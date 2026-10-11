import { seededRandom } from '@demo-studio/core';
import type { Pacing, PointSpec } from '@demo-studio/core';
import { clamp } from './util.js';

export function easeInOutCubic(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

export function distance(a: PointSpec, b: PointSpec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Below this distance a move is a "nudge": short duration and short hover (repeated clicks on one spot). */
export const NUDGE_PX = 60;
export const NUDGE_MS = 250;
export const NUDGE_HOVER_MS = 120;

/** Cursor travel duration: clamp(base + d·per_px, min, max); nudges are short, zero-length moves take no time. */
export function moveDuration(dist: number, pacing: Pacing): number {
  if (dist < 1) return 0;
  if (dist < NUDGE_PX) return Math.round(NUDGE_MS * Math.max(0.5, dist / NUDGE_PX));
  return Math.round(clamp(pacing.move_base_ms + dist * pacing.move_ms_per_px, pacing.move_min_ms, pacing.move_max_ms));
}

/**
 * Slightly arced path from a to b: perpendicular offset min(60, 0.08·d)·sin(π·e), on the side `side` (±1).
 * `e` is the eased progress in [0, 1]; e = 1 lands exactly on b.
 */
export function arcPath(a: PointSpec, b: PointSpec, side: 1 | -1): (e: number) => PointSpec {
  const d = distance(a, b);
  const amp = Math.min(60, 0.08 * d) * side;
  const nx = d > 0 ? -(b.y - a.y) / d : 0;
  const ny = d > 0 ? (b.x - a.x) / d : 0;
  return (e: number) => {
    if (e >= 1) return { x: b.x, y: b.y };
    const off = amp * Math.sin(Math.PI * e);
    return { x: a.x + (b.x - a.x) * e + nx * off, y: a.y + (b.y - a.y) * e + ny * off };
  };
}

/** Deterministic jitter source for one step (seeded by scenario/scene/step). */
export class Jitter {
  private readonly rnd: () => number;
  constructor(
    seed: string,
    private readonly amount: number,
  ) {
    this.rnd = seededRandom(seed);
  }
  /** Next value in [0, 1). */
  next(): number {
    return this.rnd();
  }
  /** ms × (1 ± amount), deterministic. */
  ms(ms: number, amount = this.amount): number {
    if (ms <= 0) return 0;
    return Math.round(ms * (1 + (this.rnd() * 2 - 1) * amount));
  }
  side(): 1 | -1 {
    return this.rnd() < 0.5 ? -1 : 1;
  }
}

/** Round a coordinate to the device pixel grid (1/scale CSS px). */
export function snap(v: number, scale: number): number {
  const s = Math.max(1, Math.round(scale));
  return Math.round(v * s) / s;
}
