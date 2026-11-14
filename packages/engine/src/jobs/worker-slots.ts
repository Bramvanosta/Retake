/**
 * The two slots of a jobs worker (worker.ts, L5.14) and the claims of one turn of its loop: the capture slot first — it
 * runs one capture-class job at a time in this process (createJobRunner, run-job-record.ts) — then the heavy slot
 * (worker-heavy.ts: a job process of its own). With heavyInProcess (WorkerOptions, worker-ports.ts), the capture slot
 * runs heavy jobs too, one at a time.
 */
import { portsOf } from '../ports.js';
import { jobClass } from './job-input.js';
import { pick } from './pick.js';
import { createJobRunner } from './run-job-record.js';
import type { JobRecord } from './types.js';
import { claimJob, scanOpenJobs, unclaimJob } from './worker-claim.js';
import { writeOrExit } from './worker-finish.js';
import { startHeavy } from './worker-heavy.js';
import type { Worker } from './worker-record.js';
import { interruptPort } from './worker-signals.js';

/** How the capture slot runs a claimed job: this worker's runner (its job.json, events, history line). */
export function captureJobRunner(w: Worker): (stored: JobRecord) => Promise<void> {
  return createJobRunner({
    root: w.root,
    ws: w.ws,
    queue: w.queue,
    files: w.files,
    cli: w.cli,
    build: w.build,
    worker: w.worker,
    self: w.self,
    log: w.log,
    // The worker is a composition root: its jobs run on its ports (a heavy job run in this process renders with its
    // renderer, a library preview reads its free space port, a `record` job opens its window port).
    ...portsOf(w.ports),
    interrupts: interruptPort(w),
    slot: w.slot,
    done: w.done,
    writeOrExit: (rec) => writeOrExit(w, rec),
    recordWindow: w.recordWindow,
    freeBytes: w.freeBytes,
    // A take of this worker started, paused, resumed or stopped filming: its hold follows now, not at the next poll.
    onFilming: (on) => {
      if (w.capture) w.capture.filming = on;
      w.wake.fn?.();
    },
    heavySlowed: () => w.heavy?.qos.held === true,
  }).runJob;
}

/** Run a claimed job in the capture slot (this process); the slot empties when it ends. */
function startCapture(w: Worker, stored: JobRecord): void {
  w.started++;
  const run = w.runJob(stored).catch((e: unknown) => w.log(`job ${stored.id}: ${(e as Error).message}`));
  w.capture = {
    id: stored.id,
    // Not filming yet: its setup hooks run first (runner onFilming says when it films).
    filming: false,
    promise: run.finally(() => {
      w.capture = undefined;
      w.ended++;
      w.idleSince = w.clock.monotonic();
      w.wake.fn?.();
    }),
  };
}

/**
 * The claims of one turn of the loop: the capture slot first (heavy jobs too when they run in this process), then the heavy slot.
 * Not while a take of this worker films and the heavy slot has nothing to take (critique M6: the take's event loop is
 * this process's), nor after a build change (critique L4: captures included), nor past `once`. True when one started.
 */
export async function claimNext(w: Worker): Promise<boolean> {
  let claimed = false;
  const room = !w.capture || (!w.heavy && !w.heavyInProcess && !w.capture.filming);
  if (room && !w.buildChanged && !w.newerJob && !(w.o.once && w.started > 0) && !w.stopping) {
    const records = await scanOpenJobs(w);
    if (!w.capture) {
      let id = pick(records, { slot: 'capture', filmingLive: w.filmingLive });
      if (!id && w.heavyInProcess) id = pick(records, { slot: 'heavy', filmingLive: w.filmingLive });
      const stored = id ? await claimJob(w, id) : undefined;
      if (stored) {
        startCapture(w, stored);
        claimed = true;
      }
    }
    if (!w.heavy && !w.heavyInProcess && !w.newerJob && !(w.o.once && w.started > 0)) {
      const id = pick(records, { slot: 'heavy', filmingLive: w.filmingLive || w.capture?.filming === true });
      const stored = id ? await claimJob(w, id) : undefined;
      if (stored) {
        if (jobClass(stored.kind) !== 'heavy' || jobClass(stored.input?.kind) !== 'heavy') await unclaimJob(w, stored.id);
        else {
          await startHeavy(w, stored);
          claimed = true;
        }
      }
    }
  }
  return claimed;
}
