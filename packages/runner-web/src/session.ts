import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import type { BrowserConfig, ResolvedClock } from '@retake/core';
import { registerSessionCopy } from './copies.js';
import { RunnerError, StepError } from './errors.js';
import { kitSource } from './kit/source.js';
import { trackRequests } from './network.js';
import { armWriteGuard, bypassServiceWorkers, enableServiceWorkerRequests, unloadPages } from './write-guard.js';
import { isRealTimePage, productClockScript } from './product-clock.js';
import type { ProductClockConfig } from './product-clock.js';
import type { PageRole, WriteGuardOptions } from './write-guard.js';
import type {
  CalendarInfo,
  CursorEffectPayload,
  CursorState,
  DropOutcome,
  ElementInfo,
  FieldState,
  FileSpec,
  FindOptions,
  InventoryOptions,
  KitConfig,
  KitInventory,
  KitTargetChecks,
  MenuTrigger,
  OutsidePlan,
  PointInfo,
  PopupEntry,
  PositionalTrigger,
  ResolveResult,
  RestAt,
  RestPlan,
  ScrollInfo,
  ScrollOp,
} from './kit/types.js';
import type { BBox, NearElement, PointSpec, TargetObject } from '@retake/core';

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
  /**
   * One browser per persona (L1.6, "realms"): each launched like the single context above, on its own profile. Without
   * it the session is that single context (profileDir / storageState / a temp profile) — the realm named "".
   */
  realms?: RealmSpec[];
  /** The realm a capture page id is created in (default: ""). A tab opened by a page goes to that page's realm. */
  realmOf?: (pageId: string) => string;
  /** The realm of a js hook tab (environment page key; default: ""). */
  hookRealmOf?: (key: string) => string;
  /**
   * A read-only run (L1.7): every realm is armed with the write guard at launch (write-guard.ts), realms launched later
   * too; its pages are closed through about:blank.
   */
  writes?: WriteGuardOptions;
}

/** Playwright storage state: cookies + localStorage per origin. */
export interface StorageStateFile {
  cookies?: Parameters<BrowserContext['addCookies']>[0];
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
}

/** One persona's browser (L1.6): a persistent context of its own. */
export interface RealmSpec {
  /** The persona; "" = the default browser (pages without a persona). */
  name: string;
  /** Chromium user-data-dir (a per-run copy of the persona's profile). Default: a fresh temporary profile. */
  userDataDir?: string;
  /** Applied at launch: an object, or a storage-state file (cookies + localStorage). */
  storageState?: StorageStateFile | string;
  /** Directories removed when the session closes (the per-run copy), or when the launch fails. */
  cleanup?: string[];
}

interface Realm {
  name: string;
  context: BrowserContext;
  /** The context's initial tab, reused by the first page created in this realm. */
  spare: Page[];
  /** Temporary profile created for the realm (removed on close). */
  temp: string | null;
  cleanup: string[];
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
 * `browser.frame_rate_limit: false` launches Chromium without its frame rate limiter (L1.3). With the limiter, frame
 * production stops ≈ 0.26 s after a dialog whose overlay has a backdrop-filter closes (measured on macOS / Metal: the
 * click ripple freezes in the capture); without it that stall is gone, but the compositor draws back to back:
 * requestAnimationFrame runs at thousands of Hz while anything animates (24 000 Hz with a CSS spinner on screen), so
 * animations that advance a fixed step per frame play far too fast, and the CPU climbs 2–6×. Default: the limiter.
 */
export function frameRateArgs(b: Pick<BrowserConfig, 'frame_rate_limit' | 'args'> = {}): string[] {
  if (b.frame_rate_limit !== false || b.args?.includes('--disable-frame-rate-limit')) return [];
  return ['--disable-frame-rate-limit'];
}

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
export const NOTIFICATION_BINDING = '__retakeNotification';
/** Name of the binding the kit calls with what its cursor shows: icon changes, presses, click ripples (L2.13). */
export const CURSOR_BINDING = '__retakeCursor';

/** playwright-core launch target for a browser config: an executable, else a channel (new headless by default). */
export function launchTarget(b: BrowserConfig = {}): { executablePath?: string; channel?: string } {
  const executablePath = b.executable ?? process.env.RETAKE_CHROMIUM ?? undefined;
  const channel = executablePath ? undefined : b.channel === 'headless-shell' ? undefined : (b.channel ?? 'chromium');
  return { executablePath, channel };
}

function isContextDestroyed(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /Execution context was destroyed|Cannot find context with specified id|frame was detached|because of a navigation/i.test(m);
}

function cleanEvalError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^page\.evaluate: /, '').replace(/^Error: /, '').split('\n    at ')[0];
}

