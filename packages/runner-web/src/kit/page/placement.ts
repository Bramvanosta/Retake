/** Popups and where the cursor goes: the open popups, blank points outside them, rest points next to a target. */
import type { OutsidePlan, PopupEntry } from '../types.js';
import type { BBox, PointSpec } from '@retake/core/model';
import { config } from './config.js';
import { host } from './host.js';
import { pointFor } from './points.js';
import { deref, ref } from './refs.js';
import { explicitRole, isInteractive, treeOf } from './roles.js';
import { isFloating, isPopoverOpen, topDialog } from './scopes.js';
import { deepClosest, deepContains, deepHit, deepQsa, frameOffset, rectOf, styleOf } from './trees.js';
import { bboxOf, isVisible } from './visibility.js';

// ───────────────────────────── popups ─────────────────────────────
export const POPUP_SEL = '[role=menu],[role=listbox],[role=dialog],[role=alertdialog],dialog[open],[data-radix-popper-content-wrapper],[popover]';
export const popupIds = new WeakMap<Element, number>();
let popupSeq = 0;
export function popupState(): PopupEntry[] {
  const out: PopupEntry[] = [];
  for (const el of deepQsa(document, POPUP_SEL)) {
    if (el === host) continue;
    if (el.hasAttribute('popover') && !isPopoverOpen(el)) continue;
    if (!isVisible(el)) continue;
    let id = popupIds.get(el);
    if (id === undefined) {
      id = ++popupSeq;
      popupIds.set(el, id);
    }
    const role = explicitRole(el);
    out.push({ id, kind: role ?? (el.tagName === 'DIALOG' ? 'dialog' : el.hasAttribute('popover') ? 'popover' : 'popper'), bbox: bboxOf(el) });
  }
  return out;
}

function blankAt(x: number, y: number, avoid: Element[]): boolean {
  const hit = deepHit(x, y);
  if (!hit) return false;
  // A click inside a frame never reaches this document's outside-click handlers.
  if (hit.ownerDocument !== document || hit.localName === 'iframe' || hit.localName === 'frame') return false;
  if (isInteractive(hit)) return false;
  if (avoid.some((a) => deepContains(a, hit))) return false;
  if (deepClosest(hit, POPUP_SEL.replace(',[role=dialog],[role=alertdialog],dialog[open]', ''))) return false;
  return true;
}
/** Box of an element's text (a Range over its contents), top px; null when it has none. */
export function textBox(el: Element): BBox | null {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const o = frameOffset(el);
  return { x: Math.round(r.left + o.x), y: Math.round(r.top + o.y), w: Math.round(r.width), h: Math.round(r.height) };
}
function textRectCentre(el: Element): PointSpec | null {
  const b = textBox(el);
  return b ? { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) } : null;
}
export function outsidePlan(near: PointSpec, avoidIds: number[]): OutsidePlan | null {
  const allPopups = deepQsa(document, POPUP_SEL);
  const popupEls = allPopups.filter((e) => {
    const id = popupIds.get(e);
    return id !== undefined && avoidIds.includes(id);
  });
  let dlg = topDialog(true);
  // A floating dialog being closed (a date popover with role=dialog) holds nothing: the dialog under it holds the
  // click, else a blank spot. Not when something else is being closed too (a listbox it opened, portaled out of it):
  // then it holds that pick and stays open.
  const closing = (e: Element) => popupEls.some((p) => p === e || deepContains(p, e));
  if (dlg && isFloating(dlg) && closing(dlg)) {
    const d = dlg;
    if (popupEls.every((p) => p === d || deepContains(p, d) || deepContains(d, p))) dlg = topDialog(true, (e) => e === d || closing(e));
  }
  const avoid = popupEls.filter((p) => p !== dlg && !(dlg && deepContains(p, dlg)));
  const keepFor = (x: number, y: number): number[] => {
    const hit = deepHit(x, y);
    if (!hit) return [];
    const ids: number[] = [];
    for (const el of allPopups) {
      const id = popupIds.get(el);
      if (id !== undefined && deepContains(el, hit)) ids.push(id);
    }
    return ids;
  };
  const plan = (kind: OutsidePlan['kind'], x: number, y: number, r?: string): OutsidePlan => ({ kind, x, y, ref: r, keep: keepFor(x, y) });
  if (dlg) {
    const lb = dlg.getAttribute('aria-labelledby');
    const byId = lb ? treeOf(dlg).getElementById(lb.split(/\s+/)[0]) : null;
    const title = (byId && dlg.contains(byId) ? byId : null) ?? Array.from(dlg.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')).find((h) => isVisible(h)) ?? null;
    if (title && isVisible(title)) {
      const c = textRectCentre(title) ?? pointFor(ref(title))!;
      if (c && blankAt(c.x, c.y, avoid)) return plan('dialog-title', c.x, c.y, ref(title));
      const tb = rectOf(title);
      for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
        const x = Math.round(tb.left + tb.width * fx);
        const y = Math.round(tb.top + tb.height / 2);
        if (blankAt(x, y, avoid)) return plan('dialog-title', x, y, ref(title));
      }
    }
    // Blank padding inside the dialog, top area first.
    const dr = rectOf(dlg);
    for (let fy = 0.04; fy <= 0.5; fy += 0.06) {
      for (let fx = 0.5; fx <= 0.96; fx += 0.08) {
        const x = Math.round(dr.left + dr.width * fx);
        const y = Math.round(dr.top + dr.height * fy);
        const hit = deepHit(x, y);
        if (hit && deepContains(dlg, hit) && blankAt(x, y, avoid)) return plan('blank', x, y);
      }
    }
    return null;
  }
  const pts: PointSpec[] = [];
  const W = window.innerWidth;
  const H = window.innerHeight;
  for (const y of [24, 48, 80, 112, 150, 200]) {
    for (let fx = 0.05; fx <= 0.96; fx += 0.05) pts.push({ x: Math.round(W * fx), y: Math.min(H - 4, y) });
  }
  for (let fy = 0.3; fy <= 0.95; fy += 0.1) for (let fx = 0.05; fx <= 0.96; fx += 0.1) pts.push({ x: Math.round(W * fx), y: Math.round(H * fy) });
  const dist = (p: PointSpec) => Math.hypot(p.x - near.x, p.y - near.y);
  const top = pts.slice(0, 6 * 19).filter((p) => blankAt(p.x, p.y, avoid));
  const pool = top.length ? top : pts.filter((p) => blankAt(p.x, p.y, avoid));
  if (!pool.length) return null;
  pool.sort((a, b) => dist(a) - dist(b));
  return plan('blank', pool[0].x, pool[0].y);
}

