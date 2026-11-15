/**
 * The renderer port: what turns an edit plan into pictures — a video file, still frames, and the posters and loops of
 * component previews. The engine owns these types; the product's adapter is the editor's driver (editor-renderer.ts,
 * checked against this file with `satisfies`), the tests' is the in-memory renderer (memory-renderer.ts). The editor
 * spells the same shape in its own driver-types.ts on purpose: the layering forbids either package importing the
 * other's, and that `satisfies` holds the two together.
 *
 * What is around the port: the engine's render use case (render-video.ts: the plan, the version reserved, the render
 * record and where files go, on the Outputs port) and the editor's (renderStill, exportRender's transcodes, the
 * component previews). Under the port: the bundle, the
 * render browser, the encoder, and the probe of the file written — so a renderer that drives none of them serves a
 * whole render with no browser and no ffmpeg / ffprobe.
 *
 * Errors: a renderer rejects with an Error that states its kind the way every package does (core `errorKindOf`):
 * `cancelled` when the request's signal aborted (nothing is left at `out`), `invalid` for a request it refuses. A
 * failure may carry the fields of RendererFailure, which the use cases read by name, never by class.
 */
import type { RenderSettings } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { BundleComponent, ComponentPreviewSpec, EditPlan, RenderProgress, RenderRecord } from '@retake/editor/plan';

/** The render process a renderer started (the jobs worker records it, to kill it after a crash). */
export interface RenderProcess {
  pid: number;
  user_data_dir?: string;
}

/** What every request says. */
export interface RenderRequestBase {
  /** What the work runs under (core WorkPolicy). */
  workPolicy: WorkPolicy;
  /** Workspace root: where the bundle cache is (the caller's; a renderer never looks for one from the current folder). */
  root: string;
  /** Where the plan's component implementations are found (the planned run's): required, a renderer loads no registry by itself. */
  registry: ComponentRegistry;
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

/**
 * The render path a 1080p render takes on this machine, from the checks a render makes (`retake doctor`'s "Renders"
 * line): the settings asked and where each comes from, then what the probe found — the GL, the GPU, VideoToolbox, the
 * encoder, the frames at a time and the ffmpeg that encodes them. `policy` is absent when the settings cannot be read
 * (`error` says why); `error` beside a policy means every render would fail.
 */
export interface RenderPathProbe {
  policy?: {
    gl: { asked: string; resolved: 'angle' | 'software'; source: string };
    encoder: { asked: string; source: string };
    /** Which ffmpeg encodes the frames (absent from a probe of before it). */
    ffmpeg?: { asked: string; source: string };
    concurrency: number;
    concurrencySource: string;
    platform: string;
  };
  error?: string;
  gpu?: { accelerated: boolean; renderer?: string };
  browserError?: string;
  gl?: 'angle' | 'software';
  videotoolbox?: { ok: boolean; error?: string };
  encoder?: 'h264_videotoolbox' | 'libx264';
  concurrency?: number;
  /**
   * The ffmpeg that would encode the frames — this machine's (`own`, its version) or the rendering library's, and why
   * not this machine's (`note`) — `byRule` when the library's is simply what the setting gives on this path.
   */
  ffmpeg?: { used: 'own' | 'library'; version?: string; note?: string; byRule?: true };
}

/** The browser renders use: its path (null: none, renders do not start), where it comes from, a note when it is not the expected one. */
export interface RenderBrowserProbe {
  path: string | null;
  source: string;
  note?: string;
}

/** What a check of the machine reads of the renderer (`retake doctor`): nothing is rendered, nothing written. */
export interface RenderMachine {
  /** The render path a 1080p render would take under `policy`. */
  path(policy: WorkPolicy): Promise<RenderPathProbe>;
  /** The browser renders would use. */
  browser(): Promise<RenderBrowserProbe>;
}

export interface Renderer {
  video(req: RenderVideoRequest): Promise<RenderVideoResult>;
  /** The files, in the order asked. */
  stills(req: RenderStillsRequest): Promise<string[]>;
  readonly previews: PreviewRendering;
  readonly machine: RenderMachine;
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
