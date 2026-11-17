import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { machineZone } from '@retake/core/environment';
import type { ResolvedClock } from '@retake/core/environment';
import type { GpuInfo } from '@retake/core/render';
import { registerSessionCopy } from './copies.js';
import { checkProfileBrowser, launchMajor, recordProfileBrowser } from './profile-browser.js';
import { RunnerError } from './errors.js';
import { kitSource } from './kit/source.js';
import { launchOptions, launchTarget, refuseUnsandboxed } from './launch.js';
import { trackRequests } from './network.js';
import { armWriteGuard, bypassServiceWorkers, enableServiceWorkerRequests, unloadPages } from './write-guard.js';
import { isRealTimePage, productClockScript } from './product-clock.js';
import type { ProductClockConfig } from './product-clock.js';
import { readPageDating, settleDating } from './page-dating.js';
import type { PageDating } from './page-dating.js';
import type { PageRole } from './write-guard.js';
import type { CursorEffectPayload } from './kit/types.js';
import { bestEffort, errorMessage } from '@retake/core/base';
import { DEFAULT_BROWSER_ARGS, frameRateArgs, scaleArgs } from './browser-args.js';
import { applyStorageState, armFileGuard } from './browser-state.js';
import { KitClient } from './kit-client.js';
import { emulatePage } from './page-emulation.js';
import type { EmulatedViewport, PageEmulation } from './page-emulation.js';
import { BrowserReports, browserVersionOf } from './browser-reports.js';
import { exposeKitBindings } from './kit-bindings.js';
import type { NotificationPayload } from './kit-bindings.js';
import { closeRealm } from './session-options.js';
import type { Realm, RealmSpec, SessionOptions } from './session-options.js';

export type { RealmSpec, SessionOptions } from './session-options.js';
export { DEFAULT_BROWSER_ARGS, frameRateArgs, mobileUserAgent, scaleArgs } from './browser-args.js';
export { applyStorageState, armFileGuard } from './browser-state.js';
export type { StorageStateFile } from './browser-state.js';
export { DocumentChangedError, KitClient } from './kit-client.js';
export { CURSOR_BINDING, NOTIFICATION_BINDING, NOTIFICATION_ICON_URL_MAX, NOTIFICATION_TEXT_MAX, readNotificationPayload } from './kit-bindings.js';
export type { NotificationPayload } from './kit-bindings.js';

/** playwright-core launch target for a browser config (launch.ts). */
export { launchTarget } from './launch.js';

/**
 * Persistent Chromium contexts with the kit injected in every document, and named pages: one per environment page key
 * (created lazily) plus tabs opened during the run. A run signed in as personas has one context per persona ("realms":
 * each its own browser process and cookie jar), plus the default one for pages without a persona; without
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
  /** Pages with their own viewport (multi-page scenes): the CDP session that keeps it, for the whole run. */
  private readonly emulations = new Map<Page, PageEmulation>();
  private readonly realms: Realm[] = [];
  /** A realm launched after the others (the default browser for a page no plan foresaw). */
  private readonly launching = new Map<string, Promise<Realm>>();
  /** Called for every web notification a page of the session shows (set by the runner). */
  onNotification: ((page: Page, n: NotificationPayload) => void) | null = null;
  /** Called for every cursor effect (icon, press, ripple) a page's kit reports (set by the runner). */
  onCursorEffect: ((page: Page, e: CursorEffectPayload) => void) | null = null;
  /** Tabs with a guard of their own (js hook tabs): the context's write guard lets their requests through to it. */
  private readonly ownGuard = new WeakSet<Page>();
  /** The automated sign-in tabs → whether a URL is its sign-in page: exempt from the write guard there. */
  private readonly signIn = new WeakMap<Page, (url: string) => boolean>();
  /** The product's clock: installed after the preflight (installClock), anchored at capture time 0. */
  private clockState: ProductClockConfig | null = null;
  /** The zone and locale the filmed pages write dates in (dating()). */
  private datingState: PageDating = {};

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
    // Before any page loads: the browser's own Intl defaults (R-MAIL-05).
    session.datingState = settleDating(await readPageDating(session.realms[0]?.context.pages()[0]), opts.browser, machineZone());
    for (const realm of session.realms)
      for (const p of realm.context.pages())
        await session
          .kit(p)
          .install()
          .catch(() => undefined);
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
  browserVersion(): Promise<string | undefined> {
    return browserVersionOf(this.context);
  }

  /** Chromium's process and GPU reports, over a browser-level CDP session per realm opened once. */
  private readonly reports = new BrowserReports();

  /**
   * Chromium's own report of its processes (run.json `perf`): per realm (persona; "" = none), each process's
   * kind ("browser", "GPU", "renderer", a utility's service name), pid and CPU seconds so far. Realms that cannot answer
   * are left out.
   */
  processInfo(): Promise<Array<{ realm: string; type: string; pid: number; cpu: number }>> {
    return this.reports.processInfo(this.realms);
  }

  /**
   * Is the capture browser GPU-accelerated (R-FLD-24)? Chromium's own feature report (the one chrome://gpu shows):
   * compositing and rasterization in hardware, the GL renderer (ANGLE Metal, SwiftShader…), the features that fell back
   * to software. Undefined when it cannot be read.
   */
  gpuInfo(): Promise<GpuInfo | undefined> {
    return this.reports.gpuInfo(this.realms[0]);
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

  /** Whether the session has a browser for realm (persona) `name`. */
  hasRealm(name: string): boolean {
    return this.realms.some((r) => r.name === name);
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
   * Install the product's clock (R-ENV-05) in every realm — after the preflight (the session check and the
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

  /**
   * What the product's clock reads at real instant `epochMs` (epoch ms): `epoch + (epochMs − since)`, the clock's time
   * when frozen — the time the in-page clock gives every document (product-clock.ts). Undefined without a clock.
   */
  productTime(epochMs: number): number | undefined {
    const c = this.clockState;
    if (!c) return undefined;
    return c.freeze ? c.epoch : c.epoch + (epochMs - c.since);
  }

  /**
   * The time zone and locale the filmed pages write dates in (R-MAIL-05), the same in every realm (each is launched
   * with the run's `browser.timezone` / `browser.locale`): read once when the session opened (page-dating.ts).
   */
  dating(): PageDating {
    return this.datingState;
  }

  /** The clock in a context: for its new documents (an init script; a later one moves an earlier one) and its open ones. */
  private async applyClock(context: BrowserContext): Promise<void> {
    const c = this.clockState;
    if (!c) return;
    const script = productClockScript(c);
    await context.addInitScript({ content: script });
    const pages = context.pages().filter((p) => !isRealTimePage(p));
    await Promise.all(pages.flatMap((p) => [...p.frames().map((f) => f.evaluate(script).catch(() => undefined)), ...p.workers().map((w) => w.evaluate(script).catch(() => undefined))]));
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
   * A tab nobody films in the realm of page `id` (`capture.prewarm`): not registered, never active; the caller
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
   * Give one page its own viewport (a page of a multi-page scene filmed at mobile or tablet size): device
   * metrics (+ mobile emulation, touch and a mobile user agent) on a CDP session kept open for the whole run — the
   * override lives as long as the session that set it (measured: detaching it brings the page back to the window
   * size), and the recorders' own sessions only re-assert the same metrics. Re-applied only when the viewport changes.
   */
  async emulate(page: Page, vp: EmulatedViewport): Promise<void> {
    await emulatePage(this.emulations, page, vp, this.options.scale);
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

  /** Remember the page a tab was opened from (new_tab): a tab of a `persona: none` page is not guarded either. */
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
      const late = await Promise.all([...this.launching.values()].map((p) => bestEffort(p, 'a browser that failed to launch has nothing to close', null)));
      for (const r of late) if (r && !this.realms.includes(r)) this.realms.push(r);
      // A read-only run: what the pages send while they unload still meets the guard (write-guard.ts).
      await Promise.all(this.realms.map((r) => unloadPages(r.context)));
      await Promise.all(this.realms.map((r) => closeRealm(r)));
    })();
    return this.closing;
  }
}

