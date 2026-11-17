/**
 * The project context's types (@retake/core/project): a project's shapes: capture settings and pacing, the browser, the
 * raw capture export settings, the project file, the workspace and the loaded project.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */
import type { ValidationIssue } from '../issues.js';
import type { RenderSettings } from '../render-settings.js';
import type { AuthConfig, ClockSpec, DatabaseConfig, EnvironmentSettings, MailboxConfig } from './environment.js';
import type { HookStep, NamedHooks } from './hooks.js';
import type { FrameSpec } from './language.js';
import type { LoadedSandbox } from './sandbox.js';

export interface CaptureSettings {
  width: number;
  height: number;
  /** deviceScaleFactor: 1, or 2 for 4K from a 1920×1080 viewport. */
  scale: number;
  fps: number;
  /** Screencast frame format. */
  format: 'jpeg' | 'png';
  /** JPEG quality of the screencast frames (1-100; default 90: small text measured indistinguishable from 100). */
  quality: number;
  /**
   * Keep the screencast frames in runs/<id>/frames (their real timing, for the raw export at 60 fps). Default false:
   * capture.mp4 is encoded during the take and nothing else is written.
   */
  keep_frames: boolean;
  /** libx264 CRF of capture.mp4 (when the encoder is libx264). */
  crf: number;
  /**
   * Encoder of capture.mp4, fed during the take: `auto` (default) uses the Mac's hardware H.264 encoder
   * (VideoToolbox) when ffmpeg has it, else libx264 (preset veryfast, `crf`).
   */
  encoder?: CaptureEncoder;
  /**
   * Visit each page of the scenario once off camera before the take (R-FLD-27): its code, fonts and images are
   * cached, so the first visit is not filmed cold. Default false.
   */
  prewarm?: boolean;
  /**
   * Keep one picture per step of a capture in runs/<id>/screenshots, as a dry run does: the captured frame at
   * the end of each step (no screenshot taken during the take). Default false.
   */
  step_shots?: boolean;
}

/** `defaults` of a project or a scenario (the scenario's win): values every step uses when it sets none. */
export interface RunDefaults {
  /**
   * Seconds every wait and action waits when it has no `timeout` of its own: targets, `wait_for`, `wait_for_email`,
   * `download` and the other actions (built-in defaults: 15, and 30 for wait_for_email / download).
   */
  timeout_s?: number;
}

export const CAPTURE_ENCODERS = ['auto', 'videotoolbox', 'libx264'] as const;

export type CaptureEncoder = (typeof CAPTURE_ENCODERS)[number];

export const DEFAULT_CAPTURE: CaptureSettings = {
  width: 1920,
  height: 1080,
  scale: 1,
  fps: 30,
  format: 'jpeg',
  quality: 90,
  keep_frames: false,
  crf: 16,
};

