/**
 * The Studio's side of a recording (L4.8, R-UI-20 / 21 / 22): the Record screen is the control panel of the headed
 * window the worker opened (record-job.ts) — it reads the draft live, picks target alternatives, places quick inserts,
 * stops, discards and saves. Nothing here reaches the window: every operation reads or writes the recording's folder
 * (`<project>/.retake/records/<rec_id>/`) or the job's markers.
 *
 * - view: the state (job + folder; the job is found through meta.json's job_id, never a queue scan), the draft made
 *   from events.jsonl (each line re-validated; a last line still being written is left for the next read), meta.json's
 *   context and the current project.yaml, with the Studio's annotations (studio.json) when the Studio started it —
 *   counts and enums trusted, everything made of page or typed text under `untrusted`; never a path; `draft_sha256`, the
 *   hash of the draft shown, which Save sends back. `since` (the answer's `version`) makes an unchanged poll cheap: no
 *   events read, no draft made. Reads, like writes, never go through a link: the records folder and the recording's
 *   folder must be real folders of the project (else nothing is read and the view says why).
 * - annotate: one change (choose / insert / remove) under the recording's lock and its revision; an insert "at the end"
 *   goes after the newest event read under the lock (critique B3: a visit to the Studio commits the typing in
 *   progress, after the screen's last poll). studio.json is read without following a link and replaced by a rename.
 * - save: the draft made again from the events file (refused when it is not the one the worker drafted and checked:
 *   record.json's events_sha256, B8 — fail closed: a record.json without a valid one, or a finished job without its
 *   record.json, is `tampered`) with the annotations, validated with the project; refused unless it is byte for byte
 *   the draft the person saw (`draft`: the view's draft_sha256 — an events line, a project.yaml var or an annotation
 *   changed since is a conflict); a hidden character anywhere refused again; then a NEW scenarios/<name>.yaml only (a
 *   taken name is a conflict, never an overwrite) under agent trust (`via: 'studio'`). Errors are fixed words located
 *   by scene and step; the validator's text sits under `untrusted`, paths removed (B15).
 * - discard: an open window is cancelled (the worker removes the folder, L3.4; the view says "discarded"); during the
 *   draft or the check the folder is marked and removed once the job is over (B9: by the job itself, else by the next
 *   view or list); afterwards it is removed at once — only a real folder directly under the project's real records
 *   folder, never through a link.
 * - stop: queued = cancel (unless the worker took it meanwhile); before the window opened = the stop marker, which the
 *   job turns into a clean cancel — never a cancel racing the window into a discard; while recording = the stop marker
 *   (the window closes as if the person closed it; the check replay runs).
 *
 * Who: annotate, save and discard only for a recording the Studio started — its job exists, with `submitted_by: 'ui'`,
 * and it is the job meta.json names with `submitted_by: 'ui'` too (a meta.json alone proves nothing: everything under
 * `.retake/` is agent-writable); MCP and CLI recordings are read-only here (their job saved them already), and so is
 * one whose origin cannot be verified. The engine gates every operation of this module to the `ui` and `test` clients.
 */
import { randomBytes } from 'node:crypto';
import { lstat, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_TEMPLATE,
  JOB_ID_RE,
  PERSONA_NONE,
  RECORD_ID_RE,
  RecordAnnotationChangeSchema,
  RecordedEventSchema,
  applyRecordChange,
  draftFromRecording,
  draftInvalidIssue,
  emptyRecordAnnotations,
  firstHiddenChar,
  hiddenCharName,
  isEmptyRecordAnnotations,
  loadProjectTemplate,
  parseScenario,
  plainTarget,
  readPlainFile,
  recordZoomOptions,
  recordedAlternatives,
  scenarioBlocks,
  shownStep,
  pathInside,
  statePath,
  PROJECT_DIRS,
} from '@retake/core';
import type {
  DraftIssue,
  DraftPlaceholder,
  DraftSource,
  DraftWrite,
  JobClient,
  JobState,
  LoadedProject,
  RecordAnnotationChange,
  RecordAnnotations,
  RecordInsert,
  RecordedEvent,
  RecordingDraft,
  ScenarioBlocks,
  TargetSpec,
} from '@retake/core';
import { callerOf, guardsStudioRecordings, submittedInStudio } from './caller.js';
import { EngineError, toEngineError } from './errors.js';
import { isAlive } from './jobs/proc.js';
import type { JobQueueView } from './jobs/job-queue.js';
import type { JobErrorView, JobRecord } from './jobs/types.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import { lockHolder, takeProjectLock } from './project-lock.js';
import { recordDir, recordStart, recordsRoot } from './record.js';
import { RECORD_META_FILE, RECORD_STUDIO_FILE, readRecordAnnotations, readRecordMeta, recordLockName } from './record-files.js';
import type { RecordMeta } from './record-files.js';
import { checkScenarioName } from './refs.js';
import { saveScenarioText } from './scenarios.js';
import type { StoreScope } from './store/project-store.js';
import { sha256Hex } from './storage.js';

/** The largest events.jsonl read (bytes): a 30-minute recording is far below it. */
export const RECORD_EVENTS_MAX_BYTES = 64 * 1024 * 1024;
const RECORD_JSON_MAX_BYTES = 8 * 1024 * 1024;
/** How long an operation waits for the recording's lock held by another one (ms). */
const RECORD_LOCK_WAIT_MS = 3000;
/** The runner's longest recording when nothing else is set (record-session RECORD_MAX_MS). */
const RECORD_DEFAULT_MAX_MS = 30 * 60_000;

/**
 * Where a recording stands. queued / preflight (no window yet) → recording (the window is open) → draft → check →
 * done (record.json written); interrupted: the worker (or the terminal) stopped while the window was open — the events
 * kept, no draft made; tampered: a Studio recording whose files were changed after its job wrote them (record.json
 * gone from a finished job, or without its events checksum) — it cannot be verified, read-only; nothing_recorded: it
 * ended with no action (no folder); failed / cancelled: the job's error; discarded: removed from the Studio (an open
 * window discarded too); missing: no folder and no job.
 */
export type RecordState =
  | 'queued'
  | 'preflight'
  | 'recording'
  | 'draft'
  | 'check'
  | 'done'
  | 'interrupted'
  | 'tampered'
  | 'nothing_recorded'
  | 'failed'
  | 'cancelled'
  | 'discarded'
  | 'missing';

const LIVE_STATES: ReadonlySet<RecordState> = new Set(['queued', 'preflight', 'recording', 'draft', 'check']);
const ANNOTATE_STATES: ReadonlySet<RecordState> = new Set(['recording', 'draft', 'check', 'done', 'interrupted']);
const FINAL_STATES: ReadonlySet<RecordState> = new Set(['done', 'interrupted']);

/** A target the person may pick for a step (index 0: the recorder's suggestion). */
export interface RecordTargetOption {
  index: number;
  target: TargetSpec;
  /** The target in plain words (`button "Save"`). */
  words: string;
  fragile: string[];
}

