import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { isDesktopViewport, resolvePageUrl } from '@demo-studio/core';
import type {
  ResolvedScenePage,
  ResolvedViewport,
  BBox,
  CaptureSettings,
  CursorEffect,
  LoadedProject,
  NormalizedStep,
  Pacing,
  PointSpec,
  ResolvedEnvironment,
  RunMode,
} from '@demo-studio/core';
import type { TemplateContext } from '@demo-studio/core';
import type { BrowserSession, KitClient } from './session.js';
import type { CursorEffectPayload } from './kit/types.js';
import { ScreencastRecorder } from './recorder.js';
import { TrackBuilder } from './timeline.js';
import type { TimelineBuilder } from './timeline.js';
import { Pointer } from './pointer.js';
import type { Jitter } from './motion.js';
import { RunnerError, StepError } from './errors.js';
import { fileSlug } from './util.js';
import { sleep } from './util.js';
import { ArtefactStore } from './artefacts/store.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeInit {
  session: BrowserSession;
  timeline: TimelineBuilder;
  pacing: Pacing;
  capture: CaptureSettings;
  mode: RunMode;
  signal: AbortSignal;
  project: LoadedProject;
  env: ResolvedEnvironment;
  runDir: string;
  screenshotsDir: string;
  template: TemplateContext;
  recorder: ScreencastRecorder | null;
  log: (level: LogLevel, message: string) => void;
}

/** A page's own track (multi-page scenes, L2.11): its timeline part and its screencast (none in a dry run). */
export interface PageTrack {
  builder: TrackBuilder;
  recorder: ScreencastRecorder | null;
  started: boolean;
  viewport: ResolvedViewport;
}

/** A page of the multi-page scene running now: its page, viewport and own cursor. */
export interface ScenePane {
  id: string;
  page: Page;
  viewport: ResolvedViewport;
  pointer: Pointer;
}

/** Long-lived state of one run, shared by every action. */
export class Runtime {
  /** The cursor of single-page scenes (it follows the active page, as the main capture does). */
  readonly mainPointer: Pointer;
  readonly session: BrowserSession;
  readonly timeline: TimelineBuilder;
  readonly pacing: Pacing;
  readonly capture: CaptureSettings;
  readonly mode: RunMode;
  readonly signal: AbortSignal;
  readonly project: LoadedProject;
  readonly env: ResolvedEnvironment;
  readonly runDir: string;
  readonly screenshotsDir: string;
  readonly template: TemplateContext;
  readonly log: (level: LogLevel, message: string) => void;
  recorder: ScreencastRecorder | null;
  /** Captured emails, documents and web notifications (runs/<id>/artefacts/). */
  readonly artefacts: ArtefactStore;
  /** The scene and step being executed (notifications are attributed to them). */
  current: { scene: string; scene_index: number; step: number } | null = null;
  private tabSeq = 1;
  private readonly tracked = new WeakSet<Page>();
  /** Per-page tracks of multi-page scenes, by page id (kept for the whole run). */
  readonly tracks = new Map<string, PageTrack>();
  /** Every page filmed by a multi-page scene so far, with its own cursor (kept across scenes). */
  private readonly panes = new Map<string, ScenePane>();
  /** The pages of the multi-page scene running now (null: a single-page scene). */
  private scenePageIds: string[] | null = null;
  /** The main capture paused for a multi-page scene: the next `activate` resumes it. */
  private mainPaused = false;
  /** What each page of a multi-page scene was declared with (a later scene listing it by id inherits it). */
  readonly declaredPages = new Map<string, { page?: string; viewport: ResolvedViewport; label?: string }>();

  constructor(init: RuntimeInit) {
    this.session = init.session;
    this.timeline = init.timeline;
    this.pacing = init.pacing;
    this.capture = init.capture;
    this.mode = init.mode;
    this.signal = init.signal;
    this.project = init.project;
    this.env = init.env;
    this.runDir = init.runDir;
    this.screenshotsDir = init.screenshotsDir;
    this.template = init.template;
    this.recorder = init.recorder;
    this.log = init.log;
    this.artefacts = new ArtefactStore(init.runDir, (m) => this.warn(m));
    // What each page's cursor shows (icon, press, ripple; L2.13) goes with the capture that films that page.
    this.session.onCursorEffect = (page, p) => this.cursorEffect(page, p);
    this.mainPointer = new Pointer({
      page: () => this.page,
      kit: () => this.kit,
      timeline: this.timeline,
      pacing: this.pacing,
      signal: this.signal,
      scale: this.capture.scale,
    });
  }

