/**
 * Review contract (docs/DESIGN-phase2.md §3): what `reviewRender` writes and returns, the findings and the rules
 * (thresholds) of the checks.
 */
import type { LoadedProject, ErrorKind, WorkPolicy } from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import type { PlanSegment, RenderRecord } from '@retake/editor/plan';

export type Severity = 'error' | 'warning' | 'info';

/** Where a finding is: output frame/time, plan segment, scenario scene and step. */
export interface FindingAt {
  /** Output frame (0-based). */
  frame?: number;
  /** Output seconds. */
  time?: number;
  /** Plan segment id ("intro", a scene id, "interstitial-3", "outro"). */
  segment?: string;
  /** Scenario scene id. */
  scene?: string;
  /** Step index within the scene (-1 = the scene's opening still). */
  step?: number;
}

/**
 * Every code a check of this package writes (a test keeps it complete): what a reader outside the CLI (review_get) may
 * show as a code — anything else in a report.json was not written by a check.
 */
export const FINDING_CODES: ReadonlySet<string> = new Set([
  'artefact-before-step', 'blank-scene-start', 'blank-screen', 'camera-jump', 'caption-missing', 'caption-not-visible', 'caption-overlap',
  'caption-overlaps-brandmark', 'caption-scene-mismatch', 'caption-shrunk', 'caption-too-long', 'caption-truncated',
  'capture-missing', 'capture-unreadable', 'card-too-short', 'component-missing', 'cursor-hidden', 'cursor-offscreen',
  'cursor-outside-reframe', 'cursor-outside-view', 'diff-duration', 'diff-frames', 'diff-segment',
  'duration-mismatch', 'empty-segment', 'frames-missing', 'loading-scene-start', 'local-url-text', 'long-scene',
  'long-wait', 'media-missing', 'near-uniform-screen', 'overlay-covers-target', 'plan-warning',
  'previous-unreadable', 'reframe-jump', 'registry-unavailable', 'render-failed', 'scene-length', 'scene-too-short',
  'size-mismatch', 'slow-transition', 'target-cut', 'target-outside-view', 'text-slot-empty', 'text-slot-overflow', 'theme-zoom-count',
  'theme-zoom-cut', 'theme-zoom-real', 'timeline-missing', 'transition-on-click', 'tutorial-skipped',
  'tutorial-stale-target', 'tutorial-target-cut', 'url-hidden', 'video-length', 'write-blocked', 'zoom-clamped',
  'zoom-count', 'zoom-not-slow', 'zoom-reset'
]);

export interface Finding {
  severity: Severity;
  /** Stable kebab-case code (see FINDING_CODES). */
  code: string;
  message: string;
  at?: FindingAt;
}

/** Thresholds of the checks; defaults from docs/reference/look.md and DESIGN-phase2 §3. */
export interface ReviewRules {
  /** Target video length, seconds (look.md: 1–2 min). Outside: info; outside by more than `video_tolerance`: warning. */
  video_min_s: number;
  video_max_s: number;
  /** Fraction of the target range a video may miss by before the length is a warning (0.25: 45 s – 150 s). */
  video_tolerance: number;
  /**
   * Where the target length comes from: the reference look (default) or the scenario's `target_length` (R-FLD-05,
   * L5.5: the plan carries it; rules passed by the caller win).
   */
  video_target?: 'reference' | 'scenario';
  /** Target scene length, seconds (look.md: 4–25 s); outside: info. */
  scene_min_s: number;
  scene_max_s: number;
  /** A scene shorter than this is a warning (too short to read its caption). */
  scene_too_short_s: number;
  /** A scene longer than this at about 1× (see `normal_speed`) is a warning. */
  long_scene_s: number;
  /** Mean speeds in this range count as "about 1×". */
  normal_speed: [number, number];
  /** Camera zooms per video (look.md: at most one very slow zoom). */
  max_zooms: number;
  /** A zoom is "very slow" when its ease-in lasts at least this long and its factor is at most `slow_zoom_max`. */
  slow_zoom_min_s: number;
  slow_zoom_max: number;
  /** Captions shrunk below this fraction of the theme size are "too long" (fitText). */
  caption_min_scale: number;
  /** Floor of the caption shrink before the text is cut (caption-below: 62 %). */
  caption_floor_scale: number;
  /** Blank detection: share of the region within a few levels of its median colour… */
  uniform_share: number;
  /** …or a luminance standard deviation below this. */
  uniform_sd: number;
  /** Near-uniform (a loading page, a spinner on an empty page): share above this. */
  near_uniform_share: number;
  /** Cards, intro, outro, interstitials: a frame is empty when this share of it is one colour (text is small there). */
  empty_share: number;
  /** Blank runs at least this long (seconds) are errors; shorter ones warnings. */
  blank_error_s: number;
  /** A screen that changes this much during the scene's opening still was still loading (share of changed cells). */
  still_change_share: number;
  /** Waiting steps (wait, wait_for) showing an unchanging screen (a loading state) this long, seconds: warning. */
  long_wait_s: number;
  /** Diff: a sample frame changed when this share of its cells moved by more than a few levels. */
  diff_change_share: number;
  /** Seconds around a click (before, after) that a transition must not cover. */
  click_window_s: [number, number];
  /** Reframed variants (vertical, square): largest move of the crop between two frames, share of the crop width. */
  reframe_max_step: number;
  /** …and largest change of that move between two frames (a jolt), share of the crop width. */
  reframe_max_accel: number;
}

