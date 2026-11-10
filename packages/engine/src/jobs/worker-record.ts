/**
 * What one jobs worker holds while it serves a workspace (worker.ts): its options, its record — its settings, the
 * queue and its paths, the two slots, the takes it sees, its counts — and the heavy job's job process. runWorker builds
 * the record once it holds the worker lock; the worker's parts read and change it, each in a module of its own:
 * worker-finish.ts (a job's end this worker writes), worker-recovery.ts (what dead workers and job processes left),
 * worker-claim.ts (the open jobs, the claim of one), worker-heavy.ts (the heavy slot: its job process, its yield while a
 * take films, its cancel, its end), worker-slots.ts (the claims of one turn, the capture slot), worker-signals.ts (the
 * process's signals) and worker-loop.ts (the loop, the drain, the hand-over). They share the record rather than talk
 * through interfaces of their own.
 */
import { hostname } from 'node:os';
import type { JobKind } from '@retake/core';
import type { RecordJobTestHooks } from './record-job.js';
import type { PreviewJobTestHooks } from './preview-job.js';
import type { Renderer } from '../render/renderer.js';
import type { buildDirs } from './build.js';
import { FilmingWatch } from './captures.js';
import type { WorkerLock } from './lock.js';
import type { ProcessIdentity } from './proc.js';
import type { JobQueue } from './job-queue.js';
import type { JobFiles } from './queue.js';
import type { Workspace } from './run-job-record.js';
import type { JobRecord, JobWorkerInfo } from './types.js';
import type { KillFn } from './signal.js';
import type { QosDeps, QosYield } from './yield.js';

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
  /**
   * In-process tests only (never set by worker-main): what render, export and preview jobs render with, instead of the
   * editor's driver. An object cannot reach a job process: with it, heavy jobs run in this process, as with previewTest.
   */
  rendererTest?: Renderer;
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
export interface HeavyChild {
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

/** What one worker holds while it serves a workspace: its settings, the queue, its two slots, the takes it sees, its counts. */
export interface Worker {
  readonly o: WorkerOptions;
  readonly log: (message: string) => void;
  readonly root: string;
  readonly idleExitMs: number;
  readonly pollMs: number;
  readonly buildCheckMs: number;
  readonly cancelGraceMs: number;
  readonly orphanGraceMs: number;
  readonly kill: KillFn | undefined;
  readonly ws: Workspace;
  readonly cli: string;
  readonly queue: JobQueue;
  /** The queue's paths (a render's browser.json), apart from the queue. */
  readonly files: JobFiles;
  readonly dirs: ReturnType<typeof buildDirs>;
  readonly build: string;
  lock: WorkerLock;
  readonly self: ProcessIdentity;
  readonly worker: JobWorkerInfo;
  readonly rw: typeof import('@retake/runner-web');
  readonly sb: typeof import('@retake/sandbox');
  /** previewTest or rendererTest (in-process tests): heavy jobs run in this process, one job at a time, as before L5.14. */
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

/** What runWorker opened and acquired before it serves: the record is built from it. */
export interface WorkerParts {
  o: WorkerOptions;
  log: (message: string) => void;
  root: string;
  ws: Workspace;
  cli: string;
  queue: JobQueue;
  files: JobFiles;
  dirs: ReturnType<typeof buildDirs>;
  build: string;
  lock: WorkerLock;
  self: ProcessIdentity;
  rw: typeof import('@retake/runner-web');
  sb: typeof import('@retake/sandbox');
}

/** A new worker's record: both slots empty, nothing seen yet; its capture runner is set by runWorker (worker-slots.ts). */
export function newWorker(p: WorkerParts): Worker {
  const { o } = p;
  return {
    o,
    log: p.log,
    root: p.root,
    idleExitMs: o.idleExitMs ?? 60_000,
    pollMs: o.pollMs ?? 500,
    buildCheckMs: o.buildCheckMs ?? 5_000,
    cancelGraceMs: o.cancelGraceMs ?? 30_000,
    orphanGraceMs: o.orphanGraceMs ?? 15_000,
    kill: o.jobProcessTest?.kill,
    ws: p.ws,
    cli: p.cli,
    queue: p.queue,
    files: p.files,
    dirs: p.dirs,
    build: p.build,
    lock: p.lock,
    self: p.self,
    worker: { ...p.self, host: hostname() },
    rw: p.rw,
    sb: p.sb,
    inlineHeavy: o.previewTest !== undefined || o.rendererTest !== undefined,
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
    watch: new FilmingWatch({ root: p.root }),
    filmingLive: false,
    filmingCause: undefined,
    filmingCapped: undefined,
    heldWritten: false,
  };
}
