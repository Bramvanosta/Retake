/**
 * Placing a box next to a target without covering it (numbered step badges, the typing loupe — L2.10). Pure.
 */
import { safeAreaRect } from './style.js';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 'left' | 'right' | 'above' | 'below' | 'above-left' | 'above-right' | 'below-left' | 'below-right';

function candidate(target: Box, w: number, h: number, gap: number, side: Side): Box {
  const cx = target.x + target.w / 2 - w / 2;
  const cy = target.y + target.h / 2 - h / 2;
  switch (side) {
    case 'left':
      return { x: target.x - gap - w, y: cy, w, h };
    case 'right':
      return { x: target.x + target.w + gap, y: cy, w, h };
    case 'above':
      return { x: cx, y: target.y - gap - h, w, h };
    case 'below':
      return { x: cx, y: target.y + target.h + gap, w, h };
    case 'above-left':
      return { x: target.x - w * 0.5, y: target.y - gap - h, w, h };
    case 'above-right':
      return { x: target.x + target.w - w * 0.5, y: target.y - gap - h, w, h };
    case 'below-left':
      return { x: target.x - w * 0.5, y: target.y + target.h + gap, w, h };
    default:
      return { x: target.x + target.w - w * 0.5, y: target.y + target.h + gap, w, h };
  }
}

const inside = (b: Box, bounds: Box) => b.x >= bounds.x - 0.5 && b.y >= bounds.y - 0.5 && b.x + b.w <= bounds.x + bounds.w + 0.5 && b.y + b.h <= bounds.y + bounds.h + 0.5;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function clampInto(b: Box, bounds: Box): Box {
  return {
    ...b,
    x: Math.min(Math.max(b.x, bounds.x), Math.max(bounds.x, bounds.x + bounds.w - b.w)),
    y: Math.min(Math.max(b.y, bounds.y), Math.max(bounds.y, bounds.y + bounds.h - b.h)),
  };
}

const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * A `w × h` box beside `target` (gap `gap`), on the first side of `order` where it lies inside `bounds` without
 * covering the target nor any `avoid` box (a caption band over the screen); otherwise the side that, once clamped
 * inside `bounds`, covers them least (the target first).
 */
export function placeBeside(opts: { target: Box; w: number; h: number; bounds: Box; gap: number; order?: readonly Side[]; avoid?: readonly Box[] }): Box & { side: Side; fits: boolean } {
  const order = opts.order ?? ['left', 'above-left', 'above', 'right', 'below', 'below-left', 'above-right', 'below-right'];
  const avoid = opts.avoid ?? [];
  for (const side of order) {
    const b = candidate(opts.target, opts.w, opts.h, opts.gap, side);
    if (inside(b, opts.bounds) && !overlaps(b, opts.target) && !avoid.some((a) => overlaps(b, a))) return { ...b, side, fits: true };
  }
  let best: (Box & { side: Side; fits: boolean }) | undefined;
  let bestCost = Infinity;
  for (const side of order) {
    const b = clampInto(candidate(opts.target, opts.w, opts.h, opts.gap, side), opts.bounds);
    const cost = overlapArea(b, opts.target) * 4 + avoid.reduce((s, a) => s + overlapArea(b, a), 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = { ...b, side, fits: false };
    }
  }
  return best!;
}

export type LoupePlacement = 'auto' | 'below' | 'above';

/** Sides tried by the typing loupe, per `placement`. */
export const LOUPE_ORDER: Readonly<Record<LoupePlacement, readonly Side[]>> = {
  auto: ['below', 'above', 'right', 'left'],
  below: ['below', 'above'],
  above: ['above', 'below'],
};

/** Readable floor of the typing loupe: lens design px per source CSS px. */
export const LOUPE_MIN_SCALE = 1.5;

export interface LoupeLens {
  /** The lens box, border included, and the side of the field it is on (`fits`: without covering the field or `avoid`). */
  box: Box & { side: Side; fits: boolean };
  /** The magnified region (inside the border). */
  w: number;
  h: number;
  border: number;
  /** Lens px per source CSS px. */
  scale: number;
}

/**
 * The lens of studio/overlay-loupe beside a field (`anchor`, output px) showing `region` (source CSS px): magnified
 * `zoom` × the capture's on-screen scale, at least LOUPE_MIN_SCALE × unit, at most `maxWidth` and the capture's width,
 * inside the capture (`screen`), clear of `avoid`. Shared by the component and the composition (which keeps one side for
 * a lens gliding from field to field).
 */
