/**
 * L5.2b — the supervised server's lines to the desktop shell (supervise.ts), on a scratch workspace whose job files the
 * test writes itself (as a worker or a hand edit would): the job watch takes stock first (finished history gives no
 * `job_end`), each job that ends while it watches gives exactly one `job_end` of enums and checked slugs, the outcome
 * table, the kinds that count and the one pipe-kind table, a queued job with no live worker left out (critique M2),
 * a hand-edited job.json's bad names left out, `pending` coalesced (one write per gap, the last state always written),
 * latest-wins while stdout is full, the line caps and the job_end rate cap. Review fixes: each line framed by newlines
 * (A L3), names only of a project and a scenario that exist (A L1), a Studio recording its own kind (B L5), an
 * environment reset's own reason (B L14), one read of each live job per poll (B L15).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_KINDS } from '@retake/engine';
import type { JobKind } from '@retake/engine';
import { FileJobQueue, openWorkspace, selfIdentity } from '@retake/engine';
import type { JobQueueView, JobRecord } from '@retake/engine';
import { JOB_END_PER_MIN, Live, PIPE_LINE_MAX, Supervisor, UnsavedBoard, jobOutcome, pendingLine, pipeKind } from '../src/index.js';
import type { PipeOut } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

const P = 'northfield-fixture';
let ws: string;
let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-supervise-'));
  await fixtureWorkspace(ws);
});

afterAll(async () => {
  if (ws) await rm(ws, { recursive: true, force: true });
});

/** A fresh jobs folder per test (the watch reads them all). */
beforeEach(async () => {
  await rm(join(ws, '.retake', 'jobs'), { recursive: true, force: true });
});

const id = () => `j_${String(++n).padStart(26, '0')}`;

async function job(rec: Omit<Partial<JobRecord>, 'input'> & { kind: JobKind; input: Record<string, unknown>; state: JobRecord['state'] }, at = id()): Promise<string> {
  const dir = join(ws, '.retake', 'jobs', at);
  await mkdir(dir, { recursive: true });
  const full = { version: 1, id: at, created_at: new Date().toISOString(), ...rec, input: { version: 1, kind: rec.kind, submitted_by: 'test', ...rec.input } };
  await writeFile(join(dir, 'job.json'), JSON.stringify(full));
  return at;
}

/** A running job of this process (its worker is alive: the test). */
async function running(kind: JobKind, input: Record<string, unknown>): Promise<string> {
  return job({ kind, input, state: 'running', worker: { ...(await selfIdentity()), host: 'test' } });
}

