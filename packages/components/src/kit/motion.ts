/**
 * Frame-driven animation helpers (pure, deterministic): everything is computed from the current frame and fps, in
 * seconds, so a component renders every frame the same way. Distances are design px: pass `unit`.
 */
import { easing } from './easing.js';
import type { EasingSpec } from './easing.js';

export function clamp(v: number, min = 0, max = 1): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Seconds → frames (rounded). */
export function toFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/** Frame → seconds. */
export function toSeconds(frame: number, fps: number): number {
  return frame / fps;
}

export interface TweenOptions {
  /** Seconds before the animation starts (default 0). */
  delay?: number;
  /** Seconds (default 0.5). */
  duration?: number;
  /** Default 'standard'. */
  ease?: EasingSpec;
}

/** Eased progress 0 → 1 of an animation that starts after `delay` seconds and lasts `duration` seconds. */
export function progress(frame: number, fps: number, opts: TweenOptions = {}): number {
  const { delay = 0, duration = 0.5, ease = 'standard' } = opts;
  // Rounded so that float noise (2.5 - 2.2 = 0.2999…) never leaves 1e-16 opacities behind.
  const t = roundTo(frame / fps - delay, 9);
  if (duration <= 0) return t >= 0 ? 1 : 0;
  return roundTo(easing(ease)(clamp(roundTo(t / duration, 9))), 6);
}

/** `v` rounded to `decimals` decimals (CSS-friendly numbers). */
export function roundTo(v: number, decimals = 2): number {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
}

/** Opacity of a fade in (0 → 1). */
export function fadeIn(frame: number, fps: number, opts: TweenOptions = {}): number {
  return progress(frame, fps, { duration: 0.4, ...opts });
}

/** Opacity of a fade out (1 → 0) that ENDS at `durationInFrames` (the end of the component). */
export function fadeOut(frame: number, fps: number, durationInFrames: number, opts: Omit<TweenOptions, 'delay'> = {}): number {
  const duration = opts.duration ?? 0.4;
  const start = durationInFrames / fps - duration;
  return 1 - progress(frame, fps, { ease: 'easeIn', ...opts, duration, delay: start });
}

/** Opacity of something that fades in at the start and out at the end of the component. */
export function fade(frame: number, fps: number, durationInFrames: number, opts: { in?: TweenOptions; out?: Omit<TweenOptions, 'delay'> | false } = {}): number {
  const a = fadeIn(frame, fps, opts.in);
  const b = opts.out === false ? 1 : fadeOut(frame, fps, durationInFrames, opts.out);
  return Math.min(a, b);
}

export interface RiseOptions extends TweenOptions {
  /** Design px travelled upwards (default 24). */
  distance?: number;
  /** props.unit (default 1). */
  unit?: number;
}

/** Style of an element that rises into place while fading in: `{opacity, transform}`. */
export function rise(frame: number, fps: number, opts: RiseOptions = {}): { opacity: number; transform: string } {
  const { distance = 24, unit = 1, ...tween } = opts;
  const p = progress(frame, fps, { duration: 0.7, ease: 'entrance', ...tween });
  const y = (1 - p) * distance * unit;
  return { opacity: roundTo(clamp(p * 1.25), 6), transform: `translateY(${roundTo(y)}px)` };
}

/** Delay (seconds) of the i-th item of a staggered entrance. */
export function stagger(index: number, opts: { start?: number; step?: number } = {}): number {
  const { start = 0, step = 0.08 } = opts;
  return start + Math.max(0, index) * step;
}

/** Index of the cue active at `frame` (cues are [from, to) frames, sorted), or -1. */
export function activeIndex<T extends { from: number; to: number }>(cues: readonly T[], frame: number): number {
  for (let i = 0; i < cues.length; i++) if (frame >= cues[i].from && frame < cues[i].to) return i;
  return -1;
}

/**
 * How much motion a theme wants (template `style_bias`), for components to scale their entrances by:
 * `real` = the subtle reference motion (factor 1, no scale, no tracking change); `balanced` and `motion` add a little
 * travel, a small scale settle and a tracking settle on display text — slightly richer, never gimmicky.
 */
export interface BiasMotion {
  /** Multiplier of rise distances. */
  travel: number;
  /** Scale an element settles from (1 − settle → 1); 0 = no scale. */
  settle: number;
  /** em of extra letter-spacing display text settles from (→ its final tracking); 0 = none. */
  tracking: number;
  /** Multiplier of entrance durations (> 1 = slower, softer). */
  pace: number;
}

export function biasMotion(bias: 'real' | 'balanced' | 'motion' | undefined): BiasMotion {
  if (bias === 'motion') return { travel: 2, settle: 0.04, tracking: 0.03, pace: 1.1 };
  if (bias === 'balanced') return { travel: 1.5, settle: 0.02, tracking: 0.015, pace: 1.05 };
  return { travel: 1, settle: 0, tracking: 0, pace: 1 };
}
