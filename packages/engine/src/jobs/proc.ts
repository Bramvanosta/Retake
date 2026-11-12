/**
 * Who a process is (jobs and the worker lock): a pid AND its start time (`ps -o lstart`, core/io proc.ts — L7.25: was
 * the sandbox package's, loaded lazily for it pulls pg), so a pid the system reused for another program never passes
 * for a worker.
 */
import { START_TOLERANCE_MS, processStart as psStart, signalState } from '@retake/core/io';

export interface ProcessIdentity {
  pid: number;
  /** Start time (ISO), from ps; absent when ps gave none. */
  started_at?: string;
}

let own: ProcessIdentity | undefined;

/** This process, with its start time as ps reports it (read once). */
export async function selfIdentity(): Promise<ProcessIdentity> {
  if (own) return own;
  const t = await psStart(process.pid);
  own = { pid: process.pid, ...(t !== null ? { started_at: new Date(t).toISOString() } : {}) };
  return own;
}

/** A process's start time (ms since the epoch, from ps), or null. */
export async function processStart(pid: number): Promise<number | null> {
  return psStart(pid);
}

/** Is the process `id` names still running (same pid, same start time)? */
export async function isAlive(id: ProcessIdentity): Promise<boolean> {
  // 0 and negative pids name groups (kill(0) is this process's own group), 1 is launchd: never a worker of ours.
  if (!Number.isInteger(id.pid) || id.pid <= 1) return false;
  if (id.pid === process.pid) {
    const me = await selfIdentity();
    return !me.started_at || !id.started_at || me.started_at === id.started_at;
  }
  const state = signalState(id.pid);
  if (state === 'gone') return false;
  if (state === 'foreign') return false; // another user's process: never a worker of ours
  if (!id.started_at) return true;
  const start = await processStart(id.pid);
  const recorded = Date.parse(id.started_at);
  // No start time: it exited meanwhile, or ps cannot run (then the pid alone decides).
  if (start === null) return signalState(id.pid) === 'alive';
  return !Number.isFinite(recorded) || Math.abs(start - recorded) <= START_TOLERANCE_MS;
}
