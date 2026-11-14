/**
 * L5.16c fixes (review c B-M2 / A-L4) — the Studio's own run submit when the workspace's jobs worker runs another copy
 * of Retake: scenario_run answers the copy under `untrusted.other_copy` (the lock's text; `worker` keeps pid / spawned
 * only), and the page's "queued" line (shoot-data.ts → submitNotice) says it — as text, through the status line's Txt.
 * Engine side: engine/test/worker-engine.test.ts; the Welcome inspector's Worker row: otherCopyWords.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { workerLockFile, workersDir } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { otherCopyOf, otherCopyWords, submitNotice } from '../src/app/other-copy.js';
import { setToken } from '../src/app/api.js';
import { startRender, startRun } from '../src/app/shoot/shoot-data.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { raw } from '@retake/test-support/http';

let root: string;
let studio: StudioServer | undefined;
const realFetch = globalThis.fetch;
afterAll(async () => {
  vi.unstubAllGlobals();
  await studio?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("another copy's worker takes the Studio's own submit", () => {
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
    const r = await raw(
      studio.port,
      'POST',
      '/v1/call/scenario_run',
      { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' },
      JSON.stringify({ project: 'northfield-fixture', name: 'quote', mode: 'dry' }),
    );
    expect(r.status).toBe(200);
    const data = r.json<{ data: Record<string, unknown> }>().data;
    expect(data.worker).toEqual({ pid: process.pid, spawned: false });
    expect(data.untrusted).toEqual({ other_copy: { version: '0.1.0', engine: folder } });
    // What the page says (the status line renders it as text).
    const said = `Rehearsal of quote queued${submitNotice(otherCopyOf(data, 'other_copy'))}`;
    expect(said).toBe(
      `Rehearsal of quote queued. It runs in another copy of Retake (0.1.0, ${folder}), with that copy's browsers and tools: to use this one, let that worker finish (it stops a minute after its last job) and start it again`,
    );
    // L7.34: the page's own submits say it — Rehearse through this server (shoot-data.ts → scenario_run), and a render
    // whose answer names the other copy the same way (the render cannot be queued here: no capture), each line as said
    // (another scenario: quote's rehearsal is queued already).
    setToken(studio.token);
    const port = studio.port;
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      sent.push(path);
      if (path === '/v1/call/scenario_render')
        return new Response(JSON.stringify({ ok: true, data: { render_id: 'quote-v1', untrusted: { other_copy: { version: '0.1.0', engine: folder } } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      return realFetch(`http://127.0.0.1:${port}${path}`, init);
    });
    const saying = (start: (say: (s: string) => void) => boolean) => new Promise<string>((resolve) => expect(start(resolve)).toBe(true));
    const run = await saying((say) => startRun({ slug: 'northfield-fixture', name: 'proforma', mode: 'dry', say }));
    expect(run).toBe(said.replace('Rehearsal of quote', 'Rehearsal of proforma'));
    const render = await saying((say) => startRender({ slug: 'northfield-fixture', name: 'quote', run: 'r1', hash: 'a'.repeat(64), say }));
    expect(render).toBe(`Render quote-v1 of quote queued${submitNotice(otherCopyOf(data, 'other_copy'))}`);
    expect(sent).toEqual(expect.arrayContaining(['/v1/call/scenario_run', '/v1/call/scenario_render']));
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
