/**
 * The comments context's types (@retake/core/comments): a frame comment's anchor and the comments folder.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */
import type { ComponentId } from './model.js';

/**
 * Where a frame comment points in the edit, computed from the render's edit plan when the comment is made (review
 * `frameAnchor`). A frame belongs to the last step that started at or before its capture frame; a step shorter than one
 * capture frame (a satisfied wait) owns none; inside a marker window (`mark:` step, from its start to its `done` frame)
 * the anchor names the marked step.
 */
export interface FrameCommentAnchor {
  /** Edit plan segment id ("intro", a scene id, "interstitial-1", "card-2", a card's `id:`…). */
  segment: string;
  /** Segment kind: intro, outro, clip, card, interstitial. */
  kind: 'intro' | 'outro' | 'clip' | 'card' | 'interstitial';
  /**
   * Component id rendering the commented area: the segment's component (a clip's layout), or the clip's caption
   * component when the region's centre lies on the caption's box (the band over the screen for a caption drawn over
   * it) while a cue shows.
   */
  component?: ComponentId;
  /** With a region: where its centre lies (`card`: a full-screen segment — intro, outro, card, interstitial). */
  area?: 'screen' | 'caption' | 'brandmark' | 'card';
  scene?: string;
  /** 0-based step index in the scene. */
  step?: number;
  step_id?: string;
  /** "<scene>.<step_id|index>": the `--until` / `page_inspect {until}` syntax. */
  step_ref?: string;
  /**
   * The step's fingerprint in the run's scenario snapshot (core `stepFingerprint`: its action and arguments, modifiers
   * left out) and its occurrence among the scene's steps with that fingerprint (0-based): finds the step again once
   * steps were inserted or moved.
   */
  step_fp?: string;
  step_fp_n?: number;
  /** The step's action (`scene_still` / `scene_open`: the opening of the scene, no step). */
  action?: string;
  /** Multi-page clips: the acting page at the frame. */
  page?: string;
  /** Capture time (seconds) under the commented frame, for clips. */
  src_time_s?: number;
  /** The marker whose window holds the frame (its marked step is then the anchor's step). */
  marker?: string;
  /** Component ids of the overlays on screen at the frame (no hit-testing). */
  overlays?: ComponentId[];
  /** The transition covering the frame (segment ids on each side; the frame counts with the incoming segment). */
  transition?: { kind: 'crossfade' | 'fade-black'; from?: string; to?: string };
}

/** Folder of a project holding the frame comments: `comments/<scenario>/c_<ULID>.json`, one file per thread. */
export const COMMENTS_DIR = 'comments';
