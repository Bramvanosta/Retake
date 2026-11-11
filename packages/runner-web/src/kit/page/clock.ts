/** The browser's real timers and clocks, captured once. */
// ── Time sources (L1.7): the kit's timers, frames and clocks are the browser's real ones, captured once — also under
// a product clock (`clock:`: product-clock.ts replaces `Date` in every document). The kit's init script runs before
// the clock's in each new document, so `Date` is still real there; evaluated later (KitClient.install), it takes the
// real `Date` the clock kept. Cursor effects are stamped on the real clock (the runner maps them to capture time); a
// notification's time and a dropped file's date stay the product's.
export const RT = (() => {
  const g = globalThis as unknown as Record<string | symbol, unknown>;
  const clock = g[Symbol.for('retake.clock')] as { Date?: DateConstructor } | undefined;
  const saved: Record<string, unknown> = clock?.Date ? { Date: clock.Date } : {};
  const pick = <T,>(name: string, bind: boolean): T => {
    const v = saved[name] ?? g[name];
    return (bind && typeof v === 'function' && saved[name] === undefined ? (v as (...a: unknown[]) => unknown).bind(g) : v) as T;
  };
  return {
    setTimeout: pick<typeof setTimeout>('setTimeout', true),
    clearTimeout: pick<typeof clearTimeout>('clearTimeout', true),
    setInterval: pick<typeof setInterval>('setInterval', true),
    clearInterval: pick<typeof clearInterval>('clearInterval', true),
    requestAnimationFrame: pick<typeof requestAnimationFrame>('requestAnimationFrame', true),
    performance: pick<Performance>('performance', false),
    Date: pick<DateConstructor>('Date', false),
  };
})();
