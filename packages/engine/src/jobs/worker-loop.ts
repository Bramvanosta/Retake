/**
 * The loop of a jobs worker (worker.ts): each turn sees a heavy job's exit, reads the takes, steers the heavy job's
 * yield, keeps held.json, claims; it ends when stopped, when the workspace is gone, when it hands over (a newer job, a
 * build change) once both slots are empty, past `once`, or when idle with nothing queued — the lock released first, the
 * queue looked at once more. Then both slots end before the lock is released (the drain), and a worker of the new build
 * is started when one hands over and jobs wait.
 */
import { existsSync } from 'node:fs';
import { stateDir } from '../workspace-state.js';
import { buildStamp } from './build.js';
import { WorkerLock } from './lock.js';
import { spawnWorker } from './spawn.js';
import { hasQueued } from './worker-claim.js';
import { onHeavyExit, scanFilming, steerHeavy, syncHeld } from './worker-heavy.js';
import type { Worker } from './worker-record.js';
import { claimNext } from './worker-slots.js';

const sleep = (ms: number, wake: { fn?: () => void }) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    wake.fn = () => {
      clearTimeout(t);
      r();
    };
  });

/** Serve until stopped, gone, idle, past `once` or handing over; resolves true when this worker hands over. */
export async function serve(w: Worker): Promise<boolean> {
  const { o, log, root, dirs, build } = w;
  let lastBuildCheck = Date.now();
  for (;;) {
    if (w.stopping) break;
    const idle = !w.capture && !w.heavy;
    if (idle && !existsSync(stateDir(root))) {
      log('the workspace is gone: exiting');
      break;
    }
    if (w.heavy?.exited) {
      const h = w.heavy;
      w.heavy = undefined;
      await onHeavyExit(w, h);
      w.ended++;
      w.idleSince = Date.now();
    }
    await scanFilming(w);
    if (w.heavy) await steerHeavy(w, w.heavy);
    await syncHeld(w);
    const claimed = await claimNext(w);
    const empty = !w.capture && !w.heavy;
    if (empty && w.newerJob) {
      log('a queued job needs a newer build than this worker: handing over');
      return true;
    }
    if (empty && w.buildChanged) {
      log('the code changed since this worker started: handing over');
      return true;
    }
    if (empty && o.once && w.ended > 0) break;
    if (claimed) {
      w.idleSince = Date.now();
      continue;
    }
    if (empty) {
      if (Date.now() - w.idleSince >= w.idleExitMs) {
        // Idle: release the lock, then look once more — a job queued while a client saw this worker alive must not wait.
        w.lock.release();
        if (!(await hasQueued(w))) break;
        const again = await WorkerLock.acquire(root, build, log, o.startedBy);
        if (!again) break; // another worker took over
        w.lock = again;
        w.idleSince = Date.now();
        continue;
      }
    }
    // Not while this worker's take films (review B L2: the stamp is a synchronous walk on the take's event loop).
    if (Date.now() - lastBuildCheck >= w.buildCheckMs && w.capture?.filming !== true) {
      lastBuildCheck = Date.now();
      o.jobProcessTest?.buildCheck?.(w.capture?.filming ?? false);
      if (o.jobProcessTest?.buildChanged?.() === true || buildStamp(dirs) !== build) {
        if (!w.buildChanged && !empty) log('the code changed since this worker started: no new job here, handing over once the running ones end');
        w.buildChanged = true;
        continue;
      }
    }
    await sleep(w.pollMs, w.wake);
  }
  return false;
}

/** Critique L3: both slots end before the lock is released (a next worker must not claim beside a dying job). */
export async function drain(w: Worker): Promise<void> {
  if (w.capture) await w.capture.promise;
  if (w.heavy) {
    const h = w.heavy;
    await h.exit;
    w.heavy = undefined;
    await onHeavyExit(w, h);
  }
  await syncHeld(w);
}

/** After a hand-over: a worker of the new build, when this one was not stopped and jobs still wait. */
export async function handOver(w: Worker): Promise<void> {
  if (!w.stopping && existsSync(stateDir(w.root)) && (await hasQueued(w))) await spawnWorker(w.root, { idleExitMs: w.idleExitMs, ...(w.o.startedBy ? { startedBy: w.o.startedBy } : {}) });
}
