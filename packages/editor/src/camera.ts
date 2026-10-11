/**
 * Camera of a run (zooms from step `camera` hints, eased in output time, view clamped to the capture) and the
 * smoothed reframe track of the vertical variant. Pure.
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
  ease: Bezier;
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
    list.push({ qa: outAt, qb: outAt + mv.frames, from: to, to: rest, ease });
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

/** Moving average over a centred window (edges use the frames available). */
function smooth(values: number[], window: number): number[] {
  if (window <= 1 || values.length === 0) return values.slice();
  const half = Math.floor(window / 2);
  const prefix = [0];
  for (const v of values) prefix.push(prefix[prefix.length - 1] + v);
  return values.map((_, i) => {
    const a = Math.max(0, i - half);
    const b = Math.min(values.length, i + half + 1);
    return (prefix[b] - prefix[a]) / (b - a);
  });
}

/**
 * Vertical reframing: the centre (source CSS px) of the crop shown in the vertical screen rect, per output frame of a
 * run. Follows the camera focus while zoomed, else the cursor; moves only when the point leaves a dead zone (20 % of
 * the crop), then is smoothed (two centred moving averages of ~0.8 s) and clamped so the crop stays in the capture.
 */
export function reframeTrack(opts: {
  /** Capture time (s) of every output frame. */
  times: readonly number[];
  camera: readonly CameraFrame[];
  cursor: Timeline['cursor'];
  crop: { w: number; h: number };
  css: { w: number; h: number };
  outFps: number;
}): Array<[number, number]> {
  const { times, camera, cursor, crop, css } = opts;
  const n = times.length;
  if (n === 0) return [];
  let anchor = { x: css.w / 2, y: css.h / 2 };
  const first = cursor.find((s) => s.visible);
  if (first) anchor = { x: first.x, y: first.y };
  let raw = anchor;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < n; k++) {
    const cam = camera[k];
    if (cam && cam[0] > 1.001) raw = { x: cam[1], y: cam[2] };
    else {
      const c = cursorAt(cursor, times[k]);
      if (c && c.visible) raw = { x: c.x, y: c.y };
    }
    if (Math.abs(raw.x - anchor.x) > 0.2 * crop.w || Math.abs(raw.y - anchor.y) > 0.2 * crop.h) anchor = raw;
    xs.push(anchor.x);
    ys.push(anchor.y);
  }
  const win = Math.max(1, Math.round(0.8 * opts.outFps));
  const sx = smooth(smooth(xs, win), win);
  const sy = smooth(smooth(ys, win), win);
  return sx.map((x, k) => [
    round(clamp(x, crop.w / 2, css.w - crop.w / 2), 2),
    round(clamp(sy[k], crop.h / 2, css.h - crop.h / 2), 2),
  ]);
}
