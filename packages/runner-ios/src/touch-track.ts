/**
 * The touches of a take: each tap and swipe the steps made (its driver times, its point in screen points), their
 * touch-down read from the video after the take, and what they give the timeline — the touch samples and effects
 * (`cursor`, `cursor_effects`: press, ripple, release) and each event's `t_click`.
 *
 * Touch-down: XCUITest's tap reaches the app 100–270 ms after the call (its own idle and interruption waits), too
 * unsteady for a constant. The video says it: the first frame after t_act + 40 ms whose box (≈ 44 pt) around the
 * touch point differs from the last frame at or before t_act (mean absolute grey difference over 3/255, on a 1/6-scale
 * decode), searched up to min(t_end + 100 ms, t_act + 600 ms). When nothing changes there (a stepper's button changes a label
 * elsewhere), the first new frame anywhere after t_act + 40 ms bounds it — a touch cannot change the screen before it
 * lands — unless the screen was already moving before t_act; the touch-down is then the earlier of that frame and
 * t_act + 130 ms (the measured median). A box already changing before t_act (a caret, a spinner): t_act + 130 ms.
 * A tap lifts 75 ms later.
 */
import type { TimelineEvent } from '@retake/core/run';
import type { TimelineBuilder } from '@retake/runner-web/types';

/** The touch-down search (seconds, grey levels of 255). */
export const TOUCH_DETECT = {
  /** Frames before t_act + this are the touch's own lead (the call's start). */
  minDelay: 0.04,
  maxDelay: 0.6,
  /** The search goes on this long past the call's return (the screen can show the touch just after it). */
  endSlack: 0.1,
  /** Mean absolute grey difference that counts as a change. */
  threshold: 3,
  /** How far back a frame tells "already changing". */
  before: 0.3,
  /** The box around the touch point, in points. */
  boxPt: 44,
  /** Pixels per point of the decode (1/6 of 3×: half a point per pixel). */
  decodeScale: 0.5,
  /** The touch-down when the video says nothing: t_act + this (the measured median). */
  fallback: 0.13,
} as const;

/** How long a tap's finger stays down. */
export const TAP_HOLD_S = 0.075;
/** The touch dot shows this long before the touch-down. */
export const TOUCH_LEAD_S = 0.15;
/** The dot fades this long after the lift. */
export const TOUCH_LIFT_S = 0.18;
/** Samples of a swipe's path per second. */
const SWIPE_RATE = 60;

/** A touch the steps made, as the driver timed it (capture time, s) and placed it (points). */
export interface TouchRecord {
  kind: 'tap' | 'swipe';
  /** Capture time right before the touch was sent. */
  t_act: number;
  /** Capture time the driver's call returned. */
  t_end: number;
  x: number;
  y: number;
  /** A swipe's end point, drag time and hold at the end (s). */
  to?: { x: number; y: number };
  press_s?: number;
  drag_s?: number;
  /** A tap held down this long (s): a press. */
  hold_s?: number;
  /** The step's event (its t_click is the touch-down). */
  event?: TimelineEvent;
}

/** A touch with its touch-down settled: what the timeline and the overlay draw. */
export interface Touch {
  t_down: number;
  t_up: number;
  /** Where the finger is while down: one point for a tap, the path of a swipe. */
  path: Array<{ t: number; x: number; y: number }>;
  how: TouchDownHow;
  why?: string;
}

/** How a touch-down was timed: the box around it changed, the screen changed elsewhere, or the measured constant. */
export type TouchDownHow = 'video' | 'screen' | 'fallback';

/** A frame of the box around a touch point: its time and grey pixels (same size for every frame of a touch). */
export interface CropFrame {
  t: number;
  pixels: Uint8Array;
}

/** Mean absolute difference of two grey crops (Infinity when their sizes differ). Pure. */
export function cropDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** The touch-down of a touch sent at `tAct` (the call returned at `tEnd`), from the crops around its point. Pure. */
export function touchDownFrom(frames: readonly CropFrame[], tAct: number, tEnd: number, o: typeof TOUCH_DETECT = TOUCH_DETECT): { t: number; how: TouchDownHow; why?: string } {
  const fallback = (why: string) => ({ t: tAct + o.fallback, how: 'fallback' as const, why });
  const ts = [...frames].sort((a, b) => a.t - b.t);
  let ref = -1;
  for (let i = 0; i < ts.length; i++) if (ts[i].t <= tAct) ref = i;
  if (ref < 0) return fallback('no frame before the touch');
  const prev = ref > 0 && ts[ref - 1].t >= tAct - o.before ? ts[ref - 1] : null;
  if (prev && cropDiff(prev.pixels, ts[ref].pixels) > o.threshold) return fallback('the screen there was already changing');
  const until = Math.min(tEnd + o.endSlack, tAct + o.maxDelay);
  for (let i = ref + 1; i < ts.length; i++) {
    const f = ts[i];
    if (f.t > until) break;
    if (f.t < tAct + o.minDelay) continue;
    if (cropDiff(ts[ref].pixels, f.pixels) > o.threshold) return { t: f.t, how: 'video' };
  }
  // Nothing changed around the point: a new frame elsewhere, before the constant, bounds the touch-down (a still
  // screen before the touch only: one that was moving says nothing of the touch).
  const still = ts[ref].t <= tAct - o.before;
  const first = ts.find((f) => f.t >= tAct + o.minDelay && f.t < tAct + o.fallback);
  if (still && first) return { t: first.t, how: 'screen' };
  return fallback('no change on screen there');
}