/** The page replaced its document during a kit call that must not be retried (`KitClient.callOnce`). */
export class DocumentChangedError extends StepError {
  constructor() {
    super('the page navigated during the inspection');
  }
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
    return this.callWith<T>(true, path, args);
  }

  /**
   * One call in the document the page shows now (an inspection, L3.3): a document replaced during the call (a late
   * navigation) is an error, never retried in the new one — whatever that document holds is not what was asked for.
   * A document that has no kit when the call starts (its init script not run) gets it installed and the call runs
   * there: whichever document answers, the inventory and the target checks return its origin, which the inspection
   * checks.
   */
  callOnce<T>(path: string, ...args: unknown[]): Promise<T> {
    return this.callWith<T>(false, path, args);
  }

  private async callWith<T>(retry: boolean, path: string, args: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.page.evaluate(
          async ([p, a]): Promise<{ missing: boolean; value?: unknown }> => {
            const k = (window as unknown as { __retake?: Record<string, unknown> }).__retake;
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
        if (isContextDestroyed(e) && !retry) throw new DocumentChangedError();
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
  scrollPlan(ref: string, margin: number, centre = false): Promise<ScrollOp | null> {
    return centre ? this.call('scrollPlan', ref, margin, true) : this.call('scrollPlan', ref, margin);
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
  restPoint(where?: 'side' | 'centre', avoid?: BBox[]): Promise<PointSpec> {
    if (avoid) return this.call('restPoint', where ?? 'side', avoid);
    return where ? this.call('restPoint', where) : this.call('restPoint');
  }
  watchChanges(): Promise<void> {
    return this.call('watchChanges');
  }
  changedBoxes(): Promise<{ watching: boolean; boxes: BBox[] }> {
    return this.call('changedBoxes');
  }
  textBox(ref: string): Promise<BBox | null> {
    return this.call('textBox', ref);
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
  menuTrigger(rowRef: string, hovered = false): Promise<MenuTrigger> {
    return this.call('menuTrigger', rowRef, hovered);
  }
  positionalTrigger(rowRef: string): Promise<PositionalTrigger | null> {
    return this.call('positionalTrigger', rowRef);
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
  fieldState(ref: string | null): Promise<FieldState | null> {
    return this.call('fieldState', ref);
  }
  clearField(ref: string | null): Promise<'setter' | 'editor' | null> {
    return this.call('clearField', ref);
  }
  calendar(): Promise<CalendarInfo | null> {
    return this.call('calendar');
  }
  setNativeValue(ref: string, value: string): Promise<boolean> {
    return this.call('setNativeValue', ref, value);
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
  /** The focused element (type steps without `into`: the field typed into; `input_type`: a password field or not). */
  focused(): Promise<{ desc: string; bbox: BBox; input_type: string } | null> {
    return this.call('focused');
  }
  /** Inspection (L3.3): the visible interactive elements with verified suggested targets (one in-page call). */
  inventory(opts: InventoryOptions = {}): Promise<KitInventory> {
    return this.callOnce('inventory', opts);
  }
  /** Inspection (L3.3): `find` for each (normalised) target. */
  checkTargets(targets: TargetObject[]): Promise<KitTargetChecks> {
    return this.callOnce('checkTargets', targets);
  }
  /** L5.6: `find` for each target without acting, with the closest visible elements of those not found. */
  closest(targets: TargetObject[]): Promise<Array<{ count: number; near: NearElement[] }>> {
    return this.call('closest', targets);
  }
  /** L5.6: whether the focus is on `ref` (a `type` step's field) and what has it. */
  focusCheck(ref: string): Promise<{ ok: boolean; desc: string | null; field: string | null }> {
    return this.call('focusCheck', ref);
  }
  /** L5.6: a field's value (input, textarea) or text (contenteditable); null for other elements. */
  fieldValue(ref: string | null): Promise<string | null> {
    return this.call('fieldValue', ref);
  }
  /** L5.6: start counting what a click changes on the page (dead-click detection). */
  effectWatch(): Promise<void> {
    return this.call('effectWatch');
  }
  effectSeen(): Promise<{ watching: boolean; dom: number; first: string; events: string[] }> {
    return this.call('effectSeen');
  }
  effectStop(): Promise<void> {
    return this.call('effectStop');
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
  /** Draw the cursor of a document that has not painted content of its own (after the load the runner waited for). */
  cursorReveal(): Promise<void> {
    return this.call('cursor.reveal');
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
 * Persistent Chromium contexts with the kit injected in every document, and named pages: one per environment page key
 * (created lazily) plus tabs opened during the run. A run signed in as personas has one context per persona (L1.6,
 * "realms": each its own browser process and cookie jar), plus the default one for pages without a persona; without
 * personas there is one context, as before.
 */
export class BrowserSession {
  readonly pages = new Map<string, Page>();
  /**
   * Tabs of js hooks by environment page key (hook-page.ts): guarded tabs that live as long as the session, never
   * capture pages (not in `pages`, never active or recorded).
   */
  readonly hookPages = new Map<string, Page>();
  private readonly history: string[] = [];
  private readonly clients = new WeakMap<Page, KitClient>();
  private readonly openers = new WeakMap<Page, Page>();
  private readonly waiters = new Set<(p: Page) => void>();
  private activeKey: string | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  /** Pages with their own viewport (multi-page scenes, L2.11): the CDP session that keeps it, for the whole run. */
  private readonly emulations = new Map<Page, { session: CDPSession; key: string; ua?: string }>();
  private readonly realms: Realm[] = [];
  /** A realm launched after the others (the default browser for a page no plan foresaw). */
  private readonly launching = new Map<string, Promise<Realm>>();
  /** Called for every web notification a page of the session shows (set by the runner). */
  onNotification: ((page: Page, n: NotificationPayload) => void) | null = null;
  /** Called for every cursor effect (icon, press, ripple) a page's kit reports (set by the runner, L2.13). */
  onCursorEffect: ((page: Page, e: CursorEffectPayload) => void) | null = null;
  /** Tabs with a guard of their own (js hook tabs): the context's write guard lets their requests through to it. */
  private readonly ownGuard = new WeakSet<Page>();
  /** The automated sign-in tabs (L1.6) → whether a URL is its sign-in page: exempt from the write guard there (L1.7). */
  private readonly signIn = new WeakMap<Page, (url: string) => boolean>();
  /** The product's clock (L1.7): installed after the preflight (installClock), anchored at capture time 0. */
  private clockState: ProductClockConfig | null = null;

  private constructor(
    readonly options: SessionOptions,
    readonly source: string,
  ) {}

  private adopt(realm: Realm): void {
    this.realms.push(realm);
    for (const p of realm.context.pages()) {
      this.clockWorkers(p);
      trackRequests(p);
    }
    realm.context.on('page', (p) => {
      this.clockWorkers(p);
      // Requests in flight are counted from the page's birth (`wait_for: {network_idle}`, network.ts).
      trackRequests(p);
      if (this.waiters.size > 0) {
        for (const w of [...this.waiters]) w(p);
      }
    });
  }

  /** Dedicated workers of a page get the product's clock as soon as they start (their first lines may run before it). */
  private clockWorkers(page: Page): void {
    page.on('worker', (w) => {
      const c = this.clockState;
      if (c && !isRealTimePage(page)) w.evaluate(productClockScript(c)).catch(() => undefined);
    });
  }

  static async open(opts: SessionOptions): Promise<BrowserSession> {
    const source = kitSource(opts.kit);
    const session = new BrowserSession(opts, source);
    const specs: RealmSpec[] = opts.realms?.length ? opts.realms : [{ name: '', userDataDir: opts.profileDir, storageState: opts.storageState }];
    // Every realm at once; when one fails, the launched ones are closed and every copy removed before throwing.
    const launched = await Promise.allSettled(specs.map((spec) => launchRealm(opts, spec, source, session)));
    const failed = launched.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      for (const r of launched) if (r.status === 'fulfilled') await closeRealm(r.value);
      for (const spec of specs) for (const dir of spec.cleanup ?? []) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw failed.reason;
    }
    for (const r of launched) if (r.status === 'fulfilled') session.adopt(r.value);
    for (const realm of session.realms) for (const p of realm.context.pages()) await session.kit(p).install().catch(() => undefined);
    return session;
  }

  /** The default realm's context (else the first realm's): js tools and tests that want "the" browser context. */
  get context(): BrowserContext {
    return (this.realms.find((r) => r.name === '') ?? this.realms[0]).context;
  }

  /** Every context of the session (one per realm). */
  get contexts(): BrowserContext[] {
    return this.realms.map((r) => r.context);
  }

  /**
   * The browser's version ("141.0.7390.37", run.json `engine.chromium`), read over CDP on a page of the session (a
   * persistent context has no Browser object); undefined when it cannot be read.
   */
  async browserVersion(): Promise<string | undefined> {
    const context = this.context;
    const page = context.pages()[0];
    if (!page) return undefined;
    try {
      const cdp = await context.newCDPSession(page);
      try {
        const { product } = await cdp.send('Browser.getVersion');
        return /\/(\S+)$/.exec(product)?.[1] ?? product;
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch {
      return undefined;
    }
  }

  /** A browser-level CDP session per realm (L5.7: Chromium's process and GPU reports), opened once. */
  private readonly browserCdp = new Map<Realm, Promise<CDPSession | null>>();

  private browserTarget(realm: Realm): Promise<CDPSession | null> {
    let p = this.browserCdp.get(realm);
    if (!p) {
      const browser = realm.context.browser();
      p = browser ? browser.newBrowserCDPSession().catch(() => null) : Promise.resolve(null);
      this.browserCdp.set(realm, p);
    }
    return p;
  }

  /**
   * Chromium's own report of its processes (L5.7, run.json `perf`): per realm (persona; "" = none), each process's
   * kind ("browser", "GPU", "renderer", a utility's service name), pid and CPU seconds so far. Realms that cannot answer
   * are left out.
   */
  async processInfo(): Promise<Array<{ realm: string; type: string; pid: number; cpu: number }>> {
    const out: Array<{ realm: string; type: string; pid: number; cpu: number }> = [];
    await Promise.all(
      this.realms.map(async (realm) => {
        const cdp = await this.browserTarget(realm);
        if (!cdp) return;
        try {
          const r = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: Array<{ type: string; id: number; cpuTime: number }> };
          for (const p of r.processInfo) out.push({ realm: realm.name, type: p.type, pid: p.id, cpu: p.cpuTime });
        } catch {
          /* closing, or an older browser */
        }
      }),
    );
    return out;
  }

  /**
   * Is the capture browser GPU-accelerated (L5.7, R-FLD-24)? Chromium's own feature report (the one chrome://gpu shows):
   * compositing and rasterization in hardware, the GL renderer (ANGLE Metal, SwiftShader…), the features that fell back
   * to software. Undefined when it cannot be read.
   */
  async gpuInfo(): Promise<GpuInfo | undefined> {
    const realm = this.realms[0];
    const cdp = realm ? await this.browserTarget(realm) : null;
    if (!cdp) return undefined;
    try {
      return gpuInfoOf((await cdp.send('SystemInfo.getInfo')) as SystemInfoReply);
    } catch {
      return undefined;
    }
  }

  /** The realm (persona; "" = none) a page belongs to; undefined for a page of another browser. */
  realmName(page: Page): string | undefined {
    const ctx = page.context();
    return this.realms.find((r) => r.context === ctx)?.name;
  }

  /** The context of a realm, launched now when the run did not foresee it (the default browser only). */
  async contextOf(realm: string): Promise<BrowserContext> {
    return (await this.realm(realm)).context;
  }

  /** The context a js hook tab of environment page `key` opens in. */
  hookContext(key: string): Promise<BrowserContext> {
    return this.contextOf(this.options.hookRealmOf?.(key) ?? '');
  }

  private async realm(name: string): Promise<Realm> {
    const known = this.realms.find((r) => r.name === name);
    if (known) return known;
    if (this.closed) throw new RunnerError('the browser session is closed');
    if (name !== '') {
      this.options.log?.('warn', `no browser was prepared for persona "${name}": the page opens without a persona`);
      return this.realm('');
    }
    let p = this.launching.get(name);
    if (!p) {
      this.options.log?.('debug', 'opening the default browser for a page without a persona');
      p = launchRealm(this.options, { name }, this.source, this).then(async (r) => {
        this.adopt(r);
        // A browser opened after the clock was installed reads the same time as the others.
        await this.applyClock(r.context);
        return r;
      });
      this.launching.set(name, p);
    }
    return p;
  }

  /** How the write guard treats a page (write-guard.ts): asked at request time. */
  pageRole(page: Page): PageRole {
    if (this.ownGuard.has(page)) return 'hook';
    const onSignInPage = this.signIn.get(page);
    return !onSignInPage ? 'capture' : onSignInPage(page.url()) ? 'sign-in' : 'signed-in';
  }

  /** A tab that guards its own requests (a js hook tab, hook-page.ts), before it loads anything. */
  markOwnGuard(page: Page): void {
    this.ownGuard.add(page);
  }

  /**
   * The automated sign-in tab of a persona (auth.ts autoLogin), before it loads anything: exempt from the write guard
   * while its main frame is on a sign-in page (`onSignInPage`), guarded elsewhere; it bypasses service workers.
   */
  async markSignIn(page: Page, onSignInPage: (url: string) => boolean): Promise<void> {
    this.signIn.set(page, onSignInPage);
    if (this.options.writes) await bypassServiceWorkers(page);
  }

  /**
   * Install the product's clock (L1.7, R-ENV-05) in every realm — after the preflight (the session check and the
   * automated sign-in run on the real time) and before the setup hooks: a Date-only clock (product-clock.ts: `Date` and
   * Intl's default date; timers, frames and `performance` stay real) in every document, frame and dedicated worker,
   * hook tabs included. `freeze`: the time never moves; otherwise it runs from the install, and anchorClock sets it
   * back to the clock's time at capture time 0.
   */
  async installClock(c: Pick<ResolvedClock, 'epoch_ms' | 'freeze'>): Promise<void> {
    this.clockState = { epoch: c.epoch_ms, since: Date.now(), freeze: c.freeze === true };
    await Promise.all(this.realms.map((r) => this.applyClock(r.context)));
  }

  /**
   * Capture time 0: the product reads exactly the clock's time now, in every realm (a running clock; no-op otherwise).
   * Every document computes the time from the same anchor: documents created before and after it agree.
   */
  async anchorClock(): Promise<void> {
    const c = this.clockState;
    if (!c || c.freeze) return;
    this.clockState = { ...c, since: Date.now() };
    await Promise.all(this.realms.map((r) => this.applyClock(r.context)));
  }

  /** The clock in a context: for its new documents (an init script; a later one moves an earlier one) and its open ones. */
  private async applyClock(context: BrowserContext): Promise<void> {
    const c = this.clockState;
    if (!c) return;
    const script = productClockScript(c);
    await context.addInitScript({ content: script });
    const pages = context.pages().filter((p) => !isRealTimePage(p));
    await Promise.all(
      pages.flatMap((p) => [...p.frames().map((f) => f.evaluate(script).catch(() => undefined)), ...p.workers().map((w) => w.evaluate(script).catch(() => undefined))]),
    );
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

  /** The page key of a js hook tab (`hookPages`). */
  hookPageId(page: Page): string | undefined {
    for (const [id, p] of this.hookPages) if (p === page) return id;
    return undefined;
  }

  has(id: string): boolean {
    const p = this.pages.get(id);
    return !!p && !p.isClosed();
  }

  /**
   * Page by id; created (blank) when missing, in its realm (`realmOf`). The first page of a realm reuses its persistent
   * context's initial tab.
   */
  async page(id: string): Promise<Page> {
    const existing = this.pages.get(id);
    if (existing && !existing.isClosed()) return existing;
    const realm = await this.realm(this.options.realmOf?.(id) ?? '');
    const spare = realm.spare.shift();
    const page = spare && !spare.isClosed() ? spare : await realm.context.newPage();
    this.register(id, page);
    return page;
  }

  /**
   * A tab nobody films in the realm of page `id` (L5.7, `capture.prewarm`): not registered, never active; the caller
   * closes it.
   */
  async scratchPage(id: string): Promise<Page> {
    const realm = await this.realm(this.options.realmOf?.(id) ?? '');
    return realm.context.newPage();
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
      e = { session: await page.context().newCDPSession(page), key: '' };
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

  /** A new tab named `id`: in the realm of `like` (the page it is opened from), else in `id`'s realm. */
  async newPage(id: string, opts: { like?: Page } = {}): Promise<Page> {
    const context = opts.like ? opts.like.context() : (await this.realm(this.options.realmOf?.(id) ?? '')).context;
    const page = await context.newPage();
    if (opts.like) this.opened(page, opts.like);
    this.register(id, page);
    return page;
  }

  /** Remember the page a tab was opened from (new_tab): a tab of a `persona: none` page is not guarded either (L1.6). */
  opened(page: Page, opener: Page): void {
    this.openers.set(page, opener);
  }

  /** The page a tab was opened from (new_tab), if any. */
  openerOf(page: Page): Page | undefined {
    return this.openers.get(page);
  }

  /** Close every browser and remove its copies; a second call waits for the first (an interrupt and the command both close). */
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      const late = await Promise.all([...this.launching.values()].map((p) => p.catch(() => null)));
      for (const r of late) if (r && !this.realms.includes(r)) this.realms.push(r);
      // A read-only run: what the pages send while they unload still meets the guard (write-guard.ts).
      await Promise.all(this.realms.map((r) => unloadPages(r.context)));
      await Promise.all(this.realms.map((r) => closeRealm(r)));
    })();
    return this.closing;
  }
}

/** What `gpuInfo` reads of SystemInfo.getInfo. */
export interface SystemInfoReply {
  gpu?: {
    featureStatus?: Record<string, string>;
    devices?: Array<{ deviceString?: string }>;
    auxAttributes?: Record<string, unknown>;
  };
}

/** The capture browser's GPU status (run.json `perf.gpu`, `retake doctor`). */
export interface GpuInfo {
  accelerated: boolean;
  renderer?: string;
  /** Features that run in software (e.g. "gpu_compositing", "rasterization"). */
  software?: string[];
}

/**
 * Hardware accelerated when compositing and rasterization are ("enabled…"); a SwiftShader renderer is software whatever
 * the statuses say. Pure.
 */
export function gpuInfoOf(info: SystemInfoReply): GpuInfo | undefined {
  const status = info.gpu?.featureStatus;
  if (!status) return undefined;
  const gl = info.gpu?.auxAttributes?.glRenderer;
  const renderer = typeof gl === 'string' && gl ? gl : info.gpu?.devices?.[0]?.deviceString || undefined;
  const on = (k: string) => typeof status[k] === 'string' && status[k].startsWith('enabled');
  const software = Object.entries(status)
    .filter(([, v]) => /software/.test(v))
    .map(([k]) => k)
    .sort();
  const accelerated = on('gpu_compositing') && on('rasterization') && !/swiftshader|llvmpipe|software/i.test(renderer ?? '');
  return { accelerated, ...(renderer ? { renderer } : {}), ...(software.length ? { software } : {}) };
}

/** Launch one realm: a persistent context with the kit, the bindings, the notification permission and its session. */
async function launchRealm(opts: SessionOptions, spec: RealmSpec, source: string, session: BrowserSession): Promise<Realm> {
  const b = opts.browser ?? {};
  const temp = spec.userDataDir ? null : await mkdtemp(join(tmpdir(), 'retake-profile-'));
  if (temp) registerSessionCopy(temp);
  const userDataDir = spec.userDataDir ?? temp!;
  const { executablePath, channel } = launchTarget(b);
  if (opts.writes) enableServiceWorkerRequests();
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
      args: [...DEFAULT_BROWSER_ARGS, ...frameRateArgs(b), ...scaleArgs(opts.scale, opts.headed || b.headless === false, b.args), ...(b.args ?? [])],
      acceptDownloads: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (e) {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    const m = e instanceof Error ? e.message : String(e);
    const hint = /ProcessSingleton|profile.*in use|SingletonLock/i.test(m)
      ? ` — the profile ${userDataDir} is already in use by another browser (close it, e.g. the login window)`
      : '';
    throw new RunnerError(`could not launch Chromium${spec.name ? ` (persona ${spec.name})` : ''}${hint}: ${m.split('\n')[0]}`, { cause: e });
  }
  const realm: Realm = { name: spec.name, context, spare: [...context.pages()], temp, cleanup: spec.cleanup ?? [] };
  try {
    // Web notifications (R-NTF-03): the product may show them (permission granted), the kit reports each one here.
    await context.grantPermissions(['notifications']).catch(() => undefined);
    await context.exposeBinding(NOTIFICATION_BINDING, (src, payload: NotificationPayload) => {
      try {
        if (session.onNotification && src.page) session.onNotification(src.page, payload);
      } catch {
        /* a listener error must not reach the page */
      }
    });
    await context.exposeBinding(CURSOR_BINDING, (src, payload: CursorEffectPayload) => {
      try {
        if (session.onCursorEffect && src.page) session.onCursorEffect(src.page, payload);
      } catch {
        /* a listener error must not reach the page */
      }
    });
    await context.addInitScript({ content: source });
    if (spec.storageState) await applyStorageState(context, spec.storageState);
    // Read-only run (L1.7): armed before any page loads — the preflight's check page included.
    if (opts.writes) await armWriteGuard(context, opts.writes, (page) => session.pageRole(page));
  } catch (e) {
    await closeRealm(realm);
    throw e;
  }
  return realm;
}

async function closeRealm(r: Realm): Promise<void> {
  await r.context.close().catch(() => undefined);
  for (const dir of [...(r.temp ? [r.temp] : []), ...r.cleanup]) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
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

/** Apply a storage state to a context: its cookies, and its localStorage by an init script (keys the app set are kept). */
export async function applyStorageState(context: BrowserContext, from: StorageStateFile | string): Promise<void> {
  let state: StorageStateFile;
  if (typeof from === 'string') {
    try {
      state = JSON.parse(await readFile(from, 'utf8')) as StorageStateFile;
    } catch (e) {
      throw new RunnerError(`cannot read storage_state ${from}: ${(e as Error).message}`);
    }
  } else state = from;
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