  /**
   * A cursor effect reported by a page's kit (L2.13): on that page's track while it records (multi-page scenes), on
   * the main capture's timeline when that page is the one recorded there.
   */
  private cursorEffect(page: Page, p: CursorEffectPayload): void {
    const id = this.session.idOf(page);
    if (!id || typeof p?.time !== 'number' || !['icon', 'press', 'release', 'ripple'].includes(p.type)) return;
    const e: CursorEffect = { t: this.timeline.clock.at(p.time), type: p.type };
    if (p.type === 'icon') {
      if (p.icon !== 'arrow' && p.icon !== 'hand' && p.icon !== 'ibeam') return;
      e.icon = p.icon;
    }
    if (p.type === 'ripple' && typeof p.x === 'number' && typeof p.y === 'number') {
      e.x = p.x;
      e.y = p.y;
    }
    const track = this.tracks.get(id);
    if (track?.builder.recordingNow) track.builder.cursorEffect(e);
    if (!this.scenePageIds && this.session.activeId === id) this.timeline.cursorEffect(e);
  }

  /** The icon a page's cursor shows right now, as an effect of the capture that starts filming it. */
  private async currentIcon(page: Page, to: { cursorEffect(e: CursorEffect): void }): Promise<void> {
    const st = await this.session.kit(page).cursorState().catch(() => null);
    if (st?.kind) to.cursorEffect({ t: this.now(), type: 'icon', icon: st.kind });
  }

  /** The cursor of the acting page: its own in a multi-page scene, else the main one. */
  get pointer(): Pointer {
    if (this.scenePageIds && this.session.activeId) {
      const pane = this.panes.get(this.session.activeId);
      if (pane) return pane.pointer;
    }
    return this.mainPointer;
  }

  /** Viewport (CSS px) of the acting page: a multi-page scene's page has its own, else the capture size. */
  get viewport(): { width: number; height: number } {
    if (this.scenePageIds && this.session.activeId) {
      const pane = this.panes.get(this.session.activeId);
      if (pane) return { width: pane.viewport.width, height: pane.viewport.height };
    }
    return { width: this.capture.width, height: this.capture.height };
  }

  /** The pages of the multi-page scene running now (empty outside one). */
  get scenePanes(): ScenePane[] {
    return (this.scenePageIds ?? []).map((id) => this.panes.get(id)!).filter(Boolean);
  }

