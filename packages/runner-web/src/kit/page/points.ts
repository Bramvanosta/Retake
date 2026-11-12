/** Points and hit testing: where an element is pressed. */
import type { PointInfo } from '../types.js';
import type { PointSpec } from '@retake/core/model';
import { deref } from './refs.js';
import { deepContains, deepHit, isA } from './trees.js';
import { bboxOf, visibleRect } from './visibility.js';

// ───────────────────────────── points & hit testing ─────────────────────────────
export function hitInside(el: Element, x: number, y: number): boolean {
  const hit = deepHit(x, y);
  if (!hit) return false;
  if (deepContains(el, hit)) return true;
  // A <label> forwarding to its control, or a control that sits inside a label we hit.
  return isA(hit, 'label') && hit.control === el;
}
export function pointFor(id: string, offset?: PointSpec | null): PointInfo | null {
  const el = deref(id);
  if (!el) return null;
  const bbox = bboxOf(el);
  const v = visibleRect(el);
  if (offset) {
    const x = Math.round(bbox.x + offset.x);
    const y = Math.round(bbox.y + offset.y);
    return { x, y, bbox, hit: hitInside(el, x, y) };
  }
  const cx = Math.round((Math.max(v.l, bbox.x) + Math.min(v.r, bbox.x + bbox.w)) / 2);
  const cy = Math.round((Math.max(v.t, bbox.y) + Math.min(v.b, bbox.y + bbox.h)) / 2);
  if (hitInside(el, cx, cy)) return { x: cx, y: cy, bbox, hit: true };
  // Centre obscured: sample a grid inside the visible part, closest to the centre first.
  const pts: Array<[number, number]> = [];
  for (let fx = 0.15; fx <= 0.86; fx += 0.175) {
    for (let fy = 0.2; fy <= 0.81; fy += 0.2) {
      pts.push([Math.round(v.l + (v.r - v.l) * fx), Math.round(v.t + (v.b - v.t) * fy)]);
    }
  }
  pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  for (const [x, y] of pts) if (hitInside(el, x, y)) return { x, y, bbox, hit: true };
  return { x: cx, y: cy, bbox, hit: false };
}