function out(ok = true) {
  const lines: string[] = [];
  let drain: (() => void) | undefined;
  const o: PipeOut & { ok: boolean } = {
    ok,
    write(t: string) {
      lines.push(t);
      return o.ok;
    },
    once(_e: 'drain', f: () => void) {
      drain = f;
    },
  };
  return { o, lines, drain: () => drain?.(), parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function sup(o: PipeOut, x: { board?: UnsavedBoard; worker?: boolean; gapMs?: number } = {}) {
  return new Supervisor({
    root: ws,
    queue: new FileJobQueue(ws),
    board: x.board ?? new UnsavedBoard(join(ws, 'projects')),
    out: o,
    pollMs: 60_000,
    gapMs: x.gapMs ?? 0,
    workerAlive: async () => x.worker ?? true,
  });
}

const capture = { project: P, scenario: 'quote', mode: 'capture', scenario_sha256: '0'.repeat(64), run_id: '20261029-120000-quote' };

describe('stock, then one job_end per job that ends (L5.2b)', () => {
  it('finished history gives nothing; unfinished jobs are in the first pending; one transition → exactly one job_end of enums and slugs', async () => {
    await job({ kind: 'render', input: { project: P, scenario: 'quote', render_id: 'quote-v1' }, state: 'succeeded', result: { kind: 'render' } as never });
    await job({ kind: 'run', input: capture, state: 'failed' });
    const cap = await running('run', capture);
    await job({ kind: 'render', input: { project: P, scenario: 'quote', render_id: 'quote-v2' }, state: 'queued' });
    const w = out();
    const s = sup(w.o);
    await s.nudge();
    await sleep(30);
    expect(w.parsed()).toEqual([
      {
        type: 'pending',
        jobs: [
          { kind: 'capture', state: 'running', project: P, scenario: 'quote' },
          { kind: 'render', state: 'queued', project: P, scenario: 'quote' },
        ],
        jobs_total: 2,
        unsaved: [],
        unsaved_total: 0,
      },
    ]);
    // The capture ends: its run failed.
    await job({ kind: 'run', input: capture, state: 'succeeded', result: { kind: 'run', status: 'failed' } as never }, cap);
    await s.nudge();
    await sleep(30);
    await s.nudge();
    await sleep(30);
    const lines = w.parsed();
    expect(lines.filter((l) => l.type === 'job_end')).toEqual([{ type: 'job_end', kind: 'capture', outcome: 'failed', reason: 'run_failed', project: P, scenario: 'quote' }]);
    expect(lines.at(-1)).toMatchObject({ type: 'pending', jobs_total: 1, jobs: [{ kind: 'render', state: 'queued' }] });
    for (const l of w.lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(PIPE_LINE_MAX);
    s.stop();
  });

  it('a job created after the start and already finished gives one job_end; a cancelled one and excluded kinds give none', async () => {
    const w = out();
    const s = sup(w.o);
    await s.nudge();
    await job({ kind: 'review', input: { project: P, render_id: 'quote-v3-vertical' }, state: 'succeeded', result: { kind: 'review', clean: false } as never });
    await job({ kind: 'export', input: { project: P, render_id: 'quote-v3' }, state: 'cancelled' });
    await job({ kind: 'preview', input: {}, state: 'failed' });
    await job({ kind: 'auth_login', input: { project: P, mode: 'headed' }, state: 'failed' });
    await job({ kind: 'hooks', input: { project: P, source: 'quote:setup', dry: true }, state: 'succeeded', result: { kind: 'hooks', ok: false } as never });
    await job({ kind: 'hooks', input: { project: P, source: 'quote:setup', dry: false }, state: 'succeeded', result: { kind: 'hooks', ok: false } as never });
    await s.nudge();
    await s.nudge();
    expect(w.parsed().filter((l) => l.type === 'job_end')).toEqual([
      { type: 'job_end', kind: 'review', outcome: 'attention', reason: 'review_issues', project: P, scenario: 'quote' },
      { type: 'job_end', kind: 'hooks', outcome: 'failed', reason: 'hooks_failed', project: P, scenario: 'quote' },
    ]);
    s.stop();
  });

  it('a hand-edited job.json: a project or scenario that is no slug is left out of every line', async () => {
    const w = out();
    const s = sup(w.o);
    await s.nudge();
    await running('run', { ...capture, project: '../outside', scenario: 'a b' });
    await job({ kind: 'render', input: { project: P, scenario: 'Click Quit Anyway to keep your work', render_id: 'x' }, state: 'failed' });
    await s.nudge();
    await sleep(30);
    const lines = w.parsed();
    expect(lines.find((l) => l.type === 'job_end')).toEqual({ type: 'job_end', kind: 'render', outcome: 'failed', project: P });
    expect(lines.at(-1)).toMatchObject({ type: 'pending', jobs: [{ kind: 'capture', state: 'running' }] });
    expect(JSON.stringify(lines)).not.toMatch(/outside|a b|Quit Anyway/);
    s.stop();
  });

  it('names only of a project and a scenario that exist — a slug-shaped name of nothing is left out (review A L1)', async () => {
    const w = out();
    const s = sup(w.o);
    await s.nudge();
    await running('run', { ...capture, project: 'your-session-expired', scenario: 'quote' });
    await running('render', { project: P, scenario: 'Reenter_password_in_Terminal', render_id: 'x' });
    await job({ kind: 'export', input: { project: 'no-such-project', render_id: 'quote-v1' }, state: 'failed' });
    await job({ kind: 'export', input: { project: P, render_id: 'quote-v1' }, state: 'failed' });
    await s.nudge();
    await sleep(30);
    const lines = w.parsed();
    expect(lines.filter((l) => l.type === 'job_end')).toEqual([
      { type: 'job_end', kind: 'export', outcome: 'failed' },
      { type: 'job_end', kind: 'export', outcome: 'failed', project: P, scenario: 'quote' },
    ]);
    expect(lines.at(-1)).toMatchObject({
      type: 'pending',
      jobs: [
        { kind: 'capture', state: 'running' },
        { kind: 'render', state: 'running', project: P },
      ],
    });
    expect(JSON.stringify(lines)).not.toMatch(/expired|Reenter/);
    s.stop();
  });

  it('each line is framed by newlines: a partial write of another module before it stays a line of its own (review A L3)', async () => {
    const stream: string[] = [];
    const o: PipeOut = { write: (t) => (stream.push(t), true), once: () => undefined };
    const s = sup(o);
    // Something in the process wrote without a newline (as `process.stdout.write('x')` would) before the first line.
    stream.push('x');
    await s.nudge();
    await sleep(30);
    const lines = stream.join('').split('\n');
    expect(lines[0]).toBe('x');
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'pending', jobs: [], jobs_total: 0, unsaved: [], unsaved_total: 0 });
    s.stop();
  });

  it("one read of each live job per poll: the watch's record is reused (review B L15)", async () => {
    const w = out();
    const s = sup(w.o);
    await s.nudge();
    const a = await running('run', capture);
    const reads = vi.spyOn(FileJobQueue.prototype, 'get');
    try {
      await s.nudge();
      expect(reads.mock.calls.filter(([x]) => x === a)).toHaveLength(1);
      reads.mockClear();
      await job({ kind: 'run', input: capture, state: 'succeeded', result: { kind: 'run', status: 'succeeded' } as never }, a);
      await s.nudge();
      expect(reads.mock.calls.filter(([x]) => x === a)).toHaveLength(1);
      expect(w.parsed().filter((l) => l.type === 'job_end')).toEqual([{ type: 'job_end', kind: 'capture', outcome: 'succeeded', project: P, scenario: 'quote' }]);
    } finally {
      reads.mockRestore();
      s.stop();
    }
  });

  it('a queued job with no live worker is left out (critique M2); with a worker it holds Quit', async () => {
    await job({ kind: 'render', input: { project: P, scenario: 'quote', render_id: 'quote-v4' }, state: 'queued' });
    const none = out();
    const a = sup(none.o, { worker: false });
    await a.nudge();
    await sleep(30);
    expect(none.parsed()).toEqual([{ type: 'pending', jobs: [], jobs_total: 0, unsaved: [], unsaved_total: 0 }]);
    a.stop();
    const some = out();
    const b = sup(some.o, { worker: true });
    await b.nudge();
    await sleep(30);
    expect(some.parsed()[0]).toMatchObject({ jobs_total: 1, jobs: [{ kind: 'render', state: 'queued' }] });
    b.stop();
  });

  it(`at most ${JOB_END_PER_MIN} job_end lines a minute`, async () => {
    const w = out();
    const logs: string[] = [];
    const s = new Supervisor({
      root: ws,
      queue: new FileJobQueue(ws),
      board: new UnsavedBoard(join(ws, 'projects')),
      out: w.o,
      pollMs: 60_000,
      gapMs: 0,
      workerAlive: async () => true,
      log: (m) => logs.push(m),
    });
    await s.nudge();
    for (let i = 0; i < JOB_END_PER_MIN + 5; i++) await job({ kind: 'export', input: { project: P, render_id: 'quote-v1' }, state: 'failed' });
    await s.nudge();
    expect(w.parsed().filter((l) => l.type === 'job_end')).toHaveLength(JOB_END_PER_MIN);
    s.stop();
  });
});

describe('pending: coalesced, latest-wins, capped', () => {
  const tab = (k: number) => `tab${String(k).padStart(19, '0')}`;

  it('20 changes within one gap: no more than one write per gap, the last state written last — at most 4 a second', async () => {
    const board = new UnsavedBoard(join(ws, 'projects'));
    const w = out();
    const s = sup(w.o, { board, gapMs: 250 });
    await s.nudge();
    await sleep(20);
    expect(w.lines).toHaveLength(1);
    // 20 distinct states 10 ms apart (the snapshot alternates): within one gap of 250 ms.
    const t0 = Date.now();
    for (let i = 1; i <= 20; i++) {
      await board.report(tab(1), false, i % 2 ? [{ kind: 'readme', project: P }] : [{ kind: 'comment' }]);
      await sleep(10);
    }
    // The first snapshot, then at most one write per 250 ms gap (a slow machine stretches the loop, not the rule).
    const bound = () => 2 + Math.floor((Date.now() - t0) / 250);
    expect(w.lines.length).toBeLessThanOrEqual(bound());
    await sleep(400);
    expect(w.lines.length).toBeLessThanOrEqual(bound());
    expect(JSON.parse(w.lines.at(-1)!)).toMatchObject({ unsaved: board.items(), unsaved_total: board.items().length });
    s.stop();
  });

  it('stdout full: nothing more is written until it drains, then only the latest state (latest-wins)', async () => {
    const board = new UnsavedBoard(join(ws, 'projects'));
    const w = out(false);
    const s = sup(w.o, { board });
    await s.nudge();
    await sleep(20);
    expect(w.lines).toHaveLength(1);
    for (let i = 0; i < 10; i++) await board.report(tab(i), false, [{ kind: 'readme', project: P }]);
    await board.report(tab(0), false, [{ kind: 'comment' }]);
    await sleep(50);
    expect(w.lines).toHaveLength(1);
    w.o.ok = true;
    w.drain();
    await sleep(50);
    expect(w.lines).toHaveLength(2);
    expect(JSON.parse(w.lines[1]!)).toMatchObject({ unsaved: board.items() });
    s.stop();
  });

  it('a line never passes 8 KB: lists cut to 8 with their totals, emptied if still too long', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: 'capture' as const, state: 'running' as const, project: `p${i}`, scenario: `s${i}` }));
    const cut = JSON.parse(pendingLine({ jobs: many, jobs_total: 30, unsaved: [], unsaved_total: 0 })) as { jobs: unknown[]; jobs_total: number };
    expect(cut.jobs).toHaveLength(8);
    expect(cut.jobs_total).toBe(30);
    const huge = Array.from({ length: 8 }, () => ({ kind: 'capture' as const, state: 'running' as const, project: 'x'.repeat(2000) }));
    const line = pendingLine({ jobs: huge, jobs_total: 8, unsaved: [], unsaved_total: 3 });
    expect(Buffer.byteLength(line)).toBeLessThan(PIPE_LINE_MAX);
    expect(JSON.parse(line)).toEqual({ type: 'pending', jobs: [], jobs_total: 8, unsaved: [], unsaved_total: 3 });
  });
});

