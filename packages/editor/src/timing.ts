/**
 * Time mapping of a "run": one clip, or several clips contiguous in the capture on the same page (joined without a
 * transition). The run is planned as ONE continuous piece of footage so that speeds, ramps, trims and the camera
 * continue across the joins, then split back into clips.
 *
 * Cuts (with idle trimming on): page loads the capture held (R-ISS-08: the previous frame frozen until the new page
 * painted) are cut whole; idle gaps outside protected spans and those loads are shortened to IDLE_KEEP_S.
 *
 * Units: source positions `p` are capture frames (float; frame n of the CFR capture shows capture time n / fps),
 * output positions `q` are output frames (float). Speeds `v` are playback speeds (×); `u`/`w` are the slopes
 * dp/dq = v · srcFps / outFps at the start / end of a map piece (linear in q on a ramp, constant otherwise).
 */
import { LOADING_CUT_MIN_S } from '@retake/core';
import type { TimelineEvent } from '@retake/core';
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
/**
 * A wait after a click (L5.7, R-FLD-26) keeps this much of its start (the viewer sees that it loads) and this much before
 * the content appears; waits whose middle is shorter than BUSY_CUT_MIN_S are left alone.
 */
export const BUSY_KEEP_BEFORE_S = 0.3;
export const BUSY_KEEP_AFTER_S = 0.1;
export const BUSY_CUT_MIN_S = 0.2;
/**
 * Waiting (L2.12 — the root cause of the catalogue `long-wait`): a wait step (`wait_for`, `wait_for_email`) and the
 * post-navigation pause of the step right before it show a loading state (placeholders, spinners — they animate, so the
 * capture is never idle and idle trimming cannot shorten them). The planner plays such a span at `WAIT_SPEED` after its
 * first `WAIT_KEEP_S` (the viewer sees that it loads), ramped like any speed change; marks, holds and the opening still
 * stay at 1×, a step's own `speed` wins, a faster scene speed is kept. A marked wait step protects the moment it waited
 * for (its end), not the waiting.
 */
export const WAIT_SPEED = 4;
export const WAIT_KEEP_S = 0.5;
/** Waiting shorter than this (after the kept part) is left alone. */
export const WAIT_MIN_S = 0.3;
/** Wait steps that waited at least this long in all show that the page before them was still loading. */
export const WAIT_LOADING_MIN_S = 0.3;
/** Steps that wait for the product. */
export const WAIT_ACTIONS: ReadonlySet<string> = new Set(['wait_for', 'wait_for_email']);
/**
 * Quick month runs of a `date` step (R-CHO-24, `data.quick_runs`: presses ~110 ms apart) are played at up to
 * QUICK_RUN_SPEED, from QUICK_RUN_PAD_BEFORE_S before the first press to QUICK_RUN_PAD_AFTER_S after the last (its
 * ripple), ramped like any speed change (a short run never reaches the full speed); a step's own `speed` wins, marks
 * and holds stay at 1×.
 */
export const QUICK_RUN_SPEED = 3;
export const QUICK_RUN_PAD_BEFORE_S = 0.1;
export const QUICK_RUN_PAD_AFTER_S = 0.35;

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
  /**
   * Capture seconds the scenario spends waiting for the product (`waitingSpans`): played at `WAIT_SPEED` (outside
   * protected spans). Absent / empty: no compression.
   */
  waits?: ReadonlyArray<{ t_start: number; t_end: number }>;
  /** Quick month runs (`quickRunSpans`, capture seconds): played at QUICK_RUN_SPEED (outside protected spans). */
  quick?: ReadonlyArray<{ t_start: number; t_end: number }>;
  /**
   * Page loads the capture held (`timeline.loading`, R-ISS-08: the previous frame frozen from the commit until the new
   * page painted): with `trimIdle`, those of at least LOADING_CUT_MIN_S are cut whole.
   */
  loading?: ReadonlyArray<{ t_start: number; t_end: number }>;
  /**
   * Freezes of the capture (`timeline.stalls`, L5.7: no new frame while the cursor moved or a click ripple played —
   * R-ISS-12's dialog close): with `trimIdle`, cut whole but their first frame, inside protected spans too.
   */
  frozen?: ReadonlyArray<{ t_start: number; t_end: number }>;
  /**
   * Waits the screen showed after a click (`timeline.busy`, L5.7, R-FLD-26: skeletons, spinners, blank panels): with
   * `trimIdle`, shortened like idle gaps — outside protected spans, keeping BUSY_KEEP_BEFORE_S of the wait and
   * BUSY_KEEP_AFTER_S before the content appears.
   */
  busy?: ReadonlyArray<{ t_start: number; t_end: number }>;
  /**
   * Spans the take played off camera (`hookSpans`: the `hook:` steps, L5.8): cut whole, always — idle trimming on or
   * off, inside protected spans too.
   */
  offcamera?: ReadonlyArray<{ t_start: number; t_end: number }>;
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
  /**
   * `idle`: a shortened idle gap; `loading`: a page load the capture held, cut whole; `frozen`: a freeze of the capture
   * (its frozen frames but the first); `busy`: a wait after a click (a skeleton, a spinner) shortened; `hook`: a `hook:`
   * step, run off camera (L5.8), cut whole.
   */
  reason: 'idle' | 'loading' | 'frozen' | 'busy' | 'hook';
  /** The idle piece (outside protected spans) the cut was taken from (a held load: the load itself). */
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

