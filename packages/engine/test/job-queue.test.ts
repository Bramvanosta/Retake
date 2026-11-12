/**
 * The job queue port: the contract suite on the file queue and on the in-memory queue, what only the file queue has
 * (its files: where the port's entries land, its file part's paths), a queue's own memory of the filming takes on both
 * adapters, and the in-memory queue serving the code that is handed a queue (pruning).
 */
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ulid } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { FileJobQueue, INSPECT_KEEP, MemoryJobQueue, RECORD_KEEP, inspectRoot, newInspectId, newRecordId, pruneInspections, pruneRecords, recordsRoot, selfIdentity } from '../src/index.js';
import type { JobQueueView, TakeHold } from '../src/index.js';
import { systemClock } from '../src/clock.js';
import { RUN_INPUT, jobQueueContract } from './job-queue-contract.js';

let ws: string;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-queue-contract-'));
  process.env.RETAKE_HOME = join(ws, '.home');
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(ws, { recursive: true, force: true });
});

let n = 0;
jobQueueContract('file', async (name, cli, clock) => {
  // A workspace folder exists before its queue does (as every real one): approvals are signed over its real path.
  const root = join(ws, `file-${name}-${n++}`);
  await mkdir(root, { recursive: true });
  return { queue: new FileJobQueue(root, cli, clock), root };
});

jobQueueContract('memory', async (name, cli, clock) => {
  const root = join(ws, `memory-${name}-${n++}`);
  await mkdir(root, { recursive: true });
  return { queue: new MemoryJobQueue(root, { ...(cli ? { cli } : {}), ...(clock ? { clock } : {}) }), root };
});

describe('the file queue (its files)', () => {
  it("keeps the port's entries as the files of the job folder, a submit's files readable by this user only", async () => {
    const q = new FileJobQueue(join(ws, 'files'));
    const job = await q.enqueue(RUN_INPUT, { files: { 'edit.yaml': 'a: 1\n' } });
    const dir = q.files.job(job.id);
    expect(dir).toBe(join(ws, 'files', '.retake', 'jobs', job.id));
    expect(q.files.record(job.id)).toBe(join(dir, 'job.json'));
    expect(JSON.parse(await readFile(q.files.record(job.id), 'utf8'))).toEqual(job);
    expect((await stat(join(dir, 'edit.yaml'))).mode & 0o777).toBe(0o600);
    await q.cancel(job.id, 'test');
    expect(JSON.parse(await readFile(join(dir, 'cancel'), 'utf8'))).toMatchObject({ by: 'test' });
    await q.setYield(job.id, { state: 'background', since: '2026-11-04T14:02:00.000Z', cause: 'here' });
    expect(await readFile(q.files.yield(job.id), 'utf8')).toBe('{"v":1,"state":"background","since":"2026-11-04T14:02:00.000Z","cause":"here"}\n');
    await q.setYield(job.id, null);
    expect(existsSync(q.files.yield(job.id))).toBe(false);
    await q.append(job.id, 0, [{ type: 'log', level: 'info', message: 'one' }]);
    expect(await readFile(q.files.events(job.id), 'utf8')).toContain('"message":"one"');
    expect(q.files.browser(job.id)).toBe(join(dir, 'browser.json'));
    expect(q.files.live(job.id)).toBe(join(dir, 'live.json'));
    // The file part refuses anything but a job id (never a path).
    for (const bad of ['../x', `${job.id}/../..`, '']) {
      expect(() => q.files.job(bad), bad).toThrow(/invalid job id/);
      expect(() => q.files.record(bad), bad).toThrow(/invalid job id/);
    }
  });

  it("jobFile never follows a link: a submit's file replaced by one reads as `link`, not as its target", async () => {
    const q = new FileJobQueue(join(ws, 'job-file-link'));
    const job = await q.enqueue(RUN_INPUT, { files: { 'edit.yaml': 'a: 1\n' } });
    const file = join(q.files.job(job.id), 'edit.yaml');
    const target = join(ws, 'job-file-link', 'elsewhere.yaml');
    writeFileSync(target, 'b: 2\n');
    await rm(file);
    await symlink(target, file);
    expect(await q.jobFile(job.id, 'edit.yaml', 100)).toEqual({ ok: false, reason: 'link' });
  });

  it('a queue with its own memory is the same queue: what one writes, the other reads', async () => {
    const q = new FileJobQueue(join(ws, 'reader'), 'retake -C /ws');
    const r = q.withOwnMemory();
    expect(r).not.toBe(q);
    expect(r.cli).toBe('retake');
    const job = await q.enqueue(RUN_INPUT);
    expect((await r.get(job.id))?.state).toBe('queued');
    await r.cancel(job.id, 'test');
    expect((await q.get(job.id))?.state).toBe('cancelled');
    const m = new MemoryJobQueue(join(ws, 'reader-memory'));
    const other = await m.enqueue(RUN_INPUT);
    expect((await m.withOwnMemory().get(other.id))?.id).toBe(other.id);
  });
});

