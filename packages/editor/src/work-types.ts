/**
 * The vocabulary the editor's work shares with its callers: the progress of a render, the render browser's process, who
 * asked for a plan, an export's progress, a component to bundle and the inputs and outputs of component previews.
 * Types only, renderer-free (no Remotion, React or file system): the planner entry (`@retake/editor/plan`) exports
 * them, so the engine names them through that domain entry; the render modules that use them import them from here.
 */
import type { ExportFormatName } from '@retake/core/render';
import type { ComponentKind } from '@retake/core/model';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedTemplate } from '@retake/core/theme';
import type { Scenario } from '@retake/core/scenario';
import type { Timeline } from '@retake/core/run';
import type { WorkPolicy } from '@retake/core/policy';
import type { LatestPick } from '@retake/core/run';
import type { ComponentManifest, ComponentRegistry, RegistrySource } from '@retake/components/geometry';
import type { EditOverrides, EditPlan, PlanVariant } from './plan-types.js';
import type { PreviewRect } from './remotion/preview-types.js';

/** A delivery format of an export (core's one list). */
export type ExportFormat = ExportFormatName;

/** `retrying`: the GPU path failed and the video renders again in software (progress does not go back). */
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

/**
 * A format of an export rendered again from the master's run, theme and overrides (vertical, square, 4K from a smaller
 * master), to `out` and its record beside it: what the export asks of whoever renders (the engine's render use case,
 * on its renderer and the renders folder of its outputs). The work's policy, project and workspace are the export's.
 */
export interface ExportRerenderRequest {
  /** The master's run folder. */
  run: string;
  scenario: string;
  /** The master's theme, as the project can name it (exportThemeRef). */
  template: string;
  overrides: EditOverrides;
  /** The master's edit: the sha256 of the scenario file it was planned from (null: the run as captured)… */
  editSha256?: string | null;
  /** …or the run as captured (a master of before the edit was recorded). */
  edit?: 'run';
  /** The .mp4 to write (its record: the same name, .json). */
  out: string;
  registry?: ComponentRegistry;
  concurrency?: number;
  signal?: AbortSignal;
  trust: PlanTrust;
  network?: 'open' | 'guard';
  onBrowser?: (b: BrowserProcessInfo) => void;
  onProgress: (p: RenderProgress) => void;
}

/** What renders a format of an export again: the record file it wrote and the render's warnings. */
export type ExportRerender = (req: ExportRerenderRequest) => Promise<{ record: string; warnings: string[] }>;

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

/**
 * An own component (the workspace's, or a project's) as the Studio's preview allow-list sees it: its id, kind, folder
 * content hash (16 hex), where it comes from, and what it hides when it overrides a component of its id.
 */
export interface WorkspaceComponent {
  id: string;
  kind: string;
  hash: string;
  source: 'project' | 'workspace';
  overrides?: 'workspace' | 'builtin';
}

/** Decides whether a workspace component (id, folder content hash) is allowed in the Studio's preview. */
export type PreviewAllowed = (id: string, hash: string) => boolean;

/**
 * What the Studio's preview bundle is built from beside its components: the kit's and the geometry entry's files
 * (refused when missing), the composition's root module, and the components' import rules its loader applies.
 */
