/**
 * Hotfix v0.2.6 (client demo retro): what the capture showed of a page still loading beyond an empty screen — a skeleton,
 * a shimmer, a spinner, an `aria-busy` region in the viewport. While a take records, the page on screen is probed every
 * PROBE_MS; the spans where one shows are written to the timeline (`timeline.loading_ui`), and the review says which
 * ones the video shows (`loading-filmed`). Pure but for the timer and the page probe.
 */
import type { Page } from 'playwright-core';
import type { TimelineLoadingUi } from '@retake/core/run';
import { round3 } from './util.js';

export const PROBE_MS = 250;

/* c8 ignore start */
/**
 * Runs in the page (serialised by Playwright: self-contained): the loading indicators that show in the viewport.
 * `take`: the take's own probe (`timeline.loading_ui`). `route` (the route watcher only, R-ISS-14): also the skeletons
 * of utility CSS — `animate-pulse`, `data-slot="skeleton"`, `data-loading="true"` — counted only for an element with no
 * text of its own and nothing to click or look at inside (a pulsing "Live" badge or a highlighted card is no loading
 * state), and never an element that was already there at the press (`snapshot`: a header's spinner, a polling
 * badge — what the route did not bring). `snapshot` records those elements and answers null.
 */
function loadingInPage(mode: 'take' | 'route' | 'snapshot'): string | null {
  const W = innerWidth;
  const H = innerHeight;
  const minArea = W * H * 0.004;
  const kinds: Array<[string, string, boolean]> = [
    ['skeleton', '[class*="skeleton" i],[class*="Skeleton"],[data-skeleton],[class*="placeholder-glow"],[class*="placeholder-wave"]', false],
    ['shimmer', '[class*="shimmer" i]', false],
    ['spinner', '[class*="spinner" i],[class*="loader" i]:not(html):not(body),[role="progressbar"]:not([aria-valuenow])', false],
    ['busy', '[aria-busy="true"]', false],
  ];
  if (mode !== 'take') kinds.push(['skeleton', '[class*="animate-pulse"],[data-slot="skeleton"],[data-loading="true"]', true]);
  const store = window as unknown as { __retakeRouteBefore?: WeakSet<Element> };
  if (mode === 'snapshot') {
    store.__retakeRouteBefore = new WeakSet(Array.from(document.querySelectorAll(kinds.map((k) => k[1]).join(','))));
    return null;
  }
  const before = mode === 'route' ? store.__retakeRouteBefore : undefined;
  const blank = (el: Element) => !(el.textContent ?? '').trim() && !el.querySelector('a[href],button,input,select,textarea,[role="button"],[role="link"],img,svg,video,canvas');
  const counts = new Map<string, number>();
  const seen = new Set<Element>();
  for (const [kind, sel, textless] of kinds) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      // An element the narrow selectors counted already is not counted again by the wide ones.
      if ((textless && seen.has(el)) || before?.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < (kind === 'spinner' ? 200 : minArea)) continue;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) continue;
      if (textless && !blank(el)) continue;
      seen.add(el);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  const found = [...counts].map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind));
  return found.length ? found.join(', ') : null;
}
/* c8 ignore stop */

/** The loading indicators a client-side route brought (the route watcher's widened probe), null when none. */
export function routeLoading(page: Page): Promise<string | null> {
  return page.evaluate(loadingInPage, 'route' as const);
}

/** Before a press: the indicators already in view, which a route of that press never counts (R-ISS-14). */
export async function routeSnapshot(page: Page): Promise<void> {
  await page.evaluate(loadingInPage, 'snapshot' as const);
}

/** Spans of probe results: a span opens on a result, closes on null or another result. */
export class LoadingSpans {
  readonly spans: TimelineLoadingUi[] = [];
  private open: { t: number; what: string; page?: string } | null = null;

  note(t: number, what: string | null, page?: string): void {
    if (this.open && (what !== this.open.what || page !== this.open.page)) this.close(t);
    if (what && !this.open) this.open = { t, what, ...(page ? { page } : {}) };
  }

  close(t: number): void {
    if (!this.open) return;
    if (t - this.open.t > 0) this.spans.push({ t_start: round3(this.open.t), t_end: round3(t), what: this.open.what, ...(this.open.page ? { page: this.open.page } : {}) });
    this.open = null;
  }
}

/** Probes the filmed page every PROBE_MS while the take records. */
export class LoadingWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly spans = new LoadingSpans();

  constructor(
    private readonly page: () => Page | undefined,
    private readonly now: () => number,
    private readonly pageId: (p: Page) => string | undefined = () => undefined,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), PROBE_MS);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    const p = this.page();
    if (!p || p.isClosed()) return;
    this.busy = true;
    try {
      const t = this.now();
      const what = await p.evaluate(loadingInPage, 'take' as const).catch(() => null);
      this.spans.note(t, what, this.pageId(p));
    } finally {
      this.busy = false;
    }
  }

  stop(): TimelineLoadingUi[] {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.spans.close(this.now());
    return this.spans.spans;
  }
}
