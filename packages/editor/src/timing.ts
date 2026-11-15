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
import { LOADING_CUT_MIN_S } from '@retake/core/run';
import { BUSY_CUT_MIN_S, BUSY_KEEP_AFTER_S, BUSY_KEEP_BEFORE_S, IDLE_KEEP_S, MARK_WINDOW_S, QUICK_RUN_SPEED, SPEED_RAMP_S, WAIT_ACTIONS, WAIT_SPEED } from './timing-spans.js';
import type { MapPiece, ProtectedSpan, RunClipInput, RunCut, RunTiming, RunTimingInput } from './timing-types.js';
import type { Interval } from './util.js';
import { intersect, mergeIntervals, stepEnd, subtractIntervals } from './util.js';

export {
  BUSY_CUT_MIN_S,
  BUSY_KEEP_AFTER_S,
  BUSY_KEEP_BEFORE_S,
  DEFAULT_IDLE_THRESHOLD_S,
  IDLE_KEEP_S,
  MARK_WINDOW_S,
  QUICK_RUN_PAD_AFTER_S,
  QUICK_RUN_PAD_BEFORE_S,
  QUICK_RUN_SPEED,
  SPEED_RAMP_S,
  WAIT_ACTIONS,
  WAIT_KEEP_S,
  WAIT_LOADING_MIN_S,
  WAIT_MIN_S,
  WAIT_SPEED,
  hookSpans,
  loadsBesideOtherPages,
  quickRunSpans,
  waitingSpans,
} from './timing-spans.js';
export type { MapPiece, ProtectReason, ProtectedSpan, RunClipInput, RunCut, RunTiming, RunTimingInput } from './timing-types.js';

const EPS = 1e-6;

/**
 * Spans played at 1× whatever the speeds: the opening still, holds (action and modifier), marked step windows. With
 * `waitsFaster` (the default: waiting plays faster, see `WAIT_SPEED`) a marked wait step protects the moment it waited
 * for (its end); without it (`overrides.trim_idle: false`) the whole marked step.
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

/** A cut while the run is planned (before the output frame after it is known). */
type DraftCut = Interval & { clip: number; idle: Interval; reason: RunCut['reason'] };

/** The parts of a span inside each clip of the run, with the clip's index. */
function perClip(clips: readonly RunClipInput[], span: Interval, visit: (x: Interval, c: RunClipInput, ci: number) => void): void {
  clips.forEach((c, ci) => {
    const x = intersect(span, { a: c.A, b: c.B });
    if (x) visit(x, c, ci);
  });
}

/** Spans played at their own speed: a step's own `speed` (a step's span, before its hold), then waits and quick runs. */
function runSpeeds(input: RunTimingInput): Array<Interval & { v: number }> {
  const { clips, srcFps } = input;
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
    perClip(clips, { a: w.t_start * srcFps, b: w.t_end * srcFps }, (x, c) => {
      if (x.b - x.a > 1) stepSpeeds.push({ ...x, v: Math.max(WAIT_SPEED, c.baseSpeed) });
    });
  }
  for (const w of input.quick ?? []) {
    perClip(clips, { a: w.t_start * srcFps, b: w.t_end * srcFps }, (x, c) => {
      if (x.b - x.a > 1) stepSpeeds.push({ ...x, v: Math.max(QUICK_RUN_SPEED, c.baseSpeed) });
    });
  }
  return stepSpeeds;
}

/** Cuts a span whole in each clip, but the parts already in `held`; each cut joins `held`. */
function cutWhole(clips: readonly RunClipInput[], span: Interval, held: Interval[], cut: (piece: Interval, ci: number) => void): void {
  perClip(clips, span, (x, _c, ci) => {
    if (x.b - x.a < EPS) return;
    for (const piece of subtractIntervals(x, held)) {
      if (piece.b - piece.a < EPS) continue;
      cut(piece, ci);
      held.push(piece);
    }
  });
}

