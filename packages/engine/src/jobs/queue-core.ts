/**
 * What every job queue adapter shares (the JobQueue port's behaviour): the input contract, the approvals signed at
 * enqueue, the derived states, the markers, the exclusive claim, lanes and holds, and the events — written once, over a
 * job's named entries (JobEntries: job.json, claim, cancel, pause, stop, yield.json, events.jsonl and a submit's files).
 * The file queue (queue.ts) keeps them as files of the job's folder; the in-memory queue (memory-queue.ts) in a map.
 *
 * One writer per entry: job.json is written once by the submitter (`queued`), then only by the worker that claimed the
 * job; claim is created once by the worker that takes the job; cancel / pause / stop by a client (pause is removed by a
 * resume); yield.json and events.jsonl by the claiming worker; a submit's files once, by the submit, read back through
 * jobFile. Readers never write: what a dead worker cannot write is derived when reading (queue.ts says how the next
 * worker persists it).
 */
import { JobInputSchema, isFilming, jobClass, parseJobId } from '@retake/core';
import type { JobId, JobInput } from '@retake/core';
import { EngineError } from '../errors.js';
import { newJobId } from './ids.js';
import { isAlive } from './proc.js';
import type { ProcessIdentity } from './proc.js';
import { signApprovals } from './signing.js';
import { FINISHED_JOB_STATES, JOB_RECORD_VERSION } from './types.js';
import type { JobEvent, JobEventBody, JobRecord, JobYield } from './types.js';
import { interrupted } from './interrupted.js';
import type { CancelMark, ClaimRecord, DeriveOptions, JobFileRead, JobFilter, JobMark, JobPosition, JobQueue, TakeHold, YieldMark } from './job-queue.js';

/** A job's id, checked (never a path): the id itself, else `invalid`. */
export function checkJobId(id: string): JobId {
  const job = parseJobId(id);
  if (job === null) throw new EngineError('invalid', `invalid job id "${id}": j_ followed by 26 characters (job_list names them)`);
  return job;
}

/**
 * A job's named entries, as an adapter keeps them. Every operation on an existing job checks its id first (checkJobId:
 * an id that is not one is refused before anything is read); `make` and `add` take a new id.
 */
export interface JobEntries {
  /** Job ids (only names that are ones), oldest first. */
  ids(): Promise<string[]>;
  /** A new job's place (its entries come next). */
  make(id: string): Promise<void>;
  /** A submit's file of a new job: created once, readable by this user only (exists: throws). */
  add(id: string, name: string, text: string): Promise<void>;
  /** An entry's text; undefined when it is missing or cannot be read. */
  read(id: string, name: string): Promise<string | undefined>;
  /** A submit's file, read as stored: a plain file of at most `max` bytes (never a link followed), else why not. */
  readPlain(id: string, name: string, max: number): Promise<JobFileRead>;
  /** When an entry was last written (ISO), or undefined. */
  mtime(id: string, name: string): Promise<string | undefined>;
  /** Create an entry only if it does not exist: false when it does; a job that is gone throws ENOENT. */
  create(id: string, name: string, text: string): Promise<boolean>;
  /** Replace an entry atomically (a reader sees the old text or the new one). */
  replace(id: string, name: string, text: string): Promise<void>;
  /** Write an entry (plain). */
  put(id: string, name: string, text: string): Promise<void>;
  append(id: string, name: string, text: string): Promise<void>;
  /** Remove an entry (missing: nothing to do). */
  remove(id: string, name: string): Promise<void>;
}

/** Names of the files a submit may add to a job (no path, no hidden file). */
const JOB_FILE_RE = /^[a-z][a-z0-9-]{0,30}\.(?:yaml|json|txt)$/;
/** The job's own entries: never written by a submit. */
const JOB_RESERVED_FILES = new Set(['job.json', 'claim', 'cancel', 'pause', 'stop', 'browser.json', 'live.json', 'events.jsonl', 'yield.json']);

/** The name of a submit's file, checked (a plain name, none of the job's own): the name itself, else `invalid`. */
function checkJobFile(name: string): string {
  if (!JOB_FILE_RE.test(name) || JOB_RESERVED_FILES.has(name)) throw new EngineError('invalid', `invalid job file name "${name.slice(0, 40)}"`);
  return name;
}

/** The queue's behaviour over an adapter's entries; `filming()`: what a filming marker of this user holds (takeHold). */
export abstract class StoredJobQueue implements JobQueue {
  /** Ids whose record was read finished (final: never read again by takeHold). */
  private readonly finished = new Set<string>();

  protected constructor(
    readonly root: string,
    readonly cli: string,
    protected readonly entries: JobEntries,
  ) {}

