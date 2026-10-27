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
 * clients (`studio` for the Studio web app, `mcp` for every other client). Only the person channels (`cli`, `studio`)
 * create and reopen threads (Engine.comments refuses both for any other client); the Studio acts on the version of a
 * thread it showed (`if_match`) and on the render it showed (`render_created_at`).
 *
 * Costs (L4.6, critique B8 / B12): the thread is written before its still (the still is an exact select from frame 0:
 * its time grows with the frame's position, a failure is a warning); `CommentIndex` counts and places threads from the
 * thread files alone (no render records, no views), memoised per file signature.
 */
import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  COMMENTS_DIR,
  COMMENT_AUTHOR_MAX,
  COMMENT_ENTRIES_MAX,
  COMMENT_ENTRY_ID_RE,
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
  locateAnchorStep,
  PROPOSAL_CHANGED_LINES_MAX,
  applyHunks,
  diffLines,
  hunkStats,
  invertHunks,
  joinLines,
  newCommentEntryId,
  newCommentId,
  proposalStates,
  regionProblem,
  sameHunks,
  scenarioSinceRun,
  textEol,
  textLines,
  trustedAnchor,
} from '@demo-studio/core';
import type {
  CommentAuthor,
  CommentEntry,
  CommentProposal,
  CommentRegion,
  CommentThread,
  FrameCommentAnchor,
  LoadedProject,
  ProposalState,
  Timeline,
  ValidationIssue,
} from '@demo-studio/core';
import type { ComponentRegistry } from '@demo-studio/components';
import type { RenderRecord } from '@demo-studio/editor';
import type { TakeLock } from '@demo-studio/sandbox';
import { EngineError } from './errors.js';
import { lockHolder, takeProjectLock, toolDir } from './project-lock.js';
import { checkRunId, checkScenarioName } from './refs.js';
import { PROPOSAL_CONTEXT_LINES, buildProposal, checkProposedText, diffRows, rebuildProposal } from './comment-proposals.js';
import type { ProposalInput, ProposalRow } from './comment-proposals.js';

export { PROPOSAL_CONTEXT_LINES } from './comment-proposals.js';
export type { ProposalRow } from './comment-proposals.js';
import { renderForWork } from './renders.js';
import { editScenario, getScenario } from './scenarios.js';
import type { ScenarioText } from './scenarios.js';
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
  /** A reply's proposal (L4.6): its state against today's file and its size — the lines themselves: `comments.proposal`. */
  proposal?: CommentProposalSummary;
  /** An apply (L4.6): the reply whose proposal it applied and the sha256 of the file written. */
  applies?: string;
  scenario_sha256?: string;
}

