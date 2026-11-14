import { seededRandom } from '@retake/core/base';
import type { Pacing, PointSpec } from '@retake/core/model';
import { clamp } from './util.js';

export function easeInOutCubic(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

export function distance(a: PointSpec, b: PointSpec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Default nudge threshold (pacing.nudge_px): below it a move is a "nudge" (repeated clicks on one spot). */
export const NUDGE_PX = 60;
/** Default nudge travel time (pacing.nudge_ms). */
export const NUDGE_MS = 250;
/** Shortest nudge, as a fraction of nudge_ms: 0.6 × 250 ms = 150 ms. */
const NUDGE_MIN_FRACTION = 0.6;

type MotionPacing = Pick<Pacing, 'move_base_ms' | 'move_ms_per_px' | 'move_min_ms' | 'move_max_ms'> & Partial<Pick<Pacing, 'nudge_px' | 'nudge_ms'>>;

/** Whether a move of `dist` px is a nudge. */
export function isNudge(dist: number, pacing: Partial<Pick<Pacing, 'nudge_px'>>): boolean {
  return dist < (pacing.nudge_px ?? NUDGE_PX);
}

/**
 * Cursor travel duration. Ordinary moves: clamp(move_base_ms + d·move_ms_per_px, move_min_ms, move_max_ms) — the
 * field-tested clamp(0.9·d, 450, 1100) with the defaults. Nudges (d < nudge_px, e.g. repeated clicks on almost the
 * same spot) take 60–100 % of nudge_ms (≈150–250 ms); a zero-length move takes 0 ms (never a 450 ms move to nowhere).
 */
export function moveDuration(dist: number, pacing: MotionPacing): number {
  if (dist < 1) return 0;
  const nudgePx = pacing.nudge_px ?? NUDGE_PX;
  if (dist < nudgePx) return Math.round((pacing.nudge_ms ?? NUDGE_MS) * Math.max(NUDGE_MIN_FRACTION, dist / nudgePx));
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
