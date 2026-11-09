/** Visibility: what a viewer can see, boxes, what is in view. */
import type { BBox } from '@retake/core';
import { memo } from './memo.js';
import { SKIP_TAGS, lc, norm } from './text.js';
import { flatParent, frameElOf, frameOffset, rectOf, styleOf, trees, upOf, winOf } from './trees.js';

// ───────────────────────────── visibility ─────────────────────────────
export function isScrollable(el: Element): boolean {
  const cs = styleOf(el);
  const oy = cs.overflowY;
  const ox = cs.overflowX;
  const sy = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
  const sx = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth + 1;
  return sy || sx;
}
function clipsContent(el: Element): boolean {
  const cs = styleOf(el);
  return cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
}
export function docScroller(): Element {
  return document.scrollingElement ?? document.documentElement;
}
export function docScrollerOf(doc: Document): Element {
  return doc.scrollingElement ?? doc.documentElement;
}

export function isVisible(el: Element): boolean {
  if (!memo) return isVisibleLive(el);
  let v = memo.vis.get(el);
  if (v === undefined) memo.vis.set(el, (v = isVisibleLive(el)));
  return v;
}
function isVisibleLive(el: Element): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.width <= 1 && r.height <= 1) return false;
  const anyEl = el as Element & {
    checkVisibility?: (o: Record<string, boolean>) => boolean;
  };
  if (typeof anyEl.checkVisibility === 'function') {
    if (!anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
      return false;
    }
  } else {
    const cs = styleOf(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') return false;
  }
  // Outside the scrollable area of the document (e.g. left:-9999px).
  const win = winOf(el);
  const sx = win.scrollX;
  const sy = win.scrollY;
  if (r.right + sx <= 0 || r.bottom + sy <= 0) return false;
  // Clipped away by a non-scrolling overflow ancestor (carousels, collapsed panels).
  const doc = el.ownerDocument;
  for (let p = flatParent(el); p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
    if (!clipsContent(p)) continue;
    const cs = styleOf(p);
    const scrolls = /(auto|scroll|overlay)/.test(cs.overflowX + cs.overflowY);
    if (scrolls) continue;
    const pr = p.getBoundingClientRect();
    if (r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom) return false;
  }
  // In a frame: the frame element must be visible too.
  const f = frameElOf(doc);
  return !f || isVisible(f);
}

/** Product of the computed opacities of an element and its ancestors (animations included), frames included. */
function effectiveOpacity(el: Element): number {
  let o = 1;
  for (let p: Element | null = el; p && o > 0; p = upOf(p)) o *= parseFloat(styleOf(p).opacity) || 0;
  return o;
}

/** Text of a node's own text children (text placed directly in a shadow root). */
export function directText(n: Node): string {
  return norm(
    Array.from(n.childNodes)
      .filter((c) => c.nodeType === 3)
      .map((c) => c.textContent)
      .join(' '),
  );
}

/**
 * Whether `text` is visible to a viewer: the innermost elements containing it must be visible and at least half
 * opaque. `innerText` alone also counts text that is laid out but still transparent (staggered reveals, fade-ins).
 * `body.innerText` leaves out open shadow roots and frames: each of them is searched the same way.
 */
export function textVisible(text: string): boolean {
  const needle = lc(norm(text));
  const body = document.body as HTMLElement | null;
  if (!needle) return true;
  if (!body) return false;
  const has = (el: Element) => lc(norm(el.textContent ?? '')).includes(needle);
  const seen = (el: Element) =>
    isVisible(el) && effectiveOpacity(el) >= 0.5 && lc(norm((el as HTMLElement).innerText ?? el.textContent ?? '')).includes(needle);
  const innermost = (from: Element): Element[] => {
    const hits: Element[] = [];
    const visit = (el: Element) => {
      let deeper = false;
      for (const child of Array.from(el.children)) {
        if (has(child)) {
          deeper = true;
          visit(child);
        }
      }
      if (!deeper) hits.push(el);
    };
    visit(from);
    return hits;
  };
  if (lc(norm(body.innerText ?? '')).includes(needle) && innermost(body).some(seen)) return true;
  for (const t of trees(body).list.slice(1)) {
    if (t.nodeType === 1) {
      // A frame's body.
      if (lc(norm((t as HTMLElement).innerText ?? '')).includes(needle) && innermost(t as Element).some(seen)) return true;
      continue;
    }
    const sr = t as ShadowRoot;
    if (!lc(norm(sr.textContent)).includes(needle)) continue;
    let deeper = false;
    for (const c of Array.from(sr.children)) {
      if (SKIP_TAGS.has(c.tagName) || !has(c)) continue;
      deeper = true;
      if (innermost(c).some(seen)) return true;
    }
    // Text placed directly in the shadow root: its host shows it.
    if (!deeper && lc(directText(sr)).includes(needle) && isVisible(sr.host) && effectiveOpacity(sr.host) >= 0.5) return true;
  }
  return false;
}

export function bboxOf(el: Element): BBox {
  const r = rectOf(el);
  const rd = (n: number) => Math.round(n * 100) / 100;
  return { x: rd(r.left), y: rd(r.top), w: rd(r.width), h: rd(r.height) };
}

/** Visible part of an element (top px): rect ∩ viewport ∩ every clipping/scrolling ancestor ∩ its frames' parts. */
export function visibleRect(el: Element): { l: number; t: number; r: number; b: number } {
  const doc = el.ownerDocument;
  const win = winOf(el);
  const rc = el.getBoundingClientRect();
  let l = Math.max(rc.left, 0);
  let t = Math.max(rc.top, 0);
  let r = Math.min(rc.right, win.innerWidth);
  let b = Math.min(rc.bottom, win.innerHeight);
  for (let p = flatParent(el); p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
    if (!clipsContent(p)) continue;
    const pr = p.getBoundingClientRect();
    l = Math.max(l, pr.left + p.clientLeft);
    t = Math.max(t, pr.top + p.clientTop);
    r = Math.min(r, pr.left + p.clientLeft + p.clientWidth);
    b = Math.min(b, pr.top + p.clientTop + p.clientHeight);
  }
  const f = frameElOf(doc);
  if (!f) return { l, t, r, b };
  // In a frame: into top px, clipped by the frame element's own visible part (top px too).
  const o = frameOffset(el);
  const fv = visibleRect(f);
  return { l: Math.max(l + o.x, fv.l), t: Math.max(t + o.y, fv.t), r: Math.min(r + o.x, fv.r), b: Math.min(b + o.y, fv.b) };
}
export function inView(el: Element): boolean {
  const rc = el.getBoundingClientRect();
  const v = visibleRect(el);
  const vw = v.r - v.l;
  const vh = v.b - v.t;
  if (vw <= 0 || vh <= 0) return false;
  const win = winOf(el);
  const W = Math.min(window.innerWidth, win.innerWidth);
  const H = Math.min(window.innerHeight, win.innerHeight);
  return vw >= Math.min(rc.width, W * 0.8) - 1 && vh >= Math.min(rc.height, H * 0.8) - 1;
}
