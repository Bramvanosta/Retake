import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import type { BrowserConfig } from '@demo-studio/core';
import { RunnerError, StepError } from './errors.js';
import { kitSource } from './kit/source.js';
import type {
  CursorEffectPayload,
  CursorState,
  DropOutcome,
  ElementInfo,
  FileSpec,
  FindOptions,
  KitConfig,
  OutsidePlan,
  PointInfo,
  PopupEntry,
  ResolveResult,
  RestAt,
  RestPlan,
  ScrollInfo,
  ScrollOp,
} from './kit/types.js';
import type { BBox, PointSpec, TargetObject } from '@demo-studio/core';

export interface SessionOptions {
  width: number;
  height: number;
  /** deviceScaleFactor. */
  scale: number;
  kit: KitConfig;
  browser?: BrowserConfig;
  /** Persistent profile directory. Default: a fresh temporary profile, deleted on close. */
  profileDir?: string;
  /** Playwright storageState JSON (cookies + localStorage) applied to the context. */
  storageState?: string;
  headed?: boolean;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** Chromium flags for clean, uninterrupted captures (background tabs keep rendering). */
export const DEFAULT_BROWSER_ARGS = [
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-features=Translate,MediaRouter',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * Launch flags for a capture at device scale `scale` (L2.8, measured in docs/HANDOFF.md): the CDP screencast of
 * headless Chromium (new headless and the headless shell alike) sends frames at the window's physical size, which
 * stays at CSS size whatever `deviceScaleFactor` the page emulates — `Emulation.setDeviceMetricsOverride` on the
 * recorder's session and `Page.captureScreenshot` give CSS-size images too. Forcing the browser's own device scale
 * factor makes the compositor surface `scale`× larger, so a 1920×1080 viewport at scale 2 is captured as real
 * 3840×2160 frames (text rasterised at 2×, not upscaled). Not used for headed windows (the display's own scale
 * applies) nor when the project already passes the flag.
 */
export function scaleArgs(scale: number, headed: boolean | undefined, extra: readonly string[] = []): string[] {
  if (headed || !(scale > 0) || scale === 1) return [];
  if (extra.some((a) => a.startsWith('--force-device-scale-factor'))) return [];
  return [`--force-device-scale-factor=${scale}`];
}

/** A web notification reported by the in-page kit (Notification API or ServiceWorkerRegistration.showNotification). */
export interface NotificationPayload {
  via: 'Notification' | 'ServiceWorkerRegistration.showNotification';
  title: string;
  body: string;
  tag?: string;
  /** Absolute icon URL (resolved against the page), when given. */
  icon?: string;
  /** Page wall clock (epoch ms). */
  time: number;
  url: string;
  origin: string;
}

/** Name of the binding the kit calls for each web notification the page shows. */
export const NOTIFICATION_BINDING = '__demoStudioNotification';
/** Name of the binding the kit calls with what its cursor shows: icon changes, presses, click ripples (L2.13). */
export const CURSOR_BINDING = '__demoStudioCursor';

/** playwright-core launch target for a browser config: an executable, else a channel (new headless by default). */
export function launchTarget(b: BrowserConfig = {}): { executablePath?: string; channel?: string } {
  const executablePath = b.executable ?? process.env.DEMO_STUDIO_CHROMIUM ?? undefined;
  const channel = executablePath ? undefined : b.channel === 'headless-shell' ? undefined : (b.channel ?? 'chromium');
  return { executablePath, channel };
}

interface StorageStateFile {
  cookies?: Parameters<BrowserContext['addCookies']>[0];
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
}

function isContextDestroyed(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /Execution context was destroyed|Cannot find context with specified id|frame was detached|because of a navigation/i.test(m);
}

function cleanEvalError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^page\.evaluate: /, '').replace(/^Error: /, '').split('\n    at ')[0];
}

/** Typed RPC to the in-page kit of one page. Re-installs the kit when a document lost it. */
export class KitClient {
  constructor(
    private readonly page: Page,
    private readonly source: string,
  ) {}

  async install(): Promise<void> {
    await this.page.evaluate(this.source);
  }