  /** A filming marker of this user that holds heavy work (`here`: its workspace is this one), else undefined. */
  protected abstract filming(): Promise<TakeHold>;

  abstract withOwnMemory(cli?: string): JobQueue;

  private async json<T>(id: string, name: string): Promise<T | undefined> {
    const text = await this.entries.read(id, name);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  async enqueue(input: JobInput, opts: { files?: Record<string, string> } = {}): Promise<JobRecord> {
    const parsed = JobInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new EngineError('invalid', `invalid job input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`);
    }
    const id = newJobId();
    // Its approvals are signed for this job (signing.ts): the worker honours no approval a submit did not write for it.
    const signed = await signApprovals(parsed.data, { jobId: id, root: this.root });
    await this.entries.make(id);
    for (const [name, text] of Object.entries(opts.files ?? {})) await this.entries.add(id, checkJobFile(name), text);
    const rec: JobRecord = { version: JOB_RECORD_VERSION, id, kind: signed.kind, input: signed, state: 'queued', created_at: new Date().toISOString() };
    await this.entries.replace(id, 'job.json', JSON.stringify(rec, null, 2) + '\n');
    return rec;
  }

  async stored(id: string): Promise<JobRecord | undefined> {
    const rec = await this.json<JobRecord>(checkJobId(id), 'job.json');
    if (!(rec && typeof rec === 'object' && rec.id === id)) return undefined;
    if (FINISHED_JOB_STATES.has(rec.state)) this.finished.add(id);
    return rec;
  }

  async claimOf(id: string): Promise<ClaimRecord | undefined> {
    return this.json<ClaimRecord>(checkJobId(id), 'claim');
  }

  async cancelOf(id: string): Promise<CancelMark | undefined> {
    const marker = await this.json<{ at?: string; reason?: unknown }>(checkJobId(id), 'cancel');
    const at = marker?.at ? marker.at : await this.entries.mtime(id, 'cancel');
    if (at === undefined) return undefined;
    return { at, ...(marker?.reason === 'discard' ? { reason: 'discard' as const } : {}) };
  }

  async jobFile(id: string, name: string, maxBytes: number): Promise<JobFileRead> {
    return this.entries.readPlain(checkJobId(id), checkJobFile(name), maxBytes);
  }

  async get(id: string, opts: DeriveOptions = {}): Promise<JobRecord | undefined> {
    const rec = await this.stored(id);
    return rec ? this.derive(rec, opts) : undefined;
  }

  async derive(stored: JobRecord, opts: DeriveOptions = {}): Promise<JobRecord> {
    const rec: JobRecord = { ...stored };
    const cancelAt = FINISHED_JOB_STATES.has(rec.state) ? undefined : (await this.cancelOf(rec.id))?.at;
    if (cancelAt) rec.cancel_requested_at = cancelAt;
    if (rec.state === 'running' && rec.kind === 'run') {
      const pauseAt = (await this.pauseOf(rec.id))?.at;
      if (pauseAt) rec.pause_requested_at = pauseAt;
    }
    const heavy = jobClass(rec.kind) === 'heavy';
    if (rec.state === 'queued') {
      const claim = await this.claimOf(rec.id);
      if (claim) {
        if (!(await isAlive(claim))) return interrupted(rec, this.cli, `the worker (pid ${claim.pid}) stopped right after taking the job, before it started`);
      } else if (cancelAt) {
        return { ...rec, state: 'cancelled', finished_at: cancelAt, error: { code: 'cancelled', message: 'cancelled before it started' }, derived: true };
      } else if (heavy) {
        const cause = await (opts.hold ?? (() => this.takeHold()))();
        if (cause) rec.yield = { state: 'waiting', cause };
      }
    } else if (rec.state === 'running') {
      if (!rec.worker || !(await isAlive(rec.worker))) {
        // L5.14: a heavy job's `worker` is its job process (its claiming worker is `supervisor`).
        const who = rec.supervisor ? 'its job process' : 'the worker';
        return interrupted(rec, this.cli, `${who}${rec.worker ? ` (pid ${rec.worker.pid})` : ''} stopped while the job ran (killed, crashed or the machine slept through a restart)`);
      }
      if (heavy) {
        const y = await this.yieldOf(rec.id);
        if (y) rec.yield = y;
      }
    }
    return rec;
  }