export function loupeLens(o: {
  anchor: Box;
  region: Box;
  screen?: Box;
  width: number;
  height: number;
  unit: number;
  variant: 'landscape' | 'vertical' | 'square';
  zoom: number;
  maxWidth: number;
  placement: LoupePlacement;
  avoid?: readonly Box[];
}): LoupeLens {
  const u = o.unit;
  const inset = 16 * u;
  const cap = o.screen;
  const bounds = cap ? { x: cap.x + inset, y: cap.y + inset, w: cap.w - 2 * inset, h: cap.h - 2 * inset } : safeAreaRect(o.width, o.height, 0.03);
  const shown = o.anchor.w / o.region.w;
  const floor = LOUPE_MIN_SCALE * u * (o.variant === 'landscape' ? 1 : 1.1);
  let scale = Math.max(shown * o.zoom, floor);
  const maxW = Math.min(o.maxWidth * u, bounds.w * 0.96, o.width * 0.94);
  if (o.region.w * scale > maxW) scale = maxW / o.region.w;
  const w = Math.round(o.region.w * scale * 100) / 100;
  const h = Math.round(o.region.h * scale * 100) / 100;
  const border = 3 * u;
  const box = placeBeside({ target: o.anchor, w: w + 2 * border, h: h + 2 * border, bounds, gap: 22 * u, order: LOUPE_ORDER[o.placement], ...(o.avoid ? { avoid: o.avoid } : {}) });
  return { box, w, h, border, scale };
}

/**
 * `box` moved up (`dir: 'up'`) or down until it overlaps none of `avoid` (`gap` from the box it clears), then kept
 * inside `bounds` (when there is no room, the bounds win). Key caps over a caption band, for instance.
 */
export function clearOf(box: Box, avoid: readonly Box[] | undefined, opts: { dir: 'up' | 'down'; gap?: number; bounds?: Box }): Box {
  let b = { ...box };
  const gap = opts.gap ?? 0;
  for (let i = 0; i < 8; i++) {
    const hit = (avoid ?? []).find((a) => overlaps(b, a));
    if (!hit) break;
    b = { ...b, y: opts.dir === 'up' ? hit.y - gap - b.h : hit.y + hit.h + gap };
  }
  return opts.bounds ? clampInto(b, opts.bounds) : b;
}

/** Sides a numbered step badge tries, per `placement` (studio/overlay-steps). */
export const STEP_BADGE_ORDER: Readonly<Record<'auto' | 'left' | 'right' | 'above' | 'below', readonly Side[]>> = {
  auto: ['left', 'above-left', 'above', 'right', 'below-left', 'below', 'above-right', 'below-right'],
  left: ['left', 'above-left', 'below-left', 'right'],
  right: ['right', 'above-right', 'below-right', 'left'],
  above: ['above', 'above-left', 'above-right', 'below'],
  below: ['below', 'below-left', 'below-right', 'above'],
};

/**
 * Where studio/overlay-steps draws its badge (output px): `size` design px (× 1.1 outside landscape) beside the target
 * (`anchor`; a point is a 2 × 2 box), inside the capture (`screen`, else the safe area), clear of `avoid`. Shared by the
 * component and the review.
 */
export function stepBadgeBox(o: {
  anchor?: Box;
  screen?: Box;
  width: number;
  height: number;
  unit: number;
  variant: 'landscape' | 'vertical' | 'square';
  size: number;
  placement: keyof typeof STEP_BADGE_ORDER;
  avoid?: readonly Box[];
}): Box & { side: Side; fits: boolean; d: number; u: number } {
  const u = o.unit * (o.variant === 'landscape' ? 1 : 1.1);
  const d = o.size * u;
  const inset = 10 * u;
  const s = o.screen;
  const bounds = s ? { x: s.x + inset, y: s.y + inset, w: s.w - 2 * inset, h: s.h - 2 * inset } : safeAreaRect(o.width, o.height, 0.03);
  const a = o.anchor;
  const target = a && a.w > 0 ? a : a ? { x: a.x - 1, y: a.y - 1, w: 2, h: 2 } : { x: bounds.x + d, y: bounds.y + d, w: 1, h: 1 };
  const place = placeBeside({ target, w: d, h: d, bounds, gap: 10 * u, order: STEP_BADGE_ORDER[o.placement] ?? STEP_BADGE_ORDER.auto, ...(o.avoid ? { avoid: o.avoid } : {}) });
  return { ...place, d, u };
}
