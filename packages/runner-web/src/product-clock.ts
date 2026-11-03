/**
 * The product's clock (L1.7, R-ENV-05): a Date-only clock. A script in every document of the run's browsers (every
 * frame, popups; dedicated workers as soon as they start) replaces `Date` (the constructor without arguments,
 * `Date()`, `Date.now`) and the "now" default of `Intl.DateTimeFormat#format` / `#formatToParts` so the product reads
 * the clock's time; timers, `requestAnimationFrame`, `performance` and event time stamps stay the browser's own — the
 * product's animations and timers run exactly as without a clock. (Playwright's clock fakes them all and slowed the
 * product's own frames and timers: L1.7 review, T1.)
 *
 * The time is `epoch + (real now − since)`, or `epoch` when frozen: every document computes it from the same `since`
 * (the runner's wall clock at the anchor), so documents created before and after the anchor, in any browser of the
 * run, agree to the millisecond. Pages that must see the real time (the session check, the automated sign-in) are
 * marked with `useRealTime` before they load anything.
 */
import type { Page } from 'playwright-core';

/** What a document's clock reads: `epoch` at real wall time `since` (epoch ms), running, or fixed at `epoch`. */
export interface ProductClockConfig {
  epoch: number;
  since: number;
  freeze: boolean;
}

/**
 * The in-page clock (serialised: no closure over module scope). `cfg` installs it in this realm or moves an installed
 * one to `cfg`; `null` makes this realm read the real time for good (a page marked useRealTime). The state lives under
 * `Symbol.for('retake.clock')` (not enumerable): `off`, the config, the real `Date` (the kit's time source when it
 * is injected after the clock).
 */
export function productClock(cfg: ProductClockConfig | null): void {
  type State = { off: boolean; cfg?: ProductClockConfig; Date?: DateConstructor; set?: (c: ProductClockConfig) => void };
  const KEY = Symbol.for('retake.clock');
  const g = globalThis as unknown as Record<string | symbol, unknown>;
  const prev = g[KEY] as State | undefined;
  if (cfg === null) {
    if (prev) prev.off = true;
    else Object.defineProperty(g, KEY, { value: { off: true }, configurable: true });
    return;
  }
  if (prev) {
    // Installed already (a later anchor moves it), or a real-time realm (no `set`: left alone).
    if (prev.set) prev.set(cfg);
    return;
  }
  const RealDate = g.Date as DateConstructor;
  const realNow = RealDate.now.bind(RealDate);
  const state: State = {
    off: false,
    cfg,
    Date: RealDate,
    set: (c) => {
      state.cfg = c;
    },
  };
  Object.defineProperty(g, KEY, { value: state, configurable: true });
  const now = (): number => {
    const c = state.cfg!;
    if (state.off) return realNow();
    return c.freeze ? c.epoch : c.epoch + (realNow() - c.since);
  };
  const ClockDate = function Date(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
  } as unknown as DateConstructor;
  // One prototype: `instanceof Date`, subclasses (`class X extends Date`) and existing dates keep working.
  Object.defineProperty(ClockDate, 'prototype', { value: RealDate.prototype, writable: false });
  Object.defineProperty(ClockDate, 'length', { value: 7 });
  for (const k of ['UTC', 'parse'] as const) Object.defineProperty(ClockDate, k, { value: RealDate[k], writable: true, configurable: true });
  Object.defineProperty(ClockDate, 'now', { value: () => now(), writable: true, configurable: true });
  Object.defineProperty(ClockDate, 'toString', { value: () => RealDate.toString(), writable: true, configurable: true });
  Object.defineProperty(RealDate.prototype, 'constructor', { value: ClockDate, writable: true, configurable: true });
  Object.defineProperty(g, 'Date', { value: ClockDate, writable: true, configurable: true });
  // Intl's "now": DateTimeFormat#format() and #formatToParts() without a date (a bound format function per instance).
  const DTF = (g.Intl as typeof Intl | undefined)?.DateTimeFormat;
  if (DTF) {
    const proto = DTF.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'format');
    const getFormat = desc?.get;
    if (desc && getFormat) {
      const bound = new WeakMap<object, (d?: unknown) => string>();
      Object.defineProperty(proto, 'format', {
        ...desc,
        get(this: object) {
          let f = bound.get(this);
          if (!f) {
            const real = getFormat.call(this) as (d?: unknown) => string;
            f = (date?: unknown) => real(date === undefined ? now() : date);
            bound.set(this, f);
          }
          return f;
        },
      });
    }
    const toParts = proto.formatToParts;
    if (typeof toParts === 'function') {
      Object.defineProperty(proto, 'formatToParts', {
        value: function formatToParts(this: Intl.DateTimeFormat, date?: Date | number) {
          return toParts.call(this, date === undefined ? now() : date);
        },
        writable: true,
        configurable: true,
      });
    }
  }
}

function scriptOf(cfg: ProductClockConfig | null): string {
  return `(() => { var __name = (f) => f; (${productClock.toString()})(${JSON.stringify(cfg)}); })();`;
}

/** The script that installs the clock in a document (or moves it to `cfg`). */
export function productClockScript(cfg: ProductClockConfig): string {
  return scriptOf(cfg);
}

/** The script that keeps a document on the real time (installed clock or not). */
export const REAL_TIME_SCRIPT = scriptOf(null);

const realTimePages = new WeakSet<Page>();

/**
 * Keep a page on the real time (L1.7, T5): the session check after a failed step and the automated sign-in judge a
 * session by its tokens' expiry — never under a product clock far from now. Call before the page loads anything; its
 * documents, frames and workers never get the clock.
 */
export async function useRealTime(page: Page): Promise<void> {
  realTimePages.add(page);
  await page.addInitScript({ content: REAL_TIME_SCRIPT });
  await Promise.all(page.frames().map((f) => f.evaluate(REAL_TIME_SCRIPT).catch(() => undefined)));
}

/** A page marked useRealTime. */
export function isRealTimePage(page: Page): boolean {
  return realTimePages.has(page);
}
