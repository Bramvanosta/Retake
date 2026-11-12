/**
 * The comment store's files (see ../comments.ts): thread files `<project>/comments/<scenario>/<id>.json`, their stills
 * and locks under `<project>/.retake/`, read by id (never a path from a file), written through the project store.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, join, relative } from 'node:path';
import { COMMENTS_DIR, SLUG_RE } from '@retake/core/model';
import { COMMENT_ID_RE, ulidFileRe } from '@retake/core/ids';
import { statePath } from '@retake/core/project';
import { COMMENT_ENTRIES_MAX, CommentThreadSchema, commentAuthorName, commentText, commentTextProblem, newCommentEntryId } from '@retake/core/comments';
import type { LoadedProject } from '@retake/core/model';
import type { CommentAuthor, CommentEntry, CommentThread } from '@retake/core/comments';
import type { TakeLock } from '@retake/core/io';
import { EngineError } from '../errors.js';
import { lockHolder, takeProjectLock, toolDir } from '../project-lock.js';
import { sha256Hex } from '../storage.js';

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
export const RUN_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** The name of a thread file: its id + ".json". */
export const THREAD_FILE_RE = ulidFileRe('comment', 'json');
export const VARIANTS: readonly string[] = ['landscape', 'vertical', 'square'];

/** `comments/<scenario>/<id>.json`, the thread's project-relative ref. */
export function commentRef(scenario: string, id: string): string {
  return `${COMMENTS_DIR}/${scenario}/${id}.json`;
}

/** `<project>/.retake/comments/<id>.jpg`: the still of a thread (machine-local). */
export function commentStillFile(projectDir: string, id: string): string {
  return statePath(projectDir, 'comments', `${id}.jpg`);
}

/** `<project>/.retake/locks/comment-<id>.lock`: held while an entry is appended. */
export function commentLockFile(projectDir: string, id: string): string {
  return statePath(projectDir, 'locks', `comment-${id}.lock`);
}

/**
 * The name of the person at this terminal for `retake comment` (no `--author`): $RETAKE_AUTHOR, else the OS user
 * name (never git config: a subprocess and often a full name), printable, ≤ 80 characters.
 */
