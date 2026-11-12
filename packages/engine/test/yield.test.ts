/**
 * L5.14a: a running heavy job yields during a take — background QoS (`taskpolicy -b`) on every process of its tree (its
 * group and every descendant, the detached browser included), walked again with `-b` for new pids only (review A L5),
 * reversed per pid (`-B`) at the end for the pids the hold made background only (review A L3: a pid already at background
 * QoS keeps it); a pid whose start time changed is never touched. The real oracle: `ps -o pri` (31 → 4 → 31).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { QosYield, parseQosTable, qosTable, treeOf } from '../src/index.js';
import type { QosProc } from '../src/index.js';

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) {
    try {
      process.kill(-c.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/** A fake machine: the job process 100 (group 100), its child 101, a detached grandchild 102 (own group), a stranger. */
function fake() {
  let table: QosProc[] = [
    { pid: 100, ppid: 1, pgid: 100, start: 1000 },
    { pid: 101, ppid: 100, pgid: 100, start: 1001 },
    { pid: 102, ppid: 101, pgid: 102, start: 1002 },
    { pid: 200, ppid: 1, pgid: 200, start: 900 },
  ];
  const calls: Array<{ pids: number[]; background: boolean }> = [];
  let t = 0;
  return {
    calls,
    set: (next: QosProc[]) => (table = next),
    get table() {
      return table;
    },
    tick: (ms: number) => (t += ms),
    deps: { table: async () => table, apply: async (pids: readonly number[], background: boolean) => void calls.push({ pids: [...pids].sort(), background }), now: () => t },
  };
}

