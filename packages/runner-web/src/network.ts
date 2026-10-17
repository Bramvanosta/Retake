import type { Frame, Page, Request } from 'playwright-core';
import { urlOriginPath } from '@demo-studio/core';
import { sleep, wallNow } from './util.js';

/** Quiet time that counts as "network idle": no request in flight for this long (Playwright's networkidle definition). */
export const NETWORK_IDLE_MS = 500;
/**
 * A response whose body the page never reads (a fire-and-forget `fetch()` of a `no-store` answer, even `{}`) is never
 * reported as finished: Chromium keeps it open, Playwright emits neither `requestfinished` nor `requestfailed`. Its
 * request stops counting this long after its response headers — so does a body still downloading by then (a large
 * file: a `download` step waits for it, not network idle).
 */
export const UNREAD_BODY_MS = 1000;
const POLL_MS = 50;

interface InFlight {
  requests: Set<Request>;
  /** Wall time of the last request start or end. */
  changed: number;
  /** Per frame, its navigation request in progress: the next `framenavigated` of that frame is its new document. */
  navigating: Map<Frame, Request>;
  /** Wall time each request in flight got its response headers (UNREAD_BODY_MS). */
  responded: WeakMap<Request, number>;
}

const tracked = new WeakMap<Page, InFlight>();

/** Requests that never count: the favicon, and event streams (open by design). WebSockets are not requests. */
function ignored(req: Request): boolean {
  if (req.resourceType() === 'eventsource') return true;
  try {
    return new URL(req.url()).pathname === '/favicon.ico';
  } catch {
    return false;
  }
}

/** The frame a request is reported on (a dedicated worker's: its page's frame); none for a service worker's. */
function frameOf(req: Request): Frame | undefined {
  try {
    return req.frame();
  } catch {
    return undefined;
  }
}

/**
 * Count a page's requests in flight, from now on (idempotent). The session tracks every page of its browsers as it
 * opens (BrowserSession), so a request a click started is already counted when a `wait_for: {network_idle}` begins.
 *
 * A request whose document goes away does not always end: after a cross-site navigation (the renderer process is
 * swapped) or with its dedicated worker, Playwright reports neither `requestfinished` nor `requestfailed`. So, as
 * Playwright's own networkidle does when a frame commits a new document, every request of that frame but the new
 * document's is forgotten then (a dedicated worker's requests are reported on its page's frame: they go with it), and
 * a detached frame's requests with it. `framenavigated` also fires for a same-document change (pushState, #hash),
 * which keeps its requests: only a frame with a navigation request in progress has committed a new document.
 */
export function trackRequests(page: Page): void {
  if (tracked.has(page)) return;
  const st: InFlight = { requests: new Set(), changed: wallNow(), navigating: new Map(), responded: new WeakMap() };
  tracked.set(page, st);
  const done = (req: Request) => {
    if (st.requests.delete(req)) st.changed = wallNow();
  };
  const forget = (frame: Frame, keep?: Request) => {
    for (const req of st.requests) if (req !== keep && frameOf(req) === frame) done(req);
  };
  page.on('request', (req) => {
    const frame = req.isNavigationRequest() ? frameOf(req) : undefined;
    if (frame) st.navigating.set(frame, req); // a redirect's next hop replaces the previous one
    if (ignored(req)) return;
    st.requests.add(req);
    st.changed = wallNow();
  });
  page.on('requestfinished', done);
  page.on('requestfailed', (req) => {
    done(req);
    const frame = frameOf(req);
    if (frame && st.navigating.get(frame) === req) st.navigating.delete(frame); // cancelled, or a download: no new document
  });
  page.on('response', (res) => {
    const req = res.request();
    if (st.requests.has(req)) st.responded.set(req, wallNow());
    const frame = res.status() === 204 || res.status() === 205 ? frameOf(req) : undefined;
    if (frame && st.navigating.get(frame) === req) st.navigating.delete(frame); // "no content": the document stays
  });
  page.on('framenavigated', (frame) => {
    const nav = st.navigating.get(frame);
    if (!nav) return;
    st.navigating.delete(frame);
    forget(frame, nav);
  });
  page.on('framedetached', (frame) => {
    st.navigating.delete(frame);
    forget(frame);
  });
}

export type NetworkIdleResult = { idle: true } | { idle: false; pending: string[] };

/**
 * Wait until `page` has had no request in flight for `idleMs` (default NETWORK_IDLE_MS), counted from the call at the
 * earliest — re-armed on every call, unlike Playwright's `networkidle` load state, which fires once per document and
 * then resolves at once for the rest of its life (requests started later are never waited for). A page that never goes
 * quiet (long polling, a request that hangs) runs into `timeoutMs`: the result then lists the requests still in flight
 * (origin + path, at most three).
 */
export async function networkIdle(page: Page, opts: { timeoutMs: number; idleMs?: number; signal?: AbortSignal }): Promise<NetworkIdleResult> {
  trackRequests(page);
  const st = tracked.get(page)!;
  const idleMs = opts.idleMs ?? NETWORK_IDLE_MS;
  const start = wallNow();
  const deadline = start + opts.timeoutMs;
  for (;;) {
    const now = wallNow();
    // A request answered UNREAD_BODY_MS ago and still open has a body nobody reads: quiet from then on.
    let quietSince = Math.max(start, st.changed);
    const busy: Request[] = [];
    for (const req of st.requests) {
      const at = st.responded.get(req);
      if (at !== undefined && now - at >= UNREAD_BODY_MS) quietSince = Math.max(quietSince, at + UNREAD_BODY_MS);
      else busy.push(req);
    }
    if (busy.length === 0 && now - quietSince >= idleMs) return { idle: true };
    if (now >= deadline) {
      const urls = busy.map((r) => urlOriginPath(r.url()));
      const pending = [...new Set(urls)];
      return { idle: false, pending: pending.length > 3 ? [...pending.slice(0, 3), `${pending.length - 3} more`] : pending };
    }
    await sleep(Math.min(POLL_MS, deadline - now), opts.signal);
  }
}

/** Why the network was not idle: "still loading: a, b", or requests that kept starting and ending. */
export function describePending(pending: string[], idleMs = NETWORK_IDLE_MS): string {
  return pending.length ? `still loading: ${pending.join(', ')}` : `never ${idleMs} ms without a request`;
}
