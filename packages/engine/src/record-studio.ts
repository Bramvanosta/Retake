/**
 * The Studio's side of a recording (R-UI-20 / 21 / 22): the Record screen is the control panel of the headed
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
 *   goes after the newest event read under the lock (a visit to the Studio commits the typing in progress, after the
 *   screen's last poll). studio.json is read without following a link and replaced by a rename.
 * - save: the draft made again from the events file (refused when it is not the one the worker drafted and checked:
 *   record.json's events_sha256, B8 — fail closed: a record.json without a valid one, or a finished job without its
 *   record.json, is `tampered`) with the annotations, validated with the project; refused unless it is byte for byte
 *   the draft the person saw (`draft`: the view's draft_sha256 — an events line, a project.yaml var or an annotation
 *   changed since is a conflict); a hidden character anywhere refused again; then a NEW scenarios/<name>.yaml only (a
 *   taken name is a conflict, never an overwrite) under agent trust (`via: 'studio'`). Errors are fixed words located
 *   by scene and step; the validator's text sits under `untrusted`, paths removed.
 * - discard: an open window is cancelled (the worker removes the folder; the view says "discarded"); during the
 *   draft or the check the folder is marked and removed once the job is over (by the job itself, else by the next
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
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bestEffort } from '@retake/core/base';
import { RECORD_ID_RE } from '@retake/core/ids';
import { PROJECT_DIRS } from '@retake/core/project';
import { RecordAnnotationChangeSchema, applyRecordChange } from '@retake/core/run';
import type { LoadedProject } from '@retake/core/project';
import type { RecordAnnotationChange } from '@retake/core/run';
import type { JobClient } from './jobs/job-input.js';
import { stampOf } from './clock.js';
import { callerOf, drivesRecordScreen, guardsStudioRecordings, submittedInStudio } from './caller.js';
import type { Caller } from './caller.js';
import { EngineError } from './errors.js';
import type { JobRecord } from './jobs/types.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import { recordsRoot } from './record.js';
import { readRecordAnnotations } from './record-files.js';
import { LINK_WORDS, ORIGIN_WORDS, checkedFolder, folderState, lockRecording, readRecordEvents, realRecordsRoot, removeFolder, writeAnnotations } from './record-folder.js';
import { ANNOTATE_STATES, annotationsOrRefuse, checkOpen, checkRev, requireStudio, settleDiscard, situation, studioWords } from './record-situation.js';
import type { RecordState, RecordStudioContext } from './record-situation.js';
import { recordView, zoomOf } from './record-view.js';
import type { RecordView } from './record-view.js';

export { RECORD_EVENTS_MAX_BYTES, readRecordEvents } from './record-folder.js';
export type { RecordState, RecordStudioContext } from './record-situation.js';
export { recordView } from './record-view.js';
export type { RecordCheckView, RecordTargetOption, RecordView, RecordZoomView } from './record-view.js';
export { recordSave, saveRecordedDraft } from './record-save.js';
export type { RecordSaved } from './record-save.js';

export interface RecordAnnotated {
  rev: number;
  /** The insert's id (an insert change). */
  insert_id?: string;
  view: RecordView;
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

/** One change to a Studio recording's annotations, under its lock and its revision (see the module comment). */
export async function recordAnnotate(ctx: RecordStudioContext, project: LoadedProject, id: string, req: { rev: number; change: RecordAnnotationChange }): Promise<RecordAnnotated> {
  const parsed = RecordAnnotationChangeSchema.safeParse(req.change);
  if (!parsed.success) throw new EngineError('invalid', `invalid change: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(change)'}: ${i.message}`).join('; ')}`);
  if (!Number.isInteger(req.rev) || req.rev < 0) throw new EngineError('invalid', 'rev must be the revision the view returned');
  const change = parsed.data;
  if (change.op === 'insert' && change.insert.kind === 'camera') {
    // A factor above the project theme's max_zoom is clamped by the editor and warned by the validator.
    const zoom = await zoomOf(project, ctx);
    if (!zoom || change.insert.zoom > zoom.max) {
      throw new EngineError(
        'invalid',
        `annotate: zoom ${change.insert.zoom} is above the project theme's max_zoom (${zoom ? zoom.max : 'no zoom'}): choose ${zoom ? zoom.options.join(', ') : 'no zoom'}`,
      );
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
    // Read now, under the lock: "at the end" is the newest event in the file at this moment.
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
      // opens), the cancel discards it — marked as a discard, so the view says "discarded".
      const marked = s.folder && (s.state === 'draft' || s.state === 'check');
      if (marked) {
        const dir = await checkedFolder(project, id);
        const a = annotationsOrRefuse(s, 'discard');
        await writeAnnotations(dir, { ...a, discard: { at: stampOf(ctx.scope.clock) } });
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
 * stopped and kept, never discarded.
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
 * The end of a Studio recording's job (called by the job itself): a Discard asked during the draft or the
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

/**
 * The Record screen's operations (a recording's view, annotations, stop, discard, save and the recent list) are the
 * Studio's and tests' (caller.ts drivesRecordScreen): any other caller's refusal, worded for its channel, else
 * undefined. The operations' `callers` (operations/record.ts) and the façade (record-api.ts) refuse with it.
 */
export function recordScreenRefused(caller: Caller, what: string): EngineError | undefined {
  if (drivesRecordScreen(caller)) return undefined;
  return new EngineError(
    'refused',
    `${what} is the Studio's (its Record screen): ${caller.channel === 'cli' ? 'retake record records in a terminal' : 'scenario_record starts a recording and job_status reads its draft'}`,
  );
}

/** Recordings listed, at most (the records folder keeps the newest 20, and unsaved Studio ones for 7 days). */
export const RECORD_LIST_MAX = 50;

/**
 * The project's recordings, newest first (the Record screen's recent list, inside record_options): those whose job is
 * queued or running before their folder exists, then the folders of `.retake/records/` (real folders only, never
 * through a link: a records folder that is one, or leads elsewhere, lists nothing). Each one's state as the view gives
 * it, without reading its events; a Discard asked during the check whose job is over is settled here too.
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
    if (await bestEffort(settleDiscard(s), 'a discard that cannot settle now is settled on the next listing', false)) continue;
    if (s.state === 'missing') continue;
    const ann = 'annotations' in s.ann ? s.ann.annotations : null;
    const saved = ann?.saved
      ? { name: ann.saved.name, file: ann.saved.file }
      : s.record?.saved
        ? { name: s.record.saved.slice(PROJECT_DIRS.scenarios.length + 1, -'.yaml'.length), file: s.record.saved }
        : null;
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
