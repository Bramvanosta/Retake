/**
 * The record of a render (renders/<id>.json) — a contract shared by the renderer, which writes it, and the review, which
 * reads it —, the test that tells a record from another JSON file and the listing of a folder of records. No I/O of its
 * own: the listing reads through the functions it is given.
 */
import { join } from 'node:path';
import type { EditOverrides, EditPlan, PlanVariant } from './plan-types.js';

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
  /** The render browser (`none` while the render has not opened one; `remotion` in records of older versions). */
  browser: { path: string | null; source: 'env' | 'bundled' | 'playwright' | 'none' | 'remotion' };
  /** `render_ms`: the last attempt's (after a fallback, the software render's; the GPU attempt's time is in `total_ms`). */
  timings: { plan_ms: number; bundle_ms: number; render_ms: number; total_ms: number };
  /** Plan warnings and render warnings. */
  warnings: string[];
  error?: string;
  /** The plan rendered (with its `ds-asset:` URLs). */
  plan: EditPlan;
}

/** Whether parsed JSON is a render record (version 1, an id, a plan): what listRenders keeps and a review accepts. */
export function isRenderRecord(r: unknown): r is RenderRecord {
  const x = r as Partial<RenderRecord> | null | undefined;
  return !!x && x.version === 1 && typeof x.id === 'string' && !!x.plan;
}

/** How `readRenderRecords` reads a folder: its file names, a file's text (each may throw). */
export interface RenderRecordReader {
  list: (dir: string) => Promise<string[]>;
  read: (file: string) => Promise<string>;
}

/** The render records of a folder (its `*.json` files, dot files aside), oldest first (`created_at`, then id); unreadable files and other JSON are skipped, a missing folder holds none. */
export async function readRenderRecords(dir: string, io: RenderRecordReader): Promise<RenderRecord[]> {
  let files: string[];
  try {
    files = (await io.list(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return [];
  }
  const out: RenderRecord[] = [];
  for (const f of files) {
    try {
      const r: unknown = JSON.parse(await io.read(join(dir, f)));
      if (isRenderRecord(r)) out.push(r);
    } catch {
      // not a render record
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