/** The window of video a touch's search reads: from the frame before its reference to the end of the search. Pure. */
export function searchWindow(frameTimes: readonly number[], tAct: number, tEnd: number, o: typeof TOUCH_DETECT = TOUCH_DETECT): { from: number; to: number } | null {
  let ref = -1;
  for (let i = 0; i < frameTimes.length; i++) if (frameTimes[i] <= tAct) ref = i;
  if (ref < 0) return null;
  const prev = ref > 0 && frameTimes[ref - 1] >= tAct - o.before ? frameTimes[ref - 1] : frameTimes[ref];
  return { from: prev, to: Math.min(tEnd + o.endSlack, tAct + o.maxDelay) };
}

/** A touch's path and lift, from its record and its touch-down. Pure. */
export function settleTouch(r: TouchRecord, down: { t: number; how: TouchDownHow; why?: string }): Touch {
  const t_down = round3(down.t);
  if (r.kind === 'tap' || !r.to) {
    const t_up = round3(t_down + (r.hold_s ?? TAP_HOLD_S));
    return { t_down, t_up, path: [{ t: t_down, x: r.x, y: r.y }], how: down.how, ...(down.why ? { why: down.why } : {}) };
  }
  const press = r.press_s ?? 0.05;
  const drag = Math.max(0.05, r.drag_s ?? 0.3);
  const path: Touch['path'] = [{ t: t_down, x: r.x, y: r.y }];
  const steps = Math.max(1, Math.round(drag * SWIPE_RATE));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    // XCUITest drags at a constant velocity.
    path.push({ t: round3(t_down + press + drag * k), x: round1(r.x + (r.to.x - r.x) * k), y: round1(r.y + (r.to.y - r.y) * k) });
  }
  const t_up = round3(t_down + press + drag + (r.hold_s ?? 0));
  path.push({ t: t_up, x: r.to.x, y: r.to.y });
  return { t_down, t_up, path, how: down.how, ...(down.why ? { why: down.why } : {}) };
}

/** Where a touch's finger is at `t` (its path, held at its ends). Pure. */
export function touchPoint(touch: Touch, t: number): { x: number; y: number } {
  const p = touch.path;
  if (t <= p[0].t || p.length === 1) return { x: p[0].x, y: p[0].y };
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i].t) {
      const a = p[i - 1];
      const b = p[i];
      const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  const last = p[p.length - 1];
  return { x: last.x, y: last.y };
}

/**
 * The touches written to the timeline: hidden from capture time 0 (where the first touch lands), then each one's
 * samples (shown before the touch-down, down, up, hidden after the lift) — all in time order, never before 0, however
 * close two touches come —, their effects (press and ripple at the touch-down, release at the lift) and each event's
 * `t_click`.
 */
export function writeTouches(timeline: Pick<TimelineBuilder, 'sampleCursor' | 'cursorEffect'>, touches: ReadonlyArray<{ touch: Touch; record: TouchRecord }>): void {
  const sorted = [...touches].sort((a, b) => a.touch.t_down - b.touch.t_down);
  if (!sorted.length) return;
  type Sample = Parameters<TimelineBuilder['sampleCursor']>[0] & { t: number };
  const start = sorted[0].touch.path[0];
  const samples: Sample[] = [{ t: 0, x: start.x, y: start.y, visible: false }];
  for (const { touch, record } of sorted) {
    const first = touch.path[0];
    const last = touch.path[touch.path.length - 1];
    samples.push({ t: round3(touch.t_down - TOUCH_LEAD_S), x: first.x, y: first.y, visible: true });
    for (const p of touch.path) samples.push({ t: p.t, x: p.x, y: p.y, visible: true, down: true });
    samples.push({ t: touch.t_up, x: last.x, y: last.y, visible: true });
    samples.push({ t: round3(touch.t_up + TOUCH_LIFT_S), x: last.x, y: last.y, visible: false });
    if (record.event && record.kind === 'tap') record.event.t_click = touch.t_down;
  }
  // Stable: the samples of one time keep their order (the hidden start before a touch at 0).
  const ordered = samples.map((s, i) => ({ s: { ...s, t: Math.max(0, s.t) }, i })).sort((a, b) => a.s.t - b.s.t || a.i - b.i);
  for (const { s } of ordered) timeline.sampleCursor(s);
  const effects: Array<Parameters<TimelineBuilder['cursorEffect']>[0]> = [];
  for (const { touch } of sorted) {
    const first = touch.path[0];
    effects.push({ t: touch.t_down, type: 'press' }, { t: touch.t_down, type: 'ripple', x: first.x, y: first.y }, { t: touch.t_up, type: 'release' });
  }
  for (const { e } of effects.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i)) timeline.cursorEffect(e);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
