/**
 * Client-side route changes held until the route is ready (R-ISS-14). A single-page app changes its route without a
 * new document (pushState, a `#/` hash route): the shell is painted at once, the route's content comes later — a
 * skeleton the full-page hold (hold.ts, R-ISS-08) never sees. A route hold is armed only by a step's own click, press
 * or Enter (`arm`, from the runner), for a path change of the main frame's document within ROUTE_ARM_MS of that press
 * and while that step runs (`cancel` when it returns): a query-only change, a `replaceState` normalisation, a path
 * rewritten while scrolling or typing (nobody pressed), a route an app changes later never holds. The indicators in
 * view before the press (`routeSnapshot`) never count. Frames are held from the route change (no frame of the new
 * route's loading state is written); the hold's record — what the edit cuts — starts ROUTE_PRESS_KEEP_MS after the
 * press at the earliest, so the press is seen. When it ends: watchRoute. At ROUTE_HOLD_MAX_MS it is shown as it is
 * (`limit`, a run warning naming the indicator still showing). */
import type { Page } from 'playwright-core';
import { ROUTE_ARM_MS, ROUTE_EARLY_MS, ROUTE_PRESS_KEEP_MS, ROUTE_QUIET_CAP_MS, ROUTE_QUIET_MS } from './hold.js';
import type { LoadHold } from './hold.js';
import { routeLoading } from './loading-watch.js';
import { networkQuiet } from './network.js';

/** How often the route watcher looks at the page. */
export const ROUTE_POLL_MS = 100;

/**
 * The route a URL shows: its origin and path, and a hash route's path (`#/quotes`, `#!/quotes`, without its query) —
 * never the query, nor an in-page `#anchor`. Null for what is not a URL.
 */
export function routeKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const hash = /^#!?\//.test(u.hash) ? u.hash.replace(/^#!?/, '').replace(/[?].*$/, '') : '';
  return `${u.origin}${u.pathname}${hash ? `#${hash}` : ''}`;
}

/** The route's path as a warning names it: `/quotes`, `/#/quotes`. */
export function routePath(url: string): string {
  const k = routeKey(url);
  if (!k) return url;
  try {
    return k.slice(new URL(url).origin.length) || '/';
  } catch {
    return k;
  }
}

export interface RouteHoldEnv {
  now(): number;
  /** The route's watcher (watchRoute): ends the hold `id` when the route is ready; returns once the hold is over. */
  watch(id: string, page: Page): Promise<void>;
}

/** The route holds of one recorder (its LoadHold): arming by a press, the path compare. */
export class RouteHolds {
  private key: string | null = null;
  private change: { wall: number; url: string } | null = null;
  private armed: { press: number; label?: string } | null = null;
  private seq = 0;
  /** Route holds begun (tests, the notes). */
  begun = 0;

  constructor(
    private readonly hold: LoadHold<{ wall: number }>,
    private readonly env: RouteHoldEnv,
  ) {}

  /** A document of the main frame (attach, a commit): its route is the one compared with from now on; nothing pending. */
  reset(url: string): void {
    this.key = routeKey(url);
    this.change = null;
    this.cancel();
  }

  /** A same-document navigation of the main frame (Page.navigatedWithinDocument) of `page`. */
  within(url: string, page: Page, pageId?: string): void {
    const key = routeKey(url);
    const prev = this.key;
    this.key = key;
    if (key === null || prev === null || key === prev) return;
    this.change = { wall: this.env.now(), url };
    this.maybeBegin(page, pageId);
  }

  /** A step pressed (its click, its key, its Enter) at wall time `press`; `label` names the step in warnings. */
  arm(press: number, page: Page, label?: string, pageId?: string): void {
    this.armed = { press, ...(label !== undefined ? { label } : {}) };
    this.maybeBegin(page, pageId);
  }

  /** The step that pressed returned (or the recorder leaves the page, or stops): no press is armed any more. */
  cancel(): void {
    this.armed = null;
    this.change = null;
  }

  private maybeBegin(page: Page, pageId?: string): void {
    const a = this.armed;
    const c = this.change;
    if (!a || !c || c.wall < a.press - ROUTE_EARLY_MS || c.wall > a.press + ROUTE_ARM_MS) return;
    // One route change per press.
    this.armed = null;
    this.change = null;
    if (this.hold.holding) return;
    const id = `route-${++this.seq}`;
    this.begun++;
    this.hold.begin(id, 'route', pageId);
    this.hold.routeOf(routePath(c.url), a.label, a.press + ROUTE_PRESS_KEEP_MS);
    void this.env.watch(id, page);
  }
}

/**
 * The route watcher of a recorder (RouteHoldEnv.watch), every ROUTE_POLL_MS after two animation frames:
 * - no loading indicator the route brought has been seen yet: the route is ready at the first poll without one — no
 *   network wait, so an entrance animation after a fast fetch is filmed and a page that polls is never held;
 * - one has been seen: ready once it is gone and the network has been quiet ROUTE_QUIET_MS (the data its rows wait for),
 *   that wait lasting ROUTE_QUIET_CAP_MS at most after the indicator went (a page that polls).
 * Each poll's indicator is noted (`hold.note`: the record's `seen` span, the limit warning's cause). Stops when the hold
 * `id` is over (ready, the limit, a commit made it a navigation hold, the recorder left).
 */
export async function watchRoute(hold: LoadHold<{ wall: number }>, id: string, page: Page, o: { now(): number; sleep(ms: number): Promise<void> }): Promise<void> {
  const current = () => hold.loaderId === id;
  let seen = false;
  let goneAt: number | null = null;
  await twoFrames(page);
  while (current()) {
    const what = await routeLoading(page).catch(() => null);
    if (!current()) return;
    const now = o.now();
    hold.note(what, now);
    if (what) {
      seen = true;
      goneAt = null;
    } else {
      goneAt ??= now;
      if (!seen || networkQuiet(page, ROUTE_QUIET_MS) || now - goneAt >= ROUTE_QUIET_CAP_MS) {
        await twoFrames(page);
        if (current()) hold.ready(o.now());
        return;
      }
    }
    await o.sleep(ROUTE_POLL_MS);
  }
}

/** Two animation frames of the page (what the DOM holds now is painted), at most 300 ms. */
async function twoFrames(page: Page): Promise<void> {
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 300);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              clearTimeout(t);
              resolve();
            }),
          );
        }),
    )
    .catch(() => undefined);
}
