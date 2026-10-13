/**
 * The tab js hooks run in (R-SEC-06): one per environment page key, opened in the run's browser context on that page,
 * so it shares cookies, localStorage and IndexedDB with the capture tabs (not sessionStorage nor page state). It stays
 * open for the session's life — a hook may leave the app running there (the fixture's `quote` scenario keeps its
 * console polling in the background for a web notification) — and later js hooks on the same key reuse it.
 *
 * The tab is guarded for its whole life: every request to a host outside the project's allow-list is failed before it
 * leaves the browser — navigations and each redirect hop, fetch / XHR, beacons, EventSource, sub-resources, dedicated
 * workers and same-site frames (CDP Fetch on the tab's own session), requests of cross-site frames (Playwright's
 * route: first hops only), page WebSockets (routeWebSocket) — and the tab bypasses service workers, so requests one
 * would answer still meet the guard. `window.open` is disabled there; a popup that still opens is closed at once.
 * The guard logs hosts, never URLs or code (the runner log is not hook-redacted).
 */
import type { CDPSession, Page } from 'playwright-core';
import { HostRefusedError, isHostAllowed, networkHost } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';
import { evalInPage } from './actions/misc.js';
import { LoginPageError, RunnerError, errorMessage } from './errors.js';
import type { BrowserSession } from './session.js';

export interface HookPageOptions {
  /** Its allow-list applies (environment hosts, `allow_hosts`, localhost). */
  project: Pick<LoadedProject, 'config' | 'slug'>;
  /** The environment whose page the tab opens. */
  env: { name: string; pages: Record<string, string> };
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Sessions & personas (L1.6): the tab opens in the browser of its page's persona (BrowserSession.hookContext); a load
   * that lands on that persona's sign-in page is refused with this message (null: not a sign-in page).
   */
  loginLanding?: (key: string, url: string) => string | null;
}

/** What the tab is doing: blocked hosts are reported according to it. */
type Phase = 'load' | 'run' | 'idle';

/** Disables `window.open` in the hook tab (a popup is a tab of its own, outside the guard). */
const NO_POPUPS = `(() => { try { Object.defineProperty(window, 'open', { value: () => null, writable: false, configurable: false }); } catch {} })();`;

function isWebPage(url: string): boolean {
  return /^https?:/i.test(url);
}

/** A Playwright evaluation error, first line, without its "page.evaluate:" prefix. */
function cleanError(e: unknown): string {
  return errorMessage(e).replace(/^page\.evaluate: /, '').replace(/^Error: /, '').split('\n')[0];
}

class HookTab {
  private phase: Phase = 'idle';
  /** Hosts blocked since the current load or run began. */
  private blocked = new Set<string>();
  /** Host of the last main-frame navigation the guard blocked. */
  private navBlocked: string | undefined;
  /** Hosts already logged while the tab was idle. */
  private readonly logged = new Set<string>();
  private mainFrame = '';

  private constructor(
    readonly key: string,
    readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly o: HookPageOptions,
  ) {}

  static async open(session: BrowserSession, key: string, o: HookPageOptions): Promise<HookTab> {
    const context = await session.hookContext(key);
    const page = await context.newPage();
    try {
      const cdp = await context.newCDPSession(page);
      const tab = new HookTab(key, page, cdp, o);
      await tab.guard();
      return tab;
    } catch (e) {
      await page.close().catch(() => undefined);
      throw e;
    }
  }

  /** The host a request to `url` would contact when the allow-list refuses it, else null. */
  private refused(url: string): string | null {
    const host = networkHost(url);
    return host && !isHostAllowed(host, this.o.project) ? host : null;
  }

  private async guard(): Promise<void> {
    const { cdp, page } = this;
    // Every request of the tab pauses here, each redirect hop too (page.route never sees those): failed or continued,
    // never left paused, and never throwing.
    cdp.on('Fetch.requestPaused', (ev) => {
      let host: string | null = 'unknown';
      try {
        host = this.refused(ev.request.url);
        if (host) this.block(host, ev.resourceType === 'Document' && ev.frameId === this.mainFrame);
      } catch {
        /* fail closed */
      }
      const done = host
        ? cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' })
        : cdp.send('Fetch.continueRequest', { requestId: ev.requestId });
      done.catch(() => undefined);
    });
    // Network must be enabled for the service-worker bypass to apply.
    await cdp.send('Network.enable');
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    this.mainFrame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
    // Requests of out-of-process (cross-site) frames never reach the tab's own Fetch: Playwright's route sees them
    // (their first hop; it lets redirects through), and backs the Fetch guard up everywhere else.
    await page.route('**/*', (route) => {
      let host: string | null = 'unknown';
      try {
        const req = route.request();
        host = this.refused(req.url());
        if (host) this.block(host, req.isNavigationRequest() && req.frame() === page.mainFrame());
      } catch {
        /* fail closed */
      }
      return (host ? route.abort('blockedbyclient') : route.fallback()).catch(() => undefined);
    });
    // WebSocket handshakes never reach Fetch: the page's WebSocket goes through Playwright's route instead.
    await page.routeWebSocket(
      () => true,
      (ws) => {
        const host = this.refused(ws.url());
        if (!host) {
          ws.connectToServer();
          return;
        }
        this.block(host, false);
        ws.close({ code: 1008, reason: 'host not in the allow-list' }).catch(() => undefined);
      },
    );
    await page.addInitScript({ content: NO_POPUPS });
    page.on('popup', (p) => {
      const host = this.refused(p.url());
      this.o.log('warn', `js hook tab "${this.key}": closed a popup it opened${host ? ` (to ${host}, not in the allow-list)` : ''}`);
      p.close().catch(() => undefined);
    });
  }