/**
 * Cuts of idle trimming: page loads the capture held and freezes cut whole, idle gaps and waits after a click shortened.
 * Pushed onto `cuts`.
 */
function trimCuts(input: RunTimingInput, protMerged: Interval[], offcamera: Interval[], cuts: DraftCut[]): void {
  const { clips, srcFps } = input;
  // Page loads the capture held (R-ISS-08): cut whole — inside protected spans too, a frozen frame is never what a mark
  // or a hold shows —, up to the first source frame showing the painted page (no frozen frame after the cut).
  const held: Interval[] = [...offcamera];
  const loads = (input.loading ?? []).filter((l) => l.t_end - l.t_start >= LOADING_CUT_MIN_S - EPS);
  // Several pages' loads (a multi-page run) may overlap: one cut each.
  for (const h of mergeIntervals(loads.map((l) => ({ a: l.t_start * srcFps, b: Math.ceil(l.t_end * srcFps - EPS) })))) {
    perClip(clips, h, (x, _c, ci) => {
      if (x.b - x.a < EPS) return;
      for (const piece of subtractIntervals(x, offcamera)) {
        if (piece.b - piece.a < EPS) continue;
        cuts.push({ ...piece, clip: ci, idle: piece, reason: 'loading' });
        held.push(piece);
      }
    });
  }
  // Freezes of the capture: the frozen frames but the first, cut whole like a held load (never inside one).
  for (const f of input.frozen ?? []) {
    const fz = { a: Math.ceil(f.t_start * srcFps - EPS) + 1, b: Math.ceil(f.t_end * srcFps - EPS) };
    if (fz.b - fz.a < 1 - EPS) continue;
    cutWhole(clips, fz, held, (piece, ci) => cuts.push({ ...piece, clip: ci, idle: piece, reason: 'frozen' }));
  }
  // Idle trims: the part of an idle interval outside protected spans and held loads, when longer than the threshold.
  const kept = mergeIntervals([...protMerged, ...held]);
  const minLen = input.idleThresholdS * srcFps;
  const keepHalf = (IDLE_KEEP_S / 2) * srcFps;
  for (const gap of input.idle) {
    perClip(clips, { a: gap.t_start * srcFps, b: gap.t_end * srcFps }, (x, _c, ci) => {
      for (const piece of subtractIntervals(x, kept)) {
        if (piece.b - piece.a > minLen + EPS) cuts.push({ a: piece.a + keepHalf, b: piece.b - keepHalf, clip: ci, idle: piece, reason: 'idle' });
      }
    });
  }
  // Waits after a click (R-FLD-26): outside protected spans, held loads and the idle cuts just made.
  const keptBusy = mergeIntervals([...kept, ...cuts.filter((c) => c.reason === 'idle')]);
  for (const w of input.busy ?? []) {
    perClip(clips, { a: w.t_start * srcFps, b: w.t_end * srcFps }, (x, _c, ci) => {
      for (const piece of subtractIntervals(x, keptBusy)) {
        const a = piece.a + BUSY_KEEP_BEFORE_S * srcFps;
        const b = piece.b - BUSY_KEEP_AFTER_S * srcFps;
        if (b - a >= BUSY_CUT_MIN_S * srcFps - EPS) cuts.push({ a, b, clip: ci, idle: piece, reason: 'busy' });
      }
    });
  }
}

/** The run's cuts, in source order: hook steps always, idle trimming's cuts with `trimIdle`. */
function runCutsOf(input: RunTimingInput, protMerged: Interval[]): DraftCut[] {
  const { clips, srcFps } = input;
  const cuts: DraftCut[] = [];
  // Hook steps: what the take did off camera is cut whole, whatever the trimming.
  const offcamera: Interval[] = [];
  for (const h of mergeIntervals((input.offcamera ?? []).map((o) => ({ a: o.t_start * srcFps, b: o.t_end * srcFps })))) {
    perClip(clips, h, (x, _c, ci) => {
      if (x.b - x.a < EPS) return;
      cuts.push({ ...x, clip: ci, idle: x, reason: 'hook' });
      offcamera.push(x);
    });
  }
  if (input.trimIdle) trimCuts(input, protMerged, offcamera, cuts);
  cuts.sort((x, y) => x.a - y.a);
  return cuts;
}