  /**
   * Start a multi-page scene (L2.11): every page exists (created blank when new) with its viewport, the main capture
   * pauses and each page is recorded on its own track, at the same time, on the capture clock; each page gets its own
   * cursor (taking over where the page already shows one). The first page acts.
   */
  async enterPages(pages: readonly ResolvedScenePage[]): Promise<void> {
    if (this.scenePageIds) await this.leavePages(pages.map((p) => p.id));
    if (this.recorder && !this.mainPaused) {
      await this.recorder.pause();
      this.mainPaused = true;
    }
    const capture = { width: this.capture.width, height: this.capture.height };
    for (const pg of pages) {
      const page = await this.session.page(pg.id);
      this.track(pg.id, page);
      const known = this.tracks.get(pg.id);
      if (known && (known.viewport.width !== pg.viewport.width || known.viewport.height !== pg.viewport.height || known.viewport.mobile !== pg.viewport.mobile)) {
        throw new StepError(
          `page "${pg.id}" was filmed at ${known.viewport.width}×${known.viewport.height} and is now asked at ${pg.viewport.width}×${pg.viewport.height}: ` +
            'a page keeps one viewport for the whole run (give the other viewport its own page id)',
        );
      }
      if (!isDesktopViewport(pg.viewport, capture) || this.session.emulated(page)) await this.session.emulate(page, pg.viewport);
      let pane = this.panes.get(pg.id);
      if (!pane || pane.page !== page) {
        const id = pg.id;
        const pointer = new Pointer({
          page: () => page,
          kit: () => this.session.kit(page),
          timeline: this.timeline,
          pacing: this.pacing,
          signal: this.signal,
          scale: this.capture.scale,
          sample: (s) => this.tracks.get(id)?.builder.sampleCursor(s),
        });
        pane = { id, page, viewport: pg.viewport, pointer };
        this.panes.set(id, pane);
      }
      let track = this.tracks.get(pg.id);
      if (!track) {
        const slug = fileSlug(pg.id);
        const builder = new TrackBuilder(
          {
            id: pg.id,
            file: `capture-${slug}.mp4`,
            frames_file: `frames-${slug}.jsonl`,
            width: pg.viewport.width,
            height: pg.viewport.height,
            scale: this.capture.scale,
            fps: this.capture.fps,
            ...(pg.viewport.mobile ? { mobile: true } : {}),
            ...(pg.viewport.touch ? { touch: true } : {}),
            ...(pg.viewport.preset ? { preset: pg.viewport.preset } : {}),
          },
          this.timeline.clock,
        );
        this.timeline.tracks.push(builder);
        const recorder =
          this.mode === 'capture'
            ? new ScreencastRecorder({
                framesDir: join(this.runDir, `frames-${slug}`),
                indexFile: join(this.runDir, `frames-${slug}.jsonl`),
                format: this.capture.format,
                quality: this.capture.quality,
                width: pg.viewport.width,
                height: pg.viewport.height,
                scale: this.capture.scale,
                mobile: pg.viewport.mobile,
                clock: this.timeline.clock,
                onError: (m) => this.timeline.warn(`page ${pg.id}: ${m}`),
              })
            : null;
        track = { builder, recorder, started: false, viewport: pg.viewport };
        this.tracks.set(pg.id, track);
      }
      if (track.recorder) {
        if (!track.started) await track.recorder.start(page);
        else await track.recorder.switchTo(page);
      }
      track.started = true;
      track.builder.start(page.url());
      await this.currentIcon(page, track.builder);
      // The page may already show a cursor (filmed by an earlier scene): this page's cursor takes over from there.
      if (!pane.pointer.known) {
        const st = await this.session.kit(page).cursorState().catch(() => null);
        if (st?.known) pane.pointer.adopt(st);
      }
    }
    for (const pg of pages) this.declaredPages.set(pg.id, { ...(pg.page !== undefined ? { page: pg.page } : {}), viewport: pg.viewport, ...(pg.label !== undefined ? { label: pg.label } : {}) });
    this.scenePageIds = pages.map((p) => p.id);
    await this.session.activate(pages[0].id);
  }

  /**
   * End a multi-page scene: its pages' tracks pause (hold their last frame) — except `keep`, the pages of a next
   * multi-page scene that films them too; the main capture resumes on the next `activate`.
   */
  async leavePages(keep: readonly string[] = []): Promise<void> {
    if (!this.scenePageIds) return;
    for (const id of this.scenePageIds) {
      if (keep.includes(id)) continue;
      const t = this.tracks.get(id);
      if (!t) continue;
      await t.recorder?.pause();
      t.builder.stop();
    }
    this.scenePageIds = null;
  }

  /** Inside a multi-page scene: the page the next steps act on (its cursor moves; the others rest). */
  async act(id: string): Promise<Page> {
    if (!this.scenePageIds?.includes(id)) throw new StepError(`page "${id}" is not filmed by this scene (${(this.scenePageIds ?? []).join(', ')})`);
    return this.session.activate(id);
  }

  get page(): Page {
    return this.session.active;
  }

  get kit(): KitClient {
    return this.session.kit();
  }

  get activeId(): string | null {
    return this.session.activeId;
  }

  now(): number {
    return this.timeline.now();
  }

  sleep(ms: number): Promise<void> {
    return sleep(ms, this.signal);
  }

  warn(message: string): void {
    this.timeline.warn(message);
    this.log('warn', message);
  }

  nextTabId(): string {
    let id: string;
    do id = `tab${++this.tabSeq}`;
    while (this.session.has(id));
    return id;
  }

