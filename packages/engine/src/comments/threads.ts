/** Creating a thread and appending entries to it: reply, resolve, reopen (see ../comments.ts). */
import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { COMMENTS_DIR, SLUG_RE } from '@retake/core/model';
import { renderIdOf } from '@retake/core/ids';
import { projectPath, projectRef } from '@retake/core/project';
import {
  COMMENT_ENTRIES_MAX,
  COMMENT_THREAD_VERSION,
  CommentThreadSchema,
  deriveStatus,
  isIsoUtcDate,
  locateAnchorStep,
  newCommentEntryId,
  newCommentId,
  regionProblem,
  trustedAnchor,
} from '@retake/core/comments';
import { latestProjectRender } from '@retake/core/render';
import type { FrameCommentAnchor, LoadedProject, Timeline, ValidationIssue } from '@retake/core/model';
import type { RenderVariant } from '@retake/core/ids';
import type { CommentAuthor, CommentEntry, CommentRegion, CommentThread } from '@retake/core/comments';
import type { ProjectRender, RenderLatestPick } from '@retake/core/render';
import type { ComponentRegistry } from '@retake/components';
import { EngineError } from '../errors.js';
import { toolDir } from '../project-lock.js';
import { checkRunId, checkScenarioName } from '../refs.js';
import { buildProposal } from '../comment-proposals.js';
import type { ProposalInput } from '../comment-proposals.js';
import { latestRenderMembers, renderEntries } from '../render-records.js';
import type { LatestRenderNotice, PassedOverRenders } from '../render-records.js';
import { renderForWork } from '../renders.js';
import type { RenderForWork } from '../renders.js';
import { storeOf } from '../store/store.js';
import type { StoreScope } from '../store/store.js';
import { stampOf } from '../clock.js';
import {
  RUN_FILE_MAX_BYTES,
  appendedThread,
  argError,
  caseVariantFolder,
  checkIfMatch,
  cleanText,
  commentRef,
  commentStillFile,
  locateThread,
  lockThread,
  readPlainFile,
  readThread,
} from './store.js';
import { frameAnchor } from '@retake/review/checks';
import type { FrameTools } from '../review/reviewer.js';
import type { ThreadFile } from './store.js';
import { recordShapeOk, renderIndex, threadView, timecodeOf, todayText } from './views.js';
import type { CommentView } from './views.js';
import type { WorkFileFacts } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import { parseTimeline } from '@retake/core/run';

// ── Creating a thread ───────────────────────────────────────────────────────

/** Where a new thread points: a render (as the caller saw it) and one of its frames, optionally a region. */
export interface CommentPrepareRequest {
  /** A render id, or `latest` (of `scenario`). */
  render: string;
  scenario?: string;
  /**
   * The render record's `created_at` as the caller saw it (L4.6: the Studio sends what it showed): a render id reused
   * since (renders/ cleaned, rendered again) is a conflict, never the other render's frame.
   */
  render_created_at?: string;
  /**
   * Exactly one of: an output frame, a time (seconds: the frame on screen at that time, floor(t × fps); the duration as
   * printed, rounded to 1/100 s, is the last frame), a marker (its `done` frame, else its start; a name marking several
   * steps is refused: pick the frame).
   */
  frame?: number;
  at_s?: number;
  marker?: string;
  region?: CommentRegion;
}

export interface CommentAddRequest extends CommentPrepareRequest {
  text: string;
}

export interface CommentAdded {
  thread: CommentView;
  warnings: string[];
}

