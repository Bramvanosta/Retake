/** Types of the render API (DESIGN-phase2 §2: renderVideo, renderStill, listRenders). */
import type { EditOverrides, EditPlan, PlanVariant } from '../plan-types.js';

/** A render that cannot start or failed (message written for the user). */
export class RenderError extends Error {
  constructor(
    message: string,
    /** The record of the failed/cancelled render (not written to disk). */
    readonly record?: RenderRecord,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/** The render was cancelled through its AbortSignal: nothing was written under the final name. */
export class RenderCancelledError extends RenderError {
  constructor(record?: RenderRecord) {
    super('render cancelled: no output written', record);
    this.name = 'CancelledError';
  }
}

export type RenderStage = 'planning' | 'bundling' | 'rendering' | 'encoding' | 'done';

export interface RenderProgress {
  stage: RenderStage;
  /** 0..1 within the stage. */
  progress: number;
  /** 0..1 over the whole render (bundling ≈ 0–10 %, rendering 10–95 %, encoding 95–100 %). */
  overall: number;
  totalFrames?: number;
  renderedFrames?: number;
  encodedFrames?: number;
  /** bundling: the bundle came from the cache. */
  cached?: boolean;
  /** Seconds left (rendering), when Remotion estimates it. */
  eta_s?: number;
}

/** renders/<id>.json: everything needed to reproduce, review and comment a render. */
export interface RenderRecord {
  version: 1;
  /** "<scenario>-v<N>" (+ "-vertical" / "-square"), or the base name of an explicit `out` file. */
  id: string;
  project: string;
  scenario: string;
  run_id: string;
  /** Absolute run directory. */
  run_dir: string;
  /** Theme (template name) the plan was made with. */
  template: string;
  /**
   * The theme folder's content hash at render time (theme-hash.ts; L4.5 fixes): the Studio's "from this version" needs
   * the same theme files. Absent in renders made before.
   */
  template_sha256?: string;
  overrides: EditOverrides;
  /**
   * Where the edit came from (L5.5): today's scenario file re-planned on the run (`scenario`, with the file's sha256
   * and what it changed against the run), or the run as captured (`run`). Absent in renders made before L5.5 (the run
   * as captured).
   */
  edit?: {
    from: 'scenario' | 'run';
    sha256?: string;
    changes?: string[];
    /** From `scenario`: each scene's caption texts as planned (its own and its steps'), which the review checks. */
    captions?: Record<string, string[]>;
  };
  variant: PlanVariant;
  status: 'succeeded' | 'failed' | 'cancelled';
  /** Absolute path of the video, and of this record. */
  file: string;
  record: string;
  /** Render version (absent with an explicit `out`). */
  render_version?: number;
  created_at: string;
  finished_at: string;
  /** Output duration, frames, fps and size (from the plan, checked against the file when ffprobe is available). */
  duration_s: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** File size in bytes. */
  size_bytes: number;
  /**
   * `audio`: what the audio track carries — `silent` (a silent AAC track), `music` (the bed), `files` (the own sound of
   * your files: a video intro, outro, card, interstitial or overlay, L2.12) or `music+files`.
   */
  encoding: { codec: 'h264'; crf: number; pixel_format: 'yuv420p'; faststart: true; audio: 'silent' | 'music' | 'files' | 'music+files' };
  /** What ffprobe saw in the file (when available). */
  probe?: { duration_s: number; frames?: number; width: number; height: number; fps: number; audio_streams: number; video_codec?: string; audio_codec?: string };
  concurrency: number;
  bundle: { hash: string; cached: boolean; ms: number };
  browser: { path: string | null; source: 'env' | 'playwright' | 'remotion' };
  timings: { plan_ms: number; bundle_ms: number; render_ms: number; total_ms: number };
  /** Plan warnings and render warnings. */
  warnings: string[];
  error?: string;
  /** The plan rendered (with its `ds-asset:` URLs). */
  plan: EditPlan;
}
