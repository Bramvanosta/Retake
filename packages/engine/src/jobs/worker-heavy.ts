/**
 * The heavy slot of a jobs worker (worker.ts, L5.14): one heavy job at a time in a job process of its own
 * (job-child.ts) — started detached with the worker's build, yielding while a take films (background QoS on its tree,
 * yield.ts; `.retake/workers/held.json` follows the hold), killed `cancelGraceMs` after a cancel it did not honour, and
 * its end written here only when its job process died before it wrote it (one writer). The takes it yields to are read
 * here too: the filming markers of this user (captures.ts).
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capMinutes, heldFile } from './captures.js';
import { JOB_EXIT } from './job-child.js';
import { workersDir } from './lock.js';
import { interrupted } from './interrupted.js';
import { jobProcessCommand } from './spawn.js';
import { FINISHED_JOB_STATES } from './types.js';
import type { JobRecord } from './types.js';
import { killTree } from './signal.js';
import { recordDigest } from './signing.js';
import { QosYield } from './yield.js';
import { unclaimJob } from './worker-claim.js';
import { closeJob } from './worker-finish.js';
import type { HeavyChild, Worker } from './worker-record.js';

/** Start a claimed heavy job in its job process (the slot holds it until its exit is seen). */
export async function startHeavy(w: Worker, stored: JobRecord): Promise<void> {
  w.started++;
  await mkdir(workersDir(w.root), { recursive: true });
  const job = { id: stored.id, kind: stored.kind, build: w.build, supervisor: process.pid, digest: recordDigest(stored) };
  const { command, args } = w.o.jobProcessTest?.command ? w.o.jobProcessTest.command({ ...job, root: w.root }) : jobProcessCommand(w.root, job);
  const out = openSync(join(workersDir(w.root), 'worker.log'), 'a');
  let child;
  try {
    child = spawn(command, args, { cwd: w.root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, RETAKE_JOB_BUILD_DIRS: JSON.stringify(w.dirs) } });
  } finally {
    closeSync(out);
  }
  // A spawn that failed (ENOENT, EAGAIN) has no pid until its `error` event: 0, which signal.ts never signals and QoS
  // never touches (review B L1).
  const pid = child.pid ?? 0;
  const h: HeavyChild = {
    id: stored.id,
    kind: stored.kind,
    pid,
    exit: Promise.resolve(),
    qos: new QosYield(pid, { group: true, ...(w.o.jobProcessTest?.qos ? { deps: w.o.jobProcessTest.qos } : {}) }),
  };
  h.exit = new Promise<void>((r) => {
    child.on('exit', (code, signal) => {
      h.exited = { code, signal };
      w.wake.fn?.();
      r();
    });
    child.on('error', (e) => {
      w.log(`job ${stored.id}: its job process did not start (${e.message})`);
      h.exited ??= { code: 1, signal: null };
      w.wake.fn?.();
      r();
    });
  });
  w.heavy = h;
  w.log(`job ${stored.id}: running (${stored.kind}) in job process ${child.pid ?? '(none)'}`);
}

/** A job process ended: its job's end is its own unless it died first (then this worker writes it: one writer). */
export async function onHeavyExit(w: Worker, h: HeavyChild): Promise<void> {
  await w.queue.setYield(h.id, null).catch(() => undefined);
  if (h.qos.held) await h.qos.release();
  const stored = await w.queue.stored(h.id);
  if (!stored) return;
  if (FINISHED_JOB_STATES.has(stored.state)) {
    w.done.add(h.id);
    return;
  }
  const { code, signal } = h.exited ?? { code: null, signal: null };
  if (code === JOB_EXIT.buildChanged && stored.state === 'queued') {
    await unclaimJob(w, h.id);
    w.buildChanged = true;
    w.log(`job ${h.id}: its job process runs another build: given back to the queue, handing over once idle`);
    return;
  }
  const now = new Date().toISOString();
  const final: JobRecord =
    h.killed === 'cancel'
      ? { ...stored, state: 'cancelled', finished_at: now, error: { code: 'cancelled', message: `cancelled: its job process did not stop within ${Math.round(w.cancelGraceMs / 1000)} s and was killed` } }
      : code === JOB_EXIT.refused
        ? { ...stored, state: 'failed', finished_at: now, error: { code: 'invalid', message: 'refused by its job process: not the queued heavy job this worker claimed' } }
        : { ...interrupted(stored, w.cli, `its job process exited (${signal ? `signal ${signal}` : `code ${code}`}) before it wrote the job's end — .retake/workers/worker.log says why`), finished_at: now };
  await closeJob(w, final, { cleanup: true });
  await rm(w.files.browser(h.id), { force: true }).catch(() => undefined);
}

