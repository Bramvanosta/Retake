/**
 * A job process (L5.14): one heavy job (core JOB_CLASS) a jobs worker claimed, run in a process of its own so the worker
 * can take a capture beside it and lower its priority during a take without touching the take (yield.ts). Started by the
 * worker (`worker-main --job <id> --kind <kind> --root <ws> --build <stamp> --supervisor <pid>`) detached, in a process
 * group of its own; it runs the worker's job code (run-job-record.ts) and writes the job's state from `running` on.
 *
 * - It refuses to start (exit 3, nothing written) on another build than its worker's: the worker gives the job back.
 * - It refuses anything but the heavy job of that kind its worker claimed (exit 4): a raced or edited job.json never
 *   makes it run a take (critique L1).
 * - Its worker gone (its parent pid changed), it cancels the job — teardown and clean-ups run — and ends it
 *   `interrupted`: a job process never outlives its worker for long (probe 3: no kernel safety net on macOS).
 * - Signals as a worker's: the first SIGINT / SIGTERM cancels the job (teardown runs), a second quits at once.
 */
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { jobClass } from '@retake/core';
import type { InterruptPort } from '../interrupts.js';
import { openWorkspace } from '../workspace.js';
import { buildDirs, buildStamp } from './build.js';
import { selfIdentity } from './proc.js';
import { FileJobQueue } from './queue.js';
import { createJobRunner, shellQuote } from './run-job-record.js';
import type { JobRecord } from './types.js';

/** Exit codes of a job process that did not run its job. */
export const JOB_EXIT = { buildChanged: 3, refused: 4 } as const;

export interface JobChildOptions {
  root: string;
  id: string;
  kind: string;
  /** The worker's build stamp. */
  build: string;
  /** The worker's pid (the job's claim names it). */
  supervisor: number;
  /** The folders the worker stamped (RETAKE_JOB_BUILD_DIRS); default this process's own. */
  dirs?: readonly string[];
  log?: (message: string) => void;
  /** How often the worker's presence is checked (ms, default 1 000). */
  watchMs?: number;
}

/** The build folders a worker passed (a JSON array of absolute paths), or undefined. */
export function passedBuildDirs(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.length > 0 && v.every((d) => typeof d === 'string' && d.startsWith('/')) ? (v as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Run the job; resolves with the exit code. */
export async function runJobChild(o: JobChildOptions): Promise<number> {
  const log = o.log ?? ((m: string) => void process.stderr.write(`${new Date().toISOString()} job process ${process.pid}: ${m}\n`));
  const root = resolve(o.root);
  const stamp = buildStamp(o.dirs ?? buildDirs());
  if (stamp !== o.build) {
    log(`job ${o.id}: this build (${stamp}) is not the worker's (${o.build}): not started`);
    return JOB_EXIT.buildChanged;
  }
  let ws: Awaited<ReturnType<typeof openWorkspace>>;
  try {
    ws = await openWorkspace({ root });
  } catch (e) {
    log(`job ${o.id}: no workspace at ${root}: ${(e as Error).message}`);
    return 1;
  }
  const cli = `retake -C ${shellQuote(root)}`;
  const queue = new FileJobQueue(root, cli);
  const stored = await queue.stored(o.id).catch(() => undefined);
  const claim = await queue.claimOf(o.id).catch(() => undefined);
  if (!stored || stored.state !== 'queued' || stored.kind !== o.kind || stored.input?.kind !== stored.kind || jobClass(stored.kind) !== 'heavy' || claim?.pid !== o.supervisor) {
    log(`job ${o.id}: not the queued ${o.kind} job its worker (pid ${o.supervisor}) claimed: refused`);
    return JOB_EXIT.refused;
  }
  const self = await selfIdentity();
  const host = hostname();
  const rw = await import('@retake/runner-web');
  const slot: { current?: AbortController; currentStop?: AbortController } = {};
  const quitSync = new Set<() => void>();
  const done = new Set<string>();

  let signals = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    signals++;
    if (signals === 1) {
      log(`${sig}: cancelling job ${o.id} (its teardown still runs)`);
      slot.current?.abort(new rw.CancelledError(`job cancelled (${sig})`));
      return;
    }
    rw.removeSessionCopiesSync();
    for (const f of quitSync) {
      try {
        f();
      } catch {
        /* quitting anyway */
      }
    }
    process.nextTick(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // As in the worker (critique L14): Remotion's encoder pipe may reject with EPIPE after a failed render.
  const onRejection = (reason: unknown) => {
    if ((reason as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') {
      log(`ignored a write to a closed pipe after a render (${(reason as Error).message})`);
      return;
    }
    throw reason;
  };
  process.on('unhandledRejection', onRejection);

  // The worker's presence: once it is gone the job is cancelled and ends interrupted.
  let orphan: string | undefined;
  const watch = setInterval(() => {
    if (process.ppid === o.supervisor) return;
    if (!orphan) {
      orphan = `its jobs worker (pid ${o.supervisor}) stopped while the job ran (its job process ended the job and cleaned up after it)`;
      log(`job ${o.id}: the worker is gone: cancelling`);
    }
    if (slot.current && !slot.current.signal.aborted) slot.current.abort(new rw.CancelledError('job cancelled (its worker stopped)'));
  }, o.watchMs ?? 1000);

  const interrupts = (signal: AbortSignal): InterruptPort => ({
    open: async (opts = {}) => {
      const q = opts.onQuitSync;
      if (q) quitSync.add(q);
      return {
        signal,
        get interrupted() {
          return signal.aborted;
        },
        dispose: () => {
          if (q) quitSync.delete(q);
        },
      };
    },
  });
  const writeOrExit = async (rec: JobRecord): Promise<void> => {
    try {
      await queue.write(rec);
    } catch (e) {
      log(`cannot write the state of job ${rec.id} (${(e as Error).message}): exiting`);
      process.exit(1);
    }
  };
  const { runJob } = createJobRunner({
    root,
    ws,
    queue,
    cli,
    build: o.build,
    worker: { ...self, host },
    self,
    supervisor: { pid: claim.pid, ...(claim.started_at ? { started_at: claim.started_at } : {}), host },
    log,
    rw,
    interrupts,
    slot,
    done,
    writeOrExit,
    abortedBecause: () => orphan,
  });
  try {
    await runJob(stored);
  } finally {
    clearInterval(watch);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('unhandledRejection', onRejection);
  }
  return 0;
}
