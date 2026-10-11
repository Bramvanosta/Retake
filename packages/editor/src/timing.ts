/**
 * Time mapping of a "run": one clip, or several clips contiguous in the capture on the same page (joined without a
 * transition). The run is planned as ONE continuous piece of footage so that speeds, ramps, trims and the camera
 * continue across the joins, then split back into clips.
 *
 * Units: source positions `p` are capture frames (float; frame n of the CFR capture shows capture time n / fps),
 * output positions `q` are output frames (float). Speeds `v` are playback speeds (×); `u`/`w` are the slopes
 * dp/dq = v · srcFps / outFps at the start / end of a map piece (linear in q on a ramp, constant otherwise).
 */
import type { TimelineEvent } from '@demo-studio/core';
import type { Interval } from './util.js';
import { intersect, mergeIntervals, stepEnd, subtractIntervals } from './util.js';

/** Seconds around a marked step (and through its hold end) always played at 1×. */
export const MARK_WINDOW_S = 0.6;
/** Output seconds over which a speed change is ramped. */
export const SPEED_RAMP_S = 0.3;
/** Idle gaps (outside protected spans) longer than this are shortened (seconds). */
export const DEFAULT_IDLE_THRESHOLD_S = 1.2;
/** What is left of a shortened idle gap (seconds of capture: half before the cut, half after). */
export const IDLE_KEEP_S = 0.4;

const EPS = 1e-6;

export interface RunClipInput {
  scene: string;
  /** Source frames [A, B) of the clip (integers). */
  A: number;
  B: number;
  /** Scene speed (overrides.speeds wins over the scenario's), > 0. */
  baseSpeed: number;
  /** The scene's timeline events (scene_open / scene_still / steps). */
  events: TimelineEvent[];
}

export interface RunTimingInput {
  clips: RunClipInput[];
  srcFps: number;
  outFps: number;
  /** timeline.idle (capture seconds). */
  idle: ReadonlyArray<{ t_start: number; t_end: number }>;
  trimIdle: boolean;
  idleThresholdS: number;
}

/** Why a span is played at 1× whatever the speeds. */
export type ProtectReason = 'still' | 'hold' | 'mark';

export interface ProtectedSpan extends Interval {
  reason: ProtectReason;
  scene: string;
  step: number;
}

/** A piece of the output → source map. */
export interface MapPiece {
  /** Source frames [p0, p1). */
  p0: number;
  p1: number;
  /** Output frames [q0, q1) of the run (q0 === q1 for a cut). */
  q0: number;
  q1: number;
  /** dp/dq at q0 and q1. */
  u: number;
  w: number;
  /** Index of the clip in the run. */
  clip: number;
  /** Target speed (×) of the piece it belongs to; ramps carry the speeds they join in `u`/`w`. */
  v: number;
  protected: boolean;
  cut: boolean;
  ramp: boolean;
}

export interface RunCut extends Interval {
  clip: number;
  /** The idle piece (outside protected spans) the cut was taken from. */
  idle: Interval;
  /** First output frame (run) after the cut. */
  at: number;
}

export interface RunTiming {
  srcFps: number;
  outFps: number;
  pieces: MapPiece[];
  /** Output length of the run in frames (float). */
  length: number;
  /** Source position of every output frame (float, frames). */
  p: number[];
  /** Source frame index of every output frame. */
  src: number[];
  /** Output frames [k0, k1) of each clip. */
  clipRanges: Array<{ k0: number; k1: number }>;
  cuts: RunCut[];
  protectedSpans: ProtectedSpan[];
}

/** Spans played at 1× whatever the speeds: the opening still, holds (action and modifier), marked step windows. */
export function protectedSpans(clips: readonly RunClipInput[], fps: number): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  for (const c of clips) {
    for (const e of c.events) {
      if (e.action === 'scene_still' && e.t_end > e.t_start) out.push({ a: e.t_start * fps, b: e.t_end * fps, reason: 'still', scene: c.scene, step: e.step });
      if (e.hold && e.hold.t_end > e.hold.t_start) out.push({ a: e.hold.t_start * fps, b: e.hold.t_end * fps, reason: 'hold', scene: c.scene, step: e.step });
      else if (e.action === 'hold' && e.t_end > e.t_start) out.push({ a: e.t_start * fps, b: e.t_end * fps, reason: 'hold', scene: c.scene, step: e.step });
      if (e.mark) out.push({ a: (e.t_start - MARK_WINDOW_S) * fps, b: (stepEnd(e) + MARK_WINDOW_S) * fps, reason: 'mark', scene: c.scene, step: e.step });
    }
  }
  const run = { a: clips[0].A, b: clips[clips.length - 1].B };
  return out
    .map((s) => {
      const x = intersect(s, run);
      return x ? { ...s, a: x.a, b: x.b } : null;
    })
    .filter((s): s is ProtectedSpan => s !== null)
    .sort((x, y) => x.a - y.a || x.b - y.b);
}

