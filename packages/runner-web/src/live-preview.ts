/**
 * The live picture of a run (L4.4, R-UI-16): a small JPEG screencast of the page the run acts on, for a person watching
 * from the Studio. Its own CDP session on that page — never the recorder's, never `Emulation.*` (the recorder's session
 * owns the device metrics) — so a dry run (no recorder) has it too and a capture's frames are not touched.
 *
 * - Every compositor frame is asked for (`everyNthFrame: 1`): with a higher stride a page that changes once and then
 *   stays still never sends its final picture (measured: 7 of 8 final states lost with a stride of 6). Frames are acked
 *   at once and at most LIVE_FPS_MAX per second are handed on; the newest frame of a burst always follows within one
 *   interval (trailing edge), so the picture never stays on an older state of the page.
 * - Only while someone watches (`LiveSink.wanted`): nobody watching, no CDP session at all.
 * - Only while the run is on camera: `start()` at capture time 0, `stop()` first thing when the scenes end (before the
 *   recorders stop, the teardown hooks, the session diagnosis, the artefacts). In between it shows whatever the page the
 *   run acts on shows — an `offscreen` scene's steps and a `hook:` step's still page included (L5.8: played live, left
 *   out of the video by the edit). It follows that page (`page()`), checked every FOLLOW_MS: a sign-in tab, a hook's
 *   page or the preflight's browser are never that page.
 * - Frames go to the sink in memory; nothing here writes a file or logs a frame. What watching cost is counted
 *   (`watched()`: the seconds a screencast ran, the frames handed on) for the take's perf report (run.json
 *   `perf.live_preview`): the screencast's JPEG encoding runs in Chromium's browser process during the take.
 */
import type { CDPSession, Page } from 'playwright-core';
import { imageSize } from './recorder.js';
import { wallNow } from './util.js';
import { bestEffort } from '@retake/core/base';

/** Frames handed on per second, at most. */
export const LIVE_FPS_MAX = 10;
/** Width of the live picture, at most (CSS px of the viewport are scaled down to it). */
export const LIVE_MAX_WIDTH = 960;
export const LIVE_JPEG_QUALITY = 60;
/** How often the page the run acts on is looked at (ms). */
const FOLLOW_MS = 250;

export interface LiveFrame {
  /** JPEG bytes. */
  data: Buffer;
  width: number;
  height: number;
  /** Wall time it was handed on (epoch ms). */
  at: number;
  /** The run's id of the page (`console`, `shop`…), when known. */
  page?: string;
}

/** Where live frames go (the jobs worker's live channel). Kept in memory only. */
export interface LiveSink {
  /** Someone watches now. */
  readonly wanted: boolean;
  /** Called whenever `wanted` changes; returns the unsubscribe. */
  onWanted(fn: (wanted: boolean) => void): () => void;
  frame(f: LiveFrame): void;
}

export interface LivePreviewOptions {
  sink: LiveSink;
  /** The page the run acts on now; null when there is none (yet). */
  page(): Page | null;
  /** The run's id of a page. */
  pageId?(p: Page): string | undefined;
  /** The capture viewport (CSS px): the picture keeps its aspect. */
  width: number;
  height: number;
  /** Default LIVE_FPS_MAX. */
  fpsMax?: number;
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
}

export class LivePreview {
  private started = false;
  private stopped = false;
  private session: CDPSession | null = null;
  /** Wall ms a screencast ran so far, and since when the current one runs (null: none). */
  private watchedMs = 0;
  private watchedSince: number | null = null;
  private attached: Page | null = null;
  private busy = false;
  private dirty = false;
  private pending: Omit<LiveFrame, 'at'> | null = null;
  private lastSent = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private followTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Frames received from Chromium / handed to the sink (tests, diagnostics). */
  received = 0;
  sent = 0;

  constructor(private readonly opts: LivePreviewOptions) {}

