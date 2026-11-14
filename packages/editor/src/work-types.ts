/**
 * The vocabulary the editor's work shares with its callers: the progress of a render, the render browser's process, who
 * asked for a plan, an export's progress, a component to bundle and the inputs and outputs of component previews.
 * Types only, renderer-free (no Remotion, React or file system): the planner entry (`@retake/editor/plan`) exports
 * them, so the engine names them through that domain entry; the render modules that use them import them from here.
 */
import type { ExportFormatName } from '@retake/core/render';
import type { ComponentKind } from '@retake/core/model';
import type { ComponentManifest } from '@retake/components/geometry';
import type { PreviewRect } from './remotion/preview-types.js';

/** A delivery format of an export (core's one list). */
export type ExportFormat = ExportFormatName;

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

/** The render browser's process (to kill it after its parent was killed: Remotion starts it detached). */
export interface BrowserProcessInfo {
  pid: number;
  /** --user-data-dir of the browser (a temporary profile folder Remotion creates). */
  user_data_dir?: string;
}

/** Who asked: a human at the CLI (`author`), or work submitted through the MCP server (`mcp`). */
export type PlanTrust = 'author' | 'mcp';

export interface ExportProgress {
  format: ExportFormat;
  stage: 'start' | 'progress' | 'done' | 'failed';
  /** 0..1 within the format (re-renders report their render progress). */
  progress: number;
  message?: string;
}

/** A component implementation to bundle. */
export interface BundleComponent {
  /** Component id, or `scaffolds/<kind>` for a stand-in. */
  id: string;
  kind: ComponentKind;
  /** Absolute component folder (hashed: every code file in it). */
  dir: string;
  /** Absolute implementation file. */
  entry: string;
  /** Params defaults of the manifest. */
  defaults: Record<string, unknown>;
  /** Stand-in of its kind (a scaffold). */
  scaffold?: boolean;
}

export type PreviewScreenName = 'desktop' | 'tablet' | 'phone';

/** A neutral sample screen (packages/components/preview/, generated once from the fixture by scripts/preview-samples.mjs). */
export interface PreviewSample {
  /** Absolute image file. */
  file: string;
  width: number;
  height: number;
  /** Address a browser layout shows. */
  url: string;
  /** A button of the screen (overlay previews point at it), sample px. */
  anchor?: PreviewRect;
  /** A text field of the screen (a loupe preview magnifies it), sample px. */
  field?: PreviewRect;
}

/** Sample artefacts for previews of components with `email` / `document` slots (files absolute). */
export interface PreviewMediaSamples {
  email?: { file: string; width: number; height: number; from: string; from_name?: string; to: string[]; subject: string; date: string; preview: string };
  document?: { file_name: string; pages: Array<{ file: string; width: number; height: number; width_pt: number; height_pt: number }> };
  /** Two states of one screen, for `frame` slots (before / after cards). */
  frames?: Array<{ file: string; width: number; height: number; label: string }>;
  /** A user image for `media` slots (studio/media, L2.12). */
  image?: { file: string; width: number; height: number };
  /** A Lottie animation for `lottie` slots (studio/lottie, L2.12). */
  lottie?: { file: string; width: number; height: number; fps: number; frames: number };
}

export type PreviewSamples = Record<PreviewScreenName, PreviewSample> & { media?: PreviewMediaSamples };

/** A component to preview: a registry entry, a scaffold (`scaffolds/<kind>`) or any component folder. */
export interface PreviewComponentTarget {
  id: string;
  dir: string;
  entry: string;
  manifest: ComponentManifest;
  /** Slot values over the manifest's preview samples (checked by the caller). */
  slots?: Record<string, string>;
  /** Params over the manifest's preview params (validated by the caller). */
  params?: Record<string, unknown>;
  /** Second shown (default: the manifest's preview moment). */
  at?: number;
  /** With outDir: the image's file name (default `<namespace>/<name>.png`). */
  file?: string;
}

/** How the README of a component folder is written (RenderPreviewsOptions.readmes). */
export interface PreviewReadmeWriter {
  /** The folder whose components' READMEs go through `write` (a workspace's components folder). */
  root: string;
  /**
   * Write `file` (a component's README.md under `root`) with `text`, merged into `previous`: the README as it was read —
   * the write is made on that version (`if_match` its hash) — or null when there was none (`if_match` null: created,
   * never over a README made in between). The engine's project store: an authored write, journaled.
   */
  write(file: string, text: string, previous: string | null): Promise<void>;
}

/** One component of `renderComponentLoops` and the files it writes (absolute; their folder exists). */
export interface LoopItem {
  target: PreviewComponentTarget;
  /** The poster (PNG 960×540, the still of `renderComponentPreviews`). */
  poster?: string;
  /** The loop (GIF, LOOP_FORMAT). */
  loop?: string;
}

export interface RenderedPoster {
  file: string;
  bytes: number;
  width: number;
  height: number;
  /** Second shown. */
  at: number;
  quantized: boolean;
}

export type RenderedLoop =
  | { file: string; bytes: number; width: number; height: number; fps: number; frames: number; duration_s: number }
  /** Over LOOP_FORMAT.max_bytes even at the fallback width: no file written. */
  | { too_large: true; bytes: number };

export interface RenderedLoopItem {
  id: string;
  poster?: RenderedPoster;
  loop?: RenderedLoop;
}
