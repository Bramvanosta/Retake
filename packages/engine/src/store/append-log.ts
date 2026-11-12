/**
 * The one append discipline of the workspace's line logs (L7.26, U15): the journal of authored writes and hook runs
 * (store/journal.ts, `.retake/journal.jsonl`) and the job history (history.ts, `.retake/history.jsonl`) — each its own
 * file and its own readers, both written and read here, with the same guarantee:
 *
 * - **One line at a time.** An append holds the log's lock (`<workspace>/.retake/locks/<log>.lock`: created whole, stale
 *   only when its process is gone — project-lock.ts), so a line's bytes are written together whatever the processes
 *   (the Studio, an MCP server, a worker, a terminal). The appends of one process queue in memory first (one chain per
 *   workspace and log), so only another process's append meets the lock file. The lock cannot be had (a live holder past LOG_LOCK_WAIT_MS, a
 *   `.retake/locks` that is not a real folder): the line is appended anyway, unlocked — O_APPEND keeps a single write
 *   whole —, never dropped for a lock.
 * - **A torn last line is closed, never lost twice.** A crash mid-write leaves a last line without its line break: the
 *   next append writes the break first, so only the torn line is lost (its readers skip it) and every later line is
 *   whole. Under the lock it is closed once.
 * - **Synced before the reply.** The line is written whole (a short write goes on from where it stopped), then fsync'd,
 *   before the append returns: it survives a crash of Retake or of the system, not a power loss on macOS (fsync does
 *   not flush the drive's cache there).
 * - **Opened to append only**: O_APPEND | O_CREAT, never truncated; the log file itself is never followed when it is a
 *   symbolic link (O_NOFOLLOW: the append fails and is said). The folders above it are another rule's: a linked
 *   `.retake/locks` is refused by the lock (project-lock.ts toolDir: the line then goes unlocked).
 * - **The same reader**: readLogLines (oldest first) and logLinesFromEnd (newest first) yield every non-empty line; each
 *   log's parser skips a torn or foreign one.
 *
 * A normal line's bytes are its writer's: this module adds nothing to them (a `\n` before one only after a torn line).
 */
import { constants, mkdir, open, readFile } from 'node:fs/promises';
import { STATE_DIR, statePath } from '@retake/core';
import { opChain } from '../admission.js';
import { EngineError } from '../errors.js';
import { takeProjectLock } from '../project-lock.js';

/** A line log of the workspace's state folder. */
export interface AppendLog {
  /** Its file name in `<workspace>/.retake/` (`journal.jsonl`, `history.jsonl`). */
  file: string;
  /** Its lock's name in `<workspace>/.retake/locks/`. */
  lock: string;
  /** The mode it is created with (the process's umask applies). */
  mode: number;
}

/** How long an append waits for a live holder of its log's lock before it appends unlocked (ms). */
export const LOG_LOCK_WAIT_MS = 5_000;

/** The in-process side of the logs' locks: one chain per workspace and log, FIFO, in front of the lock file. */
const IN_PROCESS = opChain();

/** Appending only (read too, for the last byte), created when missing, never through a symbolic link. */
const APPEND_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/** The log's file of a workspace. */
export function logFile(root: string, log: AppendLog): string {
  return statePath(root, undefined, log.file);
}

/** Write `bytes` whole at the end of an O_APPEND file (a short write goes on from where it stopped). */
async function writeWhole(fh: import('node:fs/promises').FileHandle, bytes: Buffer): Promise<void> {
  let at = 0;
  while (at < bytes.length) {
    const { bytesWritten } = await fh.write(bytes, at, bytes.length - at);
    if (bytesWritten <= 0) throw new Error('the line could not be written whole');
    at += bytesWritten;
  }
}

/** The log's lock, or undefined when it cannot be had (the line is then appended unlocked). */
async function logLock(root: string, log: AppendLog): Promise<{ release(): Promise<void> } | undefined> {
  try {
    return await takeProjectLock(root, log.lock, {
      command: `append ${log.file}`,
      what: `${STATE_DIR}/${log.file}`,
      waitMs: LOG_LOCK_WAIT_MS,
      busy: (ref) => new EngineError('busy', `${ref} is held`),
    });
  } catch {
    return undefined;
  }
}

/**
 * Append one line (`line`: its text with its final `\n`) to a workspace's log, under its lock, synced before returning.
 * The state folder is created when missing; a torn last line is closed first. Throws when the line could not be written
 * (each log's writer says so: it never fails the work the line records).
 */
export async function appendLogLine(root: string, log: AppendLog, line: string): Promise<void> {
  return IN_PROCESS(`${root}\0${log.lock}`, () => appendLocked(root, log, line));
}

/** The append itself, this process's turn come: the state folder, the lock file, then the line. */
async function appendLocked(root: string, log: AppendLog, line: string): Promise<void> {
  await mkdir(statePath(root), { recursive: true });
  const lock = await logLock(root, log);
  try {
    const fh = await open(logFile(root, log), APPEND_FLAGS, log.mode);
    try {
      const { size } = await fh.stat();
      let head = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) head = '\n';
      }
      await writeWhole(fh, Buffer.from(head + line, 'utf8'));
      await fh.sync();
    } finally {
      await fh.close();
    }
  } finally {
    await lock?.release();
  }
}

/** How often a log that cannot be written is said on stderr. */
const WARN_EVERY_MS = 60_000;

/**
 * A log's warning when a line cannot be written: on stderr, at most once a minute, with the count lost since the last
 * one (`label`: how the warning names the log).
 */
export function logWarner(label: string): (e: unknown) => void {
  let lastWarn = Number.NEGATIVE_INFINITY;
  let lost = 0;
  return (e) => {
    lost++;
    const now = Date.now();
    if (now - lastWarn < WARN_EVERY_MS) return;
    lastWarn = now;
    const count = lost === 1 ? '' : ` (${lost} lines lost since the last warning)`;
    lost = 0;
    process.stderr.write(`retake: ${label} could not be written${count}: ${(e as Error).message}\n`);
  };
}

/** The log's non-empty lines, oldest first (a missing or unreadable file: none). */
export async function readLogLines(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim() !== '');
}

/** The bytes read at a time from the end of a log (logLinesFromEnd). */
const TAIL_CHUNK = 64 * 1024;

/** The log's non-empty lines, newest first, read backwards a chunk at a time (a line break is one byte in UTF-8). Throws when it cannot be opened. */
export async function* logLinesFromEnd(file: string): AsyncGenerator<string> {
  const fh = await open(file, 'r');
  try {
    let pos = (await fh.stat()).size;
    let carry = Buffer.alloc(0);
    while (pos > 0) {
      const n = Math.min(TAIL_CHUNK, pos);
      pos -= n;
      const chunk = Buffer.alloc(n);
      await fh.read(chunk, 0, n, pos);
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        if (end > i + 1) {
          const l = data.subarray(i + 1, end).toString('utf8');
          if (l.trim() !== '') yield l;
        }
        end = i;
      }
      carry = data.subarray(0, end);
    }
    if (carry.length) {
      const l = carry.toString('utf8');
      if (l.trim() !== '') yield l;
    }
  } finally {
    await fh.close();
  }
}
