/** The input and output shapes of a run's time map (`planRunTiming`). */
import type { TimelineEvent } from '@retake/core/run';
import type { Interval } from './util.js';

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
   * Freezes of the capture (`timeline.stalls`: no new frame while the cursor moved or a click ripple played —
   * R-ISS-12's dialog close): with `trimIdle`, cut whole but their first frame, inside protected spans too.
   */
  frozen?: ReadonlyArray<{ t_start: number; t_end: number }>;
  /**
   * Waits the screen showed after a click (`timeline.busy`, R-FLD-26: skeletons, spinners, blank panels): with
   * `trimIdle`, shortened like idle gaps — outside protected spans, keeping BUSY_KEEP_BEFORE_S of the wait and
   * BUSY_KEEP_AFTER_S before the content appears.
   */
  busy?: ReadonlyArray<{ t_start: number; t_end: number }>;
  /**
   * Spans the take played off camera (`hookSpans`: the `hook:` steps): cut whole, always — idle trimming on or
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
   * step, run off camera, cut whole.
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
