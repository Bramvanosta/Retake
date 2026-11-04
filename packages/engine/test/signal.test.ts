/**
 * L5.14a fixes (review B L1, lead: HIGH): the one way a worker signals a job process or its tree. A pid of -1 (a failed
 * spawn: `kill(-1)` reaches every process of the user), 0 (this process's own group), 1 (launchd), this process, its own
 * group, or anything not an integer never reaches a signal call — nor becomes the root of a QoS hold. Signals are
 * recorded here, never sent.
 */
import { describe, expect, it } from 'vitest';
import type { ProcInfo } from '@retake/sandbox';
import { QosYield, killTree, ownProcessGroup, signalTree, signalablePid } from '../src/index.js';

const BAD = [-1, 0, 1, Number.NaN, 1.5, -4242];

function recorder() {
  const calls: Array<[number, NodeJS.Signals]> = [];
  return { calls, kill: (target: number, sig: NodeJS.Signals) => void calls.push([target, sig]) };
}

describe('signalTree (L5.14a fixes)', () => {
  it('never signals -1, 0, 1, a non-integer, this process or its own group — alone or as a tree', async () => {
    const group = ownProcessGroup();
    expect(group).toBeGreaterThan(1);
    const table: ProcInfo[] = [
      { pid: 1, ppid: 0, pgid: 1, start: 1 },
      { pid: process.pid, ppid: 1, pgid: group!, start: 2 },
    ];
    for (const pid of [...BAD, process.pid, group!]) {
      const r = recorder();
      expect(signalablePid(pid), String(pid)).toBe(false);
      expect(signalTree(pid, 'SIGTERM', undefined, r.kill), String(pid)).toEqual([]);
      expect(signalTree(pid, 'SIGKILL', table, r.kill), String(pid)).toEqual([]);
      expect(await killTree(pid, r.kill), String(pid)).toEqual([]);
      expect(r.calls, String(pid)).toEqual([]);
    }
  });

  it('a job process alone, or its group and every descendant (a detached browser too); never this process inside its tree', () => {
    const table: ProcInfo[] = [
      { pid: 5000, ppid: process.pid, pgid: 5000, start: 1 },
      { pid: 5001, ppid: 5000, pgid: 5000, start: 1 },
      { pid: 5002, ppid: 5001, pgid: 5002, start: 1 }, // detached: a group of its own
      { pid: process.pid, ppid: 5001, pgid: 5000, start: 1 }, // a forged table naming this process in the tree
      { pid: 6000, ppid: 1, pgid: 6000, start: 1 },
    ];
    const one = recorder();
    expect(signalTree(5000, 'SIGTERM', undefined, one.kill)).toEqual([5000]);
    expect(one.calls).toEqual([[5000, 'SIGTERM']]);
    const tree = recorder();
    signalTree(5000, 'SIGKILL', table, tree.kill);
    expect(tree.calls.map(([t]) => t).sort((a, b) => a - b)).toEqual([-5000, 5000, 5001, 5002]);
    expect(tree.calls.every(([, s]) => s === 'SIGKILL')).toBe(true);
  });

  it('a QoS hold never takes a bad pid (or this process, unless it is a command\'s own tree) as its root', async () => {
    for (const root of [...BAD, process.pid, ownProcessGroup()!]) {
      const applied: number[][] = [];
      const table = async () => [{ pid: 1, ppid: 0, pgid: 1, start: 1 }, { pid: 77, ppid: 1, pgid: 77, start: 1 }];
      const q = new QosYield(root, { group: true, deps: { table, apply: async (pids) => void applied.push([...pids]), now: () => 0 } });
      expect(q.usable, String(root)).toBe(false);
      await q.hold();
      await q.release();
      expect(applied, String(root)).toEqual([]);
    }
    expect(new QosYield(process.pid, { group: false, self: true }).usable).toBe(true);
    expect(new QosYield(4242, { group: false, self: true }).usable).toBe(false);
  });
});