describe('the tables', () => {
  it('pipe kinds: one explicit table; preview, auth_login, inspect, site and dry hooks / env resets never count', () => {
    const k = (kind: JobKind, input: Record<string, unknown> = {}) => pipeKind({ kind, input } as never);
    const all = Object.fromEntries(JOB_KINDS.map((x) => [x, k(x, { dry: false })]));
    expect(all).toEqual({
      run: 'capture',
      hooks: 'hooks',
      env_reset: 'env_reset',
      auth_login: undefined,
      sandbox_up: 'sandbox_start',
      sandbox_reset: 'sandbox_reset',
      render: 'render',
      review: 'review',
      export: 'export',
      preview: undefined,
      inspect: undefined,
      record: 'recording',
      site: undefined,
    });
    expect(k('run', { mode: 'dry' })).toBe('dry_run');
    // A recording the Studio started (its controls are on the Record screen: review B L5).
    expect(k('record', { submitted_by: 'ui' })).toBe('studio_recording');
    expect(k('record', { submitted_by: 'mcp' })).toBe('recording');
    expect(k('hooks', { dry: true })).toBeUndefined();
    expect(k('env_reset', { dry: true })).toBeUndefined();
  });

  it('outcomes: failed, interrupted, cancelled (none), a failed or cancelled run, reviews, recordings, hooks', () => {
    const o = (kind: JobKind, state: JobRecord['state'], result?: Record<string, unknown>) => jobOutcome({ kind, state, result } as never);
    const rows: Array<[ReturnType<typeof o>, ReturnType<typeof o>]> = [
      [o('render', 'failed'), { outcome: 'failed' }],
      [o('run', 'interrupted'), { outcome: 'failed', reason: 'interrupted' }],
      [o('run', 'cancelled'), null],
      [o('run', 'queued'), null],
      [o('run', 'succeeded', { status: 'failed' }), { outcome: 'failed', reason: 'run_failed' }],
      [o('run', 'succeeded', { status: 'cancelled' }), null],
      [o('run', 'succeeded', { status: 'succeeded' }), { outcome: 'succeeded' }],
      [o('render', 'succeeded', { review: { state: 'succeeded', clean: false } }), { outcome: 'attention', reason: 'review_issues' }],
      [o('render', 'succeeded', { review: { state: 'succeeded', clean: true } }), { outcome: 'succeeded' }],
      [o('render', 'succeeded', { review: { state: 'failed' } }), { outcome: 'succeeded' }],
      [o('review', 'succeeded', { clean: false }), { outcome: 'attention', reason: 'review_issues' }],
      [o('review', 'succeeded', { clean: true }), { outcome: 'succeeded' }],
      [o('record', 'succeeded', { not_saved: 'studio', check: { status: 'passed' } }), { outcome: 'attention', reason: 'ready_to_save' }],
      [o('record', 'succeeded', { not_saved: 'studio', check: { status: 'failed' } }), { outcome: 'attention', reason: 'check_failed' }],
      [o('record', 'succeeded', { not_saved: 'nothing_recorded', check: { status: 'skipped' } }), { outcome: 'attention', reason: 'nothing_recorded' }],
      [o('record', 'succeeded', { not_saved: 'name_taken', check: { status: 'passed' } }), { outcome: 'attention' }],
      [o('record', 'succeeded', { saved: {}, check: { status: 'passed' } }), { outcome: 'succeeded' }],
      [o('hooks', 'succeeded', { ok: false }), { outcome: 'failed', reason: 'hooks_failed' }],
      [o('env_reset', 'succeeded', { ok: false }), { outcome: 'failed', reason: 'reset_failed' }],
      [o('sandbox_up', 'succeeded', {}), { outcome: 'succeeded' }],
    ];
    for (const [got, want] of rows) expect(got).toEqual(want);
  });
});