/** The frame a request names (0 ≤ frame < frames). */
export function pickFrame(req: CommentPrepareRequest, record: RenderForWork): number {
  const frames = Math.min(record.frames, record.plan.durationInFrames);
  const given = [req.frame !== undefined, req.at_s !== undefined, req.marker !== undefined].filter(Boolean).length;
  if (given !== 1) throw argError('frame', 'name the frame with exactly one of frame, at (seconds) or marker');
  let frame: number;
  if (req.frame !== undefined) {
    if (!Number.isInteger(req.frame) || req.frame < 0) throw argError('frame', `frame ${String(req.frame)}: a frame number from 0`);
    frame = req.frame;
  } else if (req.at_s !== undefined) {
    if (typeof req.at_s !== 'number' || !Number.isFinite(req.at_s) || req.at_s < 0) throw argError('frame', `at ${String(req.at_s)}: seconds from 0`);
    // The frame on screen at that time (1e-6: 0.7 s × 30 is 20.999… in floating point); the end — the duration, exact
    // or as printed (rounded to 1/100 s: it may lie a little past the end) — is the last frame.
    frame = Math.floor(req.at_s * record.fps + 1e-6);
    const duration = frames / record.fps;
    if (frame >= frames && req.at_s <= Math.max(duration, Number(duration.toFixed(2))) + 1e-9) frame = frames - 1;
  } else {
    const name = req.marker as string;
    if (typeof name !== 'string' || !SLUG_RE.test(name)) throw argError('frame', `marker "${String(name).slice(0, 80)}": a marker name`);
    const marked = record.plan.markers.filter((x) => x.name === name);
    if (marked.length === 0) {
      const names = [...new Set(record.plan.markers.map((x) => x.name).filter((n) => SLUG_RE.test(n)))];
      throw argError('frame', `render ${record.id} has no marker "${name}"${names.length ? ` (its markers: ${names.join(', ')})` : ' (it has no marker)'}`);
    }
    if (marked.length > 1) {
      const at = marked.map((x) => Math.min(x.done ?? x.frame, frames - 1));
      throw argError('frame', `render ${record.id} has ${marked.length} markers named "${name}" (frames ${at.join(', ')}): name the frame with frame (or at)`);
    }
    frame = Math.min(marked[0].done ?? marked[0].frame, frames - 1);
  }
  if (frame >= frames) throw argError('frame', `frame ${frame} is past the end of render ${record.id} (frames 0..${frames - 1}, ${(frames / record.fps).toFixed(2)} s)`);
  return frame;
}

/** The run's scenario snapshot and (for a plan whose markers carry no step: before L3.6) its timeline, by run id. */
export async function runInputs(projectDir: string, record: RenderForWork, warnings: string[]): Promise<{ scenarioText?: string; timeline?: Pick<Timeline, 'markers' | 'events'> }> {
  const runDir = projectPath(projectDir, 'runs', checkRunId(record.run_id));
  const out: { scenarioText?: string; timeline?: Pick<Timeline, 'markers' | 'events'> } = {};
  const yaml = await readPlainFile(join(runDir, 'scenario.yaml'), RUN_FILE_MAX_BYTES);
  if (yaml) out.scenarioText = yaml.toString('utf8');
  else warnings.push(`${projectRef('runs', record.run_id, 'scenario.yaml')} is missing: the anchor has no step fingerprint`);
  if (record.plan.markers.some((m) => m.step === undefined)) {
    const tl = await readPlainFile(join(runDir, 'timeline.json'), RUN_FILE_MAX_BYTES);
    try {
      // The bytes within this file's own cap; what they are is the one parse boundary's to say (core parseTimeline).
      const t = tl ? parseTimeline(JSON.parse(tl.toString('utf8'))) : undefined;
      if (t?.ok) out.timeline = { markers: t.value.markers, events: t.value.events };
    } catch {
      /* no timeline: markers name no step */
    }
  }
  return out;
}

/**
 * Make the still of a new thread with the reviewer's frames (temp + rename in a real folder of the project); null and a
 * warning when it fails.
 */
