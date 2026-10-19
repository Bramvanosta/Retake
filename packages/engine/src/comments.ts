/**
 * The frame comment store (L3.6, R-CMT-02..05, ADR-1 #4): thread files `<project>/comments/<scenario>/<id>.json` (core
 * CommentThreadSchema), their stills `<project>/.demo-studio/comments/<id>.jpg` (machine-local: product frames never
 * enter git), and the views clients read.
 *
 * Writes: a thread is created whole (a link: never over an existing file); an entry is appended under the thread's lock
 * (`<project>/.demo-studio/locks/comment-<id>.lock`, the sandbox package's TakeLock: created whole, stale only when its
 * process is gone — never by age —, retried while busy), read → checked → appended → written atomically (temp + rename)
 * with the hash just read, so `ifMatch` (comment_resolve's if_match) is checked inside the lock. A file that does not
 * read as a thread is never overwritten.
 *
 * Reads: only `c_<ULID>.json` files of scenario folders (temp files, other names and symbolic links skipped; a link or
 * a broken file is reported by name), the file name equal to the thread id and the folder to its scenario. Paths are
 * rebuilt from ids, never taken from a file. A view keeps every free text (comment, entries, notes, author names, an
 * anchor value of an unknown shape) under `untrusted`; the status is derived from the entries.
 *
 * Trust: who wrote an entry is the channel (`author.via`), set by the caller — the CLI (`cli`) or the engine for its
 * clients (`mcp`). Only the CLI creates and reopens threads (Engine.comments refuses both for any other client).
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  COMMENTS_DIR,
  COMMENT_ENTRIES_MAX,
  COMMENT_ID_RE,
  COMMENT_THREAD_VERSION,
  CommentThreadSchema,
  RENDER_ID_RE,
  SLUG_RE,
  commentAuthorName,
  commentText,
  commentTextProblem,
  deriveStatus,
  isIsoUtcDate,
  newCommentEntryId,
  newCommentId,
  printableText,
  regionProblem,
  trustedAnchor,
} from '@demo-studio/core';
import type { CommentAuthor, CommentEntry, CommentRegion, CommentThread, FrameCommentAnchor, LoadedProject, Timeline } from '@demo-studio/core';
import type { RenderRecord } from '@demo-studio/editor';
import { TakeLock, readLock } from '@demo-studio/sandbox';
import { EngineError } from './errors.js';
import { checkRunId, checkScenarioName } from './refs.js';
import { renderForWork } from './renders.js';
import { LocalStorage, sha256Hex } from './storage.js';
import { editor } from './jobs/render-job.js';

/** Lazy: @demo-studio/review pulls in sharp. */
const review = () => import('@demo-studio/review');

/**
 * A thread file larger than this is not read, and an entry that would make it larger is refused (500 entries of 2000
 * characters fit unless the texts are mostly characters JSON escapes).
 */
export const COMMENT_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** A still larger than this is not shown (a 1920 px JPEG is ~100 KB). */
export const COMMENT_STILL_MAX_BYTES = 10 * 1024 * 1024;
/** Thread files read by one listing, at most. */
export const COMMENT_LIST_MAX_FILES = 2000;
/** How long a write waits for a thread's lock held by a live process (ms), and between tries. */
export const COMMENT_LOCK_WAIT_MS = 3000;
const LOCK_RETRY_MS = 50;
/** The author name of entries written through the MCP tools (the channel, never a person). */
export const MCP_AUTHOR_NAME = 'agent';
/** A scenario snapshot or a timeline larger than this is not read for an anchor. */
const RUN_FILE_MAX_BYTES = 64 * 1024 * 1024;

const THREAD_FILE_RE = /^c_[0-9A-HJKMNP-TV-Z]{26}\.json$/;
const VARIANTS: readonly string[] = ['landscape', 'vertical', 'square'];

/** `comments/<scenario>/<id>.json`, the thread's project-relative ref. */
export function commentRef(scenario: string, id: string): string {
  return `${COMMENTS_DIR}/${scenario}/${id}.json`;
}

/** `<project>/.demo-studio/comments/<id>.jpg`: the still of a thread (machine-local). */
export function commentStillFile(projectDir: string, id: string): string {
  return join(projectDir, '.demo-studio', 'comments', `${id}.jpg`);
}

/** `<project>/.demo-studio/locks/comment-<id>.lock`: held while an entry is appended. */
export function commentLockFile(projectDir: string, id: string): string {
  return join(projectDir, '.demo-studio', 'locks', `comment-${id}.lock`);
}

