/**
 * Camera of a run (zooms from step `camera` hints and the theme default zoom, eased in output time, view clamped to
 * the capture) and the reframe track of the vertical and square variants. Pure.
 */
import type { CameraHint } from '@retake/core/language';
import type { Timeline } from '@retake/core/run';
import { CAMERA_EASINGS, cubicBezier } from '@retake/components/geometry';
import type { Bezier, EasingFn } from '@retake/components/geometry';
import type { CameraFrame } from './plan-types.js';
import { clamp, cursorAt, round } from './util.js';
import { corridorSmooth, dampedSmooth } from './camera-smooth.js';

export { corridorSmooth, dampedSmooth } from './camera-smooth.js';

/** Minimum ease length of a zoom (seconds of output). */
export const MIN_ZOOM_EASE_S = 0.8;

/** A zoom asked by a step, in output frames of its run. */
export interface ZoomMove {
  scene: string;
  step: number;
  zoom: number;
  requested: number;
  focus: { x: number; y: number };
  /** Zoom-in start, ease length, ease-out start (all run output frames). */
  start: number;
  frames: number;
  outAt: number;
  /** Ease-out length (default: `frames`). */
  outFrames?: number;
  ease: Bezier;
  /** `hint`: a step `camera` hint; `theme`: the theme's default zoom on a marked step (style_bias balanced / motion). */
  source?: 'hint' | 'theme';
}

type State = [number, number, number];

interface Move {
  qa: number;
  qb: number;
  from: State;
  to: State;
  ease: EasingFn;
}

/** The easing curve of a hint: its own `ease` (preset or cubic-bezier), else the theme zoom_ease. */
export function hintEase(hint: Pick<CameraHint, 'ease'>, themeEase: Bezier): Bezier {
  const e = hint.ease;
  if (Array.isArray(e) && e.length === 4) return [e[0], e[1], e[2], e[3]];
  if (typeof e === 'string' && e in CAMERA_EASINGS) return CAMERA_EASINGS[e as keyof typeof CAMERA_EASINGS];
  return themeEase;
}

/** Centre of the view at `zoom`, clamped so the view stays inside the capture (the capture fills the screen rect). */
export function clampView(zoom: number, cx: number, cy: number, w: number, h: number): [number, number] {
  const hw = w / (2 * zoom);
  const hh = h / (2 * zoom);
  return [clamp(cx, hw, w - hw), clamp(cy, hh, h - hh)];
}

/**
 * Per-frame camera of a run of `n` output frames: rest = zoom 1 on the capture centre; each move eases in from the
 * current state to its zoom/focus, holds, then eases back to rest; a later move starts from wherever the camera is
 * (cancelling the remaining moves of the previous one). Views are clamped frame by frame.
 */
export function cameraTrack(moves: readonly ZoomMove[], n: number, w: number, h: number): CameraFrame[] {
  const rest: State = [1, w / 2, h / 2];
  const list: Move[] = [];
  const stateAt = (q: number): State => {
    let s: State = rest;
    for (const m of list) {
      if (q < m.qa) break;
      if (q >= m.qb) s = m.to;
      else {
        const k = m.ease((q - m.qa) / (m.qb - m.qa));
        s = [m.from[0] + (m.to[0] - m.from[0]) * k, m.from[1] + (m.to[1] - m.from[1]) * k, m.from[2] + (m.to[2] - m.from[2]) * k];
      }
    }
    return s;
  };
  for (const mv of [...moves].sort((a, b) => a.start - b.start)) {
    while (list.length > 0 && list[list.length - 1].qa >= mv.start) list.pop();
    const ease = cubicBezier(...mv.ease);
    const [vx, vy] = clampView(mv.zoom, mv.focus.x, mv.focus.y, w, h);
    const to: State = [mv.zoom, vx, vy];
    list.push({ qa: mv.start, qb: mv.start + mv.frames, from: stateAt(mv.start), to, ease });
    const outAt = Math.max(mv.outAt, mv.start + mv.frames);
    list.push({ qa: outAt, qb: outAt + (mv.outFrames ?? mv.frames), from: to, to: rest, ease });
  }
  const out: CameraFrame[] = [];
  for (let q = 0; q < n; q++) {
    const [z, cx, cy] = stateAt(q);
    const zoom = Math.max(1, z);
    const [vx, vy] = clampView(zoom, cx, cy, w, h);
    out.push([round(zoom, 4), round(vx, 2), round(vy, 2)]);
  }
  return out;
}