export interface PlayerBuildEntries {
  kit: string;
  geometry: string;
  composition: string;
  importProblem: (spec: string, resolveDir: string, componentDir: string) => string | undefined;
  unhashedFileProblem: (rel: string) => string | undefined;
  unhashedImportMessage: (spec: string, what: string) => string;
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
  /** A user image for `media` slots (studio/media). */
  image?: { file: string; width: number; height: number };
  /** A Lottie animation for `lottie` slots (studio/lottie). */
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

// ── planning a run, and an export (the types of the editor's use cases the engine names) ──

export interface RunRef {
  id: string;
  dir: string;
  /**
   * Set when the run was picked as `latest` (core latestTake): the take — `take.until` when the capture was stopped by
   * `--until` — and the newer captures of the scenario it passed over, for whoever says so. Absent for a run named
   * by its id or its folder.
   */
  latest?: LatestPick;
}

export interface PlanRunOptions {
  /** What the work runs under (core WorkPolicy): the ffprobe of its files. */
  workPolicy: WorkPolicy;
  project: LoadedProject;
  /** Run id, run directory, or "latest" (of `scenario` when given); or a run its caller already found (no second lookup). */
  run: string | RunRef;
  /** Scenario name: required to match the run's; picks the run with "latest". */
  scenario?: string;
  /** Theme to use instead of the run's (name, ./path or a loaded template). */
  template?: string | LoadedTemplate;
  overrides?: EditOverrides;
  /** Workspace root (default: the project's). */
  root?: string;
  /**
   * The components the plan reads (slot types, durations, the theme's picks): the registry, or its loader, called with
   * the root after the run is read. Required: the plan loads no registry by itself.
   */
  registry: RegistrySource;
  /** Default `author`: no trust gate. */
  trust?: PlanTrust;
  /** Measure the music bed with ffprobe so the plan loops or trims it (default true; a still does without). */
  measureMusic?: boolean;
  /** How the music bed is measured (default: ffprobe each time; the Studio's timeline memoises it by file). */
  musicLength?: (file: string) => Promise<number | undefined>;
  /**
   * Where the edit comes from. `auto` (default): today's scenario file when its filmed part is unchanged since
   * the run, else the run as captured. `run`: the run as captured.
   */
  edit?: 'auto' | 'run';
  /**
   * The scenario file's text to plan the edit from instead of today's file: a render job's snapshot
   * of the file as it was planned at submit (its job folder's edit.yaml). The same parse, filmed-part check and trust
   * gates apply; only the source of the text differs.
   */
  editText?: string;
  /**
   * What the plan is for. `render` (default): what renders it — its words say render, and a run without its
   * film is refused. `plan`: a plan alone (`retake plan`) — its words say plan, and a run without its film still plans
   * (a plan reads no film).
   */
  purpose?: 'render' | 'plan';
}

/**
 * Where a plan's edit came from: today's scenario file re-planned on the run (`scenario`: its filmed part is
 * unchanged since the capture), or the run as captured (`run`: no snapshot or file, the filmed part changed, or today's
 * file does not validate).
 */
export interface PlannedEdit {
  from: 'scenario' | 'run';
  /** sha256 of today's file the edit was planned from (from `scenario`). */
  sha256?: string;
  /** What today's edit changed against the run's (keys, scene ids, step keys; from `scenario`). */
  changes?: string[];
  /**
   * Whether the filmed part changed since the run (true: re-capture to film it), absent when it cannot be told (no
   * scenario file or no snapshot).
   */
  scenario_changed?: boolean;
  /** What changed in the filmed part (keys, scene ids, step keys); absent when the file no longer reads as YAML. */
  filmed_changes?: string[];
  /** Why today's file was not used although its filmed part is unchanged. */
  reason?: string;
}

export interface PlannedRun {
  project: LoadedProject;
  root: string;
  run: RunRef;
  timeline: Timeline;
  template: LoadedTemplate;
  registry: ComponentRegistry;
  captureFile: string;
  /** The overrides planned with (`theme` set to the theme's name when one was asked). */
  overrides: EditOverrides;
  /** The run's scenario snapshot (undefined when absent or invalid). */
  scenario?: Scenario;
  /** Where the edit came from. */
  edit: PlannedEdit;
  /** The scenario text the edit was planned from (from `scenario`): what a render job snapshots at submit. */
  editText?: string;
  plan: EditPlan;
  plan_ms: number;
}

export interface ExportOutput {
  format: ExportFormat;
  /** Absolute path. */
  file: string;
  /** copy: the master as is; transcode: ffmpeg from the master; render: re-rendered through the planner. */
  method: 'copy' | 'transcode' | 'render';
  width: number;
  height: number;
  duration_s: number;
  fps: number;
  video_codec?: string;
  audio_codec?: string;
  audio_streams: number;
  size_bytes: number;
  ms: number;
  /** GIF: the window of the master it shows (seconds) and why. */
  window?: { start_s: number; duration_s: number; reason: 'first' | 'highlight' | 'asked' };
  /** Re-rendered formats: the render record written next to the file. */
  record?: string;
  warnings: string[];
}

export interface ExportResult {
  version: 1;
  project: string;
  render: string;
  scenario: string;
  run_id: string;
  /** The master render. */
  master: { file: string; record: string; variant: PlanVariant; width: number; height: number; duration_s: number; fps: number };
  dir: string;
  manifest: string;
  created_at: string;
  outputs: ExportOutput[];
  /** Formats that failed (the others are still written). */
  failures: Array<{ format: ExportFormat; error: string }>;
}

/**
 * What the editor's exportRender made: the export without its manifest. The caller (the engine's export use case)
 * keeps the formats exported earlier into the same folder, stamps it and writes `manifest.json`: the ExportResult.
 */
export type ExportMade = Omit<ExportResult, 'manifest' | 'created_at'>;

/** Where an export is placed: the folder of the render named `name` (its folder name), made by the caller's rule. */
export type ExportPlace = (name: string) => string;

export interface ExportRenderOptions {
  /** What the work runs under (core WorkPolicy): which ffmpeg and ffprobe, under its agent policy. */
  workPolicy: WorkPolicy;
  /** The project, loaded by the caller: the editor finds no project by itself. */
  project: LoadedProject;
  /** Render id (renders/<id>.json), a path to a record / video, or `latest` (of `scenario` when given). */
  render: string;
  scenario?: string;
  formats?: readonly ExportFormat[];
  /**
   * The folder the export goes in, from the name of the render found (the engine's: `<project>/exports/<render-id>/`,
   * or the caller's output folder). Required: this package places no export by itself.
   */
  place: ExportPlace;
  /** GIF window (default: around the first marker, else the first 15 s). */
  gif?: { start_s?: number; duration_s?: number };
  /** Workspace root of the re-rendered formats (default: the project's; the re-render is handed it by its caller). */
  root?: string;
  registry?: ComponentRegistry;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  ffmpeg?: string;
  /**
   * `mcp` (an export job of the worker): the render is named by its id only, its video and run must lie in the project
   * folder, and re-rendered formats pass planRun's trust gates. Default `author`.
   */
  trust?: PlanTrust;
  /** The network of re-rendered formats (export jobs: `guard`). */
  network?: 'open' | 'guard';
  /** Called once a re-render's browser runs, with its process. */
  onBrowser?: (b: BrowserProcessInfo) => void;
  /**
   * What renders a re-rendered format again (the engine's render use case: its version, its record, its renderer).
   * Required: this package renders no format of an export by itself.
   */
  rerender: ExportRerender;
}
