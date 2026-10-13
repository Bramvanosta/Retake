/**
 * Full-page loads in the capture (R-ISS-08, L1.2): the recorder never writes a frame of a document that has not
 * painted content of its own yet. From a main-frame cross-document commit (or the recorder attaching to a page that has
 * painted nothing yet: a fresh tab's about:blank, a page still loading) the screencast frames are HELD — not written —
 * so the previous frame stays on screen (the encoder shows the latest frame at or before each tick), until a frame
 * painted at or after the new document's first contentful paint (Chromium's lifecycle event `firstContentfulPaint`).
 * Pure: the recorder wires it to its CDP session (recorder.ts), tests drive it with a fake clock.
 *
 * Measured on a Mac (headless Chromium, playwright-core 1.56): a document's first blank frame arrives 8–20 ms after
 * its commit event; the frame of the first contentful paint arrives 13–17 ms BEFORE its lifecycle event and is stamped
 * within 3 ms of the paint time; frames of a navigation can be dropped by the recorder's size check (a cropped view),
 * the paint's among them. A page with no text, image or SVG (a solid skeleton) and a PDF viewer report no first
 * contentful paint.
 */

/** A frame stamped at most this long before the paint time counts as painted after it (frames are ≥ 16 ms apart). */
export const PAINT_SLACK_MS = 8;
/**
 * After the paint signal, frames are still held this long — the first one written then shows the cursor too, which the
 * kit draws on a new document only once the page painted (kit.ts `revealed`): no cursor blink.
 */
export const HOLD_AFTER_PAINT_MS = 40;
/**
 * A page that sends no frame after its paint: its newest frame painted after it is written this long after the signal
 * (a still page sends no other); without one (the paint's frame was dropped), a fresh frame is asked for, and the hold
 * ends after this long again in any case.
 */
export const HOLD_FLUSH_MS = 120;
/**
 * A web page that never paints content (only solid colours: no text, image or SVG): released this long after its
 * network is idle (Chromium's `networkIdle`: no request for 0.5 s, after `load`) — never on `load` alone, nor on
 * `networkAlmostIdle` (≤ 2 requests): a single-page app's empty shell loads, then waits for its data request; a page
 * may also render its content from a timer, without any request.
 */
export const HOLD_IDLE_GRACE_MS = 3000;
/** The same for a document that is not a web page (a PDF viewer reports no first contentful paint at all). */
export const HOLD_PLUGIN_GRACE_MS = 500;
/** Longest hold: the page is shown as it is (with a run warning). */
export const HOLD_MAX_MS = 10_000;

/**
 * `navigation`: a commit (or a page still loading at attach); `blank`: a fresh tab's about:blank — never released on its
 * own load, and the runner does not wait for it (nothing comes until a step or the scene opens a page there).
 */
export type HoldKind = 'navigation' | 'blank';
/** What ended a hold: the first contentful paint, a load without one, the time limit, the recorder leaving the page (switch, pause), the end of the run. */
export type HoldEnd = 'paint' | 'load' | 'limit' | 'left' | 'end';

export interface HoldRecord {
  /** Wall ms (epoch) the hold started. */
  since: number;
  /** Wall ms of the first frame written after it (≥ since), else the moment it ended. */
  until: number;
  how: HoldEnd;
  /** Frames not written. */
  held: number;
  kind: HoldKind;
  /** The page it was on (as given to `begin`). */
  page?: string;
}

export interface HoldEnv<F> {
  now(): number;
  /** Run `fn` in `ms`; returns a cancel function. */
  setTimer(ms: number, fn: () => void): () => void;
  /** Write a held frame (released with its own time stamp). */
  keep(f: F): void;
  /** Ask the screencast for a fresh frame (the paint's frame was lost). */
  refresh?(): void;
}

