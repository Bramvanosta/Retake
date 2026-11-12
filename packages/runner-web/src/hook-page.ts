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
 *
 * On a read-only run (L1.7, `writes`) the tab also stops every write to the environment's guarded hosts that no
 * `read_only.allow` entry lets through — never answered by a mock: a hook that writes is refused, not fooled — and on
 * any run with a write policy, every write to a host of the project's other read-only environments. A hook that failed
 * after such a write throws core `WriteRefusedError` (@retake/hooks: refused, reason `read-only`); one that caught
 * it and went on succeeds with a warning. Writes are named `POST shop:/api/x` (no query); the context's own write guard
 * (write-guard.ts) leaves the tab's requests to this one. `fetchLater` and `SharedWorker` do not exist in the tab
 * (write-guard.ts UNGUARDED_APIS_SCRIPT): a shared worker's requests would escape both guards.
 */
import type { CDPSession, Page } from 'playwright-core';
import { HostRefusedError, WriteRefusedError, classifyRequest, describeWriteRequest, isHostAllowed, networkHost } from '@retake/core/environment';
import type { LoadedProject } from '@retake/core/model';
import type { WritePolicy } from '@retake/core/environment';
import { evalInPage } from './actions/misc.js';
import { LoginPageError, RunnerError, errorMessage } from './errors.js';
import type { BrowserSession } from './session.js';
import { UNGUARDED_APIS_SCRIPT } from './write-guard.js';
import type { GuardedWrite } from './write-guard.js';

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
  /** A read-only run (L1.7): the tab stops writes (never mocked); each write it sees is reported (`via: hook`). */
  writes?: { policy: WritePolicy; onWrite?: (w: GuardedWrite) => void };
}

/** What the tab is doing: blocked hosts are reported according to it. */
type Phase = 'load' | 'run' | 'idle';

/** Disables `window.open` in the hook tab (a popup is a tab of its own, outside the guard). */
const NO_POPUPS = `(() => { try { Object.defineProperty(window, 'open', { value: () => null, writable: false, configurable: false }); } catch {} })();`;

function isWebPage(url: string): boolean {
  return /^https?:/i.test(url);
}

/** The body of a request paused by CDP Fetch (absent when it is too large to inline: then its entries). */
function cdpBody(r: { postData?: string; postDataEntries?: Array<{ bytes?: string }> }): string | null {
  if (typeof r.postData === 'string') return r.postData;
  if (r.postDataEntries?.length) return r.postDataEntries.map((e) => (e.bytes ? Buffer.from(e.bytes, 'base64').toString('utf8') : '')).join('');
  return null;
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
  /** Writes stopped since the current load or run began (read-only runs). */
  private stopped = new Set<string>();
  /** Writes reported since the current load or run began: the tab's Fetch and its route may both see one. */
  private reported = new Set<string>();
  /** The other, read-only environment whose host the last stopped write went to (a read-write run's only reason). */
  private stoppedFor: string | undefined;
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
    // Its requests are this tab's guard's, not the context's (read-only runs).
    session.markOwnGuard(page);
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

  /**
   * On a read-only run: whether a request is a write the tab stops (a guarded host, no allow entry; a mock never
   * answers it). Every write seen is reported once per load or run.
   */
  private stopsWrite(method: string, url: string, body: string | null): boolean {
    const w = this.o.writes;
    if (!w) return false;
    const d = classifyRequest({ method, url, body }, w.policy);
    if (!d.write) return false;
    const stop = d.outcome === 'blocked' || d.outcome === 'mocked';
    const label = describeWriteRequest(method, url, w.policy.pages);
    const key = `${stop ? 'stop' : d.outcome} ${method.toUpperCase()} ${url}`;
    if (!this.reported.has(key)) {
      this.reported.add(key);
      try {
        w.onWrite?.({
          method: method.toUpperCase(),
          // Without its query: a hook's secrets are not the run's (the timeline would not mask them).
          url: url.split(/[?#]/)[0],
          label,
          ...(d.operation ? { operation: d.operation } : {}),
          outcome: stop ? 'blocked' : d.outcome,
          ...(!stop && d.rule ? { rule: d.rule } : {}),
          via: 'hook',
          ...(d.protectedBy ? { protectedBy: d.protectedBy } : {}),
          page: this.page,
        });
      } catch {
        /* a listener error must not reach the guard */
      }
    }
    if (!stop) return false;
    this.stopped.add(label);
    if (d.protectedBy) this.stoppedFor = d.protectedBy;
    if (this.phase === 'idle' && !this.logged.has(`write ${label}`)) {
      this.logged.add(`write ${label}`);
      this.o.log('info', `js hook tab "${this.key}": stopped a write (${label}): ${this.why()}`);
    }
    return true;
  }

  /** Why the tab stops writes: its read-only environment, or (a read-write run) another environment's host. */
  private why(): string {
    const w = this.o.writes;
    return w?.policy.readOnly === false ? `a host of read-only environment ${this.stoppedFor ?? '?'}` : `environment ${w?.policy.env} is read-only`;
  }

  private async guard(): Promise<void> {
    const { cdp, page } = this;
    // Every request of the tab pauses here, each redirect hop too (page.route never sees those): failed or continued,
    // never left paused, and never throwing.
    cdp.on('Fetch.requestPaused', (ev) => {
      let host: string | null = 'unknown';
      let write = false;
      try {
        host = this.refused(ev.request.url);
        if (host) this.block(host, ev.resourceType === 'Document' && ev.frameId === this.mainFrame);
        else write = this.stopsWrite(ev.request.method, ev.request.url, cdpBody(ev.request));
      } catch {
        /* fail closed */
      }
      const done =
        host || write
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
      let write = false;
      try {
        const req = route.request();
        host = this.refused(req.url());
        if (host) this.block(host, req.isNavigationRequest() && req.frame() === page.mainFrame());
        else write = this.stopsWrite(req.method(), req.url(), req.postData());
      } catch {
        /* fail closed */
      }
      return (host || write ? route.abort('blockedbyclient') : route.fallback()).catch(() => undefined);
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
    await page.addInitScript({ content: `${NO_POPUPS}\n${UNGUARDED_APIS_SCRIPT}` });
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
    this.stopped = new Set();
    this.reported = new Set();
    this.stoppedFor = undefined;
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
    if (this.stopped.size) {
      this.o.log('info', `js hook page "${this.key}": stopped ${[...this.stopped].join(', ')} while loading (${this.why()})`);
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
      if (this.stopped.size) {
        this.o.log('warn', `js hook on page "${this.key}": stopped ${[...this.stopped].join(', ')} (${this.why()}); the hook went on without it`);
      }
      return value;
    } catch (e) {
      // A request was blocked and the hook failed: refused (it names the host), with the hook's own error.
      if (this.blocked.size) {
        throw new HostRefusedError([...this.blocked], this.o.project, 'blocked while the js hook ran', { cause: e, detail: `the hook threw: ${cleanError(e)}` });
      }
      // A write was stopped (read-only run) and the hook failed: refused, never mocked.
      if (this.stopped.size) {
        const protectedBy = this.o.writes?.policy.readOnly === false ? this.stoppedFor : undefined;
        throw new WriteRefusedError([...this.stopped], this.o.writes?.policy.env ?? this.o.env.name, {
          cause: e,
          detail: `the hook threw: ${cleanError(e)}`,
          ...(protectedBy ? { protectedBy } : {}),
        });
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
 * that catches the blocked request and goes on succeeds, with a warning naming the host. On a read-only run (`writes`),
 * core `WriteRefusedError` when the code failed after one of its writes was stopped.
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
