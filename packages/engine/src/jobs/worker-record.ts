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
import type { JobKind } from './job-input.js';
import type { Renderer } from '../render/renderer.js';
import type { buildDirs } from './build.js';
import { FilmingWatch } from './captures.js';
import type { WorkerLock } from './lock.js';
import type { ProcessIdentity } from './proc.js';
import type { JobQueue } from './job-queue.js';
import type { JobFiles } from './queue.js';
import type { Workspace } from './run-job-record.js';
import type { JobRecord, JobWorkerInfo } from './types.js';
import type { Clock } from '../clock.js';
import type { CaptureRunner } from '../capture/runner.js';
import type { HookRunner } from '../hook-run/runner.js';
import type { Reviewer } from '../review/reviewer.js';
import type { ProjectStores } from '../store/store.js';
import type { WorkspaceReads } from '../workspace-reads/reads.js';
import type { Sandboxes } from '../sandboxes/sandboxes.js';
import type { ProcInfo } from '@retake/core/io';
import type { QosYield } from './yield.js';
import type { FreeBytes, JobProcesses, RecordWindow, WorkerPortsGiven } from './worker-ports.js';

/** The OS utilities the worker's signal handler calls synchronously (core/io's; L7.25: was the whole sandbox package). */
export interface WorkerOs {
  processTableSync(): ProcInfo[];
}

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
   * The ports this worker runs with instead of the product's (worker-ports.ts WorkerPorts: the engine's, what render,
   * export and preview jobs render with, a `record` job's window, a library preview's free space, the heavy slot's job
   * processes). worker-main hands none. An object cannot reach a job process: with a port a heavy job reads, heavy jobs
   * run in this process (worker-ports.ts HEAVY_JOB_PORTS).
   */
  ports?: WorkerPortsGiven;
  /** The client that started this worker (`ui`, `mcp`, …): recorded in the worker lock (`started_by`). */
  startedBy?: string;
  /** How long a cancelled heavy job's process may take to end before its tree is killed (ms, default 30 000). */
  cancelGraceMs?: number;
  /** How long a job process left by a dead worker may take to end itself before it is stopped (ms, default 15 000). */
  orphanGraceMs?: number;
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
  /** What this worker stamps with (its root's clock, ports.ts). */
  readonly clock: Clock;
  /** What its jobs' authored writes go through. */
  readonly stores: ProjectStores;
  /** What its workspace is read by (its root's, ports.ts): the jobs' loads of projects, scenarios and themes. */
  readonly reads: WorkspaceReads;
  /** What its hooks and env_reset jobs run hooks with, and its recovery prunes the replayed rollbacks with. */
  readonly hooks: HookRunner;
  /** What its inline heavy jobs review with, and its recovery puts an interrupted review back with. */
  readonly reviewer: Reviewer;
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
  /** The capture runner (ports.ts EnginePorts.capture; `capture` names the capture slot): loaded before the signals are listened to. */
  readonly captureRunner: CaptureRunner;
  /** The Sandboxes port (ports.ts EnginePorts.sandboxes), handed to the jobs. */
  readonly sandboxes: Sandboxes;
  /** The OS utilities a second signal uses synchronously (core/io's process table; a test's stand-in). */
  readonly os: WorkerOs;
  /** What render, export and preview jobs run in this process render with (WorkerPorts.renderer). */
  readonly renderer: Renderer;
  /** The window a `record` job opens (WorkerPorts.recordWindow). */
  readonly recordWindow: RecordWindow;
  /** What a library preview job run in this process reads the free space with (WorkerPorts.freeBytes). */
  readonly freeBytes: FreeBytes;
  /** The heavy slot's job processes: their command line, the signals sent to them, their QoS; the build stamp. */
  readonly processes: JobProcesses;
  /** A port a heavy job reads was handed (worker-ports.ts): heavy jobs run in this process, one job at a time, as before L5.14. */
  readonly heavyInProcess: boolean;
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
  clock: Clock;
  stores: ProjectStores;
  reads: WorkspaceReads;
  hooks: HookRunner;
  reviewer: Reviewer;
  ws: Workspace;
  cli: string;
  queue: JobQueue;
  files: JobFiles;
  dirs: ReturnType<typeof buildDirs>;
  build: string;
  lock: WorkerLock;
  self: ProcessIdentity;
  captureRunner: CaptureRunner;
  sandboxes: Sandboxes;
  os: WorkerOs;
  renderer: Renderer;
  recordWindow: RecordWindow;
  freeBytes: FreeBytes;
  processes: JobProcesses;
  heavyInProcess: boolean;
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
    clock: p.clock,
    stores: p.stores,
    reads: p.reads,
    hooks: p.hooks,
    reviewer: p.reviewer,
    ws: p.ws,
    cli: p.cli,
    queue: p.queue,
    files: p.files,
    dirs: p.dirs,
    build: p.build,
    lock: p.lock,
    self: p.self,
    worker: { ...p.self, host: hostname() },
    captureRunner: p.captureRunner,
    sandboxes: p.sandboxes,
    os: p.os,
    renderer: p.renderer,
    recordWindow: p.recordWindow,
    freeBytes: p.freeBytes,
    processes: p.processes,
    heavyInProcess: p.heavyInProcess,
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
