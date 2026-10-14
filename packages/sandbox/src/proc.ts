/**
 * Process identity and process groups (macOS / Linux). A service the process provider starts leads its own process
 * group (pgid = pid); it is identified by its pid AND its start time (`ps -o lstart`, read with LC_ALL=C: localised
 * otherwise), so a pid the system reused for another program is never signalled, and by the machine's boot time (after
 * a reboot nothing recorded is ours). `sh -c "cmd"` replaces itself with cmd (exec): the command line changes, the pid
 * and start time do not. Liveness and stops go by the group: when the leader exits its children keep the group (a dev
 * server's wrapper exiting) — such a group is ours only when one of its members is a process recorded in the service's
 * group once it was healthy (pid and start time): a pid reused by another program can lead a group of the same id.
 */
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PS_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Two start times this close (ms) are the same process (lstart has a 1-second resolution). */
export const START_TOLERANCE_MS = 2000;

/** ps' `lstart` under LC_ALL=C ("Tue Oct 13 22:49:00 2026", local time) → epoch ms; null when it is not that. */
export function parseLstart(text: string): number | null {
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  const t = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(t) ? t : null;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** Start time (epoch ms), null when ps did not give one. */
  start: number | null;
}

/** `ps -A -o pid=,ppid=,pgid=,lstart=` lines → processes. */
export function parseProcessTable(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: parseLstart(m[4]) });
  }
  return out;
}

const PS_TABLE_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,lstart='];

/** Every process of this machine (empty when ps cannot run). */
export function processTable(): Promise<ProcInfo[]> {
  return new Promise((resolve) => {
    execFile('ps', PS_TABLE_ARGS, { env: PS_ENV, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? [] : parseProcessTable(String(stdout))));
  });
}

export function processTableSync(): ProcInfo[] {
  try {
    return parseProcessTable(execFileSync('ps', PS_TABLE_ARGS, { env: PS_ENV, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  } catch {
    return [];
  }
}

/** A process's start time (epoch ms), or null when it is gone. */
export function processStart(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: PS_ENV }, (err, stdout) => resolve(err ? null : parseLstart(String(stdout).trim())));
  });
}

export function processStartSync(pid: number): number | null {
  try {
    return parseLstart(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: PS_ENV, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
  } catch {
    return null;
  }
}

/**
 * `kill(target, 0)`: alive, gone (ESRCH), or there but not ours to signal (EPERM: another user's — or, on macOS, a group
 * whose members just died and are not reaped yet). A negative target is a group.
 */
export function signalState(target: number): 'alive' | 'gone' | 'foreign' {
  try {
    process.kill(target, 0);
    return 'alive';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? 'foreign' : 'gone';
  }
}

/** Send a signal; false when the target is gone (or not ours). */
export function send(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

/** `{ sec = 1728800000, usec = 512000 } Mon Oct 13 …` (sysctl kern.boottime) → seconds; null when it is not that. */
export function parseBootTime(text: string): number | null {
  const m = /\bsec\s*=\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

let boot: number | null | undefined;

/** When this machine booted (epoch seconds: kern.boottime on macOS, btime of /proc/stat on Linux); null when unknown. */
export function bootTime(): number | null {
  if (boot !== undefined) return boot;
  boot = null;
  try {
    if (process.platform === 'linux') {
      const m = /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8'));
      boot = m ? Number(m[1]) : null;
    } else {
      boot = parseBootTime(execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }));
    }
  } catch {
    boot = null;
  }
  return boot;
}

/** A process of a service's group, as recorded once the service was healthy. */
export interface Member {
  pid: number;
  /** Start time (epoch ms, ps lstart). */
  start: number;
}

/** What is known of a service started earlier, besides its pid and start time. */
export interface Known {
  /** The boot time it was started under (bootTime). */
  boot?: number | null;
  /** The members of its group once it was healthy (groupMembers). */
  members?: readonly Member[];
  /** This very call started it (its group cannot be another program's yet). */
  spawned?: boolean;
}

/** The members of a process group with a known start time (what identify recognises when the leader is gone). */
export function groupMembers(table: readonly ProcInfo[], pgid: number): Member[] {
  return table.filter((p) => p.pgid === pgid && p.start !== null).map((p) => ({ pid: p.pid, start: p.start! }));
}

/**
 * Is the group a service started (`pid`, started at `startedAt`) still ours? ours: the leader lives with that start
 * time, or the leader is gone and its group lives on with a recorded member in it (or this call started it); gone:
 * nothing of it is left, or the machine rebooted since; reused: the pid — or the group — is another program's.
 */
export async function identify(pid: number, startedAt: string, known: Known = {}): Promise<'ours' | 'gone' | 'reused'> {
  if (typeof known.boot === 'number') {
    const now = bootTime();
    if (now !== null && Math.abs(now - known.boot) > 2) return 'gone';
  }
  const group = signalState(-pid);
  if (group === 'gone') return 'gone';
  if (group === 'foreign') return 'reused';
  const leader = signalState(pid);
  if (leader === 'foreign') return 'reused';
  const start = leader === 'alive' ? await processStart(pid) : null;
  if (start !== null) {
    const recorded = Date.parse(startedAt);
    return Number.isFinite(recorded) && Math.abs(start - recorded) <= START_TOLERANCE_MS ? 'ours' : 'reused';
  }
  // The leader exited (a wrapper), its group lives on.
  if (known.spawned) return 'ours';
  const live = groupMembers(await processTable(), pid);
  if (!live.length) return signalState(-pid) === 'alive' ? 'reused' : 'gone';
  const recorded = known.members ?? [];
  return live.some((m) => recorded.some((r) => r.pid === m.pid && Math.abs(r.start - m.start) <= START_TOLERANCE_MS)) ? 'ours' : 'reused';
}

/** The members of a process group and all their descendants (children that left the group: setsid, a detached browser). */
export function groupTree(table: readonly ProcInfo[], pgid: number): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const seen = new Map<number, ProcInfo>();
  const queue = table.filter((p) => p.pgid === pgid);
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p.pid)) continue;
    seen.set(p.pid, p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return [...seen.values()];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `kill(target, 0)` fails, at most `ms`; true when it is gone. */
async function waitGone(target: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (signalState(target) !== 'alive') return true;
    if (Date.now() >= until) return false;
    await sleep(50);
  }
}

