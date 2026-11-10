/**
 * The render driver: the editor's own shape of what renders — a video, stills, component previews — so its use cases
 * (renderVideo, renderStill, exportRender, the component previews) can be handed another one. The engine's Renderer
 * port (engine render/renderer.ts) is the same shape, owned there; the two are checked against each other where the
 * engine builds the driver. Types only.
 *
 * A driver's failure is read by what it says, never by its class: its kind (core `errorKindOf`: `cancelled`), and the
 * fields `renderPath`, `renderWarnings` and `diskFull` when it has them (`renderPath` is this package's
 * `RenderError.path` under the port's name: the driver maps it, render.ts planDriver).
 */
import type { RenderSettings, WorkPolicy } from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import type { EditPlan } from '../plan-types.js';
import type { ComponentPreviewSpec } from '../remotion/preview-types.js';
import type { RenderRecord } from '../render-record.js';
import type { BundleComponent } from './bundle.js';
import type { RenderProgress } from './types.js';

export interface DriverProcess {
  pid: number;
  user_data_dir?: string;
}

interface DriverRequestBase {
  workPolicy: WorkPolicy;
  root?: string;
  registry?: ComponentRegistry;
  settings?: RenderSettings;
  network?: 'open' | 'guard';
  onProcess?: (p: DriverProcess) => void;
}

export interface DriverVideoRequest extends DriverRequestBase {
  plan: EditPlan;
  out: string;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  frameRange?: [number, number];
}

export interface DriverVideoResult {
  file: string;
  size_bytes: number;
  concurrency: number;
  bundle: RenderRecord['bundle'];
  browser: { path: string | null; source: RenderRecord['browser']['source'] };
  bundle_ms: number;
  render_ms: number;
  warnings: string[];
  /** The render path asked, resolved and used: the port's name for what renderPlan answers as `path`. */
  renderPath: NonNullable<RenderRecord['policy']>;
  encoding: Pick<RenderRecord['encoding'], 'encoder' | 'crf' | 'bitrate' | 'gop'>;
  /** What ffprobe saw in the file written, when it ran. */
  probe?: RenderRecord['probe'];
}

export interface DriverStillsRequest extends DriverRequestBase {
  plan: EditPlan;
  frames: Array<{ frame: number; out: string }>;
  onWarnings?: (warnings: string[]) => void;
}

/** A preview bundle a driver made: what it is served from stays the driver's. */
export interface DriverPreviewBundle {
  readonly hash: string;
  readonly cached: boolean;
}

export interface DriverPreviewSession {
  still(spec: ComponentPreviewSpec, out: string, scale: number): Promise<void>;
  gif(spec: ComponentPreviewSpec, out: string, o: { scale: number; everyNthFrame: number; frames: [number, number] }): Promise<void>;
  warnings(): string[];
  close(): Promise<void>;
}

export interface DriverPreviews {
  bundle(o: { root: string; components: BundleComponent[]; signal?: AbortSignal }): Promise<DriverPreviewBundle>;
  open(
    bundle: DriverPreviewBundle,
    o: { workPolicy: WorkPolicy; assets: string; settings?: RenderSettings; network?: 'open' | 'guard'; signal?: AbortSignal; onProcess?: (p: DriverProcess) => void },
  ): Promise<DriverPreviewSession>;
}

export interface RenderDriver {
  video(req: DriverVideoRequest): Promise<DriverVideoResult>;
  stills(req: DriverStillsRequest): Promise<string[]>;
  readonly previews: DriverPreviews;
}
