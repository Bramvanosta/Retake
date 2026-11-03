/**
 * old-name: this whole file (the guard test allows it).
 *
 * L5.13 (critique H2): the variables the tool writes for the person's own scripts — a hook shell's RETAKE_PROJECT_DIR,
 * RETAKE_ENV, RETAKE_RUN_ID, RETAKE_ALLOWED_HOSTS, a seed shell's RETAKE_SANDBOX — are also written under their names
 * from before the rename (DEMO_STUDIO_*), for a script that still reads those. Written only: a value the shell already
 * had under an old name is replaced, and a command's own `env` still wins.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Journal, runHooks } from '@retake/hooks';
import type { LoadedProject } from '@retake/core';
import { makeContext, makeProject, startApi, tempProject, writeFiles } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
let api: Awaited<ReturnType<typeof startApi>>;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  tmp = await tempProject('retake-legacy-env-');
});
afterEach(async () => {
  await tmp.cleanup();
});

const text = async (file: string) => (await readFile(join(tmp.dir, file), 'utf8')).trim();

function sandboxProject(): LoadedProject {
  const p = makeProject(tmp.dir, { console: api.base });
  p.config.environments.sandbox = { console: api.base };
  p.config.environment_settings = { sandbox: { sandbox: { file: join(tmp.dir, 'sandbox', 'sandbox.yaml'), provider: 'process' } } };
  p.sandboxes = {
    sandbox: { env: 'sandbox', file: join(tmp.dir, 'sandbox', 'sandbox.yaml'), dir: join(tmp.dir, 'sandbox'), manifest: { version: 1, provider: 'process', services: { web: { command: 'x' } } }, issues: [], secrets: {} },
  };
  return p;
}

describe('the outgoing variables under both names', () => {
  it('a hook shell gets each RETAKE_* variable under its old name too; its own env wins', async () => {
    const before = process.env.DEMO_STUDIO_ENV;
    process.env.DEMO_STUDIO_ENV = 'stale-from-the-shell';
    try {
      const project = makeProject(tmp.dir, { console: api.base });
      const { ctx } = makeContext(project, { runId: '20261103-090000-quote' });
      const journal = await Journal.open(join(tmp.dir, 'runs/20261103-090000-quote/hooks-journal.json'));
      const res = await runHooks(
        [
          { shell: 'echo "$DEMO_STUDIO_ENV|$DEMO_STUDIO_RUN_ID|$(basename "$DEMO_STUDIO_PROJECT_DIR")|$DEMO_STUDIO_ALLOWED_HOSTS" > old.txt' },
          { shell: 'echo "$RETAKE_ENV|$RETAKE_RUN_ID|$(basename "$RETAKE_PROJECT_DIR")|$RETAKE_ALLOWED_HOSTS" > new.txt' },
          { shell: { run: 'echo "$DEMO_STUDIO_RUN_ID" > own.txt', env: { DEMO_STUDIO_RUN_ID: 'mine' } } },
        ],
        ctx,
        { phase: 'setup', journal },
      );
      expect(res.ok).toBe(true);
      const now = await text('new.txt');
      expect(now).toMatch(/^local\|20261103-090000-quote\|[^|]+\|.+/);
      expect(await text('old.txt')).toBe(now);
      expect(await text('own.txt')).toBe('mine');
    } finally {
      if (before === undefined) delete process.env.DEMO_STUDIO_ENV;
      else process.env.DEMO_STUDIO_ENV = before;
    }
  });

  it('a shell seed step of a sandbox gets RETAKE_SANDBOX under both names', async () => {
    await writeFiles(tmp.dir, { 'sandbox/.keep': '' });
    const project = sandboxProject();
    const { ctx } = makeContext(project, { env: { name: 'sandbox', pages: { ...project.config.environments.sandbox }, sandbox: { file: join(tmp.dir, 'sandbox', 'sandbox.yaml'), provider: 'process' } }, runId: 'seed-1', baseDir: join(tmp.dir, 'sandbox') });
    const journal = await Journal.open(join(tmp.dir, '.retake', 'sandbox', 'sandbox', 'seed-journal.json'));
    const res = await runHooks([{ shell: 'echo "$RETAKE_SANDBOX $DEMO_STUDIO_SANDBOX" > env.txt' }], ctx, { phase: 'seed', journal });
    expect(res.ok).toBe(true);
    expect(await text('sandbox/env.txt')).toBe('sandbox sandbox');
  });
});