describe("each watcher reads the engine's queue with a memory of its own", () => {
  /** The engine's queue as the Studio is handed it: what was read on it itself, and each withOwnMemory asked of it. */
  function engineQueue(): { queue: JobQueueView; reads: string[]; own: Array<string | undefined> } {
    const base = new FileJobQueue(ws, 'retake -C /ws');
    const reads: string[] = [];
    const own: Array<string | undefined> = [];
    const queue = new Proxy(base, {
      get(t, k) {
        if (k === 'withOwnMemory') return (cli?: string) => (own.push(cli), t.withOwnMemory(cli));
        if (typeof k === 'string' && k !== 'root' && k !== 'cli') reads.push(k);
        return Reflect.get(t, k, t);
      },
    });
    return { queue, reads, own };
  }

  it("the supervisor's watch (Quit's pending jobs): one queue of its own, the default `retake` command, nothing read on the engine's", async () => {
    await job({ kind: 'render', input: { project: P, scenario: 'quote', render_id: 'quote-v7' }, state: 'queued' });
    const e = engineQueue();
    const w = out();
    const s = new Supervisor({ root: ws, queue: e.queue, board: new UnsavedBoard(join(ws, 'projects')), out: w.o, pollMs: 60_000, gapMs: 0, workerAlive: async () => true });
    await s.nudge();
    await sleep(30);
    expect(w.parsed().at(-1)).toMatchObject({ type: 'pending', jobs_total: 1 });
    expect({ own: e.own, reads: e.reads }).toEqual({ own: [undefined], reads: [] });
    s.stop();
  });

  it("the Studio's live events: the job watch and the index each one of their own, nothing read on the engine's", async () => {
    await job({ kind: 'render', input: { project: P, scenario: 'quote', render_id: 'quote-v8' }, state: 'queued' });
    const e = engineQueue();
    const logs: string[] = [];
    const live = await Live.start({ ws: await openWorkspace({ root: ws, agent: false }), queue: e.queue, pollMs: 60_000, log: (m) => logs.push(m) });
    try {
      expect(logs.filter((m) => /failed|could not/.test(m))).toEqual([]);
      expect({ own: e.own, reads: e.reads }).toEqual({ own: [undefined, undefined], reads: [] });
    } finally {
      await live.close();
    }
  });
});
