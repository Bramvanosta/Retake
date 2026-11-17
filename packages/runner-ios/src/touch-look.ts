/**
 * How a touch looks on an iOS capture (docs/reference/look.md, "Touches"): a translucent mid-grey disc of 38 pt (as
 * iOS's own touch indicator: it reads on a white list and on a blue button alike) with a thin white ring and a soft
 * shadow — it appears 150 ms before the touch-down (120 ms, scale 1.12 → 1), presses to .88
 * in 80 ms, comes back at the lift and fades in 180 ms — and a click ripple at the touch-down as the web cursor's
 * (docs/reference/choreography.md: a 12 pt disc, scale .4 → 5.5 in .5 s cubic-bezier(.2,.7,.2,1), opacity 1 → 0 in
 * .55 s ease-out), in the theme's ripple colour. What is drawn at a time is a list of marks (pure), in points.
 */
import type { Touch } from './touch-track.js';
import { TOUCH_LEAD_S, TOUCH_LIFT_S, touchPoint } from './touch-track.js';

export type Rgba = readonly [number, number, number, number];

export const TOUCH_LOOK = {
  dotDiameter: 38,
  fill: [128, 128, 128, 0.42] as Rgba,
  ringWidth: 1.5,
  ring: [255, 255, 255, 0.6] as Rgba,
  shadow: { blur: 4, alpha: 0.16, dy: 1.5 },
  appearS: 0.12,
  appearScale: 1.12,
  pressS: 0.08,
  pressScale: 0.88,
  ripple: { diameter: 12, from: 0.4, to: 5.5, scaleS: 0.5, fadeS: 0.55 },
} as const;

/** The ripple colour when the theme gives none (core DEFAULT_TEMPLATE's). */
export const DEFAULT_RIPPLE: Rgba = [51, 85, 209, 0.45];

export interface DotMark {
  kind: 'dot';
  x: number;
  y: number;
  opacity: number;
  scale: number;
}

export interface RippleMark {
  kind: 'ripple';
  x: number;
  y: number;
  /** Radius, points. */
  radius: number;
  opacity: number;
}

export type TouchMark = DotMark | RippleMark;

/** A CSS cubic-bezier timing function at progress `t` (0–1). Pure. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bez = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < t) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

const easeOut = (t: number) => cubicBezier(0, 0, 0.58, 1, t);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The disc of a touch at `t` (null: not shown). Pure. */
function dotAt(touch: Touch, t: number): DotMark | null {
  const L = TOUCH_LOOK;
  const start = touch.t_down - TOUCH_LEAD_S;
  const end = touch.t_up + TOUCH_LIFT_S;
  if (t < start || t >= end) return null;
  const appear = easeOut(clamp01((t - start) / L.appearS));
  let opacity = appear;
  let scale = L.appearScale + (1 - L.appearScale) * appear;
  if (t >= touch.t_down && t < touch.t_up) scale *= 1 + (L.pressScale - 1) * easeOut(clamp01((t - touch.t_down) / L.pressS));
  if (t >= touch.t_up) {
    const pressed = 1 + (L.pressScale - 1) * easeOut(clamp01((touch.t_up - touch.t_down) / L.pressS));
    scale *= pressed + (1 - pressed) * easeOut(clamp01((t - touch.t_up) / L.pressS));
    opacity *= 1 - easeOut(clamp01((t - touch.t_up) / TOUCH_LIFT_S));
  }
  const p = touchPoint(touch, t);
  return { kind: 'dot', x: p.x, y: p.y, opacity, scale };
}

/** The ripple of a touch at `t` (null: not playing). Pure. */
function rippleAt(touch: Touch, t: number): RippleMark | null {
  const R = TOUCH_LOOK.ripple;
  const k = t - touch.t_down;
  if (k < 0 || k >= R.fadeS) return null;
  const grow = cubicBezier(0.2, 0.7, 0.2, 1, clamp01(k / R.scaleS));
  const scale = R.from + (R.to - R.from) * grow;
  const p = touch.path[0];
  return { kind: 'ripple', x: p.x, y: p.y, radius: (R.diameter / 2) * scale, opacity: 1 - easeOut(clamp01(k / R.fadeS)) };
}

/** Everything drawn at capture time `t`: the ripples under the discs. Pure. */
export function touchMarks(touches: readonly Touch[], t: number): TouchMark[] {
  const ripples: TouchMark[] = [];
  const dots: TouchMark[] = [];
  for (const touch of touches) {
    const r = rippleAt(touch, t);
    if (r && r.opacity > 0.002) ripples.push(r);
    const d = dotAt(touch, t);
    if (d && d.opacity > 0.002) dots.push(d);
  }
  return [...ripples, ...dots];
}

/** A key of what the marks draw (equal keys: the same picture). Pure. */
export function marksKey(marks: readonly TouchMark[]): string {
  return marks
    .map((m) =>
      m.kind === 'dot'
        ? `d${m.x.toFixed(1)},${m.y.toFixed(1)},${Math.round(m.opacity * 255)},${m.scale.toFixed(3)}`
        : `r${m.x.toFixed(1)},${m.y.toFixed(1)},${Math.round(m.opacity * 255)},${m.radius.toFixed(2)}`,
    )
    .join(';');
}

/** A CSS colour (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`) as RGBA, or null. Pure. */
export function parseColor(text: string | undefined): Rgba | null {
  if (!text) return null;
  const s = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (!fn) return null;
  return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] !== undefined ? Number(fn[4]) : 1];
}
