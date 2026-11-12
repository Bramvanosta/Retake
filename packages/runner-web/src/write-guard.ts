/**
 * The write guard of a run's browsers (L1.7, R-ENV-03): on a read-only run, every persona context is armed at launch —
 * before the preflight's check page loads — with a context route that classifies each request (core classifyRequest):
 * reads pass at once; a write to a guarded host (every host on a production environment; else the environment's pages
 * + `read_only.hosts`; on any run, the hosts of the project's other read-only environments) is answered by a mock
 * (scenario `mocks`, then `read_only.mocks`), let through by a `read_only.allow` entry, or stopped — a navigation (a form
 * POST, in any frame) is answered `204 No Content` so the page stays where it is (never an error page on camera),
 * anything else fails like a network error the app sees. On a read-only run a write to a host the guard does not watch
 * passes and is recorded (`passed`). A read-write run is armed only when the project has read-only environments whose
 * hosts it does not share (core crossEnvironmentHosts): only writes to those are stopped (no mock, no allow entry).
 * Each write is reported (`onWrite`) for `timeline.environment.writes`.
 *
 * Who is guarded: capture pages, tabs they open, the preflight's check tab; a request whose frame cannot be resolved (a
 * popup's first request, a form posted into a new window, a service worker's own fetch) is treated as a capture page's
 * (fail closed). Not guarded here: js hook tabs (their own guard, hook-page.ts: writes stopped, never mocked). The
 * automated sign-in tab is exempt only while its main frame is on its persona's sign-in page (its writes there are
 * recorded `exempt`); what it sends from the page it lands on is guarded like a capture page's (`via: sign-in`).
 *
 * Holes it closes besides the route: writes a page sends while it unloads (sendBeacon, `fetch(…, {keepalive})` in
 * pagehide / visibilitychange) — an init script turns them into ordinary requests to guarded hosts (they die with the
 * document unless the guard lets them through), and pages of a guarded context are closed through `about:blank`
 * (closePage, unloadPages) so their unload runs while the guard still sees it; `fetchLater` (sent by the browser after
 * the page is gone, never seen by the route) and `SharedWorker` (its requests never reach the route) — the init script
 * removes both (apps feature-detect them: neither exists in every browser); service workers — their own requests
 * reach the route (Playwright's experimental service-worker network events, set before the first read-only launch),
 * and the sign-in tab bypasses them. Not inspected: WebSocket / WebTransport messages (`onWebSocket` warns per host),
 * requests of other programs, a POST to an unguarded host that redirects to a guarded one (only its first hop is seen).
 *
 * Cost: any route makes Playwright pause every request of the context and disables its HTTP cache (playwright-core
 * crNetworkManager): every navigation of a guarded run fetches its assets again — invisible on a local app, longer
 * loads on a remote one.
 */
import type { BrowserContext, Dialog, Page, Route } from 'playwright-core';
import { classifyRequest, describeWriteRequest, guardedHostPatterns, isGuardedHost, isWriteMethod, networkHost } from '@retake/core/environment';
import type { TimelineWrite } from '@retake/core/model';
import type { WritePolicy } from '@retake/core/environment';
import { sleep, wallNow } from './util.js';

export type WriteVia = NonNullable<TimelineWrite['via']>;

/** A write request a guard saw (core TimelineWrite, plus what messages need). */
export interface GuardedWrite {
  method: string;
  /** The real URL. */
  url: string;
  /** `POST shop:/api/quotes` (never the query): core describeWriteRequest. */
  label: string;
  operation?: string;
  outcome: TimelineWrite['outcome'];
  /** The allow / mock entry that matched. */
  rule?: string;
  /** Status of the mock's answer. */
  status?: number;
  via: WriteVia;
  /** The other, read-only environment whose host it went to (guarded in every run). */
  protectedBy?: string;
  /** The page that sent it (absent: no resolvable frame — a popup's first request, a service worker). */
  page?: Page;
}

export interface WriteGuardOptions {
  policy: WritePolicy;
  /** Every write seen (blocked, mocked, allowed, passed), in the order the guard decided. Must not throw. */
  onWrite?: (w: GuardedWrite) => void;
  /** A page opened a WebSocket to a guarded host: its messages are not checked (once per socket). */
  onWebSocket?: (host: string, page: Page) => void;
}

/**
 * How the context guard treats a page's requests: its own guard (a js hook tab); exempt (`sign-in`: the automated
 * sign-in tab while its main frame is on its persona's sign-in page); guarded and recorded `via: sign-in` (`signed-in`:
 * that tab anywhere else — the page the sign-in lands on); guarded (`capture`).
 */
export type PageRole = 'hook' | 'sign-in' | 'signed-in' | 'capture';

