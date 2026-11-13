/**
 * Time measured so that a ratio of two times is a real ratio, whatever the machine's speed: a call is repeated until
 * the round lasts at least `minMs` (so the timer's resolution and the scheduler's noise are small next to it), and the
 * fastest of `rounds` rounds is kept (the first warms the code up). A test then compares two sizes of the same work —
 * linear, or bounded — instead of holding a budget in milliseconds that a busy machine stretches.
 */
export function perCallMs(fn: () => unknown, o: { minMs?: number; rounds?: number } = {}): number {
  const minMs = o.minMs ?? 20;
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < (o.rounds ?? 3); r++) {
    let calls = 0;
    const t0 = performance.now();
    let elapsed = 0;
    do {
      fn();
      calls++;
      elapsed = performance.now() - t0;
    } while (elapsed < minMs);
    best = Math.min(best, elapsed / calls);
  }
  return best;
}
