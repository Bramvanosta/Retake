/**
 * The Studio's "at most once every `ms`, then once more at the end" for a reaction to events (a list read again, a tick
 * bumped): the first call runs at once, the calls inside the window make one trailing run when it ends.
 */
import { useEffect, useRef } from 'react';

export interface Throttle {
  /** Run now, or once at the end of the window. */
  call(): void;
  /** Drop a trailing run still waiting (the screen is gone). */
  cancel(): void;
}

/**
 * A throttle of `run` (this module's rule). `o.now`: the clock (tests). `o.lastRun`: when the work last ran, if it
 * also runs elsewhere (the window counts from it). `o.leading: false`: never at once — always at the end of the
 * window, even when it is already over (a store reads in its own turn).
 */
export function throttle(run: () => void, ms: number, o: { now?: () => number; lastRun?: () => number; leading?: boolean } = {}): Throttle {
  const now = o.now ?? Date.now;
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call() {
      const wait = ms - (now() - (o.lastRun ? o.lastRun() : last));
      if (o.leading !== false && wait <= 0) {
        last = now();
        run();
      } else if (timer === null) {
        timer = setTimeout(
          () => {
            timer = null;
            last = now();
            run();
          },
          Math.max(0, wait),
        );
      }
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** A store's read (project-data): never at once, once at the end of the window of its last read, wherever that ran. */
export function storeThrottle(read: () => void, ms: number, lastRead: () => number): Throttle {
  return throttle(read, ms, { lastRun: lastRead, leading: false });
}

/** `fn` throttled for a component: the latest `fn` runs; a trailing run is dropped when the component goes. */
export function useThrottled(fn: () => void, ms: number): () => void {
  const latest = useRef(fn);
  latest.current = fn;
  const t = useRef<{ ms: number; throttle: Throttle } | null>(null);
  if (t.current?.ms !== ms) {
    t.current?.throttle.cancel();
    t.current = { ms, throttle: throttle(() => latest.current(), ms) };
  }
  useEffect(() => () => t.current?.throttle.cancel(), []);
  const call = useRef(() => t.current?.throttle.call());
  return call.current;
}