/**
 * The name of the person at this terminal for `studio comment` (no `--author`): $DEMO_STUDIO_AUTHOR, else the OS user
 * name (never git config: a subprocess and often a full name), printable, ≤ 80 characters.
 */
export function defaultAuthorName(): string {
  const env = process.env.DEMO_STUDIO_AUTHOR;
  if (env !== undefined && env.trim() !== '') {
    const name = commentAuthorName(env);
    if (name) return name;
  }
  try {
    const name = commentAuthorName(userInfo().username);
    if (name) return name;
  } catch {
    /* no user name */
  }
  return 'unknown';
}

/** An argument error (the CLI shows it as a usage error). */
function argError(argument: string, message: string): EngineError {
  return new EngineError('invalid', message, { details: { argument } });
}

export function checkCommentId(id: string): string {
  if (typeof id !== 'string' || !COMMENT_ID_RE.test(id)) {
    throw argError('comment_id', `invalid comment id "${String(id).slice(0, 80)}": c_ + 26 characters (comment list names them), never a path`);
  }
  return id;
}

function cleanText(raw: unknown, what: string, argument: string, required = true): string {
  if (typeof raw !== 'string') throw argError(argument, `${what} is a text`);
  const text = commentText(raw);
  const problem = commentTextProblem(text, { what, required });
  if (problem) throw argError(argument, problem);
  return text;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** lstat, or null when it does not exist. */
async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

/** A real folder (not a link) at `path`: 'ok', 'missing', or why not. */
async function realDir(path: string): Promise<'ok' | 'missing' | 'a symbolic link' | 'not a folder'> {
  const st = await lstatOrNull(path);
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'a symbolic link';
  return st.isDirectory() ? 'ok' : 'not a folder';
}

/** A small regular file of the project read whole (null: missing, a link, too large or not a file). */
async function readPlainFile(path: string, max: number): Promise<Buffer | null> {
  const st = await lstatOrNull(path);
  if (!st || !st.isFile() || st.size > max) return null;
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * `<project>/.demo-studio/<sub>/`, made of real folders of the project: each level checked before it is created (never
 * through a symbolic link: a lock, its temp and breaker files, or a still would land outside), then its real path
 * checked inside the project. Throws EngineError refused.
 */
async function toolDir(projectDir: string, sub: string): Promise<string> {
  let dir = projectDir;
  for (const part of ['.demo-studio', sub]) {
    dir = join(dir, part);
    let state = await realDir(dir);
    if (state === 'missing') {
      await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      state = await realDir(dir);
    }
    if (state !== 'ok') throw new EngineError('refused', `${relative(projectDir, dir)}/ is ${state}: remove it (the tool makes it again)`);
  }
  const [realProject, realSub] = await Promise.all([realpath(projectDir), realpath(dir)]);
  if (!isInside(realProject, realSub)) throw new EngineError('refused', `${relative(projectDir, dir)}/ leads out of the project folder`);
  return dir;
}

/** The comments/ folder name that differs from `scenario` only by case (a case-insensitive disk would mix them), if any. */
async function caseVariantFolder(projectDir: string, scenario: string): Promise<string | undefined> {
  const root = join(projectDir, COMMENTS_DIR);
  if ((await realDir(root)) !== 'ok') return undefined;
  const lower = scenario.toLowerCase();
  return (await readdir(root)).find((n) => n !== scenario && n.toLowerCase() === lower);
}

// ── Reading thread files ────────────────────────────────────────────────────

interface ThreadFile {
  scenario: string;
  id: string;
  ref: string;
  path: string;
}

type ReadResult = { ok: true; thread: CommentThread; hash: string } | { ok: false; problem: string };

/** Read and check one thread file (its folders and the file itself real, not links; name = id; folder = scenario). */
async function readThread(projectDir: string, f: ThreadFile): Promise<ReadResult> {
  for (const [dir, label] of [
    [join(projectDir, COMMENTS_DIR), `${COMMENTS_DIR}/`],
    [join(projectDir, COMMENTS_DIR, f.scenario), `${COMMENTS_DIR}/${f.scenario}/`],
  ] as const) {
    const state = await realDir(dir);
    if (state !== 'ok') return { ok: false, problem: `${label} is ${state === 'missing' ? 'missing' : state}` };
  }
  const st = await lstatOrNull(f.path);
  if (!st) return { ok: false, problem: `${f.ref} does not exist` };
  if (st.isSymbolicLink()) return { ok: false, problem: `${f.ref} is a symbolic link: not read` };
  if (!st.isFile()) return { ok: false, problem: `${f.ref} is not a file` };
  if (st.size > COMMENT_FILE_MAX_BYTES) return { ok: false, problem: `${f.ref} is larger than ${COMMENT_FILE_MAX_BYTES / 1024 / 1024} MB: not read` };
  const buf = await readFile(f.path);
  const hash = sha256Hex(buf);
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    return { ok: false, problem: `${f.ref} is not JSON` };
  }
  const parsed = CommentThreadSchema.safeParse(raw);
  if (!parsed.success) {
    // Issue paths are the schema's own keys and indexes; the file's values (and unknown keys) are never quoted.
    const where = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(top)'} (${i.code})`);
    return { ok: false, problem: `${f.ref} is not a valid thread: ${where.join(', ')}` };
  }
  const thread = parsed.data;
  if (thread.id !== f.id) return { ok: false, problem: `${f.ref} holds another thread's id (the file name must be its id)` };
  if (thread.scenario !== f.scenario) return { ok: false, problem: `${f.ref} holds a thread of another scenario (the folder must be its scenario)` };
  return { ok: true, thread, hash };
}

/** The thread file of `id`: its scenario folder found by scanning comments/ (real folders only); ambiguity refused. */
async function locateThread(projectDir: string, id: string): Promise<ThreadFile> {
  checkCommentId(id);
  const root = join(projectDir, COMMENTS_DIR);
  const state = await realDir(root);
  if (state === 'missing') throw new EngineError('not_found', `comment ${id} not found (the project has no comments yet)`);
  if (state !== 'ok') throw new EngineError('refused', `${COMMENTS_DIR}/ is ${state}: not read`);
  const found: string[] = [];
  for (const d of await readdir(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !SLUG_RE.test(d.name)) continue;
    // The exact name on disk (as a listing reads it): a case-insensitive disk finds `c_01jc….json` by lstat, never listed.
    const names = await readdir(join(root, d.name)).catch(() => [] as string[]);
    if (names.includes(`${id}.json`)) found.push(d.name);
  }
  if (found.length === 0) throw new EngineError('not_found', `comment ${id} not found (comment list names the threads)`);
  if (found.length > 1) throw new EngineError('refused', `comment ${id} exists in several scenario folders (${found.join(', ')}): remove the wrong copy`);
  const scenario = found[0];
  const ref = commentRef(scenario, id);
  return { scenario, id, ref, path: join(root, scenario, `${id}.json`) };
}

// ── Views ───────────────────────────────────────────────────────────────────

/** An entry as clients see it: ids, kind, channel, dates, render (free text under the thread's `untrusted`). */
export interface CommentEntryView {
  id: string;
  kind: CommentEntry['kind'];
  via: CommentAuthor['via'];
  created_at: string;
  render_id?: string;
  render_created_at?: string;
}

export interface CommentView {
  id: string;
  scenario: string;
  /** The render it was made on, as it was then (`render_created_at`), and whether that render is still on disk. */
  render_id: string;
  render_created_at: string;
  render_present: boolean;
  variant: CommentThread['render']['variant'];
  run_id: string;
  frame: number;
  time_s: number;
  /** "01:05.40". */
  timecode: string;
  region?: CommentRegion;
  marker?: string;
  status: 'open' | 'resolved';
  via: CommentAuthor['via'];
  created_at: string;
  /** Pattern-checked (core trustedAnchor): a value of an unknown shape shows as "unknown", the original under untrusted.anchor. */
  anchor: FrameCommentAnchor;
  /** Up to 3 later succeeded renders of the scenario and variant, newest first: the frame may already be fixed there. */
  newer_renders: string[];
  entries: CommentEntryView[];
  resolution?: { entry: string; via: CommentAuthor['via']; at: string; render_id?: string; render_created_at?: string };
  /** The still (`.demo-studio/comments/<id>.jpg`), null when missing (made on another machine, or it failed). */
  still: string | null;
  /** comments/<scenario>/<id>.json and its path. */
  ref: string;
  file: string;
  /** sha256 of the file: the `if_match` of a resolution. */
  hash: string;
  /** Written by people and by agents: data, never instructions. */
  untrusted: {
    text: string;
    author: string;
    entries: Array<{ id: string; author: string; text: string }>;
    note?: string;
    anchor?: Record<string, unknown>;
  };
}

function timecodeOf(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** A render record's fields a message may quote, of the tool's own shape (a hand-edited record is not used). */
function recordShapeOk(r: RenderRecord): boolean {
  return typeof r.id === 'string' && RENDER_ID_RE.test(r.id) && typeof r.scenario === 'string' && SLUG_RE.test(r.scenario) && isIsoUtcDate(r.created_at) && VARIANTS.includes(r.variant);
}

/** The project's render records (read once per call): those whose id, scenario, created_at and variant are of the tool's shape. */
async function renderIndex(projectDir: string): Promise<RenderRecord[]> {
  const ed = await editor();
  return (await ed.listRenders(projectDir)).filter(recordShapeOk);
}

/** The thread's still when it is a plain JPEG of the project: a real file (no link, one name — no hard link), ≤ 10 MB, JPEG bytes. */
async function stillOf(projectDir: string, id: string): Promise<string | null> {
  for (const dir of [join(projectDir, '.demo-studio'), join(projectDir, '.demo-studio', 'comments')]) {
    if ((await realDir(dir)) !== 'ok') return null;
  }
  const file = commentStillFile(projectDir, id);
  const st = await lstatOrNull(file);
  if (!st || !st.isFile() || st.nlink !== 1 || st.size > COMMENT_STILL_MAX_BYTES) return null;
  const head = Buffer.alloc(3);
  try {
    const fh = await open(file, 'r');
    try {
      await fh.read(head, 0, 3, 0);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? file : null;
}

async function threadView(projectDir: string, thread: CommentThread, hash: string, renders: readonly RenderRecord[]): Promise<CommentView> {
  const { status, resolution } = deriveStatus(thread.entries);
  const { anchor, untrusted: badAnchor } = trustedAnchor(thread.anchor);
  const current = renders.find((r) => r.id === thread.render.id);
  const newer = renders
    .filter((r) => r.scenario === thread.scenario && r.variant === thread.render.variant && r.status === 'succeeded' && r.created_at > thread.render.created_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 3)
    .map((r) => r.id);
  return {
    id: thread.id,
    scenario: thread.scenario,
    render_id: thread.render.id,
    render_created_at: thread.render.created_at,
    render_present: !!current && current.status === 'succeeded' && current.created_at === thread.render.created_at,
    variant: thread.render.variant,
    run_id: thread.render.run_id,
    frame: thread.frame,
    time_s: thread.time_s,
    timecode: timecodeOf(thread.time_s),
    ...(thread.region ? { region: thread.region } : {}),
    ...(thread.marker ? { marker: thread.marker } : {}),
    status,
    via: thread.author.via,
    created_at: thread.created_at,
    anchor,
    newer_renders: newer,
    entries: thread.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      via: e.author.via,
      created_at: e.created_at,
      ...(e.render_id !== undefined ? { render_id: e.render_id, render_created_at: e.render_created_at } : {}),
    })),
    ...(resolution
      ? {
          resolution: {
            entry: resolution.entry,
            via: resolution.by.via,
            at: resolution.at,
            ...(resolution.render_id !== undefined ? { render_id: resolution.render_id, render_created_at: resolution.render_created_at } : {}),
          },
        }
      : {}),
    still: await stillOf(projectDir, thread.id),
    ref: commentRef(thread.scenario, thread.id),
    file: join(projectDir, COMMENTS_DIR, thread.scenario, `${thread.id}.json`),
    hash,
    untrusted: {
      text: thread.text,
      author: thread.author.name,
      entries: thread.entries.map((e) => ({ id: e.id, author: e.author.name, text: e.text })),
      ...(resolution ? { note: resolution.note } : {}),
      ...(badAnchor ? { anchor: badAnchor } : {}),
    },
  };
}

export interface CommentListRequest {
  /** Only this scenario's threads. */
  scenario?: string;
  /**
   * Only threads made on this render as it is now (its id and `created_at`): a thread made on an earlier render of a
   * reused id is listed by scenario only. `latest`: the newest succeeded render (of `scenario`).
   */
  render?: string;
  /** Default open. */
  status?: 'open' | 'resolved' | 'all';
  /** At most this many threads (the newest renders first); default all. */
  limit?: number;
}

export interface CommentListView {
  project: string;
  /** Open first, then by commented render (newest first), then frame. */
  threads: CommentView[];
  /** Threads matching before `limit`. */
  total: number;
  /** Files and folders skipped (a link, a broken file…), by name. */
  problems: string[];
}

/** The threads of a project (see CommentListRequest). */
export async function listComments(project: LoadedProject, req: CommentListRequest = {}): Promise<CommentListView> {
  const status = req.status ?? 'open';
  if (!['open', 'resolved', 'all'].includes(status)) throw argError('status', `status "${String(status)}": open, resolved or all`);
  if (req.scenario !== undefined) checkScenarioName(req.scenario);
  if (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit < 1)) throw argError('limit', `limit ${String(req.limit)}: a whole number from 1`);
  const renders = await renderIndex(project.dir);
  let onRender: RenderRecord | undefined;
  let scenario = req.scenario;
  if (req.render !== undefined) {
    if (req.render === 'latest') {
      onRender = renders.filter((r) => r.status === 'succeeded' && (scenario === undefined || r.scenario === scenario)).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
      if (!onRender) throw new EngineError('not_found', `no finished render of ${project.slug}${scenario ? ` · ${scenario}` : ''} yet`);
    } else {
      if (typeof req.render !== 'string' || !RENDER_ID_RE.test(req.render) || req.render.length > 200) {
        throw argError('render', `invalid render id "${String(req.render).slice(0, 80)}": <scenario>-v<N>, or "latest"`);
      }
      onRender = renders.find((r) => r.id === req.render);
      if (!onRender) throw new EngineError('not_found', `render "${req.render}" not found in ${project.slug} (no renders/${req.render}.json, or one the tool never wrote): list by scenario to see threads made on an earlier render of that id`);
    }
    if (scenario !== undefined && onRender.scenario !== scenario) throw argError('render', `render ${onRender.id} is a render of ${onRender.scenario}, not of ${scenario}`);
    scenario = onRender.scenario;
  }

  const problems: string[] = [];
  const root = join(project.dir, COMMENTS_DIR);
  const rootState = await realDir(root);
  const files: ThreadFile[] = [];
  if (rootState === 'ok') {
    let skippedNames = 0;
    for (const d of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (scenario !== undefined && d.name !== scenario) {
        // Same letters, another case: the threads a case-insensitive disk wrote there for this scenario (name safe: = scenario but case).
        if (d.name.toLowerCase() === scenario.toLowerCase()) problems.push(`${COMMENTS_DIR}/${d.name}/ differs from ${scenario} only by case: skipped (rename it ${scenario}/ or remove it)`);
        continue;
      }
      if (!SLUG_RE.test(d.name)) {
        skippedNames++;
        continue;
      }
      if (d.isSymbolicLink()) {
        problems.push(`${COMMENTS_DIR}/${d.name}/ is a symbolic link: skipped`);
        continue;
      }
      if (!d.isDirectory()) continue;
      for (const f of (await readdir(join(root, d.name), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        // Temp files of an interrupted write, and anything that is not a thread file, are not threads.
        if (!THREAD_FILE_RE.test(f.name)) continue;
        const ref = `${COMMENTS_DIR}/${d.name}/${f.name}`;
        if (f.isSymbolicLink()) {
          problems.push(`${ref} is a symbolic link: skipped`);
          continue;
        }
        if (!f.isFile()) continue;
        if (files.length >= COMMENT_LIST_MAX_FILES) {
          problems.push(`more than ${COMMENT_LIST_MAX_FILES} thread files: the rest were not read`);
          break;
        }
        files.push({ scenario: d.name, id: f.name.slice(0, -'.json'.length), ref, path: join(root, d.name, f.name) });
      }
    }
    if (skippedNames) problems.push(`${COMMENTS_DIR}/ holds ${skippedNames} ${skippedNames === 1 ? 'entry' : 'entries'} whose name is not a scenario name: skipped`);
  } else if (rootState !== 'missing') problems.push(`${COMMENTS_DIR}/ is ${rootState}: not read`);

  const views: CommentView[] = [];
  for (const f of files) {
    const r = await readThread(project.dir, f);
    if (!r.ok) {
      problems.push(r.problem);
      continue;
    }
    if (onRender && (r.thread.render.id !== onRender.id || r.thread.render.created_at !== onRender.created_at)) continue;
    const view = await threadView(project.dir, r.thread, r.hash, renders);
    if (status !== 'all' && view.status !== status) continue;
    views.push(view);
  }
  views.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) ||
      b.render_created_at.localeCompare(a.render_created_at) ||
      a.frame - b.frame ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
  return { project: project.slug, threads: req.limit !== undefined ? views.slice(0, req.limit) : views, total: views.length, problems };
}

/** One thread's view. */
export async function getComment(project: LoadedProject, id: string): Promise<CommentView> {
  const f = await locateThread(project.dir, id);
  const r = await readThread(project.dir, f);
  if (!r.ok) throw new EngineError('invalid', r.problem);
  return threadView(project.dir, r.thread, r.hash, await renderIndex(project.dir));
}

// ── Creating a thread ───────────────────────────────────────────────────────

export interface CommentAddRequest {
  /** A render id, or `latest` (of `scenario`). */
  render: string;
  scenario?: string;
  /**
   * Exactly one of: an output frame, a time (seconds: the frame on screen at that time, floor(t × fps); the duration as
   * printed, rounded to 1/100 s, is the last frame), a marker (its `done` frame, else its start; a name marking several
   * steps is refused: pick the frame).
   */
  frame?: number;
  at_s?: number;
  marker?: string;
  region?: CommentRegion;
  text: string;
}

export interface CommentAdded {
  thread: CommentView;
  warnings: string[];
}

/** The frame a request names (0 ≤ frame < frames). */
function pickFrame(req: CommentAddRequest, record: RenderRecord): number {
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
async function runInputs(projectDir: string, record: RenderRecord, warnings: string[]): Promise<{ scenarioText?: string; timeline?: Pick<Timeline, 'markers' | 'events'> }> {
  const runDir = join(projectDir, 'runs', checkRunId(record.run_id));
  const out: { scenarioText?: string; timeline?: Pick<Timeline, 'markers' | 'events'> } = {};
  const yaml = await readPlainFile(join(runDir, 'scenario.yaml'), RUN_FILE_MAX_BYTES);
  if (yaml) out.scenarioText = yaml.toString('utf8');
  else warnings.push(`runs/${record.run_id}/scenario.yaml is missing: the anchor has no step fingerprint`);
  if (record.plan.markers.some((m) => m.step === undefined)) {
    const tl = await readPlainFile(join(runDir, 'timeline.json'), RUN_FILE_MAX_BYTES);
    try {
      const t = tl ? (JSON.parse(tl.toString('utf8')) as Partial<Timeline>) : undefined;
      if (t && Array.isArray(t.markers) && Array.isArray(t.events)) out.timeline = { markers: t.markers, events: t.events };
    } catch {
      /* no timeline: markers name no step */
    }
  }
  return out;
}

/** Make the still of a new thread (temp + rename in a real folder of the project); null and a warning when it fails. */
async function writeStill(projectDir: string, id: string, video: string, frame: number, region: CommentRegion | undefined, warnings: string[]): Promise<string | null> {
  const final = commentStillFile(projectDir, id);
  const tmp = join(dirname(final), `${id}.${randomBytes(4).toString('hex')}.tmp.jpg`);
  try {
    await toolDir(projectDir, 'comments');
    await (await review()).extractStill(video, frame, tmp, region ? { region } : {});
    await rename(tmp, final);
    return final;
  } catch (e) {
    warnings.push(`no still for comment ${id}: ${(e as Error).message.split('\n')[0]}`);
    return null;
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * A new thread on one frame of a render (the CLI; later the Studio UI): the render read by id (`renderForWork`: a
 * succeeded render whose files lie in the project), the frame picked, the anchor computed from the render's plan and
 * the run's scenario snapshot, the still extracted, the thread created (never over an existing file).
 */
export async function addComment(project: LoadedProject, req: CommentAddRequest, author: CommentAuthor): Promise<CommentAdded> {
  const text = cleanText(req.text, 'the comment', 'text');
  if (req.region !== undefined) {
    const p = regionProblem(req.region);
    if (p) throw argError('region', p);
  }
  if (req.scenario !== undefined) checkScenarioName(req.scenario);
  const record = await renderForWork(project, req.render, req.scenario !== undefined ? { scenario: req.scenario } : {});
  if (req.scenario !== undefined && record.scenario !== req.scenario) throw argError('render', `render ${record.id} is a render of ${record.scenario}, not of ${req.scenario}`);
  if (!RENDER_ID_RE.test(record.id) || !SLUG_RE.test(record.scenario) || !record.id.startsWith(`${record.scenario}-v`)) {
    throw new EngineError('invalid', `render ${record.id} has no <scenario>-v<N> id (written with --out?): only renders of renders/ take comments`);
  }
  const frame = pickFrame(req, record);
  const warnings: string[] = [];
  const inputs = await runInputs(project.dir, record, warnings);
  let anchor: FrameCommentAnchor;
  try {
    anchor = (await review()).frameAnchor(record.plan, frame, { ...(req.region ? { region: req.region } : {}), ...inputs });
  } catch (e) {
    if (e instanceof RangeError) throw argError('frame', e.message);
    throw e;
  }
  const clash = await caseVariantFolder(project.dir, record.scenario);
  if (clash) {
    throw new EngineError('refused', `${COMMENTS_DIR}/${clash}/ differs from ${record.scenario} only by case: a case-insensitive disk would write the thread there`, {
      fix: `rename ${COMMENTS_DIR}/${clash}/ to ${COMMENTS_DIR}/${record.scenario}/ (or remove it), then comment again`,
    });
  }
  const id = newCommentId();
  const now = new Date().toISOString();
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
  const still = await writeStill(project.dir, id, record.file, frame, req.region, warnings);
  const storage = new LocalStorage(project.dir);
  let written;
  try {
    written = await storage.writeText(commentRef(record.scenario, id), `${JSON.stringify(parsed.data, null, 2)}\n`, { ifMatch: null });
  } catch (e) {
    if (still) await rm(still, { force: true }).catch(() => undefined);
    throw e;
  }
  return { thread: await threadView(project.dir, parsed.data, written.sha256, await renderIndex(project.dir)), warnings };
}

// ── Appending entries ───────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The thread's lock: retried while a live process holds it (≤ COMMENT_LOCK_WAIT_MS); a dead holder's is broken. The
 * lock folder is a real folder of the project (toolDir); anything but a file at the lock path is refused. The lock file
 * is agent-writable: a busy error quotes its pid and a well-formed date only, its command printable, ≤ 80 characters,
 * under `details.untrusted`.
 */
async function lockThread(projectDir: string, id: string, op: string): Promise<TakeLock> {
  const file = commentLockFile(projectDir, id);
  const ref = relative(projectDir, file);
  await toolDir(projectDir, 'locks');
  const deadline = Date.now() + COMMENT_LOCK_WAIT_MS;
  for (;;) {
    const st = await lstatOrNull(file);
    if (st && !st.isFile()) {
      throw new EngineError('refused', `${ref} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a file'}: comment ${id} cannot be locked`, { fix: `remove ${ref} (no studio command makes one)` });
    }
    try {
      return TakeLock.acquire(file, `comment ${op} ${id}`, `comment ${id}`);
    } catch (e) {
      if (!(e instanceof Error && e.name === 'SandboxError' && (e as { code?: string }).code === 'busy')) throw e;
      if (Date.now() >= deadline) {
        const held = readLock(file);
        const pid = held && Number.isInteger(held.pid) && held.pid > 0 ? held.pid : undefined;
        const since = held && isIsoUtcDate(held.since) ? held.since : undefined;
        const command = held && typeof held.command === 'string' ? printableText(held.command).slice(0, 80) : '';
        throw new EngineError('busy', `comment ${id} is being written by another command${pid ? ` (pid ${pid}${since ? `, since ${since}` : ''})` : ''}: try again`, {
          fix: `try again in a moment; if no studio command is running, remove ${ref}`,
          ...(command ? { details: { untrusted: { command } } } : {}),
        });
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

export interface CommentWritten {
  thread: CommentView;
  /** The entry appended. */
  entry: string;
  /** The file's new hash. */
  hash: string;
}

/**
 * Append the entry `make` returns to thread `id`, under its lock: read (a file that is not a valid thread is never
 * overwritten), `ifMatch` checked against the hash read, appended, written with that hash.
 */
async function appendEntry(
  project: LoadedProject,
  id: string,
  op: string,
  make: (thread: CommentThread, hash: string) => Promise<CommentEntry> | CommentEntry,
  o: { ifMatch?: string } = {},
): Promise<CommentWritten> {
  const f = await locateThread(project.dir, id);
  const lock = await lockThread(project.dir, id, op);
  try {
    const r = await readThread(project.dir, f);
    if (!r.ok) throw new EngineError('invalid', `${r.problem} — the file is never overwritten: fix it or remove it`);
    if (o.ifMatch !== undefined && o.ifMatch !== r.hash) {
      throw new EngineError('conflict', `${f.ref} changed since it was read (if_match does not match): read it again (its new entries may answer it)`, {
        details: { current: r.hash },
        fix: `read the thread again and pass if_match: "${r.hash}"`,
      });
    }
    if (r.thread.entries.length >= COMMENT_ENTRIES_MAX) throw new EngineError('refused', `comment ${id} has ${COMMENT_ENTRIES_MAX} entries: start a new thread`);
    const entry = await make(r.thread, r.hash);
    const next = CommentThreadSchema.safeParse({ ...r.thread, entries: [...r.thread.entries, entry] });
    if (!next.success) throw new EngineError('invalid', `the entry does not make a valid thread: ${next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const text = `${JSON.stringify(next.data, null, 2)}\n`;
    // Never write a file that reads refuse.
    if (Buffer.byteLength(text) > COMMENT_FILE_MAX_BYTES) throw new EngineError('refused', `comment ${id} would grow past ${COMMENT_FILE_MAX_BYTES / 1024 / 1024} MB with this entry: start a new thread`);
    const written = await new LocalStorage(project.dir).writeText(f.ref, text, { ifMatch: r.hash });
    return { thread: await threadView(project.dir, next.data, written.sha256, await renderIndex(project.dir)), entry: entry.id, hash: written.sha256 };
  } finally {
    lock.releaseSync();
  }
}

/** A reply on a thread (open or resolved). */
export async function replyComment(project: LoadedProject, id: string, rawText: string, author: CommentAuthor): Promise<CommentWritten> {
  const text = cleanText(rawText, 'the reply', 'text');
  return appendEntry(project, id, 'reply', () => ({ id: newCommentEntryId(), kind: 'reply', author, text, created_at: new Date().toISOString() }));
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
export async function resolveComment(project: LoadedProject, id: string, req: CommentResolveRequest, author: CommentAuthor): Promise<CommentWritten> {
  const note = cleanText(req.note, 'the note', 'note');
  if (req.ifMatch !== undefined && (typeof req.ifMatch !== 'string' || !/^[0-9a-f]{64}$/.test(req.ifMatch))) throw argError('if_match', 'if_match is the hash a listing returned (64 hex characters)');
  const f = await locateThread(project.dir, id);
  let answer: RenderRecord | undefined;
  if (req.render_id !== undefined) {
    let renderId = req.render_id;
    if (renderId === 'latest') {
      // The newest finished render of the thread's scenario and variant (a vertical cut does not answer a landscape frame).
      const r = await readThread(project.dir, f);
      if (!r.ok) throw new EngineError('invalid', r.problem);
      const variant = r.thread.render.variant;
      const last = (await renderIndex(project.dir))
        .filter((x) => x.status === 'succeeded' && x.scenario === f.scenario && x.variant === variant)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .at(-1);
      if (!last) throw new EngineError('not_found', `no finished ${variant} render of ${f.scenario} yet: render makes one`);
      renderId = last.id;
    }
    answer = await renderForWork(project, renderId, { scenario: f.scenario });
    if (!recordShapeOk(answer)) throw new EngineError('refused', `renders/${answer.id}.json has a scenario, created_at or variant the tool never writes: not used`);
  }
  return appendEntry(
    project,
    id,
    'resolve',
    (thread) => {
      const { status, resolution } = deriveStatus(thread.entries);
      if (status === 'resolved') {
        throw new EngineError('conflict', `comment ${id} is already resolved (entry ${resolution?.entry}${resolution?.render_id ? `, render ${resolution.render_id}` : ''}): it is reopened by a person (studio comment reopen)`, {
          details: { status, ...(resolution ? { entry: resolution.entry } : {}) },
        });
      }
      if (answer) {
        if (answer.scenario !== thread.scenario) throw new EngineError('refused', `render ${answer.id} is a render of ${answer.scenario}: a comment on ${thread.scenario} is resolved by a render of ${thread.scenario}`);
        if (answer.variant !== thread.render.variant) {
          throw new EngineError('refused', `render ${answer.id} is a ${answer.variant} render: a comment on the ${thread.render.variant} render ${thread.render.id} is resolved by a ${thread.render.variant} render of ${thread.scenario}`);
        }
        if (!(answer.created_at > thread.render.created_at)) {
          throw new EngineError('refused', `render ${answer.id} (${answer.created_at}) is not later than the commented render ${thread.render.id} (${thread.render.created_at}): resolve with the render made after the change`);
        }
      }
      return {
        id: newCommentEntryId(),
        kind: 'resolve',
        author,
        text: note,
        created_at: new Date().toISOString(),
        ...(answer ? { render_id: answer.id, render_created_at: answer.created_at } : {}),
      };
    },
    req.ifMatch !== undefined ? { ifMatch: req.ifMatch } : {},
  );
}

/** Reopen a resolved thread (a person disagreeing with its resolution); the note may be empty. */
export async function reopenComment(project: LoadedProject, id: string, rawNote: string | undefined, author: CommentAuthor): Promise<CommentWritten> {
  const note = cleanText(rawNote ?? '', 'the note', 'note', false);
  return appendEntry(project, id, 'reopen', (thread) => {
    if (deriveStatus(thread.entries).status !== 'resolved') throw new EngineError('conflict', `comment ${id} is open: only a resolved thread is reopened`, { details: { status: 'open' } });
    return { id: newCommentEntryId(), kind: 'reopen', author, text: note, created_at: new Date().toISOString() };
  });
}