  async yieldOf(id: string): Promise<JobYield | undefined> {
    const y = await this.json<{ state?: unknown; cause?: unknown; since?: unknown; cap_min?: unknown }>(checkJobId(id), 'yield.json');
    if (!y || typeof y !== 'object' || (y.state !== 'background' && y.state !== 'past_cap')) return undefined;
    const since = typeof y.since === 'string' && Number.isFinite(Date.parse(y.since)) ? new Date(Date.parse(y.since)).toISOString() : undefined;
    const cap = y.state === 'past_cap' && typeof y.cap_min === 'number' && Number.isInteger(y.cap_min) && y.cap_min > 0 && y.cap_min <= 1440 ? y.cap_min : undefined;
    return { state: y.state, cause: y.cause === 'here' ? 'here' : 'elsewhere', ...(since ? { since } : {}), ...(cap ? { cap_min: cap } : {}) };
  }

  async setYield(id: string, mark: YieldMark | null): Promise<void> {
    if (mark) await this.entries.put(checkJobId(id), 'yield.json', `${JSON.stringify({ v: 1, ...mark })}\n`);
    else await this.entries.remove(checkJobId(id), 'yield.json');
  }

  /**
   * What holds this workspace's heavy work now (L5.14, review B M4): a filming take of this workspace waiting in the
   * queue (`here`), else a filming marker of this user (`here` when its workspace is this one); undefined when nothing
   * does. Reads only the jobs this queue has not seen finished (review A M1: a finished job's record is read once, not
   * at every call); callers read it once per list or poll.
   */
  async takeHold(): Promise<TakeHold> {
    for (const id of await this.ids()) {
      if (this.finished.has(id)) continue;
      const s = await this.stored(id).catch(() => undefined);
      if (s?.state === 'queued' && isFilming(s.input) && (await this.cancelOf(id)) === undefined && (await this.claimOf(id)) === undefined) return 'here';
    }
    return this.filming();
  }

  ids(): Promise<string[]> {
    return this.entries.ids();
  }

  async list(f: JobFilter = {}): Promise<JobRecord[]> {
    const out: JobRecord[] = [];
    const limit = f.limit ?? 50;
    let hold: Promise<TakeHold> | undefined;
    const once = () => (hold ??= this.takeHold());
    for (const id of (await this.ids()).reverse()) {
      if (out.length >= limit) break;
      const stored = await this.stored(id);
      if (!stored) continue;
      if (f.project !== undefined && jobProject(stored.input) !== f.project) continue;
      if (f.kinds && !f.kinds.includes(stored.kind)) continue;
      if (f.runId !== undefined && !(stored.input.kind === 'run' && stored.input.run_id === f.runId)) continue;
      if (f.renderId !== undefined && !('render_id' in stored.input && stored.input.render_id === f.renderId)) continue;
      const rec = await this.derive(stored, { hold: once });
      if (f.states && !f.states.includes(rec.state)) continue;
      out.push(rec);
    }
    return out;
  }

  async ofRun(project: string, runId: string): Promise<JobRecord | undefined> {
    return (await this.list({ project, runId, limit: 1 }))[0];
  }

  async ofRender(project: string, renderId: string): Promise<JobRecord | undefined> {
    return (await this.list({ project, renderId, kinds: ['render'], limit: 1 }))[0];
  }

  /**
   * Ask for a cancel: the marker is created once (asking again keeps the first time). A queued job is then cancelled
   * (derived at once, closed by the next worker); a running one is stopped by its worker (teardown and rollbacks still
   * run). A finished job is returned as it is. `reason` 'discard' (L4.8): the Studio's Discard of an open recording
   * window — its view says "discarded", not "cancelled".
   */
  async cancel(id: string, by: string, reason?: 'discard'): Promise<JobRecord> {
    const rec = await this.get(id);
    if (!rec) throw new EngineError('not_found', `job ${id} not found (job_list names the jobs)`);
    if (FINISHED_JOB_STATES.has(rec.state)) return rec;
    await this.entries.create(id, 'cancel', JSON.stringify({ at: new Date().toISOString(), by, ...(reason ? { reason } : {}) }) + '\n');
    return (await this.get(id)) ?? rec;
  }

  /**
   * Ask a running job to pause (`on`) or to resume (L4.4): the `pause` marker is created once (asking again keeps the
   * first time) or removed. The caller checks the job may pause (engine runs.pause); the worker only reads the marker.
   */
  async requestPause(id: string, on: boolean, by: string): Promise<void> {
    checkJobId(id);
    if (on) await this.entries.create(id, 'pause', JSON.stringify({ at: new Date().toISOString(), by }) + '\n');
    else await this.entries.remove(id, 'pause');
  }

  async pauseOf(id: string): Promise<JobMark | undefined> {
    return this.markOf(id, 'pause');
  }