// The GPU status reading moved to core (the render browser reads it too); re-exported for this package's users.
export { gpuInfoOf } from '@retake/core/render';
export type { GpuInfo, SystemInfoReply } from '@retake/core/render';

/** Launch one realm: a persistent context with the kit, the bindings, the notification permission and its session. */
async function launchRealm(opts: SessionOptions, spec: RealmSpec, source: string, session: BrowserSession): Promise<Realm> {
  const b = opts.browser ?? {};
  // The target first: a refused executable leaves no temporary profile behind.
  const { executablePath, channel } = launchTarget(b, { headless: opts.headed ? false : (b.headless ?? true), policy: opts.policy });
  const temp = spec.userDataDir ? null : await mkdtemp(join(tmpdir(), 'retake-profile-'));
  if (temp) registerSessionCopy(temp);
  const userDataDir = spec.userDataDir ?? temp!;
  if (opts.writes) enableServiceWorkerRequests();
  // A persona's profile is never opened by an older Chromium than the one that opened it last.
  const major = spec.userDataDir ? launchMajor({ executablePath, channel }) : null;
  if (spec.userDataDir) {
    try {
      checkProfileBrowser(spec.userDataDir, major, spec.name || undefined);
    } catch (e) {
      if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }
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
      acceptDownloads: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ...(opts.httpCredentials ? { httpCredentials: { ...opts.httpCredentials } } : {}),
      ...launchOptions({ args: [...DEFAULT_BROWSER_ARGS, ...frameRateArgs(b), ...scaleArgs(opts.scale, opts.headed || b.headless === false, b.args)], browserArgs: b.args, policy: opts.policy }),
    });
  } catch (e) {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    const m = errorMessage(e);
    const hint = /ProcessSingleton|profile.*in use|SingletonLock/i.test(m) ? ` — the profile ${userDataDir} is already in use by another browser (close it, e.g. the login window)` : '';
    throw new RunnerError(`could not launch Chromium${spec.name ? ` (persona ${spec.name})` : ''}${hint}: ${m.split('\n')[0]}`, { cause: e });
  }
  try {
    await refuseUnsandboxed(context.browser(), () => context.close(), `The capture browser${spec.name ? ` of persona ${spec.name}` : ''}`);
  } catch (e) {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  if (spec.userDataDir) recordProfileBrowser(spec.userDataDir, major);
  const realm: Realm = { name: spec.name, context, spare: [...context.pages()], temp, cleanup: spec.cleanup ?? [] };
  try {
    // Before anything loads: the browser itself refuses file: pages (no run continues without it).
    realm.fileGuard = await armFileGuard(context, spec.name);
    // Web notifications (R-NTF-03): the product may show them (permission granted), the kit reports each one here.
    await context.grantPermissions(['notifications']).catch(() => undefined);
    await exposeKitBindings(context, session);
    await context.addInitScript({ content: source });
    if (spec.storageState) await applyStorageState(context, spec.storageState);
    // Read-only run: armed before any page loads — the preflight's check page included.
    if (opts.writes) await armWriteGuard(context, opts.writes, (page) => session.pageRole(page));
  } catch (e) {
    await closeRealm(realm);
    throw e;
  }
  return realm;
}

/** Launch + kit injection (lower-level entry point; used by tests and live previews). */
export function openSession(opts: SessionOptions): Promise<BrowserSession> {
  return BrowserSession.open(opts);
}
