/**
 * What the screen did after each click (L5.7, R-FLD-23, R-FLD-26), from a 96×54 grey copy of every output frame of
 * capture.mp4 (the encoder fed during the take writes it: stream.ts `onThumb`). Each frame is compared with the one
 * before on a grid of 16 × 9 cells (a cell changed when at least CELL_MIN_PIXELS of its pixels moved by more than
 * PIXEL_DELTA grey levels). Cells around the in-page cursor and its click ripples, and cells that change all the time
 * (an animated widget), are left out. Then, for every click:
 * - its transition: from the press to the last change of the screen once it reacted (BIG_CELLS cells at once, or a page
 *   load held by the recorder) and then stood still for QUIET_S with nothing big coming later — while the runner waits
 *   for its next target (until the cursor moves on, the next press or TRANSITION_MAX_S), or within LATE_S of the last
 *   change during an explicit pause (a hold: a toast leaving later is not the click's);
 * - its waits: runs of near-identical frames (at most SMALL_CELLS cells changing: a spinner, a shimmering skeleton, a
 *   blank panel) of BUSY_MIN_S or more inside the transition, that end with the content appearing (BIG_CELLS cells at
 *   once) — the edit shortens them.
 * Pure but for `ActivityRecorder`, which only stores 18 bytes a frame.
 */
import type { CursorEffect, CursorSample, TimelineBusy, TimelineEvent, TimelineLoading } from '@retake/core/model';
import { THUMB_H, THUMB_W } from './stream.js';
import { round3 } from './util.js';

export const CELLS_X = 16;
export const CELLS_Y = 9;
const CELL_W = THUMB_W / CELLS_X;
const CELL_H = THUMB_H / CELLS_Y;
const MASK_BYTES = Math.ceil((CELLS_X * CELLS_Y) / 8);
/** A pixel changed when its grey level moved by more than this (JPEG and H.264 noise stay below). */
export const PIXEL_DELTA = 12;
/** A cell changed when at least this many of its 36 pixels did. */
export const CELL_MIN_PIXELS = 2;
/** A click's result is settled once the screen stood still this long. */
export const QUIET_S = 0.5;
/**
 * After the screen reacted and stood still for QUIET_S, content that appears this long after the last change still
 * belongs to the click (a panel that waits for its data without any motion); later changes do not (a toast leaving).
 */
export const LATE_S = 1.5;
/** The runner moves on (or presses again) as soon as it sees its next target in the DOM: its paint comes up to this later. */
const PAINT_SLACK_S = 0.2;
/** A transition is measured at most this long after its press. */
export const TRANSITION_MAX_S = 15;
/** Transitions longer than this are slow (R-FLD-23). */
export const SLOW_TRANSITION_MS = 800;
/** Near-identical frames: at most this many cells change (a spinner, a skeleton's shimmer). */
export const SMALL_CELLS = 2;
/** The content appearing: this many cells change at once. */
export const BIG_CELLS = 3;
/** Waits shorter than this are left alone. */
export const BUSY_MIN_S = 0.6;
/** The press's own feedback (the button's pressed state, the ripple) is not a wait. */
const PRESS_FEEDBACK_S = 0.15;
/** A cell changing in this share of the frames is animated content, not a reaction. */
const BACKGROUND_SHARE = 0.25;
/** Around the cursor and a ripple, in CSS px (the kit draws a 26 px cursor and a ripple up to ≈ 70 px across). */
const CURSOR_BOX = { l: 16, t: 16, r: 44, b: 48 };
const RIPPLE_R = 48;
const RIPPLE_S = 0.6;

/** Changed-cell bitmask of `cur` against `prev` (two THUMB_W × THUMB_H grey frames). */
export function cellMask(prev: Uint8Array, cur: Uint8Array): Uint8Array {
  const out = new Uint8Array(MASK_BYTES);
  for (let cy = 0; cy < CELLS_Y; cy++) {
    for (let cx = 0; cx < CELLS_X; cx++) {
      let n = 0;
      for (let y = cy * CELL_H; y < (cy + 1) * CELL_H && n < CELL_MIN_PIXELS; y++) {
        const row = y * THUMB_W;
        for (let x = cx * CELL_W; x < (cx + 1) * CELL_W; x++) {
          if (Math.abs(cur[row + x] - prev[row + x]) > PIXEL_DELTA && ++n >= CELL_MIN_PIXELS) break;
        }
      }
      if (n >= CELL_MIN_PIXELS) {
        const i = cy * CELLS_X + cx;
        out[i >> 3] |= 1 << (i & 7);
      }
    }
  }
  return out;
}