/**
 * Spans played at 1× whatever the speeds: the opening still, holds (action and modifier), marked step windows. With
 * `waitsFaster` (the default: waiting plays faster, see `WAIT_SPEED`) a marked wait step protects the moment it waited
 * for (its end); without it (`overrides.trim_idle: false`) the whole marked step, as before L2.12.
 */
export function protectedSpans(clips: readonly RunClipInput[], fps: number, waitsFaster = true): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  for (const c of clips) {
    for (const e of c.events) {
      if (e.action === 'scene_still' && e.t_end > e.t_start) out.push({ a: e.t_start * fps, b: e.t_end * fps, reason: 'still', scene: c.scene, step: e.step });
      if (e.hold && e.hold.t_end > e.hold.t_start) out.push({ a: e.hold.t_start * fps, b: e.hold.t_end * fps, reason: 'hold', scene: c.scene, step: e.step });
      else if (e.action === 'hold' && e.t_end > e.t_start) out.push({ a: e.t_start * fps, b: e.t_end * fps, reason: 'hold', scene: c.scene, step: e.step });
      // A marked wait step: the moment it waited for (its end) is what the mark points at, not the waiting before it.
      const markFrom = waitsFaster && WAIT_ACTIONS.has(e.action) ? e.t_end : e.t_start;
      if (e.mark) out.push({ a: (markFrom - MARK_WINDOW_S) * fps, b: (stepEnd(e) + MARK_WINDOW_S) * fps, reason: 'mark', scene: c.scene, step: e.step });
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

  const prot = protectedSpans(clips, srcFps, input.trimIdle);
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

  // Waiting played faster (after the explicit step speeds: those win).
  for (const w of input.waits ?? []) {
    clips.forEach((c) => {
      const x = intersect({ a: w.t_start * srcFps, b: w.t_end * srcFps }, { a: c.A, b: c.B });
      if (x && x.b - x.a > 1) stepSpeeds.push({ ...x, v: Math.max(WAIT_SPEED, c.baseSpeed) });
    });
  }
  for (const w of input.quick ?? []) {
    clips.forEach((c) => {
      const x = intersect({ a: w.t_start * srcFps, b: w.t_end * srcFps }, { a: c.A, b: c.B });
      if (x && x.b - x.a > 1) stepSpeeds.push({ ...x, v: Math.max(QUICK_RUN_SPEED, c.baseSpeed) });
    });
  }

  const cuts: Array<Interval & { clip: number; idle: Interval; reason: RunCut['reason'] }> = [];
  // Hook steps (L5.8): what the take did off camera is cut whole, whatever the trimming.
  const offcamera: Interval[] = [];
  for (const h of mergeIntervals((input.offcamera ?? []).map((o) => ({ a: o.t_start * srcFps, b: o.t_end * srcFps })))) {
    clips.forEach((c, ci) => {
      const x = intersect(h, { a: c.A, b: c.B });
      if (!x || x.b - x.a < EPS) return;
      cuts.push({ ...x, clip: ci, idle: x, reason: 'hook' });
      offcamera.push(x);
    });
  }
  if (input.trimIdle) {
    // Page loads the capture held (R-ISS-08): cut whole — inside protected spans too, a frozen frame is never what a mark
    // or a hold shows —, up to the first source frame showing the painted page (no frozen frame after the cut).
    const held: Interval[] = [...offcamera];
    const loads = (input.loading ?? []).filter((l) => l.t_end - l.t_start >= LOADING_CUT_MIN_S - EPS);
    // Several pages' loads (a multi-page run) may overlap: one cut each.
    for (const h of mergeIntervals(loads.map((l) => ({ a: l.t_start * srcFps, b: Math.ceil(l.t_end * srcFps - EPS) })))) {
      clips.forEach((c, ci) => {
        const x = intersect(h, { a: c.A, b: c.B });
        if (!x || x.b - x.a < EPS) return;
        for (const piece of subtractIntervals(x, offcamera)) {
          if (piece.b - piece.a < EPS) continue;
          cuts.push({ ...piece, clip: ci, idle: piece, reason: 'loading' });
          held.push(piece);
        }
      });
    }
    // Freezes of the capture (L5.7): the frozen frames but the first, cut whole like a held load (never inside one).
    for (const f of input.frozen ?? []) {
      const fz = { a: Math.ceil(f.t_start * srcFps - EPS) + 1, b: Math.ceil(f.t_end * srcFps - EPS) };
      if (fz.b - fz.a < 1 - EPS) continue;
      clips.forEach((c, ci) => {
        const x = intersect(fz, { a: c.A, b: c.B });
        if (!x || x.b - x.a < EPS) return;
        for (const piece of subtractIntervals(x, held)) {
          if (piece.b - piece.a < EPS) continue;
          cuts.push({ ...piece, clip: ci, idle: piece, reason: 'frozen' });
          held.push(piece);
        }
      });
    }
    // Idle trims: the part of an idle interval outside protected spans and held loads, when longer than the threshold.
    const kept = mergeIntervals([...protMerged, ...held]);
    const minLen = input.idleThresholdS * srcFps;
    const keepHalf = (IDLE_KEEP_S / 2) * srcFps;
    for (const gap of input.idle) {
      const g = { a: gap.t_start * srcFps, b: gap.t_end * srcFps };
      clips.forEach((c, ci) => {
        const x = intersect(g, { a: c.A, b: c.B });
        if (!x) return;
        for (const piece of subtractIntervals(x, kept)) {
          if (piece.b - piece.a > minLen + EPS) cuts.push({ a: piece.a + keepHalf, b: piece.b - keepHalf, clip: ci, idle: piece, reason: 'idle' });
        }
      });
    }
    // Waits after a click (L5.7, R-FLD-26): outside protected spans, held loads and the idle cuts just made.
    const keptBusy = mergeIntervals([...kept, ...cuts.filter((c) => c.reason === 'idle')]);
    for (const w of input.busy ?? []) {
      const g = { a: w.t_start * srcFps, b: w.t_end * srcFps };
      clips.forEach((c, ci) => {
        const x = intersect(g, { a: c.A, b: c.B });
        if (!x) return;
        for (const piece of subtractIntervals(x, keptBusy)) {
          const a = piece.a + BUSY_KEEP_BEFORE_S * srcFps;
          const b = piece.b - BUSY_KEEP_AFTER_S * srcFps;
          if (b - a >= BUSY_CUT_MIN_S * srcFps - EPS) cuts.push({ a, b, clip: ci, idle: piece, reason: 'busy' });
        }
      });
    }
  }
  cuts.sort((x, y) => x.a - y.a);

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

/** The spans of `hook:` steps (L5.8): the action ran off camera (its `hold`, after it, stays). Pure. */
export function hookSpans(events: readonly TimelineEvent[]): Array<{ t_start: number; t_end: number }> {
  return events.filter((e) => e.action === 'hook' && e.step >= 0 && e.t_end > e.t_start).map((e) => ({ t_start: e.t_start, t_end: e.t_end }));
}

/**
 * The capture seconds a scene spends waiting for the product (see `WAIT_SPEED`): each wait step without its own speed,
 * and — when a run of consecutive wait steps actually waited (≥ `WAIT_LOADING_MIN_S` in all: the new page was still
 * loading) right after a step that changed the page — that step's pause after the change (from the URL change,
 * `pageChanges` in capture seconds, to the step's end): the viewer was looking at the loading page. Contiguous spans
 * merge; the first `WAIT_KEEP_S` of each is left out (played as usual). Pure.
 */
export function waitingSpans(events: readonly TimelineEvent[], pageChanges: readonly number[] = []): Array<{ t_start: number; t_end: number }> {
  const steps = events.filter((e) => e.step >= 0 && e.status !== 'skipped').sort((a, b) => a.t_start - b.t_start || a.step - b.step);
  const isWait = (e: TimelineEvent) => WAIT_ACTIONS.has(e.action) && !(typeof e.speed === 'number' && e.speed > 0) && e.t_end > e.t_start;
  const contiguous = (prev: TimelineEvent, next: TimelineEvent) => next.t_start - stepEnd(prev) <= 0.1 && !(prev.hold && prev.hold.t_end > prev.hold.t_start);
  const raw: Interval[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (!isWait(steps[i])) continue;
    // A run of consecutive waits.
    let j = i;
    while (j + 1 < steps.length && isWait(steps[j + 1]) && contiguous(steps[j], steps[j + 1])) j++;
    const run = steps.slice(i, j + 1);
    for (const w of run) raw.push({ a: w.t_start, b: w.t_end });
    const waited = run.reduce((n, w) => n + (w.t_end - w.t_start), 0);
    const prev = steps[i - 1];
    if (prev && !WAIT_ACTIONS.has(prev.action) && contiguous(prev, steps[i]) && waited >= WAIT_LOADING_MIN_S) {
      // The page changed during the previous step and was still loading after its pause.
      const from = prev.t_click ?? prev.t_start;
      const change = pageChanges.find((t) => t >= from - 1e-6 && t < prev.t_end);
      if (change !== undefined) raw.push({ a: change, b: prev.t_end });
    }
    i = j;
  }
  const out: Array<{ t_start: number; t_end: number }> = [];
  for (const m of mergeIntervals(raw.map((x) => ({ a: x.a, b: x.b + 0.1 })))) {
    const a = m.a + WAIT_KEEP_S;
    const b = m.b - 0.1;
    if (b - a >= WAIT_MIN_S) out.push({ t_start: Math.round(a * 1e4) / 1e4, t_end: Math.round(b * 1e4) / 1e4 });
  }
  return out;
}

/**
 * Held page loads a multi-page run may cut (R-ISS-08): the time map is shared by every page the run shows, so a load
 * held on one page is not cut where another page acts — a step through its hold, ±MARK_WINDOW_S around a marked one —
 * nor during the opening still: that page's picture goes on, the loading page keeps its previous frame meanwhile. Pure.
 */
export function loadsBesideOtherPages<T extends { t_start: number; t_end: number; page?: string }>(loads: readonly T[], events: readonly TimelineEvent[]): T[] {
  const out: T[] = [];
  for (const l of loads) {
    const busy = events
      .filter((e) => e.status !== 'skipped' && (e.action === 'scene_still' || (e.step >= 0 && e.page !== undefined && e.page !== l.page)))
      .map((e) => (e.mark ? { a: e.t_start - MARK_WINDOW_S, b: stepEnd(e) + MARK_WINDOW_S } : { a: e.t_start, b: stepEnd(e) }));
    for (const x of subtractIntervals({ a: l.t_start, b: l.t_end }, busy)) out.push({ ...l, t_start: x.a, t_end: x.b });
  }
  return out;
}

/** The quick month runs of `date` steps (`data.quick_runs`), padded around their presses (capture seconds). */
export function quickRunSpans(events: readonly TimelineEvent[]): Array<{ t_start: number; t_end: number }> {
  const out: Array<{ t_start: number; t_end: number }> = [];
  for (const e of events) {
    if (e.step < 0 || e.action !== 'date' || (typeof e.speed === 'number' && e.speed > 0)) continue;
    const runs = (e.data as { quick_runs?: unknown } | undefined)?.quick_runs;
    if (!Array.isArray(runs)) continue;
    for (const r of runs as Array<{ t_start?: unknown; t_end?: unknown }>) {
      if (typeof r.t_start !== 'number' || typeof r.t_end !== 'number' || r.t_end < r.t_start) continue;
      const a = Math.max(e.t_start, r.t_start - QUICK_RUN_PAD_BEFORE_S);
      const b = Math.min(e.t_end, r.t_end + QUICK_RUN_PAD_AFTER_S);
      if (b > a) out.push({ t_start: Math.round(a * 1e4) / 1e4, t_end: Math.round(b * 1e4) / 1e4 });
    }
  }
  return out;
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
