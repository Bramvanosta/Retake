/**
 * The job queue (L3.1, R-ARC-02): files under <workspace>/.demo-studio/jobs/<id>/, one writer per file.
 *
 * - job.json: written once by the submitter (`queued`, atomically), then only by the worker that claimed the job;
 * - claim: created exclusively (O_EXCL) by the worker that takes the job — the atomic claim;
 * - cancel: created exclusively by whoever asks for a cancel (a client); the worker polls it;
 * - pause (L4.4, a running `run` job): created by whoever asks for a pause and removed by whoever asks to resume (a
 *   client); the worker polls it with the cancel marker and never writes it (a marker left by a finished job is inert);
 * - live.json (L4.4, a running `run` job): the live channel's port and token, 0600, written and removed by the claiming
 *   worker (jobs/live-channel.ts);
 * - events.jsonl: appended by the claiming worker only.
 *
 * Readers never write. What a dead worker cannot write is derived when reading: a `running` job whose worker is gone
 * (pid + start time) is `interrupted`; a `queued` job with a cancel marker and no claim is `cancelled`. The next worker
 * persists those states (it claims a cancelled job to close it; it holds the worker lock when it marks interrupted
 * jobs).
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOB_ID_RE, JobInputSchema } from '@demo-studio/core';
import type { JobInput, JobKind, JobState } from '@demo-studio/core';
import { EngineError } from '../errors.js';
import { newJobId } from './ids.js';
import { isAlive } from './proc.js';
import { signApprovals } from './signing.js';
import type { ProcessIdentity } from './proc.js';
import { FINISHED_JOB_STATES, JOB_RECORD_VERSION } from './types.js';
import type { JobEvent, JobEventBody, JobRecord } from './types.js';

/** <workspace>/.demo-studio: machine-local state of a workspace (git-ignored). */
export function stateDir(root: string): string {
  return join(root, '.demo-studio');
}