interface Armed {
  o: WriteGuardOptions;
  /** Route handlers deciding right now (closePage waits for them). */
  pending: number;
}

const armedContexts = new WeakMap<BrowserContext, Armed>();

/**
 * Before the first launch of a read-only run: let Playwright report service workers' own requests, so the context route
 * sees (and stops) a write a service worker sends — to answer a page's request or in the background. Read when a
 * service-worker target attaches (playwright-core crServiceWorker), process-wide: read-write runs only get network
 * events of their service workers (no route, nothing intercepted).
 */
export function enableServiceWorkerRequests(): void {
  process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1';
}

/**
 * Arm a context (a persona's browser) with the read-only guard: the unload init script, the route, the WebSocket
 * warning. `role` is asked at request time (a tab registers itself after the context saw it open).
 */
export async function armWriteGuard(context: BrowserContext, o: WriteGuardOptions, role: (page: Page) => PageRole): Promise<void> {
  const armed: Armed = { o, pending: 0 };
  armedContexts.set(context, armed);
  await context.addInitScript({ content: unloadGuardScript(guardedHostPatterns(o.policy)) });
  await context.route('**/*', async (route) => {
    armed.pending++;
    try {
      await decide(route, o, role);
    } finally {
      armed.pending--;
    }
  });
  const watch = (page: Page) => {
    page.on('websocket', (ws) => {
      const host = networkHost(ws.url());
      if (!host || !isGuardedHost(host, o.policy)) return;
      try {
        o.onWebSocket?.(host, page);
      } catch {
        /* a listener error must not reach the page */
      }
    });
  };
  for (const p of context.pages()) watch(p);
  context.on('page', watch);
}

async function decide(route: Route, o: WriteGuardOptions, roleOf: (page: Page) => PageRole): Promise<void> {
  const fallback = () => route.fallback().catch(() => undefined);
  const req = route.request();
  const method = req.method().toUpperCase();
  if (!isWriteMethod(method)) return fallback();
  let page: Page | undefined;
  try {
    page = req.frame().page();
  } catch {
    page = undefined; // no resolvable frame: guarded like a capture page's request
  }
  let role: PageRole = 'capture';
  try {
    if (page) role = roleOf(page);
  } catch {
    role = 'capture';
  }
  if (role === 'hook') return fallback();
  let body: string | null = null;
  try {
    body = req.postData();
  } catch {
    body = null;
  }
  const url = req.url();
  const d = classifyRequest({ method, url, body }, o.policy);
  if (!d.write) return fallback();
  const via: WriteVia = role === 'capture' ? 'page' : 'sign-in';
  const report = (w: Omit<GuardedWrite, 'method' | 'url' | 'label' | 'operation' | 'page' | 'via' | 'protectedBy'>) => {
    try {
      o.onWrite?.({
        method,
        url,
        label: describeWriteRequest(method, url, o.policy.pages),
        ...(d.operation ? { operation: d.operation } : {}),
        ...w,
        via,
        ...(d.protectedBy ? { protectedBy: d.protectedBy } : {}),
        ...(page ? { page } : {}),
      });
    } catch {
      /* a listener error must not stop the decision */
    }
  };
  if (role === 'sign-in') {
    // The automated sign-in, on its sign-in page, is exempt (its POST /sign-in must happen): recorded, never stopped.
    report({ outcome: 'exempt' });
    return fallback();
  }
  if (d.outcome === 'passed' || d.outcome === 'allowed') {
    report({ outcome: d.outcome, ...(d.rule ? { rule: d.rule } : {}) });
    return fallback();
  }
  if (d.outcome === 'mocked' && d.mock) {
    const m = d.mock;
    report({ outcome: 'mocked', rule: m.source, status: m.status });
    if (m.delayMs > 0) await sleep(m.delayMs);
    await route
      .fulfill({ status: m.status, headers: { ...m.headers }, contentType: m.contentType, ...(m.status === 204 || m.status === 205 || m.status === 304 ? {} : { body: m.body }) })
      .catch(() => undefined);
    return;
  }
  report({ outcome: 'blocked' });
  // A stopped navigation (a form POST, in any frame) is answered 204: the browser stays on the page — no error page.
  let navigation = false;
  try {
    navigation = req.isNavigationRequest();
  } catch {
    navigation = false;
  }
  if (navigation) await route.fulfill({ status: 204, body: '' }).catch(() => undefined);
  else await route.abort('blockedbyclient').catch(() => undefined);
}

