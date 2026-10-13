import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import type { TimelineLoading } from '@demo-studio/core';
import { LoadHold } from './hold.js';
import type { HoldKind } from './hold.js';
import type { CaptureClock } from './timeline.js';
import { pad, round3 } from './util.js';

/** One captured frame: file name inside frames/ and capture time in seconds. */
export interface FrameIndexEntry {
  file: string;
  t: number;
}

export interface RecorderOptions {
  framesDir: string;
  /** frames.jsonl path (one FrameIndexEntry per line, appended as frames are written). */
  indexFile: string;
  format: 'jpeg' | 'png';
  quality: number;
  /** Viewport in CSS px; frames are captured at width·scale × height·scale. */
  width: number;
  height: number;
  scale: number;
  /** Emulate a mobile device on the recorder's session (a page filmed at a mobile viewport, L2.11). */
  mobile?: boolean;
  clock: CaptureClock;
  onError?: (message: string) => void;
  /** Id of a recorded page (`timeline.loading[].page`). */
  pageId?: (page: Page) => string | undefined;
  /** Hold the frames of a page that has not painted yet (R-ISS-08; default true — false only in tests, as a control). */
  holdLoads?: boolean;
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
  metadata: { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
}

/** A frame that passed the size check: its JPEG/PNG bytes and paint time (epoch ms). */
interface Shot {
  data: Buffer;
  wall: number;
}

interface CdpFrame {
  id: string;
  parentId?: string;
  loaderId: string;
  url: string;
  mimeType?: string;
}

/** A document Chromium reports a first contentful paint for (a web page, text, an image) — not a PDF viewer. */
function isWebDocument(mimeType: string | undefined): boolean {
  return mimeType === undefined || /^(text|image)\/|html|xml/.test(mimeType);
}

/** How long the attach check may take (a page with a JavaScript dialog open never answers): then it counts as painted. */
const ATTACH_CHECK_MS = 300;
/**
 * After a frame dropped by the size check, a fresh frame is asked for this long later when no full-size frame came
 * meanwhile (a still page sends no other: its picture would never be filmed); at most HEAL_REFRESH_MAX times in a row.
 */
const HEAL_REFRESH_MS = 150;
const HEAL_REFRESH_MAX = 5;

/**
 * CDP screencast of the active page. Frames are acked immediately and written asynchronously so capture never
 * blocks the action loop; timestamps come from the compositor (epoch seconds, same clock as the runner).
 */
export class ScreencastRecorder {
  readonly frames: FrameIndexEntry[] = [];
  private session: CDPSession | null = null;
  private page: Page | null = null;
  private seq = 0;
  private readonly pending = new Set<Promise<void>>();
  private index: WriteStream | null = null;
  private writeErrors = 0;
  private stopped = false;
  private sizeWarned = false;
  private dropped = 0;
  /** Wall time (epoch ms) of the last frame kept, and who waits for a later one (waitFrameAfter). */
  private lastFrameWall = 0;
  private waiters: Array<{ after: number; done: (ok: boolean) => void }> = [];
  private readonly ext: string;
  private keptAny = false;
  /** Main-frame commits seen (the attach check is void when one arrives meanwhile). */
  private commits = 0;
  /** Full-page loads held (R-ISS-08). */
  private readonly hold: LoadHold<Shot>;
  /**
   * Wall ms minus Chromium's monotonic clock (lifecycle event time stamps), estimated as the smallest difference
   * between an event's arrival and its stamp: the paint time on the frames' clock.
   */
  private monoOffset = Infinity;

  constructor(private readonly opts: RecorderOptions) {
    this.ext = opts.format === 'png' ? 'png' : 'jpg';
    this.hold = new LoadHold<Shot>({
      now: () => Date.now(),
      setTimer: (ms, fn) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      keep: (f) => this.keep(f),
      refresh: () => this.refresh(),
    });
  }

  /**
   * A fresh frame of what the page shows now. After a navigation Chromium can stop sending frames once the new page
   * painted, until the next input (measured: 0.4 s to several seconds — the paint's own frame never comes); restarting
   * the screencast sends the current picture within ≈ 20 ms (re-sending startScreencast alone does not).
   */
  private refresh(): void {
    const s = this.session;
    if (!s) return;
    void s
      .send('Page.stopScreencast')
      .then(() => (this.session === s && !this.stopped ? s.send('Page.startScreencast', this.screencastParams()) : undefined))
      .catch(() => undefined);
  }

