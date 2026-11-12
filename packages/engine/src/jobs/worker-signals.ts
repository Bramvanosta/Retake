/**
 * The process's signals while a jobs worker (worker.ts) serves. The first SIGINT / SIGTERM stops claiming, cancels the
 * running capture (or closes a recording's window) and SIGTERMs the job process (its first signal cancels with
 * teardown); any later signal quits at once: session copies and what a sandbox take started are removed synchronously
 * (the interrupt port's quit-sync functions), the job process's tree is killed, the lock released, the exit deferred to
 * the next tick so that the runner's own second-signal handler (registered after this one) still kills the shell hooks
 * it runs. Every signal to a job process or its tree goes through signal.ts. And the one rejection a worker survives:
 * Remotion's encoder pipe after a failed render.
 */
import type { InterruptPort } from '../interrupts.js';
import { signalTree, signalablePid } from './signal.js';
import type { Worker } from './worker-record.js';

/** Listen to SIGINT, SIGTERM and unhandled rejections for `w`; returns what stops listening (once the worker is done). */
export function handleSignals(w: Worker): () => void {
  const { log, queue, captureRunner, sb } = w;
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    signals++;
    if (signals === 1) {
      w.stopping = true;
      if (w.slot.currentStop) {
        log(`${sig}: stopping (the recording's window closes; what was recorded is kept, without its check replay)`);
        w.slot.currentStop.abort();
      } else {
        log(`${sig}: stopping${w.slot.current ? ' (cancelling the running job: its teardown still runs)' : ''}`);
        w.slot.current?.abort(captureRunner.cancelled(`run cancelled (${sig})`));
      }
      // The job process cancels its job on its first signal (teardown runs) — the SIGTERM first (review A L4: never behind
      // a pending walk of its tree), then normal priority again.
      const h = w.heavy;
      if (h && !h.exited) {
        log(`${sig}: cancelling job ${h.id} in its job process`);
        signalTree(h.pid, 'SIGTERM', undefined, w.kill);
        void queue
          .setYield(h.id, null)
          .catch(() => undefined)
          .then(() => h.qos.release());
      }
      w.wake.fn?.();
      return;
    }
    captureRunner.cleanupSync();
    for (const f of w.quitSync) {
      try {
        f();
      } catch {
        /* quitting anyway */
      }
    }
    if (w.heavy && !w.heavy.exited && signalablePid(w.heavy.pid)) signalTree(w.heavy.pid, 'SIGKILL', sb.processTableSync(), w.kill);
    w.lock?.release();
    process.nextTick(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // A render that fails mid-way (a refused download, a component error) leaves Remotion's encoder pipe to reject with
  // EPIPE after the failure, unhandled: the job already failed, the worker must not die of it. Anything else still
  // crashes the worker (readers then derive `interrupted`).
  const onRejection = (reason: unknown) => {
    if ((reason as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') {
      log(`ignored a write to a closed pipe after a render (${(reason as Error).message})`);
      return;
    }
    throw reason;
  };
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('unhandledRejection', onRejection);
  };
}

/** The interrupt port of the worker's capture: its quit-sync functions run on a second signal (handleSignals). */
export function interruptPort(w: Worker): (signal: AbortSignal) => InterruptPort {
  return (signal) => ({
    open: async (opts = {}) => {
      const q = opts.onQuitSync;
      if (q) w.quitSync.add(q);
      return {
        signal,
        get interrupted() {
          return signal.aborted;
        },
        dispose: () => {
          if (q) w.quitSync.delete(q);
        },
      };
    },
  });
}
