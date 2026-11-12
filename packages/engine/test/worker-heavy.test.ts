/**
 * L5.14a fixes (review B H2, A M1, A M2, B M3): the heavy slot's paths with a stand-in job process (a small script the
 * in-process worker starts instead of `worker-main --job`; every signal the worker sends is recorded, and forwarded only
 * to a stand-in) — no render needed:
 * - a job process that exits 3 (another build) gives its job back (claim removed, still queued) and the worker hands
 *   over to a new worker once empty; exit 1 before `running` → `interrupted` with the worker's events numbered after the
 *   child's; exit 4 → `failed` (invalid);
 * - a cancelled job process that ignores its cancel is killed `cancelGraceMs` later, `cancelled` (was killed);
 * - the worker's first SIGTERM reaches its job process, and the worker exits once it ended;
 * - recovery before the first claim: a job process a dead worker left, provably that job's, is given its grace then
 *   SIGTERMed and the job persisted; a decoy (a pid with no start time, a start time but another command line, pid 0 / 1
 *   / -1) is never signalled and its job ends `interrupted`;
 * - a record whose kind is not its input's kind ends `failed` on its first claim; the honest job behind it runs and the
 *   worker idles out (no claim / unclaim loop);
 * - a take's setup hooks and its pause hold nothing; it holds while it films (real capture, Chromium);
 * - the order of the worker's side effects, pinned before runWorker was split into its parts (worker-*.ts): its
 *   refusals before serving, its first log lines, a job end it writes itself (job.json, events and history, then its
 *   log line), `once`, the rejection guard, a second signal, held.json and the listeners and lock it leaves behind.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APPROVALS_USED_DIR, FileJobQueue, MARKER_NAME_RE, buildDirs, buildStamp, capturesDir, createEngine, heldFile, historyFile, processStart, readWorkerLock, runWorker, signApprovals, workspaceCaptureId } from '../src/index.js';
import type { JobRecord } from '../src/index.js';
import { REPO } from './helpers.js';

/** The stand-in job process: `--mode` says what it does (the rest of its command line is a job process's). */
const FAKE = `const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const id = arg('--job'), root = arg('--root'), mode = arg('--mode');
const dir = path.join(root, '.retake', 'jobs', id);
const job = () => JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
const write = (rec) => { const tmp = path.join(dir, 'job.json.fake'); fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, path.join(dir, 'job.json')); };
let seq = 0;
const event = (e) => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ seq: ++seq, t: new Date().toISOString(), ...e }) + '\\n');
const note = (what) => fs.writeFileSync(path.join(dir, 'fake-' + what), String(process.pid));
const running = () => { write({ ...job(), state: 'running', started_at: new Date().toISOString(), worker: { pid: process.pid, host: os.hostname() } }); event({ type: 'state', state: 'running' }); };
const end = (state) => { write({ ...job(), state, finished_at: new Date().toISOString() }); event({ type: 'state', state }); event({ type: 'result' }); };
note('started');
switch (mode) {
  case 'exit3': process.exit(3);
  case 'exit4': process.exit(4);
  case 'event-exit1': event({ type: 'log', level: 'info', message: 'stand-in: started' }); process.exit(1);
  case 'succeed': running(); setTimeout(() => { end('succeeded'); process.exit(0); }, 200); break;
  case 'until-file': running(); setInterval(() => { if (fs.existsSync(path.join(dir, 'fake-finish'))) { end('succeeded'); process.exit(0); } }, 50); break;
  case 'ignore-term': running(); process.on('SIGTERM', () => note('term')); setInterval(() => {}, 1000); break;
  case 'term': running(); process.on('SIGTERM', () => { note('term'); end('cancelled'); process.exit(0); }); setInterval(() => {}, 1000); break;
  case 'orphan': process.on('SIGTERM', () => { note('term'); process.exit(0); }); setInterval(() => {}, 1000); break;
}
`;

let base: string;
let fakeBin: string;
const savedHome = process.env.RETAKE_HOME;
const children: ChildProcess[] = [];
/** Every signal a worker sent: [target, signal]. */
let sent: Array<[number, NodeJS.Signals]> = [];
/** Pending in-process workers (a failed test's worker is stopped after it). */
const pending = new Set<Promise<number>>();
let baseline: Array<(...a: unknown[]) => void> = [];

/** A stand-in's pid (its command line names the stand-in script). */
const isFake = (pid: number) => spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(Math.abs(pid))], { encoding: 'utf8' }).stdout.includes(fakeBin);
const kill = (target: number, sig: NodeJS.Signals) => {
  sent.push([target, sig]);
  if (isFake(target)) process.kill(target, sig);
};

async function workspace(name: string): Promise<{ root: string; queue: FileJobQueue }> {
  const root = join(base, name);
  await mkdir(join(root, 'projects'), { recursive: true });
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\n');
  return { root, queue: new FileJobQueue(root) };
}