export async function writeStill(
  projectDir: string,
  id: string,
  video: string,
  frame: number,
  region: CommentRegion | undefined,
  warnings: string[],
  policy: WorkPolicy,
  frames: Pick<FrameTools, 'still'>,
): Promise<string | null> {
  const final = commentStillFile(projectDir, id);
  const tmp = join(dirname(final), `${id}.${randomBytes(4).toString('hex')}.tmp.jpg`);
  try {
    await toolDir(projectDir, 'comments');
    await frames.still(video, frame, tmp, { policy, ...(region ? { region } : {}) });
    await rename(tmp, final);
    return final;
  } catch (e) {
    warnings.push(`no still for comment ${id}: ${(e as Error).message.split('\n')[0]}`);
    return null;
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** A new thread's render, frame and anchor, computed and checked — everything `addComment` does before the write. */
export interface PreparedComment {
  record: RenderForWork & { variant: RenderVariant };
  frame: number;
  anchor: FrameCommentAnchor;
  warnings: string[];
}

/**
 * The render read by id (`renderForWork`: a succeeded render whose files lie in the project; its id, scenario,
 * created_at and variant of the tool's shape; `render_created_at`, when given, its record's), the frame picked, the
 * anchor computed from the render's plan and the run's scenario snapshot (review frameAnchor). The one code path of
 * `addComment` and of the Studio's anchor chips (`anchorAt`, R-UI-27): the chips shown are the anchor stored.
 */
export async function prepareComment(project: LoadedProject, req: CommentPrepareRequest): Promise<PreparedComment> {
  if (req.region !== undefined) {
    const p = regionProblem(req.region);
    if (p) throw argError('region', p);
  }
  if (req.scenario !== undefined) checkScenarioName(req.scenario);
  if (req.render_created_at !== undefined && !isIsoUtcDate(req.render_created_at)) {
    throw argError('render_created_at', 'render_created_at is the created_at of the render record as read (an ISO 8601 UTC date)');
  }
  const record = await renderForWork(project, req.render, req.scenario !== undefined ? { scenario: req.scenario } : {});
  if (req.scenario !== undefined && record.scenario !== req.scenario) throw argError('render', `render ${record.id} is a render of ${record.scenario}, not of ${req.scenario}`);
  if (renderIdOf(record.id, record.scenario) === null) {
    throw new EngineError('invalid', `render ${record.id} has no <scenario>-v<N> id (written with --out?): only renders of renders/ take comments`);
  }
  if (!recordShapeOk(record)) throw new EngineError('refused', `${projectRef('renders', `${record.id}.json`)} has a scenario, created_at or variant the tool never writes: not used`);
  if (req.render_created_at !== undefined && req.render_created_at !== record.created_at) {
    throw new EngineError('conflict', `render ${record.id} was replaced since it was read (another render now has its id): read the renders again`, {
      details: { current: record.created_at },
      fix: `read the renders again (render ${record.id} is now the one made ${record.created_at})`,
    });
  }
  const frame = pickFrame(req, record);
  const warnings: string[] = [];
  const inputs = await runInputs(project.dir, record, warnings);
  let anchor: FrameCommentAnchor;
  try {
    anchor = frameAnchor(record.plan, frame, { ...(req.region ? { region: req.region } : {}), ...inputs });
  } catch (e) {
    if (e instanceof RangeError) throw argError('frame', e.message);
    throw e;
  }
  return { record, frame, anchor, warnings };
}

/** What the Studio shows before a comment is posted (R-UI-27): a frame of a render and a region, never a text. */
export interface CommentAnchorRequest {
  render: string;
  /** Required: the anchor is of the render the page shows. */
  render_created_at: string;
  frame: number;
  region?: CommentRegion;
}

export interface CommentAnchorView {
  project: string;
  scenario: string;
  render_id: string;
  render_created_at: string;
  variant: CommentThread['render']['variant'];
  frame: number;
  time_s: number;
  timecode: string;
  region?: CommentRegion;
  /** Pattern-checked (core trustedAnchor), as a thread view shows it. */
  anchor: FrameCommentAnchor;
  /** The anchored step in today's scenario file (as CommentView.step_now). */
  step_now?: string | null;
  warnings: string[];
  untrusted?: { anchor?: Record<string, unknown> };
}

/** The anchor a comment on that frame would store (prepareComment: the same code as addComment), and where its step is today. */
export async function anchorAt(project: LoadedProject, req: CommentAnchorRequest): Promise<CommentAnchorView> {
  if (req.render_created_at === undefined || req.render_created_at === null) throw argError('render_created_at', 'render_created_at is required: the created_at of the render shown');
  if (typeof req.frame !== 'number') throw argError('frame', 'frame is an output frame number of the render');
  const p = await prepareComment(project, { render: req.render, render_created_at: req.render_created_at, frame: req.frame, ...(req.region ? { region: req.region } : {}) });
  const { anchor, untrusted: badAnchor } = trustedAnchor(p.anchor);
  let stepNow: string | null | undefined;
  if (anchor.scene !== undefined && anchor.step !== undefined) {
    const today = await todayText(project.dir, p.record.scenario, new Map());
    stepNow = today === null ? null : (locateAnchorStep(today.text, anchor) ?? null);
  }
  const time_s = Math.round((p.frame / p.record.fps) * 1000) / 1000;
  return {
    project: project.slug,
    scenario: p.record.scenario,
    render_id: p.record.id,
    render_created_at: p.record.created_at,
    variant: p.record.variant,
    frame: p.frame,
    time_s,
    timecode: timecodeOf(time_s),
    ...(req.region ? { region: { x: req.region.x, y: req.region.y, w: req.region.w, h: req.region.h } } : {}),
    anchor,
    ...(stepNow !== undefined ? { step_now: stepNow } : {}),
    warnings: p.warnings,
    ...(badAnchor ? { untrusted: { anchor: badAnchor } } : {}),
  };
}

/**
 * A new thread on one frame of a render (the CLI and the Studio): prepareComment, then the thread created whole (never
 * over an existing file), then its still (critique B12: the thread exists whatever the still costs; a still that fails
 * is a warning; it is made by `frames`, the caller's reviewer's).
 */
export async function addComment(
  project: LoadedProject,
  req: CommentAddRequest,
  author: CommentAuthor,
  scope: StoreScope,
  policy: WorkPolicy,
  frames: Pick<FrameTools, 'still'>,
): Promise<CommentAdded> {
  const text = cleanText(req.text, 'the comment', 'text');
  const { record, frame, anchor, warnings } = await prepareComment(project, req);
  const clash = await caseVariantFolder(project.dir, record.scenario);
  if (clash) {
    throw new EngineError('refused', `${COMMENTS_DIR}/${clash}/ differs from ${record.scenario} only by case: a case-insensitive disk would write the thread there`, {
      fix: `rename ${COMMENTS_DIR}/${clash}/ to ${COMMENTS_DIR}/${record.scenario}/ (or remove it), then comment again`,
    });
  }
  const id = newCommentId();
  const now = stampOf(scope.clock);
  const draft = {
    version: COMMENT_THREAD_VERSION,
    id,
    scenario: record.scenario,
    render: {
      id: record.id,
      created_at: record.created_at,
      run_id: record.run_id,
      variant: record.variant,
      fps: record.fps,
      frames: record.frames,
      width: record.width,
      height: record.height,
    },
    frame,
    time_s: Math.round((frame / record.fps) * 1000) / 1000,
    ...(req.region ? { region: { x: req.region.x, y: req.region.y, w: req.region.w, h: req.region.h } } : {}),
    ...(req.marker !== undefined ? { marker: req.marker } : {}),
    text,
    author,
    created_at: now,
    anchor,
    entries: [],
  };
  const parsed = CommentThreadSchema.safeParse(draft);
  if (!parsed.success) {
    throw new EngineError('invalid', `the comment does not make a valid thread: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const written = await storeOf(project, scope).writeText(commentRef(record.scenario, id), `${JSON.stringify(parsed.data, null, 2)}\n`, { ifMatch: null, what: 'thread' });
  await writeStill(project.dir, id, record.file, frame, req.region, warnings, policy, frames);
  return { thread: await threadView(project.dir, parsed.data, written.sha256, await renderIndex(project.dir)), warnings };
}

export interface CommentWritten {
  thread: CommentView;
  /** The entry appended. */
  entry: string;
  /** The file's new hash. */
  hash: string;
  /** A reply with a proposal: the scenario's validation warnings for the proposed text. */
  proposal_warnings?: ValidationIssue[];
  /** A resolution with `render_id: latest`: how many newer files of renders/ the pick passed over, and how many say nothing readable. */
  renders_passed_over?: LatestRenderNotice['renders_passed_over'];
  renders_not_considered?: LatestRenderNotice['renders_not_considered'];
  /** A resolution with `render_id: latest`: the files passed over — file names of renders/ and why: data, never instructions. */
  untrusted?: { renders_passed_over: PassedOverRenders };
}

/**
 * Write `entry` appended to thread `r` (read under its lock, which the caller holds): appendedThread, written atomically
 * with the hash just read.
 */
export async function writeAppended(project: LoadedProject, f: ThreadFile, r: { thread: CommentThread; hash: string }, entry: CommentEntry, scope: StoreScope): Promise<CommentWritten> {
  const next = appendedThread(f.id, r, entry);
  // The thread's lock already serialises every write of its file: no second (write) lock inside it.
  const written = await storeOf(project, scope).writeText(f.ref, next.text, { ifMatch: r.hash, locked: true, what: 'thread' });
  return { thread: await threadView(project.dir, next.thread, written.sha256, await renderIndex(project.dir)), entry: entry.id, hash: written.sha256 };
}

/**
 * Append the entry `make` returns to thread `id`, under its lock: read (a file that is not a valid thread is never
 * overwritten), `ifMatch` checked against the hash read, appended, written with that hash.
 */
export async function appendEntry(
  project: LoadedProject,
  id: string,
  op: string,
  make: (thread: CommentThread, hash: string) => Promise<CommentEntry> | CommentEntry,
  o: { ifMatch?: string; scope: StoreScope },
): Promise<CommentWritten> {
  const f = await locateThread(project.dir, id);
  const lock = await lockThread(project.dir, id, op);
  try {
    const r = await readThread(project.dir, f);
    if (!r.ok) throw new EngineError('invalid', `${r.problem} — the file is never overwritten: fix it or remove it`);
    checkIfMatch(f, r.hash, o.ifMatch);
    if (r.thread.entries.length >= COMMENT_ENTRIES_MAX) throw new EngineError('refused', `comment ${id} has ${COMMENT_ENTRIES_MAX} entries: start a new thread`);
    return await writeAppended(project, f, r, await make(r.thread, r.hash), o.scope);
  } finally {
    lock.releaseSync();
  }
}

/**
 * A reply on a thread (open or resolved). With `proposal` (L4.6, MCP only — Engine.comments refuses it from any other
 * client): Claude's whole new text of the thread's own scenario file and the hash it read, checked as the Studio would
 * check it at Apply (comment-proposals.ts buildProposal) and stored as the canonical line diff — on an open thread only.
 */
export async function replyComment(
  project: LoadedProject,
  id: string,
  rawText: string,
  author: CommentAuthor,
  o: { proposal?: ProposalInput; registry?: () => Promise<ComponentRegistry>; scope: StoreScope; files: WorkFileFacts },
): Promise<CommentWritten> {
  const text = cleanText(rawText, 'the reply', 'text');
  const write = { scope: o.scope };
  if (o.proposal === undefined) {
    return appendEntry(project, id, 'reply', () => ({ id: newCommentEntryId(), kind: 'reply', author, text, created_at: stampOf(o.scope.clock) }), write);
  }
  // The target is the thread's own scenario (its folder, checked against the file by readThread): never an argument.
  const f = await locateThread(project.dir, id);
  const built = await buildProposal(project, f.scenario, o.proposal, { files: o.files, ...(o.registry ? { registry: o.registry } : {}) });
  const w = await appendEntry(
    project,
    id,
    'reply',
    (thread) => {
      const { status } = deriveStatus(thread.entries);
      if (status !== 'open') throw new EngineError('conflict', `not proposed: comment ${id} is resolved — a proposal answers an open thread (a person reopens it)`, { details: { status } });
      return { id: newCommentEntryId(), kind: 'reply', author, text, created_at: stampOf(o.scope.clock), proposal: built.proposal };
    },
    write,
  );
  return { ...w, proposal_warnings: built.warnings };
}

export interface CommentResolveRequest {
  /** What was changed (required). */
  note: string;
  /** The render that answers it: a later succeeded render of the same scenario and variant (an id, or `latest`: the newest of both). */
  render_id?: string;
  /** The thread's hash as last read: refused (conflict) when it changed since. */
  ifMatch?: string;
}

/** Resolve an open thread, optionally naming the render that answers it (stored with its `created_at`). */
export async function resolveComment(project: LoadedProject, id: string, req: CommentResolveRequest, author: CommentAuthor, o: { scope: StoreScope }): Promise<CommentWritten> {
  const note = cleanText(req.note, 'the note', 'note');
  if (req.ifMatch !== undefined && (typeof req.ifMatch !== 'string' || !/^[0-9a-f]{64}$/.test(req.ifMatch))) throw argError('if_match', 'if_match is the hash a listing returned (64 hex characters)');
  const f = await locateThread(project.dir, id);
  let answer: RenderForWork | undefined;
  let latest: RenderLatestPick<ProjectRender> | undefined;
  if (req.render_id !== undefined) {
    let renderId = req.render_id;
    if (renderId === 'latest') {
      // The newest finished render of the thread's scenario and variant (a vertical cut does not answer a landscape frame).
      const r = await readThread(project.dir, f);
      if (!r.ok) throw new EngineError('invalid', r.problem);
      const variant = r.thread.render.variant;
      latest = latestProjectRender(await renderEntries(project.dir), { scenario: f.scenario, variant, status: 'succeeded', quotable: true });
      const last = latest.pick;
      if (!last) throw new EngineError('not_found', `no finished ${variant} render of ${f.scenario} yet: render makes one`);
      renderId = last.id;
    }
    answer = await renderForWork(project, renderId, { scenario: f.scenario });
    if (!recordShapeOk(answer)) throw new EngineError('refused', `${projectRef('renders', `${answer.id}.json`)} has a scenario, created_at or variant the tool never writes: not used`);
  }
  const written = await appendEntry(
    project,
    id,
    'resolve',
    (thread) => {
      const { status, resolution } = deriveStatus(thread.entries);
      if (status === 'resolved') {
        throw new EngineError(
          'conflict',
          `comment ${id} is already resolved (entry ${resolution?.entry}${resolution?.render_id ? `, render ${resolution.render_id}` : ''}): it is reopened by a person (retake comment reopen)`,
          {
            details: { status, ...(resolution ? { entry: resolution.entry } : {}) },
          },
        );
      }
      if (answer) {
        if (answer.scenario !== thread.scenario)
          throw new EngineError('refused', `render ${answer.id} is a render of ${answer.scenario}: a comment on ${thread.scenario} is resolved by a render of ${thread.scenario}`);
        if (answer.variant !== thread.render.variant) {
          throw new EngineError(
            'refused',
            `render ${answer.id} is a ${answer.variant} render: a comment on the ${thread.render.variant} render ${thread.render.id} is resolved by a ${thread.render.variant} render of ${thread.scenario}`,
          );
        }
        if (!(answer.created_at > thread.render.created_at)) {
          throw new EngineError(
            'refused',
            `render ${answer.id} (${answer.created_at}) is not later than the commented render ${thread.render.id} (${thread.render.created_at}): resolve with the render made after the change`,
          );
        }
      }
      return {
        id: newCommentEntryId(),
        kind: 'resolve',
        author,
        text: note,
        created_at: stampOf(o.scope.clock),
        ...(answer ? { render_id: answer.id, render_created_at: answer.created_at } : {}),
      };
    },
    { ...(req.ifMatch !== undefined ? { ifMatch: req.ifMatch } : {}), scope: o.scope },
  );
  // What `latest` passed over on the way to the render that answers (none for a render named by its id).
  return { ...written, ...latestRenderMembers(latest) };
}

/**
 * Reopen a resolved thread (a person disagreeing with its resolution); the note may be empty. `ifMatch`: the thread's
 * hash as last read (the Studio reopens the version it showed; refused as a conflict when it changed since).
 */
export async function reopenComment(project: LoadedProject, id: string, rawNote: string | undefined, author: CommentAuthor, o: { ifMatch?: string; scope: StoreScope }): Promise<CommentWritten> {
  const note = cleanText(rawNote ?? '', 'the note', 'note', false);
  if (o.ifMatch !== undefined && (typeof o.ifMatch !== 'string' || !/^[0-9a-f]{64}$/.test(o.ifMatch))) throw argError('if_match', 'if_match is the hash a listing returned (64 hex characters)');
  return appendEntry(
    project,
    id,
    'reopen',
    (thread) => {
      if (deriveStatus(thread.entries).status !== 'resolved') throw new EngineError('conflict', `comment ${id} is open: only a resolved thread is reopened`, { details: { status: 'open' } });
      return { id: newCommentEntryId(), kind: 'reopen', author, text: note, created_at: stampOf(o.scope.clock) };
    },
    { ...(o.ifMatch !== undefined ? { ifMatch: o.ifMatch } : {}), scope: o.scope },
  );
}
