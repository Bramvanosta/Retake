/**
 * The worker lock (<workspace>/.demo-studio/workers/worker.lock): one worker per workspace, so one job at a time
 * (concurrency 1: a capture is CPU- and GPU-heavy). It holds the worker's pid, start time and build. Created whole and
 * atomically (sandbox createExclusive); a lock whose process is gone — or whose pid belongs to another program now — is
 * stale and taken over under a breaker (sandbox breakStale), so two workers finding one stale lock never both take it.
 */
import { readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DEMO_STUDIO_VERSION } from '@demo-studio/core';
import { isAlive, selfIdentity } from './proc.js';
import type { ProcessIdentity } from './proc.js';
import { stateDir } from './queue.js';

export interface WorkerLockRecord extends ProcessIdentity {
  host: string;
  version: string;
  /** The code it runs (buildStamp): a worker of another build hands over once idle. */
  build: string;
  since: string;
}

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
    return typeof v?.pid === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** The lock as written, or null. */
export function readWorkerLock(root: string): WorkerLockRecord | null {
  return parse(readText(workerLockFile(root)));
}

/** The worker holding the workspace's lock, when it is alive. */
export async function liveWorker(root: string): Promise<WorkerLockRecord | null> {
  const held = readWorkerLock(root);
  return held && (await isAlive(held)) ? held : null;
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
  static async acquire(root: string, build: string, note?: (msg: string) => void): Promise<WorkerLock | null> {
    const { createExclusive, breakStale } = await import('@demo-studio/sandbox');
    await mkdir(workersDir(root), { recursive: true });
    const file = workerLockFile(root);
    const record: WorkerLockRecord = { ...(await selfIdentity()), host: hostname(), version: DEMO_STUDIO_VERSION, build, since: new Date().toISOString() };
    const text = JSON.stringify(record, null, 2);
    for (let tries = 0; tries < 200; tries++) {
      if (createExclusive(file, text)) return new WorkerLock(file, record);
      const seen = readText(file);
      if (seen === null) continue;
      const held = parse(seen);
      if (held && (await isAlive(held))) return null;
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