/** A review job (a heavy kind; its project need not exist: the stand-in runs it). */
const review = (q: FileJobQueue, renderId = 'held-v1') => q.enqueue({ version: 1, kind: 'review', project: 'demo', render_id: renderId, fps: 1, submitted_by: 'test' } as never);

/** The in-process worker, its job processes the stand-in in `modes[jobId]` (default: succeed). */
function work(root: string, modes: Record<string, string>, extra: Partial<Parameters<typeof runWorker>[0]> = {}, logs: string[] = []): Promise<number> {
  const p = runWorker({
    root,
    idleExitMs: 400,
    pollMs: 50,
    log: (m) => logs.push(m),
    ...extra,
    ports: {
      ...extra.ports,
      processes: {
        command: (j) => ({ command: process.execPath, args: [fakeBin, '--job', j.id, '--kind', j.kind, '--root', j.root, '--build', j.build, '--supervisor', String(j.supervisor), '--mode', modes[j.id] ?? 'succeed'] }),
        kill,
        ...extra.ports?.processes,
      },
    },
  });
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
}

/** This build's stamp (what the product's build stamp port answers while the code does not change). */
const stamp = buildStamp(buildDirs());

/** A take of this workspace films now: one of its filming markers is live and not paused (read as the worker's slot sees it). */
function filmingHere(root: string): boolean {
  const { dir } = capturesDir(process.env);
  if (!dir) return false;
  const ws = workspaceCaptureId(root);
  return readdirSync(dir)
    .filter((n) => MARKER_NAME_RE.test(n))
    .some((n) => {
      try {
        const m = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { ws?: string; paused?: boolean };
        return m.ws === ws && m.paused !== true;
      } catch {
        return false;
      }
    });
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'retake-worker-heavy-'));
  process.env.RETAKE_HOME = join(base, '.home');
  // Named as a job process's entry: the recovery's command-line proof looks for `/worker-main.js `.
  fakeBin = join(base, 'bin', 'worker-main.js');
  await mkdir(join(base, 'bin'), { recursive: true });
  await writeFile(fakeBin, FAKE);
});

/** The stand-ins still running (by their command line: the script is this file's own). */
const fakes = () =>
  spawnSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((l) => l.includes(fakeBin))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((p) => p > 1 && p !== process.pid);

afterEach(async () => {
  // A worker a failed test left: stopped as a first signal would (its job process cancelled), never killed; a stand-in
  // left running (a mutation that drops a signal) is killed so that its worker ends.
  for (const l of process.listeners('SIGTERM')) if (!baseline.includes(l as never)) (l as (s: string) => void)('SIGTERM');
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  if (pending.size) await new Promise((r) => setTimeout(r, 500));
  for (const pid of fakes()) process.kill(pid, 'SIGKILL');
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 15_000))]);
  sent = [];
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  if (base) await rm(base, { recursive: true, force: true });
});

