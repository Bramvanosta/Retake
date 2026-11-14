/**
 * Easing curves (pure, deterministic). Every curve maps [0, 1] → [0, 1] (bezier curves may overshoot in between).
 */
import type { ThemeTokens } from '../types.js';

export type EasingFn = (t: number) => number;
export type Bezier = readonly [number, number, number, number];

const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/** CSS-style cubic-bezier(x1, y1, x2, y2) as a function of progress (Newton–Raphson, bisection fallback). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  if (x1 === y1 && x2 === y2) return (t) => clamp01(t);
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const solve = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-7) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 60; i++) {
      const v = sampleX(s);
      if (Math.abs(v - x) < 1e-7) return s;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solve(t));
  };
}

/** Named curves (cubic-bezier control points). */
export const EASING_CURVES = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  /** Material "standard": most UI motion. */
  standard: [0.4, 0, 0.2, 1],
  /** Fast start, long soft landing: entrances (titles, cards). */
  entrance: [0.16, 1, 0.3, 1],
  /** Slow start, fast end: exits. */
  exit: [0.7, 0, 0.84, 0],
  /** Gentle, symmetric: crossfades and slow camera moves. */
  gentle: [0.45, 0, 0.2, 1],
} as const satisfies Record<string, Bezier>;

export type EasingName = keyof typeof EASING_CURVES;

/** Ready-made easing functions for every named curve. */
export const EASINGS: Readonly<Record<EasingName, EasingFn>> = Object.fromEntries(Object.entries(EASING_CURVES).map(([k, v]) => [k, cubicBezier(...(v as Bezier))])) as Record<EasingName, EasingFn>;

/** The scenario camera presets (slow / normal / fast / linear), mapped to curves. */
export const CAMERA_EASINGS: Readonly<Record<'slow' | 'normal' | 'fast' | 'linear', Bezier>> = {
  slow: [0.45, 0, 0.2, 1],
  normal: [0.4, 0, 0.2, 1],
  fast: [0.2, 0, 0, 1],
  linear: [0, 0, 1, 1],
};

export type EasingSpec = EasingName | Bezier | EasingFn;

/** An easing function from a name, control points or a function. */
export function easing(spec: EasingSpec = 'standard'): EasingFn {
  if (typeof spec === 'function') return spec;
  if (typeof spec === 'string') {
    const fn = EASINGS[spec];
    if (!fn) throw new Error(`unknown easing "${spec}" (known: ${Object.keys(EASINGS).join(', ')})`);
    return fn;
  }
  return cubicBezier(spec[0], spec[1], spec[2], spec[3]);
}

/** Default template zoom easing (DEFAULT_TEMPLATE.motion.zoom_ease). */
export const DEFAULT_ZOOM_EASE: Bezier = [0.45, 0, 0.2, 1];

/** The theme's motion curve (template `motion.zoom_ease`), for camera-like moves that should feel like the brand. */
export function themeEasing(theme: Pick<ThemeTokens, 'motion'>): EasingFn {
  const [a, b, c, d] = theme.motion?.zoom_ease ?? DEFAULT_ZOOM_EASE;
  return cubicBezier(a, b, c, d);
}
