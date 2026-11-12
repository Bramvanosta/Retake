/**
 * The take lock of a sandbox (`take.lock`): `run --sandbox`, `sandbox up | reset | down` hold it, so one sandbox films
 * one take at a time and nothing restarts or reseeds it under a run. A second command fails fast naming the holder.
 *
 * It is created whole and atomically — its record written to a file of its own, then hard-linked as take.lock (which
 * fails when one exists) —, so nobody ever reads a half-written lock. A lock whose process is gone — or whose pid now
 * belongs to another program (start time) — or that cannot be read is stale: removed with a note, under
 * `take.lock.break` (created exclusively; one left more than 10 s by a crash is removed), and only if it is still the
 * same file: two commands finding the same stale lock never both take it. Released when the command ends, and
 * synchronously if the process exits first.
 *
 * A file lock of core's io side (L7.25: from @retake/sandbox, which re-exports it): the sandbox's take lock, and the
 * engine's project locks (project-lock.ts) and worker lock (jobs/lock.ts: createExclusive, breakStale) are made with it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { SandboxError } from '../sandbox-error.js';
import { START_TOLERANCE_MS, processStartSync, signalState } from './proc.js';

/** A breaker older than this (ms) was left by a command that died while breaking a stale lock. */
export const BREAKER_STALE_MS = 10_000;
/** Tries before a command gives up on a lock that keeps changing under it. */
const MAX_TRIES = 200;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The lock file's text, or null when there is none. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseLock(text: string | null): LockRecord | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as LockRecord;
    return typeof v?.pid === 'number' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Create `file` with `text`, atomically and only if it does not exist: false when it does. A file system without hard
 * links falls back to an exclusive create.
 */
export function createExclusive(file: string, text: string): boolean {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Remove a stale lock whose text was `seen`, under the breaker: only when take.lock still has that text (another
 * command may have broken it and taken the lock meanwhile). True when it was removed by this call.
 */
export function breakStale(file: string, seen: string): boolean {
  const breaker = `${file}.break`;
  let fd: number;
  try {
    fd = openSync(breaker, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Another command is breaking it right now — or died doing so.
    try {
      if (Date.now() - statSync(breaker).mtimeMs > BREAKER_STALE_MS) rmSync(breaker, { force: true });
    } catch {
      /* gone meanwhile */
    }
    sleepSync(10);
    return false;
  }
  closeSync(fd);
  try {
    if (readText(file) !== seen) return false;
    rmSync(file, { force: true });
    return true;
  } finally {
    rmSync(breaker, { force: true });
  }
}

export interface LockRecord {
  pid: number;
  /** The holder's start time (ISO): a pid reused by another program is not the holder. */
  started_at?: string;
  /** What holds it: "run sandbox-quote", "sandbox up". */
  command: string;
  /** The run filmed under it, once known. */
  run?: string;
  since: string;
}

export function readLock(file: string): LockRecord | null {
  return parseLock(readText(file));
}

/** Does the process that wrote this lock still run? */
export function lockAlive(rec: LockRecord): boolean {
  // This process (a busy lock retried by another write of the same process): its start time is known — no `ps`.
  if (rec.pid === process.pid) return !rec.started_at || !selfStart() || Math.abs(Date.parse(rec.started_at) - Date.parse(selfStart()!)) <= START_TOLERANCE_MS;
  if (signalState(rec.pid) !== 'alive') return false;
  if (!rec.started_at) return true;
  const start = processStartSync(rec.pid);
  const recorded = Date.parse(rec.started_at);
  return start === null || !Number.isFinite(recorded) || Math.abs(start - recorded) <= START_TOLERANCE_MS;
}

/** "run 20261014-101500-quote (pid 4242) since 10:15:03". */
export function describeLock(rec: LockRecord): string {
  const since = new Date(rec.since);
  const at = Number.isNaN(since.getTime()) ? rec.since : since.toTimeString().slice(0, 8);
  return `${rec.run ? `run ${rec.run}` : rec.command} (pid ${rec.pid}) since ${at}`;
}

let ownStart: string | undefined;
function selfStart(): string | undefined {
  if (ownStart === undefined) {
    const t = processStartSync(process.pid);
    ownStart = t === null ? '' : new Date(t).toISOString();
  }
  return ownStart || undefined;
}

export class TakeLock {
  private released = false;
  private readonly onExit = () => this.releaseSync();

  private constructor(
    readonly file: string,
    private record: LockRecord,
  ) {
    process.once('exit', this.onExit);
  }

  /**
   * Take the lock for `command` (a stale one is removed and reported through `note`). Throws SandboxError busy when a
   * live process holds it.
   */
  static acquire(file: string, command: string, env: string, note?: (msg: string) => void): TakeLock {
    mkdirSync(dirname(file), { recursive: true });
    const record: LockRecord = { pid: process.pid, ...(selfStart() ? { started_at: selfStart() } : {}), command, since: new Date().toISOString() };
    const text = JSON.stringify(record, null, 2);
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      if (createExclusive(file, text)) return new TakeLock(file, record);
      const seen = readText(file);
      if (seen === null) continue; // released meanwhile
      const held = parseLock(seen);
      if (held && lockAlive(held)) {
        throw new SandboxError(`sandbox ${env} is in use: ${describeLock(held)} — wait for it (retake sandbox status shows it)`, 'busy');
      }
      if (breakStale(file, seen)) {
        note?.(held ? `removed a stale take lock of sandbox ${env}: ${describeLock(held)} is not running any more` : `removed an unreadable take lock of sandbox ${env}`);
      }
    }
    throw new SandboxError(`sandbox ${env}: its take lock (${file}) keeps changing — another command is taking it; try again`, 'busy');
  }

  /** Name the run filmed under the lock (status and a second command show it). */
  note(run: string): void {
    if (this.released) return;
    this.record = { ...this.record, run };
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.record, null, 2));
      renameSync(tmp, this.file);
    } catch {
      /* the lock still holds; only its label is older */
    }
  }

  releaseSync(): void {
    if (this.released) return;
    this.released = true;
    process.off('exit', this.onExit);
    const held = readLock(this.file);
    if (held && held.pid === process.pid && held.since === this.record.since) rmSync(this.file, { force: true });
  }

  async release(): Promise<void> {
    this.releaseSync();
  }
}