describe('the heavy slot with a stand-in job process (L5.14a fixes, review B H2)', () => {
  beforeAll(() => {
    baseline = process.listeners('SIGTERM') as never;
  });

  it('exit 3 (another build): the job is given back — claim removed, still queued — and the worker hands over once empty', async () => {
    const { root, queue } = await workspace('exit3');
    const job = await review(queue);
    const logs: string[] = [];
    expect(await work(root, { [job.id]: 'exit3' }, {}, logs)).toBe(0);
    expect(logs.join('\n')).toMatch(/its job process runs another build: given back to the queue/);
    expect(logs.join('\n')).toMatch(/the code changed since this worker started: handing over/);
    expect(existsSync(join(queue.files.job(job.id), 'fake-started'))).toBe(true);
    // The new worker (a real one, from the sources) takes it: it runs to its end there (a review of nothing: failed).
    const end = await waitFor(
      'the new worker ends the job',
      async () => {
        const j = await queue.get(job.id);
        return j && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : undefined;
      },
      90_000,
    );
    expect(end.supervisor?.pid ?? end.worker?.pid).not.toBe(process.pid);
    await waitFor('the new worker gone', async () => (await readWorkerLock(root)) === null || undefined, 30_000);
  }, 120_000);

  it('review B M1: the approvals a claim took are given back with the job (exit 3): the next worker\'s claim takes them, the job is not refused', async () => {
    const { root, queue } = await workspace('exit3-approvals');
    const job = await review(queue, 'approved-v1');
    // A job carrying a signed approval (as a submit writes it), so that its claim takes it.
    const stored = (await queue.stored(job.id))!;
    const input = await signApprovals({ ...stored.input, approvals: [{ fingerprint: 'a'.repeat(64), by: 'human-cli', at: new Date().toISOString() }] } as never, { jobId: job.id, root });
    await writeFile(join(queue.files.job(job.id), 'job.json'), JSON.stringify({ ...stored, input }));
    const used = join(base, '.home', APPROVALS_USED_DIR, job.id);
    const seen: boolean[] = [];
    const logs: string[] = [];
    const log = (m: string) => {
      logs.push(m);
      // Said right after the give-back: the record its claim made is gone by then.
      if (/given back to the queue/.test(m)) seen.push(existsSync(used));
    };
    expect(await work(root, { [job.id]: 'exit3' }, { log })).toBe(0);
    // The worker it handed over to is stopped even when an expect below fails (it would outlive the test's workspace).
    const stopNext = () => {
      const w = readWorkerLock(root);
      if (w && w.pid !== process.pid && alive(w.pid)) process.kill(w.pid, 'SIGTERM');
    };
    try {
      expect(seen).toEqual([false]);
      // The new worker (a real one) claims it: its claim takes the approvals again — the job runs (a review of nothing).
      const end = await waitFor(
        'the new worker ends the job',
        async () => {
          const j = await queue.get(job.id);
          return j && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : undefined;
        },
        90_000,
      );
      expect(end.error?.message ?? '').not.toMatch(/approvals of job .* were taken by an earlier claim/);
      expect(end.supervisor?.pid ?? end.worker?.pid).not.toBe(process.pid);
      expect(existsSync(used)).toBe(true);
      await waitFor('the new worker gone', async () => (await readWorkerLock(root)) === null || undefined, 30_000);
    } finally {
      stopNext();
    }
  }, 120_000);

  it('critique L4: after a build change the worker claims nothing more — a capture included — and hands over once its running job ended', async () => {
    const { root, queue } = await workspace('l4');
    const job = await review(queue);
    let changed = false;
    const logs: string[] = [];
    const worker = work(root, { [job.id]: 'until-file' }, { buildCheckMs: 1, ports: { processes: { buildStamp: () => (changed ? `${stamp}-changed` : stamp) } } }, logs);
    await waitFor('running', async () => (await queue.stored(job.id))?.state === 'running');
    changed = true;
    await waitFor('the build change seen', () => logs.some((l) => /the code changed since this worker started: no new job here/.test(l)));
    // A capture-class job queued now (a dry run): never claimed by this worker of the old build.
    const take = await queue.enqueue({ version: 1, kind: 'run', project: 'w', scenario: 's', scenario_sha256: 'a'.repeat(64), run_id: '20261104-150000-s', mode: 'dry', submitted_by: 'test' } as never);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await queue.claimOf(take.id)).toBeUndefined();
    // Cancelled before the old worker ends (no new worker is started for it), then the running job ends.
    await queue.cancel(take.id, 'test');
    await writeFile(join(queue.files.job(job.id), 'fake-finish'), '');
    expect(await worker).toBe(0);
    expect(await queue.claimOf(take.id)).toBeUndefined();
    expect((await queue.stored(job.id))?.state).toBe('succeeded');
    expect(logs.join('\n')).toMatch(/the code changed since this worker started: handing over/);
  }, 60_000);

  it('the cap reached is said on the running job (yield `past_cap`, its words), not only logged; gone once the take ends', async () => {
    const { FilmingMarker, selfIdentity, yieldWords } = await import('../src/index.js');
    const saved = process.env.RETAKE_CAPTURE_HOLD_MAX_MIN;
    process.env.RETAKE_CAPTURE_HOLD_MAX_MIN = '0.02';
    const { root, queue } = await workspace('cap');
    const job = await review(queue);
    const logs: string[] = [];
    const worker = work(root, { [job.id]: 'until-file' }, {}, logs);
    let m: ReturnType<typeof FilmingMarker.open> = null;
    try {
      await waitFor('running', async () => (await queue.stored(job.id))?.state === 'running');
      m = FilmingMarker.open({ root: join(base, 'cap-elsewhere'), source: 'cli', owner: await selfIdentity() });
      await waitFor('slowed', async () => (await queue.get(job.id))?.yield?.state === 'background');
      // Review A H1: while it holds heavy work the worker keeps one file a take outside it reads.
      await waitFor('the held file', () => existsSync(heldFile(root)));
      expect(JSON.parse(readFileSync(heldFile(root), 'utf8'))).toMatchObject({ v: 1, state: 'background' });
      const capped = await waitFor('past the cap', async () => {
        const y = (await queue.get(job.id))?.yield;
        return y?.state === 'past_cap' ? y : undefined;
      });
      await waitFor('the held file removed with the hold', () => !existsSync(heldFile(root)));
      expect(capped.cause).toBe('elsewhere');
      expect(yieldWords(capped)).toMatch(/^going on: a take \(elsewhere on this Mac\) has held heavy work for longer than the cap$/);
      expect(logs.join('\n')).toMatch(/a take has held heavy work for over 0\.02 min: this job goes on at normal priority/);
      m!.closeSync();
      await waitFor('said no more once the take ended', async () => (await queue.get(job.id))?.yield === undefined || undefined);
      await writeFile(join(queue.files.job(job.id), 'fake-finish'), '');
      expect(await worker).toBe(0);
    } finally {
      m?.closeSync();
      if (saved === undefined) delete process.env.RETAKE_CAPTURE_HOLD_MAX_MIN;
      else process.env.RETAKE_CAPTURE_HOLD_MAX_MIN = saved;
    }
  }, 60_000);

  it('exit 1 before `running`: interrupted, the worker\'s state / result events numbered after the child\'s; exit 4: failed (invalid)', async () => {
    const { root, queue } = await workspace('exit1');
    const one = await review(queue, 'a-v1');
    const four = await review(queue, 'b-v1');
    expect(await work(root, { [one.id]: 'event-exit1', [four.id]: 'exit4' })).toBe(0);
    const a = (await queue.stored(one.id))!;
    expect(a.state).toBe('interrupted');
    expect(a.error?.message).toMatch(/its job process exited \(code 1\) before it wrote the job's end/);
    expect((await queue.events(one.id)).map((e) => [e.seq, e.type])).toEqual([
      [1, 'log'],
      [2, 'state'],
      [3, 'result'],
    ]);
    const b = (await queue.stored(four.id))!;
    expect(b.state).toBe('failed');
    expect(b.error).toMatchObject({ code: 'invalid', message: expect.stringMatching(/refused by its job process/) });
  }, 60_000);

  it('a cancelled job process that ignores its cancel is killed cancelGraceMs later: cancelled (was killed)', async () => {
    const { root, queue } = await workspace('grace');
    const job = await review(queue);
    const logs: string[] = [];
    const worker = work(root, { [job.id]: 'ignore-term' }, { cancelGraceMs: 600 }, logs);
    const run = await waitFor('running', async () => {
      const j = await queue.stored(job.id);
      return j?.state === 'running' ? j : undefined;
    });
    const t0 = Date.now();
    await queue.cancel(job.id, 'test');
    expect(await worker).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    const end = (await queue.stored(job.id))!;
    expect(end.state).toBe('cancelled');
    expect(end.error?.message).toMatch(/did not stop within 1 s and was killed/);
    expect(logs.join('\n')).toMatch(/killing its job process/);
    expect(sent).toContainEqual([-run.worker!.pid, 'SIGKILL']);
    expect(alive(run.worker!.pid)).toBe(false);
  }, 60_000);

  it('the worker\'s first SIGTERM reaches its job process (before any QoS release); the worker exits once it ended', async () => {
    const { root, queue } = await workspace('first-signal');
    const job = await review(queue);
    const logs: string[] = [];
    const before = process.listeners('SIGTERM');
    const worker = work(root, { [job.id]: 'term' }, {}, logs);
    const run = await waitFor('running', async () => {
      const j = await queue.stored(job.id);
      return j?.state === 'running' ? j : undefined;
    });
    const mine = process.listeners('SIGTERM').filter((l) => !before.includes(l));
    expect(mine).toHaveLength(1);
    (mine[0] as (s: string) => void)('SIGTERM');
    expect(await worker).toBe(0);
    expect(sent[0]).toEqual([run.worker!.pid, 'SIGTERM']);
    expect(existsSync(join(queue.files.job(job.id), 'fake-term'))).toBe(true);
    expect((await queue.stored(job.id))?.state).toBe('cancelled');
  }, 30_000);

  it('review A L4: the first signal SIGTERMs the job process at once, even while a walk of its tree is slow (QoS released after)', async () => {
    const { FilmingMarker, selfIdentity } = await import('../src/index.js');
    const { root, queue } = await workspace('slow-walk');
    const job = await review(queue);
    const before = process.listeners('SIGTERM');
    // Every walk of the tree takes 3 s (a slow `ps`); a take films elsewhere, so the job is held.
    const slowTable = async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      return [];
    };
    const worker = work(root, { [job.id]: 'term' }, { ports: { processes: { qos: { table: slowTable, apply: async () => undefined } } } });
    await waitFor('running', async () => (await queue.stored(job.id))?.state === 'running');
    const take = FilmingMarker.open({ root: join(base, 'elsewhere'), source: 'cli', owner: await selfIdentity() })!;
    try {
      await waitFor('held', () => existsSync(queue.files.yield(job.id)));
      const mine = process.listeners('SIGTERM').filter((l) => !before.includes(l));
      const t0 = Date.now();
      (mine[0] as (s: string) => void)('SIGTERM');
      await waitFor('the job process got its SIGTERM', () => existsSync(join(queue.files.job(job.id), 'fake-term')), 10_000);
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(await worker).toBe(0);
    } finally {
      take.closeSync();
    }
  }, 60_000);

  it('review B L1: a job process that cannot start (no pid yet) is never signalled, even by a first signal right then; its job ends interrupted', async () => {
    const { root, queue } = await workspace('no-spawn');
    const job = await review(queue);
    const before = process.listeners('SIGTERM');
    const logs: string[] = [];
    const log = (m: string) => {
      logs.push(m);
      // The spawn failure window: the worker holds the child, no pid, no `error` event yet.
      if (m.includes('in job process (none)')) for (const l of process.listeners('SIGTERM').filter((x) => !before.includes(x))) (l as (s: string) => void)('SIGTERM');
    };
    expect(await work(root, {}, { log, ports: { processes: { command: () => ({ command: join(base, 'missing', 'node'), args: [] }) } } })).toBe(0);
    expect(logs.join('\n')).toMatch(/its job process did not start/);
    expect(sent).toEqual([]);
    expect((await queue.stored(job.id))?.state).toBe('interrupted');
  }, 30_000);

  it('review A M1: recovery signals only a job process provably that job\'s (before any claim); decoys and pids 0 / 1 / -1 are left alone, their jobs interrupted', async () => {
    const { root, queue } = await workspace('recover');
    const dead = deadPid();
    const supervisor = { pid: dead, started_at: new Date(Date.now() - 60_000).toISOString(), host: hostname() };
    const asRunning = async (rec: JobRecord, worker: Record<string, unknown>) => {
      await queue.claim(rec.id, { pid: dead });
      await queue.write({ ...rec, state: 'running', started_at: new Date().toISOString(), worker: worker as never, supervisor });
    };
    // The real orphan: a job process of this job and this workspace, its start time recorded.
    const orphanJob = await review(queue, 'orphan-v1');
    const orphan = spawn(process.execPath, [fakeBin, '--job', orphanJob.id, '--kind', 'review', '--root', root, '--build', 'x', '--supervisor', String(dead), '--mode', 'orphan'], { stdio: 'ignore', detached: true });
    children.push(orphan);
    await waitFor('the orphan started', () => existsSync(join(queue.files.job(orphanJob.id), 'fake-started')));
    const orphanStart = await processStart(orphan.pid!);
    await asRunning(orphanJob, { pid: orphan.pid, started_at: new Date(orphanStart!).toISOString(), host: hostname() });
    // Decoys: a process of the user with no recorded start time; one with its start time but not a job process; pids 0, 1, -1.
    const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(sleeper);
    const sleeperStart = await waitFor('ps sees the sleeper', () => processStart(sleeper.pid!).then((t) => t ?? undefined));
    const decoys: Record<string, JobRecord> = {};
    for (const [name, worker] of Object.entries({
      'no-start': { pid: sleeper.pid, host: hostname() },
      'not-a-job-process': { pid: sleeper.pid, started_at: new Date(sleeperStart).toISOString(), host: hostname() },
      'another-host': { pid: orphan.pid, started_at: new Date(orphanStart!).toISOString(), host: 'another-mac.example' },
      zero: { pid: 0, host: hostname() },
      one: { pid: 1, host: hostname() },
      minus: { pid: -1, host: hostname() },
    })) {
      decoys[name] = await review(queue, `${name}-v1`);
      await asRunning(decoys[name]!, worker);
    }
    // Queued after them: claimed only once recovery is done.
    const later = await review(queue, 'later-v1');
    const logs: string[] = [];
    expect(await work(root, { [later.id]: 'succeed' }, { orphanGraceMs: 300 }, logs)).toBe(0);
    // The orphan: its grace, then a SIGTERM to it alone, its job persisted.
    expect(sent).toEqual([[orphan.pid!, 'SIGTERM']]);
    expect(existsSync(join(queue.files.job(orphanJob.id), 'fake-term'))).toBe(true);
    expect((await queue.stored(orphanJob.id))?.state).toBe('interrupted');
    const order = logs.findIndex((l) => l.includes(`job ${orphanJob.id}: its job process`));
    const claimed = logs.findIndex((l) => l.includes(`job ${later.id}: running`));
    expect(order).toBeGreaterThanOrEqual(0);
    expect(claimed).toBeGreaterThan(order);
    // Decoys: never signalled, still running; their jobs interrupted.
    expect(alive(sleeper.pid!)).toBe(true);
    for (const [name, rec] of Object.entries(decoys)) expect((await queue.stored(rec.id))?.state, name).toBe('interrupted');
    expect(logs.join('\n')).toMatch(/is not provably its job process: left alone/);
    expect((await queue.stored(later.id))?.state).toBe('succeeded');
  }, 60_000);

  it('review A M2: a record whose kind is not its input\'s ends failed on its first claim; the honest job behind it runs; the worker idles out', async () => {
    const { root, queue } = await workspace('mismatch');
    const forged = await review(queue, 'forged-v1');
    await queue.write({ ...forged, kind: 'run' });
    const honest = await review(queue, 'honest-v1');
    const t0 = Date.now();
    expect(await work(root, {})).toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const f = (await queue.stored(forged.id))!;
    expect(f.state).toBe('failed');
    expect(f.error).toMatchObject({ code: 'invalid', message: expect.stringMatching(/refused without running: .* "run" job whose input is of kind "review"/) });
    expect(existsSync(join(queue.files.job(forged.id), 'fake-started'))).toBe(false);
    expect((await queue.events(forged.id)).map((e) => e.type)).toEqual(['state', 'result']);
    expect((await queue.stored(honest.id))?.state).toBe('succeeded');
  }, 30_000);
});