interface Elementary extends Interval {
  clip: number;
  v: number;
  protected: boolean;
  cut: boolean;
  rampIn?: { R: number; v: number };
  rampOut?: { R: number; v: number };
}

function containing<T extends Interval>(list: readonly T[], x: number): T | undefined {
  return list.find((i) => i.a <= x && x < i.b);
}

/** Plan the time map of a run (see the module comment). Pure. */
export function planRunTiming(input: RunTimingInput): RunTiming {
  const { clips, srcFps, outFps } = input;
  const r = srcFps / outFps;
  const P0 = clips[0].A;
  const P1 = clips[clips.length - 1].B;

  const prot = protectedSpans(clips, srcFps);
  const protMerged = mergeIntervals(prot);

  // Step speeds (a step's own span, before its hold).
  const stepSpeeds: Array<Interval & { v: number }> = [];
  for (const c of clips) {
    for (const e of c.events) {
      if (e.step >= 0 && typeof e.speed === 'number' && e.speed > 0 && e.t_end > e.t_start) {
        const x = intersect({ a: e.t_start * srcFps, b: e.t_end * srcFps }, { a: c.A, b: c.B });
        if (x) stepSpeeds.push({ ...x, v: e.speed });
      }
    }
  }

  // Idle trims: the part of an idle interval outside protected spans, when longer than the threshold.
  const cuts: Array<Interval & { clip: number; idle: Interval }> = [];
  if (input.trimIdle) {
    const minLen = input.idleThresholdS * srcFps;
    const keepHalf = (IDLE_KEEP_S / 2) * srcFps;
    for (const gap of input.idle) {
      const g = { a: gap.t_start * srcFps, b: gap.t_end * srcFps };
      clips.forEach((c, ci) => {
        const x = intersect(g, { a: c.A, b: c.B });
        if (!x) return;
        for (const piece of subtractIntervals(x, protMerged)) {
          if (piece.b - piece.a > minLen + EPS) cuts.push({ a: piece.a + keepHalf, b: piece.b - keepHalf, clip: ci, idle: piece });
        }
      });
    }
    cuts.sort((x, y) => x.a - y.a);
  }

  // Elementary pieces between every boundary.
  const bounds = new Set<number>([P0, P1]);
  for (const c of clips) {
    bounds.add(c.A);
    bounds.add(c.B);
  }
  for (const i of [...protMerged, ...stepSpeeds, ...cuts]) {
    bounds.add(i.a);
    bounds.add(i.b);
  }
  const sorted = [...bounds].filter((x) => x >= P0 && x <= P1).sort((x, y) => x - y);
  const pieces: Elementary[] = [];
  for (let n = 0; n + 1 < sorted.length; n++) {
    const a = sorted[n];
    const b = sorted[n + 1];
    if (b - a < 1e-9) continue;
    const mid = (a + b) / 2;
    const clip = clips.findIndex((c) => c.A <= mid && mid < c.B);
    if (clip < 0) continue;
    const isProt = containing(protMerged, mid) !== undefined;
    const cut = containing(cuts, mid) !== undefined;
    const v = isProt ? 1 : (containing(stepSpeeds, mid)?.v ?? clips[clip].baseSpeed);
    const last = pieces[pieces.length - 1];
    if (last && last.clip === clip && last.v === v && last.protected === isProt && last.cut === cut && Math.abs(last.b - a) < 1e-9) {
      last.b = b;
    } else {
      pieces.push({ a, b, clip, v, protected: isProt, cut });
    }
  }

  // Slivers (unprotected pieces shorter than one source frame, e.g. the millisecond between a final hold and the
  // scene end) take the speed of the piece before them: no ramp for nothing.
  for (let n = 0; n < pieces.length; n++) {
    const x = pieces[n];
    if (x.cut || x.protected || x.b - x.a >= 1) continue;
    const before = pieces.slice(0, n).reverse().find((y) => !y.cut);
    const after = pieces.slice(n + 1).find((y) => !y.cut);
    const ref = before ?? after;
    if (ref) x.v = ref.v;
  }
  const sliver = (x: Elementary) => !x.cut && x.b - x.a < 1;
  for (let n = pieces.length - 1; n > 0; n--) {
    const x = pieces[n - 1];
    const y = pieces[n];
    if (x.clip !== y.clip || x.v !== y.v || x.cut !== y.cut) continue;
    if (x.protected !== y.protected && !sliver(x) && !sliver(y)) continue;
    // The merged piece keeps the flag of its substantial part.
    const isProt = sliver(x) ? y.protected : x.protected;
    pieces.splice(n - 1, 2, { a: x.a, b: y.b, clip: x.clip, v: x.v, protected: isProt, cut: x.cut });
  }

  // Ramps between kept pieces of different speeds: inside the unprotected side (the faster one when both are free).
  const R = SPEED_RAMP_S * outFps;
  const kept = pieces.filter((p) => !p.cut);
  for (let n = 0; n + 1 < kept.length; n++) {
    const x = kept[n];
    const y = kept[n + 1];
    if (Math.abs(x.v - y.v) < 1e-9) continue;
    const hostIsX = y.protected ? true : x.protected ? false : x.v > y.v;
    if (hostIsX) x.rampOut = { R, v: y.v };
    else y.rampIn = { R, v: x.v };
  }

  // Map pieces.
  const map: MapPiece[] = [];
  let q = 0;
  for (const piece of pieces) {
    const len = piece.b - piece.a;
    if (piece.cut) {
      map.push({ p0: piece.a, p1: piece.b, q0: q, q1: q, u: 0, w: 0, clip: piece.clip, v: piece.v, protected: false, cut: true, ramp: false });
      continue;
    }
    let rIn = piece.rampIn?.R ?? 0;
    let rOut = piece.rampOut?.R ?? 0;
    let dIn = piece.rampIn ? rIn * r * ((piece.rampIn.v + piece.v) / 2) : 0;
    let dOut = piece.rampOut ? rOut * r * ((piece.rampOut.v + piece.v) / 2) : 0;
    if (dIn + dOut > len) {
      const s = len / (dIn + dOut);
      rIn *= s;
      rOut *= s;
      dIn *= s;
      dOut *= s;
    }
    let pos = piece.a;
    const base = { clip: piece.clip, v: piece.v, protected: piece.protected, cut: false };
    if (piece.rampIn && rIn > 1e-9) {
      map.push({ ...base, p0: pos, p1: pos + dIn, q0: q, q1: q + rIn, u: piece.rampIn.v * r, w: piece.v * r, ramp: true });
      pos += dIn;
      q += rIn;
    }
    const mid = len - dIn - dOut;
    if (mid > 1e-9) {
      const dq = mid / (piece.v * r);
      map.push({ ...base, p0: pos, p1: pos + mid, q0: q, q1: q + dq, u: piece.v * r, w: piece.v * r, ramp: false });
      pos += mid;
      q += dq;
    }
    if (piece.rampOut && rOut > 1e-9) {
      map.push({ ...base, p0: pos, p1: pos + dOut, q0: q, q1: q + rOut, u: piece.v * r, w: piece.rampOut.v * r, ramp: true });
      pos += dOut;
      q += rOut;
    }
  }
  const length = q;

  // Sample every output frame.
  const p: number[] = [];
  const src: number[] = [];
  let idx = 0;
  for (let k = 0; k < length - EPS; k++) {
    while (idx < map.length - 1 && (map[idx].q1 - map[idx].q0 < 1e-12 || map[idx].q1 <= k + 1e-9)) idx++;
    const m = map[idx];
    const dq = Math.max(0, k - m.q0);
    const span = m.q1 - m.q0;
    const pos = span > 1e-12 ? m.p0 + m.u * dq + ((m.w - m.u) * dq * dq) / (2 * span) : m.p1;
    p.push(pos);
    src.push(Math.min(P1 - 1, Math.max(P0, Math.floor(pos + EPS))));
  }

  // Output frames of each clip (source frames are non-decreasing).
  const clipRanges = clips.map(() => ({ k0: -1, k1: -1 }));
  src.forEach((f, k) => {
    const ci = clips.findIndex((c) => c.A <= f && f < c.B);
    const range = clipRanges[ci];
    if (!range) return;
    if (range.k0 < 0) range.k0 = k;
    range.k1 = k + 1;
  });
  for (const range of clipRanges) {
    if (range.k0 < 0) {
      range.k0 = 0;
      range.k1 = 0;
    }
  }

  const runCuts: RunCut[] = cuts.map((c) => ({ ...c, at: firstFrameAtOrAfter(p, c.b) }));
  return { srcFps, outFps, pieces: map, length, p, src, clipRanges, cuts: runCuts, protectedSpans: prot };
}

/** First output frame whose source position is at or after source frame position `pos` (p.length when none). */
export function firstFrameAtOrAfter(p: readonly number[], pos: number): number {
  let lo = 0;
  let hi = p.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p[mid] >= pos - EPS) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Output frame (run) at which capture time `t` (seconds) is shown. */
export function outFrameAt(timing: RunTiming, t: number): number {
  return firstFrameAtOrAfter(timing.p, t * timing.srcFps);
}