/** True when every frame is the rest camera (zoom 1). */
export function isStatic(track: readonly CameraFrame[]): boolean {
  return track.every((c) => c[0] === 1);
}

/** A box the reframe should keep in view over capture seconds [t0, t1) (a step target, an overlay anchor…). */
export interface ReframeTarget {
  t0: number;
  t1: number;
  box: { x: number; y: number; w: number; h: number };
  /**
   * `hard`: must be fully in view over [t0, t1) when it fits (the clicked target around its click, an overlay
   * anchor while the overlay shows); otherwise the reframe only prefers it (the active step's target).
   */
  hard?: boolean;
  /** Where it comes from (debugging, review). */
  label?: string;
}

/** Tunables of the reframe track (seconds are output seconds unless stated). */
export const REFRAME = {
  /** Targets are taken into account this many capture seconds before their step starts (look-ahead). */
  look_ahead_s: 0.5,
  /** Time constant of each stage of the critically damped smoothing (two stages forward + two backward). */
  tau_s: 0.2,
  /** Dead zone: the view only re-targets when what must be seen leaves the view inset by this share of its size. */
  dead_zone: 0.15,
  /** Box kept around the cursor's hotspot (CSS px): the arrow and its ripple. */
  cursor_box: { left: 24, top: 24, right: 56, bottom: 64 },
  /** Margin (CSS px) kept between a hard box and the edge of the view. */
  margin: 12,
  /** A run starts framed on what its first step needs when that step starts within this many capture seconds. */
  calm_start_s: 4,
  /** Where the cursor will be within this many capture seconds is part of what the view should show (look-ahead). */
  cursor_ahead_s: 0.4,
  /**
   * Reach (output seconds, ≈ a third of how far it spreads) of a repair: where the smoothed path would cut the cursor
   * or a hard box, it is bent by the smoothest critically damped correction that keeps them in view (corridorSmooth).
   */
  repair_s: 0.3,
} as const;

type Box = { x: number; y: number; w: number; h: number };

/**
 * The part of `b` the view can show next to `roi` (what it already shows) when `b` is larger than the view: its
 * leading part (left / top: where a row's or a card's text starts), as much of it as fits in the view with `roi`.
 * `b` itself when it fits; null when nothing of it fits.
 */
