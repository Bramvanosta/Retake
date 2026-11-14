/**
 * L7.39: a capture held to the files a person checked before it (RunOptions.trustedHookFiles → HookContext.trustedFiles):
 * a hook whose script is no longer as checked is refused, and nothing it would run runs; as checked, it runs.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { runScenario } from '../src/index.js';
import { FAST, makeScenario, startServer } from '@retake/test-support/capture';
import { makeProject, tempDir, testHookRunner } from './helpers.js';

let dir: string;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  dir = await tempDir('rw-trusted-files-');
  await mkdir(join(dir, 'tools'), { recursive: true });
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('a capture held to the files a person checked', () => {
  it('a teardown whose script changed since the check is refused, nothing of it runs; as checked, it runs', async () => {
    const server = await startServer({ '/': '<html><body><h1>Home</h1></body></html>' });
    try {
      const marker = join(dir, 'tidied');
      const script = `touch ${marker}\n`;
      await writeFile(join(dir, 'tools', 'tidy.sh'), script);
      const run = (name: string, code: string) =>
        runScenario({
          policy: PERSON_POLICY,
          project: makeProject(dir, { app: server.url }),
          scenario: makeScenario(name, { pacing: FAST, teardown: [{ shell: 'sh tools/tidy.sh' }], scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ hold: 0.1 }] }] }),
          mode: 'dry',
          hooks: 'run',
          env: 'test',
          runId: `${name}-${Date.now()}`,
          hookRunner: testHookRunner(),
          trustedHookFiles: { code: { 'tools/tidy.sh': code }, data: {} },
        });
      const changed = await run('changed', sha('echo other\n'));
      expect(changed.hooks?.teardown).toBe('failed');
      expect(existsSync(marker)).toBe(false);
      const same = await run('same', sha(script));
      expect(same.hooks?.teardown).toBe('ok');
      expect(existsSync(marker)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('a setup that dumps and a teardown that restores it: run after run, the restore held to the dump this run wrote', async () => {
    const server = await startServer({ '/': '<html><body><h1>Home</h1></body></html>' });
    try {
      const restored = join(dir, 'restored.log');
      const psql = '#!/bin/sh\n# stands for psql: logs the file it restores\ncat "$2" >> restored.log\n';
      await writeFile(join(dir, 'tools', 'psql'), psql, { mode: 0o755 });
      const run = (name: string) =>
        runScenario({
          policy: PERSON_POLICY,
          project: makeProject(dir, { app: server.url }),
          scenario: makeScenario(name, {
            pacing: FAST,
            setup: [{ shell: 'echo "insert {{run.id}};" > backup.sql' }],
            teardown: [{ shell: 'tools/psql -f backup.sql' }],
            scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ hold: 0.1 }] }],
          }),
          mode: 'dry',
          hooks: 'run',
          env: 'test',
          runId: `${name}-${Date.now()}`,
          hookRunner: testHookRunner(),
          // As a person's check gives it: the restore's own program bound; the dump, written by the setup before the teardown reads it, not yet held.
          trustedHookFiles: { code: { 'tools/psql': sha(psql) }, data: {} },
        });
      for (const name of ['dump-1', 'dump-2']) {
        const rec = await run(name);
        expect(rec.hooks?.setup).toBe('ok');
        expect(rec.hooks?.teardown).toBe('ok');
      }
      expect((await readFile(restored, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('a script changed during the capture (between the setup and the teardown) is refused at the teardown', async () => {
    const server = await startServer({ '/': '<html><body><h1>Home</h1></body></html>' });
    try {
      const marker = join(dir, 'swapped');
      const script = 'echo tidy\n';
      await writeFile(join(dir, 'tools', 'late.sh'), script);
      let swap: Promise<void> | undefined;
      const running = runScenario({
        policy: PERSON_POLICY,
        project: makeProject(dir, { app: server.url }),
        scenario: makeScenario('late', {
          pacing: FAST,
          setup: [{ shell: 'true' }],
          teardown: [{ shell: 'sh tools/late.sh' }],
          scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ hold: 0.3 }] }],
        }),
        mode: 'dry',
        hooks: 'run',
        env: 'test',
        runId: `late-${Date.now()}`,
        hookRunner: testHookRunner(),
        trustedHookFiles: { code: { 'tools/late.sh': sha(script) }, data: {} },
        // While the take holds its scene (after the setup's hold was refreshed): another program swaps the script.
        onProgress: (e) => {
          if (e.type === 'step_start') swap = writeFile(join(dir, 'tools', 'late.sh'), `touch ${marker}\n`);
        },
      });
      const rec = await running;
      await swap;
      expect(swap).toBeDefined();
      expect(rec.hooks?.setup).toBe('ok');
      expect(rec.hooks?.teardown).toBe('failed');
      expect(existsSync(marker)).toBe(false);
    } finally {
      await server.close();
    }
  });
});