export function jobsDir(root: string): string {
  return join(stateDir(root), 'jobs');
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Create `file` only if it does not exist; false when it does. */
async function createExclusive(file: string, text: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
  return true;
}

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

/** Names of the files a submit may add to a job folder (no path, no hidden file). */
const JOB_FILE_RE = /^[a-z][a-z0-9-]{0,30}\.(?:yaml|json|txt)$/;
/** The job folder's own files: never written by a submit. */
const JOB_RESERVED_FILES = new Set(['job.json', 'claim', 'cancel', 'pause', 'browser.json', 'live.json', 'events.jsonl']);

export class FileJobQueue {
  readonly dir: string;

  /** `cli`: how the commands a human is asked to run start ("studio -C <root>"). */
  constructor(
    readonly root: string,
    readonly cli = 'studio',
  ) {
    this.dir = jobsDir(root);
  }

  jobDir(id: string): string {
    if (!JOB_ID_RE.test(id)) throw new EngineError('invalid', `invalid job id "${id}": j_ followed by 26 characters (job_list names them)`);
    return join(this.dir, id);
  }

  /**
   * Validate an input and queue it: job.json written once, atomically (`queued`). `files`: files of the job folder
   * written first (mode 0600, by name: a render's edit.yaml snapshot, L4.5), so a worker that sees the job sees them.
   */
  async enqueue(input: JobInput, opts: { files?: Record<string, string> } = {}): Promise<JobRecord> {
    const parsed = JobInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new EngineError('invalid', `invalid job input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`);
    }
    const id = newJobId();
    const dir = join(this.dir, id);
    // Its approvals are signed (signing.ts): the worker honours no approval a submit did not write.
    const signed = await signApprovals(parsed.data);
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(opts.files ?? {})) {
      if (!JOB_FILE_RE.test(name) || JOB_RESERVED_FILES.has(name)) throw new EngineError('invalid', `invalid job file name "${name.slice(0, 40)}"`);
      await writeFile(join(dir, name), text, { mode: 0o600, flag: 'wx' });
    }
    const rec: JobRecord = { version: JOB_RECORD_VERSION, id, kind: signed.kind, input: signed, state: 'queued', created_at: new Date().toISOString() };
    await writeAtomic(join(dir, 'job.json'), JSON.stringify(rec, null, 2) + '\n');
    return rec;
  }

  /** job.json as stored (no derivation); undefined when there is none (yet). */
  async stored(id: string): Promise<JobRecord | undefined> {
    const rec = await readJsonFile<JobRecord>(join(this.jobDir(id), 'job.json'));
    return rec && typeof rec === 'object' && rec.id === id ? rec : undefined;
  }

  async claimOf(id: string): Promise<ClaimRecord | undefined> {
    return readJsonFile<ClaimRecord>(join(this.jobDir(id), 'claim'));
  }

  /** When a cancel was asked (the marker's time), or undefined. */
  async cancelOf(id: string): Promise<string | undefined> {
    const marker = await readJsonFile<{ at?: string }>(join(this.jobDir(id), 'cancel'));
    if (marker?.at) return marker.at;
    try {
      return (await stat(join(this.jobDir(id), 'cancel'))).mtime.toISOString();
    } catch {
      return undefined;
    }
  }

  /** A job as clients see it: its stored record with the cancel request and the derived states. */
  async get(id: string): Promise<JobRecord | undefined> {
    const rec = await this.stored(id);
    return rec ? this.derive(rec) : undefined;
  }

  /** Derive what a dead worker could not write, and the cancel request. Writes nothing. */
  async derive(stored: JobRecord): Promise<JobRecord> {
    const rec: JobRecord = { ...stored };
    const cancelAt = FINISHED_JOB_STATES.has(rec.state) ? undefined : await this.cancelOf(rec.id);
    if (cancelAt) rec.cancel_requested_at = cancelAt;
    if (rec.state === 'running' && rec.kind === 'run') {
      const pauseAt = await this.pauseOf(rec.id);
      if (pauseAt) rec.pause_requested_at = pauseAt;
    }
    if (rec.state === 'queued') {
      const claim = await this.claimOf(rec.id);
      if (claim) {
        if (!(await isAlive(claim))) return interrupted(rec, this.cli, `the worker (pid ${claim.pid}) stopped right after taking the job, before it started`);
      } else if (cancelAt) {
        return { ...rec, state: 'cancelled', finished_at: cancelAt, error: { code: 'cancelled', message: 'cancelled before it started' }, derived: true };
      }
    } else if (rec.state === 'running') {
      if (!rec.worker || !(await isAlive(rec.worker))) {
        return interrupted(rec, this.cli, `the worker${rec.worker ? ` (pid ${rec.worker.pid})` : ''} stopped while the job ran (killed, crashed or the machine slept through a restart)`);
      }
    }
    return rec;
  }

  /** Job ids, oldest first. */
  async ids(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((n) => JOB_ID_RE.test(n)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  /** Jobs, newest first (derived states). */
  async list(f: JobFilter = {}): Promise<JobRecord[]> {
    const out: JobRecord[] = [];
    const limit = f.limit ?? 50;
    for (const id of (await this.ids()).reverse()) {
      if (out.length >= limit) break;
      const stored = await this.stored(id);
      if (!stored) continue;
      if (f.project !== undefined && jobProject(stored.input) !== f.project) continue;
      if (f.kinds && !f.kinds.includes(stored.kind)) continue;
      if (f.runId !== undefined && !(stored.input.kind === 'run' && stored.input.run_id === f.runId)) continue;
      if (f.renderId !== undefined && !('render_id' in stored.input && stored.input.render_id === f.renderId)) continue;
      const rec = await this.derive(stored);
      if (f.states && !f.states.includes(rec.state)) continue;
      out.push(rec);
    }
    return out;
  }

  /** The job of a run (submitted through the engine), or undefined (a CLI run). */
  async ofRun(project: string, runId: string): Promise<JobRecord | undefined> {
    return (await this.list({ project, runId, limit: 1 }))[0];
  }

  /** The newest job of a render id (a render id is reused after a failed or cancelled render), or undefined. */
  async ofRender(project: string, renderId: string): Promise<JobRecord | undefined> {
    return (await this.list({ project, renderId, kinds: ['render'], limit: 1 }))[0];
  }

  /** <job>/browser.json: the render browser a job's worker started (pid + start time), to kill it after a crash. */
  browserFile(id: string): string {
    return join(this.jobDir(id), 'browser.json');
  }

  /**
   * Ask for a cancel: the marker is created once (asking again keeps the first time). A queued job is then cancelled
   * (derived at once, closed by the next worker); a running one is stopped by its worker (teardown and rollbacks still
   * run). A finished job is returned as it is.
   */
  async cancel(id: string, by: string): Promise<JobRecord> {
    const rec = await this.get(id);
    if (!rec) throw new EngineError('not_found', `job ${id} not found (job_list names the jobs)`);
    if (FINISHED_JOB_STATES.has(rec.state)) return rec;
    await createExclusive(join(this.jobDir(id), 'cancel'), JSON.stringify({ at: new Date().toISOString(), by }) + '\n');
    return (await this.get(id)) ?? rec;
  }

  async cancelRequested(id: string): Promise<boolean> {
    return exists(join(this.jobDir(id), 'cancel'));
  }

  /**
   * Ask a running job to pause (`on`) or to resume (L4.4): the `pause` marker is created once (asking again keeps the
   * first time) or removed. The caller checks the job may pause (engine runs.pause); the worker only reads the marker.
   */
  async requestPause(id: string, on: boolean, by: string): Promise<void> {
    const file = join(this.jobDir(id), 'pause');
    if (on) await createExclusive(file, JSON.stringify({ at: new Date().toISOString(), by }) + '\n');
    else await rm(file, { force: true });
  }

  async pauseRequested(id: string): Promise<boolean> {
    return exists(join(this.jobDir(id), 'pause'));
  }

  /** When a pause was asked (the marker's time), or undefined. */
  async pauseOf(id: string): Promise<string | undefined> {
    const marker = await readJsonFile<{ at?: string }>(join(this.jobDir(id), 'pause'));
    if (typeof marker?.at === 'string') return marker.at;
    try {
      return (await stat(join(this.jobDir(id), 'pause'))).mtime.toISOString();
    } catch {
      return undefined;
    }
  }

  /** <job>/live.json: the live channel of a running `run` job (jobs/live-channel.ts). */
  liveFile(id: string): string {
    return join(this.jobDir(id), 'live.json');
  }

  /** Take a job (O_EXCL claim file): true for exactly one caller. */
  async claim(id: string, who: ProcessIdentity): Promise<boolean> {
    const claim: ClaimRecord = { ...who, at: new Date().toISOString() };
    try {
      return await createExclusive(join(this.jobDir(id), 'claim'), JSON.stringify(claim) + '\n');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; // the job folder is gone
      throw e;
    }
  }

  /** Write job.json — only the worker holding the job's claim calls this. */
  async write(rec: JobRecord): Promise<void> {
    const { cancel_requested_at: _c, pause_requested_at: _p, derived: _d, ...stored } = rec;
    await writeAtomic(join(this.jobDir(rec.id), 'job.json'), JSON.stringify(stored, null, 2) + '\n');
  }

  /** Append events (the claiming worker only). */
  async append(id: string, seq: number, events: readonly JobEventBody[]): Promise<number> {
    if (!events.length) return seq;
    const t = new Date().toISOString();
    const lines = events.map((e) => JSON.stringify({ seq: ++seq, t, ...e })).join('\n') + '\n';
    await appendFile(join(this.jobDir(id), 'events.jsonl'), lines);
    return seq;
  }

  /** Events after `after` (seq), oldest first. */
  async events(id: string, opts: { after?: number; limit?: number } = {}): Promise<JobEvent[]> {
    let text: string;
    try {
      text = await readFile(join(this.jobDir(id), 'events.jsonl'), 'utf8');
    } catch {
      return [];
    }
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
   * Where a queued job stands: how many jobs run or wait before it (0: it is next). Undefined when it is not queued.
   */
  async position(id: string): Promise<{ ahead: number; running?: string } | undefined> {
    let ahead = 0;
    let running: string | undefined;
    let mine: JobRecord | undefined;
    for (const other of await this.ids()) {
      const stored = await this.stored(other);
      if (!stored || FINISHED_JOB_STATES.has(stored.state)) continue;
      const rec = await this.derive(stored);
      if (other === id) mine = rec;
      else if (rec.state === 'running') running = other;
      else if (rec.state === 'queued' && !mine) ahead++;
    }
    if (mine?.state !== 'queued') return undefined;
    return { ahead: ahead + (running ? 1 : 0), ...(running ? { running } : {}) };
  }
}

function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The project of a job's input (a site extraction is workspace-level: none). */
export function jobProject(input: JobInput): string | undefined {
  return 'project' in input ? input.project : undefined;
}

function interrupted(rec: JobRecord, cli: string, why: string): JobRecord {
  const i = rec.input;
  if (i.kind === 'site') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message: `interrupted: ${why}. The site extraction stopped with its browser (files written before stay in .demo-studio/site/${i.site_id}/); nothing else was touched`,
        fix: `${cli} theme from-site ${shellWord(i.url)}`,
      },
    };
  }
  if (i.kind === 'render') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message: `interrupted: ${why}. The render stopped: nothing was written under ${i.render_id} (the next worker removes its temporary files and its browser)`,
        fix: `${cli} render ${i.project} ${i.scenario} --run ${i.run_id}${i.template ? ` --theme ${i.template}` : ''}`,
      },
    };
  }
  if (i.kind === 'review' || i.kind === 'export') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message:
          i.kind === 'review'
            ? `interrupted: ${why}. The review stopped: the previous review of ${i.render_id} is kept (the next worker puts it back and removes the temporary folder)`
            : `interrupted: ${why}. The export stopped: formats written before stay in exports/${i.render_id}/ (the next worker removes partial files and a re-render's browser)`,
        fix: i.kind === 'review' ? `${cli} review ${i.project} ${i.render_id}` : `${cli} export ${i.project} ${i.render_id} --formats ${i.formats.join(',')}`,
      },
    };
  }
  if (i.kind === 'preview') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message: `interrupted: ${why}. The preview stopped: images written before stay in .demo-studio/previews/${i.preview_id}/ (the next worker kills its browser)`,
        ...(i.target.kind === 'component' ? { fix: `${cli} components preview ${i.target.component}${i.template ? ` --theme ${i.template}` : ''} --out <folder>` } : {}),
      },
    };
  }
  if (i.kind === 'inspect') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message: `interrupted: ${why}. The inspection stopped: it ran a dry replay only (no hook); submit it again`,
        fix: `${cli} inspect ${i.project} ${i.source.kind === 'page' ? i.source.page : i.source.scenario}${i.env ? ` --env ${i.env}` : ''}`,
      },
    };
  }
  if (i.kind === 'record') {
    // Where it was (the job's last progress): from the draft on, the recording had ended and its draft was written.
    const phase = rec.progress?.phase ?? '';
    const folder = `.demo-studio/records/${i.rec_id}`;
    const message =
      phase === 'check'
        ? `interrupted: ${why}. The recording had ended and its draft was made: ${folder}/draft.yaml (saved under scenarios/ too when its name was free); only its check replay was cut — dry-run the draft`
        : phase === 'draft'
          ? `interrupted: ${why}. The recording had ended; its draft was being made: ${folder}/draft.yaml if it was written (${folder}/events.jsonl holds what was recorded); record again if it is missing`
          : `interrupted: ${why}. The recording stopped with it: no draft was made (what was recorded up to then is in ${folder}/events.jsonl, if the window had opened); record again`;
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message,
        fix: `${cli} record ${i.project}${i.scenario ? ` ${i.scenario}` : ''}${i.env ? ` --env ${i.env}` : ''}${i.persona ? ` --persona ${i.persona}` : ''} --page ${i.source.page}${i.source.path !== '/' ? ` --path ${shellWord(i.source.path)}` : ''}`,
      },
    };
  }
  const env = i.env ? ` --env ${i.env}` : '';
  const error: JobRecord['error'] =
    i.kind === 'auth_login'
      ? { code: 'cancelled', message: `interrupted: ${why}. The sign-in stopped with it: its session may not have been saved`, fix: `${cli} login ${i.project}${env}${i.persona ? ` --persona ${i.persona}` : ''}${i.mode === 'auto' ? ' --auto' : ''}` }
      : i.kind === 'sandbox_up' || i.kind === 'sandbox_reset'
        ? {
            code: 'cancelled',
            message: `interrupted: ${why}. Services it started may still run, and a seed it began is not recorded: the next sandbox up seeds again`,
            fix: `${cli} sandbox up ${i.project}${env}`,
          }
        : {
            code: 'cancelled',
            message: `interrupted: ${why}. ${i.kind === 'run' ? 'Its run' : 'It'} stopped where it was; rollbacks it left pending are replayed by an environment reset`,
            fix: `${cli} env reset ${i.project}${env}`,
          };
  return { ...rec, state: 'interrupted', derived: true, error };
}
