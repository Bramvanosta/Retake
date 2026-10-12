/**
 * Camera of a run (zooms from step `camera` hints and the theme default zoom, eased in output time, view clamped to
 * the capture) and the reframe track of the vertical and square variants. Pure.
 */
import type { CameraHint, Timeline } from '@demo-studio/core';
import { CAMERA_EASINGS, cubicBezier } from '@demo-studio/components';
import type { Bezier, EasingFn } from '@demo-studio/components';
import type { CameraFrame } from './plan-types.js';
import { clamp, cursorAt, round } from './util.js';

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

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Critically damped smoothing without lag: two first-order lags in cascade (= a critically damped second-order
 * system, no overshoot) run forward, then the same backward (zero phase: a change of the target signal becomes a
 * smooth S that starts before it and ends after it — the reframe anticipates).
 */
export function dampedSmooth(values: readonly number[], fps: number, tauS: number, zeroPhase = true): number[] {
  const n = values.length;
  if (n === 0) return [];
  const alpha = 1 - Math.exp(-1 / Math.max(1e-6, tauS * fps));
  const pass = (src: number[], reverse: boolean): number[] => {
    const out = new Array<number>(n);
    let y = src[reverse ? n - 1 : 0];
    for (let i = 0; i < n; i++) {
      const k = reverse ? n - 1 - i : i;
      y += alpha * (src[k] - y);
      out[k] = y;
    }
    return out;
  };
  let v = values.slice();
  v = pass(pass(v, false), false);
  if (zeroPhase) v = pass(pass(v, true), true);
  return v;
}

/**
 * The smoothest repair of a path: the path `x = free + d` closest to `free` that stays within [lo, hi] at every
 * frame, with the weights of a CRITICALLY DAMPED system on the repair's slope and the path's curvature:
 * minimise Σ d² + 2L² Σ (Δd)² + L⁴ Σ (Δ²x)²  subject to  lo ≤ x ≤ hi.
 * The response to a one-sided push is then a single smooth bump (Green's function (1 + |t|/L)·e^(−|t|/L), never
 * negative: no ringing, the view never moves the wrong way before or after a forced move), reaching ≈ 3 L frames on
 * each side. A banded quadratic programme solved with ADMM (pentadiagonal Cholesky factorised once). Where the free
 * path is already inside, it is returned as is.
 */
