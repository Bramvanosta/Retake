/**
 * The job queue as a port: what its callers need — submit, read (with the states a dead worker could not write derived
 * on the way), the markers a client asks with (cancel, pause, stop), the worker's claim and writes, what holds heavy work
 * and a running heavy job's yield, and the events. No file path in it: the file queue (queue.ts, the product's) keeps its
 * paths in its own file part (JobFiles), used only by the code that reads or writes a job's files itself; the in-memory
 * queue (memory-queue.ts) serves tests. One contract suite holds both (packages/engine/test/job-queue-contract.ts).
 *
 * Only the composition roots build one: the engine (createEngine), the worker (runWorker) and the job process
 * (job-child.ts); everything else is handed the queue (the import-rules ratchet's `queue` rule).
 */
import type { JobInput, JobKind, JobState } from '@retake/core';
import type { ProcessIdentity } from './proc.js';
import type { JobEvent, JobEventBody, JobRecord, JobYield } from './types.js';

/** What holds this workspace's heavy work now: a filming take of this workspace, one elsewhere on this Mac, or nothing. */
export type TakeHold = 'here' | 'elsewhere' | undefined;

/** The worker that claimed a job (its process identity) and when. */
export interface ClaimRecord extends ProcessIdentity {
  at: string;
}

export interface JobFilter {
  project?: string;
  states?: readonly JobState[];
  kinds?: readonly JobKind[];
  /** Only jobs of this run (a `run` job's run_id). */
  runId?: string;
  /** Only jobs about this render (the render_id of a `render`, `review` or `export` job). */
  renderId?: string;
  limit?: number;
}

/** Where a queued job stands in its lane. */
export interface JobPosition {
  ahead: number;
  running?: string;
  held_by?: 'take';
}

/** What the worker of a running heavy job says while the job yields to a filming take (cleared with null). */
export type YieldMark =
  | { state: 'background'; since: string; cause: 'here' | 'elsewhere' }
  | { state: 'past_cap'; since: string; cause: 'here' | 'elsewhere'; cap_min: number };

/** `hold`: what holds heavy work now, read once for a whole list (takeHold). */
export interface DeriveOptions {
  hold?: () => Promise<TakeHold>;
}

export interface JobQueue {
  /** The workspace root (approvals are signed for it). */
  readonly root: string;
  /** How the commands a human is asked to run start ("retake -C <root>"). */
  readonly cli: string;
  /**
   * The same queue for another reader (a watcher of the Studio, the index): its own memory of what it saw — the jobs
   * seen finished, and the filming markers, whose holding time each reader counts over its own scans.
   */
  reader(): JobQueue;

  // ── submit ──
  /**
   * Validate an input and queue it (`queued`), its approvals signed for this job. `files`: files of the job written
   * first (by name, created once: a render's edit snapshot), so a worker that sees the job sees them.
   */
  enqueue(input: JobInput, opts?: { files?: Record<string, string> }): Promise<JobRecord>;

  // ── read ──
  /** Job ids, oldest first. */
  ids(): Promise<string[]>;
  /** The record as stored (no derivation); undefined when there is none (yet). An id that is not one is refused. */
  stored(id: string): Promise<JobRecord | undefined>;
  /** A job as clients see it: its stored record with the cancel request and the derived states. */
  get(id: string, opts?: DeriveOptions): Promise<JobRecord | undefined>;
  /** Derive what a dead worker could not write, the cancel and pause requests and a heavy job's yield. Writes nothing. */
  derive(stored: JobRecord, opts?: DeriveOptions): Promise<JobRecord>;
  /** Jobs, newest first (derived states). */
  list(filter?: JobFilter): Promise<JobRecord[]>;
  /** The job of a run (submitted through the engine), or undefined (a CLI run). */
  ofRun(project: string, runId: string): Promise<JobRecord | undefined>;
  /** The newest render job of a render id, or undefined. */
  ofRender(project: string, renderId: string): Promise<JobRecord | undefined>;
  /** Where a queued job stands in its lane (undefined when it is not queued). */
  position(id: string): Promise<JobPosition | undefined>;

  // ── a client's requests ──
  /** Ask for a cancel (once: asking again keeps the first time). `discard`: the Studio's Discard of a recording window. */
  cancel(id: string, by: string, reason?: 'discard'): Promise<JobRecord>;
  /** When a cancel was asked, or undefined. */
  cancelOf(id: string): Promise<string | undefined>;
  cancelRequested(id: string): Promise<boolean>;
  cancelReason(id: string): Promise<'discard' | undefined>;
  /** Ask a running `run` job to pause (`on`, once) or to resume. */
  requestPause(id: string, on: boolean, by: string): Promise<void>;
  pauseRequested(id: string): Promise<boolean>;
  /** When a pause was asked, or undefined. */
  pauseOf(id: string): Promise<string | undefined>;
  /** Ask a running `record` job to stop and keep (once). */
  requestStop(id: string, by: string): Promise<void>;
  stopRequested(id: string): Promise<boolean>;

  // ── the worker's ──
  /** Take a job: true for exactly one caller. */
  claim(id: string, who: ProcessIdentity): Promise<boolean>;
  claimOf(id: string): Promise<ClaimRecord | undefined>;
  /** Give a claimed job back (only the worker that claimed it, before anything ran). */
  unclaim(id: string): Promise<void>;
  /** Write the record — only the worker holding the job's claim (the derived fields are never written). */
  write(rec: JobRecord): Promise<void>;

  // ── hold / yield ──
  /** What holds this workspace's heavy work now (a filming take queued here, else a filming marker of this user). */
  takeHold(): Promise<TakeHold>;
  /** A running heavy job's yield as its worker set it, checked (fixed words and a time only), or undefined. */
  yieldOf(id: string): Promise<JobYield | undefined>;
  /** Set (or clear, null) a running heavy job's yield — the worker that claimed it only. */
  setYield(id: string, mark: YieldMark | null): Promise<void>;

  // ── events ──
  /** Append events after `seq` (the claiming worker only); returns the last seq written. */
  append(id: string, seq: number, events: readonly JobEventBody[]): Promise<number>;
  /** Events after `after` (seq), oldest first; the last `limit`. */
  events(id: string, opts?: { after?: number; limit?: number }): Promise<JobEvent[]>;
  /** The seq of the last event written (0: none). */
  lastSeq(id: string): Promise<number>;
}