/** The processes of `before` still running (same pid and start time) in `now`. */
function stillRunning(before: readonly ProcInfo[], now: readonly ProcInfo[]): ProcInfo[] {
  return before.filter((p) => now.some((q) => q.pid === p.pid && q.start === p.start));
}

/** Signal a left-over descendant: its whole group when it leads one (a browser and its helpers), else itself. */
function signalLeftover(p: ProcInfo, signal: NodeJS.Signals): void {
  if (p.pgid === p.pid) send(-p.pid, signal);
  else send(p.pid, signal);
}

export interface StopResult {
  /** SIGTERM was not enough: the group was killed (SIGKILL). */
  forced: boolean;
  /** Descendants that had left the group and were still running after it stopped (they were stopped too). */
  leftovers: number;
}

/**
 * Stop a process group: SIGTERM, up to `timeoutMs` for it to end, then SIGKILL. Then the descendants that had left the
 * group (a browser Playwright launched detached, a daemonised child) and are still running: SIGTERM, 2 s, SIGKILL.
 */
export async function stopGroup(pgid: number, timeoutMs: number): Promise<StopResult> {
  const before = groupTree(await processTable(), pgid);
  let forced = false;
  if (send(-pgid, 'SIGTERM') && !(await waitGone(-pgid, timeoutMs))) {
    forced = true;
    send(-pgid, 'SIGKILL');
    await waitGone(-pgid, 2000);
  }
  const outside = before.filter((p) => p.pgid !== pgid);
  if (!outside.length) return { forced, leftovers: 0 };
  let left = stillRunning(outside, await processTable());
  const leftovers = left.length;
  if (left.length) {
    for (const p of left) signalLeftover(p, 'SIGTERM');
    const until = Date.now() + 2000;
    while (left.length && Date.now() < until) {
      await sleep(100);
      left = stillRunning(left, await processTable());
    }
    for (const p of left) signalLeftover(p, 'SIGKILL');
  }
  return { forced, leftovers };
}

/** Kill a process group and its descendants at once (a second Ctrl-C: nothing can be awaited). */
export function killGroupSync(pgid: number): void {
  const tree = groupTree(processTableSync(), pgid);
  send(-pgid, 'SIGKILL');
  for (const p of tree) if (p.pgid !== pgid) signalLeftover(p, 'SIGKILL');
}
