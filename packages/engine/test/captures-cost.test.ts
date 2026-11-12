/**
 * L5.14 review A H1 / A M1 / B L8: what a take and the Studio cost while a take holds heavy work, with a long job
 * history (3000 finished job folders): a take's sampler (TakeBeside) never reads the job folders — the worker's own
 * hold, or its one held file — and a JobsWatch poll with queued heavy jobs reads what holds them once, from the jobs
 * not finished, not every job.json once per queued heavy job. Asserted on the files read, not on time.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ulid } from '@retake/core';
import { FileJobQueue, JOB_RECORD_VERSION, JobsWatch, TakeBeside, heldFile } from '../src/index.js';

let root: string;
let jobs: string;

/** Paths under the job folders that `fn` opens, reads or stats (sync and promise APIs). */
async function touched(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const watch = <T extends object>(mod: T, names: Array<keyof T & string>) =>
    names.map((name) => {
      const real = mod[name] as unknown as (...a: unknown[]) => unknown;
      return vi.spyOn(mod, name as never).mockImplementation(((...a: unknown[]) => {
        seen.push(String(a[0]));
        return real.apply(mod, a);
      }) as never);
    });
  const spies = [...watch(fs, ['openSync', 'readFileSync', 'statSync', 'readdirSync']), ...watch(fsp, ['readFile', 'open', 'stat', 'readdir'])];
  // The named exports the sources import follow the patched module objects.
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
    syncBuiltinESMExports();
  }
  return seen.filter((p) => p.startsWith(jobs));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-captures-cost-'));
  jobs = join(root, '.retake', 'jobs');
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\n');
  const at = new Date().toISOString();
  const input = { version: 1, kind: 'render', project: 'demo', scenario: 'quote', render_id: 'quote-v1', submitted_by: 'test' };
  for (let i = 0; i < 3000; i++) {
    const id = `j_${ulid()}`;
    await mkdir(join(jobs, id), { recursive: true });
    await writeFile(join(jobs, id, 'job.json'), JSON.stringify({ version: JOB_RECORD_VERSION, id, kind: 'render', input, state: 'succeeded', created_at: at, finished_at: at }));
  }
  // Three renders queued behind a take (queued, unclaimed).
  for (let i = 0; i < 3; i++) {
    const id = `j_${ulid()}`;
    await mkdir(join(jobs, id), { recursive: true });
    await writeFile(
      join(jobs, id, 'job.json'),
      JSON.stringify({ version: JOB_RECORD_VERSION, id, kind: 'render', input: { ...input, render_id: `quote-v${i + 2}` }, state: 'queued', created_at: at }),
    );
  }
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('the cost of a take beside a long history (review A H1, A M1, B L8)', () => {
  it("a take's sampler reads no job folder: the worker's own hold, else its one held file", async () => {
    let asked = 0;
    const inWorker = new TakeBeside({ root, own: () => undefined, slowed: () => (asked++, true) });
    expect(await touched(() => inWorker.sample())).toEqual([]);
    expect(inWorker.stop()).toEqual({ takes_beside: 0, heavy_slowed: true });
    expect(asked).toBe(1);
    const cli = new TakeBeside({ root, own: () => undefined });
    expect(await touched(() => cli.sample())).toEqual([]);
    expect(cli.stop().heavy_slowed).toBe(false);
    await mkdir(join(root, '.retake', 'workers'), { recursive: true });
    await writeFile(heldFile(root), JSON.stringify({ v: 1, state: 'background', since: new Date().toISOString() }));
    const held = new TakeBeside({ root, own: () => undefined });
    expect(await touched(() => held.sample())).toEqual([]);
    expect(held.stop().heavy_slowed).toBe(true);
    await rm(heldFile(root));
  });

  it('a JobsWatch poll after the first reads the unfinished jobs only, what holds them once', async () => {
    const queue = new FileJobQueue(root);
    const watch = new JobsWatch(queue);
    // Taking stock: the whole history, once (the count shows what is seen).
    expect((await touched(() => watch.poll())).filter((p) => p.endsWith('job.json')).length).toBeGreaterThanOrEqual(3003);
    const read = await touched(() => watch.poll());
    const jobJson = read.filter((p) => p.endsWith('job.json'));
    expect(jobJson.length).toBeGreaterThanOrEqual(3);
    // Three queued renders: each read for the poll, and once for what holds them — never the 3000 finished ones.
    expect(jobJson.length).toBeLessThanOrEqual(3 * 2);
    expect(read.length).toBeLessThan(40);
    // A list memoises it too.
    expect((await touched(() => queue.list({ limit: 5 }))).filter((p) => p.endsWith('job.json')).length).toBeLessThan(20);
  });
});