  /** On camera from now (capture time 0). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribe = this.opts.sink.onWanted(() => this.sync());
    this.followTimer = setInterval(() => this.sync(), FOLLOW_MS);
    this.followTimer.unref?.();
    this.sync();
  }

  /** What watching cost so far: the seconds a screencast ran (someone watched) and the frames handed on. */
  watched(): { seconds: number; frames_sent: number } {
    const ms = this.watchedMs + (this.watchedSince !== null ? wallNow() - this.watchedSince : 0);
    return { seconds: Math.round(ms / 10) / 100, frames_sent: this.sent };
  }

  /** Off camera for good: no frame is handed on from the moment this is called. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.dropPending();
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.detach();
  }

  private get live(): boolean {
    return this.started && !this.stopped;
  }

  private dropPending(): void {
    this.pending = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** The page frames should come from now, or null. */
  private target(): Page | null {
    if (!this.live || !this.opts.sink.wanted) return null;
    let page: Page | null;
    try {
      page = this.opts.page();
    } catch {
      page = null; // no active page yet
    }
    return page && !page.isClosed() ? page : null;
  }

  /** Attach to / detach from the page as the target says, one change at a time. */
  private sync(): void {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    const want = this.target();
    if (want === this.attached && (want === null || this.session !== null)) return;
    this.busy = true;
    void (async () => {
      try {
        do {
          this.dirty = false;
          const page = this.target();
          if (page === this.attached && (page === null || this.session !== null)) continue;
          await this.detach();
          if (page) await this.attach(page);
        } while (this.dirty);
      } finally {
        this.busy = false;
      }
    })();
  }

  private async attach(page: Page): Promise<void> {
    let session: CDPSession;
    try {
      session = await page.context().newCDPSession(page);
    } catch {
      return; // the page went away: the next look follows the new one
    }
    // Stopped or moved on while the session opened.
    if (this.target() !== page) {
      await session.detach().catch(() => undefined);
      return;
    }
    this.session = session;
    this.attached = page;
    this.watchedSince = wallNow();
    const id = this.opts.pageId?.(page);
    session.on('Page.screencastFrame', (f: ScreencastFrame) => {
      session.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      if (this.session !== session || !this.live) return;
      this.received++;
      const data = Buffer.from(f.data, 'base64');
      const size = imageSize(data);
      if (!size) return;
      this.offer({ data, width: size.width, height: size.height, ...(id !== undefined ? { page: id } : {}) });
    });
    const maxWidth = Math.min(LIVE_MAX_WIDTH, this.opts.width);
    await bestEffort(
      session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: LIVE_JPEG_QUALITY,
        maxWidth,
        maxHeight: Math.max(1, Math.round((maxWidth * this.opts.height) / Math.max(1, this.opts.width))),
        everyNthFrame: 1,
      }),
      'the live view is a preview: a page that cannot stream shows no live picture, the capture is unchanged',
    );
  }

  private async detach(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.attached = null;
    this.dropPending();
    if (this.watchedSince !== null) this.watchedMs += wallNow() - this.watchedSince;
    this.watchedSince = null;
    if (!s) return;
    await s.send('Page.stopScreencast').catch(() => undefined);
    await s.detach().catch(() => undefined);
  }

  /** Latest-only, at most fpsMax per second, the newest frame of a burst always handed on (trailing edge). */
  private offer(f: Omit<LiveFrame, 'at'>): void {
    this.pending = f;
    if (this.flushTimer) return;
    const interval = 1000 / (this.opts.fpsMax ?? LIVE_FPS_MAX);
    const wait = this.lastSent + interval - wallNow();
    if (wait <= 0) this.flush();
    else this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.flushTimer = null;
    const f = this.pending;
    this.pending = null;
    if (!f || !this.live) return;
    this.lastSent = wallNow();
    this.sent++;
    try {
      this.opts.sink.frame({ ...f, at: this.lastSent });
    } catch {
      /* a sink error must not break the run */
    }
  }
}