/** A proposal as a thread view carries it: trusted fields only (ids, hashes, counts, words of the tool). */
export interface CommentProposalSummary {
  state: ProposalState;
  /** The newest proposal, pending or undone, on an open thread: Apply and Preview are offered for it. */
  actionable: boolean;
  delta: CommentProposal['delta'];
  added: number;
  removed: number;
  hunks: number;
  base_sha256: string;
  result_sha256: string;
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
  /**
   * The anchored step in today's scenario file (L4.3, critique B10; core locateAnchorStep): "<scene>.<index>", what
   * page_inspect {until} takes — `anchor.step_ref` is where it was in the rendered run, and steps moved since (a Studio
   * drag) change the index. Null: today's file has no such step (deleted, changed, or not readable). Absent: the frame
   * shows no step.
   */
  step_now?: string | null;
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

/** "01:05.40": minutes and seconds to 1/100 s. */
export function timecodeOf(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** A render record's fields a message may quote, of the tool's own shape (a hand-edited record is not used). */
export function recordShapeOk(r: RenderRecord): boolean {
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

/** Today's text of a scenario (.yaml, else an existing .yml) and its bytes' sha256, null when it cannot be read; one read per scenario and call. */
async function todayText(projectDir: string, scenario: string, cache: Map<string, Promise<{ text: string; sha256: string } | null>>): Promise<{ text: string; sha256: string } | null> {
  let p = cache.get(scenario);
  if (!p) {
    const storage = new LocalStorage(projectDir);
    p = (async () => {
      for (const ref of [`scenarios/${scenario}.yaml`, `scenarios/${scenario}.yml`]) {
        try {
          const r = await storage.readText(ref);
          if (r) return { text: r.text, sha256: r.sha256 };
        } catch {
          return null;
        }
      }
      return null;
    })();
    cache.set(scenario, p);
  }
  return p;
}

type TextCache = Map<string, Promise<{ text: string; sha256: string } | null>>;

function proposalSummary(p: CommentProposal, state: ProposalState, actionable: boolean): CommentProposalSummary {
  const st = hunkStats(p.hunks);
  return { state, actionable, delta: p.delta, added: st.added, removed: st.removed, hunks: p.hunks.length, base_sha256: p.base_sha256, result_sha256: p.result_sha256 };
}

async function threadView(
  projectDir: string,
  thread: CommentThread,
  hash: string,
  renders: readonly RenderRecord[],
  texts: TextCache = new Map(),
): Promise<CommentView> {
  const { status, resolution } = deriveStatus(thread.entries);
  const { anchor, untrusted: badAnchor } = trustedAnchor(thread.anchor);
  let stepNow: string | null | undefined;
  if (anchor.scene !== undefined && anchor.step !== undefined) {
    const today = await todayText(projectDir, thread.scenario, texts);
    stepNow = today === null ? null : (locateAnchorStep(today.text, anchor) ?? null);
  }
  // Proposals (L4.6): their state against today's file (critique B4), read only when the thread holds one.
  const states = thread.entries.some((e) => e.proposal)
    ? new Map(proposalStates(thread.entries, (await todayText(projectDir, thread.scenario, texts))?.sha256 ?? null).map((x) => [x.entry, x]))
    : undefined;
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
    ...(stepNow !== undefined ? { step_now: stepNow } : {}),
    newer_renders: newer,
    entries: thread.entries.map((e) => {
      const st = states?.get(e.id);
      return {
        id: e.id,
        kind: e.kind,
        via: e.author.via,
        created_at: e.created_at,
        ...(e.render_id !== undefined ? { render_id: e.render_id, render_created_at: e.render_created_at } : {}),
        ...(e.proposal && st ? { proposal: proposalSummary(e.proposal, st.state, st.actionable && status === 'open') } : {}),
        ...(e.applies !== undefined ? { applies: e.applies, scenario_sha256: e.scenario_sha256 } : {}),
      };
    }),
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
  const texts: TextCache = new Map();
  for (const f of files) {
    const r = await readThread(project.dir, f);
    if (!r.ok) {
      problems.push(r.problem);
      continue;
    }
    if (onRender && (r.thread.render.id !== onRender.id || r.thread.render.created_at !== onRender.created_at)) continue;
    const view = await threadView(project.dir, r.thread, r.hash, renders, texts);
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
function pickFrame(req: CommentPrepareRequest, record: RenderRecord): number {
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

/** A new thread's render, frame and anchor, computed and checked — everything `addComment` does before the write. */
export interface PreparedComment {
  record: RenderRecord;
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
  if (!RENDER_ID_RE.test(record.id) || !SLUG_RE.test(record.scenario) || !record.id.startsWith(`${record.scenario}-v`)) {
    throw new EngineError('invalid', `render ${record.id} has no <scenario>-v<N> id (written with --out?): only renders of renders/ take comments`);
  }
  if (!recordShapeOk(record)) throw new EngineError('refused', `renders/${record.id}.json has a scenario, created_at or variant the tool never writes: not used`);
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
    anchor = (await review()).frameAnchor(record.plan, frame, { ...(req.region ? { region: req.region } : {}), ...inputs });
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
 * is a warning).
 */
export async function addComment(project: LoadedProject, req: CommentAddRequest, author: CommentAuthor): Promise<CommentAdded> {
  const text = cleanText(req.text, 'the comment', 'text');
  const { record, frame, anchor, warnings } = await prepareComment(project, req);
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
  const written = await new LocalStorage(project.dir).writeText(commentRef(record.scenario, id), `${JSON.stringify(parsed.data, null, 2)}\n`, { ifMatch: null });
  await writeStill(project.dir, id, record.file, frame, req.region, warnings);
  return { thread: await threadView(project.dir, parsed.data, written.sha256, await renderIndex(project.dir)), warnings };
}

// ── Appending entries ───────────────────────────────────────────────────────

/**
 * The thread's lock: retried while a live process holds it (≤ COMMENT_LOCK_WAIT_MS); a dead holder's is broken. The
 * lock folder is a real folder of the project (toolDir); anything but a file at the lock path is refused. The lock file
 * is agent-writable: a busy error quotes its pid and a well-formed date only, its command printable, ≤ 80 characters,
 * under `details.untrusted`.
 */
function lockThread(projectDir: string, id: string, op: string): Promise<TakeLock> {
  return takeProjectLock(projectDir, basename(commentLockFile(projectDir, id)), {
    command: `comment ${op} ${id}`,
    what: `comment ${id}`,
    waitMs: COMMENT_LOCK_WAIT_MS,
    retryMs: 50,
    busy: (ref, held) => {
      const { pid, since, command } = lockHolder(held);
      return new EngineError('busy', `comment ${id} is being written by another command${pid ? ` (pid ${pid}${since ? `, since ${since}` : ''})` : ''}: try again`, {
        fix: `try again in a moment; if no studio command is running, remove ${ref}`,
        ...(command ? { details: { untrusted: { command } } } : {}),
      });
    },
  });
}

export interface CommentWritten {
  thread: CommentView;
  /** The entry appended. */
  entry: string;
  /** The file's new hash. */
  hash: string;
  /** A reply with a proposal: the scenario's validation warnings for the proposed text. */
  proposal_warnings?: ValidationIssue[];
}

/**
 * Thread `r` with `entry` appended, as it would be written: refused past COMMENT_ENTRIES_MAX entries or
 * COMMENT_FILE_MAX_BYTES (never a file that reads refuse), checked whole (CommentThreadSchema). Nothing written: Apply
 * runs it before its scenario write (review A L5 / B M3), so a full thread refuses before anything changes.
 */
function appendedThread(id: string, r: { thread: CommentThread }, entry: CommentEntry): { thread: CommentThread; text: string } {
  if (r.thread.entries.length >= COMMENT_ENTRIES_MAX) throw new EngineError('refused', `comment ${id} has ${COMMENT_ENTRIES_MAX} entries: start a new thread`);
  const next = CommentThreadSchema.safeParse({ ...r.thread, entries: [...r.thread.entries, entry] });
  if (!next.success) throw new EngineError('invalid', `the entry does not make a valid thread: ${next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const text = `${JSON.stringify(next.data, null, 2)}\n`;
  if (Buffer.byteLength(text) > COMMENT_FILE_MAX_BYTES) throw new EngineError('refused', `comment ${id} would grow past ${COMMENT_FILE_MAX_BYTES / 1024 / 1024} MB with this entry: start a new thread`);
  return { thread: next.data, text };
}

/** The apply entry of a proposal (L4.6): the reply it applies and the sha256 of the file written. */
function applyEntryOf(author: CommentAuthor, applies: string, scenarioSha256: string): CommentEntry {
  return { id: newCommentEntryId(), kind: 'apply', author, text: '', created_at: new Date().toISOString(), applies, scenario_sha256: scenarioSha256 };
}

/**
 * Write `entry` appended to thread `r` (read under its lock, which the caller holds): appendedThread, written atomically
 * with the hash just read.
 */
async function writeAppended(project: LoadedProject, f: ThreadFile, r: { thread: CommentThread; hash: string }, entry: CommentEntry): Promise<CommentWritten> {
  const next = appendedThread(f.id, r, entry);
  // The thread's lock already serialises every write of its file: no second (write) lock inside it.
  const written = await new LocalStorage(project.dir).writeText(f.ref, next.text, { ifMatch: r.hash, locked: true });
  return { thread: await threadView(project.dir, next.thread, written.sha256, await renderIndex(project.dir)), entry: entry.id, hash: written.sha256 };
}

/** `ifMatch` (the thread's hash as the caller read it) against the hash read under the lock: a conflict naming it. */
function checkIfMatch(f: ThreadFile, hash: string, ifMatch: string | undefined): void {
  if (ifMatch !== undefined && ifMatch !== hash) {
    throw new EngineError('conflict', `${f.ref} changed since it was read (if_match does not match): read it again (its new entries may answer it)`, {
      details: { current: hash },
      fix: `read the thread again and pass if_match: "${hash}"`,
    });
  }
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
    checkIfMatch(f, r.hash, o.ifMatch);
    if (r.thread.entries.length >= COMMENT_ENTRIES_MAX) throw new EngineError('refused', `comment ${id} has ${COMMENT_ENTRIES_MAX} entries: start a new thread`);
    return await writeAppended(project, f, r, await make(r.thread, r.hash));
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
  o: { proposal?: ProposalInput; registry?: () => Promise<ComponentRegistry> } = {},
): Promise<CommentWritten> {
  const text = cleanText(rawText, 'the reply', 'text');
  if (o.proposal === undefined) {
    return appendEntry(project, id, 'reply', () => ({ id: newCommentEntryId(), kind: 'reply', author, text, created_at: new Date().toISOString() }));
  }
  // The target is the thread's own scenario (its folder, checked against the file by readThread): never an argument.
  const f = await locateThread(project.dir, id);
  const built = await buildProposal(project, f.scenario, o.proposal, o.registry ? { registry: o.registry } : {});
  const w = await appendEntry(project, id, 'reply', (thread) => {
    const { status } = deriveStatus(thread.entries);
    if (status !== 'open') throw new EngineError('conflict', `not proposed: comment ${id} is resolved — a proposal answers an open thread (a person reopens it)`, { details: { status } });
    return { id: newCommentEntryId(), kind: 'reply', author, text, created_at: new Date().toISOString(), proposal: built.proposal };
  });
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

/**
 * Reopen a resolved thread (a person disagreeing with its resolution); the note may be empty. `ifMatch`: the thread's
 * hash as last read (the Studio reopens the version it showed; refused as a conflict when it changed since).
 */
export async function reopenComment(project: LoadedProject, id: string, rawNote: string | undefined, author: CommentAuthor, o: { ifMatch?: string } = {}): Promise<CommentWritten> {
  const note = cleanText(rawNote ?? '', 'the note', 'note', false);
  if (o.ifMatch !== undefined && (typeof o.ifMatch !== 'string' || !/^[0-9a-f]{64}$/.test(o.ifMatch))) throw argError('if_match', 'if_match is the hash a listing returned (64 hex characters)');
  return appendEntry(
    project,
    id,
    'reopen',
    (thread) => {
      if (deriveStatus(thread.entries).status !== 'resolved') throw new EngineError('conflict', `comment ${id} is open: only a resolved thread is reopened`, { details: { status: 'open' } });
      return { id: newCommentEntryId(), kind: 'reopen', author, text: note, created_at: new Date().toISOString() };
    },
    o.ifMatch !== undefined ? { ifMatch: o.ifMatch } : {},
  );
}

// ── Proposals: apply, the diff shown, the preview (L4.6, R-UI-28) ─────────────

/** The proposal entry of a thread named by `entryId` (default: the newest proposal). */
function proposalEntry(thread: CommentThread, entryId: string | undefined): CommentEntry & { proposal: CommentProposal } {
  if (entryId !== undefined && (typeof entryId !== 'string' || !COMMENT_ENTRY_ID_RE.test(entryId))) {
    throw argError('entry_id', `invalid entry id "${String(entryId).slice(0, 80)}": r_ + 26 characters (the thread's entries name them)`);
  }
  const withProposal = thread.entries.filter((e): e is CommentEntry & { proposal: CommentProposal } => e.proposal !== undefined);
  if (entryId === undefined) {
    const last = withProposal.at(-1);
    if (!last) throw new EngineError('not_found', `comment ${thread.id} holds no proposal`);
    return last;
  }
  const e = thread.entries.find((x) => x.id === entryId);
  if (!e) throw new EngineError('not_found', `comment ${thread.id} has no entry ${entryId}`);
  if (!e.proposal) throw argError('entry_id', `entry ${entryId} of comment ${thread.id} holds no proposal`);
  return e as CommentEntry & { proposal: CommentProposal };
}

/** Why a proposal cannot be applied or previewed now (its state, the thread's status), as an EngineError; null: it can. */
function notActionable(thread: CommentThread, entry: CommentEntry & { proposal: CommentProposal }, today: ScenarioText, stage: 'applied' | 'previewed'): EngineError | null {
  const { status } = deriveStatus(thread.entries);
  if (status !== 'open') return new EngineError('conflict', `not ${stage}: comment ${thread.id} is resolved — reopen it first`, { details: { status } });
  const st = proposalStates(thread.entries, today.hash).find((x) => x.entry === entry.id)!;
  if (st.actionable) return null;
  const newest = thread.entries.filter((e) => e.proposal).at(-1)!.id;
  switch (st.state) {
    case 'applied':
      return new EngineError('conflict', `not ${stage}: the proposal of entry ${entry.id} is already applied (${today.file} is its text)`, { details: { state: st.state, current: today.hash } });
    case 'superseded':
    case 'undone':
      return new EngineError('conflict', `not ${stage}: a newer proposal (entry ${newest}) replaces the one of entry ${entry.id}`, { details: { state: st.state, newest } });
    default:
      return new EngineError('conflict', `not ${stage}: ${today.file} changed since this was proposed — ask Claude to propose again on today's file`, { details: { state: st.state, current: today.hash } });
  }
}

export interface CommentApplyRequest {
  /** The reply holding the proposal (the newest proposal of the thread, pending or undone). */
  entry_id: string;
  /** The thread's hash as last read (the version the page showed): a conflict when it changed since. */
  ifMatch?: string;
}

export interface CommentApplied {
  thread: CommentView;
  /** The thread's hash after the apply entry (its hash before when the entry could not be appended). */
  hash: string;
  /** The apply entry, absent when it could not be appended (the state still reads `applied` from the file's hash). */
  entry?: string;
  scenario: {
    name: string;
    file: string;
    /** sha256 of the bytes written (= the proposal's result_sha256). */
    hash: string;
    /** The file before (the proposal's base): Undo apply restores it (scenarios.edit `restore`: a version the engine read). */
    previous: { text: string; hash: string };
  };
  label: string;
  change: 'edit';
  /** The scenario's validation warnings for the text written. */
  warnings: ValidationIssue[];
  /** What went wrong after the write (the apply entry not appended), in words. */
  problems: string[];
}

/**
 * Apply a thread's proposal (L4.6, a person channel: Engine.comments allows `cli` and `ui` only): under the thread's
 * lock, held across the scenario write and the apply entry (critique B5: thread lock → storage write lock, nothing takes
 * them the other way), the thread read with `ifMatch`, open, the entry its newest pending (or undone) proposal; the
 * text rebuilt from today's file and checked (rebuildProposal: base hash, strict hunks, result hash, canonical diff) and
 * edit-only; then written by editScenario itself (`replace_text` with agent trust from the Studio: every L4.3 rule runs
 * again at the moment of the write — a planted thread is refused here); then the apply entry is appended with no
 * second hash check (a failure there is a problem in words, never a failed answer: the file's hash says `applied`).
 */
export async function applyProposal(
  project: LoadedProject,
  id: string,
  req: CommentApplyRequest,
  author: CommentAuthor,
  o: { registry?: () => Promise<ComponentRegistry> } = {},
): Promise<CommentApplied> {
  if (req.ifMatch !== undefined && (typeof req.ifMatch !== 'string' || !/^[0-9a-f]{64}$/.test(req.ifMatch))) throw argError('if_match', 'if_match is the hash a listing returned (64 hex characters)');
  if (typeof req.entry_id !== 'string' || !COMMENT_ENTRY_ID_RE.test(req.entry_id)) throw argError('entry_id', `invalid entry id "${String(req.entry_id).slice(0, 80)}": r_ + 26 characters`);
  const f = await locateThread(project.dir, id);
  const lock = await lockThread(project.dir, id, 'apply');
  try {
    const r = await readThread(project.dir, f);
    if (!r.ok) throw new EngineError('invalid', `${r.problem} — the file is never overwritten: fix it or remove it`);
    checkIfMatch(f, r.hash, req.ifMatch);
    const entry = proposalEntry(r.thread, req.entry_id);
    const today = await getScenario(project, r.thread.scenario);
    const why = notActionable(r.thread, entry, today, 'applied');
    if (why) throw why;
    const text = rebuildProposal(today, entry.proposal, 'applied');
    // Edit-only and the Studio's checks once more before the write (editScenario repeats the latter while writing).
    await checkProposedText(project, r.thread.scenario, today, text, 'applied', o);
    // The apply entry must fit the thread (entries, size) before the scenario is written (review A L5 / B M3): a full
    // thread refuses with nothing changed. The entry written after names the hash editScenario returns (= this one).
    try {
      appendedThread(id, r, applyEntryOf(author, entry.id, entry.proposal.result_sha256));
    } catch (e) {
      if (e instanceof EngineError) throw new EngineError(e.code, `not applied: ${e.message} — nothing was written`, e.details !== undefined ? { details: e.details } : {});
      throw e;
    }
    let edited: Awaited<ReturnType<typeof editScenario>>;
    try {
      edited = await editScenario(project, r.thread.scenario, { hash: entry.proposal.base_sha256, edit: { kind: 'replace_text', text } }, { agent: true, via: 'studio', ...(o.registry ? { registry: o.registry } : {}) });
    } catch (e) {
      if (e instanceof EngineError && e.message.startsWith('not saved: ')) throw new EngineError(e.code, e.message.replace(/^not saved: /, 'not applied: '), { ...(e.details !== undefined ? { details: e.details } : {}), ...(e.fix !== undefined ? { fix: e.fix } : {}) });
      throw e;
    }
    const problems: string[] = [];
    let written: CommentWritten | undefined;
    try {
      written = await writeAppended(project, f, r, applyEntryOf(author, entry.id, edited.hash));
    } catch (e) {
      problems.push(`the apply was written to ${edited.file} but not recorded in the thread (${(e as Error).message.split('\n')[0]}): the thread reads the proposal as applied from the file`);
    }
    const thread = written?.thread ?? (await threadView(project.dir, r.thread, r.hash, await renderIndex(project.dir)));
    return {
      thread,
      hash: written?.hash ?? r.hash,
      ...(written ? { entry: written.entry } : {}),
      scenario: { name: r.thread.scenario, file: edited.file, hash: edited.hash, previous: { text: today.yaml, hash: today.hash } },
      label: `Applied the proposal of comment ${id}`,
      change: 'edit',
      warnings: edited.warnings,
      problems,
    };
  } finally {
    lock.releaseSync();
  }
}

export interface CommentProposalView {
  project: string;
  comment_id: string;
  scenario: string;
  /** The reply holding it. */
  entry: string;
  status: 'open' | 'resolved';
  /** The thread's hash (the `if_match` of an apply). */
  hash: string;
  state: ProposalState;
  actionable: boolean;
  delta: CommentProposal['delta'];
  base_sha256: string;
  result_sha256: string;
  /** sha256 of today's file (null: not readable). */
  today_sha256: string | null;
  added: number;
  removed: number;
  hunks: number;
  /** Changed lines over the lines of both versions, in % (critique B13: say it past PROPOSAL_REWRITE_NOTE_PCT). */
  rewrites_pct?: number;
  /**
   * The rows are the canonical diff of the exact bytes (critique B1: rebuilt from today's file — pending, undone or
   * applied — and checked: result hash, canonical hunks), with context lines. False: the hunks as stored (the file is
   * neither its base nor its result), no context.
   */
  verified: boolean;
  /**
   * Pending or undone: the proposed text's filmed part equals the commented run's snapshot — it renders on that take
   * (critique B2: "Apply and re-render", "Preview change"); false when it does not or the run is gone.
   */
  same_take?: boolean;
  /**
   * Actionable, yet Apply would refuse it now (review A L4): the same checks as Apply's before its write — the text
   * rebuilt (base, strict hunks, result hash, canonical, rows), the Studio's write checks, edit-only, no theme change,
   * the apply entry fitting the thread — in the tool's words, project-relative. Absent: Apply would go ahead.
   */
  blocked?: string;
  rows: ProposalRow[];
  /** Data written by an agent: the text of each row (rows[i] ↔ untrusted.rows[i]; '' for a gap). */
  untrusted: { rows: string[] };
}

/**
 * A proposal as a person reads it (critique B1, B15): its state and the diff computed by the engine from the file —
 * rebuilt from today's file when it is the base (pending, undone) or the result (applied), checked (result hash,
 * canonical hunks) and shown with context; otherwise the stored hunks, unverified. Lines are data (`untrusted.rows`).
 */
export async function getProposal(project: LoadedProject, id: string, entryId?: string, o: { registry?: () => Promise<ComponentRegistry> } = {}): Promise<CommentProposalView> {
  const f = await locateThread(project.dir, id);
  const r = await readThread(project.dir, f);
  if (!r.ok) throw new EngineError('invalid', r.problem);
  const entry = proposalEntry(r.thread, entryId);
  const p = entry.proposal;
  let today: ScenarioText | null = null;
  try {
    today = await getScenario(project, r.thread.scenario);
  } catch (e) {
    if (!(e instanceof EngineError && e.code === 'not_found')) throw e;
  }
  const { status } = deriveStatus(r.thread.entries);
  const st = proposalStates(r.thread.entries, today?.hash ?? null).find((x) => x.entry === entry.id)!;
  const stats = hunkStats(p.hunks);
  let base: string[] | undefined;
  let result: string[] | undefined;
  if (today && (st.state === 'pending' || st.state === 'undone')) {
    try {
      const text = rebuildProposal(today, p, 'previewed');
      base = textLines(today.yaml);
      result = textLines(text);
    } catch {
      /* a tampered proposal: shown unverified */
    }
  } else if (today && st.state === 'applied') {
    // Today's file is the result: the base is the hunks undone, checked against the base hash and the canonical diff.
    const eol = textEol(today.yaml);
    try {
      const after = textLines(today.yaml);
      const before = applyHunks(after, invertHunks(p.hunks));
      const canonical = diffLines(before, after, { maxChanged: PROPOSAL_CHANGED_LINES_MAX });
      // The base may have had no final line break (Apply writes one): both spellings of the base are its hash (review B L1).
      const baseOk = sha256Hex(joinLines(before, eol)) === p.base_sha256 || sha256Hex(before.join(eol)) === p.base_sha256;
      if (baseOk && canonical && sameHunks(canonical, p.hunks)) {
        base = before;
        result = after;
      }
    } catch {
      /* shown unverified */
    }
  }
  const verified = base !== undefined && result !== undefined;
  // What Apply would say now (review A L4): its checks before the write, run only for a proposal it would take.
  let blocked: string | undefined;
  if (today && status === 'open' && st.actionable) {
    try {
      const text = rebuildProposal(today, p, 'applied');
      await checkProposedText(project, r.thread.scenario, today, text, 'applied', o);
      appendedThread(r.thread.id, r, applyEntryOf({ via: 'studio', name: 'x'.repeat(COMMENT_AUTHOR_MAX) }, entry.id, p.result_sha256)); // the longest name: never offered when Apply would not fit
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      const words = e.message.split(`${project.dir}/`).join('').split(project.dir).join('.');
      blocked = words.startsWith('not applied: ') ? words : `not applied: ${words}`;
    }
  }
  const { rows, texts } = verified
    ? diffRows(base!, p.hunks, PROPOSAL_CONTEXT_LINES)
    : (() => {
        const out: { rows: ProposalRow[]; texts: string[] } = { rows: [], texts: [] };
        for (const h of p.hunks) {
          h.del.forEach((l, j) => (out.rows.push({ kind: 'del', base: h.at + j }), out.texts.push(l)));
          h.add.forEach((l) => (out.rows.push({ kind: 'add' }), out.texts.push(l)));
        }
        return out;
      })();
  let sameTake: boolean | undefined;
  if (verified && (st.state === 'pending' || st.state === 'undone')) {
    let since: ReturnType<typeof scenarioSinceRun>;
    try {
      since = scenarioSinceRun(project, join(project.dir, 'runs', checkRunId(r.thread.render.run_id)), r.thread.scenario, joinLines(result!, textEol(today!.yaml)));
    } catch {
      since = undefined;
    }
    sameTake = since !== undefined && since.filmed !== undefined && since.filmed.length === 0;
  }
  return {
    project: project.slug,
    comment_id: r.thread.id,
    scenario: r.thread.scenario,
    entry: entry.id,
    status,
    hash: r.hash,
    state: st.state,
    actionable: st.actionable && status === 'open',
    delta: p.delta,
    base_sha256: p.base_sha256,
    result_sha256: p.result_sha256,
    today_sha256: today?.hash ?? null,
    added: stats.added,
    removed: stats.removed,
    hunks: p.hunks.length,
    ...(verified ? { rewrites_pct: Math.round((100 * stats.changed) / Math.max(1, base!.length + result!.length)) } : {}),
    verified,
    ...(sameTake !== undefined ? { same_take: sameTake } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
    rows,
    untrusted: { rows: texts },
  };
}

/** A proposal checked for the timeline's preview (critique B9): the text to plan and where it comes from. */
export interface ProposalPreview {
  comment_id: string;
  entry: string;
  /** The exact bytes Apply would write (never registered as a version of the file). */
  text: string;
  result_sha256: string;
  /** The commented take: the preview plans the proposed text on it. */
  run_id: string;
  /** Today's file hash (the proposal's base). */
  base_sha256: string;
  thread: CommentThread;
}

/**
 * The proposed text of a thread's actionable proposal for the timeline's preview (critique B9): the thread of
 * `scenario`, open, the entry its newest pending (or undone) proposal, today's file its base, the text rebuilt and
 * checked (rebuildProposal) and passed through the Studio's full write checks (prepareScenarioEdit: agent trust,
 * hooks, vars / env) — nothing written, no version remembered. Run on every preview (outside any memo).
 */
export async function proposalForPreview(
  project: LoadedProject,
  scenario: string,
  req: { comment_id: string; entry_id: string },
  o: { registry?: () => Promise<ComponentRegistry> } = {},
): Promise<ProposalPreview> {
  const f = await locateThread(project.dir, req.comment_id);
  const r = await readThread(project.dir, f);
  if (!r.ok) throw new EngineError('invalid', r.problem);
  if (r.thread.scenario !== scenario) throw argError('proposal', `comment ${r.thread.id} is a comment on ${r.thread.scenario}, not on ${scenario}`);
  if (typeof req.entry_id !== 'string' || !COMMENT_ENTRY_ID_RE.test(req.entry_id)) throw argError('entry_id', `invalid entry id "${String(req.entry_id).slice(0, 80)}": r_ + 26 characters`);
  const entry = proposalEntry(r.thread, req.entry_id);
  const today = await getScenario(project, scenario);
  const why = notActionable(r.thread, entry, today, 'previewed');
  if (why) throw why;
  const text = rebuildProposal(today, entry.proposal, 'previewed');
  await checkProposedText(project, scenario, today, text, 'previewed', o);
  return { comment_id: r.thread.id, entry: entry.id, text, result_sha256: entry.proposal.result_sha256, run_id: checkRunId(r.thread.render.run_id), base_sha256: today.hash, thread: r.thread };
}

// ── Counts and pins from the thread files alone (L4.6, critique B8) ─────────

/** Scenario folders of comments/ one count reads, at most (as the `comments:` sources). */
export const COMMENT_COUNT_MAX_FOLDERS = 200;

/** What a count or a pin needs of one thread file: its status and where it points (no view, no render record). */
export interface CommentSummary {
  id: string;
  scenario: string;
  render_id: string;
  render_created_at: string;
  frame: number;
  status: 'open' | 'resolved';
}

export interface CommentCountsView {
  project: string;
  /** Per scenario folder holding threads: open and resolved threads. */
  scenarios: Record<string, { open: number; resolved: number }>;
  /** Thread files that do not read as threads (a link, a broken file…): left out of the counts. */
  problems: number;
}

type Summarised = { sig: string; summary: CommentSummary | null };

/**
 * Thread summaries of a project's scenario folders, read from the thread files only (readThread: the same checks as a
 * listing) and memoised per file signature (inode, size, mtime): a count after a reply reads one file. No render
 * record, no still, no scenario text is read (a listing reads all three per thread).
 */
export class CommentIndex {
  /** `<project dir>\0<scenario>` → file name → its signature and summary (null: not a valid thread). */
  private readonly memo = new Map<string, Map<string, Summarised>>();
  /** Thread files read (parsed) since this index was made: for tests. */
  readonly stats = { reads: 0 };

  /** The summaries of one scenario folder, in file name order (≤ COMMENT_LIST_MAX_FILES); problems counted. */
  async ofScenario(projectDir: string, scenario: string): Promise<{ threads: CommentSummary[]; problems: number }> {
    checkScenarioName(scenario);
    const root = join(projectDir, COMMENTS_DIR);
    if ((await realDir(root)) !== 'ok') return { threads: [], problems: 0 };
    const state = await realDir(join(root, scenario));
    const key = `${projectDir}\0${scenario}`;
    if (state !== 'ok') {
      this.memo.delete(key);
      return { threads: [], problems: state === 'missing' ? 0 : 1 };
    }
    // The exact folder name on disk (a case-insensitive disk would also open "Quote/" for "quote").
    if (!(await readdir(root)).includes(scenario)) return { threads: [], problems: 0 };
    const old = this.memo.get(key) ?? new Map<string, Summarised>();
    const next = new Map<string, Summarised>();
    const threads: CommentSummary[] = [];
    let problems = 0;
    const names = (await readdir(join(root, scenario))).filter((n) => THREAD_FILE_RE.test(n)).sort();
    for (const name of names.slice(0, COMMENT_LIST_MAX_FILES)) {
      const path = join(root, scenario, name);
      const st = await lstatOrNull(path);
      if (!st) continue;
      if (st.isSymbolicLink() || !st.isFile()) {
        problems++;
        continue;
      }
      const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
      let got = old.get(name);
      if (!got || got.sig !== sig) {
        this.stats.reads++;
        const id = name.slice(0, -'.json'.length);
        const r = await readThread(projectDir, { scenario, id, ref: commentRef(scenario, id), path });
        got = {
          sig,
          summary: r.ok
            ? { id, scenario, render_id: r.thread.render.id, render_created_at: r.thread.render.created_at, frame: r.thread.frame, status: deriveStatus(r.thread.entries).status }
            : null,
        };
      }
      next.set(name, got);
      if (got.summary) threads.push(got.summary);
      else problems++;
    }
    if (names.length > COMMENT_LIST_MAX_FILES) problems++;
    this.memo.set(key, next);
    return { threads, problems };
  }

  /** Open and resolved threads per scenario folder of a project (one scenario: `scenario`). */
  async counts(project: LoadedProject, o: { scenario?: string } = {}): Promise<CommentCountsView> {
    const out: CommentCountsView = { project: project.slug, scenarios: {}, problems: 0 };
    let folders: string[];
    if (o.scenario !== undefined) folders = [checkScenarioName(o.scenario)];
    else {
      const root = join(project.dir, COMMENTS_DIR);
      if ((await realDir(root)) !== 'ok') return out;
      folders = (await readdir(root)).filter((n) => SLUG_RE.test(n)).sort().slice(0, COMMENT_COUNT_MAX_FOLDERS);
    }
    for (const scenario of folders) {
      const { threads, problems } = await this.ofScenario(project.dir, scenario);
      out.problems += problems;
      if (!threads.length) continue;
      const c = { open: 0, resolved: 0 };
      for (const t of threads) c[t.status]++;
      out.scenarios[scenario] = c;
    }
    return out;
  }
}
