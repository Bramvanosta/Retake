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
import type { EngineEnv } from '../env.js';
import { parseJobId } from '@retake/core/ids';
import { JOB_STATES, JobInputSchema, isFilming, jobClass } from './job-input.js';
import { NO_PROJECT_BROWSER, jobToolNeed } from '../tools/tool-need.js';
import type { ProjectBrowser } from '../tools/tool-need.js';
import type { BundleInfo, ToolNeed } from '@retake/core/io';
import { toolsGate } from '../tools/gate.js';
import type { JobId } from '@retake/core/ids';
import type { JobInput } from './job-input.js';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import { EngineError } from '../errors.js';
import { newJobId } from './ids.js';
import { isAlive } from './proc.js';
import type { ProcessIdentity } from './proc.js';
import { signApprovals } from './signing.js';
import { FINISHED_JOB_STATES, JOB_RECORD_VERSION } from './types.js';
import type { JobEvent, JobEventBody, JobRecord, JobYield } from './types.js';
import { interrupted } from './interrupted.js';
import type { ToolsGate } from './job-queue.js';
import type { CancelMark, ClaimRecord, DeriveOptions, JobFileRead, JobFilter, JobRangeRead, JobMark, JobPosition, JobQueue, RecordedBrowser, TakeHold, YieldMark } from './job-queue.js';
import { bestEffort } from '@retake/core/base';
import { storedJson } from '../stored-json.js';
import { z } from 'zod';

/**
 * What a job.json must be for the queue to hold it: a job of a known kind and state, with its input. The rest (progress,
 * result, error) is the worker's own writing, read as written.
 */
