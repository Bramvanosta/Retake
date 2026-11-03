/**
 * The worker lock (<workspace>/.retake/workers/worker.lock): one worker per workspace, so one job at a time
 * (concurrency 1: a capture is CPU- and GPU-heavy). It holds the worker's pid, start time and build. Created whole and
 * atomically (sandbox createExclusive); a lock whose process is gone — or whose pid belongs to another program now — is
 * stale and taken over under a breaker (sandbox breakStale), so two workers finding one stale lock never both take it.
 */
import { readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { RETAKE_VERSION } from '@retake/core';
import { isAlive, processStart, selfIdentity } from './proc.js';
import type { ProcessIdentity } from './proc.js';
import { stateDir } from './queue.js';

export interface WorkerLockRecord extends ProcessIdentity {
  host: string;
  version: string;
  /** The code it runs (buildStamp): a worker of another build hands over once idle. */
  build: string;
  since: string;
  /**
   * The client whose submit started it (L4.2: `ui`, `mcp`; absent: `retake worker` in a terminal, or an older build).
   * One worker serves the workspace, in the environment of whoever started it.
   */
  started_by?: string;
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
  static async acquire(root: string, build: string, note?: (msg: string) => void, startedBy?: string): Promise<WorkerLock | null> {
    const { createExclusive, breakStale } = await import('@retake/sandbox');
    await mkdir(workersDir(root), { recursive: true });
    const file = workerLockFile(root);
    const record: WorkerLockRecord = {
      ...(await selfIdentity()),
      host: hostname(),
      version: RETAKE_VERSION,
      build,
      since: new Date().toISOString(),
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
