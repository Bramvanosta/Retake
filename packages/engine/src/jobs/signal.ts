/**
 * The one way a jobs worker signals a job process or its tree (L5.14a fixes, review B L1): every target is checked
 * first. A pid that is not an integer above 1 (a failed spawn's -1, a forged 0 or 1: `kill(0)` is this process's own
 * group, `kill(-1)` every process of the user, 1 is launchd), this process itself, or this process's own group never
 * reaches `process.kill` — whatever recorded or computed it (the spawn failure window, recovery from a job.json, a cancel,
 * the QoS hold's tree).
 */
import { execFileSync } from 'node:child_process';
import { processTable } from '@retake/core/io';
import type { ProcInfo } from '@retake/core/io';

/** Sends a signal (process.kill; tests record instead). */
export type KillFn = (target: number, sig: NodeJS.Signals) => void;

let ownGroup: number | null | undefined;

/** This process's group (ps, read once; null when ps cannot tell — then only the pid checks apply). */
export function ownProcessGroup(): number | null {
  if (ownGroup !== undefined) return ownGroup;
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    const n = Number(out);
    ownGroup = Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    ownGroup = null;
  }
  return ownGroup;
}

/** A pid this process may signal (or treat as a tree root): an integer above 1, not itself, not its own group's leader. */
export function signalablePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== ownProcessGroup();
}

/** The processes of a tree: `root`'s group (when it leads one) and every descendant of `root` by parent pid. */
export function treeOf<T extends ProcInfo>(table: readonly T[], root: number, opts: { group?: boolean } = {}): T[] {
  const byParent = new Map<number, T[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const seen = new Map<number, T>();
  const queue = table.filter((p) => p.pid === root || (opts.group === true && p.pgid === root));
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p.pid)) continue;
    seen.set(p.pid, p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return [...seen.values()];
}

const defaultKill: KillFn = (target, sig) => process.kill(target, sig);

/**
 * Signal a job process (`table` absent) or its whole tree (`table`: its group, then every descendant — Remotion's browser
 * leads a group of its own). Nothing at all when `pid` is not signalable; a descendant that is this process is skipped.
 * Returns the targets signalled.
 */
export function signalTree(pid: number, sig: NodeJS.Signals, table?: readonly ProcInfo[], kill: KillFn = defaultKill): number[] {
  if (!signalablePid(pid)) return [];
  const sent: number[] = [];
  const send = (target: number) => {
    try {
      kill(target, sig);
      sent.push(target);
    } catch {
      /* gone, or not ours */
    }
  };
  if (!table) {
    send(pid);
    return sent;
  }
  send(-pid);
  for (const p of treeOf(table, pid, { group: true })) if (p.pid > 1 && p.pid !== process.pid) send(p.pid);
  return sent;
}

/** SIGKILL a job process's tree (the machine's process table read first; nothing read for a pid not signalable). */
export async function killTree(pid: number, kill?: KillFn): Promise<number[]> {
  if (!signalablePid(pid)) return [];
  return signalTree(pid, 'SIGKILL', await processTable(), kill);
}
