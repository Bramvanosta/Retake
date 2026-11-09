/** Text helpers: normalised text and match tiers. */
import { memo } from './memo.js';
import { isA } from './trees.js';

// ───────────────────────────── text helpers ─────────────────────────────
export const norm = (s: string | null | undefined): string =>
  (s ?? '').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
export const lc = (s: string): string => s.toLowerCase();
/** Lower-cased normalised textContent (memoised during an inspection). */
export function lowText(n: Node): string {
  if (!memo) return lc(norm(n.textContent));
  let v = memo.low.get(n);
  if (v === undefined) memo.low.set(n, (v = lc(norm(n.textContent))));
  return v;
}
export const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'RETAKE-CURSOR']);
export const BUTTON_INPUT = 'input[type=button],input[type=submit],input[type=reset]';

export function textOf(el: Element): string {
  if (isA(el, 'input')) {
    return el.matches(BUTTON_INPUT) ? norm(el.value) : '';
  }
  return norm(el.textContent);
}
export function short(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export type Tier = 0 | 1 | 2; // exact, case-insensitive exact, substring
export function tierOf(text: string, q: string, exactOnly: boolean): Tier | -1 {
  if (text === q) return 0;
  const tl = lc(text);
  const ql = lc(q);
  if (tl === ql) return 1;
  if (!exactOnly && ql.length > 0 && tl.includes(ql)) return 2;
  return -1;
}
/**
 * Keep the best non-empty tier (exact first, then case-insensitive, then substring). With `own` (items of the
 * searched document, not of a frame inside it), the tier is the best one of those items when there are any: an exact
 * match in a widget frame does not beat a partial one on the page (the frame's matches of that tier still count).
 */
export function bestTier<T>(items: T[], text: (t: T) => string, q: string, exactOnly: boolean, own?: (t: T) => boolean): T[] {
  const tiers: T[][] = [[], [], []];
  const mine = [false, false, false];
  const qn = norm(q);
  for (const it of items) {
    const t = tierOf(text(it), qn, exactOnly);
    if (t < 0) continue;
    tiers[t].push(it);
    if (own?.(it)) mine[t] = true;
  }
  const k = mine.includes(true) ? mine.indexOf(true) : tiers.findIndex((t) => t.length > 0);
  return k >= 0 ? tiers[k] : [];
}