export function defaultAuthorName(): string {
  const env = process.env.RETAKE_AUTHOR;
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
export function argError(argument: string, message: string): EngineError {
  return new EngineError('invalid', message, { details: { argument } });
}

export function checkCommentId(id: string): string {
  if (typeof id !== 'string' || !COMMENT_ID_RE.test(id)) {
    throw argError('comment_id', `invalid comment id "${String(id).slice(0, 80)}": c_ + 26 characters (comment list names them), never a path`);
  }
  return id;
}

export function cleanText(raw: unknown, what: string, argument: string, required = true): string {
  if (typeof raw !== 'string') throw argError(argument, `${what} is a text`);
  const text = commentText(raw);
  const problem = commentTextProblem(text, { what, required });
  if (problem) throw argError(argument, problem);
  return text;
}

/** lstat, or null when it does not exist. */
export async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

/** A real folder (not a link) at `path`: 'ok', 'missing', or why not. */
export async function realDir(path: string): Promise<'ok' | 'missing' | 'a symbolic link' | 'not a folder'> {
  const st = await lstatOrNull(path);
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'a symbolic link';
  return st.isDirectory() ? 'ok' : 'not a folder';
}

/** A small regular file of the project read whole (null: missing, a link, too large or not a file). */
export async function readPlainFile(path: string, max: number): Promise<Buffer | null> {
  const st = await lstatOrNull(path);
  if (!st || !st.isFile() || st.size > max) return null;
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** The comments/ folder name that differs from `scenario` only by case (a case-insensitive disk would mix them), if any. */
export async function caseVariantFolder(projectDir: string, scenario: string): Promise<string | undefined> {
  const root = join(projectDir, COMMENTS_DIR);
  if ((await realDir(root)) !== 'ok') return undefined;
  const lower = scenario.toLowerCase();
  return (await readdir(root)).find((n) => n !== scenario && n.toLowerCase() === lower);
}

// ── Reading thread files ────────────────────────────────────────────────────

export interface ThreadFile {
  scenario: string;
  id: string;
  ref: string;
  path: string;
}

/** A thread file that is not read as a thread: why; `scenario`, the scenario a well-formed thread in the wrong place names. */
export type ReadResult = { ok: true; thread: CommentThread; hash: string } | { ok: false; problem: string; scenario?: string };

/** Read and check one thread file (its folders and the file itself real, not links; name = id; folder = scenario). */
export async function readThread(projectDir: string, f: ThreadFile): Promise<ReadResult> {
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
  if (thread.id !== f.id) return { ok: false, problem: `${f.ref} holds another thread's id (the file name must be its id)`, scenario: thread.scenario };
  if (thread.scenario !== f.scenario) return { ok: false, problem: `${f.ref} holds a thread of another scenario (the folder must be its scenario)`, scenario: thread.scenario };
  return { ok: true, thread, hash };
}

/** The thread file of `id`: its scenario folder found by scanning comments/ (real folders only); ambiguity refused. */
export async function locateThread(projectDir: string, id: string): Promise<ThreadFile> {
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

// ── Appending entries ───────────────────────────────────────────────────────

/**
 * The thread's lock: retried while a live process holds it (≤ COMMENT_LOCK_WAIT_MS); a dead holder's is broken. The
 * lock folder is a real folder of the project (toolDir); anything but a file at the lock path is refused. The lock file
 * is agent-writable: a busy error quotes its pid and a well-formed date only, its command printable, ≤ 80 characters,
 * under `details.untrusted`.
 */
export function lockThread(projectDir: string, id: string, op: string): Promise<TakeLock> {
  return takeProjectLock(projectDir, basename(commentLockFile(projectDir, id)), {
    command: `comment ${op} ${id}`,
    what: `comment ${id}`,
    waitMs: COMMENT_LOCK_WAIT_MS,
    retryMs: 50,
    busy: (ref, held) => {
      const { pid, since, command } = lockHolder(held);
      return new EngineError('busy', `comment ${id} is being written by another command${pid ? ` (pid ${pid}${since ? `, since ${since}` : ''})` : ''}: try again`, {
        fix: `try again in a moment; if no retake command is running, remove ${ref}`,
        ...(command ? { details: { untrusted: { command } } } : {}),
      });
    },
  });
}

/**
 * Thread `r` with `entry` appended, as it would be written: refused past COMMENT_ENTRIES_MAX entries or
 * COMMENT_FILE_MAX_BYTES (never a file that reads refuse), checked whole (CommentThreadSchema). Nothing written: Apply
 * runs it before its scenario write (review A L5 / B M3), so a full thread refuses before anything changes.
 */
export function appendedThread(id: string, r: { thread: CommentThread }, entry: CommentEntry): { thread: CommentThread; text: string } {
  if (r.thread.entries.length >= COMMENT_ENTRIES_MAX) throw new EngineError('refused', `comment ${id} has ${COMMENT_ENTRIES_MAX} entries: start a new thread`);
  const next = CommentThreadSchema.safeParse({ ...r.thread, entries: [...r.thread.entries, entry] });
  if (!next.success) throw new EngineError('invalid', `the entry does not make a valid thread: ${next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const text = `${JSON.stringify(next.data, null, 2)}\n`;
  if (Buffer.byteLength(text) > COMMENT_FILE_MAX_BYTES)
    throw new EngineError('refused', `comment ${id} would grow past ${COMMENT_FILE_MAX_BYTES / 1024 / 1024} MB with this entry: start a new thread`);
  return { thread: next.data, text };
}

/** The apply entry of a proposal (L4.6): the reply it applies and the sha256 of the file written, made at `at`. */
export function applyEntryOf(author: CommentAuthor, applies: string, scenarioSha256: string, at: string): CommentEntry {
  return { id: newCommentEntryId(), kind: 'apply', author, text: '', created_at: at, applies, scenario_sha256: scenarioSha256 };
}

/** A stamp of the length every `created_at` has: what an entry not written (a fit check) is made at. */
export const FIT_STAMP = '1970-01-01T00:00:00.000Z';

/** `ifMatch` (the thread's hash as the caller read it) against the hash read under the lock: a conflict naming it. */
export function checkIfMatch(f: ThreadFile, hash: string, ifMatch: string | undefined): void {
  if (ifMatch !== undefined && ifMatch !== hash) {
    throw new EngineError('conflict', `${f.ref} changed since it was read (if_match does not match): read it again (its new entries may answer it)`, {
      details: { current: hash },
      fix: `read the thread again and pass if_match: "${hash}"`,
    });
  }
}
