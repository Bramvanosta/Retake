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
 * its job itself). *
 * The code is in four parts over one Worker record: finish (a job's end this worker writes itself), recovery (what dead
 * workers and job processes left), claim (the open jobs and the one each slot takes) and run (the two slots and the
 * heavy job's yield); runWorker sets them up and runs the loop.
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
import type { ProcessIdentity } from './proc.js';
import { interrupted } from './queue-core.js';
import { FileJobQueue, stateDir } from './queue.js';
import type { FileJobs } from './queue.js';
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

/** What one worker holds while it serves a workspace: its settings, the queue, its two slots, the takes it sees, its counts. */
interface Worker {
  readonly o: WorkerOptions;
  readonly log: (message: string) => void;
  readonly root: string;
  readonly idleExitMs: number;
  readonly pollMs: number;
  readonly buildCheckMs: number;
  readonly cancelGraceMs: number;
  readonly orphanGraceMs: number;
  readonly kill: KillFn | undefined;
  readonly ws: Awaited<ReturnType<typeof openWorkspace>>;
  readonly cli: string;
  readonly queue: FileJobs;
  readonly dirs: ReturnType<typeof buildDirs>;
  readonly build: string;
  lock: WorkerLock;
  readonly self: ProcessIdentity;
  readonly worker: JobWorkerInfo;
  readonly rw: typeof import('@retake/runner-web');
  readonly sb: typeof import('@retake/sandbox');
  /** previewTest (in-process tests): heavy jobs run in this process, one job at a time, as before L5.14. */
  readonly inlineHeavy: boolean;
  /** `filming`: the take films now (runner onFilming: not during its setup / teardown hooks, not while paused — review B M3). */
  capture?: { id: string; filming: boolean; promise: Promise<void> };
  heavy?: HeavyChild;
  /** The running job's cancel and a `record` job's stop, for the signal handler. */
  readonly slot: { current?: AbortController; currentStop?: AbortController };
  readonly quitSync: Set<() => void>;
  readonly wake: { fn?: () => void };
  stopping: boolean;
  /** Ids whose stored state is final: not read again. */
  readonly done: Set<string>;
  /** A queued job this build does not know while the code changed: a new worker takes it (handover). */
  newerJob: boolean;
  /** The code changed since this worker started (or a job process runs another build): no claim, hand over once idle. */
  buildChanged: boolean;
  started: number;
  ended: number;
  idleSince: number;
  runJob: (stored: JobRecord) => Promise<void>;
  // ── captures first: the markers of this user's takes ──
  readonly watch: FilmingWatch;
  filmingLive: boolean;
  filmingCause: 'here' | 'elsewhere' | undefined;
  /** A live take that films but reached the cap (it holds nothing any more): said on the running heavy job. */
  filmingCapped: 'here' | 'elsewhere' | undefined;
  /** `.retake/workers/held.json` is written (it follows the heavy job's hold). */
  heldWritten: boolean;
}

// ── finish: a job's end, written by this worker when its runner did not write it ──

/** Write job.json, or exit: a job whose state cannot be written must not look alive. */
async function writeOrExit(w: Worker, rec: JobRecord): Promise<void> {
  try {
    await w.queue.write(rec);
  } catch (e) {
    w.log(`cannot write the state of job ${rec.id} (${(e as Error).message}): exiting`);
    w.lock?.release();
    process.exit(1);
  }
}

/** Close a job this worker ends itself (its runner never wrote its end): job.json, its last events, its history line. */
async function closeJob(w: Worker, final: JobRecord, opts: { cleanup?: boolean } = {}): Promise<void> {
  await writeOrExit(w, final);
  try {
    await w.queue.append(final.id, await w.queue.lastSeq(final.id), [{ type: 'state', state: final.state }, { type: 'result', ...(final.error ? { error: final.error } : {}) }]);
  } catch (e) {
    w.log(`job ${final.id}: events not written (${(e as Error).message})`);
  }
  w.done.add(final.id);
  try {
    await appendHistory(w.root, historyOf(final));
  } catch (e) {
    w.log(`job ${final.id}: no history line (${(e as Error).message})`);
  }
  if (opts.cleanup) await cleanupDead(w, final);
  w.log(`job ${final.id}: ${final.state} (${final.error?.message.split('\n')[0] ?? ''})`);
}

/** A job process ended: its job's end is its own unless it died first (then this worker writes it: one writer). */
async function onHeavyExit(w: Worker, h: HeavyChild): Promise<void> {
  await w.queue.setYield(h.id, null).catch(() => undefined);
  if (h.qos.held) await h.qos.release();
  const stored = await w.queue.stored(h.id);
  if (!stored) return;
  if (FINISHED_JOB_STATES.has(stored.state)) {
    w.done.add(h.id);
    return;
  }
  const { code, signal } = h.exited ?? { code: null, signal: null };
  if (code === JOB_EXIT.buildChanged && stored.state === 'queued') {
    await unclaimJob(w, h.id);
    w.buildChanged = true;
    w.log(`job ${h.id}: its job process runs another build: given back to the queue, handing over once idle`);
    return;
  }
  const now = new Date().toISOString();
  const final: JobRecord =
    h.killed === 'cancel'
      ? { ...stored, state: 'cancelled', finished_at: now, error: { code: 'cancelled', message: `cancelled: its job process did not stop within ${Math.round(w.cancelGraceMs / 1000)} s and was killed` } }
      : code === JOB_EXIT.refused
        ? { ...stored, state: 'failed', finished_at: now, error: { code: 'invalid', message: 'refused by its job process: not the queued heavy job this worker claimed' } }
        : { ...interrupted(stored, w.cli, `its job process exited (${signal ? `signal ${signal}` : `code ${code}`}) before it wrote the job's end — .retake/workers/worker.log says why`), finished_at: now };
  await closeJob(w, final, { cleanup: true });
  await rm(w.queue.files.browser(h.id), { force: true }).catch(() => undefined);
}

// ── recovery: what dead workers and job processes left ──

/** What a job killed mid-way leaves: its browser (Remotion starts it detached), its lock, partial files. */
async function cleanupDead(w: Worker, final: JobRecord): Promise<void> {
  if (final.input.kind === 'render') {
    const { cleanupInterruptedRender } = await import('./render-job.js');
    await cleanupInterruptedRender(w.ws, w.queue.files, final, w.log);
  } else if (final.input.kind === 'export') {
    // An export's re-render leaves the same: its browser and partial files.
    const { cleanupInterruptedExport } = await import('./export-job.js');
    await cleanupInterruptedExport(w.ws, w.queue.files, final, w.log);
  } else if (final.input.kind === 'preview') {
    // A preview's browser, started detached like a render's.
    const { killRecordedBrowser } = await import('./render-job.js');
    await killRecordedBrowser(w.queue.files, final, w.log);
  } else if (final.input.kind === 'review') {
    // A review killed between its two renames leaves the previous review set aside.
    const { cleanupInterruptedReview } = await import('./review-job.js');
    await cleanupInterruptedReview(w.ws, final, w.log);
  }
}

/** Persist what dead workers could not write (this worker holds the lock: no other one runs). */
async function persistDerived(w: Worker, stored: JobRecord): Promise<void> {
  const rec = await w.queue.derive(stored);
  if (rec.state === 'interrupted') {
    const final = { ...rec, finished_at: rec.finished_at ?? new Date().toISOString() };
    await w.queue.write(final);
    w.done.add(rec.id);
    await appendHistory(w.root, historyOf(final));
    await cleanupDead(w, final);
  }
}

/**
 * Before any claim (probe 3: no kernel safety net): a job process a dead worker left — it ends its job itself once its
 * worker is gone; given `orphanGraceMs`, then SIGTERM (cancel with teardown), then its tree killed; its end persisted.
 * Only a process provably that job's is ever signalled (review A M1); any other recorded pid is left alone and the job
 * persisted `interrupted` (its clean-ups, which may signal its recorded browser, do not run then).
 */
async function recoverOrphans(w: Worker): Promise<void> {
  for (const id of await w.queue.ids()) {
    const stored = await w.queue.stored(id).catch(() => undefined);
    if (!stored || stored.state !== 'running' || !stored.supervisor || !stored.worker) continue;
    if (stored.worker.pid === process.pid || (await isAlive(stored.supervisor))) continue;
    if (!(await isAlive(stored.worker))) continue; // dead too: persisted as interrupted by the first scan
    if (!(await provenJobProcess(id, w.root, stored.worker))) {
      w.log(`job ${id}: the process its record names (pid ${String(stored.worker.pid).slice(0, 12)}) is not provably its job process: left alone, the job ends interrupted`);
      await closeJob(w, { ...interrupted(stored, w.cli, 'its jobs worker stopped while the job ran, and the process its record names could not be confirmed as its job process (left alone)'), finished_at: new Date().toISOString() });
      continue;
    }
    const pid = stored.worker.pid;
    w.log(`job ${id}: its job process (pid ${pid}) outlived its worker: waiting for it to end`);
    const until = Date.now() + w.orphanGraceMs;
    while (Date.now() < until && (await isAlive(stored.worker))) await new Promise((r) => setTimeout(r, 200));
    if (await isAlive(stored.worker)) {
      signalTree(pid, 'SIGTERM', undefined, w.kill);
      const t = Date.now() + 5_000;
      while (Date.now() < t && (await isAlive(stored.worker))) await new Promise((r) => setTimeout(r, 200));
      if (await isAlive(stored.worker)) await killTree(pid, w.kill);
    }
    const after = await w.queue.stored(id);
    if (after && !FINISHED_JOB_STATES.has(after.state)) await persistDerived(w, after);
  }
}

// ── claim: the open jobs, the one each slot takes ──

/**
 * The open jobs as `pick` reads them; what a dead worker or job process left is persisted on the way (critique M2:
 * never the jobs of this worker's own slots, whose ends this worker writes itself).
 */
async function scanOpenJobs(w: Worker): Promise<PickRecord[]> {
  const out: PickRecord[] = [];
  for (const id of await w.queue.ids()) {
    if (w.done.has(id)) continue;
    const stored = await w.queue.stored(id);
    if (!stored) continue;
    if (FINISHED_JOB_STATES.has(stored.state)) {
      w.done.add(id);
      continue;
    }
    const claimed = (await w.queue.claimOf(id)) !== undefined;
    if ((stored.state === 'running' || claimed) && id !== w.capture?.id && id !== w.heavy?.id) {
      await persistDerived(w, stored);
      if (w.done.has(id)) continue;
    }
    // The class comes from the kind of the input the job runs, through this build's JOB_CLASS (no field of job.json orders it).
    const kind = String((stored.input as { kind?: unknown } | undefined)?.kind ?? stored.kind);
    // A cancelled queued take holds nothing (review B L7): only takes are asked (one marker read each).
    const cancelled = stored.state === 'queued' && isFilming(stored.input) && (await w.queue.cancelRequested(id));
    out.push({ id, state: stored.state, kind, input: stored.input, claimed, ...(cancelled ? { cancelled } : {}) });
  }
  return out;
}

async function hasQueued(w: Worker): Promise<boolean> {
  for (const id of await w.queue.ids()) {
    if (w.done.has(id)) continue;
    const rec = await w.queue.get(id);
    if (rec?.state === 'queued') return true;
  }
  return false;
}

/**
 * Claim a job (re-read: it may have changed since the scan); undefined when someone else took it, or when it was refused
 * at once — review A M2: a record whose kind is not its input's kind (which a job process would refuse) ends `failed`
 * on its first claim, never claimed and given back in a loop. A job's approvals are taken as it is claimed (signing.ts
 * consumeApprovals): a job whose approvals were taken before (a job folder made again under the same id) is refused.
 */
async function claimJob(w: Worker, id: string): Promise<JobRecord | undefined> {
  const stored = await w.queue.stored(id);
  if (!stored || stored.state !== 'queued') return undefined;
  // A job of a newer client (its input version or kind): left for a worker of the new build when the code changed.
  if (unknownInput(stored.input) && buildStamp(w.dirs) !== w.build) {
    w.newerJob = true;
    return undefined;
  }
  if (!(await w.queue.claim(id, w.self))) return undefined;
  const inputKind = (stored.input as { kind?: unknown } | undefined)?.kind;
  if (inputKind !== stored.kind) {
    w.started++;
    w.ended++;
    await closeJob(w, {
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
    w.started++;
    w.ended++;
    await closeJob(w, { ...stored, state: 'failed', finished_at: new Date().toISOString(), error: { code: 'refused', message: consumed } });
    return undefined;
  }
  return stored;
}

/** Give a claimed job back to the queue unrun: its claim and the approvals its claim took. */
async function unclaimJob(w: Worker, id: string): Promise<void> {
  await restoreApprovals(id).catch(() => undefined);
  await w.queue.unclaim(id);
}

/**
 * The claims of one turn of the loop: the capture slot first (with previewTest, heavy jobs too), then the heavy slot.
 * Not while a take of this worker films and the heavy slot has nothing to take (critique M6: the take's event loop is
 * this process's), nor after a build change (critique L4: captures included), nor past `once`. True when one started.
 */
async function claimNext(w: Worker): Promise<boolean> {
  let claimed = false;
  const room = !w.capture || (!w.heavy && !w.inlineHeavy && !w.capture.filming);
  if (room && !w.buildChanged && !w.newerJob && !(w.o.once && w.started > 0) && !w.stopping) {
    const records = await scanOpenJobs(w);
    if (!w.capture) {
      let id = pick(records, { slot: 'capture', filmingLive: w.filmingLive });
      if (!id && w.inlineHeavy) id = pick(records, { slot: 'heavy', filmingLive: w.filmingLive });
      const stored = id ? await claimJob(w, id) : undefined;
      if (stored) {
        startCapture(w, stored);
        claimed = true;
      }
    }
    if (!w.heavy && !w.inlineHeavy && !w.newerJob && !(w.o.once && w.started > 0)) {
      const id = pick(records, { slot: 'heavy', filmingLive: w.filmingLive || w.capture?.filming === true });
      const stored = id ? await claimJob(w, id) : undefined;
      if (stored) {
        if (jobClass(stored.kind) !== 'heavy' || jobClass(stored.input?.kind) !== 'heavy') await unclaimJob(w, stored.id);
        else {
          await startHeavy(w, stored);
          claimed = true;
        }
      }
    }
  }
  return claimed;
}

// ── run: the two slots, and the heavy job's yield while a take films ──

function startCapture(w: Worker, stored: JobRecord): void {
  w.started++;
  const run = w.runJob(stored).catch((e: unknown) => w.log(`job ${stored.id}: ${(e as Error).message}`));
  w.capture = {
    id: stored.id,
    // Not filming yet: its setup hooks run first (runner onFilming says when it films).
    filming: false,
    promise: run.finally(() => {
      w.capture = undefined;
      w.ended++;
      w.idleSince = Date.now();
      w.wake.fn?.();
    }),
  };
}

async function startHeavy(w: Worker, stored: JobRecord): Promise<void> {
  w.started++;
  await mkdir(workersDir(w.root), { recursive: true });
  const job = { id: stored.id, kind: stored.kind, build: w.build, supervisor: process.pid, digest: recordDigest(stored) };
  const { command, args } = w.o.jobProcessTest?.command ? w.o.jobProcessTest.command({ ...job, root: w.root }) : jobProcessCommand(w.root, job);
  const out = openSync(join(workersDir(w.root), 'worker.log'), 'a');
  let child;
  try {
    child = spawn(command, args, { cwd: w.root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, RETAKE_JOB_BUILD_DIRS: JSON.stringify(w.dirs) } });
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
    qos: new QosYield(pid, { group: true, ...(w.o.jobProcessTest?.qos ? { deps: w.o.jobProcessTest.qos } : {}) }),
  };
  h.exit = new Promise<void>((r) => {
    child.on('exit', (code, signal) => {
      h.exited = { code, signal };
      w.wake.fn?.();
      r();
    });
    child.on('error', (e) => {
      w.log(`job ${stored.id}: its job process did not start (${e.message})`);
      h.exited ??= { code: 1, signal: null };
      w.wake.fn?.();
      r();
    });
  });
  w.heavy = h;
  w.log(`job ${stored.id}: running (${stored.kind}) in job process ${child.pid ?? '(none)'}`);
}

async function scanFilming(w: Worker): Promise<void> {
  try {
    const st = await w.watch.scan();
    w.filmingLive = st.holding;
    w.filmingCause = st.cause;
    const capped = st.takes.filter((t) => t.capped && !t.paused);
    w.filmingCapped = capped.length ? (capped.some((t) => t.here) ? 'here' : 'elsewhere') : undefined;
    for (const _ of st.newlyCapped) w.log(`a take has held heavy work for over ${capMinutes()} min: heavy work goes on`);
  } catch (e) {
    w.log(`the filming markers could not be read (${(e as Error).message}): heavy work is not held`);
    w.filmingLive = false;
    w.filmingCapped = undefined;
  }
}

/** The running heavy job yields while a take films (background QoS on its tree), and ends when cancelled. */
async function steerHeavy(w: Worker, h: HeavyChild): Promise<void> {
  if (h.exited) return;
  // This worker's own take films (its marker may be missing: an unusable captures folder) or a marker holds.
  const own = w.capture?.filming === true;
  if (w.filmingLive || own) {
    if (!h.qos.held) {
      const cause = own ? 'here' : (w.filmingCause ?? 'elsewhere');
      w.log(`job ${h.id}: background priority while a take films (${cause === 'here' ? 'in this workspace' : 'elsewhere on this Mac'})`);
      await w.queue.setYield(h.id, { state: 'background', since: new Date().toISOString(), cause }).catch(() => undefined);
      h.pastCap = false;
    }
    await h.qos.hold();
  } else {
    if (h.qos.held) {
      // The yield goes first: whoever sees normal priority again sees it gone (review B H1).
      await w.queue.setYield(h.id, null).catch(() => undefined);
      await h.qos.release();
      w.log(`job ${h.id}: normal priority again`);
    }
    // The cap reached (a take still films, but has held heavy work for over the cap): said on the job, not only logged.
    if (w.filmingCapped && !h.pastCap) {
      h.pastCap = true;
      await w.queue.setYield(h.id, { state: 'past_cap', since: new Date().toISOString(), cause: w.filmingCapped, cap_min: capMinutes() }).catch(() => undefined);
      w.log(`job ${h.id}: a take has held heavy work for over ${capMinutes()} min: this job goes on at normal priority`);
    } else if (!w.filmingCapped && h.pastCap) {
      h.pastCap = false;
      await w.queue.setYield(h.id, null).catch(() => undefined);
    }
  }
  // Critique M3: a cancelled job ends itself (teardown, clean-ups) — at background priority during a take; its tree
  // is killed only when it has not ended `cancelGraceMs` after the cancel.
  if (h.cancelSeen === undefined && (await w.queue.cancelRequested(h.id))) h.cancelSeen = Date.now();
  if (h.cancelSeen !== undefined && !h.killed && Date.now() - h.cancelSeen >= w.cancelGraceMs) {
    h.killed = 'cancel';
    w.log(`job ${h.id}: still running ${Math.round(w.cancelGraceMs / 1000)} s after its cancel: killing its job process`);
    await killTree(h.pid, w.kill);
  }
}

/** `.retake/workers/held.json` follows the heavy job's hold: what a take filmed outside this worker reads (TakeBeside). */
async function syncHeld(w: Worker): Promise<void> {
  const on = w.heavy?.qos.held === true && !w.heavy.exited;
  if (on === w.heldWritten) return;
  w.heldWritten = on;
  if (on) await writeFile(heldFile(w.root), `${JSON.stringify({ v: 1, state: 'background', since: new Date().toISOString() })}\n`).catch(() => undefined);
  else await rm(heldFile(w.root), { force: true }).catch(() => undefined);
}

// ── the worker ──

/** Run a worker until it is idle, stopped or replaced; resolves with the process exit code. */
export async function runWorker(o: WorkerOptions): Promise<number> {
  const log = o.log ?? ((m: string) => void process.stderr.write(`${new Date().toISOString()} worker ${process.pid}: ${m}\n`));
  const root = resolve(o.root);
  let ws: Awaited<ReturnType<typeof openWorkspace>>;
  try {
    // The worker runs every job under trust mcp, whoever submitted it (the Studio, the desktop app, an MCP client).
    ws = await openWorkspace({ root, agent: true });
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
  // The worker process's composition root: the one queue this worker reads and writes.
  const queue = new FileJobQueue(root, cli);
  const dirs = buildDirs();
  const build = buildStamp(dirs);
  const lock = await WorkerLock.acquire(root, build, log, o.startedBy);
  if (!lock) {
    log('another worker serves this workspace: exiting');
    return 0;
  }
  const self = await selfIdentity();
  const rw = await import('@retake/runner-web');
  const sb = await import('@retake/sandbox');
  log(`serving ${root} (build ${build})`);

  const w: Worker = {
    o,
    log,
    root,
    idleExitMs: o.idleExitMs ?? 60_000,
    pollMs: o.pollMs ?? 500,
    buildCheckMs: o.buildCheckMs ?? 5_000,
    cancelGraceMs: o.cancelGraceMs ?? 30_000,
    orphanGraceMs: o.orphanGraceMs ?? 15_000,
    kill: o.jobProcessTest?.kill,
    ws,
    cli,
    queue,
    dirs,
    build,
    lock,
    self,
    worker: { ...self, host: hostname() },
    rw,
    sb,
    inlineHeavy: o.previewTest !== undefined,
    slot: {},
    quitSync: new Set(),
    wake: {},
    stopping: false,
    done: new Set(),
    newerJob: false,
    buildChanged: false,
    started: 0,
    ended: 0,
    idleSince: Date.now(),
    runJob: async () => undefined,
    watch: new FilmingWatch({ root }),
    filmingLive: false,
    filmingCause: undefined,
    filmingCapped: undefined,
    heldWritten: false,
  };

  // ── signals ──
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    signals++;
    if (signals === 1) {
      w.stopping = true;
      if (w.slot.currentStop) {
        log(`${sig}: stopping (the recording's window closes; what was recorded is kept, without its check replay)`);
        w.slot.currentStop.abort();
      } else {
        log(`${sig}: stopping${w.slot.current ? ' (cancelling the running job: its teardown still runs)' : ''}`);
        w.slot.current?.abort(new rw.CancelledError(`run cancelled (${sig})`));
      }
      // The job process cancels its job on its first signal (teardown runs) — the SIGTERM first (review A L4: never behind
      // a pending walk of its tree), then normal priority again.
      const h = w.heavy;
      if (h && !h.exited) {
        log(`${sig}: cancelling job ${h.id} in its job process`);
        signalTree(h.pid, 'SIGTERM', undefined, w.kill);
        void queue
          .setYield(h.id, null)
          .catch(() => undefined)
          .then(() => h.qos.release());
      }
      w.wake.fn?.();
      return;
    }
    rw.removeSessionCopiesSync();
    for (const f of w.quitSync) {
      try {
        f();
      } catch {
        /* quitting anyway */
      }
    }
    if (w.heavy && !w.heavy.exited && signalablePid(w.heavy.pid)) signalTree(w.heavy.pid, 'SIGKILL', sb.processTableSync(), w.kill);
    w.lock?.release();
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
      if (q) w.quitSync.add(q);
      return {
        signal,
        get interrupted() {
          return signal.aborted;
        },
        dispose: () => {
          if (q) w.quitSync.delete(q);
        },
      };
    },
  });

  w.runJob = createJobRunner({
    root,
    ws,
    queue,
    cli,
    build,
    worker: w.worker,
    self,
    log,
    rw,
    interrupts,
    slot: w.slot,
    done: w.done,
    writeOrExit: (rec) => writeOrExit(w, rec),
    ...(o.recordTest ? { recordTest: o.recordTest } : {}),
    ...(o.previewTest ? { previewTest: o.previewTest } : {}),
    // A take of this worker started, paused, resumed or stopped filming: its hold follows now, not at the next poll.
    onFilming: (on) => {
      if (w.capture) w.capture.filming = on;
      w.wake.fn?.();
    },
    heavySlowed: () => w.heavy?.qos.held === true,
  }).runJob;

  // ── the loop ──
  let lastBuildCheck = Date.now();
  let handover = false;
  try {
    await recoverOrphans(w);
    await pruneUsedApprovals().catch(() => undefined);
    await import('@retake/hooks').then((h) => h.pruneDoneRollbacks()).catch(() => undefined);
    for (;;) {
      if (w.stopping) break;
      const idle = !w.capture && !w.heavy;
      if (idle && !existsSync(stateDir(root))) {
        log('the workspace is gone: exiting');
        break;
      }
      if (w.heavy?.exited) {
        const h = w.heavy;
        w.heavy = undefined;
        await onHeavyExit(w, h);
        w.ended++;
        w.idleSince = Date.now();
      }
      await scanFilming(w);
      if (w.heavy) await steerHeavy(w, w.heavy);
      await syncHeld(w);
      const claimed = await claimNext(w);
      const empty = !w.capture && !w.heavy;
      if (empty && w.newerJob) {
        log('a queued job needs a newer build than this worker: handing over');
        handover = true;
        break;
      }
      if (empty && w.buildChanged) {
        log('the code changed since this worker started: handing over');
        handover = true;
        break;
      }
      if (empty && o.once && w.ended > 0) break;
      if (claimed) {
        w.idleSince = Date.now();
        continue;
      }
      if (empty) {
        if (Date.now() - w.idleSince >= w.idleExitMs) {
          // Idle: release the lock, then look once more — a job queued while a client saw this worker alive must not wait.
          w.lock.release();
          if (!(await hasQueued(w))) break;
          const again = await WorkerLock.acquire(root, build, log, o.startedBy);
          if (!again) break; // another worker took over
          w.lock = again;
          w.idleSince = Date.now();
          continue;
        }
      }
      // Not while this worker's take films (review B L2: the stamp is a synchronous walk on the take's event loop).
      if (Date.now() - lastBuildCheck >= w.buildCheckMs && w.capture?.filming !== true) {
        lastBuildCheck = Date.now();
        o.jobProcessTest?.buildCheck?.(w.capture?.filming ?? false);
        if (o.jobProcessTest?.buildChanged?.() === true || buildStamp(dirs) !== build) {
          if (!w.buildChanged && !empty) log('the code changed since this worker started: no new job here, handing over once the running ones end');
          w.buildChanged = true;
          continue;
        }
      }
      await sleep(w.pollMs, w.wake);
    }
    // Critique L3: both slots end before the lock is released (a next worker must not claim beside a dying job).
    if (w.capture) await w.capture.promise;
    if (w.heavy) {
      const h = w.heavy;
      await h.exit;
      w.heavy = undefined;
      await onHeavyExit(w, h);
    }
    await syncHeld(w);
  } finally {
    if (w.heldWritten) await rm(heldFile(root), { force: true }).catch(() => undefined);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('unhandledRejection', onRejection);
    w.lock.release();
  }
  if (handover && !w.stopping && existsSync(stateDir(root)) && (await hasQueued(w))) await spawnWorker(root, { idleExitMs: w.idleExitMs, ...(o.startedBy ? { startedBy: o.startedBy } : {}) });
  return 0;
}
