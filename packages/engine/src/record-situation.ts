/** Where a recording stands for the Record screen (record-studio.ts): its folder, its job and who started it. */
import type { VersionLedger } from './version-ledger.js';
import type { LoadedProject } from '@retake/core/project';
import type { WorkFileFacts } from '@retake/core/model';
import { emptyRecordAnnotations } from '@retake/core/run';
import type { RecordAnnotations } from '@retake/core/run';
import type { JobClient } from './jobs/job-input.js';
import { submittedInStudio } from './caller.js';
import { EngineError } from './errors.js';
import { isAlive } from './jobs/proc.js';
import type { JobQueueView } from './jobs/job-queue.js';
import type { JobRecord } from './jobs/types.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import { recordDir } from './record.js';
import { readRecordAnnotations, readRecordMeta } from './record-files.js';
import type { RecordMeta } from './record-files.js';
import type { StoreScope } from './store/store.js';
import type { WorkspaceReads } from './workspace-reads/reads.js';
import { LINK_WORDS, ORIGIN_WORDS, folderState, jobOf, lockRecording, readRecordJson, removeFolder } from './record-folder.js';
import type { RecordJson } from './record-folder.js';

/**
 * Where a recording stands. queued / preflight (no window yet) → recording (the window is open) → draft → check →
 * done (record.json written); interrupted: the worker (or the terminal) stopped while the window was open — the events
 * kept, no draft made; tampered: a Studio recording whose files were changed after its job wrote them (record.json
 * gone from a finished job, or without its events checksum) — it cannot be verified, read-only; nothing_recorded: it
 * ended with no action (no folder); failed / cancelled: the job's error; discarded: removed from the Studio (an open
 * window discarded too); missing: no folder and no job.
 */
export type RecordState = 'queued' | 'preflight' | 'recording' | 'draft' | 'check' | 'done' | 'interrupted' | 'tampered' | 'nothing_recorded' | 'failed' | 'cancelled' | 'discarded' | 'missing';

export const ANNOTATE_STATES: ReadonlySet<RecordState> = new Set(['recording', 'draft', 'check', 'done', 'interrupted']);
export const FINAL_STATES: ReadonlySet<RecordState> = new Set(['done', 'interrupted']);

export interface RecordStudioContext {
  queue: JobQueueView;
  client: JobClient;
  /** Where a saved draft is written and journaled (the engine's caller); its clock stamps a Save and a Discard. */
  scope: StoreScope;
  /** How a draft's files are looked at (core FileFacts): the engine's, under its workspace's policy. */
  files: WorkFileFacts;
  /** What the project's theme and a saved draft's checks read the workspace by (its WorkspaceReads). */
  reads: WorkspaceReads;
  /** The engine's ledger of the scenario versions it showed or wrote. */
  seen: VersionLedger;
}

export interface Situation {
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

export async function situation(ctx: RecordStudioContext, project: LoadedProject, id: string, hint?: string): Promise<Situation> {
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
  // Who started it: a Studio recording only when its job — the one meta.json names — says so too.
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
    // Fail closed: a Studio recording's record.json must hold the events checksum, and a job that ended well
    // wrote one — a missing or spoiled one is tampered (never "done" or "interrupted", which Save accepts).
    if (record) state = studio && record.events_sha256 === null ? 'tampered' : 'done';
    else if (job) state = job.state === 'failed' ? 'failed' : job.state === 'cancelled' ? 'cancelled' : job.state === 'succeeded' && studio ? 'tampered' : 'interrupted';
    else if (meta && meta.job_id === null && (await isAlive(meta.owner))) state = 'recording';
    else state = 'interrupted';
  } else if (job) {
    // A job that ended well though it was cancelled: the cancel came during the draft or the check (a Discard), and
    // the folder is gone since — discarded (not "nothing recorded"); a cancel that was the Studio's Discard of the open
    // window: discarded too (not "cancelled").
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

/**
 * A discard asked during the draft or the check: once the job is over, the folder goes (the job removes it itself;
 * this catches a Discard that came as the job ended, from a view or the recent list). A read removes a folder here — on
 * purpose: only a Studio recording whose job is verified and marked, which an agent could remove anyway.
 */
export async function settleDiscard(s: Situation): Promise<boolean> {
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

export const studioWords = (by: JobClient | null) =>
  by === 'mcp'
    ? 'Claude started this recording (its job saved the draft): it is read-only here'
    : by === 'cli'
      ? 'this recording was made in a terminal: it is read-only here'
      : 'this recording was not started from the Studio: it is read-only here';

/** A Studio recording, or a refusal (annotate, save and discard are the person's, from the Studio). */
export function requireStudio(s: Situation, what: string): RecordMeta {
  if (s.link) throw new EngineError('refused', `${what}: ${LINK_WORDS}`);
  if (s.unverified) throw new EngineError('refused', `${what}: ${ORIGIN_WORDS}`);
  if (!s.studio) throw new EngineError('refused', `${what}: ${studioWords(s.startedBy)}`);
  if (!s.meta) throw new EngineError('refused', `${what}: the recording's meta.json is missing or not valid — it is read-only here`);
  return s.meta;
}

export function annotationsOrRefuse(s: Situation, what: string): RecordAnnotations {
  if ('problem' in s.ann) throw new EngineError('invalid', `${what}: ${s.ann.problem}`);
  return s.ann.annotations ?? emptyRecordAnnotations();
}

export function checkOpen(a: RecordAnnotations, what: string): void {
  if (a.saved) throw new EngineError('conflict', `${what}: the recording was saved as scenario ${a.saved.name} — change the scenario itself now`);
  if (a.discard) throw new EngineError('conflict', `${what}: the recording is being discarded`);
}

export function checkRev(a: RecordAnnotations, rev: number): void {
  if (rev !== a.rev) {
    throw new EngineError('conflict', `the recording changed since it was read (revision ${a.rev}, not ${rev}): read it again`, { details: { current: a.rev }, fix: `rev: ${a.rev}` });
  }
}
