/** Small pure helpers of the planner (no I/O, no clocks, no randomness). */
import type { Timeline, TimelineEvent } from '@retake/core';

/** Round to `d` decimals (stable JSON, no float noise like 0.30000000000000004). */
export function round(x: number, d = 3): number {
  const k = 10 ** d;
  const r = Math.round(x * k) / k;
  return Object.is(r, -0) ? 0 : r;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Seconds, for messages ("2.31 s"). */
export function secs(x: number): string {
  return `${x.toFixed(2)} s`;
}

/** Half-open interval [a, b). */
export interface Interval {
  a: number;
  b: number;
}

/** Sort and merge overlapping or touching intervals; empty ones are dropped. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.b > i.a).sort((x, y) => x.a - y.a || x.b - y.b);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.a <= last.b) last.b = Math.max(last.b, i.b);
    else out.push({ a: i.a, b: i.b });
  }
  return out;
}

/** `i` minus every interval of `holes` (merged), as a list of pieces. */
export function subtractIntervals(i: Interval, holes: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [{ a: i.a, b: i.b }];
  for (const h of mergeIntervals(holes)) {
    const next: Interval[] = [];
    for (const p of pieces) {
      if (h.b <= p.a || h.a >= p.b) {
        next.push(p);
        continue;
      }
      if (h.a > p.a) next.push({ a: p.a, b: h.a });
      if (h.b < p.b) next.push({ a: h.b, b: p.b });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.b > p.a);
}

export function intersect(x: Interval, y: Interval): Interval | null {
  const a = Math.max(x.a, y.a);
  const b = Math.min(x.b, y.b);
  return b > a ? { a, b } : null;
}

/** End of a step including its hold. */
export function stepEnd(e: TimelineEvent): number {
  return Math.max(e.t_end, e.hold?.t_end ?? e.t_end);
}

/** Cursor position at capture time `t` (linear between samples; the first/last sample outside the track). */
export function cursorAt(cursor: Timeline['cursor'], t: number, interpolate = true): { x: number; y: number; visible: boolean } | null {
  if (cursor.length === 0) return null;
  let lo = 0;
  let hi = cursor.length - 1;
  if (t <= cursor[0].t) return { x: cursor[0].x, y: cursor[0].y, visible: cursor[0].visible };
  if (t >= cursor[hi].t) return { x: cursor[hi].x, y: cursor[hi].y, visible: cursor[hi].visible };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cursor[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const s0 = cursor[lo];
  const s1 = cursor[hi];
  if (!interpolate || s1.t <= s0.t) return { x: s0.x, y: s0.y, visible: s0.visible };
  const k = (t - s0.t) / (s1.t - s0.t);
  return { x: s0.x + (s1.x - s0.x) * k, y: s0.y + (s1.y - s0.y) * k, visible: s0.visible };
}

/** Ordered set of unique strings (warnings and notes are reported once). */
export class MessageList {
  private readonly seen = new Set<string>();
  readonly items: string[] = [];
  add(message: string): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.items.push(message);
  }
}

/** First line of an error message (registry errors list alternatives on the following lines). */
export function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0].trim();
}
