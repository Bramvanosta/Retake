/**
 * A jobs worker's signals go through its capture runner (L7.12: the CaptureRunner port, worker-signals.ts): the first
 * SIGINT / SIGTERM cancels the running job with the runner's own cancel (its message says the signal), the second
 * removes the session copies synchronously before anything else of the quit, then exits 130 on the next tick. Driven on
 * an in-memory runner and a worker record holding only what the handler reads; `process.exit` is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCancelledError, MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { handleSignals } from '../src/jobs/worker-signals.js';
import type { Worker } from '../src/jobs/worker-record.js';

afterEach(() => vi.restoreAllMocks());

/** The worker record's members handleSignals reads, nothing else. */
function workerOn(captureRunner: MemoryCaptureRunner, order: string[]) {
  const current = new AbortController();
  const w = {
    log: (m: string) => void order.push(`log ${m}`),
    queue: { setYield: async () => undefined },
    captureRunner,
    os: { processTableSync: () => [] },
    slot: { current },
    quitSync: new Set<() => void>([() => void order.push('quit-sync')]),
    wake: {},
    stopping: false,
    lock: { release: () => void order.push('lock released') },
  };
  return { w: w as unknown as Worker, current };
}

describe("a worker's signals, through its capture runner", () => {
  it('cancels with the runner\'s cancel on the first signal, removes the session copies first on the second', async () => {
    const order: string[] = [];
    const runner = new MemoryCaptureRunner();
    // As runWorker: loaded before it listens to signals.
    await runner.load();
    const cleanupSync = runner.cleanupSync.bind(runner);
    vi.spyOn(runner, 'cleanupSync').mockImplementation(() => {
      order.push('session copies removed');
      return cleanupSync();
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => void order.push('exit')) as never);
    const before = new Set(process.listeners('SIGTERM'));
    const { w, current } = workerOn(runner, order);
    const stop = handleSignals(w);
    try {
      const handler = process.listeners('SIGTERM').find((l) => !before.has(l)) as (sig: NodeJS.Signals) => void;
      expect(handler).toBeTypeOf('function');
      handler('SIGTERM');
      expect(w.stopping).toBe(true);
      expect(current.signal.aborted).toBe(true);
      expect(current.signal.reason).toBeInstanceOf(MemoryCancelledError);
      expect((current.signal.reason as Error).message).toBe('run cancelled (SIGTERM)');
      expect(runner.cleanups).toBe(0);
      handler('SIGTERM');
      expect(runner.cleanups).toBe(1);
      await new Promise((r) => process.nextTick(r));
      expect(order.filter((x) => !x.startsWith('log '))).toEqual(['session copies removed', 'quit-sync', 'lock released', 'exit']);
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      stop();
    }
  });
});