  private block(host: string, mainFrameNavigation: boolean): void {
    if (mainFrameNavigation) this.navBlocked = host;
    this.blocked.add(host);
    if (this.phase === 'idle' && !this.logged.has(host)) {
      this.logged.add(host);
      this.o.log('info', `js hook tab "${this.key}": blocked a request to ${host} (not in the allow-list)`);
    }
  }

  private start(phase: Phase): void {
    this.phase = phase;
    this.blocked = new Set();
  }

  /** Open the environment page (the tab is blank, or on an error page after a blocked navigation). */
  async load(url: string): Promise<void> {
    this.start('load');
    this.navBlocked = undefined;
    try {
      await this.page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    } catch (e) {
      if (this.navBlocked) throw new HostRefusedError([this.navBlocked], this.o.project, `js hook page "${this.key}" redirected to it`, { cause: e });
      throw e;
    } finally {
      this.phase = 'idle';
    }
    const host = this.refused(this.page.url());
    if (host) throw new HostRefusedError([host], this.o.project, `js hook page "${this.key}" redirected to it`);
    const signIn = this.o.loginLanding?.(this.key, this.page.url());
    if (signIn) throw new LoginPageError(signIn);
    if (this.blocked.size) {
      this.o.log('info', `js hook page "${this.key}": blocked ${[...this.blocked].join(', ')} while loading (not in the allow-list; add to allow_hosts what the page needs)`);
    }
  }

  /**
   * Evaluate a hook's code: a request it makes to a host outside the allow-list fails like a network error. A tab a
   * previous hook left on its persona's sign-in page is refused (L1.6).
   */
  async run(code: string): Promise<unknown> {
    if (!isWebPage(this.page.url()) && this.navBlocked) {
      throw new HostRefusedError([this.navBlocked], this.o.project, `js hook page "${this.key}" redirected to it`);
    }
    const signIn = this.o.loginLanding?.(this.key, this.page.url());
    if (signIn) throw new LoginPageError(signIn);
    this.start('run');
    try {
      const value = await evalInPage(this.page, code);
      if (this.blocked.size) {
        this.o.log('warn', `js hook on page "${this.key}": blocked ${[...this.blocked].join(', ')} (not in the allow-list); the hook went on without it`);
      }
      return value;
    } catch (e) {
      // A request was blocked and the hook failed: refused (it names the host), with the hook's own error.
      if (this.blocked.size) {
        throw new HostRefusedError([...this.blocked], this.o.project, 'blocked while the js hook ran', { cause: e, detail: `the hook threw: ${cleanError(e)}` });
      }
      throw e;
    } finally {
      this.phase = 'idle';
    }
  }
}

/** Hook tabs being opened or open, per session and page key. */
const tabs = new WeakMap<BrowserSession, Map<string, Promise<HookTab>>>();

async function hookTab(session: BrowserSession, key: string, o: HookPageOptions): Promise<HookTab> {
  let byKey = tabs.get(session);
  if (!byKey) tabs.set(session, (byKey = new Map()));
  const existing = byKey.get(key);
  if (existing) {
    const tab = await existing.catch(() => null);
    if (tab && !tab.page.isClosed()) return tab;
  }
  const opening = HookTab.open(session, key, o);
  byKey.set(key, opening);
  const tab = await opening.catch((e: unknown) => {
    byKey.delete(key);
    throw e;
  });
  session.hookPages.set(key, tab.page);
  tab.page.on('close', () => {
    if (session.hookPages.get(key) === tab.page) session.hookPages.delete(key);
    if (byKey.get(key) === opening) byKey.delete(key);
  });
  return tab;
}

/**
 * Run a js hook's code (a function body) in the hook tab of `pageKey` (default: the environment's first page), opening
 * the tab on that environment page when it is not on a web page yet. Throws core `HostRefusedError` when the page
 * redirected to a host outside the allow-list, or when the code failed after one of its requests was blocked; a hook
 * that catches the blocked request and goes on succeeds, with a warning naming the host.
 */
export async function evalHookInPage(session: BrowserSession, o: HookPageOptions, pageKey: string | undefined, code: string): Promise<unknown> {
  const key = pageKey ?? Object.keys(o.env.pages)[0];
  if (!key) throw new RunnerError(`js hook: environment "${o.env.name}" declares no pages`);
  const url = o.env.pages[key];
  if (!url) throw new RunnerError(`js hook: environment "${o.env.name}" has no page "${key}"`);
  const tab = await hookTab(session, key, o);
  if (!isWebPage(tab.page.url())) await tab.load(url);
  return tab.run(code);
}