export function leadingPart(b: Box, view: { w: number; h: number }, roi: Box | null, margin: number): Box | null {
  const W = view.w - 2 * margin;
  const H = view.h - 2 * margin;
  if (b.w <= W && b.h <= H) return b;
  const axis = (b0: number, len: number, r0: number | undefined, rLen: number, size: number): [number, number] | null => {
    if (len <= size && r0 === undefined) return [b0, len];
    let p0 = b0;
    let p1 = Math.min(b0 + len, b0 + size);
    if (r0 !== undefined) {
      p0 = Math.max(b0, r0 + rLen - size);
      p1 = Math.min(b0 + len, Math.min(r0, p0) + size);
    }
    return p1 - p0 > 0.5 ? [p0, p1 - p0] : null;
  };
  const x = axis(b.x, b.w, roi?.x, roi?.w ?? 0, W);
  const y = axis(b.y, b.h, roi?.y, roi?.h ?? 0, H);
  return x && y ? { x: x[0], y: y[0], w: x[1], h: y[1] } : null;
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Minimal shift (1-D) that brings [a, a + len) inside [lo, hi) — 0 when inside, centred when it cannot fit. */
function shiftInto(a: number, len: number, lo: number, hi: number): number {
  if (len >= hi - lo) return a + len / 2 - (lo + hi) / 2;
  if (a < lo) return a - lo;
  if (a + len > hi) return a + len - hi;
  return 0;
}

/** The view of every output frame of a reframe and what it must show (steps 1–2 read it). */
function reframeView(opts: ReframeOptions) {
  const { times, camera, cursor, crop, css } = opts;
  const targets = [...(opts.targets ?? [])].sort((a, b) => a.t0 - b.t0);
  const R = REFRAME;
  const viewAt = (k: number) => {
    const z = Math.max(1, camera[k]?.[0] ?? 1);
    return { w: Math.min(css.w, crop.w / z), h: Math.min(css.h, crop.h / z) };
  };
  const boxAt = (t: number): Box | null => {
    const c = cursorAt(cursor, t);
    if (!c?.visible) return null;
    const b = R.cursor_box;
    return { x: c.x - b.left, y: c.y - b.top, w: b.left + b.right, h: b.top + b.bottom };
  };
  const cursorBox = (k: number): Box | null => boxAt(times[k]);
  /** The cursor box and where it goes within `cursor_ahead_s` (samples of the track in that window). */
  const cursorAhead = (k: number): Box[] => {
    const t = times[k];
    const out: Box[] = [];
    for (const smp of cursor) {
      if (smp.t <= t) continue;
      if (smp.t > t + R.cursor_ahead_s) break;
      const b = boxAt(smp.t);
      if (b) out.push(b);
    }
    return out;
  };
  const fits = (b: Box, v: { w: number; h: number }) => b.w <= v.w - 2 * R.margin && b.h <= v.h - 2 * R.margin;

  // 1–2. Target signal with a dead zone.
  const activeAt = (k: number) => targets.filter((g) => times[k] >= g.t0 - (g.hard ? 0 : R.look_ahead_s) && times[k] < g.t1);
  /**
   * What should be seen at frame k: hard boxes first, then the cursor (and where it goes), then soft targets — a
   * target wider than the view by its leading part, as far as it fits with the rest.
   */
  const roiAt = (k: number, active: ReframeTarget[], hk: Box[], cb: Box | null): Box | null => {
    const v = viewAt(k);
    let roi: Box | null = null;
    // A box larger than the view counts by its leading part (a whole table row: where its text starts).
    const add = (box: Box) => {
      const b = leadingPart(box, v, roi, R.margin);
      if (!b) return;
      if (!roi) {
        if (fits(b, v)) roi = { ...b };
        return;
      }
      const u = union(roi, b);
      if (fits(u, v)) roi = u;
    };
    for (const b of hk) add(b);
    if (cb) add(cb);
    for (const b of cursorAhead(k)) add(b);
    const cam = camera[k];
    if (cam && cam[0] > 1.001) add({ x: cam[1] - 1, y: cam[2] - 1, w: 2, h: 2 });
    for (const g of [...active].filter((x) => !x.hard).sort((a, b) => a.t1 - b.t1)) add(g.box);
    return roi;
  };
  return { targets, viewAt, cursorBox, cursorAhead, fits, activeAt, roiAt };
}

type ReframeView = ReturnType<typeof reframeView>;

/** Steps 1–2: the target signal with a dead zone, from a calm start; the cursor box and hard boxes of each frame. */
function reframeWants(opts: ReframeOptions, view: ReframeView): { cur: Array<Box | null>; hard: Box[][]; wantX: number[]; wantY: number[] } {
  const { times, cursor, css } = opts;
  const n = times.length;
  const R = REFRAME;
  const { viewAt, cursorBox, cursorAhead, fits, activeAt, roiAt } = view;
  const cur: Array<Box | null> = [];
  const hard: Box[][] = [];
  const wantX: number[] = [];
  const wantY: number[] = [];
  // A calm start: the first frames are framed on what the first step needs (its target with the resting cursor), so
  // the view does not travel during the scene's opening still; without a target soon, on the cursor. The view holds as
  // far toward the page's leading edge (left, top: its heading, where text starts) as that region allows.
  const c0 = cursorAt(cursor, times[0]);
  let ax = c0?.visible ? c0.x : css.w / 2;
  let ay = c0?.visible ? c0.y : css.h / 2;
  let start: Box | null = cursorBox(0);
  const kFirst = times.findIndex((t, k) => t - times[0] <= R.calm_start_s && activeAt(k).length > 0);
  if (kFirst >= 0) {
    const act = activeAt(kFirst);
    const roi = roiAt(
      kFirst,
      act,
      act.filter((g) => g.hard).map((g) => g.box),
      cursorBox(kFirst),
    );
    if (roi) {
      ax = roi.x + roi.w / 2;
      ay = roi.y + roi.h / 2;
      start = roi;
    }
  }
  {
    const v = viewAt(0);
    if (start && fits(start, v)) {
      // Inside the dead zone: the first frames do not re-target right away.
      ax = Math.min(ax, start.x + start.w + v.w * R.dead_zone - v.w / 2);
      ay = Math.min(ay, start.y + start.h + v.h * R.dead_zone - v.h / 2);
    }
    ax = clamp(ax, v.w / 2, css.w - v.w / 2);
    ay = clamp(ay, v.h / 2, css.h - v.h / 2);
  }
  const settle = [...(opts.settle ?? [])].sort((a, b) => a - b);
  let si = 0;
  let settling = false;
  for (let k = 0; k < n; k++) {
    const v = viewAt(k);
    const cb = cursorBox(k);
    cur.push(cb);
    const active = activeAt(k);
    const hk = active.filter((g) => g.hard && fits(g.box, v)).map((g) => g.box);
    hard.push(hk);
    const roi = roiAt(k, active, hk, cb);
    while (si < settle.length && settle[si] <= times[k]) {
      si++;
      settling = true;
    }
    // A settle waits for the previous step's targets to end (they may last into the scene).
    if (settling && roi && active.length === 0 && fits(roi, v)) {
      settling = false;
      ax = clamp(Math.min(ax, roi.x + roi.w + v.w * R.dead_zone - v.w / 2), v.w / 2, css.w - v.w / 2);
      ay = clamp(Math.min(ay, roi.y + roi.h + v.h * R.dead_zone - v.h / 2), v.h / 2, css.h - v.h / 2);
    } else if (roi) {
      const r: Box = roi;
      const ix = v.w * R.dead_zone;
      const iy = v.h * R.dead_zone;
      const sx = shiftInto(r.x, r.w, ax - v.w / 2 + ix, ax + v.w / 2 - ix);
      const sy = shiftInto(r.y, r.h, ay - v.h / 2 + iy, ay + v.h / 2 - iy);
      // Half the slack goes ahead of what moves; a cursor resting alone (its step's targets over: a closing hold) is
      // only brought back inside — no pan across the page for a few pixels.
      const resting = active.length === 0 && cb !== null && r.w === cb.w && r.h === cb.h && cursorAhead(k).every((b) => Math.abs(b.x - cb.x) < 1 && Math.abs(b.y - cb.y) < 1);
      const slack = resting ? 0 : 1;
      if (sx !== 0) ax += sx + slack * Math.sign(sx) * Math.max(0, (v.w - 2 * ix - r.w) / 2);
      if (sy !== 0) ay += sy + slack * Math.sign(sy) * Math.max(0, (v.h - 2 * iy - r.h) / 2);
      ax = clamp(ax, v.w / 2, css.w - v.w / 2);
      ay = clamp(ay, v.h / 2, css.h - v.h / 2);
    }
    wantX.push(ax);
    wantY.push(ay);
  }
  return { cur, hard, wantX, wantY };
}

/** Where the view centre may be at a frame on one axis so that [a, a + len) shows with the margin (centred when too big). */
function mustRange(a: number, len: number, size: number, bounds: [number, number], m: number): [number, number] {
  let lo = Math.max(bounds[0], a + len + m - size / 2);
  let hi = Math.min(bounds[1], a - m + size / 2);
  if (lo > hi) {
    // Too big (or at the edge) with the margin: centre it, inside the capture.
    const c = clamp(a + len / 2, bounds[0], bounds[1]);
    lo = Math.min(Math.max(lo, bounds[0]), c);
    hi = Math.max(Math.min(hi, bounds[1]), c);
    if (lo > hi) lo = hi = c;
    else lo = hi = clamp(c, lo, hi);
  }
  return [lo, hi];
}

/** Step 4: the corridor of each frame — the view centres that keep the cursor and the hard boxes in view. */
function reframeCorridor(opts: ReframeOptions, view: ReframeView, cur: Array<Box | null>, hard: Box[][]): { loX: number[]; hiX: number[]; loY: number[]; hiY: number[] } {
  const { css } = opts;
  const n = opts.times.length;
  const R = REFRAME;
  const { viewAt, fits } = view;
  const loX: number[] = [];
  const hiX: number[] = [];
  const loY: number[] = [];
  const hiY: number[] = [];
  for (let k = 0; k < n; k++) {
    const v = viewAt(k);
    const must: Box[] = [...hard[k]];
    const cb = cur[k];
    if (cb && fits(cb, v)) must.push(cb);
    const bx: [number, number] = [v.w / 2, css.w - v.w / 2];
    const by: [number, number] = [v.h / 2, css.h - v.h / 2];
    if (must.length > 0) {
      let box = must[0];
      for (const b of must.slice(1)) box = union(box, b);
      // Only the part inside the capture can be shown (a cursor at the edge, a target partly off the page).
      const x0 = clamp(box.x, 0, css.w);
      const y0 = clamp(box.y, 0, css.h);
      box = { x: x0, y: y0, w: clamp(box.x + box.w, 0, css.w) - x0, h: clamp(box.y + box.h, 0, css.h) - y0 };
      const m = R.margin;
      const rx = mustRange(box.x, box.w, v.w, bx, m);
      const ry = mustRange(box.y, box.h, v.h, by, m);
      loX.push(rx[0]);
      hiX.push(rx[1]);
      loY.push(ry[0]);
      hiY.push(ry[1]);
    } else {
      loX.push(bx[0]);
      hiX.push(bx[1]);
      loY.push(by[0]);
      hiY.push(by[1]);
    }
  }
  return { loX, hiX, loY, hiY };
}

type ReframeOptions = Parameters<typeof reframeTrack>[0];

/**
 * Reframing of the vertical and square variants: the centre (source CSS px) of the crop shown in the layout's
 * screen rect, per output frame of a run (contiguous clips: the track never crosses a cut).
 *
 * 1. What must be seen at each frame: the cursor (its arrow + ripple box, while visible), the active step's target
 *    (from `look_ahead_s` before the step starts to its end) and the overlay anchors; their union when it fits in the
 *    view, else the hard boxes, else the cursor alone (the view then follows the cursor towards the target). A box
 *    larger than the view counts by its leading part (`leadingPart`: a table row by its id and label). While the
 *    camera zooms, its focus is kept in view too.
 * 2. Dead zone: the target centre only moves when that region leaves the view inset by `dead_zone`; it then moves by
 *    the smallest shift that brings it back, plus half the slack (no re-targeting for small motions: no jitter). It
 *    starts framed on the first step's region, as far toward the page's leading edge (left, top) as that allows.
 * 3. Critically damped smoothing without lag (`dampedSmooth`): moves are smooth S curves that start a little before
 *    the need (look-ahead) and never overshoot.
 * 4. Constraints: the cursor and the hard boxes (the clicked target around its click, overlay anchors while shown)
 *    must stay fully in view; violations push the target signal and the smoothing is run again (a few passes), then
 *    any remaining violation is removed by the smallest shift — so the clicked target and the cursor are never cut.
 * 5. The view stays inside the capture.
 */
export function reframeTrack(opts: {
  /** Capture time (s) of every output frame. */
  times: readonly number[];
  camera: readonly CameraFrame[];
  cursor: Timeline['cursor'];
  crop: { w: number; h: number };
  css: { w: number; h: number };
  outFps: number;
  targets?: readonly ReframeTarget[];
  /**
   * Capture times where the view settles toward the page's leading edge (left, top) when nothing is acted on then — the
   * start of a scene where the page only rests (the idle page of a multi-page scene): it shows the page's content
   * around its resting cursor instead of holding on where its last action was.
   */
  settle?: readonly number[];
}): Array<[number, number]> {
  const n = opts.times.length;
  if (n === 0) return [];
  const R = REFRAME;
  const view = reframeView(opts);
  const { cur, hard, wantX, wantY } = reframeWants(opts, view);
  const { loX, hiX, loY, hiY } = reframeCorridor(opts, view, cur, hard);
  const reach = R.repair_s * opts.outFps;
  const xs = corridorSmooth(dampedSmooth(wantX, opts.outFps, R.tau_s), loX, hiX, reach);
  const ys = corridorSmooth(dampedSmooth(wantY, opts.outFps, R.tau_s), loY, hiY, reach);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) out.push([round(clamp(xs[k], loX[k], hiX[k]), 2), round(clamp(ys[k], loY[k], hiY[k]), 2)]);
  return out;
}
