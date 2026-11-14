/**
 * Hotfix v0.2.6 (client demo retro): what the capture showed of a page still loading beyond an empty screen — a skeleton,
 * a shimmer, a spinner, an `aria-busy` region in the viewport. While a take records, the page on screen is probed every
 * PROBE_MS; the spans where one shows are written to the timeline (`timeline.loading_ui`), and the review says which
 * ones the video shows (`loading-filmed`). Pure but for the timer and the page probe.
 */
import type { Page } from 'playwright-core';
import type { TimelineLoadingUi } from '@retake/core/model';
import { round3 } from './util.js';

export const PROBE_MS = 250;

/* c8 ignore start */
/** Runs in the page (serialised by Playwright: self-contained): the loading indicators that show in the viewport. */
function loadingInPage(): string | null {
  const W = innerWidth;
  const H = innerHeight;
  const minArea = W * H * 0.004;
  const kinds: Array<[string, string]> = [
    ['skeleton', '[class*="skeleton" i],[class*="Skeleton"],[data-skeleton],[class*="placeholder-glow"],[class*="placeholder-wave"]'],
    ['shimmer', '[class*="shimmer" i]'],
    ['spinner', '[class*="spinner" i],[class*="loader" i]:not(html):not(body),[role="progressbar"]:not([aria-valuenow])'],
    ['busy', '[aria-busy="true"]'],
  ];
  const found: string[] = [];
  for (const [kind, sel] of kinds) {
    let n = 0;
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height < (kind === 'spinner' ? 200 : minArea)) continue;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) continue;
      n++;
    }
    if (n) found.push(n > 1 ? `${kind} ×${n}` : kind);
  }
  return found.length ? found.join(', ') : null;
}
/* c8 ignore stop */

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
      const what = await p.evaluate(loadingInPage).catch(() => null);
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