describe('the background hold of a job process tree (L5.14a)', () => {
  it('the tree: its group and every descendant by parent pid, not a stranger', () => {
    const f = fake();
    expect(
      treeOf(f.table, 100, { group: true })
        .map((p) => p.pid)
        .sort(),
    ).toEqual([100, 101, 102]);
  });

  it('hold: -b on every pid; walked again when due, -b on the new pids only (review A L5); release: -B per pid', async () => {
    const f = fake();
    const q = new QosYield(100, { group: true, rewalkMs: 2000, deps: f.deps });
    await q.hold();
    expect(f.calls).toEqual([{ pids: [100, 101, 102], background: true }]);
    await q.hold(); // not due
    expect(f.calls).toHaveLength(1);
    f.tick(2000);
    await q.hold(); // due, nothing new: no taskpolicy at all
    expect(f.calls).toHaveLength(1);
    f.tick(2000);
    f.set([...f.table, { pid: 103, ppid: 102, pgid: 102, start: 1003, background: true }]);
    await q.hold();
    expect(f.calls[1]).toEqual({ pids: [103], background: true });
    await q.release();
    expect(f.calls[2]).toEqual({ pids: [100, 101, 102, 103], background: false });
    expect(q.held).toBe(false);
    await q.release(); // released once
    expect(f.calls).toHaveLength(3);
  });

  it('review A L3: a pid at background QoS before the hold keeps it (never -B), its children forked during the hold too; a child of a held pid gets -B', async () => {
    const f = fake();
    // The person started the job process under `taskpolicy -b`: 100 and 101 are background already; 102 is not.
    f.set(f.table.map((p) => (p.pid === 100 || p.pid === 101 ? { ...p, background: true } : p)));
    const q = new QosYield(100, { group: true, rewalkMs: 0, deps: f.deps });
    await q.hold();
    expect(f.calls).toEqual([{ pids: [102], background: true }]);
    // Forked during the hold: 104 under 101 (background before: keeps it), 105 under 102 (inherited the hold's).
    f.set([...f.table, { pid: 104, ppid: 101, pgid: 100, start: 1004, background: true }, { pid: 105, ppid: 102, pgid: 102, start: 1005, background: true }]);
    await q.hold();
    expect(f.calls[1]).toEqual({ pids: [105], background: true }); // new: under a held parent; 104 untouched
    expect(q.pids.sort()).toEqual([102, 105]);
    // Forked after the last walk under 102: released too.
    f.set([...f.table, { pid: 106, ppid: 102, pgid: 102, start: 1006, background: true }]);
    await q.release();
    expect(f.calls[2]).toEqual({ pids: [102, 105, 106], background: false });
  });

  it('review A L4: a hung ps never holds a walk (nor the sandbox process table) longer than its time limit', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const bin = mkdtempSync(join(tmpdir(), 'retake-hung-ps-'));
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ''}`;
    try {
      let t0 = Date.now();
      expect(await qosTable()).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(8_000);
      // The sandbox's table (killTree, the second signal) reads PATH when it loads: in a process of its own.
      const mod = join(import.meta.dirname, '..', '..', 'sandbox', 'src', 'proc.ts');
      t0 = Date.now();
      const r = spawnSync(
        process.execPath,
        [
          '--conditions=source',
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `const { processTable } = await import(${JSON.stringify(mod)}); process.stdout.write(JSON.stringify(await processTable()))`,
        ],
        {
          cwd: join(import.meta.dirname, '..', '..', '..'),
          env: process.env,
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(r.stdout).toBe('[]');
      expect(Date.now() - t0).toBeLessThan(12_000);
    } finally {
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);

  it('ps -o pri 4 is background QoS (parseQosTable)', () => {
    const rows = parseQosTable(['  100     1   100  31 Tue Nov  4 10:00:00 2026', '  101   100   100   4 Tue Nov  4 10:00:01 2026', 'garbage'].join('\n'), () => 7);
    expect(rows).toEqual([
      { pid: 100, ppid: 1, pgid: 100, start: 7, background: false },
      { pid: 101, ppid: 100, pgid: 100, start: 7, background: true },
    ]);
  });

  it('a pid reused by another program (another start time) is never touched', async () => {
    const f = fake();
    const q = new QosYield(100, { group: true, deps: f.deps });
    await q.hold();
    // 102 exited; its pid now names a stranger (another start time, outside the tree).
    f.set(f.table.map((p) => (p.pid === 102 ? { pid: 102, ppid: 1, pgid: 102, start: 5000 } : p)));
    await q.release();
    expect(f.calls[1]).toEqual({ pids: [100, 101], background: false });
  });

  it.skipIf(process.platform !== 'darwin')('real: ps -o pri of every process of a tree (a detached grandchild too) goes to 4 and back', async () => {
    // A job-process-like tree: a group leader, a child, and a detached grandchild of its own group.
    const script = `const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); setInterval(()=>{},1000)"], { stdio: 'ignore' });
      setInterval(() => {}, 1000);`;
    const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    children.push(leader);
    const pri = () => {
      const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,pri='], { encoding: 'utf8' }).stdout;
      const rows = out
        .split('\n')
        .map((l) => l.trim().split(/\s+/).map(Number))
        .filter((r) => r.length === 4);
      const table = rows.map(([pid, ppid, pgid]) => ({ pid: pid!, ppid: ppid!, pgid: pgid!, start: null }));
      const tree = new Set(treeOf(table, leader.pid!, { group: true }).map((p) => p.pid));
      return rows.filter(([pid]) => tree.has(pid!)).map(([pid, , , p]) => ({ pid: pid!, pri: p! }));
    };
    const deadline = Date.now() + 10_000;
    while (pri().length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const before = pri();
    expect(before).toHaveLength(3);
    // The grandchild is detached (a group of its own), as Remotion's browser is.
    const q = new QosYield(leader.pid!, { group: true });
    await q.hold();
    expect(pri().map((p) => p.pri)).toEqual([4, 4, 4]);
    await q.release();
    expect(pri().map((p) => p.pri)).toEqual(before.map((p) => p.pri));
    for (const p of pri()) process.kill(p.pid, 'SIGKILL');
  });
});
