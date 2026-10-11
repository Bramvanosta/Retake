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
  /** "<scenario>-v<N>" (+ "-vertical"), or the base name of an explicit `out` file. */
  id: string;
  project: string;
  scenario: string;
  run_id: string;
  /** Absolute run directory. */
  run_dir: string;
  /** Theme (template name) the plan was made with. */
  template: string;
  overrides: EditOverrides;
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
  encoding: { codec: 'h264'; crf: number; pixel_format: 'yuv420p'; faststart: true; audio: 'silent' | 'music' };
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
