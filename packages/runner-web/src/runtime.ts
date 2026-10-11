import type { Page } from 'playwright-core';
import { resolvePageUrl } from '@demo-studio/core';
import type {
  BBox,
  CaptureSettings,
  LoadedProject,
  NormalizedStep,
  Pacing,
  PointSpec,
  ResolvedEnvironment,
  RunMode,
} from '@demo-studio/core';
import type { TemplateContext } from '@demo-studio/core';
import type { BrowserSession, KitClient } from './session.js';
import type { ScreencastRecorder } from './recorder.js';
import type { TimelineBuilder } from './timeline.js';
import { Pointer } from './pointer.js';
import type { Jitter } from './motion.js';
import { RunnerError } from './errors.js';
import { sleep } from './util.js';

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

/** Long-lived state of one run, shared by every action. */
export class Runtime {
  readonly pointer: Pointer;
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
  private tabSeq = 1;
  private readonly tracked = new WeakSet<Page>();

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
    this.pointer = new Pointer({
      page: () => this.page,
      kit: () => this.kit,
      timeline: this.timeline,
      pacing: this.pacing,
      signal: this.signal,
      scale: this.capture.scale,
    });
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
      if (this.session.activeId === id && this.session.pages.get(id) === page) this.timeline.pageSegment(id, frame.url());
    });
  }

  /** Switch the active (recorded) page: screencast, timeline segment and cursor follow. */
  async activate(id: string, page?: Page): Promise<Page> {
    if (page) this.session.register(id, page);
    const prev = this.session.activeId;
    const p = await this.session.activate(id);
    this.track(id, p);
    if (prev !== id || !this.timeline.pages.length) {
      if (this.recorder) await this.recorder.switchTo(p);
      this.timeline.pageSegment(id, p.url());
      if (prev !== id) await this.pointer.syncPage();
    }
    return p;
  }

  /** Base URL used to resolve a relative path on page `id` (environment page, else the current URL). */
  resolveUrl(pathOrUrl: string, id: string | null = this.session.activeId): string {
    const envBase = id ? this.env.pages[id] : undefined;
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

/** One recorded pointer interaction inside a step. */
export interface ClickRecord {
  t: number;
  point: PointSpec;
  desc: string;
  bbox?: BBox;
  strategy?: string;
  popup_opened?: boolean;
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