export interface RecordCheckView {
  status: 'passed' | 'failed' | 'skipped' | 'cancelled';
  scope: 'all' | 'until_write' | null;
  reason?: string;
  steps_passed: number;
  steps_total: number;
  /** The events file is not the one the worker drafted and checked (record.json's events_sha256): the check does not hold. */
  events_changed: boolean;
}

/** The zoom factors the camera insert offers (each at most the project theme's max_zoom) and its default. */
export interface RecordZoomView {
  max: number;
  options: number[];
  default: number;
}

export interface RecordView {
  rec_id: string;
  state: RecordState;
  /** Pass it back as `since`: an answer with `unchanged: true` and nothing else means nothing changed. */
  version: string;
  unchanged?: true;
  job: { id: string; state: JobState; phase: string | null; cancel_requested: boolean; stop_requested: boolean; error?: JobErrorView } | null;
  /** Who started it (`ui`: the Studio; `mcp`: Claude; `cli`: a terminal); null when neither meta.json nor a job says. */
  started_by: JobClient | null;
  /** What the Record screen may offer. annotate / save / discard: a Studio recording, not saved, not discarded. */
  can: { annotate: boolean; save: boolean; discard: boolean; stop: boolean };
  /** Why the draft is not shown or cannot be changed (fixed words), when it is not. */
  problem?: string;
  name: string | null;
  env: string | null;
  persona: string | null;
  access: 'read-only' | 'read-write' | null;
  page: string | null;
  path: string | null;
  started_at: string | null;
  /** When the recording stops by itself (its maximum duration). */
  ends_at: string | null;
  /** studio.json's revision (annotate's and save's `rev`). */
  rev: number;
  /** sha256 of the draft shown (`untrusted.yaml`): Save sends it back and refuses any other draft. Null with no draft. */
  draft_sha256: string | null;
  /** The camera insert's factors under the project theme (null: the theme allows no zoom, or there is no draft). */
  zoom: RecordZoomView | null;
  counts: { events: number; actions: number; dropped_lines: number };
  stats: RecordingDraft['stats'] | null;
  issues: { error: number; warning: number; info: number };
  check: RecordCheckView | null;
  saved: { name: string; file: string; hash?: string } | null;
  /** The recording's warnings (engine and runner words: no page text). */
  warnings: string[];
  writes: { total: number; by_steps: number; ambient: number };
  /** Page and typed text: the draft, its rows, sources and issues, the alternatives, the inserts, the write labels. */
  untrusted: {
    yaml: string;
    blocks: ScenarioBlocks;
    sources: DraftSource[];
    issues: DraftIssue[];
    pending: string[];
    placeholders: DraftPlaceholder[];
    alternatives: Array<{ scene: string; step: number; seq: number; chosen: number; options: RecordTargetOption[] }>;
    inserts: RecordInsert[];
    writes: DraftWrite[];
    /**
     * The check replay's failure. `failed_at` is a step of the recorded draft the check replayed (no picks, no inserts);
     * `failed_row` the same step on screen (null: it is not there any more).
     */
    check?: { until?: string; failed_at?: { scene: string; step: number; action: string }; failed_row?: { scene: string; step: number } | null; error?: string };
  } | null;
}

export interface RecordAnnotated {
  rev: number;
  /** The insert's id (an insert change). */
  insert_id?: string;
  view: RecordView;
}

export interface RecordSaved {
  name: string;
  /** scenarios/<name>.yaml */
  file: string;
  hash: string;
  rev: number;
  /** The scenario's validation warnings, counted (their text is page-derived). */
  warnings: number;
  untrusted: { issues: DraftIssue[] };
}

export interface RecordDiscarded {
  rec_id: string;
  /** discarded: the folder is gone; discarding: the job is being cancelled (the folder goes once it is over). */
  state: 'discarded' | 'discarding';
}

export interface RecordStopped {
  /** cancelled: before the window opened; stopping: the window closes, then the draft and the check; none: nothing to stop. */
  action: 'cancelled' | 'stopping' | 'none';
  view: RecordView;
}

export interface RecordStudioContext {
  queue: JobQueueView;
  client: JobClient;
  /** Where a saved draft is written and journaled (the engine's caller). */
  scope: StoreScope;
}

// ── Reading the folder ─────────────────────────────────────────────────────

type EventsRead = { ok: true; events: RecordedEvent[]; bytes: Buffer; dropped: number } | { ok: false; problem: string };

/**
 * events.jsonl read without following a link, each complete line re-validated (a line the schema refuses is dropped
 * and counted). The runner streams the file: a last line without its newline is still being written — left for the
 * next read.
 */
export function readRecordEvents(dir: string): EventsRead {
  const r = readPlainFile(join(dir, 'events.jsonl'), RECORD_EVENTS_MAX_BYTES);
  if (!r.ok) {
    if (r.reason === 'missing') return { ok: true, events: [], bytes: Buffer.alloc(0), dropped: 0 };
    if (r.reason === 'link') return { ok: false, problem: 'events.jsonl is a symbolic link: the recording is never read through a link' };
    if (r.reason === 'too_large') return { ok: false, problem: `events.jsonl is larger than ${RECORD_EVENTS_MAX_BYTES / 1024 / 1024} MB` };
    return { ok: false, problem: 'events.jsonl cannot be read' };
  }
  const text = r.bytes.toString('utf8');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const events: RecordedEvent[] = [];
  let dropped = 0;
  for (const line of complete.split('\n')) {
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      dropped++;
      continue;
    }
    const p = RecordedEventSchema.safeParse(raw);
    if (p.success) events.push(p.data);
    else dropped++;
  }
  return { ok: true, events, bytes: r.bytes, dropped };
}

interface RecordJson {
  events_sha256: string | null;
  saved: string | null;
  check: Record<string, unknown> | null;
  warnings: string[];
  /** The worker's draft: its steps, and the actions recorded (the recent list). */
  steps: number | null;
  actions: number | null;
}