  private screencastParams(): Record<string, unknown> {
    return {
      format: this.opts.format,
      quality: this.opts.format === 'jpeg' ? this.opts.quality : undefined,
      maxWidth: Math.round(this.opts.width * this.opts.scale),
      maxHeight: Math.round(this.opts.height * this.opts.scale),
      everyNthFrame: 1,
    };
  }

  get recordingPage(): Page | null {
    return this.page;
  }

  /** Paint time (epoch ms) of the last frame kept (0 before the first). */
  get lastFrameAt(): number {
    return this.lastFrameWall;
  }

  /** A page load is being held: no frame is written until it paints (R-ISS-08). */
  get holding(): boolean {
    return this.hold.holding;
  }

  /** What is held (null when nothing is): a navigation, or a fresh tab's about:blank. */
  get holdKind(): HoldKind | null {
    return this.hold.kind;
  }

  /** Page loads held so far (ended holds). */
  get holdsEnded(): number {
    return this.hold.ends;
  }

  async start(page: Page): Promise<void> {
    await this.prepare();
    await this.attach(page);
  }

  /** Create the frame folder and index without recording yet (the first `switchTo` starts). */
  async prepare(): Promise<void> {
    if (this.index) return;
    await mkdir(this.opts.framesDir, { recursive: true });
    this.index = createWriteStream(this.opts.indexFile, { flags: 'a' });
  }

