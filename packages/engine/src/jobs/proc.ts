/**
 * Who a process is (jobs and the worker lock): a pid AND its start time (`ps -o lstart`, sandbox proc.ts), so a pid
 * the system reused for another program never passes for a worker. Loaded lazily: the sandbox package pulls pg.
 */

/** Two start times this close (ms) are the same process (lstart has a 1-second resolution). */
const START_TOLERANCE_MS = 2000;

export interface ProcessIdentity {
  pid: number;
  /** Start time (ISO), from ps; absent when ps gave none. */
  started_at?: string;
}

let own: ProcessIdentity | undefined;

/** This process, with its start time as ps reports it (read once). */
export async function selfIdentity(): Promise<ProcessIdentity> {
  if (own) return own;
  const { processStart } = await import('@demo-studio/sandbox');
  const t = await processStart(process.pid);
  own = { pid: process.pid, ...(t !== null ? { started_at: new Date(t).toISOString() } : {}) };
  return own;
}

/** A process's start time (ms since the epoch, from ps), or null. */
export async function processStart(pid: number): Promise<number | null> {
  const { processStart: start } = await import('@demo-studio/sandbox');
  return start(pid);
}

/** Is the process `id` names still running (same pid, same start time)? */
export async function isAlive(id: ProcessIdentity): Promise<boolean> {
  const { processStart, signalState } = await import('@demo-studio/sandbox');
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