/** The drawn cursor at (x, y) overlaps one of `boxes` (with a `clear` margin). */
function coversAny(x: number, y: number, boxes: BBox[] | undefined, clear = 14): boolean {
  if (!boxes || !boxes.length) return false;
  const c = cursorBox(x, y);
  return boxes.some((b) => c.r > b.x - clear && c.l < b.x + b.w + clear && c.b > b.y - clear && c.t < b.y + b.h + clear);
}
export function restPoint(where: 'side' | 'centre' = 'side', avoid?: BBox[]): PointSpec {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const cands: Array<[number, number]> =
    where === 'centre'
      ? [
          [0.5, 0.5],
          [0.5, 0.42],
          [0.44, 0.5],
          [0.56, 0.5],
          [0.5, 0.58],
          [0.42, 0.42],
          [0.58, 0.42],
          [0.42, 0.58],
          [0.58, 0.58],
        ]
      : [
          [0.8, 0.5],
          [0.84, 0.44],
          [0.76, 0.58],
          [0.88, 0.52],
          [0.72, 0.46],
          [0.82, 0.66],
          [0.9, 0.36],
          [0.66, 0.62],
        ];
  for (const [fx, fy] of cands) {
    const x = Math.round(W * fx);
    const y = Math.round(H * fy);
    if (coversAny(x, y, avoid)) continue;
    const hit = deepHit(x, y);
    if (!hit || isInteractive(hit)) continue;
    const cur = styleOf(hit).cursor;
    if (cur === 'pointer' || cur === 'text') continue;
    return { x, y };
  }
  return where === 'centre' ? { x: Math.round(W * 0.5), y: Math.round(H * 0.5) } : { x: Math.round(W * 0.8), y: Math.round(H * 0.5) };
}