  /** A pause or stop marker: the time it says, else its file's time; undefined when there is none. */
  private async markOf(id: string, name: 'pause' | 'stop'): Promise<JobMark | undefined> {
    const marker = await this.json<{ at?: unknown }>(checkJobId(id), name);
    const at = typeof marker?.at === 'string' ? marker.at : await this.entries.mtime(id, name);
    return at === undefined ? undefined : { at };
  }

  /**
   * Ask a running `record` job to stop and keep (L4.8): the `stop` marker is created once (asking again keeps the first
   * time). The caller checks the job may stop (engine record.stop); the worker only reads the marker, and a marker left
   * by a finished job is inert.
   */
  async requestStop(id: string, by: string): Promise<void> {
    await this.entries.create(checkJobId(id), 'stop', JSON.stringify({ at: new Date().toISOString(), by }) + '\n');
  }

  async stopOf(id: string): Promise<JobMark | undefined> {
    return this.markOf(id, 'stop');
  }

  async claim(id: string, who: ProcessIdentity): Promise<boolean> {
    const claim: ClaimRecord = { ...who, at: new Date().toISOString() };
    try {
      return await this.entries.create(checkJobId(id), 'claim', JSON.stringify(claim) + '\n');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; // the job is gone
      throw e;
    }
  }

  /**
   * Give a claimed job back to the queue (L5.14: its job process refused to start on another build) — only the worker
   * that claimed it, before anything ran.
   */
  async unclaim(id: string): Promise<void> {
    await this.entries.remove(checkJobId(id), 'claim');
  }

  async lastSeq(id: string): Promise<number> {
    const events = await this.events(id);
    return events.length ? events[events.length - 1]!.seq : 0;
  }

  async write(rec: JobRecord): Promise<void> {
    const { cancel_requested_at: _c, pause_requested_at: _p, derived: _d, yield: _y, ...stored } = rec;
    await this.entries.replace(checkJobId(rec.id), 'job.json', JSON.stringify(stored, null, 2) + '\n');
  }

  async append(id: string, seq: number, events: readonly JobEventBody[]): Promise<number> {
    if (!events.length) return seq;
    checkJobId(id);
    const t = new Date().toISOString();
    const lines = events.map((e) => JSON.stringify({ seq: ++seq, t, ...e })).join('\n') + '\n';
    await this.entries.append(id, 'events.jsonl', lines);
    return seq;
  }

  async events(id: string, opts: { after?: number; limit?: number } = {}): Promise<JobEvent[]> {
    let text: string | undefined;
    try {
      text = await this.entries.read(checkJobId(id), 'events.jsonl');
    } catch {
      return [];
    }
    if (text === undefined) return [];
    const out: JobEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as JobEvent;
        if (e.seq > (opts.after ?? 0)) out.push(e);
      } catch {
        /* a torn last line while it is written */
      }
    }
    return opts.limit !== undefined ? out.slice(-opts.limit) : out;
  }

  /**
   * Where a queued job stands in its lane (L5.14: the worker runs one capture and one heavy job at a time, captures
   * first): how many jobs of the same class run or wait before it (0: it is next). Undefined when it is not queued.
   * `held_by: 'take'` (review B M4): a heavy job that cannot start now — a filming take of this workspace waits in the
   * queue, or a take films on this Mac (a filming marker holds) — whatever its place in its lane.
   */
  async position(id: string): Promise<JobPosition | undefined> {
    let ahead = 0;
    let running: string | undefined;
    let mine: JobRecord | undefined;
    const recs: JobRecord[] = [];
    let hold: Promise<TakeHold> | undefined;
    const once = () => (hold ??= this.takeHold());
    for (const other of await this.ids()) {
      const stored = await this.stored(other);
      if (!stored || FINISHED_JOB_STATES.has(stored.state)) continue;
      const rec = await this.derive(stored, { hold: once });
      if (other === id) mine = rec;
      else recs.push(rec);
    }
    if (mine?.state !== 'queued') return undefined;
    const lane = jobClass(mine.kind);
    for (const rec of recs) {
      if (jobClass(rec.kind) !== lane) continue;
      if (rec.state === 'running') running = rec.id;
      // Captures go before every heavy job whatever their age; within a lane, the oldest first.
      else if (rec.state === 'queued' && rec.id < id) ahead++;
    }
    const held = lane === 'heavy' && (await once()) !== undefined;
    return { ahead: ahead + (running ? 1 : 0), ...(running ? { running } : {}), ...(held ? { held_by: 'take' as const } : {}) };
  }
}

/** The project of a job's input (a site extraction is workspace-level: none). */
export function jobProject(input: JobInput): string | undefined {
  return 'project' in input ? input.project : undefined;
}
