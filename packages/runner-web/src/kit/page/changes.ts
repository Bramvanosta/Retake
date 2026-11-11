/** What changed on the page since an action started (where the cursor parks after it). */
import type { BBox } from '@retake/core';
import { host } from './host.js';
import { cleanups } from './lifecycle.js';
import { isVisible } from './visibility.js';

// ───────────────────────────── changes (parking, R-CHO-21) ─────────────────────────────
// What changed on the page since an action started: elements added, removed from, re-texted or restyled (top
// document; the cursor overlay ignored). Boxes are measured when asked; one over 40 % of the viewport (a page, an
// opened dialog) is not a "changed area" the cursor could stay clear of.
let watch: { obs: MutationObserver; els: Set<Element>; take: (list: MutationRecord[]) => void } | null = null;
const WATCH_ATTRS = ['class', 'style', 'hidden', 'open', 'disabled', 'value', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'data-state'];
/** The change watcher stops with the kit (`api.dispose`). */
export function stopWatchingOnDispose(): void {
  cleanups.push(() => watch?.obs.disconnect());
}
export function watchChanges(): void {
  watch?.obs.disconnect();
  const els = new Set<Element>();
  // The 500 most recent elements: a change after a large re-render (a toast after a table) still counts.
  const add = (n: Node | null) => {
    const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
    if (!el || el === host) return;
    els.delete(el);
    els.add(el);
    if (els.size > 500) els.delete(els.values().next().value as Element);
  };
  const take = (list: MutationRecord[]) => {
    for (const m of list) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(add);
        if (m.removedNodes.length) add(m.target);
      } else {
        add(m.target);
      }
    }
  };
  const obs = new MutationObserver(take);
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: WATCH_ATTRS });
  watch = { obs, els, take };
}
export function changedBoxes(): { watching: boolean; boxes: BBox[] } {
  if (!watch) return { watching: false, boxes: [] };
  watch.take(watch.obs.takeRecords());
  const W = window.innerWidth;
  const H = window.innerHeight;
  const rects: Array<{ l: number; t: number; r: number; b: number }> = [];
  for (const el of watch.els) {
    if (!el.isConnected || el === host || el === document.body || el === document.documentElement) continue;
    const rc = el.getBoundingClientRect();
    const l = Math.max(0, rc.left);
    const t = Math.max(0, rc.top);
    const r = Math.min(W, rc.right);
    const b = Math.min(H, rc.bottom);
    if (r - l < 1 || b - t < 1 || (r - l) * (b - t) > 0.4 * W * H || !isVisible(el)) continue;
    rects.push({ l, t, r, b });
  }
  // Merge overlapping boxes; keep the 12 largest.
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < rects.length && !merged; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const c = rects[j];
        if (a.l <= c.r && c.l <= a.r && a.t <= c.b && c.t <= a.b) {
          rects[i] = { l: Math.min(a.l, c.l), t: Math.min(a.t, c.t), r: Math.max(a.r, c.r), b: Math.max(a.b, c.b) };
          rects.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  rects.sort((a, c) => (c.r - c.l) * (c.b - c.t) - (a.r - a.l) * (a.b - a.t));
  return {
    watching: true,
    boxes: rects.slice(0, 12).map((x) => ({ x: Math.round(x.l), y: Math.round(x.t), w: Math.round(x.r - x.l), h: Math.round(x.b - x.t) })),
  };
}
