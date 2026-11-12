/**
 * How a running heavy job yields during a filming take (L5.14a): background QoS (macOS `taskpolicy -b`: efficiency
 * cores only, throttled I/O), applied to every process of its tree and reversed (`taskpolicy -B`) per process when the
 * take ends. Chosen by the spike over SIGSTOP (DESIGN §4q): it passes the take criteria, needs no root, raises no timer
 * of Remotion's, and a process left behind keeps working (only slower).
 *
 * - The tree: a job process's group (it leads one: started detached) plus every descendant by parent pid — Remotion
 *   starts its browser detached, in a group of its own. Walked again every REWALK_MS while held; `-b` goes only to the
 *   pids not seen before (review A L5: one `ps` per walk, a `/bin/sh` only when the tree grew — the take's event loop may
 *   be this process's). A process forked under background QoS inherits it; `-B` on a parent does not reach its
 *   children: the reversal is per pid.
 * - Each pid's own QoS before the hold is kept (review A L3): a pid already at background QoS when first seen (`ps -o
 *   pri` 4 — a person who started `taskpolicy -b retake render`) is neither held nor released; a pid forked during the
 *   hold takes its parent's. Release gives default QoS back only to the pids the hold made background (and to what they
 *   forked since).
 * - A pid is touched only while its start time is the one first seen for it (a reused pid is never changed); the root
 *   must be a pid this process may signal (signal.ts: never 0, 1, -1, itself or its own group), or this process itself
 *   for a command's own tree (`self`).
 * - `ps` and `taskpolicy` run with time limits (review A L4: a hung `ps` never blocks a cancel).
 * - Other platforms: nothing (heavy jobs still wait to start; BL-147).
 */
import { execFile } from 'node:child_process';
import { parseLstart } from '@retake/core/io';
import type { ProcInfo } from '@retake/core/io';
import { signalablePid, treeOf } from './signal.js';

export { treeOf } from './signal.js';

/** How often a held tree is walked again (ms). */
export const REWALK_MS = 2_000;
/** The longest a `ps` of a walk may take (ms). */
export const PS_TIMEOUT_MS = 5_000;

/** A process as the hold sees it: whether its QoS is background (`pri` 4 on macOS). */
export interface QosProc extends ProcInfo {
  background?: boolean;
}

export interface QosDeps {
  /** Every process of the machine, with its QoS. */
  table(): Promise<QosProc[]>;
  /** Background (`-b`) or default (`-B`) QoS for these pids. */
  apply(pids: readonly number[], background: boolean): Promise<void>;
  now(): number;
}

/** taskpolicy over a list of pids, in one shell (errors of exited pids are ignored). */
export function taskpolicy(pids: readonly number[], background: boolean): Promise<void> {
  if (process.platform !== 'darwin' || !pids.length) return Promise.resolve();
  const script = `for p in "$@"; do /usr/sbin/taskpolicy ${background ? '-b' : '-B'} -p "$p" 2>/dev/null; done; exit 0`;
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script, 'sh', ...pids.map(String)], { timeout: 10_000 }, () => resolve());
  });
}

/** `ps -A -o pid=,ppid=,pgid=,pri=,lstart=` lines → processes (pri 4: background QoS on macOS). */
export function parseQosTable(text: string, parseLstart: (s: string) => number | null): QosProc[] {
  const out: QosProc[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: parseLstart(m[5]!), background: Number(m[4]) === 4 });
  }
  return out;
}

/** Every process with its QoS, from one `ps` with a time limit (empty when it fails or takes too long). */
export async function qosTable(): Promise<QosProc[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,pri=,lstart='], { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: PS_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? [] : parseQosTable(String(stdout), parseLstart)),
    );
  });
}

/** What the hold knows of a pid: its start time when first seen, and whether it was background before the hold. */
interface Known {
  start: number | null;
  before: boolean;
}

/** The background hold of one process tree (a heavy job process, or a `retake render` command's own). */
export class QosYield {
  private readonly deps: QosDeps;
  private readonly known = new Map<number, Known>();
  /** The pids this hold made background (their QoS before was not). */
  private readonly made = new Set<number>();
  private lastWalk = 0;
  private holding = false;
  private busy: Promise<void> = Promise.resolve();
  /** The root is one this hold may touch (signal.ts rules, or this process itself with `self`). */
  readonly usable: boolean;

  constructor(
    readonly root: number,
    readonly opts: { group?: boolean; rewalkMs?: number; self?: boolean; deps?: Partial<QosDeps> } = {},
  ) {
    this.deps = { table: opts.deps?.table ?? qosTable, apply: opts.deps?.apply ?? taskpolicy, now: opts.deps?.now ?? Date.now };
    this.usable = opts.self === true ? root === process.pid : signalablePid(root);
  }

  get held(): boolean {
    return this.holding;
  }

  /** The pids made background so far. */
  get pids(): number[] {
    return [...this.made];
  }

  private serial(f: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(f, f);
    return this.busy;
  }

  /** The tree now (pids whose start time changed left out); pids not seen before are learnt with their QoS before the hold. */
  private learn(table: readonly QosProc[]): { tree: QosProc[]; fresh: QosProc[] } {
    const tree = treeOf(table, this.root, { group: this.opts.group ?? true }).filter((p) => {
      const k = this.known.get(p.pid);
      return !k || k.start === null || p.start === null || Math.abs(k.start - p.start) <= 2000;
    });
    const fresh: QosProc[] = [];
    // treeOf walks from the root down: a parent is learnt before its children, so a child forked during the hold takes
    // its parent's QoS before the hold (what it inherited from a held parent is the hold's, not its own).
    for (const p of tree) {
      if (this.known.has(p.pid)) continue;
      const parent = this.known.get(p.ppid);
      const before = this.holding && parent ? parent.before : p.background === true;
      this.known.set(p.pid, { start: p.start, before });
      if (!before) fresh.push(p);
    }
    return { tree, fresh };
  }

  /** Start holding (background QoS on the tree), or walk it again when due (`-b` on new pids only); no-op when unusable. */
  hold(): Promise<void> {
    return this.serial(async () => {
      if (!this.usable) return;
      const due = !this.holding || this.deps.now() - this.lastWalk >= (this.opts.rewalkMs ?? REWALK_MS);
      if (!due) return;
      this.lastWalk = this.deps.now();
      const table = await this.deps.table();
      const { fresh } = this.learn(table);
      this.holding = true;
      for (const p of fresh) this.made.add(p.pid);
      if (fresh.length)
        await this.deps.apply(
          fresh.map((p) => p.pid),
          true,
        );
    });
  }

  /** Stop holding: default QoS again on every pid this hold made background (same start), and on what they forked since. */
  release(): Promise<void> {
    return this.serial(async () => {
      if (!this.holding) return;
      const table = await this.deps.table();
      const { fresh } = this.learn(table);
      this.holding = false;
      const now = new Map(table.map((p) => [p.pid, p]));
      const pids = new Set<number>();
      for (const pid of this.made) {
        const p = now.get(pid);
        const k = this.known.get(pid);
        if (p && k && (k.start === null || p.start === null || Math.abs(k.start - p.start) <= 2000)) pids.add(pid);
      }
      for (const p of fresh) pids.add(p.pid);
      this.made.clear();
      this.known.clear();
      if (pids.size) await this.deps.apply([...pids], false);
    });
  }
}