interface Active<F> {
  since: number;
  page?: string;
  loaderId: string;
  kind: HoldKind;
  /** The document is a web page (else a PDF viewer…: HOLD_PLUGIN_GRACE_MS). */
  web: boolean;
  held: number;
  /** Newest held frame, and the newest painted at or after the paint (`floor`). */
  newest: F | null;
  newestPainted: F | null;
  loaded: boolean;
  idle: boolean;
  /** Arrival of the paint signal (wall ms), null before it. */
  signalAt: number | null;
  refreshed: boolean;
  cancelMax: () => void;
  cancelFlush: (() => void) | null;
  cancelIdle: (() => void) | null;
}

/** The hold of one recorded page (see the module comment). */
export class LoadHold<F extends { wall: number }> {
  readonly records: HoldRecord[] = [];
  /** Holds ended so far (the runner reveals the cursor after each one it waited for). */
  ends = 0;
  private cur: Active<F> | null = null;
  /** Frames painted before this (wall ms) are never written: the last paint's time, less PAINT_SLACK_MS. */
  private floor = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly env: HoldEnv<F>) {}

  get holding(): boolean {
    return this.cur !== null;
  }

  /** The document the hold waits for (null when not holding). */
  get loaderId(): string | null {
    return this.cur?.loaderId ?? null;
  }

  /** What is held (null when not holding). */
  get kind(): HoldKind | null {
    return this.cur?.kind ?? null;
  }

  /**
   * A new document committed (or the recorder attached to a page that has not painted): hold. A commit during a hold
   * (a client redirect) continues it — the newer document must paint. `page`: the page id, kept in the record; `web`:
   * the document is a web page (HTML, text, an image), not a PDF viewer.
   */
  begin(loaderId: string, kind: HoldKind = 'navigation', page?: string, web = true): void {
    const c = this.cur;
    if (c) {
      c.loaderId = loaderId;
      c.web = web;
      if (kind === 'navigation') c.kind = 'navigation';
      c.loaded = false;
      c.idle = false;
      c.signalAt = null;
      c.newestPainted = null;
      c.refreshed = false;
      c.cancelFlush?.();
      c.cancelIdle?.();
      c.cancelFlush = null;
      c.cancelIdle = null;
      return;
    }
    this.cur = {
      since: this.env.now(),
      ...(page !== undefined ? { page } : {}),
      loaderId,
      kind,
      web,
      held: 0,
      newest: null,
      newestPainted: null,
      loaded: false,
      idle: false,
      signalAt: null,
      refreshed: false,
      cancelMax: this.env.setTimer(HOLD_MAX_MS, () => this.release('limit')),
      cancelFlush: null,
      cancelIdle: null,
    };
  }

  /** A screencast frame: true when it is written now, false when it is held (or painted before the last paint). */
  frame(f: F): boolean {
    const c = this.cur;
    if (!c) return f.wall >= this.floor;
    if (c.signalAt !== null && f.wall >= this.floor) {
      if (this.env.now() - c.signalAt >= HOLD_AFTER_PAINT_MS) {
        this.finish('paint', f.wall);
        return true;
      }
      c.newestPainted = f;
    }
    c.newest = f;
    c.held++;
    return false;
  }

  /**
   * Lifecycle `firstContentfulPaint` of document `loaderId`, painted at wall time `at` (the event's own time stamp;
   * default: 25 ms before now — the paint's frame arrives up to ≈ 17 ms before its signal).
   */
  painted(loaderId: string, at?: number): void {
    const c = this.cur;
    if (!c || c.loaderId !== loaderId || c.signalAt !== null) return;
    c.signalAt = this.env.now();
    this.floor = Math.max(this.floor, (at ?? c.signalAt - 25) - PAINT_SLACK_MS);
    if (c.newest && c.newest.wall >= this.floor) c.newestPainted = c.newest;
    c.cancelIdle?.();
    c.cancelIdle = null;
    c.cancelFlush = this.env.setTimer(HOLD_FLUSH_MS, () => this.flush());
  }

  /** Lifecycle `load` of document `loaderId`. */
  loaded(loaderId: string): void {
    const c = this.cur;
    if (!c || c.loaderId !== loaderId) return;
    c.loaded = true;
    this.armIdle(c);
  }

  /** Lifecycle `networkIdle` of document `loaderId`. */
  idle(loaderId: string): void {
    const c = this.cur;
    if (!c || c.loaderId !== loaderId) return;
    c.idle = true;
    this.armIdle(c);
  }

  private armIdle(c: Active<F>): void {
    if (c.kind === 'blank' || !c.loaded || !c.idle || c.signalAt !== null || c.cancelIdle) return;
    c.cancelIdle = this.env.setTimer(c.web ? HOLD_IDLE_GRACE_MS : HOLD_PLUGIN_GRACE_MS, () => this.release('load'));
  }

  /**
   * The recorder leaves the page (switch, pause: `left`) or stops (`end`): the hold ends now, nothing is written —
   * unless the recorder never wrote a frame (`keptAny` false): then the newest held frame is, so a capture is never
   * empty.
   */
  leave(how: 'left' | 'end', keptAny: boolean): void {
    const c = this.cur;
    if (!c) return;
    if (!keptAny && c.newest) {
      this.env.keep(c.newest);
      this.finish(how, c.newest.wall);
    } else {
      this.finish(how, this.env.now());
    }
  }

  /** Resolves true once no hold is active (at once when none is), false after `ms` or when `signal` aborts. */
  waitEnd(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.cur) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const end = (ok: boolean) => {
        cancel();
        signal?.removeEventListener('abort', aborted);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(ok);
      };
      const done = () => end(true);
      const aborted = () => end(false);
      const cancel = this.env.setTimer(ms, () => end(false));
      this.waiters.push(done);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  /** Total ms held since wall time `wall`, counting only holds of at least `minMs` (shorter ones are not cut). */
  heldSince(wall: number, minMs: number): number {
    let ms = 0;
    for (const r of this.records) {
      if (r.until <= wall || r.until - r.since < minMs) continue;
      ms += r.until - Math.max(r.since, wall);
    }
    return ms;
  }

  /** No frame came after the paint within HOLD_AFTER_PAINT_MS (a still page). */
  private flush(): void {
    const c = this.cur;
    if (!c) return;
    if (c.newestPainted) {
      this.env.keep(c.newestPainted);
      this.finish('paint', c.newestPainted.wall);
    } else if (!c.refreshed && this.env.refresh) {
      // The paint's frame never came (dropped by the size check): ask for one, hold a little longer.
      c.refreshed = true;
      this.env.refresh();
      c.cancelFlush = this.env.setTimer(HOLD_FLUSH_MS, () => this.flush());
    } else {
      this.finish('paint', this.env.now());
    }
  }

  /**
   * Releases without a paint: the page is shown as it is from NOW — the held time stays held (the edit cuts it), so a
   * page that never paints content is not filmed during its grace. The newest held frame of the new document is
   * written stamped now (what the page shows, unless Chromium stopped sending frames), and a fresh frame is asked for
   * (Chromium may have sent none: dropped by the size check, or stopped). Frames painted before now are not written.
   */
  private release(how: 'load' | 'limit'): void {
    const c = this.cur;
    if (!c) return;
    const now = this.env.now();
    this.floor = Math.max(this.floor, now);
    if (c.newest && c.newest.wall >= c.since) this.env.keep({ ...c.newest, wall: now });
    this.finish(how, now);
    this.env.refresh?.();
  }

  private finish(how: HoldEnd, until: number): void {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    c.cancelMax();
    c.cancelFlush?.();
    c.cancelIdle?.();
    this.records.push({ since: c.since, until: Math.max(c.since, until), how, held: c.held, kind: c.kind, ...(c.page !== undefined ? { page: c.page } : {}) });
    this.ends++;
    for (const w of this.waiters.splice(0)) w();
  }
}