export const DEFAULT_RULES: Readonly<ReviewRules> = Object.freeze({
  video_min_s: 60,
  video_max_s: 120,
  video_tolerance: 0.25,
  scene_min_s: 4,
  scene_max_s: 25,
  scene_too_short_s: 2,
  long_scene_s: 30,
  normal_speed: [0.85, 1.2] as [number, number],
  max_zooms: 1,
  slow_zoom_min_s: 3,
  slow_zoom_max: 1.2,
  caption_min_scale: 0.85,
  caption_floor_scale: 0.62,
  uniform_share: 0.985,
  uniform_sd: 3,
  near_uniform_share: 0.95,
  empty_share: 0.998,
  blank_error_s: 1,
  still_change_share: 0.02,
  long_wait_s: 3,
  diff_change_share: 0.01,
  click_window_s: [0.2, 0.4] as [number, number],
  reframe_max_step: 0.06,
  reframe_max_accel: 0.015,
});

export interface ReviewOptions {
  /** What the work runs under (core WorkPolicy): which ffmpeg and ffprobe, under its agent policy. */
  policy: WorkPolicy;
  /** A loaded project, or a project slug / directory (resolved in `root`). */
  project: LoadedProject | string;
  /** Workspace root (when `project` is a slug); default: the project's root. */
  root?: string;
  /** Render id ("catalogue-v3"), a render record (.json) or video (.mp4) path, or "latest". */
  render: string;
  /** With "latest": the latest render of this scenario. */
  scenario?: string;
  /** Contact sheet rate (default 1 frame per second). Per-scene sheets are always 2 fps. */
  fps?: 1 | 2;
  /** Render to compare with: an id, `false` for none; default the previous render of the same scenario. */
  previous?: string | false;
  /** Base64 thumbnails returned: the contact sheet pages + marker key frames (default), everything, or none. */
  thumbnails?: false | 'sheets' | 'all';
  /** Long side of the returned thumbnails, px (≤ 1280, default 1280). */
  thumbnail_px?: number;
  /** Write the review here instead of `<project>/review/<render-id>/`. */
  out?: string;
  rules?: Partial<ReviewRules>;
  /** Component registry (read for slot limits); loaded from the workspace when absent. */
  registry?: ComponentRegistry;
  /** Contact sheet grid (default 6 columns × 10 rows, 300 px tiles). */
  sheet?: Partial<SheetLayout>;
  onProgress?: (p: ReviewProgress) => void;
  /**
   * Cancels the review: checked between its stages, and the ffmpeg decoding a video is killed at once. A cancelled
   * review throws ReviewCancelledError and leaves the previous review of the render as it was.
   */
  signal?: AbortSignal;
}

/** A review stopped by its signal (nothing replaced the previous review). */
export class ReviewCancelledError extends Error {
  constructor(message = 'review cancelled') {
    super(message);
    this.name = 'ReviewCancelledError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'cancelled';
  }
}