/** Box covered by the drawn cursor when its hotspot is at (x, y): the arrow extends right and down. */
function cursorBox(x: number, y: number): { l: number; t: number; r: number; b: number } {
  const size = Math.max(12, config.cursor.size || 26);
  return { l: x - 6, t: y - 6, r: x + size * 0.8 + 4, b: y + size + 6 };
}
export function restNear(box: BBox, at: { point?: PointSpec; ref?: string; avoid?: BBox[] } = {}): { x: number; y: number; side: string } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const EDGE = 28;
  const CLEAR = 14;
  // A wide target is clicked at one point: rest next to that point, not next to the far corner of its box.
  const NEAR_SPAN = 80;
  const R0 = box.x + box.w;
  const B = box.y + box.h;
  const px = at.point ? Math.min(R0, Math.max(box.x, at.point.x)) : box.x + box.w / 2;
  const L = Math.max(box.x, px - NEAR_SPAN);
  const R = Math.min(R0, px + NEAR_SPAN);
  const cx = (L + R) / 2;
  const cy = box.y + box.h / 2;
  // Natural resting spots a hand would leave the pointer at: below-right first, then around the target.
  const cands: Array<[string, number, number]> = [
    ['below-right', R + 56, B + 44],
    ['right', R + 84, cy + 18],
    ['below', cx + 36, B + 64],
    ['below-left', L - 64, B + 44],
    ['above-right', R + 56, box.y - 72],
    ['above', cx + 36, box.y - 92],
    ['left', L - 96, cy + 18],
    ['above-left', L - 72, box.y - 72],
  ];
  // Inside the dialog that holds the target: never out on its backdrop (the arrow extends right and down).
  const at0 = at.ref ? deref(at.ref) : null;
  const host = at0 ? deepClosest(at0, '[role=dialog],[role=alertdialog],dialog,[aria-modal=true]') : null;
  const hr = host ? rectOf(host) : null;
  const inHost = (x: number, y: number) => !hr || (x >= hr.left + 12 && y >= hr.top + 12 && x <= hr.right - 12 - 20 && y <= hr.bottom - 12 - 28);
  const inside = (x: number, y: number) => x >= EDGE && y >= EDGE && x <= W - EDGE - 20 && y <= H - EDGE - 28;
  const covers = (x: number, y: number) => {
    const c = cursorBox(x, y);
    return (c.r > box.x - CLEAR && c.l < R0 + CLEAR && c.b > box.y - CLEAR && c.t < B + CLEAR) || coversAny(x, y, at.avoid, CLEAR);
  };
  const neutral = (x: number, y: number) => {
    const hit = deepHit(x, y);
    if (!hit) return true;
    if (isInteractive(hit) || deepClosest(hit, 'a[href],button,input,select,textarea,[role=button],[role=link]')) return false;
    const cur = styleOf(hit).cursor;
    return cur !== 'pointer' && cur !== 'text';
  };
  const ok = cands.filter(([, x, y]) => inside(x, y) && !covers(x, y)).map(([side, x, y]) => ({ side, x: Math.round(x), y: Math.round(y) }));
  const usual = ok.find((p) => inHost(p.x, p.y) && neutral(p.x, p.y));
  if (usual) return usual;
  // No usual spot is free (a form in a dialog: fields all around): look closer to the click point, below-right
  // first — the gap between two rows of fields, a label — before settling on something interactive.
  const DIRS: Array<[string, number]> = [
    ['below-right', 0.25],
    ['below', 0.5],
    ['right', 0],
    ['below-left', 0.75],
    ['above-right', -0.25],
    ['above', -0.5],
    ['left', 1],
    ['above-left', -0.75],
  ];
  for (const r of [40, 56, 72, 96, 128, 160]) {
    for (const [side, turn] of DIRS) {
      const x = Math.round(px + r * Math.cos(turn * Math.PI));
      const y = Math.round(cy + r * Math.sin(turn * Math.PI));
      if (inside(x, y) && !covers(x, y) && inHost(x, y) && neutral(x, y)) return { side: `near-${side}`, x, y };
    }
  }
  const best = ok.find((p) => inHost(p.x, p.y)) ?? ok.find((p) => neutral(p.x, p.y)) ?? ok[0];
  if (best) return best;
  return { ...restPoint('side', at.avoid), side: 'fallback' };
}