export function corridorSmooth(free: readonly number[], lo: readonly number[], hi: readonly number[], reachFrames: number, opts: { iterations?: number; rho?: number; damping?: number } = {}): number[] {
  const n = free.length;
  const inside = free.every((x, k) => x >= lo[k] - 1e-9 && x <= hi[k] + 1e-9);
  if (inside || n < 3) return free.map((x, k) => clamp(x, lo[k], hi[k]));
  const rho = opts.rho ?? 1;
  const L = Math.max(1, reachFrames);
  const w1 = 2 * (opts.damping ?? 1) * L * L;
  const w2 = L ** 4;
  // A = (1 + ρ) I + w1 D1ᵀD1 + w2 D2ᵀD2 (D1, D2: first and second differences), stored by diagonals.
  const a0 = new Array<number>(n).fill(1 + rho);
  const a1 = new Array<number>(n).fill(0);
  const a2 = new Array<number>(n).fill(0);
  for (let i = 0; i + 1 < n; i++) {
    a0[i] += w1;
    a0[i + 1] += w1;
    a1[i] -= w1;
  }
  const c = [1, -2, 1];
  for (let i = 0; i + 2 < n; i++) {
    for (let p = 0; p < 3; p++) {
      a0[i + p] += w2 * c[p] * c[p];
      if (p < 2) a1[i + p] += w2 * c[p] * c[p + 1];
      if (p < 1) a2[i + p] += w2 * c[p] * c[p + 2];
    }
  }
  // Banded Cholesky A = L Lᵀ (L lower, bandwidth 2).
  const l0 = new Array<number>(n).fill(0);
  const l1 = new Array<number>(n).fill(0);
  const l2 = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    const p1 = j >= 1 ? l1[j - 1] : 0;
    const p2 = j >= 2 ? l2[j - 2] : 0;
    l0[j] = Math.sqrt(Math.max(1e-12, a0[j] - p1 * p1 - p2 * p2));
    l1[j] = (a1[j] - (j >= 1 ? l2[j - 1] * l1[j - 1] : 0)) / l0[j];
    l2[j] = a2[j] / l0[j];
  }
  const solve = (b: number[]): number[] => {
    const y = new Array<number>(n);
    for (let j = 0; j < n; j++) y[j] = (b[j] - (j >= 1 ? l1[j - 1] * y[j - 1] : 0) - (j >= 2 ? l2[j - 2] * y[j - 2] : 0)) / l0[j];
    const x = new Array<number>(n);
    for (let j = n - 1; j >= 0; j--) x[j] = (y[j] - (j + 1 < n ? l1[j] * x[j + 1] : 0) - (j + 2 < n ? l2[j] * x[j + 2] : 0)) / l0[j];
    return x;
  };
  // The curvature penalty applies to the path itself (x = free + d), so a path released from a constraint (pinned at
  // the capture's edge) accelerates smoothly instead of taking the free path's speed at once: the right-hand side
  // carries −w2 D2ᵀ D2 free.
  const curve = new Array<number>(n).fill(0);
  for (let i = 0; i + 2 < n; i++) {
    const dd = free[i] - 2 * free[i + 1] + free[i + 2];
    curve[i] -= w2 * dd;
    curve[i + 1] += 2 * w2 * dd;
    curve[i + 2] -= w2 * dd;
  }
  // ADMM on the repair d: d ∈ [lo − free, hi − free].
  const dlo = lo.map((v, k) => v - free[k]);
  const dhi = hi.map((v, k) => v - free[k]);
  let z = dlo.map((v, k) => clamp(0, v, dhi[k]));
  const u = new Array<number>(n).fill(0);
  let d = z.slice();
  const iterations = opts.iterations ?? 3000;
  for (let it = 0; it < iterations; it++) {
    d = solve(z.map((zk, k) => rho * (zk - u[k]) + curve[k]));
    let primal = 0;
    let dual = 0;
    const zn = d.map((v, k) => clamp(v + u[k], dlo[k], dhi[k]));
    for (let k = 0; k < n; k++) {
      u[k] += d[k] - zn[k];
      primal = Math.max(primal, Math.abs(d[k] - zn[k]));
      dual = Math.max(dual, Math.abs(zn[k] - z[k]));
    }
    z = zn;
    if (primal < 0.01 && dual < 0.001) break;
  }
  return free.map((f, k) => clamp(f + d[k], lo[k], hi[k]));
}

/** Minimal shift (1-D) that brings [a, a + len) inside [lo, hi) — 0 when inside, centred when it cannot fit. */
function shiftInto(a: number, len: number, lo: number, hi: number): number {
  if (len >= hi - lo) return a + len / 2 - (lo + hi) / 2;
  if (a < lo) return a - lo;
  if (a + len > hi) return a + len - hi;
  return 0;
}

