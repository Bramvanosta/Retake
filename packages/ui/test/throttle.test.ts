/** The Studio's throttle (app/throttle.ts): the first call at once, the calls inside the window one trailing run. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeThrottle, throttle } from '../src/app/throttle.js';

describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs at once, then once at the end of the window whatever the calls inside it', () => {
    const run = vi.fn();
    const t = throttle(run, 1000);
    t.call();
    expect(run).toHaveBeenCalledTimes(1);
    t.call();
    t.call();
    vi.advanceTimersByTime(999);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    t.call();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('cancel drops the trailing run', () => {
    const run = vi.fn();
    const t = throttle(run, 1000);
    t.call();
    t.call();
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a store’s read (project-data): never at once, at the end of the window of its last read wherever that ran', () => {
    const run = vi.fn();
    let lastAt = Date.now();
    const t = storeThrottle(run, 1000, () => lastAt);
    t.call();
    t.call();
    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    // Long after the last read: still in its own turn (a 0 ms timer), not inside the call.
    lastAt = Date.now() - 5000;
    t.call();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