  async call<T>(path: string, ...args: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.page.evaluate(
          async ([p, a]): Promise<{ missing: boolean; value?: unknown }> => {
            const k = (window as unknown as { __demoStudio?: Record<string, unknown> }).__demoStudio;
            if (!k) return { missing: true };
            const parts = p.split('.');
            let owner = k;
            for (let i = 0; i < parts.length - 1; i++) owner = owner[parts[i]] as Record<string, unknown>;
            const fn = owner[parts[parts.length - 1]] as (...x: unknown[]) => unknown;
            return { missing: false, value: await fn.apply(owner, a) };
          },
          [path, args] as [string, unknown[]],
        );
        if (res.missing) {
          if (attempt >= 3) throw new RunnerError(`the in-page kit could not be installed in ${this.page.url()}`);
          await this.install();
          continue;
        }
        return res.value as T;
      } catch (e) {
        if (e instanceof RunnerError) throw e;
        if (isContextDestroyed(e) && attempt < 5) {
          await this.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
          continue;
        }
        throw new StepError(cleanEvalError(e));
      }
    }
  }

  find(t: TargetObject, opts?: FindOptions): Promise<ResolveResult> {
    return this.call('find', t, opts ?? {});
  }
  point(ref: string, offset?: PointSpec | null): Promise<PointInfo | null> {
    return this.call('point', ref, offset ?? null);
  }
  visible(ref: string): Promise<boolean> {
    return this.call('visible', ref);
  }
  scrollPlan(ref: string, margin: number): Promise<ScrollOp | null> {
    return this.call('scrollPlan', ref, margin);
  }
  scrollContainerFor(ref: string | null, fromParent = false): Promise<string> {
    return this.call('scrollContainerFor', ref, fromParent);
  }
  scrollInfo(container: string, of?: string | null): Promise<ScrollInfo> {
    return this.call('scrollInfo', container, of ?? null);
  }
  scrollAnimate(container: string, top: number, left: number, ms: number): Promise<{ top: number; left: number }> {
    return this.call('scrollAnimate', container, top, left, ms);
  }
  popupState(): Promise<PopupEntry[]> {
    return this.call('popupState');
  }
  expanded(ref: string): Promise<string | null> {
    return this.call('expanded', ref);
  }
  outsidePlan(near: PointSpec, avoid: number[]): Promise<OutsidePlan | null> {
    return this.call('outsidePlan', near, avoid);
  }
  restPoint(where?: 'side' | 'centre'): Promise<PointSpec> {
    return where ? this.call('restPoint', where) : this.call('restPoint');
  }
  restNear(box: BBox, at?: RestAt): Promise<RestPlan> {
    return at ? this.call('restNear', box, at) : this.call('restNear', box);
  }
  hasText(text: string): Promise<boolean> {
    return this.call('hasText', text);
  }
  snapshot(ref: string | null, max: number): Promise<string> {
    return this.call('snapshot', ref, max);
  }
  domClick(ref: string, x: number, y: number): Promise<void> {
    return this.call('domClick', ref, x, y);
  }
  pointerSequence(ref: string, x: number, y: number): Promise<void> {
    return this.call('pointerSequence', ref, x, y);
  }
  rowFor(text: string): Promise<string | null> {
    return this.call('rowFor', text);
  }
  menuTrigger(rowRef: string): Promise<string | null> {
    return this.call('menuTrigger', rowRef);
  }
  confirmButton(text: string | null): Promise<string | null> {
    return this.call('confirmButton', text);
  }
  fileInputFor(ref: string): Promise<string | null> {
    return this.call('fileInputFor', ref);
  }
  selectNative(ref: string, option: string): Promise<{ ok: boolean; label?: string; options: string[] }> {
    return this.call('selectNative', ref, option);
  }
  isTextInput(ref: string | null): Promise<boolean> {
    return this.call('isTextInput', ref);
  }
  describe(ref: string): Promise<string> {
    return this.call('describe', ref);
  }
  info(ref: string): Promise<ElementInfo | null> {
    return this.call('info', ref);
  }
  /** The element's rendered text (innerText, a field's value), whitespace collapsed (capture_text). */
  visibleText(ref: string): Promise<string> {
    return this.call('visibleText', ref);
  }
  /** The focused element (type steps without `into`: the field typed into). */
  focused(): Promise<{ desc: string; bbox: BBox } | null> {
    return this.call('focused');
  }
  cursorSet(x: number, y: number, show?: boolean): Promise<void> {
    return this.call('cursor.set', x, y, show);
  }
  cursorShow(show: boolean): Promise<void> {
    return this.call(show ? 'cursor.show' : 'cursor.hide');
  }
  cursorState(): Promise<CursorState> {
    return this.call('cursor.state');
  }
  ripple(x: number, y: number): Promise<void> {
    return this.call('cursor.ripple', x, y);
  }
  ghostShow(name: string, detail: string): Promise<void> {
    return this.call('ghost.show', name, detail);
  }
  ghostHide(): Promise<void> {
    return this.call('ghost.hide');
  }
  fileDragBegin(spec: FileSpec): Promise<void> {
    return this.call('fileDrag.begin', spec);
  }
  fileDragDrop(x: number, y: number): Promise<DropOutcome> {
    return this.call('fileDrag.drop', x, y);
  }
  fileDragCancel(): Promise<void> {
    return this.call('fileDrag.cancel');
  }
}

/**
 * A persistent Chromium context with the kit injected in every document, and named pages:
 * one per environment page key (created lazily) plus tabs opened during the run.
 */