/**
 * Reframing of the vertical and square variants: the centre (source CSS px) of the crop shown in the layout's
 * screen rect, per output frame of a run (contiguous clips: the track never crosses a cut).
 *
 * 1. What must be seen at each frame: the cursor (its arrow + ripple box, while visible), the active step's target
 *    (from `look_ahead_s` before the step starts to its end) and the overlay anchors; their union when it fits in the
 *    view, else the hard boxes, else the cursor alone (the view then follows the cursor towards the target). While
 *    the camera zooms, its focus is kept in view too.
 * 2. Dead zone: the target centre only moves when that region leaves the view inset by `dead_zone`; it then moves by
 *    the smallest shift that brings it back, plus half the slack (no re-targeting for small motions: no jitter).
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
}): Array<[number, number]> {
  const { times, camera, cursor, crop, css } = opts;
  const n = times.length;
  if (n === 0) return [];
  const targets = [...(opts.targets ?? [])].sort((a, b) => a.t0 - b.t0);
  const R = REFRAME;
  const viewAt = (k: number) => {
    const z = Math.max(1, camera[k]?.[0] ?? 1);
    return { w: Math.min(css.w, crop.w / z), h: Math.min(css.h, crop.h / z) };
  };
  const boxAt = (t: number): Box | null => {
    const c = cursorAt(cursor, t);
    if (!c || !c.visible) return null;
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
  /** What should be seen at frame k: hard boxes first, then the cursor (and where it goes), then soft targets. */
  const roiAt = (k: number, active: ReframeTarget[], hk: Box[], cb: Box | null): Box | null => {
    const v = viewAt(k);
    let roi: Box | null = null;
    const add = (b: Box) => {
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
  const cur: Array<Box | null> = [];
  const hard: Box[][] = [];
  const wantX: number[] = [];
  const wantY: number[] = [];
  // A calm start: the first frames are framed on what the first step needs (its target with the resting cursor), so
  // the view does not travel during the scene's opening still; without a target soon, on the cursor.
  const c0 = cursorAt(cursor, times[0]);
  let ax = c0 && c0.visible ? c0.x : css.w / 2;
  let ay = c0 && c0.visible ? c0.y : css.h / 2;
  const kFirst = times.findIndex((t, k) => t - times[0] <= R.calm_start_s && activeAt(k).length > 0);
  if (kFirst >= 0) {
    const act = activeAt(kFirst);
    const roi = roiAt(kFirst, act, act.filter((g) => g.hard).map((g) => g.box), cursorBox(kFirst));
    if (roi) {
      ax = roi.x + roi.w / 2;
      ay = roi.y + roi.h / 2;
    }
  }
  {
    const v = viewAt(0);
    ax = clamp(ax, v.w / 2, css.w - v.w / 2);
    ay = clamp(ay, v.h / 2, css.h - v.h / 2);
  }
  for (let k = 0; k < n; k++) {
    const v = viewAt(k);
    const cb = cursorBox(k);
    cur.push(cb);
    const active = activeAt(k);
    const hk = active.filter((g) => g.hard && fits(g.box, v)).map((g) => g.box);
    hard.push(hk);
    const roi = roiAt(k, active, hk, cb);
    if (roi) {
      const r: Box = roi;
      const ix = v.w * R.dead_zone;
      const iy = v.h * R.dead_zone;
      const sx = shiftInto(r.x, r.w, ax - v.w / 2 + ix, ax + v.w / 2 - ix);
      const sy = shiftInto(r.y, r.h, ay - v.h / 2 + iy, ay + v.h / 2 - iy);
      if (sx !== 0) ax += sx + Math.sign(sx) * Math.max(0, (v.w - 2 * ix - r.w) / 2);
      if (sy !== 0) ay += sy + Math.sign(sy) * Math.max(0, (v.h - 2 * iy - r.h) / 2);
      ax = clamp(ax, v.w / 2, css.w - v.w / 2);
      ay = clamp(ay, v.h / 2, css.h - v.h / 2);
    }
    wantX.push(ax);
    wantY.push(ay);
  }

  // 3–4. Smoothing, then the smoothest repair that keeps what must be seen in view.
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
      const range = (a: number, len: number, size: number, bounds: [number, number]): [number, number] => {
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
      };
      const rx = range(box.x, box.w, v.w, bx);
      const ry = range(box.y, box.h, v.h, by);
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
  const reach = R.repair_s * opts.outFps;
  const xs = corridorSmooth(dampedSmooth(wantX, opts.outFps, R.tau_s), loX, hiX, reach);
  const ys = corridorSmooth(dampedSmooth(wantY, opts.outFps, R.tau_s), loY, hiY, reach);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) out.push([round(clamp(xs[k], loX[k], hiX[k]), 2), round(clamp(ys[k], loY[k], hiY[k]), 2)]);
  return out;
}