const JobRecordSchema = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.enum(JOB_STATES),
  created_at: z.string(),
  input: z.object({ kind: z.string() }),
});
/** A claim: the claiming worker (pid, start time) and when. */
const ClaimSchema = z.object({ pid: z.number().int(), started_at: z.string().optional(), at: z.string() });
/** A marker file (cancel, pause, stop, yield.json): a JSON object; each reader takes the members it knows. */
const MarkerSchema = z.record(z.string(), z.unknown());
/** A browser.json: the browser's pid and start time (both needed to kill it), and its profile when it has one. */
const RecordedBrowserSchema = z.object({ pid: z.number().int(), started_at: z.string().optional(), user_data_dir: z.string().optional() });
/** A line of events.jsonl: its sequence number, time and type. */
const JobEventSchema = z.object({ seq: z.number().int(), t: z.string(), type: z.string() });

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
  /**
   * At most `max` bytes of an entry from `offset`, and its size (a growing entry: events.jsonl); never a link followed.
   */
  readRange(id: string, name: string, offset: number, max: number): Promise<JobRangeRead>;
  /**
   * An entry only this user may have written and only they may read (live.json), of at most `max` bytes; else
   * undefined.
   */
  readPrivate(id: string, name: string, max: number): Promise<string | undefined>;
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
  /** The app's Tools missing now (tools/gate.ts, read at most once a second): a queued job that needs one waits. A test's memory queue hands its own. */
  protected tools: ToolsGate;
  /** The `browser:` of this workspace's projects (tools/tool-need.ts; its engine hands the reader): a job whose project launches its own browser needs no Tool. */
  protected browsers: ProjectBrowser = NO_PROJECT_BROWSER;

  protected constructor(
    readonly root: string,
    readonly cli: string,
    protected readonly entries: JobEntries,
    /** What the queue stamps its records and markers with (the composition root's clock). */
    protected readonly clock: Clock,
    /** The environment its composition root read (env.ts): the Retake home whose key signs the approvals, the captures folder. */
    protected readonly env: EngineEnv,
  ) {
    this.tools = toolsGate(env);
  }

  useTools(o: { app?: BundleInfo | null; browsers?: ProjectBrowser }): void {
    if (o.app !== undefined) {
      const app = o.app;
      this.tools = toolsGate(this.env, () => app);
    }
    if (o.browsers) this.browsers = o.browsers;
  }

  /** What a job needs of the Tools while `missing` are missing (tool-need.ts: its kind's, or none for a project's own browser). */
  toolNeed(rec: { kind: string; input: unknown }, missing: ReadonlySet<ToolNeed>): Promise<ToolNeed | null> {
    return jobToolNeed(rec, missing, this.browsers);
  }

  /** A filming marker of this user that holds heavy work (`here`: its workspace is this one), else undefined. */
  protected abstract filming(): Promise<TakeHold>;

  abstract withOwnMemory(cli?: string): JobQueue;

  /** `fn` under the queue's lock of `key` (JobQueue.exclusive): the adapter's lock. */
  abstract exclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;

  /** A job file's text as JSON its schema accepts; undefined when it is missing, torn or not one */
  private async json(id: string, name: string, schema: z.ZodType): Promise<unknown> {
    const text = await this.entries.read(id, name);
    return text === undefined ? undefined : storedJson(schema, text);
  }

  async enqueue(input: JobInput, opts: { files?: Record<string, string> } = {}): Promise<JobRecord> {
    const parsed = JobInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new EngineError('invalid', `invalid job input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`);
    }
    const id = newJobId(this.clock.now());
    // Its approvals are signed for this job (signing.ts): the worker honours no approval a submit did not write for it.
    const signed = await signApprovals(parsed.data, { jobId: id, root: this.root, env: this.env });
    await this.entries.make(id);
    for (const [name, text] of Object.entries(opts.files ?? {})) await this.entries.add(id, checkJobFile(name), text);
    const rec: JobRecord = { version: JOB_RECORD_VERSION, id, kind: signed.kind, input: signed, state: 'queued', created_at: stampOf(this.clock) };
    await this.entries.replace(id, 'job.json', JSON.stringify(rec, null, 2) + '\n');
    return rec;
  }

  async stored(id: string): Promise<JobRecord | undefined> {
    const rec = (await this.json(checkJobId(id), 'job.json', JobRecordSchema)) as JobRecord | undefined;
    if (rec?.id !== id) return undefined;
    if (FINISHED_JOB_STATES.has(rec.state)) this.finished.add(id);
    return rec;
  }

  async claimOf(id: string): Promise<ClaimRecord | undefined> {
    const text = await this.entries.read(checkJobId(id), 'claim');
    if (text === undefined) return undefined;
    // A claim file that is not a claim is held by no live process (pid 0: isAlive says no) — its job reads as interrupted.
    return (storedJson(ClaimSchema, text) as ClaimRecord | undefined) ?? { pid: 0, at: '' };
  }

  async cancelOf(id: string): Promise<CancelMark | undefined> {
    const marker = (await this.json(checkJobId(id), 'cancel', MarkerSchema)) as { at?: unknown; reason?: unknown } | undefined;
    const at = typeof marker?.at === 'string' && marker.at ? marker.at : await this.entries.mtime(id, 'cancel');
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
      } else {
        // a job whose Tool is not downloaded yet waits for it, whatever its class (it is not picked: pick.ts).
        const missing = (opts.tools ?? this.tools)();
        const needs = missing.size ? await this.toolNeed(rec, missing) : null;
        if (needs && missing.has(needs)) rec.yield = { state: 'waiting', cause: 'tools', needs };
        else if (heavy) {
          const cause = await (opts.hold ?? (() => this.takeHold()))();
          if (cause) rec.yield = { state: 'waiting', cause };
        }
      }
    } else if (rec.state === 'running') {
      if (!rec.worker || !(await isAlive(rec.worker))) {
        // A heavy job's `worker` is its job process (its claiming worker is `supervisor`).
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
    const y = (await this.json(checkJobId(id), 'yield.json', MarkerSchema)) as { state?: unknown; cause?: unknown; since?: unknown; cap_min?: unknown } | undefined;
    if (!y || (y.state !== 'background' && y.state !== 'past_cap')) return undefined;
    const since = typeof y.since === 'string' && Number.isFinite(Date.parse(y.since)) ? new Date(Date.parse(y.since)).toISOString() : undefined;
    const cap = y.state === 'past_cap' && typeof y.cap_min === 'number' && Number.isInteger(y.cap_min) && y.cap_min > 0 && y.cap_min <= 1440 ? y.cap_min : undefined;
    return { state: y.state, cause: y.cause === 'here' ? 'here' : 'elsewhere', ...(since ? { since } : {}), ...(cap ? { cap_min: cap } : {}) };
  }

  async setYield(id: string, mark: YieldMark | null): Promise<void> {
    if (mark) await this.entries.put(checkJobId(id), 'yield.json', `${JSON.stringify({ v: 1, ...mark })}\n`);
    else await this.entries.remove(checkJobId(id), 'yield.json');
  }

  async recordBrowser(id: string, browser: RecordedBrowser | null): Promise<void> {
    const job = checkJobId(id);
    if (!browser) return this.entries.remove(job, 'browser.json');
    const { pid, started_at, user_data_dir } = browser;
    await this.entries.put(job, 'browser.json', `${JSON.stringify({ pid, ...(started_at !== undefined ? { started_at } : {}), ...(user_data_dir ? { user_data_dir } : {}) })}\n`);
  }

  async recordedBrowser(id: string): Promise<RecordedBrowser | undefined> {
    const job = parseJobId(id);
    // Not a job's id: no file of it to read (nothing to kill).
    return job === null ? undefined : ((await this.json(job, 'browser.json', RecordedBrowserSchema)) as RecordedBrowser | undefined);
  }

  /**
   * What holds this workspace's heavy work now: a filming take of this workspace waiting in the
   * queue (`here`), else a filming marker of this user (`here` when its workspace is this one); undefined when nothing
   * does. Reads only the jobs this queue has not seen finished (a finished job's record is read once, not at every
   * call); callers read it once per list or poll.
   */
  async takeHold(): Promise<TakeHold> {
    for (const id of await this.ids()) {
      if (this.finished.has(id)) continue;
      const s = await bestEffort(this.stored(id), 'a job removed meanwhile reads as gone');
      // A take that waits for the browser films nothing yet: it holds no heavy work (pick.ts skips it too).
      if (s?.state === 'queued' && isFilming(s.input) && !(await this.heldByTools(s)) && (await this.cancelOf(id)) === undefined && (await this.claimOf(id)) === undefined) return 'here';
    }
    return this.filming();
  }

  ids(): Promise<string[]> {
    return this.entries.ids();
  }

  /** Does a queued job wait for the Tools now (its need missing)? */
  private async heldByTools(rec: JobRecord): Promise<boolean> {
    const missing = this.tools();
    if (!missing.size) return false;
    const need = await this.toolNeed(rec, missing);
    return need !== null && missing.has(need);
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
      const rec = await this.derive(stored, { hold: once, ...(f.tools ? { tools: f.tools } : {}) });
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
   * run). A finished job is returned as it is. `reason` 'discard': the Studio's Discard of an open recording
   * window — its view says "discarded", not "cancelled".
   */
  async cancel(id: string, by: string, reason?: 'discard'): Promise<JobRecord> {
    const rec = await this.get(id);
    if (!rec) throw new EngineError('not_found', `job ${id} not found (job_list names the jobs)`);
    if (FINISHED_JOB_STATES.has(rec.state)) return rec;
    await this.entries.create(id, 'cancel', JSON.stringify({ at: stampOf(this.clock), by, ...(reason ? { reason } : {}) }) + '\n');
    return (await this.get(id)) ?? rec;
  }

  /**
   * Ask a running job to pause (`on`) or to resume: the `pause` marker is created once (asking again keeps the
   * first time) or removed. The caller checks the job may pause (engine runs.pause); the worker only reads the marker.
   */
  async requestPause(id: string, on: boolean, by: string): Promise<void> {
    checkJobId(id);
    if (on) await this.entries.create(id, 'pause', JSON.stringify({ at: stampOf(this.clock), by }) + '\n');
    else await this.entries.remove(id, 'pause');
  }

  async pauseOf(id: string): Promise<JobMark | undefined> {
    return this.markOf(id, 'pause');
  }

  /** A pause or stop marker: the time it says, else its file's time; undefined when there is none. */
  private async markOf(id: string, name: 'pause' | 'stop'): Promise<JobMark | undefined> {
    const marker = (await this.json(checkJobId(id), name, MarkerSchema)) as { at?: unknown } | undefined;
    const at = typeof marker?.at === 'string' ? marker.at : await this.entries.mtime(id, name);
    return at === undefined ? undefined : { at };
  }

  /**
   * Ask a running `record` job to stop and keep: the `stop` marker is created once (asking again keeps the first
   * time). The caller checks the job may stop (engine record.stop); the worker only reads the marker, and a marker left
   * by a finished job is inert.
   */
  async requestStop(id: string, by: string): Promise<void> {
    await this.entries.create(checkJobId(id), 'stop', JSON.stringify({ at: stampOf(this.clock), by }) + '\n');
  }

  async stopOf(id: string): Promise<JobMark | undefined> {
    return this.markOf(id, 'stop');
  }

  async claim(id: string, who: ProcessIdentity): Promise<boolean> {
    const claim: ClaimRecord = { ...who, at: stampOf(this.clock) };
    try {
      return await this.entries.create(checkJobId(id), 'claim', JSON.stringify(claim) + '\n');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; // the job is gone
      throw e;
    }
  }

  /**
   * Give a claimed job back to the queue (its job process refused to start on another build) — only the worker
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
    const t = stampOf(this.clock);
    const lines = events.map((e) => JSON.stringify({ seq: ++seq, t, ...e })).join('\n') + '\n';
    await this.entries.append(id, 'events.jsonl', lines);
    return seq;
  }

  async eventsRange(id: string, offset: number, max: number): Promise<JobRangeRead> {
    return this.entries.readRange(checkJobId(id), 'events.jsonl', offset, max);
  }

  async liveRecord(id: string, max: number): Promise<string | undefined> {
    return this.entries.readPrivate(checkJobId(id), 'live.json', max);
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
      // A torn last line while it is written, or a line that is no event: skipped.
      const e = storedJson(JobEventSchema, line) as JobEvent | undefined;
      if (e && e.seq > (opts.after ?? 0)) out.push(e);
    }
    return opts.limit !== undefined ? out.slice(-opts.limit) : out;
  }

  /**
   * Where a queued job stands in its lane (the worker runs one capture and one heavy job at a time, captures
   * first): how many jobs of the same class run or wait before it (0: it is next). Undefined when it is not queued.
   * `held_by: 'take'`: a heavy job that cannot start now — a filming take of this workspace waits in the
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
    if (mine.yield?.cause === 'tools') return { ahead: 0, held_by: 'tools', ...(mine.yield.needs ? { needs: mine.yield.needs } : {}) };
    const lane = jobClass(mine.kind);
    for (const rec of recs) {
      if (jobClass(rec.kind) !== lane) continue;
      if (rec.state === 'running') running = rec.id;
      // Captures go before every heavy job whatever their age; within a lane, the oldest first — not one that waits
      // for the Tools (it is skipped: pick.ts).
      else if (rec.state === 'queued' && rec.id < id && rec.yield?.cause !== 'tools') ahead++;
    }
    const held = lane === 'heavy' && (await once()) !== undefined;
    return { ahead: ahead + (running ? 1 : 0), ...(running ? { running } : {}), ...(held ? { held_by: 'take' as const } : {}) };
  }
}

/** The project of a job's input (a site extraction is workspace-level: none). */
export function jobProject(input: JobInput): string | undefined {
  return 'project' in input ? input.project : undefined;
}