export class BrowserSession {
  readonly pages = new Map<string, Page>();
  private readonly history: string[] = [];
  private readonly clients = new WeakMap<Page, KitClient>();
  private readonly waiters = new Set<(p: Page) => void>();
  private readonly spare: Page[] = [];
  private activeKey: string | null = null;
  private closed = false;
  /** Pages with their own viewport (multi-page scenes, L2.11): the CDP session that keeps it, for the whole run. */
  private readonly emulations = new Map<Page, { session: CDPSession; key: string; ua?: string }>();
  /** Called for every web notification a page of the session shows (set by the runner). */
  onNotification: ((page: Page, n: NotificationPayload) => void) | null = null;
  /** Called for every cursor effect (icon, press, ripple) a page's kit reports (set by the runner, L2.13). */
  onCursorEffect: ((page: Page, e: CursorEffectPayload) => void) | null = null;

  private constructor(
    readonly context: BrowserContext,
    readonly options: SessionOptions,
    readonly source: string,
    private readonly tempProfile: string | null,
  ) {
    for (const p of context.pages()) this.spare.push(p);
    context.on('page', (p) => {
      if (this.waiters.size > 0) {
        for (const w of [...this.waiters]) w(p);
      }
    });
  }

  static async open(opts: SessionOptions): Promise<BrowserSession> {
    const b = opts.browser ?? {};
    const tempProfile = opts.profileDir ? null : await mkdtemp(join(tmpdir(), 'demo-studio-profile-'));
    const userDataDir = opts.profileDir ?? tempProfile!;
    const { executablePath, channel } = launchTarget(b);
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: opts.headed ? false : (b.headless ?? true),
        channel,
        executablePath,
        viewport: { width: opts.width, height: opts.height },
        screen: { width: opts.width, height: opts.height },
        deviceScaleFactor: opts.scale,
        locale: b.locale,
        timezoneId: b.timezone,
        colorScheme: b.color_scheme,
        args: [...DEFAULT_BROWSER_ARGS, ...scaleArgs(opts.scale, opts.headed || b.headless === false, b.args), ...(b.args ?? [])],
        acceptDownloads: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
    } catch (e) {
      if (tempProfile) await rm(tempProfile, { recursive: true, force: true }).catch(() => undefined);
      const m = e instanceof Error ? e.message : String(e);
      const hint = /ProcessSingleton|profile.*in use|SingletonLock/i.test(m)
        ? ` — the profile ${userDataDir} is already in use by another browser (close it, e.g. the login window)`
        : '';
      throw new RunnerError(`could not launch Chromium${hint}: ${m.split('\n')[0]}`, { cause: e });
    }
    const source = kitSource(opts.kit);
    // Web notifications (R-NTF-03): the product may show them (permission granted), the kit reports each one here.
    await context.grantPermissions(['notifications']).catch(() => undefined);
    let session: BrowserSession | null = null;
    await context.exposeBinding(NOTIFICATION_BINDING, (src, payload: NotificationPayload) => {
      try {
        if (session?.onNotification && src.page) session.onNotification(src.page, payload);
      } catch {
        /* a listener error must not reach the page */
      }
    });
    await context.exposeBinding(CURSOR_BINDING, (src, payload: CursorEffectPayload) => {
      try {
        if (session?.onCursorEffect && src.page) session.onCursorEffect(src.page, payload);
      } catch {
        /* a listener error must not reach the page */
      }
    });
    await context.addInitScript({ content: source });
    if (opts.storageState) await applyStorageState(context, opts.storageState);
    session = new BrowserSession(context, opts, source, tempProfile);
    for (const p of context.pages()) await session.kit(p).install().catch(() => undefined);
    return session;
  }

  /** The page being recorded and acted on. */
  get active(): Page {
    if (!this.activeKey) throw new RunnerError('no active page');
    const p = this.pages.get(this.activeKey);
    if (!p) throw new RunnerError(`active page "${this.activeKey}" is gone`);
    return p;
  }

  get activeId(): string | null {
    return this.activeKey;
  }

  kit(page: Page = this.active): KitClient {
    let c = this.clients.get(page);
    if (!c) {
      c = new KitClient(page, this.source);
      this.clients.set(page, c);
    }
    return c;
  }

  idOf(page: Page): string | undefined {
    for (const [id, p] of this.pages) if (p === page) return id;
    return undefined;
  }

  has(id: string): boolean {
    const p = this.pages.get(id);
    return !!p && !p.isClosed();
  }

  /** Page by id; created (blank) when missing. The first page reuses the persistent context's initial tab. */
  async page(id: string): Promise<Page> {
    const existing = this.pages.get(id);
    if (existing && !existing.isClosed()) return existing;
    const spare = this.spare.shift();
    const page = spare && !spare.isClosed() ? spare : await this.context.newPage();
    this.register(id, page);
    return page;
  }

  register(id: string, page: Page): void {
    this.pages.set(id, page);
    page.on('close', () => {
      if (this.pages.get(id) === page) this.pages.delete(id);
    });
  }

  /** Make `id` the active page (bring it to front). */
  async activate(id: string): Promise<Page> {
    const page = await this.page(id);
    if (this.activeKey !== id) {
      if (this.activeKey) this.history.push(this.activeKey);
      this.activeKey = id;
      await page.bringToFront().catch(() => undefined);
    }
    return page;
  }

  /** Previously active page still open. */
  previousId(): string | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const id = this.history[i];
      if (id !== this.activeKey && this.has(id)) return id;
    }
    return undefined;
  }

  /** Resolve with the next page opened in the context within `ms`, else null. */
  waitForNewPage(ms: number): { promise: Promise<Page | null>; cancel: () => void } {
    let done: (p: Page | null) => void = () => undefined;
    const promise = new Promise<Page | null>((resolve) => {
      const timer = setTimeout(() => finish(null), ms);
      const finish = (p: Page | null) => {
        clearTimeout(timer);
        this.waiters.delete(onPage);
        resolve(p);
      };
      const onPage = (p: Page) => finish(p);
      this.waiters.add(onPage);
      done = finish;
    });
    return { promise, cancel: () => done(null) };
  }

  /**
   * Give one page its own viewport (a page of a multi-page scene filmed at mobile or tablet size, L2.11): device
   * metrics (+ mobile emulation, touch and a mobile user agent) on a CDP session kept open for the whole run — the
   * override lives as long as the session that set it (measured: detaching it brings the page back to the window
   * size), and the recorders' own sessions only re-assert the same metrics. Re-applied only when the viewport changes.
   */
  async emulate(page: Page, vp: { width: number; height: number; mobile?: boolean; touch?: boolean }): Promise<void> {
    const scale = this.options.scale;
    const key = `${vp.width}x${vp.height}@${scale}${vp.mobile ? 'm' : ''}${vp.touch ? 't' : ''}`;
    let e = this.emulations.get(page);
    if (e?.key === key) return;
    if (!e) {
      e = { session: await this.context.newCDPSession(page), key: '' };
      this.emulations.set(page, e);
      page.on('close', () => this.emulations.delete(page));
    }
    e.key = key;
    const s = e.session;
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: scale,
      mobile: vp.mobile ?? false,
      screenWidth: vp.width,
      screenHeight: vp.height,
    });
    await s.send('Emulation.setTouchEmulationEnabled', vp.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    if (vp.mobile) {
      e.ua ??= await page.evaluate(() => navigator.userAgent).catch(() => undefined);
      if (e.ua) await s.send('Emulation.setUserAgentOverride', { userAgent: mobileUserAgent(e.ua) }).catch(() => undefined);
    } else if (e.ua) {
      await s.send('Emulation.setUserAgentOverride', { userAgent: e.ua }).catch(() => undefined);
    }
  }

  /** Whether a page has its own viewport (`emulate`). */
  emulated(page: Page): boolean {
    return this.emulations.has(page);
  }

  async newPage(id: string): Promise<Page> {
    const page = await this.context.newPage();
    this.register(id, page);
    return page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    if (this.tempProfile) await rm(this.tempProfile, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A mobile user agent derived from the browser's own (same engine and version): the platform token becomes an Android
 * phone and "Mobile" is added, so sites that pick their layout from the user agent serve the phone one.
 */
export function mobileUserAgent(ua: string): string {
  let out = ua.replace(/\([^)]*\)/, '(Linux; Android 14; K)');
  if (!/\bMobile\b/.test(out)) out = out.replace(/ Safari\//, ' Mobile Safari/');
  return out;
}

async function applyStorageState(context: BrowserContext, file: string): Promise<void> {
  let state: StorageStateFile;
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as StorageStateFile;
  } catch (e) {
    throw new RunnerError(`cannot read storage_state ${file}: ${(e as Error).message}`);
  }
  if (state.cookies?.length) await context.addCookies(state.cookies);
  const origins = (state.origins ?? []).filter((o) => o.localStorage?.length);
  if (origins.length) {
    // Applied before page scripts; keys already present (set by the app since) are kept.
    await context.addInitScript({
      content: `(() => { const o = ${JSON.stringify(origins)}.find((x) => x.origin === location.origin);
        if (!o) return; try { for (const kv of o.localStorage) if (localStorage.getItem(kv.name) === null) localStorage.setItem(kv.name, kv.value); } catch {} })();`,
    });
  }
}

/** Launch + kit injection (lower-level entry point; used by tests and live previews). */
export function openSession(opts: SessionOptions): Promise<BrowserSession> {
  return BrowserSession.open(opts);
}