/** What the elementary pieces are cut from: protected spans, own speeds and cuts. */
interface RunSpans {
  protMerged: Interval[];
  stepSpeeds: Array<Interval & { v: number }>;
  cuts: DraftCut[];
}

/** Elementary pieces between every boundary, neighbours of the same clip, speed and flags joined. */
function elementaryPieces(clips: readonly RunClipInput[], spans: RunSpans): Elementary[] {
  const { protMerged, stepSpeeds, cuts } = spans;
  const P0 = clips[0].A;
  const P1 = clips[clips.length - 1].B;
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
  return pieces;
}

/**
 * Slivers (unprotected pieces shorter than one source frame, e.g. the millisecond between a final hold and the
 * scene end) take the speed of the piece before them: no ramp for nothing. In place.
 */
function absorbSlivers(pieces: Elementary[]): void {
  for (let n = 0; n < pieces.length; n++) {
    const x = pieces[n];
    if (x.cut || x.protected || x.b - x.a >= 1) continue;
    const before = pieces
      .slice(0, n)
      .reverse()
      .find((y) => !y.cut);
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
}

/** Ramps between kept pieces of different speeds: inside the unprotected side (the faster one when both are free). In place. */
function placeRamps(pieces: Elementary[], outFps: number): void {
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
}

/** The map pieces of a kept piece from output frame `q` (ramp in, steady part, ramp out); returns the output frame after it. */
function mapKeptPiece(piece: Elementary, r: number, q: number, map: MapPiece[]): number {
  const len = piece.b - piece.a;
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
  return q;
}

/** The output → source map of the pieces and its output length (frames). */
function mapPieces(pieces: Elementary[], r: number): { map: MapPiece[]; length: number } {
  const map: MapPiece[] = [];
  let q = 0;
  for (const piece of pieces) {
    if (piece.cut) {
      map.push({ p0: piece.a, p1: piece.b, q0: q, q1: q, u: 0, w: 0, clip: piece.clip, v: piece.v, protected: false, cut: true, ramp: false });
      continue;
    }
    q = mapKeptPiece(piece, r, q, map);
  }
  return { map, length: q };
}

/** The source position and frame of every output frame, frames held to the run's [P0, P1). */
function sampleFrames(map: MapPiece[], length: number, run: { P0: number; P1: number }): { p: number[]; src: number[] } {
  const { P0, P1 } = run;
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
  return { p, src };
}

/** Output frames of each clip (source frames are non-decreasing); an empty clip gets [0, 0). */
function clipRangesOf(clips: readonly RunClipInput[], src: number[]): Array<{ k0: number; k1: number }> {
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
  return clipRanges;
}

/** Plan the time map of a run (see the module comment). Pure. */
export function planRunTiming(input: RunTimingInput): RunTiming {
  const { clips, srcFps, outFps } = input;
  const r = srcFps / outFps;
  const P0 = clips[0].A;
  const P1 = clips[clips.length - 1].B;

  const prot = protectedSpans(clips, srcFps, input.trimIdle);
  const protMerged = mergeIntervals(prot);
  const stepSpeeds = runSpeeds(input);
  const cuts = runCutsOf(input, protMerged);

  const pieces = elementaryPieces(clips, { protMerged, stepSpeeds, cuts });
  absorbSlivers(pieces);
  placeRamps(pieces, outFps);

  const { map, length } = mapPieces(pieces, r);
  const { p, src } = sampleFrames(map, length, { P0, P1 });
  const clipRanges = clipRangesOf(clips, src);

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
