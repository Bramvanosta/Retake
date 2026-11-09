/** Scrolling: plans, containers, animated scrolls. */
import type { ScrollInfo, ScrollOp } from '../types.js';
import { RT } from './clock.js';
import { host } from './host.js';
import { deref, ref } from './refs.js';
import { contentOffset, flatParent, frameDoc, frameElOf, frameOffset, rectOf, styleOf, winOf } from './trees.js';
import type { Rect } from './trees.js';
import { docScroller, docScrollerOf, isScrollable, visibleRect } from './visibility.js';

// ───────────────────────────── scrolling ─────────────────────────────
/**
 * The next scroll that brings `id` into view, innermost container first: the scrollable ancestors in the element's
 * document, then that document's scroller; then the same from its frame element in the parent document. The
 * container is '' only for the top document's scroller (a frame document's scroller is a ref).
 */
export function scrollPlan(id: string, margin: number, centre = false): ScrollOp | null {
  const el = deref(id);
  if (!el) return null;
  let from = el;
  let r: Rect = el.getBoundingClientRect();
  for (let layer = 0; layer < 16; layer++) {
    const doc = from.ownerDocument;
    const win = winOf(from);
    const scroller = docScrollerOf(doc);
    const containers: Element[] = [];
    for (let p = flatParent(from); p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
      if (isScrollable(p)) containers.push(p);
    }
    containers.push(scroller);
    for (const c of containers) {
      const isDoc = c === scroller;
      let vt: number;
      let vb: number;
      let vl: number;
      let vr: number;
      if (isDoc) {
        vt = 0;
        vb = win.innerHeight;
        vl = 0;
        vr = win.innerWidth;
      } else {
        const cr = c.getBoundingClientRect();
        vt = cr.top + c.clientTop;
        vb = vt + c.clientHeight;
        vl = cr.left + c.clientLeft;
        vr = vl + c.clientWidth;
      }
      const viewH = vb - vt;
      const viewW = vr - vl;
      const m = Math.min(margin, viewH / 4);
      let dy = 0;
      if (r.top < vt + m || r.bottom > vb - m) {
        dy = r.height > viewH - 2 * m ? r.top - (vt + m) : r.top + r.height / 2 - (vt + viewH * 0.42);
      } else if (centre && r.height <= viewH - 2 * m) {
        // In view but covered (a sticky footer or header of the container): towards the middle of the container.
        dy = r.top + r.height / 2 - (vt + viewH * 0.42);
        if (Math.abs(dy) < 24) dy = 0;
      }
      let dx = 0;
      if (r.left < vl || r.right > vr) {
        dx = r.width > viewW ? r.left - vl : r.left + r.width / 2 - (vl + viewW / 2);
      }
      const maxTop = c.scrollHeight - c.clientHeight;
      const maxLeft = c.scrollWidth - c.clientWidth;
      const fromTop = c.scrollTop;
      const fromLeft = c.scrollLeft;
      const top = Math.max(0, Math.min(maxTop, Math.round(fromTop + dy)));
      const left = Math.max(0, Math.min(maxLeft, Math.round(fromLeft + dx)));
      if (Math.abs(top - fromTop) >= 1 || Math.abs(left - fromLeft) >= 1) {
        return { container: isDoc && doc === document ? '' : ref(c), top, left, from_top: fromTop, from_left: fromLeft };
      }
    }
    // In view in this document: bring its frame into view in the parent document.
    const f = frameElOf(doc);
    if (!f) return null;
    const o = contentOffset(f);
    r = { left: r.left + o.x, right: r.right + o.x, top: r.top + o.y, bottom: r.bottom + o.y, width: r.width, height: r.height };
    from = f;
  }
  return null;
}
export function scrollContainerFor(id: string | null, fromParent = false): string {
  const el = deref(id);
  if (el) {
    // An <iframe> itself designates its document's scroller, when that scrolls.
    const fd = fromParent ? null : frameDoc(el);
    const fs = fd ? docScrollerOf(fd) : null;
    if (fs && (fs.scrollHeight > fs.clientHeight + 1 || fs.scrollWidth > fs.clientWidth + 1)) return ref(fs);
    let doc = el.ownerDocument;
    let from: Element | null = fromParent ? flatParent(el) : el;
    for (let layer = 0; layer < 16; layer++) {
      for (let p = from; p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
        if (isScrollable(p)) return ref(p);
      }
      if (doc === document) return '';
      // A frame's document scroller, else the containers around the frame.
      const se = docScrollerOf(doc);
      if (se.scrollHeight > se.clientHeight + 1) return ref(se);
      const f = frameElOf(doc);
      if (!f) return '';
      from = flatParent(f);
      doc = f.ownerDocument;
    }
    return '';
  }
  const se = docScroller();
  if (se.scrollHeight > se.clientHeight + 1) return '';
  // App shells: the document does not scroll; use the largest visible scrollable element.
  let best: Element | null = null;
  let bestArea = 0;
  for (const c of Array.from(document.body?.querySelectorAll('*') ?? [])) {
    if (c === host) continue;
    const cs = styleOf(c);
    if (!/(auto|scroll|overlay)/.test(cs.overflowY) || c.scrollHeight <= c.clientHeight + 1) continue;
    const v = visibleRect(c);
    const area = Math.max(0, v.r - v.l) * Math.max(0, v.b - v.t);
    if (area > bestArea) {
      best = c;
      bestArea = area;
    }
  }
  return best ? ref(best) : '';
}
function containerEl(id: string): Element | null {
  return id ? deref(id) : docScroller();
}
export function scrollInfo(id: string, of?: string | null): ScrollInfo {
  const c = containerEl(id);
  if (!c) throw new Error('scroll container is gone');
  const info: ScrollInfo = {
    container: id,
    top: c.scrollTop,
    left: c.scrollLeft,
    max_top: c.scrollHeight - c.clientHeight,
    max_left: c.scrollWidth - c.clientWidth,
    client_height: c.clientHeight,
  };
  const t = deref(of ?? null);
  if (t) {
    const tr = rectOf(t);
    // Top of the container's viewport in top px: its frame's position for a document scroller.
    const top = c === docScrollerOf(c.ownerDocument) ? frameOffset(c).y : rectOf(c).top + c.clientTop;
    info.target_top = Math.round(tr.top - top + c.scrollTop);
  }
  return info;
}
function easeInOutCubic(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}
/** rAF raced with setTimeout: rAF alone can stall (background/occluded rendering). */
function nextTick(fn: () => void): void {
  let fired = false;
  const go = () => {
    if (fired) return;
    fired = true;
    fn();
  };
  RT.requestAnimationFrame(go);
  RT.setTimeout(go, 17);
}
export function scrollAnimate(id: string, top: number, left: number, ms: number): Promise<{ top: number; left: number }> {
  const c = containerEl(id);
  if (!c) return Promise.reject(new Error('scroll container is gone'));
  const styleEl = (c === docScrollerOf(c.ownerDocument) ? c.ownerDocument.documentElement : c) as HTMLElement;
  const prev = styleEl.style.scrollBehavior;
  styleEl.style.scrollBehavior = 'auto';
  const fromTop = c.scrollTop;
  const fromLeft = c.scrollLeft;
  const t0 = RT.performance.now();
  return new Promise((resolve) => {
    const step = () => {
      const u = ms <= 0 ? 1 : Math.min(1, (RT.performance.now() - t0) / ms);
      const e = easeInOutCubic(u);
      c.scrollTop = fromTop + (top - fromTop) * e;
      c.scrollLeft = fromLeft + (left - fromLeft) * e;
      if (u >= 1) {
        styleEl.style.scrollBehavior = prev;
        resolve({ top: c.scrollTop, left: c.scrollLeft });
        return;
      }
      nextTick(step);
    };
    step();
  });
}
