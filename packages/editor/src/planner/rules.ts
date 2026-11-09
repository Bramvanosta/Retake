/** The planner's fixed values: lengths, windows and defaults the steps of `planEdit` share. */
import type { OverlayAnchor } from '@retake/core';

/** Seconds before the end of a clip during which an overlay still counts as "showing" for a tap-open anchor. */
export const ANCHOR_OVERLAY_WINDOW_S = 1;

/** Defaults of a music bed (base volume, multiplier under footage and its ramp, fades, loop seams). */
export const MUSIC_DEFAULTS = { volume: 0.6, duck: 0.5, duck_ramp_s: 0.5, fadeIn_s: 1, fadeOut_s: 2, loop: true, crossfade_s: 1 } as const;
/** Two scenes are contiguous in the capture when the second starts within this many seconds of the first's end. */
export const CONTIGUOUS_GAP_S = 0.1;
/**
 * A page change (a URL segment) this long before a held load's start belongs to that load (R-ISS-08): both come from
 * the same commit, through two event listeners (measured 1 ms apart).
 */
export const LOAD_START_SLACK_S = 0.05;

/**
 * The theme default zoom (motion.default_zoom, style_bias balanced / motion — R-ED-22): a very slow zoom-in on the first
 * marked step's target of a scene, held, and eased back out before the scene ends.
 */
export const DEFAULT_ZOOM = {
  /** Ease-in length (output s): as slow as the scene allows, up to this. */
  in_max_s: 4,
  /** Shortest ease-in that still reads as a slow zoom; a scene with less room gets none (a note says so). */
  in_min_s: 1.5,
  /** Ease-out back to the full view, ending with the scene's own frames (its last frame is at 1×). */
  out_s: 1.6,
  out_min_s: 0.8,
  /** Share of the room left after the mark that the ease-in may take. */
  in_share: 0.5,
} as const;

/** Overlays keep a step's targets clear from this many capture seconds before the step starts (the next click). */
export const CLEAR_LOOKAHEAD_S = 1.2;

/** Seconds around a click during which the clicked target must stay fully in view of a reframed variant. */
export const REFRAME_CLICK_WINDOW_S = { before: 0.35, after: 0.5 } as const;

/**
 * Where a file overlay placed at a position of the screen may move to keep clear of the step's targets (the planner's
 * per-variant check): a corner to another corner, a top / bottom side to the other, a left / right side to the other.
 * The centre stays (a note when it covers a target).
 */
export const SCREEN_POSITION_CHOICES: Partial<Record<OverlayAnchor, readonly OverlayAnchor[]>> = {
  'top-left': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  'top-right': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  'bottom-left': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  'bottom-right': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  top: ['top', 'bottom'],
  bottom: ['top', 'bottom'],
  left: ['left', 'right'],
  right: ['left', 'right'],
  center: ['center'],
};
