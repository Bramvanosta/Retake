/**
 * The job queue's contract (the JobQueue port), one suite every adapter passes: the file queue (the product's) and the
 * in-memory one (tests). Written first against the file queue as it was, so the port keeps its behaviour exactly: the
 * input contract, the derived states (interrupted, cancelled before it started, yield), the markers (cancel, pause,
 * stop), the exclusive claim, what a write keeps, the events and their seqs, a submit's own files, a queue with its own
 * memory, and the approvals signed at enqueue.
 */
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { RunJobInput } from '@retake/engine';
import { EngineError, ManualClock, newJobId, selfIdentity, stampOf, verifiedApprovals } from '../src/index.js';
import type { Clock, JobQueue, JobRecord, YieldMark } from '../src/index.js';

export const RUN_INPUT: RunJobInput = {
  version: 1,
  kind: 'run',
  project: 'northfield-fixture',
  scenario: 'quote',
  scenario_sha256: 'a'.repeat(64),
  mode: 'dry',
  run_id: '20261017-130000-quote',
  submitted_by: 'test',
};

/** A pid that existed and is gone now. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

export interface ContractQueue {
  queue: JobQueue;
  /** The workspace root the queue signs approvals for. */
  root: string;
}

/** `make(name, cli, clock)`: a new, empty queue of its own each call (stamped by `clock` when one is given). */
export function jobQueueContract(adapter: string, make: (name: string, cli?: string, clock?: Clock) => Promise<ContractQueue>): void {
  const review = (q: JobQueue, n: number) => q.enqueue({ version: 1, kind: 'review', project: 'northfield-fixture', render_id: `quote-v${n}`, fps: 1, submitted_by: 'test' } as never);
  const running = async (q: JobQueue, rec: JobRecord, extra: Partial<JobRecord> = {}): Promise<JobRecord> => {
    const me = { ...(await selfIdentity()), host: hostname() };
    const r: JobRecord = { ...rec, state: 'running', started_at: new Date().toISOString(), worker: me, ...extra };
    await q.write(r);
    return r;
  };

  describe(`the job queue contract (${adapter})`, () => {
    it('enqueue validates the input contract (never a path, an unknown key or another version) and queues it once', async () => {
      const { queue: q } = await make('contract');
      for (const bad of [{ ...RUN_INPUT, project: '../x' }, { ...RUN_INPUT, run_id: '../../x' }, { ...RUN_INPUT, version: 2 }, { ...RUN_INPUT, kind: 'record' }, { ...RUN_INPUT, secret: 'x' }]) {
        await expect(q.enqueue(bad as RunJobInput), JSON.stringify(bad)).rejects.toThrow(EngineError);
      }
      expect(await q.ids()).toEqual([]);
      const rec = await q.enqueue(RUN_INPUT);
      expect(rec).toMatchObject({ version: 1, kind: 'run', state: 'queued', input: RUN_INPUT });
      expect(rec.created_at).toBeTypeOf('string');
      expect(await q.ids()).toEqual([rec.id]);
      expect(await q.stored(rec.id)).toEqual(rec);
      expect(JSON.parse(JSON.stringify(await q.get(rec.id)))).toEqual(rec);
    });

    it('enqueue refuses a job file named like a path, a hidden file or one of the job folder\'s own', async () => {
      const { queue: q } = await make('files');
      for (const name of ['../x.yaml', '.hidden.yaml', 'job.json', 'claim', 'events.jsonl', 'yield.json', 'live.json', 'browser.json', 'a/b.yaml', 'Edit.yaml']) {
        await expect(q.enqueue(RUN_INPUT, { files: { [name]: 'x' } }), name).rejects.toMatchObject({ code: 'invalid' });
      }
      expect(await q.list()).toEqual([]);
      const ok = await q.enqueue(RUN_INPUT, { files: { 'edit.yaml': 'a: 1\n' } });
      expect((await q.get(ok.id))?.state).toBe('queued');
    });

    it('jobFile reads a submit\'s file back as stored: missing when there is none, too large past its cap; never a name of the job\'s own', async () => {
      const { queue: q } = await make('job-file');
      const job = await q.enqueue(RUN_INPUT, { files: { 'edit.yaml': 'caption: é\n' } });
      expect(await q.jobFile(job.id, 'edit.yaml', 100)).toEqual({ ok: true, text: 'caption: é\n' });
      // The cap counts bytes (é is two): at the size it reads, one byte below it does not.
      expect(await q.jobFile(job.id, 'edit.yaml', 12)).toEqual({ ok: true, text: 'caption: é\n' });
      expect(await q.jobFile(job.id, 'edit.yaml', 11)).toEqual({ ok: false, reason: 'too_large' });
      expect(await q.jobFile(job.id, 'other.yaml', 100)).toEqual({ ok: false, reason: 'missing' });
      expect(await q.jobFile((await q.enqueue(RUN_INPUT)).id, 'edit.yaml', 100)).toEqual({ ok: false, reason: 'missing' });
      for (const name of ['job.json', 'cancel', 'events.jsonl', '../x.yaml', '.hidden.yaml']) {
        await expect(q.jobFile(job.id, name, 100), name).rejects.toMatchObject({ code: 'invalid' });
      }
    });

    it('a job id that is not one is refused (never a path); an unknown one reads as nothing', async () => {
      const { queue: q } = await make('ids');
      for (const bad of ['../x', 'j_short', '', `j_${'A'.repeat(25)}/`]) {
        await expect(q.get(bad), bad).rejects.toMatchObject({ code: 'invalid' });
        await expect(q.cancelOf(bad), bad).rejects.toMatchObject({ code: 'invalid' });
        await expect(q.jobFile(bad, 'edit.yaml', 100), bad).rejects.toMatchObject({ code: 'invalid' });
        // The events of a job that cannot be read are none.
        expect(await q.events(bad), bad).toEqual([]);
      }
      const unknown = newJobId(Date.now());
      expect(await q.get(unknown)).toBeUndefined();
      expect(await q.stored(unknown)).toBeUndefined();
      expect(await q.claimOf(unknown)).toBeUndefined();
      expect(await q.events(unknown)).toEqual([]);
      expect(await q.lastSeq(unknown)).toBe(0);
      await expect(q.cancel(unknown, 'test')).rejects.toMatchObject({ code: 'not_found' });
      // A job that is gone cannot be claimed.
      expect(await q.claim(unknown, { pid: process.pid })).toBe(false);
    });

    it('lists newest first with its filters (project, kinds, states, run, render, limit); ofRun and ofRender', async () => {
      const { queue: q } = await make('list');
      const a = await q.enqueue(RUN_INPUT);
      const b = await q.enqueue({ ...RUN_INPUT, run_id: '20261017-130001-quote' });
      const other = await q.enqueue({ ...RUN_INPUT, project: 'other-project', run_id: '20261017-130002-quote' });
      const r1 = await q.enqueue({ version: 1, kind: 'render', project: 'northfield-fixture', scenario: 'quote', run_id: '20261017-130000-quote', timeline_sha256: 'c'.repeat(64), render_id: 'quote-v1', overrides: {}, submitted_by: 'test' } as never);
      const rv = await review(q, 1);
      expect((await q.list()).map((j) => j.id)).toEqual([rv.id, r1.id, other.id, b.id, a.id]);
      expect((await q.list({ limit: 2 })).map((j) => j.id)).toEqual([rv.id, r1.id]);
      expect((await q.list({ project: 'other-project' })).map((j) => j.id)).toEqual([other.id]);
      expect((await q.list({ kinds: ['render', 'review'] })).map((j) => j.id)).toEqual([rv.id, r1.id]);
      expect((await q.list({ runId: '20261017-130001-quote' })).map((j) => j.id)).toEqual([b.id]);
      expect((await q.list({ renderId: 'quote-v1' })).map((j) => j.id)).toEqual([rv.id, r1.id]);
      expect((await q.ofRun('northfield-fixture', RUN_INPUT.run_id))?.id).toBe(a.id);
      expect(await q.ofRun('other-project', RUN_INPUT.run_id)).toBeUndefined();
      expect((await q.ofRender('northfield-fixture', 'quote-v1'))?.id).toBe(r1.id);
      await q.cancel(b.id, 'test');
      expect((await q.list({ states: ['cancelled'] })).map((j) => j.id)).toEqual([b.id]);
      expect((await q.list({ states: ['queued'], kinds: ['run'] })).map((j) => j.id)).toEqual([other.id, a.id]);
    });

    it('a cancel before the claim derives `cancelled` (written by nobody); asked twice it keeps the first time; a finished job is returned as it is', async () => {
      const { queue: q } = await make('cancel');
      const a = await q.enqueue(RUN_INPUT);
      expect(await q.cancelOf(a.id)).toBeUndefined();
      const c = await q.cancel(a.id, 'test');
      expect(c).toMatchObject({ state: 'cancelled', derived: true, error: { code: 'cancelled', message: 'cancelled before it started' } });
      expect(c.cancel_requested_at).toBeTypeOf('string');
      expect(c.finished_at).toBe(c.cancel_requested_at);
      expect((await q.stored(a.id))?.state).toBe('queued');
      expect(await q.cancelOf(a.id)).toEqual({ at: c.cancel_requested_at });
      expect((await q.cancel(a.id, 'test')).cancel_requested_at).toBe(c.cancel_requested_at);
      // Discard (an open recording window): the reason is kept.
      const d = await q.enqueue({ ...RUN_INPUT, run_id: '20261017-130003-quote' });
      await q.cancel(d.id, 'ui', 'discard');
      expect(await q.cancelOf(d.id)).toEqual({ at: expect.any(String), reason: 'discard' });
      // A finished job: no marker, returned as stored.
      const f = await q.enqueue({ ...RUN_INPUT, run_id: '20261017-130004-quote' });
      const done: JobRecord = { ...f, state: 'succeeded', finished_at: new Date().toISOString() };
      await q.write(done);
      expect(await q.cancel(f.id, 'test')).toEqual(done);
      expect(await q.cancelOf(f.id)).toBeUndefined();
      // A running job: the request is said on it, the state is its worker's.
      const r = await q.enqueue({ ...RUN_INPUT, run_id: '20261017-130005-quote' });
      await running(q, r);
      const asked = await q.cancel(r.id, 'test');
      expect(asked.state).toBe('running');
      expect(asked.cancel_requested_at).toBeTypeOf('string');
    });

    it('claims are exclusive, also when many race for one job; unclaim gives the job back', async () => {
      const { queue: q } = await make('claim');
      const job = await q.enqueue(RUN_INPUT);
      expect(await q.claimOf(job.id)).toBeUndefined();
      const wins = await Promise.all(Array.from({ length: 8 }, (_, i) => q.claim(job.id, { pid: process.pid + i })));
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(await q.claim(job.id, { pid: process.pid })).toBe(false);
      const claim = await q.claimOf(job.id);
      expect(claim?.at).toBeTypeOf('string');
      expect(claim?.pid).toBeGreaterThanOrEqual(process.pid);
      await q.unclaim(job.id);
      expect(await q.claimOf(job.id)).toBeUndefined();
      expect(await q.claim(job.id, await selfIdentity())).toBe(true);
      // Claimed by a live worker, still queued: queued.
      expect((await q.get(job.id))?.state).toBe('queued');
    });

    it('derives `interrupted` for a dead worker (a gone pid, 0, 1, -1, a reused pid, a claim of a dead worker), never written', async () => {
      const { queue: q } = await make('interrupted', 'retake -C /ws');
      const job = await q.enqueue({ ...RUN_INPUT, env: 'local' });
      const run: JobRecord = { ...job, state: 'running', started_at: new Date().toISOString(), worker: { pid: deadPid(), host: 'h' } };
      await q.write(run);
      const got = await q.get(job.id);
      expect(got).toMatchObject({ state: 'interrupted', derived: true, error: { code: 'cancelled', fix: 'retake -C /ws env reset northfield-fixture --env local' } });
      expect(got?.error?.message).toContain('stopped while the job ran');
      expect((await q.stored(job.id))?.state).toBe('running');
      for (const pid of [0, 1, -1]) {
        await q.write({ ...run, worker: { pid, host: 'here' } });
        expect((await q.get(job.id))?.state, String(pid)).toBe('interrupted');
      }
      await q.write({ ...run, worker: { pid: process.ppid, started_at: '2001-01-01T00:00:00.000Z', host: 'h' } });
      expect((await q.get(job.id))?.state).toBe('interrupted');
      await q.write({ ...run, worker: { ...(await selfIdentity()), host: 'h' } });
      expect((await q.get(job.id))?.state).toBe('running');
      // A heavy job's worker is its job process.
      await q.write({ ...run, worker: { pid: deadPid(), host: 'h' }, supervisor: { pid: process.pid, host: 'h' } });
      expect((await q.get(job.id))?.error?.message).toContain('its job process');
      const other = await q.enqueue(RUN_INPUT);
      await q.claim(other.id, { pid: deadPid() });
      const lost = await q.get(other.id);
      expect(lost).toMatchObject({ state: 'interrupted', derived: true });
      expect(lost?.error?.message).toContain('stopped right after taking the job');
    });

    it('pause (a running run job) and stop markers: created once, removed on resume; said on the job only while it runs', async () => {
      const { queue: q } = await make('markers');
      const job = await q.enqueue(RUN_INPUT);
      expect(await q.pauseOf(job.id)).toBeUndefined();
      await q.requestPause(job.id, true, 'test');
      const at = (await q.pauseOf(job.id))?.at;
      expect(at).toBeTypeOf('string');
      // Queued: not said on it.
      expect((await q.get(job.id))?.pause_requested_at).toBeUndefined();
      await running(q, (await q.stored(job.id))!);
      expect((await q.get(job.id))?.pause_requested_at).toBe(at);
      await q.requestPause(job.id, true, 'test');
      expect(await q.pauseOf(job.id)).toEqual({ at });
      await q.requestPause(job.id, false, 'test');
      expect(await q.pauseOf(job.id)).toBeUndefined();
      await q.requestPause(job.id, false, 'test');
      expect((await q.get(job.id))?.pause_requested_at).toBeUndefined();
      expect(await q.stopOf(job.id)).toBeUndefined();
      await q.requestStop(job.id, 'test');
      const stop = await q.stopOf(job.id);
      expect(stop?.at).toBeTypeOf('string');
      await q.requestStop(job.id, 'test');
      expect(await q.stopOf(job.id)).toEqual(stop);
    });

    it('write keeps what is stored: the derived fields (cancel and pause requests, derived, yield) are never written', async () => {
      const { queue: q } = await make('write');
      const job = await q.enqueue(RUN_INPUT);
      await running(q, job);
      await q.cancel(job.id, 'test');
      await q.requestPause(job.id, true, 'test');
      const seen = (await q.get(job.id))!;
      expect(seen.cancel_requested_at).toBeTypeOf('string');
      await q.write({ ...seen, derived: true, yield: { state: 'background', cause: 'here' } });
      const stored = (await q.stored(job.id))!;
      for (const k of ['cancel_requested_at', 'pause_requested_at', 'derived', 'yield']) expect(stored, k).not.toHaveProperty(k);
      expect(stored.state).toBe('running');
    });

    it('events: appended with increasing seq, read after a seq or the last few; lastSeq goes on from there', async () => {
      const { queue: q } = await make('events');
      const job = await q.enqueue(RUN_INPUT);
      expect(await q.append(job.id, 0, [])).toBe(0);
      let seq = await q.append(job.id, 0, [{ type: 'state', state: 'running' }, { type: 'log', level: 'info', message: 'one' }]);
      seq = await q.append(job.id, seq, [{ type: 'log', level: 'warn', message: 'two' }]);
      expect(seq).toBe(3);
      expect(await q.lastSeq(job.id)).toBe(3);
      const all = await q.events(job.id);
      expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(all[0]).toMatchObject({ seq: 1, type: 'state', state: 'running' });
      expect(all[0]!.t).toBeTypeOf('string');
      expect((await q.events(job.id, { after: 2 })).map((e) => e.type === 'log' && e.message)).toEqual(['two']);
      expect((await q.events(job.id, { limit: 2 })).map((e) => e.seq)).toEqual([2, 3]);
      // A second writer goes on from the last seq.
      expect(await q.append(job.id, await q.lastSeq(job.id), [{ type: 'result' }])).toBe(4);
      // The seq given is the writer's: what it appends follows it, whatever was written (one writer at a time).
      expect(await q.append(job.id, 10, [{ type: 'result' }, { type: 'result' }])).toBe(12);
      expect((await q.events(job.id)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 11, 12]);
      expect(await q.lastSeq(job.id)).toBe(12);
    });

    it('position per lane (captures before heavy jobs, the oldest first); a queued take holds every heavy job (held_by "take")', async () => {
      const { queue: q } = await make('lanes');
      const r1 = await review(q, 1);
      const dry = await q.enqueue({ ...RUN_INPUT, run_id: '20261017-140000-quote' });
      const r2 = await review(q, 2);
      expect(await q.position(r2.id)).toEqual({ ahead: 1 });
      expect(await q.position(dry.id)).toEqual({ ahead: 0 });
      expect(await q.position(r1.id)).toEqual({ ahead: 0 });
      expect(await q.takeHold()).toBeUndefined();
      const take = await q.enqueue({ ...RUN_INPUT, mode: 'capture', run_id: '20261017-140001-quote' });
      expect(await q.takeHold()).toBe('here');
      expect(await q.position(r1.id)).toEqual({ ahead: 0, held_by: 'take' });
      expect(await q.position(r2.id)).toEqual({ ahead: 1, held_by: 'take' });
      expect(await q.position(dry.id)).toEqual({ ahead: 0 });
      expect((await q.get(r1.id))?.yield).toEqual({ state: 'waiting', cause: 'here' });
      expect((await q.get(dry.id))?.yield).toBeUndefined();
      await q.cancel(take.id, 'test');
      expect(await q.takeHold()).toBeUndefined();
      expect(await q.position(r1.id)).toEqual({ ahead: 0 });
      // A running job of the lane is ahead of every queued one; a job not queued has no position.
      await running(q, (await q.stored(r1.id))!);
      expect(await q.position(r2.id)).toEqual({ ahead: 1, running: r1.id });
      expect(await q.position(r1.id)).toBeUndefined();
      // A take claimed (taken by a worker) holds through its worker, not through the queue.
      const claimed = await q.enqueue({ ...RUN_INPUT, mode: 'capture', run_id: '20261017-140002-quote' });
      await q.claim(claimed.id, await selfIdentity());
      expect(await q.takeHold()).toBeUndefined();
    });

    it('yield: a running heavy job reads what its worker set (background, past the cap), checked; cleared, it reads nothing', async () => {
      const { queue: q } = await make('yield');
      const job = await review(q, 1);
      const me = { ...(await selfIdentity()), host: hostname() };
      await running(q, job, { supervisor: me });
      expect((await q.get(job.id))?.yield).toBeUndefined();
      const bg: YieldMark = { state: 'background', since: '2026-11-04T14:02:00.000Z', cause: 'here' };
      await q.setYield(job.id, bg);
      expect((await q.get(job.id))?.yield).toEqual({ state: 'background', cause: 'here', since: '2026-11-04T14:02:00.000Z' });
      expect(await q.yieldOf(job.id)).toEqual({ state: 'background', cause: 'here', since: '2026-11-04T14:02:00.000Z' });
      await q.setYield(job.id, { state: 'past_cap', since: '2026-11-04T15:02:00.000Z', cause: 'elsewhere', cap_min: 60 });
      expect((await q.get(job.id))?.yield).toEqual({ state: 'past_cap', cause: 'elsewhere', since: '2026-11-04T15:02:00.000Z', cap_min: 60 });
      // A cap out of bounds is dropped, never shown.
      await q.setYield(job.id, { state: 'past_cap', since: '2026-11-04T15:02:00.000Z', cause: 'elsewhere', cap_min: 99_999 });
      expect((await q.get(job.id))?.yield).toEqual({ state: 'past_cap', cause: 'elsewhere', since: '2026-11-04T15:02:00.000Z' });
      await q.setYield(job.id, null);
      expect((await q.get(job.id))?.yield).toBeUndefined();
      await q.setYield(job.id, null);
      // A run job (capture class) never reads a yield.
      const run = await q.enqueue(RUN_INPUT);
      await running(q, run);
      await q.setYield(run.id, bg);
      expect((await q.get(run.id))?.yield).toBeUndefined();
    });

    it('a queue with its own memory reads and writes the same jobs, for the same root; its fix texts start with `retake` unless told', async () => {
      const { queue: q } = await make('reader', 'retake -C /ws');
      const r = q.withOwnMemory();
      expect(r).not.toBe(q);
      expect([r.root, r.cli]).toEqual([q.root, 'retake']);
      expect(q.withOwnMemory('retake -C /other').cli).toBe('retake -C /other');
      // A derived interrupted job's fix starts with the reading queue's command.
      const lost = await q.enqueue({ ...RUN_INPUT, run_id: '20261017-130009-quote' });
      await q.claim(lost.id, { pid: deadPid() });
      expect((await q.get(lost.id))?.error?.fix).toMatch(/^retake -C \/ws env reset /);
      expect((await r.get(lost.id))?.error?.fix).toMatch(/^retake env reset /);
      const job = await q.enqueue(RUN_INPUT);
      expect(await r.ids()).toEqual([lost.id, job.id]);
      expect(await r.claim(job.id, await selfIdentity())).toBe(true);
      expect(await q.claim(job.id, await selfIdentity())).toBe(false);
      await r.append(job.id, 0, [{ type: 'result' }]);
      expect(await q.lastSeq(job.id)).toBe(1);
    });

    it('approvals are signed at enqueue for that job and that workspace (the worker honours no other)', async () => {
      const { queue: q, root } = await make('approvals');
      const approval = { fingerprint: 'b'.repeat(64), by: 'test' as const, at: '2026-11-09T10:00:00.000Z' };
      const input = { version: 1, kind: 'hooks', project: 'northfield-fixture', env: 'local', source: 'reset', dry: false, journal_id: '20261017-150000-hooks-reset', submitted_by: 'test', approvals: [approval] };
      const rec = await q.enqueue(input as never);
      const signed = (rec.input as { approvals?: Array<{ sig?: string }> }).approvals!;
      expect(signed[0]!.sig).toMatch(/^[0-9a-f]{64}$/);
      expect((await verifiedApprovals(rec.input, { jobId: rec.id, root })).approvals).toHaveLength(1);
      expect((await verifiedApprovals(rec.input, { jobId: newJobId(Date.now()), root })).rejected).toBe(1);
      expect((await q.stored(rec.id))?.input).toEqual(rec.input);
      // A job without approvals carries none.
      expect('approvals' in (await q.enqueue(RUN_INPUT)).input).toBe(false);
    });

    it('stamps its records, markers, claims and events with the clock it is handed (the composition root\'s)', async () => {
      const clock = new ManualClock('2026-03-04T05:06:07.008Z');
      const { queue: q } = await make('clock', undefined, clock);
      const a = await q.enqueue(RUN_INPUT);
      expect(a.created_at).toBe('2026-03-04T05:06:07.008Z');
      // The id is made at the clock's time too (a ULID: its first 10 characters are the milliseconds).
      expect(a.id.slice(2, 12)).toBe(newJobId(clock.now()).slice(2, 12));
      clock.advance(1_000);
      expect(await q.claim(a.id, await selfIdentity())).toBe(true);
      expect((await q.claimOf(a.id))?.at).toBe(stampOf(clock));
      clock.advance(1_000);
      await q.requestPause(a.id, true, 'test');
      expect((await q.pauseOf(a.id))?.at).toBe('2026-03-04T05:06:09.008Z');
      clock.advance(1_000);
      await q.requestStop(a.id, 'test');
      expect((await q.stopOf(a.id))?.at).toBe('2026-03-04T05:06:10.008Z');
      clock.advance(1_000);
      expect((await q.cancel(a.id, 'test')).cancel_requested_at).toBe('2026-03-04T05:06:11.008Z');
      clock.advance(1_000);
      await q.append(a.id, 0, [{ type: 'log', level: 'info', message: 'one' }]);
      expect((await q.events(a.id)).map((e) => e.t)).toEqual(['2026-03-04T05:06:12.008Z']);
      // A queue with its own memory keeps the clock.
      const own = q.withOwnMemory('retake -C x');
      clock.set('2027-01-01T00:00:00.000Z');
      expect((await own.enqueue(RUN_INPUT)).created_at).toBe('2027-01-01T00:00:00.000Z');
    });

    it('exclusive (L7.26): one holder at a time per key, its queues with their own memory too; other keys are not held; a throw releases it', async () => {
      const { queue: q } = await make('exclusive');
      const own = q.withOwnMemory();
      const tick = () => new Promise((r) => setTimeout(r, 5));
      let inside = 0;
      let most = 0;
      const order: string[] = [];
      let other: string | undefined;
      const hold = (by: JobQueue, name: string) =>
        by.exclusive('run\0p\0s', async () => {
          inside++;
          most = Math.max(most, inside);
          order.push(`${name} in`);
          // Another key is taken while this one is held (were it the same lock, it would wait for this holder).
          if (name === 'a') other = await Promise.race([q.exclusive('render\0p\0s', async () => 'free'), new Promise<string>((r) => setTimeout(() => r('held'), 2_000))]);
          await tick();
          order.push(`${name} out`);
          inside--;
          return name;
        });
      expect(await Promise.all([hold(q, 'a'), hold(own, 'b'), hold(q, 'c')])).toEqual(['a', 'b', 'c']);
      expect(most).toBe(1);
      expect(order).toEqual(['a in', 'a out', 'b in', 'b out', 'c in', 'c out']);
      expect(other).toBe('free');
      // A holder that throws releases the lock: its error is the caller's, the next one gets in.
      await expect(q.exclusive('run\0p\0s', async () => Promise.reject(new EngineError('conflict', 'taken')))).rejects.toMatchObject({ code: 'conflict', message: 'taken' });
      expect(await q.exclusive('run\0p\0s', async () => 'next')).toBe('next');
    });
  });
}