  /**
   * New-headless Chromium sometimes shrinks the captured view (a transient browser-UI layout pass) while the
   * page keeps its emulated viewport: re-asserting the device metrics on our session restores full frames.
   */
  private emulate(session: CDPSession): Promise<unknown> {
    const { width, height, scale } = this.opts;
    return session
      .send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: this.opts.mobile ?? false, screenWidth: width, screenHeight: height })
      .catch(() => undefined);
  }

  private async attach(page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    const holdLoads = this.opts.holdLoads !== false;
    let lastHeal = 0;
    /** Paint time of the last full-size frame; the pending fresh-frame request after a drop, and how many in a row. */
    let lastFull = 0;
    let healTimer: ReturnType<typeof setTimeout> | null = null;
    let healRefreshes = 0;
    let mainFrameId: string | null = null;
    /** Lifecycle events (and their time stamps) of the main frame's documents since the attach (a hold begun at attach replays them). */
    const seen = new Map<string, Map<string, number | undefined>>();
    session.on('Page.screencastFrame', (f: ScreencastFrame) => {
      session.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      if (this.session !== session || this.stopped) return;
      // A cropped view would distort the video: drop the frame (the previous one holds) and heal. The metadata can
      // claim the full viewport while the image itself is cropped (e.g. 1920×941 right after a navigation), so the
      // real pixel size is checked too.
      const { deviceWidth: dw, deviceHeight: dh } = f.metadata;
      const data = Buffer.from(f.data, 'base64');
      const px = imageSize(data);
      const ew = Math.round(this.opts.width * this.opts.scale);
      const eh = Math.round(this.opts.height * this.opts.scale);
      let wrong: string | null = null;
      if (dw !== undefined && dh !== undefined && (Math.abs(dw - this.opts.width) > 1 || Math.abs(dh - this.opts.height) > 1)) {
        wrong = `${dw}×${dh} CSS px`;
      } else if (px && (Math.abs(px.width - ew) > 1 || Math.abs(px.height - eh) > 1)) {
        wrong = `${px.width}×${px.height} px`;
      }
      const wall = f.metadata.timestamp !== undefined ? f.metadata.timestamp * 1000 : Date.now();
      if (wrong) {
        this.dropped++;
        const now = Date.now();
        if (now - lastHeal > 250) {
          lastHeal = now;
          void this.emulate(session);
        }
        // Chromium may send no other frame once healed (a still page, or a fresh frame asked for after a held load):
        // the page's picture would never be filmed — ask for one when no full-size frame came meanwhile.
        if (!healTimer && healRefreshes < HEAL_REFRESH_MAX) {
          healTimer = setTimeout(() => {
            healTimer = null;
            if (this.session !== session || this.stopped || lastFull >= wall) return;
            healRefreshes++;
            this.refresh();
          }, HEAL_REFRESH_MS);
        }
        if (this.dropped === 30 && !this.sizeWarned) {
          this.sizeWarned = true;
          this.opts.onError?.(`screencast frames stay ${wrong} instead of the ${ew}×${eh} px viewport`);
        }
        return;
      }
      lastFull = Math.max(lastFull, wall);
      healRefreshes = 0;
      const shot: Shot = { data, wall };
      // A page that has not painted yet (R-ISS-08): the frame is held, the previous one stays on screen.
      if (this.hold.frame(shot)) this.keep(shot);
    });
    if (holdLoads) {
      // Full-page loads (R-ISS-08): a main-frame cross-document commit holds the frames until the new document's
      // first contentful paint. Same-document navigations (Page.navigatedWithinDocument) and back/forward-cache
      // restores (painted already) are not held.
      session.on('Page.frameNavigated', (e: { frame: CdpFrame; type?: string }) => {
        if (this.session !== session || this.stopped || e.frame.parentId) return;
        mainFrameId = e.frame.id;
        this.commits++;
        if (e.type === 'BackForwardCacheRestore') return;
        this.hold.begin(e.frame.loaderId, e.frame.url === 'about:blank' ? 'blank' : 'navigation', this.idOf(page), isWebDocument(e.frame.mimeType));
      });
      session.on('Page.lifecycleEvent', (e: { frameId: string; loaderId: string; name: string; timestamp?: number }) => {
        if (this.session !== session || this.stopped) return;
        if (typeof e.timestamp === 'number') this.monoOffset = Math.min(this.monoOffset, Date.now() - e.timestamp * 1000);
        if (e.frameId !== mainFrameId) return;
        let names = seen.get(e.loaderId);
        if (!names) seen.set(e.loaderId, (names = new Map()));
        names.set(e.name, e.timestamp);
        this.lifecycle(e.name, e.loaderId, e.timestamp);
      });
    }
    this.session = session;
    this.page = page;
    await this.emulate(session);
    if (holdLoads) {
      try {
        const commits = this.commits;
        await session.send('Page.enable');
        const tree = (await session.send('Page.getFrameTree')) as { frameTree: { frame: CdpFrame } };
        const main = tree.frameTree.frame;
        mainFrameId ??= main.id;
        // Replays the lifecycle of the current document (commit, DOMContentLoaded, load, network idle — never its
        // paints): recorded in `seen`, ignored while nothing is held.
        await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
        const state = await this.attachState(session, main.url);
        // A commit meanwhile began its own hold (with the right document).
        if (this.session === session && this.commits === commits && state !== 'painted') {
          this.hold.begin(main.loaderId, state, this.idOf(page), isWebDocument(main.mimeType));
          for (const [name, ts] of seen.get(main.loaderId) ?? []) this.lifecycle(name, main.loaderId, ts);
        }
      } catch {
        /* no hold: never break a capture */
      }
    }
    await session.send('Page.startScreencast', this.screencastParams());
  }

  /** A lifecycle event of the main frame's document `loaderId` (time stamp: Chromium's monotonic seconds). */
  private lifecycle(name: string, loaderId: string, timestamp?: number): void {
    if (name === 'firstContentfulPaint') {
      const at = typeof timestamp === 'number' && Number.isFinite(this.monoOffset) ? timestamp * 1000 + this.monoOffset : undefined;
      this.hold.painted(loaderId, at);
    } else if (name === 'load') this.hold.loaded(loaderId);
    else if (name === 'networkIdle') this.hold.idle(loaderId);
  }

  /**
   * Has the page painted content of its own? `blank` (about:blank, a fresh tab), `navigation` (still loading: no first
   * contentful paint and not loaded), else `painted` (also when the check fails or takes longer than ATTACH_CHECK_MS).
   */
  private async attachState(session: CDPSession, url: string): Promise<'blank' | 'navigation' | 'painted'> {
    if (url === 'about:blank' || url === '') return 'blank';
    const check = session
      .send('Runtime.evaluate', {
        expression: "performance.getEntriesByName('first-contentful-paint').length > 0 || document.readyState === 'complete'",
        returnByValue: true,
      })
      .then((r) => ((r as { result?: { value?: unknown } }).result?.value === false ? ('navigation' as const) : ('painted' as const)))
      .catch(() => 'painted' as const);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'painted'>((resolve) => (timer = setTimeout(() => resolve('painted'), ATTACH_CHECK_MS)));
    try {
      return await Promise.race([check, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private idOf(page: Page): string | undefined {
    try {
      return this.opts.pageId?.(page);
    } catch {
      return undefined;
    }
  }

  /** Write a frame (index, last frame time, waiters of waitFrameAfter). */
  private keep(f: Shot): void {
    this.keptAny = true;
    this.lastFrameWall = Math.max(this.lastFrameWall, f.wall);
    if (this.waiters.length) {
      for (const w of this.waiters.filter((x) => f.wall > x.after)) w.done(true);
      this.waiters = this.waiters.filter((x) => f.wall <= x.after);
    }
    const entry: FrameIndexEntry = { file: `${pad(++this.seq, 6)}.${this.ext}`, t: this.opts.clock.at(f.wall) };
    const write = writeFile(join(this.opts.framesDir, entry.file), f.data)
      .then(() => {
        this.frames.push(entry);
        this.index?.write(JSON.stringify(entry) + '\n');
      })
      .catch((e: unknown) => {
        this.writeErrors++;
        this.opts.onError?.(`frame ${entry.file} could not be written: ${(e as Error).message}`);
      })
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }

  private async detach(): Promise<void> {
    this.hold.leave('left', this.keptAny);
    for (const w of this.waiters.splice(0)) w.done(false);
    const s = this.session;
    this.session = null;
    this.page = null;
    if (!s) return;
    await s.send('Page.stopScreencast').catch(() => undefined);
    await s.detach().catch(() => undefined);
  }

  /** Record another page from now on (new tab, page switch), or resume after `pause()`. */
  async switchTo(page: Page): Promise<void> {
    if (this.stopped || page === this.page) return;
    await this.detach();
    await this.attach(page);
  }

  /**
   * Stop recording for a while (L2.11: the main capture while a multi-page scene records its pages on their own
   * tracks, a page's track between the scenes that film it): no frame arrives, so the encoder holds the last one.
   */
  async pause(): Promise<void> {
    if (this.stopped) return;
    await this.detach();
  }

  /**
   * Resolves true once a frame painted after `afterWall` (epoch ms) arrives, false after `timeoutMs` (or when the
   * recorder is paused / stopped meanwhile).
   */
  waitFrameAfter(afterWall: number, timeoutMs: number): Promise<boolean> {
    if (this.lastFrameWall > afterWall) return Promise.resolve(true);
    if (this.stopped || !this.session) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = {
        after: afterWall,
        done: (ok: boolean) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /**
   * Resolves true once the page being recorded is not held (at once when it is not), false after `timeoutMs` or when
   * `signal` aborts.
   */
  waitLoaded(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return this.hold.waitEnd(timeoutMs, signal);
  }

  /** Ms of page loads held since wall time `wall` (epoch ms), counting only holds of at least `minMs`. */
  heldSince(wall: number, minMs: number): number {
    return this.hold.heldSince(wall, minMs);
  }

  /** The page loads held so far, in capture seconds (`timeline.loading`, `tracks[].loading`). */
  loadingIntervals(): TimelineLoading[] {
    return this.hold.records
      .filter((r) => r.until > r.since)
      .map((r) => ({
        t_start: round3(this.opts.clock.at(r.since)),
        t_end: round3(this.opts.clock.at(r.until)),
        ...(r.page !== undefined ? { page: r.page } : {}),
        until: r.how,
        held_frames: r.held,
      }));
  }

  /** Holds that ran into the time limit (HOLD_MAX_MS): capture time, page and what was held. */
  limitedLoads(): Array<{ t: number; page?: string; kind: HoldKind }> {
    return this.hold.records
      .filter((r) => r.how === 'limit')
      .map((r) => ({ t: round3(this.opts.clock.at(r.since)), ...(r.page !== undefined ? { page: r.page } : {}), kind: r.kind }));
  }

  /** Stop capturing and wait for every pending frame write. Returns the frames sorted by time. */
  async stop(): Promise<FrameIndexEntry[]> {
    if (!this.stopped) {
      // The hold open at the end of the run ends as `end` (detach would call it `left`).
      this.hold.leave('end', this.keptAny);
      this.stopped = true;
      await this.detach();
      await Promise.all([...this.pending]);
      await new Promise<void>((resolve) => (this.index ? this.index.end(resolve) : resolve()));
      this.index = null;
    }
    this.frames.sort((a, b) => a.t - b.t);
    return this.frames;
  }

  stats(): { frames: number; write_errors: number; dropped: number; held: number } {
    return { frames: this.frames.length, write_errors: this.writeErrors, dropped: this.dropped, held: this.hold.records.reduce((n, r) => n + r.held, 0) };
  }
}

/** Pixel size of a JPEG (first SOF marker) or PNG (IHDR) image; null when it cannot be read. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
