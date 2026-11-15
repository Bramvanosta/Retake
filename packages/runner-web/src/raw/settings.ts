/** A raw export's options, progress, manifest and result, and its resolved settings (exportCapture). */
import { RAW_CURSOR_MODES, RAW_FORMATS, RAW_LAYER_FORMATS } from '@retake/core/project';
import { projectPath } from '@retake/core/project';
import type { BrowserConfig, LoadedProject, RawCursorMode, RawFormat, RawFps, RawLayerFormat } from '@retake/core/project';
import type { LoadedTemplate } from '@retake/core/theme';
import type { Timeline } from '@retake/core/run';
import type { WorkPolicy } from '@retake/core/policy';
import type { RawMarkerKind } from './markers.js';

/** A raw export that cannot start (message written for the user). */
export class RawExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawExportError';
  }
}

export interface ExportCaptureOptions {
  project: LoadedProject;
  /** The run directory (the caller resolves an id, a path or `latest`). */
  runDir: string;
  /** Template the run was captured with: the look of the cursor layer (default look otherwise). */
  template?: LoadedTemplate;
  format?: RawFormat;
  fps?: RawFps;
  cursor?: RawCursorMode;
  layer?: RawLayerFormat;
  selects?: boolean;
  cuts?: boolean;
  /** Package folder (default `<project>/exports/<run-id>-raw-<format><fps>-<cursor>/`). */
  out?: string;
  /** Files the edit of this scenario uses (intro / outro videos, overlays, images…): listed for re-use. */
  editFiles?: string[];
  browser?: BrowserConfig;
  ffmpeg?: string;
  ffprobe?: string;
  /** What the work runs under (core WorkPolicy): which ffmpeg and Chromium, under its agent policy. */
  policy: WorkPolicy;
  signal?: AbortSignal;
  onProgress?: (p: RawExportProgress) => void;
}

export interface RawExportProgress {
  stage: 'plan' | 'clip' | 'layer' | 'selects' | 'files' | 'done';
  done: number;
  total: number;
  message?: string;
}

export interface RawManifestClip {
  file: string;
  name: string;
  scene: string;
  scene_number: number;
  page?: string;
  label?: string;
  /** On the sequence (FCPXML spine, EDL, the OTIO track V1, selects); the other pages of a scene ride along, disabled. */
  primary: boolean;
  caption?: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration_s: number;
  codec: string;
  profile?: string;
  pix_fmt: string;
  timecode: string;
  size_bytes: number;
  seq_start_frame: number;
  seq_start_tc: string;
  /** Capture seconds it covers (cuts inside). */
  capture: { from: number; to: number };
  /** `wait_step`: the wait step whose awaited state ends the cut (absent for a page load the capture held, R-ISS-08). */
  cuts: Array<{ at_frame: number; at_tc: string; capture_from: number; capture_to: number; seconds: number; reason: string; wait_step?: number; after_step?: number }>;
  layer?: { file: string; codec: string; profile?: string; pix_fmt: string; alpha: boolean; frames: number; size_bytes: number };
}

export interface RawManifest {
  version: 1;
  kind: 'retake/raw-capture';
  created_at: string;
  project: { slug: string; name: string };
  scenario: string;
  run: {
    id: string;
    dir: string;
    captured_at: string;
    status?: string;
    env?: string;
    capture: { width: number; height: number; scale: number; fps: number; duration_s: number; frames: number };
    /** Whether the in-page cursor is in the run's pictures. */
    cursor: 'visible' | 'hidden';
  };
  settings: {
    format: RawFormat;
    codec: string;
    fps: RawFps;
    cursor: RawCursorMode;
    layer?: RawLayerFormat;
    layer_codec?: string;
    cuts: boolean;
    selects: boolean;
    frames_from: 'screencast frames' | 'capture video';
  };
  sequence: { fps: number; frames: number; duration_s: number; start_tc: string; end_tc: string };
  clips: RawManifestClip[];
  selects?: { file: string; frames: number; duration_s: number; codec: string; size_bytes: number };
  cursor: {
    mode: RawCursorMode;
    data: { json: string; csv: string; clicks_csv: string };
    icons: 'recorded' | 'approximated';
    look: { style: string; size: number; ripple_color: string };
    layers: string[];
  };
  markers: { fcpxml: string; edl: string; otio: string; json: string; csv: string; count: Record<RawMarkerKind, number>; colors: Record<RawMarkerKind, string> };
  edit_files: string[];
  notes: string[];
  warnings: string[];
}

export interface RawExportResult {
  dir: string;
  manifest: RawManifest;
  manifestFile: string;
  readme: string;
}

const pick = <T extends string | number>(v: unknown, allowed: readonly T[]): T | undefined => ((allowed as readonly unknown[]).includes(v) ? (v as T) : undefined);

/** Resolved settings: the call's, else project.yaml `raw`, else the defaults (mp4, 30, cursor as captured). */
export function rawSettings(project: LoadedProject, timeline: Pick<Timeline, 'capture'>, opts: Pick<ExportCaptureOptions, 'format' | 'fps' | 'cursor' | 'layer' | 'selects' | 'cuts'>) {
  const raw = project.config.raw ?? {};
  const hidden = timeline.capture.cursor === 'hidden';
  const format = opts.format ?? raw.format ?? 'mp4';
  const fps = opts.fps ?? raw.fps ?? 30;
  const cursor = opts.cursor ?? raw.cursor ?? (hidden ? 'none' : 'baked');
  const layer = opts.layer ?? raw.layer ?? 'prores';
  if (!pick(format, RAW_FORMATS)) throw new RawExportError(`format "${format}": use ${RAW_FORMATS.join(' or ')}`);
  if (fps !== 30 && fps !== 60) throw new RawExportError(`fps ${fps}: use 30 or 60`);
  if (!pick(cursor, RAW_CURSOR_MODES)) throw new RawExportError(`cursor "${cursor}": use ${RAW_CURSOR_MODES.join(', ')}`);
  if (!pick(layer, RAW_LAYER_FORMATS)) throw new RawExportError(`layer "${layer}": use ${RAW_LAYER_FORMATS.join(' or ')}`);
  return { format, fps: fps as RawFps, cursor, layer, selects: opts.selects ?? raw.selects ?? false, cuts: opts.cuts ?? raw.cuts ?? true, hidden };
}

/** Default package folder of a run. */
export function rawPackageDir(project: Pick<LoadedProject, 'dir'>, runId: string, s: { format: RawFormat; fps: number; cursor: RawCursorMode }): string {
  return projectPath(project.dir, 'exports', `${runId}-raw-${s.format}${s.fps}-${s.cursor}`);
}

export const round3 = (x: number) => Math.round(x * 1000) / 1000;
export const fileBase = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sequence';
export const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
