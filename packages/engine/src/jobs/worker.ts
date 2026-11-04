/**
 * The jobs worker of a workspace (L3.1, L5.14): one process per workspace (the worker lock) with two slots — captures
 * first. The capture slot runs one capture-class job at a time (core JOB_CLASS: takes, what prepares them, sign-ins,
 * recordings, inspections) in this process; the heavy slot runs one heavy job at a time (renders, reviews, exports,
 * previews, site extractions) in a job process of its own (job-child.ts). Each slot claims the oldest queued job of its
 * class, captures whatever their age (pick.ts); a heavy job starts only while no filming take of this workspace is
 * queued or running and no filming marker of this user holds (captures.ts), and a running one yields during a take
 * (background QoS, yield.ts). It exits once idle — or when the workspace disappears, or when its build changed (it then
 * stops claiming and hands over to a new worker once both slots are empty).
 *
 * Signals: the first SIGINT / SIGTERM stops claiming, cancels the running capture (its teardown and rollbacks still run
 * — the runner aborts on the same signal) and the job process (its first signal cancels with teardown), waits for both,
 * then the worker exits. Any later signal quits at once: session copies and what a sandbox take started are removed
 * synchronously, the job process's tree is killed; the quit is deferred to the next tick so that the runner's own
 * second-signal handler (registered after this one) still kills the shell hooks it runs. Every signal to a job process or
 * its tree goes through signal.ts (review B L1: never a pid of -1, 0, 1, the worker itself or its own group).
 *
 * A job whose final state cannot be written makes the worker exit non-zero: readers then see its pid gone and derive
 * `interrupted`, never a `running` job with a live pid that will never finish (a job process whose worker is gone ends
 * its job itself).
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { isFilming, jobClass } from '@retake/core';
import type { JobKind } from '@retake/core';
import type { RecordJobTestHooks } from './record-job.js';
import type { PreviewJobTestHooks } from './preview-job.js';
import type { EngineError } from '../errors.js';
import type { InterruptPort } from '../interrupts.js';
import { refuseBesideOldHolder } from '../legacy.js';
import { openWorkspace } from '../workspace.js';
import { buildDirs, buildStamp } from './build.js';
import { FilmingWatch, capMinutes, heldFile } from './captures.js';
import { JOB_EXIT } from './job-child.js';
import { WorkerLock, workersDir } from './lock.js';
import { pick } from './pick.js';
import type { PickRecord } from './pick.js';
import { isAlive, processStart, selfIdentity } from './proc.js';
import { FileJobQueue, interrupted, stateDir } from './queue.js';
import { appendHistory } from '../history.js';
import { createJobRunner, historyOf, shellQuote, unknownInput } from './run-job-record.js';
import { jobProcessCommand, spawnWorker } from './spawn.js';
import { FINISHED_JOB_STATES } from './types.js';
import type { JobRecord, JobWorkerInfo } from './types.js';
import { killTree, signalTree, signalablePid } from './signal.js';
import type { KillFn } from './signal.js';
import { approvalsUsedDir, consumeApprovals, pruneUsedApprovals, recordDigest, restoreApprovals } from './signing.js';
import { QosYield } from './yield.js';
import type { QosDeps } from './yield.js';

export interface WorkerOptions {
  root: string;
  /** Exit after this long without a job (ms, default 60 000). */
  idleExitMs?: number;
  /** How often the queue and a running job's cancel marker are looked at (ms, default 500 / 250). */
  pollMs?: number;
  /** Run at most one job, then exit (tests). */
  once?: boolean;
  /** Diagnostics (stderr): never stdout. */
  log?: (message: string) => void;
  /** How often the build is compared while idle (ms, default 5 000). */
  buildCheckMs?: number;
  /**
   * In-process tests only (never set by worker-main): Playwright plays the person of a `record` job in a headless
   * "headed" window. A worker process has no way to receive it.
   */
  recordTest?: RecordJobTestHooks;
  /**
   * In-process tests only (never set by worker-main): a stand-in for Remotion and the disk gate's free space in library
   * previews. A function cannot reach a job process: with it, heavy jobs run in this process, one job at a time, as
   * before L5.14 (no capture beside them, no yield).
   */
  previewTest?: PreviewJobTestHooks;
  /** The client that started this worker (`ui`, `mcp`, …): recorded in the worker lock (`started_by`). */
  startedBy?: string;
  /** How long a cancelled heavy job's process may take to end before its tree is killed (ms, default 30 000). */
  cancelGraceMs?: number;
  /** How long a job process left by a dead worker may take to end itself before it is stopped (ms, default 15 000). */
  orphanGraceMs?: number;
  /**
   * In-process tests only (never set by worker-main): a stand-in job process (its command line) and a recorder of the
   * signals the worker sends (signal.ts still checks every target first).
   */
  jobProcessTest?: {
    command?: (job: { id: string; kind: string; root: string; build: string; supervisor: number; digest: string }) => { command: string; args: string[] };
    kill?: KillFn;
    /** The QoS hold's process table and taskpolicy. */
    qos?: Partial<QosDeps>;
    /** Told of each build check (whether the worker's take films then). */
    buildCheck?: (filming: boolean) => void;
    /** The build changed (as if its stamp had): critique L4's test. */
    buildChanged?: () => boolean;
  };
}