/** Collects the changed-cell masks of the output frames, in order (frame 0: nothing changed). */
export class ActivityRecorder {
  readonly masks: Uint8Array[] = [];
  private prev: Uint8Array | null = null;

  add(n: number, gray: Uint8Array): void {
    if (gray.length < THUMB_W * THUMB_H) return;
    while (this.masks.length < n) this.masks.push(new Uint8Array(MASK_BYTES));
    this.masks[n] = this.prev ? cellMask(this.prev, gray) : new Uint8Array(MASK_BYTES);
    this.prev = gray;
  }
}

export interface ActivityClick {
  t: number;
  scene: string;
  step: number;
  target?: string;
}

export interface ActivityInput {
  masks: readonly Uint8Array[];
  fps: number;
  /** Viewport in CSS px (the cells' scale). */
  width: number;
  height: number;
  cursor: readonly CursorSample[];
  effects?: readonly CursorEffect[];
  events: readonly TimelineEvent[];
  /** Page loads the recorder held (the frozen frame is not a wait the edit shortens: it cuts the load itself). */
  loading?: readonly TimelineLoading[];
}

export interface ActivityResult {
  /** Clicks measured, and every transition (ms) with its click. */
  transitions: Array<ActivityClick & { ms: number }>;
  busy: TimelineBusy[];
}

function bit(mask: Uint8Array, i: number): boolean {
  return (mask[i >> 3] & (1 << (i & 7))) !== 0;
}

/** Cells (indexes) a CSS-px box touches. */
function cellsOf(l: number, t: number, r: number, b: number, w: number, h: number): number[] {
  const out: number[] = [];
  const x0 = Math.max(0, Math.floor((l / w) * CELLS_X));
  const x1 = Math.min(CELLS_X - 1, Math.floor((r / w) * CELLS_X));
  const y0 = Math.max(0, Math.floor((t / h) * CELLS_Y));
  const y1 = Math.min(CELLS_Y - 1, Math.floor((b / h) * CELLS_Y));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * CELLS_X + x);
  return out;
}

/** The clicks of a capture: pointer steps that pressed (their press time), in order. */
export function clicksOf(events: readonly TimelineEvent[]): ActivityClick[] {
  return events
    .filter((e) => e.step >= 0 && typeof e.t_click === 'number' && e.status !== 'skipped')
    .map((e) => ({ t: e.t_click!, scene: e.scene, step: e.step, ...(e.target?.desc ? { target: e.target.desc } : {}) }))
    .sort((a, b) => a.t - b.t);
}