  /** Track URL changes of a page for the timeline page segments. */
  private track(id: string, page: Page): void {
    if (this.tracked.has(page)) return;
    this.tracked.add(page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (this.session.pages.get(id) !== page) return;
      // A page of a multi-page scene: its own track's URL segments; otherwise the main capture's.
      const t = this.tracks.get(id);
      if (t?.builder.recordingNow) t.builder.pageSegment(frame.url());
      if (!this.scenePageIds && this.session.activeId === id) this.timeline.pageSegment(id, frame.url());
    });
  }

  /** Switch the active (recorded) page: screencast, timeline segment and cursor follow. */
  async activate(id: string, page?: Page): Promise<Page> {
    if (this.scenePageIds) await this.leavePages();
    if (page) this.session.register(id, page);
    const prev = this.session.activeId;
    const p = await this.session.activate(id);
    this.track(id, p);
    const t = this.tracks.get(id);
    if (t && !isDesktopViewport(t.viewport, { width: this.capture.width, height: this.capture.height })) {
      throw new StepError(
        `page "${id}" has a ${t.viewport.width}×${t.viewport.height} viewport: a single-page scene films the capture size — film it in a multi-page scene (\`pages\`)`,
      );
    }
    const resumed = this.mainPaused;
    if (resumed) {
      this.mainPaused = false;
      // The page's own cursor (multi-page scene) is where the main cursor continues.
      const pane = this.panes.get(id);
      if (pane) this.mainPointer.adopt(pane.pointer);
    }
    if (prev !== id || !this.timeline.pages.length || resumed) {
      if (this.recorder) await this.recorder.switchTo(p);
      this.timeline.pageSegment(id, p.url());
      if (prev !== id) await this.pointer.syncPage();
      if (prev !== id || resumed) await this.currentIcon(p, this.timeline);
    }
    return p;
  }

  /**
   * Base URL used to resolve a relative path on page `id`: its environment page — for a page id declared by a
   * multi-page scene (`pages:`), the environment page it was declared on, as its `open:` resolves —, else the current
   * URL.
   */
  resolveUrl(pathOrUrl: string, id: string | null = this.session.activeId): string {
    const envKey = id !== null && !Object.hasOwn(this.env.pages, id) ? this.declaredPages.get(id)?.page : id;
    const envBase = envKey ? this.env.pages[envKey] : undefined;
    if (envBase) return resolvePageUrl(envBase, pathOrUrl);
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return pathOrUrl;
    const cur = id && this.session.has(id) ? this.session.pages.get(id)!.url() : '';
    if (cur && /^https?:/.test(cur)) return new URL(pathOrUrl, cur).toString();
    throw new RunnerError(
      `cannot resolve relative URL "${pathOrUrl}": page "${id ?? '(none)'}" is not an environment page (${Object.keys(this.env.pages).join(', ')}) and has no http(s) URL`,
    );
  }

  /**
   * Resolve once the active page has painted the current DOM state (two animation frames; at most 150 ms when the
   * page does not render). Used before a scene's still so its first frames already show the cursor in place.
   */
  async painted(page: Page = this.page): Promise<void> {
    await page
      .evaluate(
        () =>
          new Promise<void>((resolve) => {
            const done = () => resolve();
            setTimeout(done, 150);
            requestAnimationFrame(() => requestAnimationFrame(done));
          }),
      )
      .catch(() => undefined);
  }

  /** Wait for load, then for network idle up to settle_ms. */
  async settle(page: Page = this.page): Promise<void> {
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => undefined);
    if (this.pacing.settle_ms > 0) {
      await page.waitForLoadState('networkidle', { timeout: this.pacing.settle_ms }).catch(() => undefined);
    }
  }
}

/**
 * Role of a pointer interaction inside a step: the click that opens the widget (trigger; also the only click of a
 * plain click, the drop of a drop_file, the press of a drag), an option of a listbox/popover, a menu item, the
 * confirmation button, a click outside that closes a popover, or a click into a popover's search field.
 */
export type ClickRole = 'trigger' | 'option' | 'item' | 'confirm' | 'outside' | 'search';

/** One recorded pointer interaction inside a step. */
export interface ClickRecord {
  role: ClickRole;
  /** Capture time of the press. */
  t: number;
  point: PointSpec;
  desc: string;
  bbox?: BBox;
  strategy?: string;
  popup_opened?: boolean;
  /** ms from the press to the evidence that a popup opened. */
  popup_ms?: number;
}

/** Per-step context passed to every action. */
export interface StepContext {
  rt: Runtime;
  scene: { id: string; index: number };
  step: NormalizedStep;
  /** Step timeout in ms (step.timeout or 15 s). */
  timeoutMs: number;
  jitter: Jitter;
  /** Pointer interactions performed by the step, in order. */
  clicks: ClickRecord[];
}