export interface SheetLayout {
  columns: number;
  rows: number;
  /** Tile width, px (height from the video aspect). */
  tile: number;
}

export const DEFAULT_SHEET: Readonly<SheetLayout> = Object.freeze({ columns: 6, rows: 10, tile: 300 });

export interface ReviewProgress {
  stage: 'loading' | 'frames' | 'capture' | 'previous' | 'checks' | 'sheets' | 'writing' | 'done';
  /** 0..1 within the stage, when known. */
  progress?: number;
  message?: string;
}

/** One image returned to the MCP: a JPEG ≤ thumbnail_px on its long side. */
export interface ReviewThumbnail {
  /** "sheet_1fps", "sheet_1fps_p2", "keyframe:reveal", "sheet_scene_import"… */
  name: string;
  /** The full-size file it was made from. */
  file: string;
  mime: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  base64: string;
}

export interface SegmentDuration {
  id: string;
  kind: PlanSegment['kind'];
  scene?: string;
  /** Output frames [from, to): to = the next segment's start (crossfades overlap: the overlap counts once). */
  from: number;
  to: number;
  from_s: number;
  to_s: number;
  duration_s: number;
  /** Clips: mean playback speed (source seconds per output second, held frames excluded). */
  speed?: number;
  component: string;
}

export interface DiffFrame {
  frame: number;
  time: number;
  segment: string;
  /** The frame of the previous render compared with (same segment, same offset). */
  previous_frame: number;
  /** Share of the frame's cells that changed. */
  changed: number;
}

export interface ReviewDiff {
  previous: string;
  previous_file: string;
  duration_s: { previous: number; current: number; delta: number };
  segments: Array<{
    id: string;
    status: 'same' | 'changed' | 'added' | 'removed';
    duration_delta_s?: number;
    previous_duration_s?: number;
    duration_s?: number;
    /** What changed besides pixels: component, caption, transition. */
    changes: string[];
  }>;
  template?: { previous: string; current: string };
  run?: { previous: string; current: string };
  /** Sample frames compared (same segment, same offset) and the ones that changed visibly. */
  compared: number;
  changed_frames: DiffFrame[];
  /** Side-by-side sheet of the changed frames (previous | current), when any. */
  sheet?: string;
}

export interface ReviewFiles {
  dir: string;
  /** Contact sheet pages (sheet_<fps>fps.jpg, sheet_<fps>fps_p2.jpg…). */
  sheets: string[];
  /** Per-scene sheets by segment id (pages). */
  scene_sheets: Record<string, string[]>;
  /** Key frames by name (marker names, "<segment>-first", "<segment>-last", "<segment>-hold"). */
  keyframes: Record<string, string>;
  timeline: string;
  report_json: string;
  report_md: string;
  diff_sheet?: string;
}

/** The run's environment as a review shows it (L1.7; from timeline.json `environment`). */
export interface ReviewEnvironment {
  name: string;
  production?: true;
  /** The run's access. */
  access: 'read-only' | 'read-write';
  /** Written to production with `--allow-writes`. */
  allow_writes?: true;
  clock?: { at: string; timezone?: string; freeze?: true };
  /** The display bases of the run's pages (what the browser bars show). */
  display?: string[];
  /** Writes the write guard saw (the automated sign-in's exempt ones excepted). */
  writes: { blocked: number; mocked: number; allowed: number; passed: number };
}

export interface ReviewResult {
  version: 1;
  render: {
    id: string;
    file: string;
    record: string;
    scenario: string;
    run_id: string;
    template: string;
    duration_s: number;
    frames: number;
    fps: number;
    width: number;
    height: number;
    variant: RenderRecord['variant'];
  };
  review: { created_at: string; fps: 1 | 2; ms: number; rules: ReviewRules };
  /** No error and no warning. */
  clean: boolean;
  counts: Record<Severity, number>;
  findings: Finding[];
  durations: { total_s: number; segments: SegmentDuration[] };
  /** The environment the run filmed (L1.7: access, production, clock, writes); absent for runs before it. */
  environment?: ReviewEnvironment;
  diff?: ReviewDiff;
  files: ReviewFiles;
  /** Not written to report.json. */
  thumbnails: ReviewThumbnail[];
}