/** A heavy job in its job process. */
interface HeavyChild {
  id: string;
  kind: JobKind;
  pid: number;
  exit: Promise<void>;
  exited?: { code: number | null; signal: NodeJS.Signals | null };
  qos: QosYield;
  /** Its yield.json says a take held it past the cap (it goes on at normal priority). */
  pastCap?: boolean;
  /** When this worker first saw the job's cancel marker. */
  cancelSeen?: number;
  killed?: 'cancel';
}

const sleep = (ms: number, wake: { fn?: () => void }) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    wake.fn = () => {
      clearTimeout(t);
      r();
    };
  });

/** A process's command line (`ps -ww`, with a time limit), or null. */
function commandLine(pid: number): Promise<string | null> {
  return new Promise((r) => {
    execFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5_000 }, (err, stdout) => r(err ? null : String(stdout).trim()));
  });
}

/**
 * Review A M1: the process a running job's record names is provably that job's job process — a pid this worker may
 * signal, on this host, running with the recorded start time (ps), with the command line of a job process of this job
 * and this workspace (`worker-main… --job <id> --kind … --root <root> --build`). A hand-edited, restored or synced
 * job.json never makes the worker signal another process.
 */
async function provenJobProcess(id: string, root: string, w: JobWorkerInfo | undefined): Promise<boolean> {
  if (!w || !signalablePid(w.pid) || w.host !== hostname() || typeof w.started_at !== 'string') return false;
  const recorded = Date.parse(w.started_at);
  const start = await processStart(w.pid);
  if (start === null || !Number.isFinite(recorded) || Math.abs(start - recorded) > 2000) return false;
  const cmd = await commandLine(w.pid);
  if (!cmd || !/\/worker-main\.(?:js|ts) /.test(cmd) || !cmd.includes(` --job ${id} --kind `)) return false;
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* the workspace as named */
  }
  return cmd.includes(` --root ${root} --build `) || cmd.includes(` --root ${real} --build `);
}