/**
 * What a guarded page (any frame, a popup, a js hook tab) must not have: `fetchLater` (the browser sends a deferred
 * fetch when the page is gone, or on its timer — never through the route nor a page's CDP Fetch) and `SharedWorker`
 * (its requests reach no route: Playwright does not attach to shared workers). Both are removed — apps feature-detect
 * them (neither exists in every browser: no SharedWorker on Android Chrome) and fall back to what the guard sees.
 */
export const UNGUARDED_APIS_SCRIPT = `(() => { for (const name of ['fetchLater', 'SharedWorker']) { try { delete globalThis[name]; } catch {} } })();`;

/**
 * The init script of a guarded context: the unguarded APIs removed (UNGUARDED_APIS_SCRIPT); a write to a guarded host
 * sent with `keepalive` (a `fetch` in pagehide, a `sendBeacon`) becomes an ordinary request — the guard sees it while
 * the document lives, and it dies with the document otherwise (a keepalive request outlives its page: one left paused
 * when the page unloads is sent when the browser closes). Beacons to other hosts are untouched. Never throws into the
 * page.
 */
export function unloadGuardScript(hosts: readonly string[]): string {
  return `${UNGUARDED_APIS_SCRIPT}
(() => {
  const H = ${JSON.stringify(hosts)};
  const guarded = (u) => {
    let h = '';
    try { h = new URL(String(u), location.href).hostname.toLowerCase().replace(/^\\[|\\]$/g, ''); } catch { return false; }
    return !!h && H.some((p) => p === '*' || (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
  };
  const writes = (m) => !/^(GET|HEAD|OPTIONS)$/i.test(String(m || 'GET'));
  try {
    const F = globalThis.fetch;
    if (typeof F === 'function' && !F.__retakeGuard) {
      const fetch = function (input, init) {
        try {
          const req = typeof Request === 'function' && input instanceof Request ? input : null;
          const url = req ? req.url : input;
          const method = (init && init.method) || (req ? req.method : 'GET');
          if (((init && init.keepalive) || (req && req.keepalive)) && writes(method) && guarded(url)) init = Object.assign({}, init, { keepalive: false });
        } catch {}
        return F.call(this === undefined || this === null ? globalThis : this, input, init);
      };
      Object.defineProperty(fetch, '__retakeGuard', { value: true });
      globalThis.fetch = fetch;
      const N = typeof Navigator === 'function' ? Navigator.prototype : null;
      const B = N && N.sendBeacon;
      if (typeof B === 'function') {
        N.sendBeacon = function sendBeacon(url, data) {
          try {
            if (guarded(url)) {
              F.call(globalThis, String(url), { method: 'POST', body: data === undefined ? null : data, credentials: 'include', mode: 'no-cors' }).catch(() => {});
              return true;
            }
          } catch {}
          return B.call(this, url, data);
        };
      }
    }
  } catch {}
})();`;
}

/**
 * The automated sign-in tab of a guarded context bypasses service workers (as js hook tabs do): its requests then come
 * from its page, where the exemption applies — a service worker's own fetch has no page and would be stopped, failing
 * the sign-in. The CDP session lives as long as the tab.
 */
export async function bypassServiceWorkers(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  // Network must be enabled for the bypass to apply.
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
}

/** Wait (≤ maxMs) until the route handlers of a guarded context have decided: unload writes are stopped, not cut off. */
async function drained(armed: Armed, minMs: number, maxMs: number): Promise<void> {
  const start = wallNow();
  await sleep(minMs);
  while (armed.pending > 0 && wallNow() - start < maxMs) await sleep(20);
}

/** Navigate a page to about:blank, leaving it even when it asks to stay (a beforeunload prompt is accepted). */
async function toBlank(page: Page): Promise<void> {
  const onDialog = (d: Dialog) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => undefined);
  page.on('dialog', onDialog);
  try {
    await page.goto('about:blank', { timeout: 3000 }).catch(() => undefined);
  } finally {
    page.off('dialog', onDialog);
  }
}

/**
 * Close a page. In a guarded context it first goes to about:blank, so what it sends while unloading (beacons, keepalive
 * fetches in pagehide) meets the guard: a page closed directly sends them unseen (measured: 3 of 3 leaked).
 */
export async function closePage(page: Page): Promise<void> {
  if (page.isClosed()) return;
  const armed = armedContexts.get(page.context());
  if (armed) {
    await toBlank(page);
    await drained(armed, 60, 300);
  }
  await page.close().catch(() => undefined);
}

/** Before a guarded context closes: every page to about:blank first (see closePage). A no-op on other contexts. */
export async function unloadPages(context: BrowserContext): Promise<void> {
  const armed = armedContexts.get(context);
  if (!armed) return;
  await Promise.all(
    context
      .pages()
      .filter((p) => !p.isClosed())
      .map((p) => toBlank(p)),
  );
  await drained(armed, 60, 300);
}