/** record.json's fields the view uses (each checked; null when there is none or it is not readable). */
function readRecordJson(dir: string): RecordJson | null {
  const r = readPlainFile(join(dir, 'record.json'), RECORD_JSON_MAX_BYTES);
  if (!r.ok) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(r.bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  return {
    events_sha256: typeof j.events_sha256 === 'string' && /^[0-9a-f]{64}$/.test(j.events_sha256) ? j.events_sha256 : null,
    saved: typeof j.saved === 'string' && /^scenarios\/[\w-]{1,100}\.yaml$/.test(j.saved) ? j.saved : null,
    check: j.check && typeof j.check === 'object' && !Array.isArray(j.check) ? (j.check as Record<string, unknown>) : null,
    warnings: Array.isArray(j.warnings) ? j.warnings.filter((w): w is string => typeof w === 'string').slice(0, 50).map((w) => w.slice(0, 400)) : [],
    steps: count((j.stats as { steps?: unknown } | undefined)?.steps),
    actions: count((j.counts as { actions?: unknown } | undefined)?.actions),
  };
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** The recording's job (meta.json's job_id, else the caller's hint), only when it is that recording's `record` job. */
async function jobOf(queue: JobQueueView, slug: string, id: string, meta: RecordMeta | null, hint?: string): Promise<JobRecord | null> {
  const jid = meta ? meta.job_id : (hint ?? null);
  if (!jid || !JOB_ID_RE.test(jid)) return null;
  const job = await queue.get(jid);
  if (!job || job.input.kind !== 'record' || job.input.rec_id !== id || job.input.project !== slug) return null;
  return job;
}

/**
 * Is the recording's folder there, and a real one: the project's records folder a real folder (its real path exactly
 * <real project>/.retake/records — no link on the way) and the recording's folder a real folder directly in it.
 * `link`: something on the way is a link or leads elsewhere — nothing is read, written or removed there (L4.1: reads
 * never follow a link out of a project).
 */
async function folderState(project: LoadedProject, id: string): Promise<'folder' | 'none' | 'link'> {
  const root = recordsRoot(project);
  const dir = join(root, id);
  let dirSt: Awaited<ReturnType<typeof lstat>>;
  try {
    dirSt = await lstat(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'link';
  }
  if (!dirSt.isDirectory() || dirSt.isSymbolicLink()) return 'link';
  try {
    const [rootSt, realProject, realRoot, realDir] = await Promise.all([lstat(root), realpath(project.dir), realpath(root), realpath(dir)]);
    if (!rootSt.isDirectory() || rootSt.isSymbolicLink() || realRoot !== statePath(realProject, 'records') || realDir !== join(realRoot, id) || !pathInside(realDir, realProject, { dotDotPrefix: true })) return 'link';
  } catch {
    return 'link';
  }
  return 'folder';
}

/** The project's records folder, when it is a real folder of the project (else null: a link on the way). */
async function realRecordsRoot(project: LoadedProject): Promise<string | null> {
  const root = recordsRoot(project);
  try {
    const [st, realProject, realRoot] = await Promise.all([lstat(root), realpath(project.dir), realpath(root)]);
    return st.isDirectory() && !st.isSymbolicLink() && realRoot === statePath(realProject, 'records') ? root : null;
  } catch {
    return null;
  }
}

const LINK_WORDS = 'the recording\'s folder or the records folder is a symbolic link or leads out of the project: nothing is read, written or removed through a link (remove it by hand)';
const ORIGIN_WORDS = 'the recording\'s origin cannot be verified (meta.json says the Studio started it, but its job is gone or says otherwise): it is read-only here';
const TAMPERED_WORDS =
  'the recording\'s files were changed after its job wrote them (record.json is missing or holds no checksum of the events): it cannot be verified, so it cannot be saved — discard it and record again';

async function mtimeOf(file: string): Promise<string> {
  try {
    const s = await stat(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

interface Situation {
  project: LoadedProject;
  id: string;
  dir: string;
  folder: boolean;
  /** The folder (or the records folder) is a link or leads elsewhere: nothing read. */
  link: boolean;
  meta: RecordMeta | null;
  job: JobRecord | null;
  stopAsked: boolean;
  cancelAsked: boolean;
  /** The cancel was the Studio's Discard of the open window. */
  discardAsked: boolean;
  record: RecordJson | null;
  ann: { annotations: RecordAnnotations | null } | { problem: string };
  state: RecordState;
  startedBy: JobClient | null;
  /** The person's own recording, from the Studio: its job (with `submitted_by: 'ui'`) is the one meta.json names. */
  studio: boolean;
  /** meta.json says the Studio started it, but no job proves it (ORIGIN_WORDS). */
  unverified: boolean;
}

/** The phase of a running record job (its progress), as a state. */
function runningState(job: JobRecord, folder: boolean): RecordState {
  const phase = job.progress?.phase ?? 'preflight';
  if (phase === 'draft' || phase === 'check') return phase;
  if (phase.startsWith('recording')) return 'recording';
  return folder ? 'recording' : 'preflight';
}

async function situation(ctx: RecordStudioContext, project: LoadedProject, id: string, hint?: string): Promise<Situation> {
  const dir = recordDir(project, id);
  const where = await folderState(project, id);
  const folder = where === 'folder';
  const meta = folder ? readRecordMeta(dir, id) : null;
  const job = await jobOf(ctx.queue, project.slug, id, meta, hint);
  const record = folder ? readRecordJson(dir) : null;
  const ann = folder ? readRecordAnnotations(dir) : { annotations: null };
  const [stop, cancel] = job ? await Promise.all([ctx.queue.stopOf(job.id), ctx.queue.cancelOf(job.id)]) : [undefined, undefined];
  const [stopAsked, cancelAsked, reason] = [stop !== undefined, cancel !== undefined, cancel?.reason];
  const discardAsked = reason === 'discard';
  // Who started it (A-L1): a Studio recording only when its job — the one meta.json names — says so too.
  const byJob = job?.input.kind === 'record' ? job.input.submitted_by : undefined;
  let studio: boolean;
  let startedBy: JobClient | null;
  let unverified = false;
  if (meta && submittedInStudio(meta)) {
    studio = !!job && meta.job_id === job.id && submittedInStudio({ submitted_by: byJob });
    unverified = !studio;
    startedBy = studio ? 'ui' : (byJob ?? null);
  } else if (meta) {
    studio = false;
    startedBy = meta.submitted_by;
  } else {
    studio = submittedInStudio({ submitted_by: byJob });
    startedBy = byJob ?? null;
  }
  let state: RecordState;
  if (job && (job.state === 'queued' || job.state === 'running')) state = job.state === 'queued' ? 'queued' : runningState(job, folder);
  else if (folder) {
    // Fail closed (A-M2): a Studio recording's record.json must hold the events checksum, and a job that ended well
    // wrote one — a missing or spoiled one is tampered (never "done" or "interrupted", which Save accepts).
    if (record) state = studio && record.events_sha256 === null ? 'tampered' : 'done';
    else if (job) state = job.state === 'failed' ? 'failed' : job.state === 'cancelled' ? 'cancelled' : job.state === 'succeeded' && studio ? 'tampered' : 'interrupted';
    else if (meta && meta.job_id === null && (await isAlive(meta.owner))) state = 'recording';
    else state = 'interrupted';
  } else if (job) {
    // A job that ended well though it was cancelled: the cancel came during the draft or the check (a Discard, B9), and
    // the folder is gone since — discarded (not "nothing recorded"); a cancel that was the Studio's Discard of the open
    // window: discarded too (not "cancelled", B-M5).
    state =
      job.state === 'succeeded'
        ? cancelAsked
          ? 'discarded'
          : 'nothing_recorded'
        : job.state === 'failed'
          ? 'failed'
          : job.state === 'interrupted'
            ? 'interrupted'
            : discardAsked
              ? 'discarded'
              : 'cancelled';
  } else state = 'missing';
  return { project, id, dir, folder, link: where === 'link', meta, job, stopAsked, cancelAsked, discardAsked, record, ann, state, startedBy, studio, unverified };
}

/** The recording's lock: retried while another operation holds it (≤ RECORD_LOCK_WAIT_MS). */
function lockRecording(project: LoadedProject, id: string, op: string) {
  return takeProjectLock(project.dir, recordLockName(id), {
    command: `record ${op} ${id}`,
    what: `recording ${id}`,
    waitMs: RECORD_LOCK_WAIT_MS,
    retryMs: 30,
    busy: (_ref, held) => {
      const { pid } = lockHolder(held);
      return new EngineError('busy', `recording ${id} is being changed by another operation${pid ? ` (pid ${pid})` : ''}: try again`, { fix: 'try again in a moment' });
    },
  });
}

/**
 * The recording's folder, checked before anything in it is written or removed: the project's records folder is a real
 * folder (no link on the way: its real path is exactly <real project>/.retake/records) and the recording's own
 * folder is a real folder directly in it. Throws EngineError refused (no path in the message).
 */
async function checkedFolder(project: LoadedProject, id: string): Promise<string> {
  if (!RECORD_ID_RE.test(id)) throw new EngineError('invalid', 'invalid recording id: rec_ followed by 26 characters, never a path');
  const where = await folderState(project, id);
  if (where === 'none') throw new EngineError('not_found', `recording ${id} has no folder (nothing recorded, discarded or pruned)`);
  if (where === 'link') throw new EngineError('refused', `recording ${id}: ${LINK_WORDS}`);
  return join(recordsRoot(project), id);
}

/** Remove the recording's folder (checkedFolder first). */
async function removeFolder(project: LoadedProject, id: string): Promise<void> {
  const dir = await checkedFolder(project, id);
  await rm(dir, { recursive: true, force: true });
}

/** studio.json replaced whole: a new file created exclusively (never through a link), then renamed over it. */
async function writeAnnotations(dir: string, a: RecordAnnotations): Promise<void> {
  const tmp = join(dir, `.studio-${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(a)}\n`);
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, join(dir, RECORD_STUDIO_FILE));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

// ── The draft ──────────────────────────────────────────────────────────────

const ACTION_EVENT_KINDS = new Set(['pointer', 'dblclick', 'type', 'select_native', 'file', 'key']);

/**
 * The draft of the recording as it is now (meta.json's context with the current project.yaml), or why not. A Studio
 * recording's draft holds no YAML anchor or alias (B-M2: the block editor edits it after Save); the others' is exactly
 * their job's.
 */
function draftOf(s: Situation, events: readonly RecordedEvent[], annotations: RecordAnnotations | null): { draft: RecordingDraft } | { problem: string } {
  const meta = s.meta!;
  let start: ReturnType<typeof recordStart>;
  try {
    start = recordStart(s.project, { env: meta.env, persona: meta.persona ?? PERSONA_NONE, page: meta.page, path: meta.path });
  } catch {
    return { problem: 'the recording\'s environment, page or persona is no longer in project.yaml: the draft cannot be made' };
  }
  const config = s.project.config;
  const draft = draftFromRecording(
    events,
    {
      name: meta.name,
      env: start.env.name,
      envIsDefault: start.env.name === (config.default_env ?? Object.keys(config.environments ?? {})[0]),
      pages: start.env.pages,
      persona: meta.persona,
      ...(start.defaultPersonas ? { defaultPersonas: start.defaultPersonas } : {}),
      ...(config.vars ? { projectVars: config.vars } : {}),
      access: meta.access,
    },
    annotations,
    { ...(FINAL_STATES.has(s.state) || s.state === 'tampered' ? { final: true } : {}), ...(s.studio ? { aliases: false } : {}) },
  );
  // Valid in the project, as the worker checks it: errors located by scene and step, never the validator's text.
  if (!draft.issues.some((i) => i.severity === 'error')) {
    const ids = (draft.scenario.scenes as Array<{ id: string }>).map((x) => x.id);
    const file = join(s.dir, 'draft.yaml');
    for (const x of parseScenario(draft.yaml, { project: s.project, file, env: start.env.name }).issues) {
      if (x.severity === 'error') draft.issues.push(draftInvalidIssue(x, ids, 'the draft does not validate in the project'));
    }
  }
  return { draft };
}

function alternativesOf(draft: RecordingDraft, events: readonly RecordedEvent[], annotations: RecordAnnotations | null): NonNullable<RecordView['untrusted']>['alternatives'] {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const out: NonNullable<RecordView['untrusted']>['alternatives'] = [];
  for (const src of draft.sources) {
    if (src.target_seq === undefined) continue;
    const ev = bySeq.get(src.target_seq);
    const el = ev && 'el' in ev ? ev.el : null;
    if (!el?.target) continue;
    const offered = recordedAlternatives(el);
    if (!offered.length) continue;
    const main = el.target;
    const chosen = annotations?.choices[String(src.target_seq)] ?? 0;
    out.push({
      scene: src.scene,
      step: src.step,
      seq: src.target_seq,
      chosen,
      options: [
        { index: 0, target: main as TargetSpec, words: plainTarget(main), fragile: [...el.fragile] },
        ...offered.map((o) => ({ index: o.index, target: o.target, words: plainTarget(o.target), fragile: [...o.fragile] })),
      ],
    });
  }
  return out;
}

function checkOf(rec: RecordJson | null, eventsChanged: boolean): { view: RecordCheckView | null; untrusted?: NonNullable<RecordView['untrusted']>['check'] } {
  const c = rec?.check;
  if (!c) return { view: null };
  const status = ['passed', 'failed', 'skipped', 'cancelled'].includes(c.status as string) ? (c.status as RecordCheckView['status']) : null;
  if (!status) return { view: null };
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  const view: RecordCheckView = {
    status,
    scope: c.scope === 'all' || c.scope === 'until_write' ? c.scope : null,
    ...(typeof c.reason === 'string' && /^[a-z_]{1,40}$/.test(c.reason) ? { reason: c.reason } : {}),
    steps_passed: num(c.steps_passed),
    steps_total: num(c.steps_total),
    events_changed: eventsChanged,
  };
  const f = c.failed_at as { scene?: unknown; step?: unknown; action?: unknown } | undefined;
  const u = c.untrusted as { error?: unknown } | undefined;
  const untrusted = {
    ...(typeof c.until === 'string' ? { until: c.until.slice(0, 200) } : {}),
    ...(f && typeof f.scene === 'string' && typeof f.step === 'number' && Number.isInteger(f.step) && f.step >= 0
      ? { failed_at: { scene: f.scene.slice(0, 100), step: f.step, action: typeof f.action === 'string' ? f.action.slice(0, 40) : '?' } }
      : {}),
    ...(u && typeof u.error === 'string' ? { error: u.error.slice(0, 2000) } : {}),
  };
  return { view, ...(Object.keys(untrusted).length ? { untrusted } : {}) };
}

function versionOf(parts: unknown[]): string {
  return sha256Hex(JSON.stringify(parts)).slice(0, 16);
}

async function versionFor(s: Situation): Promise<string> {
  const [ev, st, rj, py] = await Promise.all([
    mtimeOf(join(s.dir, 'events.jsonl')),
    mtimeOf(join(s.dir, RECORD_STUDIO_FILE)),
    mtimeOf(join(s.dir, 'record.json')),
    mtimeOf(join(s.project.dir, 'project.yaml')),
  ]);
  return versionOf([s.state, s.folder, s.link, s.studio, s.job?.state, s.job?.progress?.phase ?? null, s.stopAsked, s.cancelAsked, ev, st, rj, py, await mtimeOf(join(s.dir, RECORD_META_FILE))]);
}

/**
 * A discard asked during the draft or the check: once the job is over, the folder goes (the job removes it itself, B9;
 * this catches a Discard that came as the job ended, from a view or the recent list). A read removes a folder here — on
 * purpose: only a Studio recording whose job is verified and marked, which an agent could remove anyway.
 */
async function settleDiscard(s: Situation): Promise<boolean> {
  const a = 'annotations' in s.ann ? s.ann.annotations : null;
  if (!s.folder || !a?.discard || !s.studio) return false;
  if (s.job && !FINISHED_JOB_STATES.has(s.job.state)) return false;
  const lock = await lockRecording(s.project, s.id, 'discard');
  try {
    await removeFolder(s.project, s.id);
  } finally {
    lock.releaseSync();
  }
  return true;
}

const studioWords = (by: JobClient | null) =>
  by === 'mcp' ? 'Claude started this recording (its job saved the draft): it is read-only here' : by === 'cli' ? 'this recording was made in a terminal: it is read-only here' : 'this recording was not started from the Studio: it is read-only here';

/** The camera insert's factors under the project theme's max_zoom (B-M3). */
async function zoomOf(project: LoadedProject): Promise<RecordZoomView | null> {
  let max = DEFAULT_TEMPLATE.motion.max_zoom;
  try {
    max = (await loadProjectTemplate(project)).template.motion.max_zoom;
  } catch {
    max = DEFAULT_TEMPLATE.motion.max_zoom;
  }
  const o = recordZoomOptions(max);
  return o ? { max, options: o.options, default: o.default } : null;
}

// ── Operations ─────────────────────────────────────────────────────────────

/** The Record screen's view of a recording (see the module comment). */
export async function recordView(ctx: RecordStudioContext, project: LoadedProject, id: string, o: { job?: string; since?: string } = {}): Promise<RecordView> {
  let s = await situation(ctx, project, id, o.job);
  if (await settleDiscard(s)) s = { ...s, folder: false, state: 'discarded' };
  const version = await versionFor(s);
  const annRead = s.ann;
  const ann = 'annotations' in annRead ? annRead.annotations : null;
  const studio = s.studio;
  const meta = s.meta;
  const base: RecordView = {
    rec_id: id,
    state: s.state,
    version,
    job: s.job
      ? {
          id: s.job.id,
          state: s.job.state,
          phase: s.job.progress?.phase ?? null,
          cancel_requested: s.cancelAsked,
          stop_requested: s.stopAsked,
          ...(s.job.error ? { error: { code: s.job.error.code, message: s.job.error.message, ...(s.job.error.fix ? { fix: s.job.error.fix } : {}) } } : {}),
        }
      : null,
    started_by: s.startedBy,
    can: { annotate: false, save: false, discard: false, stop: false },
    name: meta?.name ?? (s.job?.input.kind === 'record' ? (s.job.input.scenario ?? null) : null),
    env: meta?.env ?? (s.job?.input.kind === 'record' ? (s.job.input.env ?? null) : null),
    persona: meta?.persona ?? null,
    access: meta?.access ?? null,
    page: meta?.page ?? (s.job?.input.kind === 'record' ? s.job.input.source.page : null),
    path: meta?.path ?? (s.job?.input.kind === 'record' ? s.job.input.source.path : null),
    started_at: meta?.started_at ?? null,
    ends_at: meta ? new Date(Date.parse(meta.started_at) + (meta.max_ms ?? RECORD_DEFAULT_MAX_MS)).toISOString() : null,
    rev: ann?.rev ?? 0,
    draft_sha256: null,
    zoom: null,
    counts: { events: 0, actions: 0, dropped_lines: 0 },
    stats: null,
    issues: { error: 0, warning: 0, info: 0 },
    check: null,
    saved: ann?.saved ? { name: ann.saved.name, file: ann.saved.file, hash: ann.saved.hash } : s.record?.saved ? { name: s.record.saved.slice(PROJECT_DIRS.scenarios.length + 1, -'.yaml'.length), file: s.record.saved } : null,
    warnings: s.record?.warnings ?? [],
    writes: { total: 0, by_steps: 0, ambient: 0 },
    untrusted: null,
  };
  const liveJob = !!s.job && !FINISHED_JOB_STATES.has(s.job.state);
  base.can.stop = liveJob && !s.cancelAsked && !s.stopAsked && (s.state === 'queued' || s.state === 'preflight' || s.state === 'recording');
  const open = studio && !base.saved && !ann?.discard && s.state !== 'discarded';
  base.can.discard = studio && !ann?.discard && (s.folder || liveJob) && !(liveJob && s.cancelAsked);
  if (o.since !== undefined && o.since === version) return { ...base, unchanged: true };
  if (s.link) {
    base.problem = LINK_WORDS;
    return base;
  }
  if (s.unverified && s.folder) base.problem = ORIGIN_WORDS;
  else if (!studio && s.startedBy !== null && s.folder) base.problem = studioWords(s.startedBy);
  if ('problem' in annRead && studio) base.problem = annRead.problem;
  if (s.state === 'tampered') base.problem = TAMPERED_WORDS;
  if (!s.folder || !meta) {
    if (s.folder && !meta) base.problem = 'the recording\'s meta.json is missing or not valid: it is read-only here';
    return base;
  }
  const read = readRecordEvents(s.dir);
  if (!read.ok) {
    base.problem = read.problem;
    return base;
  }
  // The events as drafted and checked (B8, fail closed: a record.json without the checksum never matches).
  const eventsChanged = !!s.record && s.record.events_sha256 !== sha256Hex(read.bytes);
  const shownAnn = studio ? ann : null;
  const made = draftOf(s, read.events, shownAnn);
  base.counts = { events: read.events.length, actions: read.events.filter((e) => ACTION_EVENT_KINDS.has(e.kind)).length, dropped_lines: read.dropped };
  const check = checkOf(s.record, eventsChanged);
  base.check = check.view;
  if ('problem' in made) {
    base.problem = made.problem;
    return base;
  }
  const d = made.draft;
  base.stats = d.stats;
  base.draft_sha256 = sha256Hex(d.yaml);
  base.issues = { error: d.issues.filter((i) => i.severity === 'error').length, warning: d.issues.filter((i) => i.severity === 'warning').length, info: d.issues.filter((i) => i.severity === 'info').length };
  base.writes = { total: d.writes.length, by_steps: d.writes.filter((w) => w.step !== null).length, ambient: d.writes.filter((w) => w.step === null).length };
  const annotatable = open && ANNOTATE_STATES.has(s.state) && 'annotations' in annRead;
  base.can.annotate = annotatable;
  base.can.save = annotatable && FINAL_STATES.has(s.state) && !eventsChanged && read.events.length > 0;
  if (annotatable) base.zoom = await zoomOf(project);
  // The check replayed the recorder's own draft (no picks, no inserts): its failing step, found on screen (B-M4).
  let checkUntrusted = check.untrusted;
  const failedAt = checkUntrusted?.failed_at;
  if (failedAt) {
    let row: { scene: string; step: number } | null = { scene: failedAt.scene, step: failedAt.step };
    if (!isEmptyRecordAnnotations(shownAnn)) {
      const bare = draftOf(s, read.events, null);
      row = 'draft' in bare ? shownStep(bare.draft.sources, d.sources, failedAt) : null;
    }
    checkUntrusted = { ...checkUntrusted, failed_row: row };
  }
  base.untrusted = {
    yaml: d.yaml,
    blocks: scenarioBlocks(d.yaml),
    sources: d.sources,
    issues: d.issues,
    pending: d.pending,
    placeholders: d.placeholders,
    alternatives: alternativesOf(d, read.events, shownAnn),
    inserts: studio ? (ann?.inserts ?? []) : [],
    writes: d.writes,
    ...(checkUntrusted ? { check: checkUntrusted } : {}),
  };
  return base;
}

/** A Studio recording, or a refusal (annotate, save and discard are the person's, from the Studio). */
function requireStudio(s: Situation, what: string): RecordMeta {
  if (s.link) throw new EngineError('refused', `${what}: ${LINK_WORDS}`);
  if (s.unverified) throw new EngineError('refused', `${what}: ${ORIGIN_WORDS}`);
  if (!s.studio) throw new EngineError('refused', `${what}: ${studioWords(s.startedBy)}`);
  if (!s.meta) throw new EngineError('refused', `${what}: the recording's meta.json is missing or not valid — it is read-only here`);
  return s.meta;
}

function annotationsOrRefuse(s: Situation, what: string): RecordAnnotations {
  if ('problem' in s.ann) throw new EngineError('invalid', `${what}: ${s.ann.problem}`);
  return s.ann.annotations ?? emptyRecordAnnotations();
}

function checkOpen(a: RecordAnnotations, what: string): void {
  if (a.saved) throw new EngineError('conflict', `${what}: the recording was saved as scenario ${a.saved.name} — change the scenario itself now`);
  if (a.discard) throw new EngineError('conflict', `${what}: the recording is being discarded`);
}

function checkRev(a: RecordAnnotations, rev: number): void {
  if (rev !== a.rev) {
    throw new EngineError('conflict', `the recording changed since it was read (revision ${a.rev}, not ${rev}): read it again`, { details: { current: a.rev }, fix: `rev: ${a.rev}` });
  }
}

/** One change to a Studio recording's annotations, under its lock and its revision (see the module comment). */
export async function recordAnnotate(ctx: RecordStudioContext, project: LoadedProject, id: string, req: { rev: number; change: RecordAnnotationChange }): Promise<RecordAnnotated> {
  const parsed = RecordAnnotationChangeSchema.safeParse(req.change);
  if (!parsed.success) throw new EngineError('invalid', `invalid change: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(change)'}: ${i.message}`).join('; ')}`);
  if (!Number.isInteger(req.rev) || req.rev < 0) throw new EngineError('invalid', 'rev must be the revision the view returned');
  const change = parsed.data;
  if (change.op === 'insert' && change.insert.kind === 'camera') {
    // A factor above the project theme's max_zoom is clamped by the editor and warned by the validator (B-M3).
    const zoom = await zoomOf(project);
    if (!zoom || change.insert.zoom > zoom.max) {
      throw new EngineError('invalid', `annotate: zoom ${change.insert.zoom} is above the project theme's max_zoom (${zoom ? zoom.max : 'no zoom'}): choose ${zoom ? zoom.options.join(', ') : 'no zoom'}`);
    }
  }
  let rev: number;
  let insertId: string | undefined;
  const lock = await lockRecording(project, id, 'annotate');
  try {
    const s = await situation(ctx, project, id);
    requireStudio(s, 'annotate');
    if (!ANNOTATE_STATES.has(s.state)) throw new EngineError('conflict', `annotate: the recording is ${s.state.replace('_', ' ')} — nothing to arrange`);
    const dir = await checkedFolder(project, id);
    const a = annotationsOrRefuse(s, 'annotate');
    checkOpen(a, 'annotate');
    checkRev(a, req.rev);
    // Read now, under the lock: "at the end" is the newest event in the file at this moment (critique B3).
    const read = readRecordEvents(dir);
    if (!read.ok) throw new EngineError('refused', `annotate: ${read.problem}`);
    const r = applyRecordChange(a, change, read.events);
    if ('error' in r) {
      const code = r.error.code === 'not_found' ? 'not_found' : r.error.code === 'taken' ? 'conflict' : r.error.code === 'too_many' ? 'refused' : 'invalid';
      throw new EngineError(code, `annotate: ${r.error.message}`);
    }
    await writeAnnotations(dir, r.annotations);
    rev = r.annotations.rev;
    insertId = r.id;
  } finally {
    lock.releaseSync();
  }
  return { rev, ...(insertId !== undefined ? { insert_id: insertId } : {}), view: await recordView(ctx, project, id) };
}

/** Remove the project's and the workspace's absolute paths from a text that leaves the engine (B15). */
function withoutPaths(text: string, dirs: string[]): string {
  let out = text;
  for (const d of dirs.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(d).join('…');
  return out.replace(/(?:\/[\w.@-]+){3,}/g, '…').slice(0, 400);
}

/** Any string of `v` holding a hidden character: that character. */
function hiddenIn(v: unknown): string | undefined {
  if (typeof v === 'string') return firstHiddenChar(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const h = hiddenIn(x);
      if (h !== undefined) return h;
    }
    return undefined;
  }
  if (v !== null && typeof v === 'object') return hiddenIn(Object.values(v));
  return undefined;
}

/**
 * A hidden character in a draft (A-M3, defence in depth — the generator leaves such steps out): where it is, in fixed
 * words (`scene <id>, step <n>` and the character's code), or null.
 */
function hiddenProblem(yaml: string): string | null {
  const h = firstHiddenChar(yaml);
  if (h === undefined) return null;
  const parsed = parseScenario(yaml).scenario as { scenes?: Array<{ id?: unknown; steps?: unknown[] }> } | undefined;
  for (const sc of parsed?.scenes ?? []) {
    for (const [k, st] of (sc.steps ?? []).entries()) {
      const c = hiddenIn(st);
      if (c !== undefined) return `scene ${typeof sc.id === 'string' && /^[\w-]{1,100}$/.test(sc.id) ? sc.id : '?'}, step ${k + 1} holds ${hiddenCharName(c)}`;
    }
  }
  return `the draft holds ${hiddenCharName(h)}`;
}

/**
 * Write a recorded draft as a NEW scenario (the write path of Save, exported for its tests): never a hidden character
 * (the Studio never writes one), agent trust (`via: 'studio'`), never over an existing file (a taken name is a
 * conflict), errors without a path — the validator's text located by scene and step and kept under `details.untrusted`.
 */
export async function saveRecordedDraft(project: LoadedProject, name: string, yaml: string, sceneIds: readonly string[], scope: StoreScope): Promise<{ file: string; hash: string; warnings: number }> {
  checkScenarioName(name);
  const hid = hiddenProblem(yaml);
  if (hid !== null) throw new EngineError('invalid', `not saved: ${hid} — a hidden character (a direction control, a zero-width or line-separator character) reads as something else than it is, and the Studio never writes one`);
  const taken = () => new EngineError('conflict', `scenario ${name} exists: choose another name (a recording never replaces a scenario)`, { fix: 'choose another name' });
  if (project.scenarios.includes(name)) throw taken();
  try {
    const r = await saveScenarioText(project, name, yaml, { ifMatch: null, agent: true, via: 'studio', scope });
    return { file: r.file, hash: r.hash, warnings: r.warnings.length };
  } catch (e) {
    if (e instanceof Error && e.name === 'ScenarioError') {
      const issues = ((e as { issues?: Array<{ severity: string; path: Array<string | number>; line?: number; message: string }> }).issues ?? []).filter((x) => x.severity === 'error');
      throw new EngineError('invalid', 'not saved: the draft does not pass the checks a scenario saved from the Studio must pass — its problems are listed by scene and step', {
        details: {
          issues: issues.map((x) => draftInvalidIssue(x, sceneIds, 'not saved')),
          untrusted: { messages: issues.slice(0, 20).map((x) => withoutPaths(x.message, [project.dir])) },
        },
      });
    }
    const err = toEngineError(e);
    if (err.code === 'conflict') throw taken();
    if (err.code === 'invalid' || err.code === 'refused') throw new EngineError(err.code, `not saved: ${withoutPaths(err.message, [project.dir])}`);
    throw new EngineError('internal', 'not saved: the scenario file could not be written');
  }
}

/** Save a finished Studio recording as scenarios/<name>.yaml — the draft the person saw, byte for byte (see the module comment). */
export async function recordSave(ctx: RecordStudioContext, project: LoadedProject, id: string, req: { name: string; rev: number; draft: string }): Promise<RecordSaved> {
  checkScenarioName(req.name);
  if (!Number.isInteger(req.rev) || req.rev < 0) throw new EngineError('invalid', 'rev must be the revision the view returned');
  if (typeof req.draft !== 'string' || !/^[0-9a-f]{64}$/.test(req.draft)) throw new EngineError('invalid', 'draft must be the draft_sha256 the view returned (the draft you saw)');
  const lock = await lockRecording(project, id, 'save');
  try {
    const s = await situation(ctx, project, id);
    requireStudio(s, 'save');
    if (s.state === 'tampered') throw new EngineError('conflict', `save: ${TAMPERED_WORDS}`);
    if (!FINAL_STATES.has(s.state)) throw new EngineError('conflict', `save: the recording is ${s.state.replace('_', ' ')} — save it once it is over`);
    const dir = await checkedFolder(project, id);
    const a = annotationsOrRefuse(s, 'save');
    checkOpen(a, 'save');
    checkRev(a, req.rev);
    const read = readRecordEvents(dir);
    if (!read.ok) throw new EngineError('refused', `save: ${read.problem}`);
    if (s.record && s.record.events_sha256 !== sha256Hex(read.bytes)) {
      throw new EngineError('conflict', 'save: the recording\'s events changed after it was drafted and checked — the draft would not be the one checked; record again');
    }
    if (!read.events.length) throw new EngineError('conflict', 'save: nothing was recorded');
    const made = draftOf(s, read.events, a);
    if ('problem' in made) throw new EngineError('refused', `save: ${made.problem}`);
    const d = made.draft;
    // The draft the person saw, or nothing (A-M1): its events, project.yaml (pages, vars) and annotations as they were.
    if (sha256Hex(d.yaml) !== req.draft) {
      throw new EngineError('conflict', 'save: the draft changed since you read it (its events, project.yaml or the arrangement): read it again, look at it, then save', { fix: 'read the recording again' });
    }
    const sceneIds = (d.scenario.scenes as Array<{ id: string }>).map((x) => x.id);
    const errors = d.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      throw new EngineError('invalid', 'not saved: the draft has errors — they are listed by scene and step', { details: { issues: errors } });
    }
    const w = await saveRecordedDraft(project, req.name, d.yaml, sceneIds, ctx.scope);
    const next: RecordAnnotations = { ...a, rev: a.rev + 1, saved: { name: req.name, file: w.file, hash: w.hash, at: new Date().toISOString() } };
    await writeAnnotations(dir, next);
    return { name: req.name, file: w.file, hash: w.hash, rev: next.rev, warnings: w.warnings, untrusted: { issues: d.issues } };
  } finally {
    lock.releaseSync();
  }
}

/** Discard a Studio recording (see the module comment). The saved scenario, if any, is never touched. */
export async function recordDiscard(ctx: RecordStudioContext, project: LoadedProject, id: string, o: { job?: string } = {}): Promise<RecordDiscarded> {
  const lock = await lockRecording(project, id, 'discard');
  try {
    const s = await situation(ctx, project, id, o.job);
    if (s.link) throw new EngineError('refused', `discard: recording ${id}: ${LINK_WORDS}`);
    if (s.state === 'missing' || s.state === 'discarded') throw new EngineError('not_found', `recording ${id} has no folder and no job (discarded, pruned, or never started)`);
    if (!s.studio) throw new EngineError('refused', `discard: ${s.unverified ? ORIGIN_WORDS : studioWords(s.startedBy)}`);
    const job = s.job;
    if (job && !FINISHED_JOB_STATES.has(job.state)) {
      // During the draft or the check a cancel stops only the check replay: the folder is marked, and removed once the
      // job is over (by the job itself, else the next view, list or operation). While the window is open (or before it
      // opens), the cancel discards it (L3.4) — marked as a discard, so the view says "discarded" (B-M5).
      const marked = s.folder && (s.state === 'draft' || s.state === 'check');
      if (marked) {
        const dir = await checkedFolder(project, id);
        const a = annotationsOrRefuse(s, 'discard');
        await writeAnnotations(dir, { ...a, discard: { at: new Date().toISOString() } });
      }
      await ctx.queue.cancel(job.id, ctx.client, marked ? undefined : 'discard');
      return { rec_id: id, state: 'discarding' };
    }
    if (!s.folder) return { rec_id: id, state: 'discarded' };
    await removeFolder(project, id);
    return { rec_id: id, state: 'discarded' };
  } finally {
    lock.releaseSync();
  }
}

/**
 * Stop and keep (see the module comment): any recording whose job runs, whoever started it. Before the window opens
 * it is a cancel — through the job's stop marker once the worker has the job, so a window that opens meanwhile is
 * stopped and kept, never discarded (B-L8).
 */
export async function recordStop(ctx: RecordStudioContext, project: LoadedProject, id: string, o: { job?: string } = {}): Promise<RecordStopped> {
  const s = await situation(ctx, project, id, o.job);
  const job = s.job;
  if (!job) {
    if (s.state === 'recording') throw new EngineError('refused', 'this recording runs in a terminal: close its window or press Ctrl-C there');
    return { action: 'none', view: await recordView(ctx, project, id, o) };
  }
  let action: RecordStopped['action'] = 'none';
  if (s.state === 'queued' || s.state === 'preflight') {
    await ctx.queue.requestStop(job.id, ctx.client);
    // Still waiting for a worker: a plain cancel (nothing can open). Taken meanwhile: the stop marker does it.
    if ((await ctx.queue.get(job.id))?.state === 'queued') await ctx.queue.cancel(job.id, ctx.client);
    action = 'cancelled';
  } else if (s.state === 'recording' && !s.cancelAsked) {
    await ctx.queue.requestStop(job.id, ctx.client);
    action = 'stopping';
  }
  return { action, view: await recordView(ctx, project, id, { job: job.id }) };
}

/**
 * The end of a Studio recording's job (B9 / B-L2, called by the job itself): a Discard asked during the draft or the
 * check marked the folder — it goes now, whether or not a Record screen is still open. True when it was removed.
 */
export async function settleDiscardAtJobEnd(project: LoadedProject, id: string): Promise<boolean> {
  const lock = await lockRecording(project, id, 'discard');
  try {
    if ((await folderState(project, id)) !== 'folder') return false;
    const a = readRecordAnnotations(join(recordsRoot(project), id));
    if (!('annotations' in a) || !a.annotations?.discard) return false;
    await removeFolder(project, id);
    return true;
  } finally {
    lock.releaseSync();
  }
}

/** A recording as the Record screen's recent list shows it (counts, enums and names: no page text, no path). */
export interface RecordListItem {
  rec_id: string;
  state: RecordState;
  /** The `record` job (null: a terminal's recording, or its job is gone). */
  job: string | null;
  started_by: JobClient | null;
  started_at: string | null;
  /** The scenario name the draft is made for. */
  name: string | null;
  env: string | null;
  persona: string | null;
  page: string | null;
  /** The URL path the window opened (under the page). */
  path: string | null;
  /** The worker's draft (record.json): its steps and the actions recorded; null before the draft. */
  steps: number | null;
  actions: number | null;
  saved: { name: string; file: string } | null;
  /** The Record screen may arrange, save or discard it (a Studio recording, not saved, not being discarded). */
  studio: boolean;
}

/** Recordings listed, at most (the records folder keeps the newest 20, and unsaved Studio ones for 7 days). */
export const RECORD_LIST_MAX = 50;

/**
 * The project's recordings, newest first (the Record screen's recent list, inside record_options): those whose job is
 * queued or running before their folder exists, then the folders of `.retake/records/` (real folders only, never
 * through a link: a records folder that is one, or leads elsewhere, lists nothing). Each one's state as the view gives
 * it, without reading its events; a Discard asked during the check whose job is over is settled here too (B-L2).
 */
export async function recordList(ctx: RecordStudioContext, project: LoadedProject, o: { limit?: number } = {}): Promise<RecordListItem[]> {
  const limit = Math.max(1, Math.min(RECORD_LIST_MAX, o.limit ?? 20));
  let names: string[] = [];
  const root = await realRecordsRoot(project);
  try {
    if (root === null) throw new Error('not a real records folder');
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && RECORD_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    names = [];
  }
  const open = (await ctx.queue.list({ project: project.slug, kinds: ['record'], states: ['queued', 'running'], limit: 10 })).flatMap((j) =>
    j.input.kind === 'record' && !names.includes(j.input.rec_id) ? [{ id: j.input.rec_id, job: j.id }] : [],
  );
  const wanted = [...open, ...names.map((id) => ({ id, job: undefined as string | undefined }))].slice(0, limit);
  const out: RecordListItem[] = [];
  for (const w of wanted) {
    const s = await situation(ctx, project, w.id, w.job);
    if (await settleDiscard(s).catch(() => false)) continue;
    if (s.state === 'missing') continue;
    const ann = 'annotations' in s.ann ? s.ann.annotations : null;
    const saved = ann?.saved ? { name: ann.saved.name, file: ann.saved.file } : s.record?.saved ? { name: s.record.saved.slice(PROJECT_DIRS.scenarios.length + 1, -'.yaml'.length), file: s.record.saved } : null;
    const input = s.job?.input.kind === 'record' ? s.job.input : null;
    out.push({
      rec_id: w.id,
      state: s.state,
      job: s.job?.id ?? null,
      started_by: s.startedBy,
      started_at: s.meta?.started_at ?? s.job?.created_at ?? null,
      name: s.meta?.name ?? input?.scenario ?? null,
      env: s.meta?.env ?? input?.env ?? null,
      persona: s.meta?.persona ?? input?.persona ?? null,
      page: s.meta?.page ?? input?.source.page ?? null,
      path: s.meta?.path ?? input?.source.path ?? null,
      steps: s.record?.steps ?? null,
      actions: s.record?.actions ?? null,
      saved,
      studio: s.studio && !saved && !ann?.discard && s.state !== 'tampered',
    });
  }
  return out;
}

/**
 * An agent (the MCP client) never cancels a recording the person started in the Studio while it is open — a cancel
 * then would discard their recording (caller.ts guardsStudioRecordings). Throws EngineError refused; anything else passes.
 */
export function checkAgentCancel(job: JobRecord, client: JobClient): void {
  if (!guardsStudioRecordings(callerOf(client))) return;
  if (job.input.kind !== 'record' || !submittedInStudio(job) || FINISHED_JOB_STATES.has(job.state)) return;
  throw new EngineError('refused', `job ${job.id} is a recording the person started in the Studio: only the Studio stops or discards it (job_cancel would discard their recording)`);
}

/** Is `live` one of the states where the window may still be open or the draft still change? */
export function recordLive(state: RecordState): boolean {
  return LIVE_STATES.has(state);
}
