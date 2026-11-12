/**
 * The worker lock (<workspace>/.retake/workers/worker.lock): one worker per workspace, so one capture and one heavy job
 * at a time (L5.14: captures first; a heavy job yields during a take — a capture is CPU- and GPU-heavy). It holds the worker's pid, start time and build. Created whole and
 * atomically (sandbox createExclusive); a lock whose process is gone — or whose pid belongs to another program now — is
 * stale and taken over under a breaker (sandbox breakStale), so two workers finding one stale lock never both take it.
 */
import { readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { RETAKE_VERSION } from '@retake/core';
import { breakStale, createExclusive, engineLocation } from '@retake/core/io';
import { isAlive, processStart, selfIdentity } from './proc.js';
import type { ProcessIdentity } from './proc.js';
import { stateDir } from '../workspace-state.js';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';

export interface WorkerLockRecord extends ProcessIdentity {
  host: string;
  /** The version it runs (a version's shape only: an odd one is dropped when the lock is read — review c A-L4). */
  version?: string;
  /** The code it runs (buildStamp): a worker of another build hands over once idle. */
  build: string;
  since: string;
  /**
   * The client whose submit started it (L4.2: `ui`, `mcp`; absent: `retake worker` in a terminal, or an older build).
   * One worker serves the workspace, in the environment of whoever started it.
   */
  started_by?: string;
  /**
   * L5.16c (critique M6): which copy of Retake it runs — the `.app` it runs from, or the repository checkout (core
   * engineLocation). Absent: an older build. A workspace's worker of another copy is said (doctor, the Studio, a submit).
   */
  engine?: string;
}

/** A recorded engine location: an absolute path, one line, at most 4096 characters (it is shown). */
// eslint-disable-next-line no-control-regex
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
function engineOk(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !HIDDEN_RE.test(v);
}

/** A recorded version (review c A-L4): a version's shape (`1.2.3`, an optional short suffix), at most 40 characters. */
export const LOCK_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+.][0-9A-Za-z.-]{1,20})?$/;
/** A recorded build stamp (core buildStamp: hex) and start time (ISO): anything else is dropped or replaced. */
const LOCK_BUILD_RE = /^[0-9A-Za-z._-]{1,64}$/;
const LOCK_SINCE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;

/**
 * The live worker when it runs another copy of Retake than `self` (an engine location) or another version: what doctor,
 * engine_info and a submit say. A lock without `engine` (an older build) counts by its version only.
 */
export function otherCopy(held: WorkerLockRecord | null, self: { engine: string; version: string }): { version: string; engine?: string } | null {
  if (!held) return null;
  const engineDiffers = held.engine !== undefined && held.engine !== self.engine;
  if (!engineDiffers && held.version === self.version) return null;
  return { version: held.version !== undefined && LOCK_VERSION_RE.test(held.version) ? held.version : '?', ...(held.engine !== undefined ? { engine: held.engine } : {}) };
}

/** A client name a worker may record as `started_by`. */
export const WORKER_CLIENT_RE = /^[a-z]{1,16}$/;

export function workersDir(root: string): string {
  return join(stateDir(root), 'workers');
}

export function workerLockFile(root: string): string {
  return join(workersDir(root), 'worker.lock');
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parse(text: string | null): WorkerLockRecord | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as WorkerLockRecord;
    if (typeof v?.pid !== 'number') return null;
    // A client name only (it is shown: doctor, retake jobs, the Studio's sidebar).
    if (v.started_by !== undefined && !(typeof v.started_by === 'string' && WORKER_CLIENT_RE.test(v.started_by))) delete v.started_by;
    if (v.engine !== undefined && !engineOk(v.engine)) delete v.engine;
    // Review c A-L4: every field that is shown has its shape (a lock is a file anyone of this user can write).
    if (v.version !== undefined && !(typeof v.version === 'string' && v.version.length <= 40 && LOCK_VERSION_RE.test(v.version))) delete v.version;
    if (!(typeof v.build === 'string' && LOCK_BUILD_RE.test(v.build))) v.build = '?';
    if (!(typeof v.since === 'string' && LOCK_SINCE_RE.test(v.since))) v.since = '?';
    if (!(typeof v.host === 'string' && v.host.length <= 255 && !HIDDEN_RE.test(v.host))) v.host = '?';
    return v;
  } catch {
    return null;
  }
}

/** The lock as written, or null. */
export function readWorkerLock(root: string): WorkerLockRecord | null {
  return parse(readText(workerLockFile(root)));
}

/**
 * Whether the process a lock names is its worker. A worker records its start time (ps): a lock without one names a pid
 * that cannot be told from any other process of the user (review A #7: a lock forged in the workspace naming the
 * Studio's own pid made it never start a worker, the sidebar saying "started by the Studio") — it counts only where ps
 * cannot tell this pid's start time either (then the pid alone decides, as before).
 */
async function holderAlive(held: WorkerLockRecord): Promise<boolean> {
  if (!held.started_at) return (await processStart(held.pid)) === null && (await isAlive(held));
  return isAlive(held);
}

/** The worker holding the workspace's lock, when it is alive. */
export async function liveWorker(root: string): Promise<WorkerLockRecord | null> {
  const held = readWorkerLock(root);
  return held && (await holderAlive(held)) ? held : null;
}

export class WorkerLock {
  private released = false;
  private readonly onExit = () => this.release();

  private constructor(
    readonly file: string,
    readonly record: WorkerLockRecord,
  ) {
    process.once('exit', this.onExit);
  }

  /** Take the lock, or null when a live worker holds it (`note` reports a stale lock taken over). */
  static async acquire(root: string, build: string, clock: Clock, note?: (msg: string) => void, startedBy?: string): Promise<WorkerLock | null> {
    await mkdir(workersDir(root), { recursive: true });
    const file = workerLockFile(root);
    const record: WorkerLockRecord = {
      ...(await selfIdentity()),
      host: hostname(),
      version: RETAKE_VERSION,
      build,
      engine: engineLocation(),
      since: stampOf(clock),
      ...(startedBy !== undefined && WORKER_CLIENT_RE.test(startedBy) ? { started_by: startedBy } : {}),
    };
    const text = JSON.stringify(record, null, 2);
    for (let tries = 0; tries < 200; tries++) {
      if (createExclusive(file, text)) return new WorkerLock(file, record);
      const seen = readText(file);
      if (seen === null) continue;
      const held = parse(seen);
      if (held && (await holderAlive(held))) return null;
      if (breakStale(file, seen)) note?.(held ? `took over a stale worker lock (pid ${held.pid} is not running any more)` : 'removed an unreadable worker lock');
    }
    return null;
  }

  /** Release it (also on exit): only if it is still this worker's. */
  release(): void {
    if (this.released) return;
    this.released = true;
    process.off('exit', this.onExit);
    const held = parse(readText(this.file));
    if (held && held.pid === this.record.pid && held.since === this.record.since) rmSync(this.file, { force: true });
  }
}