/** The listeners a worker adds to the process (what it must remove once it returns). */
const listening = () => ({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM'), rejection: process.listenerCount('unhandledRejection') });

describe('the order of the worker\'s side effects (characterization of runWorker, before its split)', () => {
  it('refusals before serving: a workspace that cannot be opened → 1, said, nothing written; a live holder of the lock → 0, said, its lock and the process\'s listeners untouched', async () => {
    const logs: string[] = [];
    const broken = join(base, 'broken-workspace');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'retake.yaml'), 'projects_dir: [unclosed\n');
    expect(await runWorker({ root: broken, idleExitMs: 200, pollMs: 50, log: (m) => logs.push(m) })).toBe(1);
    expect(logs).toEqual([expect.stringMatching(/^no workspace at .*broken-workspace: /)]);
    expect(existsSync(join(broken, '.retake'))).toBe(false);
    const { root, queue } = await workspace('held-lock');
    const job = await review(queue);
    const first = work(root, { [job.id]: 'until-file' });
    await waitFor('running', async () => (await queue.stored(job.id))?.state === 'running');
    const holder = readWorkerLock(root);
    const before = listening();
    const second: string[] = [];
    expect(await runWorker({ root, idleExitMs: 200, pollMs: 50, log: (m) => second.push(m) })).toBe(0);
    expect(second).toEqual(['another worker serves this workspace: exiting']);
    expect(listening()).toEqual(before);
    expect(readWorkerLock(root)).toEqual(holder);
    await writeFile(join(queue.files.job(job.id), 'fake-finish'), '');
    expect(await first).toBe(0);
  }, 30_000);

  it('a job process that writes its own end: serving, then running; no line of the worker\'s own; once idle its lock and every listener it added are gone', async () => {
    const { root, queue } = await workspace('own-end');
    const job = await review(queue);
    const before = listening();
    const logs: string[] = [];
    let during: ReturnType<typeof listening> | undefined;
    const p = work(root, { [job.id]: 'succeed' }, {}, logs);
    await waitFor('running', async () => (await queue.stored(job.id))?.state === 'running');
    during = listening();
    expect(await p).toBe(0);
    expect(during).toEqual({ int: before.int + 1, term: before.term + 1, rejection: before.rejection + 1 });
    expect(logs[0]).toMatch(new RegExp(`^serving ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(build [^)]+\\)$`));
    expect(logs.filter((l) => l.startsWith(`job ${job.id}:`))).toEqual([expect.stringMatching(new RegExp(`^job ${job.id}: running \\(review\\) in job process \\d+$`))]);
    expect((await queue.stored(job.id))?.state).toBe('succeeded');
    // The job process ended it: the history line is its own (the stand-in writes none), the worker writes none.
    expect(existsSync(historyFile(root))).toBe(false);
    expect(readWorkerLock(root)).toBeNull();
    expect(listening()).toEqual(before);
    expect(existsSync(heldFile(root))).toBe(false);
  }, 30_000);

  it('a job the worker ends itself: job.json, then its state / result events and its history line, then its log line', async () => {
    const { root, queue } = await workspace('worker-end');
    const job = await review(queue);
    const seen: Array<{ state?: string; events: string[]; history: string[] }> = [];
    const logs: string[] = [];
    const log = (m: string) => {
      logs.push(m);
      if (m.startsWith(`job ${job.id}: interrupted (`)) {
        const rec = JSON.parse(readFileSync(queue.files.record(job.id), 'utf8')) as JobRecord;
        const events = readFileSync(join(queue.files.job(job.id), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type);
        const history = existsSync(historyFile(root)) ? readFileSync(historyFile(root), 'utf8').trim().split('\n') : [];
        seen.push({ state: rec.state, events, history });
      }
    };
    expect(await work(root, { [job.id]: 'event-exit1' }, { log })).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.state).toBe('interrupted');
    expect(seen[0]!.events).toEqual(['log', 'state', 'result']);
    expect(seen[0]!.history.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([expect.objectContaining({ kind: 'review', state: 'interrupted' })]);
    // Running, then the clean-ups of a job killed mid-way (a review's leftovers: its project is none here), then its end.
    expect(logs.filter((l) => l.startsWith(`job ${job.id}:`))).toEqual([
      expect.stringMatching(/: running \(review\) in job process \d+$/),
      expect.stringMatching(/: review leftovers not removed \(/),
      expect.stringMatching(/: interrupted \(interrupted: its job process exited \(code 1\) before it wrote the job's end/),
    ]);
  }, 30_000);

  it('`once`: one job, then the worker exits; the next one stays queued, unclaimed, and no worker is started for it', async () => {
    const { root, queue } = await workspace('once');
    const a = await review(queue, 'a-v1');
    const b = await review(queue, 'b-v1');
    expect(await work(root, {}, { once: true })).toBe(0);
    expect((await queue.stored(a.id))?.state).toBe('succeeded');
    expect((await queue.stored(b.id))?.state).toBe('queued');
    expect(await queue.claimOf(b.id)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(readWorkerLock(root)).toBeNull();
  }, 30_000);

  it('the rejection guard: an EPIPE is said and ignored, anything else thrown again; it goes with the worker', async () => {
    const { root, queue } = await workspace('epipe');
    const job = await review(queue);
    const before = process.listeners('unhandledRejection');
    const logs: string[] = [];
    const p = work(root, { [job.id]: 'until-file' }, {}, logs);
    await waitFor('running', async () => (await queue.stored(job.id))?.state === 'running');
    const mine = process.listeners('unhandledRejection').filter((l) => !before.includes(l)) as Array<(reason: unknown) => void>;
    expect(mine).toHaveLength(1);
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => mine[0]!(epipe)).not.toThrow();
    expect(logs).toContain('ignored a write to a closed pipe after a render (write EPIPE)');
    const other = new Error('boom');
    expect(() => mine[0]!(other)).toThrow(other);
    await writeFile(join(queue.files.job(job.id), 'fake-finish'), '');
    expect(await p).toBe(0);
    expect(process.listeners('unhandledRejection').filter((l) => !before.includes(l))).toEqual([]);
  }, 30_000);

  it('a second signal quits at once: the job process\'s tree SIGKILLed after its first SIGTERM, the lock released, exit 130 on the next tick', async () => {
    const { root, queue } = await workspace('second-signal');
    const job = await review(queue);
    const before = process.listeners('SIGTERM');
    const logs: string[] = [];
    const exits: Array<number | string | null | undefined> = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => void exits.push(code)) as never);
    try {
      const p = work(root, { [job.id]: 'ignore-term' }, {}, logs);
      const run = await waitFor('running', async () => {
        const j = await queue.stored(job.id);
        return j?.state === 'running' ? j : undefined;
      });
      const mine = process.listeners('SIGTERM').filter((l) => !before.includes(l)) as Array<(s: string) => void>;
      expect(mine).toHaveLength(1);
      mine[0]!('SIGTERM');
      expect(logs).toContain('SIGTERM: stopping');
      expect(logs).toContain(`SIGTERM: cancelling job ${job.id} in its job process`);
      expect(readWorkerLock(root)).not.toBeNull();
      mine[0]!('SIGTERM');
      expect(readWorkerLock(root)).toBeNull();
      expect(exits).toEqual([]);
      await new Promise((r) => setImmediate(r));
      expect(exits).toEqual([130]);
      const pid = run.worker!.pid;
      expect(sent[0]).toEqual([pid, 'SIGTERM']);
      expect(sent[1]).toEqual([-pid, 'SIGKILL']);
      // The worker goes on here (its exit is a stand-in): the killed job process ends its job interrupted.
      expect(await p).toBe(0);
      expect((await queue.stored(job.id))?.state).toBe('interrupted');
    } finally {
      exit.mockRestore();
    }
  }, 30_000);

  it('a worker stopped while it holds heavy work: held.json written during the hold, gone once it returned', async () => {
    const { FilmingMarker, selfIdentity } = await import('../src/index.js');
    const { root, queue } = await workspace('held-stop');
    const job = await review(queue);
    const before = process.listeners('SIGTERM');
    const p = work(root, { [job.id]: 'term' });
    await waitFor('running', async () => (await queue.stored(job.id))?.state === 'running');
    const take = FilmingMarker.open({ root: join(base, 'held-stop-elsewhere'), source: 'cli', owner: await selfIdentity() })!;
    try {
      await waitFor('the held file', () => existsSync(heldFile(root)));
      (process.listeners('SIGTERM').filter((l) => !before.includes(l))[0] as (s: string) => void)('SIGTERM');
      expect(await p).toBe(0);
      expect(existsSync(heldFile(root))).toBe(false);
      expect((await queue.stored(job.id))?.state).toBe('cancelled');
    } finally {
      take.closeSync();
    }
  }, 30_000);
});

function chromiumAvailable(): boolean {
  if (process.env.RETAKE_CHROMIUM) return existsSync(process.env.RETAKE_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!chromiumAvailable() || !hasFfmpeg)('review B M3: a take holds heavy work while it films only (real capture)', () => {
  let server: Server;
  let release: (() => void) | undefined;
  let releaseBusy: (() => void) | undefined;
  let hookSeen = false;

  beforeAll(async () => {
    baseline = process.listeners('SIGTERM') as never;
    server = createServer((req, res) => {
      if (req.url === '/busy') {
        releaseBusy = () => res.end('ok');
        return;
      }
      if (req.url === '/hold') {
        hookSeen = true;
        release = () => res.end('ok');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Held</title><body style="font:40px sans-serif"><h1>A page filmed</h1><button>Go</button></body>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  });
  afterAll(async () => {
    release?.();
    releaseBusy?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('review B L7: a cancelled queued take holds nothing — a render runs while the capture slot is busy (hooks), the take is closed after', async () => {
    const { root, queue } = await workspace('cancelled-take');
    const port = (server.address() as { port: number }).port;
    const project = join(root, 'projects', 'w');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(join(project, 'project.yaml'), ['name: W', 'environments:', '  local:', `    app: http://127.0.0.1:${port}`, ''].join('\n'));
    await writeFile(join(project, 'scenarios', 'busy.yaml'), ['video: busy', 'setup:', '  - name: busy', '    http: {method: POST, url: "{{app}}/busy"}', 'scenes:', '  - id: one', '    page: app', '    open: /', '    steps:', '      - hold: 0.5', ''].join('\n'));
    const engine = await createEngine({ root, client: 'test', autoStartWorker: false });
    const hooks = await engine.hooks.submit({ project: 'w', source: 'busy:setup', dry: false }, { approver: { approve: async () => ({ approved: true as const }) } });
    const take = await queue.enqueue({ version: 1, kind: 'run', project: 'w', scenario: 'busy', scenario_sha256: 'a'.repeat(64), run_id: '20261104-120000-busy', mode: 'capture', submitted_by: 'test' } as never);
    await queue.cancel(take.id, 'test');
    const heavy = await review(queue);
    releaseBusy = undefined;
    const worker = work(root, { [heavy.id]: 'succeed' });
    await waitFor('the capture slot busy with the hooks', () => releaseBusy !== undefined);
    await waitFor('the render done beside it', async () => (await queue.stored(heavy.id))?.state === 'succeeded');
    expect((await queue.stored(take.id))?.state).toBe('queued');
    releaseBusy!();
    expect(await worker).toBe(0);
    expect((await queue.stored(hooks.job.id))?.state).toBe('succeeded');
    expect((await queue.stored(take.id))?.state).toBe('cancelled');
  }, 60_000);

  it('a render starts during the take\'s setup hooks, yields once it films, goes back to normal while it is paused and after it', async () => {
    const { root, queue } = await workspace('live');
    const port = (server.address() as { port: number }).port;
    const project = join(root, 'projects', 'w');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(join(project, 'project.yaml'), ['name: W', 'environments:', '  local:', `    app: http://127.0.0.1:${port}`, 'capture: {width: 640, height: 360, scale: 1, fps: 30}', 'template: default', ''].join('\n'));
    await writeFile(
      join(project, 'scenarios', 'gated.yaml'),
      ['video: gated', 'setup:', '  - name: gate', '    http: {method: POST, url: "{{app}}/hold"}', 'pacing: {scene_start_still: 0.2}', 'scenes:', '  - id: one', '    page: app', '    open: /', '    steps:', ...Array.from({ length: 12 }, () => '      - hold: 0.5'), ''].join('\n'),
    );
    const engine = await createEngine({ root, client: 'test', autoStartWorker: false });
    const take = await engine.runs.submit({ project: 'w', scenario: 'gated', mode: 'capture', hooks: 'run' }, { approver: { approve: async () => ({ approved: true as const }) } });
    const heavy = await review(queue);
    const yieldFile = queue.files.yield(heavy.id);
    // Review B L2: the build is not stamped while the take films (a synchronous walk on the take's event loop): each
    // stamp records whether a take of this workspace films then (its marker, written with the slot's filming state).
    const checks: boolean[] = [];
    const buildStampSeen = () => {
      checks.push(filmingHere(root));
      return stamp;
    };
    const worker = work(root, { [heavy.id]: 'until-file' }, { idleExitMs: 400, buildCheckMs: 1, ports: { processes: { buildStamp: buildStampSeen } } });
    // Setup hooks: not filming — the render starts beside them.
    await waitFor('the setup hook', () => hookSeen);
    await waitFor('the render running during setup', async () => (await queue.stored(heavy.id))?.state === 'running');
    expect(existsSync(yieldFile)).toBe(false);
    release!();
    // Filming: the render yields.
    await waitFor('held while the take films', () => existsSync(yieldFile));
    // Paused (L4.4: not filmed): it holds nothing.
    await engine.runs.pause('w', take.run_id, true);
    await waitFor('normal priority while paused', () => !existsSync(yieldFile), 30_000);
    await engine.runs.pause('w', take.run_id, false);
    await waitFor('held again on resume', () => existsSync(yieldFile), 30_000);
    // Its end: normal priority again.
    await waitFor('the take finished', async () => {
      const j = await queue.get(take.job.id);
      return j && j.state !== 'queued' && j.state !== 'running' ? j : undefined;
    }, 60_000);
    await waitFor('normal priority after the take', () => !existsSync(yieldFile));
    await writeFile(join(queue.files.job(heavy.id), 'fake-finish'), '');
    expect(await worker).toBe(0);
    expect(checks.length).toBeGreaterThan(10);
    expect(checks.filter(Boolean)).toEqual([]);
    expect((await queue.stored(take.job.id))?.state).toBe('succeeded');
    expect((await queue.stored(heavy.id))?.state).toBe('succeeded');
    expect(readFileSync(join(queue.files.job(heavy.id), 'fake-started'), 'utf8')).toMatch(/^\d+$/);
    // L5.14b: the take's report says what ran beside it — no other take, a heavy job of its workspace slowed.
    const run = JSON.parse(readFileSync(join(project, 'runs', take.run_id, 'run.json'), 'utf8')) as { perf: { machine: Record<string, unknown> } };
    expect(run.perf.machine).toMatchObject({ takes_beside: 0, heavy_slowed: true });
  }, 120_000);
});