/** Deterministic pacing (field-tested defaults). */
export interface Pacing {
  /** Seconds still at scene start (1.5–2). */
  scene_start_still: number;
  /** Cursor travel: ms = clamp(move_base_ms + distance_px * move_ms_per_px, move_min_ms, move_max_ms) (field notes: clamp(0.9·d, 450, 1100)). */
  move_base_ms: number;
  move_ms_per_px: number;
  move_min_ms: number;
  move_max_ms: number;
  /** Moves shorter than this (px) are "nudges" (repeated clicks on almost the same spot): short travel and hover. */
  nudge_px: number;
  /** Travel time of a nudge of nudge_px; shorter nudges scale down to 60 % of it (≈150–250 ms). A zero-length move takes 0 ms. */
  nudge_ms: number;
  /** Hover pause before pressing after a nudge (≈120). */
  nudge_hover_ms: number;
  /** Hover pause before pressing (150–250). */
  hover_ms: number;
  /** mousedown → mouseup. */
  press_ms: number;
  /** Pause after an ordinary click. */
  after_click_ms: number;
  /** Pause after a click that opened a menu/popover/dialog (600–1000). */
  after_popup_ms: number;
  /** Minimum time between a click and the next step when the click navigated or changed the URL (1.5–2.8 s in the field notes). */
  after_navigation_ms: number;
  /**
   * How long a click gets to show that an expected popup opened (aria-expanded="true" or a new visible popup, polled
   * every 40 ms) before the next click strategy is tried.
   */
  popup_fallback_ms: number;
  /** How long the last click strategy waits for an expected popup before the step reports it missing. */
  popup_timeout_ms: number;
  /**
   * Typing speed, characters per second (field notes: ~14). A `type` step without `cps` adapts it (R-CHO-14): search
   * fields at most 10, long free text up to 24.
   */
  type_cps: number;
  /** Smooth scroll duration in seconds (1.5–2). */
  scroll_duration: number;
  /** Default `scroll.offset` with a target: final scrollTop = target top + offset (−140 ⇒ the target ends 140 px below the top). */
  scroll_offset: number;
  /** Deterministic ±fraction jitter applied to durations (0 = none). */
  jitter: number;
  /** After navigation: wait for network idle up to this many ms. */
  settle_ms: number;
  /**
   * Multi-page scenes: pause when a step acts on another page than the previous step, before that page's cursor
   * starts to move (the viewer's eye moves to the other page; no cursor ever jumps).
   */
  page_switch_ms: number;
  /** Seconds a step's `park: true` holds the cursor still on the result (field notes 1.5–2.6). */
  park_hold: number;
  /** Seconds a scroll's `park: true` holds the cursor next to the target (field notes 3–3.5). */
  park_scroll_hold: number;
}

export const DEFAULT_PACING: Pacing = {
  scene_start_still: 1.6,
  move_base_ms: 0,
  move_ms_per_px: 0.9,
  move_min_ms: 450,
  move_max_ms: 1100,
  nudge_px: 60,
  nudge_ms: 250,
  nudge_hover_ms: 120,
  hover_ms: 200,
  press_ms: 90,
  after_click_ms: 350,
  after_popup_ms: 800,
  after_navigation_ms: 1500,
  popup_fallback_ms: 300,
  popup_timeout_ms: 700,
  type_cps: 14,
  scroll_duration: 1.6,
  scroll_offset: -140,
  jitter: 0.08,
  settle_ms: 3000,
  page_switch_ms: 500,
  park_hold: 2,
  park_scroll_hold: 3.2,
};

export interface BrowserConfig {
  executable?: string;
  /** 'chromium' = new headless (default); 'headless-shell' = old headless shell. */
  channel?: 'chromium' | 'headless-shell' | 'chrome';
  headless?: boolean;
  args?: string[];
  locale?: string;
  timezone?: string;
  color_scheme?: 'light' | 'dark';
  /**
   * false: run Chromium without its frame rate limiter. It removes the ≈ 0.26 s capture stall after a dialog
   * whose overlay has a backdrop-filter closes, but requestAnimationFrame then runs at thousands of Hz while anything
   * animates (fixed-step animations play too fast) and the CPU climbs 2–6×. Default true (the limiter).
   */
  frame_rate_limit?: boolean;
}

