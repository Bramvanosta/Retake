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
  /** A failed render (renderPlan): the path it tried — the GPU path, its fallback and why (the record's `policy`). */
  path?: RenderRecord['policy'];
  /** A failed render (renderPlan): its warnings so far (a fallback's, a guard's blocked origins). */
  renderWarnings?: string[];
}

/** The render was cancelled through its AbortSignal: nothing was written under the final name. */
export class RenderCancelledError extends RenderError {
  constructor(record?: RenderRecord) {
    super('render cancelled: no output written', record);
    this.name = 'CancelledError';
  }
}

/**
 * The disk filled up during a render or a preview (ENOSPC): the work stopped there, nothing more was attempted. The
 * jobs worker turns it into "the disk has N MB free".
 */
export class RenderDiskFullError extends RenderError {
  constructor(detail: string) {
    super(`the disk is full (${detail})`);
    this.name = 'DiskFullError';
  }
}

/** An ENOSPC from Node (its `code`) or from a tool's message (ffmpeg, Chromium, Remotion). */
export function isDiskFullError(e: unknown): boolean {
  if (e instanceof RenderDiskFullError) return true;
  if (!e || typeof e !== 'object') return false;
  if ((e as { code?: unknown }).code === 'ENOSPC') return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && /\bENOSPC\b|no space left on device/i.test(message);
}

/** `retrying`: the GPU path failed and the video renders again in software (L5.15; progress does not go back). */
export type RenderStage = 'planning' | 'bundling' | 'rendering' | 'retrying' | 'encoding' | 'done';

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
  encoding: {
    codec: 'h264';
    /** The encoder used (L5.15; absent before it: libx264). */
    encoder?: 'libx264' | 'h264_videotoolbox';
    /** libx264's CRF (16). */
    crf?: number;
    /** VideoToolbox's bitrate ("8M": 0.13 bit per pixel per frame) and key-frame interval (2 s). */
    bitrate?: string;
    gop?: number;
    pixel_format: 'yuv420p';
    faststart: true;
    audio: 'silent' | 'music' | 'files' | 'music+files';
  };
  /**
   * The render policy (L5.15, editor policy.ts): the GL asked (and where from), the one this machine resolves it to and
   * the one that drew the video (re-read at the end), with the GPU's name; the encoder asked and used; whether the GPU
   * path failed and the video was rendered again in software (`fallback`; its `reason` quotes the failure: untrusted
   * text, shown only as text and kept under `untrusted` by the engine's views). A failed render's record says what
   * its last attempt tried. Absent before L5.15 (software, libx264).
   */
  policy?: {
    gl: { asked: 'auto' | 'gpu' | 'software'; source: 'option' | 'retake.yaml' | 'env' | 'default'; resolved: 'angle' | 'software'; used: 'angle' | 'software'; renderer?: string };
    encoder: { asked: 'auto' | 'videotoolbox' | 'libx264'; source: 'option' | 'retake.yaml' | 'env' | 'default'; used: 'libx264' | 'h264_videotoolbox' };
    concurrency_source: 'option' | 'retake.yaml' | 'env' | 'default';
    fallback?: { reason: string };
  };
  /** What ffprobe saw in the file (when available). */
  probe?: { duration_s: number; frames?: number; width: number; height: number; fps: number; audio_streams: number; video_codec?: string; audio_codec?: string };
  concurrency: number;
  bundle: { hash: string; cached: boolean; ms: number };
  browser: { path: string | null; source: 'env' | 'bundled' | 'playwright' | 'remotion' };
  /** `render_ms`: the last attempt's (after a fallback, the software render's; the GPU attempt's time is in `total_ms`). */
  timings: { plan_ms: number; bundle_ms: number; render_ms: number; total_ms: number };
  /** Plan warnings and render warnings. */
  warnings: string[];
  error?: string;
  /** The plan rendered (with its `ds-asset:` URLs). */
  plan: EditPlan;
}