/**
 * Each queue counts a take's holding time from its own first sight of it (captures.ts): a watcher built later is not
 * held to what an older one counted. `held(q)`: the queue's takeHold after one more scan step.
 */
function ownMemory(adapter: string, make: () => Promise<{ queue: JobQueueView; step: () => void; done: () => void }>): void {
  it(`${adapter}: a queue's own memory counts the take's cap from its own first sight (a queue made later still holds)`, async () => {
    const { queue: q, step, done } = await make();
    try {
      const seen: TakeHold[] = [];
      for (let i = 0; i < 4; i++) {
        seen.push(await q.takeHold());
        step();
      }
      // Held, then capped: this queue counted the take past its cap.
      expect(seen).toEqual(['elsewhere', 'elsewhere', 'elsewhere', undefined]);
      const fresh = q.withOwnMemory();
      expect(await fresh.takeHold()).toBe('elsewhere');
      expect(await q.takeHold()).toBeUndefined();
    } finally {
      done();
    }
  });
}

describe("a queue's own memory of the filming takes", () => {
  const saved = { cap: process.env.RETAKE_CAPTURE_HOLD_MAX_MIN };
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.cap === undefined) delete process.env.RETAKE_CAPTURE_HOLD_MAX_MIN;
    else process.env.RETAKE_CAPTURE_HOLD_MAX_MIN = saved.cap;
  });

  ownMemory('file', async () => {
    // A live marker of this process (another workspace's take), its time kept fresh at each step of a fake clock;
    // a cap of 12 s, each scan counting at most 5 s: held at 0, 5 and 10 s, capped at 15 s.
    const dir = process.env.RETAKE_CAPTURES_DIR!;
    const me = await selfIdentity();
    const marker = join(dir, `k_${ulid()}.json`);
    writeFileSync(marker, JSON.stringify({ v: 1, pid: me.pid, started_at: me.started_at, ws: '0'.repeat(32), source: 'cli' }), { mode: 0o600 });
    process.env.RETAKE_CAPTURE_HOLD_MAX_MIN = '0.2';
    let t = Date.now();
    const touch = () => utimesSync(marker, t / 1000, t / 1000);
    touch();
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const root = join(ws, 'own-memory-file');
    await mkdir(root, { recursive: true });
    return {
      queue: new FileJobQueue(root),
      step: () => {
        t += 5_000;
        touch();
      },
      done: () => void rm(marker, { force: true }),
    };
  });

  ownMemory('memory', async () => {
    // Each queue's own source: holding for three scans, then capped.
    const filming = () => {
      let scans = 0;
      return async (): Promise<TakeHold> => (scans++ < 3 ? 'elsewhere' : undefined);
    };
    const root = join(ws, 'own-memory-memory');
    await mkdir(root, { recursive: true });
    return { queue: new MemoryJobQueue(root, { filming }), step: () => undefined, done: () => undefined };
  });
});

describe('the in-memory queue serves the code that is handed a queue', () => {
  const project = async (name: string): Promise<LoadedProject> => {
    const dir = join(ws, name);
    await mkdir(dir, { recursive: true });
    return { dir, slug: 'northfield-fixture' } as LoadedProject;
  };

  it('pruning keeps the folder of a recording whose job is queued, even the oldest; once cancelled it goes', async () => {
    const p = await project('prune-records');
    const q = new MemoryJobQueue(p.dir);
    const active = newRecordId();
    await mkdir(join(recordsRoot(p), active), { recursive: true });
    for (let i = 0; i < RECORD_KEEP + 2; i++) await mkdir(join(recordsRoot(p), newRecordId()), { recursive: true });
    const job = await q.enqueue({ version: 1, kind: 'record', project: p.slug, rec_id: active, source: { page: 'shop', path: '/' }, check: true, submitted_by: 'mcp' });
    expect(await pruneRecords(p, systemClock, RECORD_KEEP, [], q)).not.toContain(active);
    expect(existsSync(join(recordsRoot(p), active))).toBe(true);
    await q.cancel(job.id, 'test');
    expect(await pruneRecords(p, systemClock, RECORD_KEEP, [], q)).toContain(active);
  });

  it('pruning keeps the folder of an inspection whose job is queued, even the oldest; once cancelled it goes', async () => {
    const p = await project('prune-inspections');
    const q = new MemoryJobQueue(p.dir);
    const active = newInspectId();
    await mkdir(join(inspectRoot(p), active), { recursive: true });
    for (let i = 0; i < INSPECT_KEEP + 2; i++) await mkdir(join(inspectRoot(p), newInspectId()), { recursive: true });
    const job = await q.enqueue({ version: 1, kind: 'inspect', project: p.slug, inspect_id: active, source: { kind: 'page', page: 'shop', path: '/' }, images: 'none', submitted_by: 'mcp' } as never);
    expect(await pruneInspections(p, INSPECT_KEEP, [], q)).not.toContain(active);
    expect(existsSync(join(inspectRoot(p), active))).toBe(true);
    await q.cancel(job.id, 'test');
    expect(await pruneInspections(p, INSPECT_KEEP, [], q)).toContain(active);
  });
});