/** The filming markers of this user's takes, as the claims and the heavy job's yield read them. */
export async function scanFilming(w: Worker): Promise<void> {
  try {
    const st = await w.watch.scan();
    w.filmingLive = st.holding;
    w.filmingCause = st.cause;
    const capped = st.takes.filter((t) => t.capped && !t.paused);
    w.filmingCapped = capped.length ? (capped.some((t) => t.here) ? 'here' : 'elsewhere') : undefined;
    for (const _ of st.newlyCapped) w.log(`a take has held heavy work for over ${capMinutes()} min: heavy work goes on`);
  } catch (e) {
    w.log(`the filming markers could not be read (${(e as Error).message}): heavy work is not held`);
    w.filmingLive = false;
    w.filmingCapped = undefined;
  }
}

/** The running heavy job yields while a take films (background QoS on its tree), and ends when cancelled. */
export async function steerHeavy(w: Worker, h: HeavyChild): Promise<void> {
  if (h.exited) return;
  // This worker's own take films (its marker may be missing: an unusable captures folder) or a marker holds.
  const own = w.capture?.filming === true;
  if (w.filmingLive || own) {
    if (!h.qos.held) {
      const cause = own ? 'here' : (w.filmingCause ?? 'elsewhere');
      w.log(`job ${h.id}: background priority while a take films (${cause === 'here' ? 'in this workspace' : 'elsewhere on this Mac'})`);
      await w.queue.setYield(h.id, { state: 'background', since: new Date().toISOString(), cause }).catch(() => undefined);
      h.pastCap = false;
    }
    await h.qos.hold();
  } else {
    if (h.qos.held) {
      // The yield goes first: whoever sees normal priority again sees it gone (review B H1).
      await w.queue.setYield(h.id, null).catch(() => undefined);
      await h.qos.release();
      w.log(`job ${h.id}: normal priority again`);
    }
    // The cap reached (a take still films, but has held heavy work for over the cap): said on the job, not only logged.
    if (w.filmingCapped && !h.pastCap) {
      h.pastCap = true;
      await w.queue.setYield(h.id, { state: 'past_cap', since: new Date().toISOString(), cause: w.filmingCapped, cap_min: capMinutes() }).catch(() => undefined);
      w.log(`job ${h.id}: a take has held heavy work for over ${capMinutes()} min: this job goes on at normal priority`);
    } else if (!w.filmingCapped && h.pastCap) {
      h.pastCap = false;
      await w.queue.setYield(h.id, null).catch(() => undefined);
    }
  }
  // Critique M3: a cancelled job ends itself (teardown, clean-ups) — at background priority during a take; its tree
  // is killed only when it has not ended `cancelGraceMs` after the cancel.
  if (h.cancelSeen === undefined && (await w.queue.cancelOf(h.id)) !== undefined) h.cancelSeen = Date.now();
  if (h.cancelSeen !== undefined && !h.killed && Date.now() - h.cancelSeen >= w.cancelGraceMs) {
    h.killed = 'cancel';
    w.log(`job ${h.id}: still running ${Math.round(w.cancelGraceMs / 1000)} s after its cancel: killing its job process`);
    await killTree(h.pid, w.kill);
  }
}

/** `.retake/workers/held.json` follows the heavy job's hold: what a take filmed outside this worker reads (TakeBeside). */
export async function syncHeld(w: Worker): Promise<void> {
  const on = w.heavy?.qos.held === true && !w.heavy.exited;
  if (on === w.heldWritten) return;
  w.heldWritten = on;
  if (on) await writeFile(heldFile(w.root), `${JSON.stringify({ v: 1, state: 'background', since: new Date().toISOString() })}\n`).catch(() => undefined);
  else await rm(heldFile(w.root), { force: true }).catch(() => undefined);
}
