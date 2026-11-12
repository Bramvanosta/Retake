/**
 * L5.16c fixes (review c B-M2 / A-L4) — the Studio's own run submit when the workspace's jobs worker runs another copy
 * of Retake: scenario_run answers the copy under `untrusted.other_copy` (the lock's text; `worker` keeps pid / spawned
 * only), and the page's "queued" line (shoot-data.ts → submitNotice) says it — as text, through the status line's Txt.
 * Engine side: engine/test/worker-engine.test.ts; the Welcome inspector's Worker row: otherCopyWords.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { workerLockFile, workersDir } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { otherCopyOf, otherCopyWords, submitNotice } from '../src/app/other-copy.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

let root: string;
let studio: StudioServer | undefined;
afterAll(async () => {
  await studio?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('another copy\'s worker takes the Studio\'s own submit', () => {
  it('scenario_run answers it under untrusted.other_copy; the page says it in its queued line', async () => {
    root = await mkdtemp(join(tmpdir(), 'ui-other-copy-'));
    await fixtureWorkspace(root);
    await mkdir(workersDir(root), { recursive: true });
    const { selfIdentity } = await import('../../engine/src/jobs/proc.js');
    const folder = '/Applications/Old Retake.app';
    await writeFile(workerLockFile(root), JSON.stringify({ ...(await selfIdentity()), host: 'h', version: '0.1.0', build: 'other', since: new Date().toISOString(), engine: folder }));
    studio = await startStudioServer({
      root,
      workerSpawn: () => {
        throw new Error('no worker may start: one is alive');
      },
    });
    const r = await raw(studio.port, 'POST', '/v1/call/scenario_run', { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify({ project: 'northfield-fixture', name: 'quote', mode: 'dry' }));
    expect(r.status).toBe(200);
    const data = r.json<{ data: Record<string, unknown> }>().data;
    expect(data.worker).toEqual({ pid: process.pid, spawned: false });
    expect(data.untrusted).toEqual({ other_copy: { version: '0.1.0', engine: folder } });
    // What the page says (the status line renders it as text).
    const said = `Rehearsal of quote queued${submitNotice(otherCopyOf(data, 'other_copy'))}`;
    expect(said).toBe(`Rehearsal of quote queued. It runs in another copy of Retake (0.1.0, ${folder}), with that copy's browsers and tools: to use this one, let that worker finish (it stops a minute after its last job) and start it again`);
    // The page builds the line from these two, for a run and for a render.
    const shoot = await readFile(join(__dirname, '..', 'src', 'app', 'shoot/shoot-data.ts'), 'utf8');
    expect(shoot.match(/queued\$\{submitNotice\(otherCopyOf\(d, 'other_copy'\)\)\}/g)).toHaveLength(2);
  });

  it('the words: nothing without another copy; a malformed field is ignored', () => {
    expect(submitNotice(undefined)).toBe('');
    expect(otherCopyWords(undefined)).toBe('');
    expect(otherCopyOf({ untrusted: { other_copy: { version: 3 } } }, 'other_copy')).toBeUndefined();
    expect(otherCopyOf({}, 'other_copy')).toBeUndefined();
    expect(otherCopyOf(null, 'worker_other_copy')).toBeUndefined();
    expect(otherCopyWords(otherCopyOf({ untrusted: { worker_other_copy: { version: '0.1.0' } } }, 'worker_other_copy'))).toBe(' — another copy of Retake (0.1.0): jobs run with its tools');
  });
});
