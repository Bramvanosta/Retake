/**
 * The job queue as a port: what its callers need — submit, read (with the states a dead worker could not write derived
 * on the way), a submit's own files, the markers a client asks with (cancel, pause, stop), the worker's claim and writes,
 * what holds heavy work and a running heavy job's yield, and the events. No file path in it: the file queue (queue.ts,
 * the product's) keeps its paths in its own file part (JobFiles), handed only to the code that reads or writes a job's
 * files itself; the in-memory queue (memory-queue.ts) serves tests. One contract suite holds both
 * (packages/engine/test/job-queue-contract.ts).
 *
 * Two views: JobQueueView reads and asks (what the engine hands its shells as Engine.queue: the MCP server and the
 * Studio), JobQueue adds the submit (the engine's operations, after their checks) and the worker's writes (the claiming
 * worker only). The import-rules ratchet keeps those calls inside packages/engine/src (its `queue-call` rule).
 *
 * Only the composition roots build a queue: the engine (createEngine), the worker (runWorker), the job process
 * (job-child.ts) and the CLI's in-process commands (packages/cli/src/workspace.ts), plus the file queue's own
 * withOwnMemory(); everything else is handed one (the ratchet's `queue` rule).
 */
import type { JobInput, JobKind, JobState } from '@retake/core';
import type { PlainFileProblem } from '@retake/core/io';
import type { ProcessIdentity } from './proc.js';
import type { JobEvent, JobEventBody, JobRecord, JobYield } from './types.js';

/** What holds this workspace's heavy work now: a filming take of this workspace, one elsewhere on this Mac, or nothing. */
export type TakeHold = 'here' | 'elsewhere' | undefined;

/** The worker that claimed a job (its process identity) and when. */
export interface ClaimRecord extends ProcessIdentity {
  at: string;
}

/** A client's marker on a job: when it was asked. */
export interface JobMark {
  at: string;
}

/** A cancel marker: when it was asked, and `discard` for the Studio's Discard of an open recording window. */
export interface CancelMark extends JobMark {
  reason?: 'discard';
}

/** A file a submit added to a job (enqueue `files`), as read: its text, or why there is none to read. */
export type JobFileRead = { ok: true; text: string } | { ok: false; reason: PlainFileProblem };

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

/** The queue as a reader and a client sees it: reads, a submit's files, the client's markers, holds and events. */
export interface JobQueueView {
  /** The workspace root (approvals are signed for it). */
  readonly root: string;
  /** How the commands a human is asked to run start: the first word of a derived `interrupted` job's fix. */
  readonly cli: string;
  /**
   * The same jobs for another watcher (the Studio's job watch, its index, its supervisor): a queue with a memory of its
   * own — the jobs it saw finished (never read again by its takeHold) and the filming markers, whose holding time each
   * one counts over its own scans (captures.ts). `cli`: the command of its derived fix texts (default `retake`).
   */
  withOwnMemory(cli?: string): JobQueueView;

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
  /** The newest render job of a render id (a render id is reused after a failed or cancelled render), or undefined. */
  ofRender(project: string, renderId: string): Promise<JobRecord | undefined>;
  /** Where a queued job stands in its lane (undefined when it is not queued). */
  position(id: string): Promise<JobPosition | undefined>;
  /**
   * A file a submit added to the job (enqueue `files`: a render's edit snapshot), read as it was stored: `missing` when
   * there is none, another reason when it is not a plain file of at most `maxBytes` (never a link followed). A name that
   * is not one a submit may write is refused (`invalid`).
   */
  jobFile(id: string, name: string, maxBytes: number): Promise<JobFileRead>;

  // ── a client's requests ──
  /** Ask for a cancel (once: asking again keeps the first time). `discard`: the Studio's Discard of a recording window. */
  cancel(id: string, by: string, reason?: 'discard'): Promise<JobRecord>;
  /** The cancel asked of a job (when, and its reason), or undefined. */
  cancelOf(id: string): Promise<CancelMark | undefined>;
  /** Ask a running `run` job to pause (`on`, once) or to resume. */
  requestPause(id: string, on: boolean, by: string): Promise<void>;
  /** The pause asked of a job (when), or undefined. */
  pauseOf(id: string): Promise<JobMark | undefined>;
  /** Ask a running `record` job to stop and keep (once). */
  requestStop(id: string, by: string): Promise<void>;
  /** The stop asked of a job (when), or undefined. */
  stopOf(id: string): Promise<JobMark | undefined>;

  /** The worker that claimed a job, or undefined. */
  claimOf(id: string): Promise<ClaimRecord | undefined>;

  // ── hold / yield ──
  /** What holds this workspace's heavy work now (a filming take queued here, else a filming marker of this user). */
  takeHold(): Promise<TakeHold>;
  /** A running heavy job's yield as its worker set it, checked (fixed words and a time only), or undefined. */
  yieldOf(id: string): Promise<JobYield | undefined>;

  // ── events ──
  /** Events after `after` (seq), oldest first; the last `limit`. */
  events(id: string, opts?: { after?: number; limit?: number }): Promise<JobEvent[]>;
  /** The seq of the last event written (0: none): where a writer that did not keep the seq goes on from (append). */
  lastSeq(id: string): Promise<number>;
}

/** The whole queue: the view, the submit (the engine's operations) and the writes of the worker that claimed a job. */
export interface JobQueue extends JobQueueView {
  withOwnMemory(cli?: string): JobQueue;

  // ── submit ──
  /**
   * Validate an input and queue it (`queued`), its approvals signed for this job. `files`: files of the job written
   * first (by name, created once: a render's edit snapshot), so a worker that sees the job sees them (jobFile).
   */
  enqueue(input: JobInput, opts?: { files?: Record<string, string> }): Promise<JobRecord>;
  /**
   * Run `fn` while holding the queue's lock of `key` (L7.26): one holder at a time per key — across processes for the
   * file queue (the Studio, an MCP server, a terminal on one workspace), within its process for the in-memory one; other
   * keys are not held. The engine's admission rules (admission.ts) check and submit under it, so two processes cannot
   * both pass a rule and both enqueue. Released when `fn` settles (a throw too); a holder that died releases it.
   * Not re-entrant: `fn` must not take `exclusive` again (the same key would wait for itself — in the file queue, until
   * its wait ends `busy`; another key may wait on a holder that waits on this one).
   */
  exclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;

  // ── the worker's ──
  /** Take a job: true for exactly one caller. */
  claim(id: string, who: ProcessIdentity): Promise<boolean>;
  /** Give a claimed job back (only the worker that claimed it, before anything ran). */
  unclaim(id: string): Promise<void>;
  /** Write the record — only the worker holding the job's claim (the derived fields are never written). */
  write(rec: JobRecord): Promise<void>;
  /** Set (or clear, null) a running heavy job's yield — the worker that claimed it only. */
  setYield(id: string, mark: YieldMark | null): Promise<void>;

  // ── events ──
  /**
   * Append events after `seq` — the claiming worker only (one writer at a time, so seqs are never checked): they get
   * seq + 1, seq + 2… in order, and the last one is returned, which the writer passes to its next append. A writer
   * that did not keep it (the worker closing a job whose process died) starts from lastSeq. Nothing appended: `seq`.
   */
  append(id: string, seq: number, events: readonly JobEventBody[]): Promise<number>;
}