export interface ProjectConfig {
  /** Format version of project.yaml (optional: a file without it is version 1). */
  version?: 1;
  name: string;
  /**
   * env name → page key → real base URL: both forms of project.yaml reduced to their page URLs (the long form's
   * `pages`, `{url, display}` → its url). Display URLs, production and access live in `environment_settings`.
   */
  environments: Record<string, Record<string, string>>;
  /** Derived by loadProject from the environments (never written in project.yaml): only those that say something. */
  environment_settings?: Record<string, EnvironmentSettings>;
  /** The product's clock at capture time 0 for every scenario (a scenario's `clock` wins). */
  clock?: ClockSpec;
  default_env?: string;
  /** Global auth, or per environment name. */
  auth?: AuthConfig | Record<string, AuthConfig>;
  capture: CaptureSettings;
  /** Default frame of every scenario: a FrameStyle or a layout component id (default 'card'). */
  frame: FrameSpec;
  /** Derived (never written in project.yaml): project.yaml writes no `frame` — `frame` is the default. */
  frame_defaulted?: true;
  template: string;
  locale?: string;
  /** Extra hosts hooks may target (environment hosts, localhost and 127.0.0.1 are always allowed). */
  allow_hosts?: string[];
  /**
   * Variables of the worker's environment the programs of a job under the agent policy also get (core childEnv): shell
   * hooks, docker, a process sandbox's services. Never a loader variable (passEnvProblem).
   */
  pass_env?: string[];
  databases?: Record<string, DatabaseConfig>;
  pacing?: Partial<Pacing>;
  /** Step defaults of every scenario (a scenario's `defaults` win). */
  defaults?: RunDefaults;
  browser?: BrowserConfig;
  /** Hooks run by `env_reset`. */
  reset?: HookStep[];
  /** Named hooks of every scenario: what a `hook: <name>` step runs when the scenario has no hook of that name. */
  hooks?: NamedHooks;
  vars?: Record<string, string>;
  /** Test mailbox read by `wait_for_email`. */
  mailbox?: MailboxConfig;
  /** Defaults of the raw capture export for editors (`retake export-capture`, `retake run --raw`). */
  raw?: RawSettings;
  /**
   * Sandbox environments, as written: environment name → its sandbox.yaml, relative to the project dir. loadProject
   * adds each one to `environments` (its pages), `environment_settings` and `auth` (its accounts).
   */
  sandboxes?: Record<string, string>;
}

/** Clip codecs of a raw export: H.264 high profile MP4, or ProRes 422 HQ (.mov). */
export const RAW_FORMATS = ['mp4', 'prores'] as const;

export type RawFormat = (typeof RAW_FORMATS)[number];

/** Frame rates of a raw export (CFR, from the capture's own frame timing — never interpolated). */
export const RAW_FPS = [30, 60] as const;

export type RawFps = (typeof RAW_FPS)[number];

/**
 * Cursor of a raw export: `baked` as captured; `none` captured without the in-page cursor (the cursor track and the
 * clicks are still exported as data); `layer` a separate transparent cursor + click-ripple video per clip.
 */
export const RAW_CURSOR_MODES = ['baked', 'none', 'layer'] as const;

export type RawCursorMode = (typeof RAW_CURSOR_MODES)[number];

/** Transparent cursor layers: ProRes 4444 (.mov) or VP9 with alpha (.webm). */
export const RAW_LAYER_FORMATS = ['prores', 'webm'] as const;

export type RawLayerFormat = (typeof RAW_LAYER_FORMATS)[number];

/** project.yaml `raw`: defaults of `retake export-capture` / `retake run --raw` (the CLI flags win). */
export interface RawSettings {
  format?: RawFormat;
  fps?: RawFps;
  cursor?: RawCursorMode;
  layer?: RawLayerFormat;
  /** Also write one continuous "selects" file of the clips (default false). */
  selects?: boolean;
  /** Cut the loading inside scenes (default true; page loads before a scene's still are never in a clip). */
  cuts?: boolean;
}

export interface WorkspaceConfig {
  root: string;
  projectsDir: string;
  templatesDir: string;
  /** Workspace components (`<namespace>/<name>/component.yaml`), scanned before the built-in library. */
  componentsDir: string;
  browser?: BrowserConfig;
  /** ffmpeg binary (ffprobe is looked for beside it); default: $RETAKE_FFMPEG, the app's own, else "ffmpeg" on PATH. */
  ffmpeg?: string;
  /** retake.yaml `render:`: this machine's render settings (each key wins over its RETAKE_RENDER_* variable). */
  render?: RenderSettings;
}

export interface LoadedProject {
  slug: string;
  /** Absolute project directory. */
  dir: string;
  /** Workspace root the project belongs to (for template resolution). */
  root: string;
  /** project.yaml with defaults applied (capture, frame, template). */
  config: ProjectConfig;
  readme: string | null;
  /** Scenario names (scenarios/<name>.yaml). */
  scenarios: string[];
  /** Absolute path of project.yaml. */
  file: string;
  /** Non-blocking issues (warnings) of project.yaml, set by loadProject. */
  issues?: ValidationIssue[];
  /** The sandboxes of project.yaml `sandboxes:`, by environment name; absent when it declares none. */
  sandboxes?: Record<string, LoadedSandbox>;
}