/** Run a worker until it is idle, stopped or replaced; resolves with the process exit code. */
export async function runWorker(o: WorkerOptions): Promise<number> {
  const log = o.log ?? ((m: string) => void process.stderr.write(`${new Date().toISOString()} worker ${process.pid}: ${m}\n`));
  const root = resolve(o.root);
  const idleExitMs = o.idleExitMs ?? 60_000;
  const pollMs = o.pollMs ?? 500;
  const buildCheckMs = o.buildCheckMs ?? 5_000;
  const cancelGraceMs = o.cancelGraceMs ?? 30_000;
  const orphanGraceMs = o.orphanGraceMs ?? 15_000;
  const kill = o.jobProcessTest?.kill;
  let ws: Awaited<ReturnType<typeof openWorkspace>>;
  try {
    ws = await openWorkspace({ root });
  } catch (e) {
    log(`no workspace at ${root}: ${(e as Error).message}`);
    return 1;
  }
  try {
    await refuseBesideOldHolder(root, 'this jobs worker');
  } catch (e) {
    log(`${(e as Error).message}: exiting (${(e as EngineError).fix ?? ''})`);
    return 1;
  }
  const cli = `retake -C ${shellQuote(root)}`;
  const queue = new FileJobQueue(root, cli);
  const dirs = buildDirs();
  const build = buildStamp(dirs);
  let lock = await WorkerLock.acquire(root, build, log, o.startedBy);
  if (!lock) {
    log('another worker serves this workspace: exiting');
    return 0;
  }
  const self = await selfIdentity();
  const worker: JobWorkerInfo = { ...self, host: hostname() };
  const rw = await import('@retake/runner-web');
  const sb = await import('@retake/sandbox');
  log(`serving ${root} (build ${build})`);

  // ── the slots ──
  /** previewTest (in-process tests): heavy jobs run in this process, one job at a time, as before L5.14. */
  const inlineHeavy = o.previewTest !== undefined;
  /** `filming`: the take films now (runner onFilming: not during its setup / teardown hooks, not while paused — review B M3). */
  let capture: { id: string; filming: boolean; promise: Promise<void> } | undefined;
  let heavy: HeavyChild | undefined;

  // ── signals ──
  let stopping = false;
  let signals = 0;
  const slot: { current?: AbortController; currentStop?: AbortController } = {};
  const quitSync = new Set<() => void>();
  const wake: { fn?: () => void } = {};
  const onSignal = (sig: NodeJS.Signals) => {
    signals++;
    if (signals === 1) {
      stopping = true;
      if (slot.currentStop) {
        log(`${sig}: stopping (the recording's window closes; what was recorded is kept, without its check replay)`);
        slot.currentStop.abort();
      } else {
        log(`${sig}: stopping${slot.current ? ' (cancelling the running job: its teardown still runs)' : ''}`);
        slot.current?.abort(new rw.CancelledError(`run cancelled (${sig})`));
      }
      // The job process cancels its job on its first signal (teardown runs) — the SIGTERM first (review A L4: never behind
      // a pending walk of its tree), then normal priority again.
      const h = heavy;
      if (h && !h.exited) {
        log(`${sig}: cancelling job ${h.id} in its job process`);
        signalTree(h.pid, 'SIGTERM', undefined, kill);
        void rm(queue.yieldFile(h.id), { force: true })
          .catch(() => undefined)
          .then(() => h.qos.release());
      }
      wake.fn?.();
      return;
    }
    rw.removeSessionCopiesSync();
    for (const f of quitSync) {
      try {
        f();
      } catch {
        /* quitting anyway */
      }
    }
    if (heavy && !heavy.exited && signalablePid(heavy.pid)) signalTree(heavy.pid, 'SIGKILL', sb.processTableSync(), kill);
    lock?.release();
    process.nextTick(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // A render that fails mid-way (a refused download, a component error) leaves Remotion's encoder pipe to reject with
  // EPIPE after the failure, unhandled: the job already failed, the worker must not die of it. Anything else still
  // crashes the worker (readers then derive `interrupted`).
  const onRejection = (reason: unknown) => {
    if ((reason as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') {
      log(`ignored a write to a closed pipe after a render (${(reason as Error).message})`);
      return;
    }
    throw reason;
  };
  process.on('unhandledRejection', onRejection);

  const interrupts = (signal: AbortSignal): InterruptPort => ({
    open: async (opts = {}) => {
      const q = opts.onQuitSync;
      if (q) quitSync.add(q);
      return {
        signal,
        get interrupted() {
          return signal.aborted;
        },
        dispose: () => {
          if (q) quitSync.delete(q);
        },
      };
    },
  });

  /** Ids whose stored state is final: not read again. */
  const done = new Set<string>();
  /** A queued job this build does not know while the code changed: a new worker takes it (handover). */
  let newerJob = false;

  /** What a job killed mid-way leaves: its browser (Remotion starts it detached), its lock, partial files. */
  const cleanupDead = async (final: JobRecord): Promise<void> => {
    if (final.input.kind === 'render') {
      const { cleanupInterruptedRender } = await import('./render-job.js');
      await cleanupInterruptedRender(ws, queue, final, log);
    } else if (final.input.kind === 'export') {
      // An export's re-render leaves the same: its browser and partial files.
      const { cleanupInterruptedExport } = await import('./export-job.js');
      await cleanupInterruptedExport(ws, queue, final, log);
    } else if (final.input.kind === 'preview') {
      // A preview's browser, started detached like a render's.
      const { killRecordedBrowser } = await import('./render-job.js');
      await killRecordedBrowser(queue, final, log);
    } else if (final.input.kind === 'review') {
      // A review killed between its two renames leaves the previous review set aside.
      const { cleanupInterruptedReview } = await import('./review-job.js');
      await cleanupInterruptedReview(ws, final, log);
    }
  };

  /** Persist what dead workers could not write (this worker holds the lock: no other one runs). */
  const persistDerived = async (stored: JobRecord): Promise<void> => {
    const rec = await queue.derive(stored);
    if (rec.state === 'interrupted') {
      const final = { ...rec, finished_at: rec.finished_at ?? new Date().toISOString() };
      await queue.write(final);
      done.add(rec.id);
      await appendHistory(root, historyOf(final));
      await cleanupDead(final);
    }
  };

  /** Write job.json, or exit: a job whose state cannot be written must not look alive. */
  const writeOrExit = async (rec: JobRecord): Promise<void> => {
    try {
      await queue.write(rec);
    } catch (e) {
      log(`cannot write the state of job ${rec.id} (${(e as Error).message}): exiting`);
      lock?.release();
      process.exit(1);
    }
  };

  /** Close a job this worker ends itself (its runner never wrote its end): job.json, its last events, its history line. */
  const closeJob = async (final: JobRecord, opts: { cleanup?: boolean } = {}): Promise<void> => {
    await writeOrExit(final);
    try {
      await queue.append(final.id, await queue.lastSeq(final.id), [{ type: 'state', state: final.state }, { type: 'result', ...(final.error ? { error: final.error } : {}) }]);
    } catch (e) {
      log(`job ${final.id}: events not written (${(e as Error).message})`);
    }
    done.add(final.id);
    try {
      await appendHistory(root, historyOf(final));
    } catch (e) {
      log(`job ${final.id}: no history line (${(e as Error).message})`);
    }
    if (opts.cleanup) await cleanupDead(final);
    log(`job ${final.id}: ${final.state} (${final.error?.message.split('\n')[0] ?? ''})`);
  };

  const { runJob } = createJobRunner({
    root,
    ws,
    queue,
    cli,
    build,
    worker,
    self,
    log,
    rw,
    interrupts,
    slot,
    done,
    writeOrExit,
    ...(o.recordTest ? { recordTest: o.recordTest } : {}),
    ...(o.previewTest ? { previewTest: o.previewTest } : {}),
    // A take of this worker started, paused, resumed or stopped filming: its hold follows now, not at the next poll.
    onFilming: (on) => {
      if (capture) capture.filming = on;
      wake.fn?.();
    },
    heavySlowed: () => heavy?.qos.held === true,
  });

  /**
   * The open jobs as `pick` reads them; what a dead worker or job process left is persisted on the way (critique M2:
   * never the jobs of this worker's own slots, whose ends this worker writes itself).
   */
  const scan = async (): Promise<PickRecord[]> => {
    const out: PickRecord[] = [];
    for (const id of await queue.ids()) {
      if (done.has(id)) continue;
      const stored = await queue.stored(id);
      if (!stored) continue;
      if (FINISHED_JOB_STATES.has(stored.state)) {
        done.add(id);
        continue;
      }
      const claimed = (await queue.claimOf(id)) !== undefined;
      if ((stored.state === 'running' || claimed) && id !== capture?.id && id !== heavy?.id) {
        await persistDerived(stored);
        if (done.has(id)) continue;
      }
      // The class comes from the kind of the input the job runs, through this build's JOB_CLASS (no field of job.json orders it).
      const kind = String((stored.input as { kind?: unknown } | undefined)?.kind ?? stored.kind);
      // A cancelled queued take holds nothing (review B L7): only takes are asked (one marker read each).
      const cancelled = stored.state === 'queued' && isFilming(stored.input) && (await queue.cancelRequested(id));
      out.push({ id, state: stored.state, kind, input: stored.input, claimed, ...(cancelled ? { cancelled } : {}) });
    }
    return out;
  };

  const hasQueued = async (): Promise<boolean> => {
    for (const id of await queue.ids()) {
      if (done.has(id)) continue;
      const rec = await queue.get(id);
      if (rec?.state === 'queued') return true;
    }
    return false;
  };

  /**
   * Claim a job (re-read: it may have changed since the scan); undefined when someone else took it, or when it was refused
   * at once — review A M2: a record whose kind is not its input's kind (which a job process would refuse) ends `failed`
   * on its first claim, never claimed and given back in a loop. A job's approvals are taken as it is claimed (signing.ts
   * consumeApprovals): a job whose approvals were taken before (a job folder made again under the same id) is refused.
   */
  const claim = async (id: string): Promise<JobRecord | undefined> => {
    const stored = await queue.stored(id);
    if (!stored || stored.state !== 'queued') return undefined;
    // A job of a newer client (its input version or kind): left for a worker of the new build when the code changed.
    if (unknownInput(stored.input) && buildStamp(dirs) !== build) {
      newerJob = true;
      return undefined;
    }
    if (!(await queue.claim(id, self))) return undefined;
    const inputKind = (stored.input as { kind?: unknown } | undefined)?.kind;
    if (inputKind !== stored.kind) {
      started++;
      ended++;
      await closeJob({
        ...stored,
        state: 'failed',
        finished_at: new Date().toISOString(),
        error: { code: 'invalid', message: `refused without running: job ${id} is a ${JSON.stringify(stored.kind)} job whose input is of kind ${JSON.stringify(inputKind ?? null)}` },
      });
      return undefined;
    }
    // Review B L4: a record that cannot be written is said as such (not as approvals taken before).
    const consumed = await consumeApprovals(stored).then(
      (ok) => (ok ? null : `refused without running: the approvals of job ${id} were taken by an earlier claim of that id (approvals are bound to their job) — submit it again`),
      (e: unknown) => `not run: the record of the approvals workers took (${approvalsUsedDir()}) cannot be written (${(e as Error).message}) — fix it, then submit the job again`,
    );
    if (consumed) {
      started++;
      ended++;
      await closeJob({ ...stored, state: 'failed', finished_at: new Date().toISOString(), error: { code: 'refused', message: consumed } });
      return undefined;
    }
    return stored;
  };

  /** Give a claimed job back to the queue unrun: its claim and the approvals its claim took. */
  const unclaim = async (id: string): Promise<void> => {
    await restoreApprovals(id).catch(() => undefined);
    await queue.unclaim(id);
  };

  let started = 0;
  let ended = 0;
  let idleSince = Date.now();

  const startCapture = (stored: JobRecord) => {
    started++;
    const run = runJob(stored).catch((e: unknown) => log(`job ${stored.id}: ${(e as Error).message}`));
    capture = {
      id: stored.id,
      // Not filming yet: its setup hooks run first (runner onFilming says when it films).
      filming: false,
      promise: run.finally(() => {
        capture = undefined;
        ended++;
        idleSince = Date.now();
        wake.fn?.();
      }),
    };
  };

  const startHeavy = async (stored: JobRecord): Promise<void> => {
    started++;
    await mkdir(workersDir(root), { recursive: true });
    const job = { id: stored.id, kind: stored.kind, build, supervisor: process.pid, digest: recordDigest(stored) };
    const { command, args } = o.jobProcessTest?.command ? o.jobProcessTest.command({ ...job, root }) : jobProcessCommand(root, job);
    const out = openSync(join(workersDir(root), 'worker.log'), 'a');
    let child;
    try {
      child = spawn(command, args, { cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, RETAKE_JOB_BUILD_DIRS: JSON.stringify(dirs) } });
    } finally {
      closeSync(out);
    }
    // A spawn that failed (ENOENT, EAGAIN) has no pid until its `error` event: 0, which signal.ts never signals and QoS
    // never touches (review B L1).
    const pid = child.pid ?? 0;
    const h: HeavyChild = {
      id: stored.id,
      kind: stored.kind,
      pid,
      exit: Promise.resolve(),
      qos: new QosYield(pid, { group: true, ...(o.jobProcessTest?.qos ? { deps: o.jobProcessTest.qos } : {}) }),
    };
    h.exit = new Promise<void>((r) => {
      child.on('exit', (code, signal) => {
        h.exited = { code, signal };
        wake.fn?.();
        r();
      });
      child.on('error', (e) => {
        log(`job ${stored.id}: its job process did not start (${e.message})`);
        h.exited ??= { code: 1, signal: null };
        wake.fn?.();
        r();
      });
    });
    heavy = h;
    log(`job ${stored.id}: running (${stored.kind}) in job process ${child.pid ?? '(none)'}`);
  };

  /** A job process ended: its job's end is its own unless it died first (then this worker writes it: one writer). */
  const onHeavyExit = async (h: HeavyChild): Promise<void> => {
    await rm(queue.yieldFile(h.id), { force: true }).catch(() => undefined);
    if (h.qos.held) await h.qos.release();
    const stored = await queue.stored(h.id);
    if (!stored) return;
    if (FINISHED_JOB_STATES.has(stored.state)) {
      done.add(h.id);
      return;
    }
    const { code, signal } = h.exited ?? { code: null, signal: null };
    if (code === JOB_EXIT.buildChanged && stored.state === 'queued') {
      await unclaim(h.id);
      buildChanged = true;
      log(`job ${h.id}: its job process runs another build: given back to the queue, handing over once idle`);
      return;
    }
    const now = new Date().toISOString();
    const final: JobRecord =
      h.killed === 'cancel'
        ? { ...stored, state: 'cancelled', finished_at: now, error: { code: 'cancelled', message: `cancelled: its job process did not stop within ${Math.round(cancelGraceMs / 1000)} s and was killed` } }
        : code === JOB_EXIT.refused
          ? { ...stored, state: 'failed', finished_at: now, error: { code: 'invalid', message: 'refused by its job process: not the queued heavy job this worker claimed' } }
          : { ...interrupted(stored, cli, `its job process exited (${signal ? `signal ${signal}` : `code ${code}`}) before it wrote the job's end — .retake/workers/worker.log says why`), finished_at: now };
    await closeJob(final, { cleanup: true });
    await rm(queue.browserFile(h.id), { force: true }).catch(() => undefined);
  };

  /**
   * Before any claim (probe 3: no kernel safety net): a job process a dead worker left — it ends its job itself once its
   * worker is gone; given `orphanGraceMs`, then SIGTERM (cancel with teardown), then its tree killed; its end persisted.
   * Only a process provably that job's is ever signalled (review A M1); any other recorded pid is left alone and the job
   * persisted `interrupted` (its clean-ups, which may signal its recorded browser, do not run then).
   */
  const recoverOrphans = async (): Promise<void> => {
    for (const id of await queue.ids()) {
      const stored = await queue.stored(id).catch(() => undefined);
      if (!stored || stored.state !== 'running' || !stored.supervisor || !stored.worker) continue;
      if (stored.worker.pid === process.pid || (await isAlive(stored.supervisor))) continue;
      if (!(await isAlive(stored.worker))) continue; // dead too: persisted as interrupted by the first scan
      if (!(await provenJobProcess(id, root, stored.worker))) {
        log(`job ${id}: the process its record names (pid ${String(stored.worker.pid).slice(0, 12)}) is not provably its job process: left alone, the job ends interrupted`);
        await closeJob({ ...interrupted(stored, cli, 'its jobs worker stopped while the job ran, and the process its record names could not be confirmed as its job process (left alone)'), finished_at: new Date().toISOString() });
        continue;
      }
      const pid = stored.worker.pid;
      log(`job ${id}: its job process (pid ${pid}) outlived its worker: waiting for it to end`);
      const until = Date.now() + orphanGraceMs;
      while (Date.now() < until && (await isAlive(stored.worker))) await new Promise((r) => setTimeout(r, 200));
      if (await isAlive(stored.worker)) {
        signalTree(pid, 'SIGTERM', undefined, kill);
        const t = Date.now() + 5_000;
        while (Date.now() < t && (await isAlive(stored.worker))) await new Promise((r) => setTimeout(r, 200));
        if (await isAlive(stored.worker)) await killTree(pid, kill);
      }
      const after = await queue.stored(id);
      if (after && !FINISHED_JOB_STATES.has(after.state)) await persistDerived(after);
    }
  };

  // ── captures first: the markers of this user's takes ──
  const watch = new FilmingWatch({ root });
  let filmingLive = false;
  let filmingCause: 'here' | 'elsewhere' | undefined;
  /** A live take that films but reached the cap (it holds nothing any more): said on the running heavy job. */
  let filmingCapped: 'here' | 'elsewhere' | undefined;
  const scanFilming = async (): Promise<void> => {
    try {
      const st = await watch.scan();
      filmingLive = st.holding;
      filmingCause = st.cause;
      const capped = st.takes.filter((t) => t.capped && !t.paused);
      filmingCapped = capped.length ? (capped.some((t) => t.here) ? 'here' : 'elsewhere') : undefined;
      for (const _ of st.newlyCapped) log(`a take has held heavy work for over ${capMinutes()} min: heavy work goes on`);
    } catch (e) {
      log(`the filming markers could not be read (${(e as Error).message}): heavy work is not held`);
      filmingLive = false;
      filmingCapped = undefined;
    }
  };

  /** The running heavy job yields while a take films (background QoS on its tree), and ends when cancelled. */
  const steerHeavy = async (h: HeavyChild): Promise<void> => {
    if (h.exited) return;
    // This worker's own take films (its marker may be missing: an unusable captures folder) or a marker holds.
    const own = capture?.filming === true;
    if (filmingLive || own) {
      if (!h.qos.held) {
        const cause = own ? 'here' : (filmingCause ?? 'elsewhere');
        log(`job ${h.id}: background priority while a take films (${cause === 'here' ? 'in this workspace' : 'elsewhere on this Mac'})`);
        await writeFile(queue.yieldFile(h.id), `${JSON.stringify({ v: 1, state: 'background', since: new Date().toISOString(), cause })}\n`).catch(() => undefined);
        h.pastCap = false;
      }
      await h.qos.hold();
    } else {
      if (h.qos.held) {
        // yield.json goes first: whoever sees normal priority again sees it gone (review B H1).
        await rm(queue.yieldFile(h.id), { force: true }).catch(() => undefined);
        await h.qos.release();
        log(`job ${h.id}: normal priority again`);
      }
      // The cap reached (a take still films, but has held heavy work for over the cap): said on the job, not only logged.
      if (filmingCapped && !h.pastCap) {
        h.pastCap = true;
        await writeFile(queue.yieldFile(h.id), `${JSON.stringify({ v: 1, state: 'past_cap', since: new Date().toISOString(), cause: filmingCapped, cap_min: capMinutes() })}\n`).catch(() => undefined);
        log(`job ${h.id}: a take has held heavy work for over ${capMinutes()} min: this job goes on at normal priority`);
      } else if (!filmingCapped && h.pastCap) {
        h.pastCap = false;
        await rm(queue.yieldFile(h.id), { force: true }).catch(() => undefined);
      }
    }
    // Critique M3: a cancelled job ends itself (teardown, clean-ups) — at background priority during a take; its tree
    // is killed only when it has not ended `cancelGraceMs` after the cancel.
    if (h.cancelSeen === undefined && (await queue.cancelRequested(h.id))) h.cancelSeen = Date.now();
    if (h.cancelSeen !== undefined && !h.killed && Date.now() - h.cancelSeen >= cancelGraceMs) {
      h.killed = 'cancel';
      log(`job ${h.id}: still running ${Math.round(cancelGraceMs / 1000)} s after its cancel: killing its job process`);
      await killTree(h.pid, kill);
    }
  };

  /** `.retake/workers/held.json` follows the heavy job's hold: what a take filmed outside this worker reads (TakeBeside). */
  let heldWritten = false;
  const syncHeld = async (): Promise<void> => {
    const on = heavy?.qos.held === true && !heavy.exited;
    if (on === heldWritten) return;
    heldWritten = on;
    if (on) await writeFile(heldFile(root), `${JSON.stringify({ v: 1, state: 'background', since: new Date().toISOString() })}\n`).catch(() => undefined);
    else await rm(heldFile(root), { force: true }).catch(() => undefined);
  };

  // ── the loop ──
  let lastBuildCheck = Date.now();
  let handover = false;
  let buildChanged = false;
  try {
    await recoverOrphans();
    await pruneUsedApprovals().catch(() => undefined);
    await import('@retake/hooks').then((h) => h.pruneDoneRollbacks()).catch(() => undefined);
    for (;;) {
      if (stopping) break;
      const idle = !capture && !heavy;
      if (idle && !existsSync(stateDir(root))) {
        log('the workspace is gone: exiting');
        break;
      }
      if (heavy?.exited) {
        const h = heavy;
        heavy = undefined;
        await onHeavyExit(h);
        ended++;
        idleSince = Date.now();
      }
      await scanFilming();
      if (heavy) await steerHeavy(heavy);
      await syncHeld();
      // Claims. Not while a take of this worker films and the heavy slot has nothing to take (critique M6: the take's
      // event loop is this process's), nor after a build change (critique L4: captures included), nor past `once`.
      let claimed = false;
      const room = !capture || (!heavy && !inlineHeavy && !capture.filming);
      if (room && !buildChanged && !newerJob && !(o.once && started > 0) && !stopping) {
        const records = await scan();
        if (!capture) {
          let id = pick(records, { slot: 'capture', filmingLive });
          if (!id && inlineHeavy) id = pick(records, { slot: 'heavy', filmingLive });
          const stored = id ? await claim(id) : undefined;
          if (stored) {
            startCapture(stored);
            claimed = true;
          }
        }
        if (!heavy && !inlineHeavy && !newerJob && !(o.once && started > 0)) {
          const id = pick(records, { slot: 'heavy', filmingLive: filmingLive || capture?.filming === true });
          const stored = id ? await claim(id) : undefined;
          if (stored) {
            if (jobClass(stored.kind) !== 'heavy' || jobClass(stored.input?.kind) !== 'heavy') await unclaim(stored.id);
            else {
              await startHeavy(stored);
              claimed = true;
            }
          }
        }
      }
      const empty = !capture && !heavy;
      if (empty && newerJob) {
        log('a queued job needs a newer build than this worker: handing over');
        handover = true;
        break;
      }
      if (empty && buildChanged) {
        log('the code changed since this worker started: handing over');
        handover = true;
        break;
      }
      if (empty && o.once && ended > 0) break;
      if (claimed) {
        idleSince = Date.now();
        continue;
      }
      if (empty) {
        if (Date.now() - idleSince >= idleExitMs) {
          // Idle: release the lock, then look once more — a job queued while a client saw this worker alive must not wait.
          lock.release();
          if (!(await hasQueued())) break;
          const again = await WorkerLock.acquire(root, build, log, o.startedBy);
          if (!again) break; // another worker took over
          lock = again;
          idleSince = Date.now();
          continue;
        }
      }
      // Not while this worker's take films (review B L2: the stamp is a synchronous walk on the take's event loop).
      if (Date.now() - lastBuildCheck >= buildCheckMs && capture?.filming !== true) {
        lastBuildCheck = Date.now();
        o.jobProcessTest?.buildCheck?.(capture?.filming ?? false);
        if (o.jobProcessTest?.buildChanged?.() === true || buildStamp(dirs) !== build) {
          if (!buildChanged && !empty) log('the code changed since this worker started: no new job here, handing over once the running ones end');
          buildChanged = true;
          continue;
        }
      }
      await sleep(pollMs, wake);
    }
    // Critique L3: both slots end before the lock is released (a next worker must not claim beside a dying job).
    if (capture) await capture.promise;
    if (heavy) {
      const h = heavy;
      await h.exit;
      heavy = undefined;
      await onHeavyExit(h);
    }
    await syncHeld();
  } finally {
    if (heldWritten) await rm(heldFile(root), { force: true }).catch(() => undefined);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('unhandledRejection', onRejection);
    lock.release();
  }
  if (handover && !stopping && existsSync(stateDir(root)) && (await hasQueued())) await spawnWorker(root, { idleExitMs, ...(o.startedBy ? { startedBy: o.startedBy } : {}) });
  return 0;
}
