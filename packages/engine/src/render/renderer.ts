/**
 * The renderer port: what turns an edit plan into pictures — a video file, still frames, and the posters and loops of
 * component previews. The engine owns these types; the product's adapter is the editor's driver (editor-renderer.ts,
 * checked against this file with `satisfies`), the tests' is the in-memory renderer (memory-renderer.ts).
 *
 * What is around the port and stays the editor's use cases (renderVideo, renderStill, exportRender, the component
 * previews): planning, the version reserved, the render record and where files go. Under the port: the bundle, the
 * render browser, the encoder, and the probe of the file written — so a renderer that drives none of them serves a
 * whole render with no browser and no ffmpeg / ffprobe.
 *
 * Errors: a renderer rejects with an Error that states its kind the way every package does (core `errorKindOf`):
 * `cancelled` when the request's signal aborted (nothing is left at `out`), `invalid` for a request it refuses. A
 * failure may carry the fields of RendererFailure, which the use cases read by name, never by class.
 */
import type { RenderSettings, WorkPolicy } from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import type { EditPlan, RenderRecord } from '@retake/editor/plan';
import type { BundleComponent, ComponentPreviewSpec, RenderProgress } from '@retake/editor';

/** The render process a renderer started (the jobs worker records it, to kill it after a crash). */
export interface RenderProcess {
  pid: number;
  user_data_dir?: string;
}

/** What every request says. */
export interface RenderRequestBase {
  /** What the work runs under (core WorkPolicy). */
  workPolicy: WorkPolicy;
  /** Workspace root (default: the workspace of the cwd). */
  root?: string;
  /** Where the plan's component implementations are found (default: the workspace's). */
  registry?: ComponentRegistry;
  /** Render settings over the process's. */
  settings?: RenderSettings;
  /** `guard`: the renderer loads only the request's own files (renders of the jobs worker); default `open`. */
  network?: 'open' | 'guard';
  /** Called at most once, when the renderer's process runs. */
  onProcess?: (p: RenderProcess) => void;
}

export interface RenderVideoRequest extends RenderRequestBase {
  plan: EditPlan;
  /** The .mp4 to write: whole on success, absent after a failure or a cancel. */
  out: string;
  concurrency?: number;
  signal?: AbortSignal;
  /** Stages `bundling`, `rendering`, `retrying`, `encoding`; `overall` never goes back. */
  onProgress?: (p: RenderProgress) => void;
  /** Only these output frames [first, last], inclusive. */
  frameRange?: [number, number];
}

/**
 * What a video render says of itself: the fields of the render record it fills. Their shapes are the record's on
 * purpose (the record is the product's format); the values in them — which GL, which encoder, where the browser came
 * from — are the adapter's, and nothing around the port reads them as anything but text to record.
 */
export interface RenderVideoResult {
  file: string;
  size_bytes: number;
  concurrency: number;
  bundle: RenderRecord['bundle'];
  browser: { path: string | null; source: RenderRecord['browser']['source'] };
  bundle_ms: number;
  render_ms: number;
  warnings: string[];
  /** The render path asked, resolved and used (the record's `policy`). */
  renderPath: NonNullable<RenderRecord['policy']>;
  /** The encoder's part of the record's `encoding`. */
  encoding: Pick<RenderRecord['encoding'], 'encoder' | 'crf' | 'bitrate' | 'gop'>;
  /** What the file written holds, when the renderer measured it (the record's `probe`). */
  probe?: RenderRecord['probe'];
}

export interface RenderStillsRequest extends RenderRequestBase {
  plan: EditPlan;
  /** Output frames (0-based) and the .png each one goes to; a frame outside the plan is refused (`invalid`). */
  frames: Array<{ frame: number; out: string }>;
  /** Receives the session's warnings once the stills are done. */
  onWarnings?: (warnings: string[]) => void;
}

/** A set of components made ready to render previews of: the same components give the same `hash`. */
export interface PreviewBundle {
  readonly hash: string;
  readonly cached: boolean;
}

export interface PreviewBundleRequest {
  root: string;
  components: BundleComponent[];
  signal?: AbortSignal;
}

export interface PreviewOpenRequest {
  workPolicy: WorkPolicy;
  /** The URL prefix the specs' files are served from (a guarded session loads from it and from nowhere else). */
  assets: string;
  settings?: RenderSettings;
  network?: 'open' | 'guard';
  signal?: AbortSignal;
  onProcess?: (p: RenderProcess) => void;
}

/** One open session on a preview bundle: frames of preview specs, until `close`. */
export interface PreviewSession {
  /** One frame (the spec's `frame`) as a PNG at `out`. */
  still(spec: ComponentPreviewSpec, out: string, scale: number): Promise<void>;
  /** `frames` [first, last] of the spec, every nth, as a GIF at `out`. */
  gif(spec: ComponentPreviewSpec, out: string, o: { scale: number; everyNthFrame: number; frames: [number, number] }): Promise<void>;
  /** The session's warnings so far. */
  warnings(): string[];
  /** Twice is fine; `still` and `gif` reject after it. */
  close(): Promise<void>;
}

export interface PreviewRendering {
  bundle(o: PreviewBundleRequest): Promise<PreviewBundle>;
  /** A session on a bundle this renderer made (another renderer's is refused). */
  open(bundle: PreviewBundle, o: PreviewOpenRequest): Promise<PreviewSession>;
}

export interface Renderer {
  video(req: RenderVideoRequest): Promise<RenderVideoResult>;
  /** The files, in the order asked. */
  stills(req: RenderStillsRequest): Promise<string[]>;
  readonly previews: PreviewRendering;
}

/** What a renderer's failure may say beside its message and its kind. */
export interface RendererFailure extends Error {
  /**
   * The render path the failed render was on (the record's `policy`). Its own name on purpose: a system error
   * (ENOENT, ENOTDIR…) names a file under `path`, as a string, and that is never read as a render path.
   */
  renderPath?: RenderRecord['policy'];
  /** Warnings gathered before it failed. */
  renderWarnings?: string[];
  /** The disk was full. */
  diskFull?: true;
}