/** See the module comment. Pure. */
export function analyzeActivity(input: ActivityInput): ActivityResult {
  const { masks, fps, width, height } = input;
  const n = masks.length;
  if (!n || !(fps > 0)) return { transitions: [], busy: [] };
  // Cells the cursor or a ripple covers in each frame (and the frame before: the cursor left that place).
  const masked: Array<Set<number> | undefined> = new Array(n);
  const cover = (k: number, cells: number[]) => {
    if (k < 0 || k >= n) return;
    const s = (masked[k] ??= new Set<number>());
    for (const c of cells) s.add(c);
  };
  const cursor = input.cursor.filter((s) => s.visible);
  for (let i = 0; i < cursor.length; i++) {
    const s = cursor[i];
    const until = i + 1 < cursor.length ? cursor[i + 1].t : s.t + 1 / fps;
    const cells = cellsOf(s.x - CURSOR_BOX.l, s.y - CURSOR_BOX.t, s.x + CURSOR_BOX.r, s.y + CURSOR_BOX.b, width, height);
    for (let k = Math.floor(s.t * fps); k <= Math.min(n - 1, Math.ceil(until * fps) + 1); k++) cover(k, cells);
  }
  for (const e of input.effects ?? []) {
    if (e.type !== 'ripple' || typeof e.x !== 'number' || typeof e.y !== 'number') continue;
    const cells = cellsOf(e.x - RIPPLE_R, e.y - RIPPLE_R, e.x + RIPPLE_R, e.y + RIPPLE_R, width, height);
    for (let k = Math.floor(e.t * fps); k <= Math.ceil((e.t + RIPPLE_S) * fps); k++) cover(k, cells);
  }
  // Animated content: cells changing in a large share of the frames.
  const counts = new Array<number>(CELLS_X * CELLS_Y).fill(0);
  for (let k = 0; k < n; k++) for (let c = 0; c < CELLS_X * CELLS_Y; c++) if (bit(masks[k], c) && !masked[k]?.has(c)) counts[c]++;
  const background = new Set(counts.map((v, c) => (v >= BACKGROUND_SHARE * n ? c : -1)).filter((c) => c >= 0));
  /** Cells that changed in frame k, outside the cursor and animated content. */
  const changed = (k: number): number => {
    let m = 0;
    for (let c = 0; c < CELLS_X * CELLS_Y; c++) if (bit(masks[k], c) && !background.has(c) && !masked[k]?.has(c)) m++;
    return m;
  };
  const activity = Array.from({ length: n }, (_, k) => changed(k));

  const clicks = clicksOf(input.events);
  // Explicit pauses: a step's hold, a `hold` or `wait` step (capture seconds of their start).
  const pauses = input.events
    .flatMap((e) => (e.step < 0 ? [] : [...(e.hold && e.hold.t_end > e.hold.t_start ? [e.hold.t_start] : []), ...((e.action === 'hold' || e.action === 'wait') && e.t_end > e.t_start ? [e.t_start] : [])]))
    .sort((a, b) => a - b);
  const moves = cursor.map((s) => s);
  const transitions: ActivityResult['transitions'] = [];
  const busy: TimelineBusy[] = [];
  const quiet = Math.round(QUIET_S * fps);
  const late_ = Math.round(LATE_S * fps);
  const loads = (input.loading ?? []).map((l) => [Math.floor(l.t_start * fps), Math.ceil(l.t_end * fps)] as const);
  const held = (k: number) => loads.some(([a, b]) => k >= a && k < b);
  for (let i = 0; i < clicks.length; i++) {
    const click = clicks[i];
    // The cursor moves on: the first sample 3 px away from where it pressed.
    const at = [...moves].reverse().find((s) => s.t <= click.t + 1e-6);
    const moved = at ? moves.find((s) => s.t > click.t && Math.hypot(s.x - at.x, s.y - at.y) >= 3) : undefined;
    // The content that let the runner move on reaches the screen a frame or two after it saw it in the DOM.
    const end = Math.min((clicks[i + 1]?.t ?? Infinity) + PAINT_SLACK_S, (moved?.t ?? Infinity) + PAINT_SLACK_S, click.t + TRANSITION_MAX_S, (n - 1) / fps);
    // Until the cursor moves on, the runner waits for its next target (the content the click asked for); an explicit
    // pause (a hold, a wait) is the viewer looking at the result: only LATE_S after the last change there.
    const pause = pauses.find((t) => t > click.t + 1e-6);
    const waitUntil = Math.floor(Math.min(end, pause ?? Infinity) * fps);
    const k0 = Math.ceil(click.t * fps);
    const k1 = Math.floor(end * fps);
    if (k1 <= k0) continue;
    let last = k0;
    let reacted = false;
    for (let k = k0 + 1; k <= k1; ) {
      const a = activity[k];
      // A page load the recorder holds is the transition going on (its frozen frame changes nothing).
      if (a > 0 || held(k)) {
        last = k;
        if (a >= BIG_CELLS) reacted = true;
      } else if (reacted && k - last >= quiet) {
        // Still since the reaction: settled — unless the content comes a moment later (a wait without any motion).
        let late = -1;
        for (let j = k + 1; j <= Math.min(k1, Math.max(waitUntil, last + late_)); j++) {
          if (activity[j] >= BIG_CELLS) {
            late = j;
            break;
          }
        }
        if (late < 0) break;
        k = late;
        continue;
      }
      k++;
    }
    transitions.push({ ...click, ms: Math.max(0, Math.round((last / fps - click.t) * 1000)) });
    // Waits inside it: near-identical runs that end with the content appearing.
    let runStart = -1;
    for (let k = Math.ceil((click.t + PRESS_FEEDBACK_S) * fps); k <= last; k++) {
      const a = activity[k];
      if (a <= SMALL_CELLS) {
        if (runStart < 0) runStart = k;
        continue;
      }
      if (runStart >= 0 && a >= BIG_CELLS && (k - runStart) / fps >= BUSY_MIN_S) {
        const span = { t_start: round3(runStart / fps), t_end: round3(k / fps), click: round3(click.t) };
        if (!(input.loading ?? []).some((l) => l.t_start < span.t_end && l.t_end > span.t_start)) busy.push(span);
      }
      runStart = -1;
    }
  }
  return { transitions, busy };
}

/** The slow transitions (over SLOW_TRANSITION_MS), slowest first. */
export function slowTransitions(t: ActivityResult['transitions']): ActivityResult['transitions'] {
  return t.filter((x) => x.ms > SLOW_TRANSITION_MS).sort((a, b) => b.ms - a.ms);
}
