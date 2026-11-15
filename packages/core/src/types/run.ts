/**
 * The run context's types (@retake/core/run): the timeline a runner emits (scenes, tracks, events, markers, cursor,
 * loading, artefacts, environment) and the run record's parts (status, errors, engine, performance, outline).
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */
import type { EnvironmentAccess, ResolvedClock, TimelineWrite } from './environment.js';
import type {
  ActionName,
  CameraHint,
  CardSpec,
  FrameSpec,
  InterstitialSpec,
  OverlayAnchor,
  OverlayAt,
  SceneTransition,
  TimelineVideo,
  TutorialSwitch,
  ViewportPreset,
  ViewportSpec,
} from './language.js';
import type { BBox, ComponentId, PointSpec } from './model.js';
import type { RunSandbox } from './sandbox.js';

export interface TimelineScene {
  id: string;
  index: number;
  kind: 'scene' | 'interstitial' | 'card';
  /** Capture time. Interstitials and cards have t_start === t_end (they take no capture time). */
  t_start: number;
  t_end: number;
  /** Time the scene's "still" ends (actions begin). */
  t_actions?: number;
  page?: string;
  url?: string;
  caption?: { kicker?: string; text: string };
  speed?: number;
  transition?: SceneTransition;
  /** Scene-level frame as written in the scenario (the scenario/project default is in `Timeline.video.frame`). */
  frame?: FrameSpec;
  interstitial?: InterstitialSpec;
  card?: CardSpec;
  /** Scene-level tutorial switches as written (the scenario's are in `Timeline.video.tutorial`). */
  tutorial?: TutorialSwitch;
  /**
   * Multi-page scene: the pages filmed at the same time, in the scenario's order; each one is recorded on its
   * own track (`Timeline.tracks`). Absent for a single-page scene (recorded in `capture`).
   */
  pages?: TimelineScenePage[];
  /** Played during the take but left out of the video (scene `offscreen: true`): the edit shows nothing of it. */
  offscreen?: true;
  status: 'ok' | 'failed' | 'skipped' | 'partial';
}

/** A page of a multi-page scene as the run filmed it. */
export interface TimelineScenePage {
  /** Page id (the key of the scene's `pages`). */
  id: string;
  /** Environment page key its URLs resolve against, when it has one. */
  page?: string;
  label?: string;
  /** Viewport in CSS px (`preset` when it came from one). */
  viewport: ViewportSpec & { preset?: ViewportPreset };
  /** URL at the end of the scene's still. */
  url?: string;
  /** Id of the track holding its video (`Timeline.tracks`). */
  track: string;
}

/**
 * A page recorded on its own: every page of a multi-page scene gets one, on the same clock as `capture`
 * (frame n of every track is capture time n / fps: one frame grid). Outside the scenes that film it, a track holds its
 * last frame.
 */
export interface TimelineTrack {
  /** The page id. */
  id: string;
  /** CFR video, relative to the run directory (`capture-<id>.mp4`). */
  file: string;
  /** Frame index of the screencast (one {file, t} per line), relative to the run directory. */
  frames_file: string;
  /** Viewport in CSS px, device scale factor, mobile emulation. */
  width: number;
  height: number;
  scale: number;
  mobile?: boolean;
  touch?: boolean;
  preset?: ViewportPreset;
  fps: number;
  /** Screencast frames received. */
  frames: number;
  /** Capture-time intervals during which the page was recorded. */
  recording: Array<{ t_start: number; t_end: number }>;
  /** URL segments of the page while recorded (the browser chrome of a layout shows them). */
  pages: TimelinePageSegment[];
  /** This page's in-page cursor (each page has its own; only the acting page's moves). */
  cursor: CursorSample[];
  /** Icon changes, presses and click ripples of this page's cursor. */
  cursor_effects?: CursorEffect[];
  /** Page loads this track did not show (R-ISS-08; absent when none). */
  loading?: TimelineLoading[];
}

/**
 * A full-page load the capture did not show (R-ISS-08): from a new document's commit — or the recorder attaching
 * to a page that had painted nothing yet (a fresh tab, a page still loading) — the recorder kept the previous frame on
 * screen until the new document's first contentful paint. `t_end` is the first frame written after it (the moment
 * the hold ended when no frame came then): no frame of the capture (frames.jsonl) lies in [t_start, t_end).
 */
export interface TimelineLoading {
  t_start: number;
  t_end: number;
  /** Page id. */
  page?: string;
  /**
   * What ended it: the page's first contentful paint (`paint`); its load without one — no text, image or SVG, a PDF
   * viewer — once its network was idle, plus a grace (`load`: shown from then); the 10 s limit (`limit`: the page is
   * filmed as it is from then, with a run warning — also a fresh tab left blank); the recorder leaving the page — a page
   * switch, a multi-page scene's pause — (`left`); the end of the run (`end`).
   */
  until: 'paint' | 'load' | 'limit' | 'left' | 'end';
  /** Screencast frames not written. */
  held_frames: number;
}

/** A freeze of the capture: no new frame from `t_start` (the last frame before the gap) to `t_end`. */
export interface TimelineStall {
  t_start: number;
  t_end: number;
  during: 'move' | 'ripple';
}

/**
 * Hotfix v0.2.6: a loading indicator the page showed in its viewport while the take recorded — a skeleton, a shimmer, a
 * spinner, an `aria-busy` region (`what`: their kinds, e.g. "skeleton ×6") — from `t_start` to `t_end` (capture s).
 */
export interface TimelineLoadingUi {
  t_start: number;
  t_end: number;
  what: string;
  /** Page id. */
  page?: string;
}

/** A wait the screen showed after the click at `click` (capture seconds): near-identical frames from `t_start` to `t_end`. */
export interface TimelineBusy {
  t_start: number;
  t_end: number;
  click: number;
}

/**
 * A pause of the take (R-UI-19): the run waited before step `step` of `scene` for `ms` wall ms, which capture time
 * left out — the video goes on at `t` (capture seconds) from where it paused; what the page did meanwhile (timers,
 * animations, a running product clock) shows as a jump there.
 */
export interface TimelinePause {
  t: number;
  ms: number;
  scene: string;
  step: number;
}

/**
 * Held page loads (`TimelineLoading`) at least this long are cut by the edit and the raw export; a shorter freeze of
 * the previous frame is invisible (the same bound as the capture's stalls). The cut sits on the page change itself.
 */
export const LOADING_CUT_MIN_S = 0.15;

/** Step `overlay` as recorded by the runner: the spec plus the target measured at the END of the step. */
export interface TimelineOverlay {
  component: ComponentId;
  slots: Record<string, string>;
  params: Record<string, unknown>;
  /** Seconds, when the scenario sets it (else the component's default). */
  duration?: number;
  /** Description of the target that was measured. */
  target?: string;
  /** Target bbox at the end of the step (after any scroll), CSS px. */
  bbox?: BBox;
  /** Anchor point when there is no target bbox (cursor position at the end of the step). */
  point?: PointSpec;
  /** When it starts, as written (default: the end of the step). */
  at?: OverlayAt;
  /** A box-filling overlay (a user video, image or Lottie file): where its box goes. */
  box?: { anchor?: OverlayAnchor; rect?: BBox; scale?: number };
}

export interface TimelineEvent {
  scene: string;
  scene_index: number;
  /** Step index within the scene. */
  step: number;
  id?: string;
  /**
   * `notification`: a web notification the product showed (Notification API or a service worker's showNotification),
   * captured by the in-page kit — `step` is -1 (it belongs to no step) and `data` = {name, title, body, icon?, tag?,
   * artefact}; the artefact is in `Timeline.artefacts`.
   */
  action: ActionName | 'scene_open' | 'scene_still' | 'notification';
  /** Capture time at which the action started (cursor starts moving, etc.). */
  t_start: number;
  /** Capture time at which the action itself completed (before any `hold`). */
  t_end: number;
  /** Stillness requested by the `hold` modifier: [t_end, t_end + hold]. */
  hold?: { t_start: number; t_end: number };
  /** The moment of the click/press (mousedown) for pointer actions. */
  t_click?: number;
  target?: { desc: string; bbox?: BBox };
  /** Cursor position at the click/end of the action. */
  point?: PointSpec;
  /**
   * Cursor position at the end of the step, before any park or hold: what an overlay or a camera hint added to
   * the scenario after the capture anchors to when the step has no target box.
   */
  end_point?: PointSpec;
  mark?: string;
  caption?: { kicker?: string; text: string };
  speed?: number;
  /** Camera hint; `bbox` (target) / `point` measured at the end of the step, after any scroll. */
  camera?: CameraHint & { bbox?: BBox; point?: PointSpec };
  overlay?: TimelineOverlay;
  /** Step-level tutorial switches as written. */
  tutorial?: TutorialSwitch;
  page?: string;
  url?: string;
  status: 'ok' | 'skipped' | 'failed' | 'dry';
  /** Click strategy that worked (real/dom/pointer). */
  strategy?: string;
  popup_opened?: boolean;
  error?: string;
  /** `emit` payload, screenshot path, etc. */
  data?: unknown;
}

export interface TimelineMarker {
  name: string;
  t: number;
  scene: string;
  step: number;
  /** Multi-page scenes: the page the marked step acts on. */
  page?: string;
}

export interface TimelinePageSegment {
  /** Page id (environment page key, "tab2", or `as`). */
  id: string;
  t_start: number;
  t_end: number;
  url?: string;
}

export interface CursorSample {
  t: number;
  x: number;
  y: number;
  visible: boolean;
  down?: boolean;
}

/** Icon the in-page cursor draws: arrow, pointing hand (links, buttons), text beam (fields). */
export const CURSOR_ICONS = ['arrow', 'hand', 'ibeam'] as const;

export type CursorIcon = (typeof CURSOR_ICONS)[number];

/**
 * What the in-page cursor showed besides its position, reported by the kit as it drew it: `icon` (the icon
 * changed), `press` / `release` (the press scale), `ripple` (a click ripple centred at x, y, CSS px).
 */
export interface CursorEffect {
  t: number;
  type: 'icon' | 'press' | 'release' | 'ripple';
  icon?: CursorIcon;
  x?: number;
  y?: number;
}

/** Folder of a run holding the captured artefacts (emails/, documents/, notifications/). */
export const ARTEFACTS_DIR = 'artefacts';

export type ArtefactKind = 'email' | 'document' | 'notification' | 'text';

/** An image of an artefact (rendered email, PDF page, notification icon); `file` is relative to the run directory. */
export interface ArtefactImage {
  file: string;
  /** Pixels. */
  width: number;
  height: number;
}

interface ArtefactBase {
  kind: ArtefactKind;
  /** The step's `as` (emails, documents), or the notification name (its `tag`, else "notification-<n>"). */
  name: string;
  /** Capture time it was captured at. */
  t: number;
  /** Scene / step that captured it (a notification: the scene and step running when it showed). */
  scene?: string;
  step?: number;
}

export interface EmailArtefact extends ArtefactBase {
  kind: 'email';
  /** artefacts/emails/<name>.json: {from, to, subject, date, text, html} as captured. */
  file: string;
  from: string;
  /** Display name of the sender, when the message has one. */
  from_name?: string;
  to: string[];
  subject: string;
  /** ISO 8601. */
  date: string;
  /** The first characters of the text part (whitespace collapsed), for components. */
  preview: string;
  /** The HTML rendered at 600 px width, full height (absent when the message has no HTML part or rendering failed). */
  image?: ArtefactImage;
  /** The persona whose mailbox it was waited for in (`to: persona:<name>`): mail cards label the mailbox after it. */
  persona?: string;
}

export interface DocumentPage extends ArtefactImage {
  /** Page size in PDF points (1/72 in). */
  width_pt: number;
  height_pt: number;
}

export interface DocumentArtefact extends ArtefactBase {
  kind: 'document';
  /** artefacts/documents/<name>.<ext>. */
  file: string;
  mime: string;
  /** File name the server suggested (download) or the URL's last segment. */
  file_name: string;
  /** How it was captured: the browser's download event, a document opened in a new tab, or a project file. */
  via: 'download' | 'tab' | 'project';
  url?: string;
  bytes: number;
  /** PDFs: every page rasterised at 2× (A4 → ≈ 1587 × 2245 px) into documents/<name>/page-<n>.png; images: the image. */
  pages: DocumentPage[];
}

export interface NotificationArtefact extends ArtefactBase {
  kind: 'notification';
  /** artefacts/notifications/<name>.json. */
  file: string;
  /** 1-based order of capture in the run. */
  index: number;
  title: string;
  body: string;
  tag?: string;
  /** The icon, fetched with the session (absent when the notification has none or it could not be fetched). */
  icon?: ArtefactImage;
  /** Icon URL as the page gave it (resolved against the page URL). */
  icon_url?: string;
  /** Origin of the page that showed it (the "app" a system notification names). */
  origin: string;
  /** Environment page key that showed it. */
  page?: string;
  via: 'Notification' | 'ServiceWorkerRegistration.showNotification';
  /** ISO 8601 wall time. */
  time: string;
}

/** A text read from the page by `capture_text`: a figure for a card (`capture: <name>`). */
export interface TextArtefact extends ArtefactBase {
  kind: 'text';
  /** artefacts/texts/<name>.json: {value, text, target, pattern?}. */
  file: string;
  /** What the card shows: the pattern's first group (else its match), else the whole text. */
  value: string;
  /** The element's visible text, whitespace collapsed. */
  text: string;
  /** Description of the element read, and its box at that moment (CSS px). */
  target: string;
  bbox?: BBox;
  pattern?: string;
}

export type TimelineArtefact = EmailArtefact | DocumentArtefact | NotificationArtefact | TextArtefact;

export interface Timeline {
  version: 1;
  run_id: string;
  project: string;
  scenario: string;
  created_at: string;
  mode: 'capture' | 'dry';
  capture: {
    file: string;
    width: number;
    height: number;
    scale: number;
    fps: number;
    /** Seconds. */
    duration: number;
    /**
     * Wall-clock epoch ms of capture time 0. A take paused from the Studio (`pauses`) does not film its pauses:
     * a later wall time converts with them applied — (wall − t0_wall) / 1000, less the `ms` / 1000 of every pause
     * before it (one that falls inside a pause is that pause's `t`).
     */
    t0_wall: number;
    frames: number;
    /**
     * `hidden`: captured without the in-page cursor (`retake run --raw --cursor none|layer`) — real input,
     * cursor track and effects recorded as usual, nothing drawn. Absent: the cursor is in the pictures.
     */
    cursor?: 'hidden';
  };
  /** Title, intro, outro, frame, template and music of the scenario (written by runners; older runs have none). */
  video?: TimelineVideo;
  scenes: TimelineScene[];
  events: TimelineEvent[];
  markers: TimelineMarker[];
  /** URL segments of `capture` (the recorded page of single-page scenes; per-page tracks keep their own). */
  pages: TimelinePageSegment[];
  /** The cursor of `capture` (per-page tracks keep their own: `tracks[].cursor`). */
  cursor: CursorSample[];
  /**
   * What the in-page cursor of `capture` showed besides its position (absent in older runs): icon changes,
   * presses and click ripples, as the kit drew them (per-page tracks keep their own).
   */
  cursor_effects?: CursorEffect[];
  /**
   * Intervals where the screen did not change at all (no screencast frame) for ≥ 0.5 s — of any recorded page: with
   * tracks, a frame of any of them counts.
   */
  idle: Array<{ t_start: number; t_end: number }>;
  /** Page loads `capture` did not show (R-ISS-08; absent when none — and in older runs). */
  loading?: TimelineLoading[];
  /**
   * Where `capture` froze while the cursor moved or a click ripple played (absent when it never did): the frame
   * before the gap held from `t_start` to `t_end`. The edit cuts the frozen part (R-ISS-12, R-FLD-20).
   */
  stalls?: TimelineStall[];
  /**
   * Waits the screen showed after a click (R-FLD-26; absent when none): near-identical frames — a skeleton, a
   * spinner, a blank panel — before the content the click asked for appeared. The edit shortens them.
   */
  busy?: TimelineBusy[];
  /** Hotfix v0.2.6: loading indicators in the filmed page's viewport (absent when none: the review's `loading-filmed`). */
  loading_ui?: TimelineLoadingUi[];
  /** Where the take was paused between steps (absent when it never was): capture time did not run meanwhile. */
  pauses?: TimelinePause[];
  /**
   * Emails, documents and web notifications and texts (`capture_text`) captured by the run; files are
   * relative to the run directory.
   */
  artefacts?: TimelineArtefact[];
  /**
   * Multi-page scenes: one track per page they film, recorded at the same time as each other on the capture
   * clock. Absent when every scene films one page (`capture` holds everything).
   */
  tracks?: TimelineTrack[];
  /** The environment the run filmed (absent in older runs): access, display URLs, clock, writes stopped. */
  environment?: TimelineEnvironment;
  warnings: string[];
}

/**
 * The environment of a run. URLs elsewhere in the timeline stay the real ones; `display` maps them to what the
 * video shows.
 */
export interface TimelineEnvironment {
  name: string;
  production?: true;
  /** The run's effective access. */
  access: EnvironmentAccess;
  /** The run was allowed to write to production (`--allow-writes` where project.yaml sets `access: read-write`). */
  allow_writes?: true;
  /** The display base of each page that declares one: `url` is its real base URL. */
  display?: Array<{ page: string; url: string; display: string }>;
  /** The product's clock (`clock:` of the scenario or the project). */
  clock?: ResolvedClock;
  /** Writes the read-only guard stopped, answered or let through, and writes that went to hosts it does not guard. */
  writes?: TimelineWrite[];
  /** A sandbox environment: its provider and the reset made before the take. */
  sandbox?: RunSandbox;
}

export type RunMode = 'capture' | 'dry';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunError {
  message: string;
  scene?: string;
  step?: number;
  action?: string;
  screenshot?: string;
  dom?: string;
  /**
   * A target was not found: the targets of the scene's later steps that do not resolve on the page either,
   * looked up without acting, with the visible elements closest to each — every renamed label of a scene in one take.
   */
  missing_targets?: MissingTarget[];
}

/** A visible element close to a target that was not found (role, accessible name, text). */
export interface NearElement {
  role?: string;
  name?: string;
  text?: string;
}

/** A step target that does not resolve on the page a run failed on (RunError.missing_targets). */
export interface MissingTarget {
  scene: string;
  step: number;
  action: string;
  /** Description of the target (`label="Quantity"`). */
  target: string;
  near: NearElement[];
}

/** An `optional` step that failed (run.json `optional_failures`): the run went on. */
export interface OptionalFailure {
  scene: string;
  step: number;
  action: string;
  error: string;
  screenshot?: string;
}

/** What ran a capture (run.json `engine`, R-PRIN-13): explains a difference between two machines' takes. */
export interface RunEngine {
  /** Retake version. */
  retake: string;
  /** Node.js version. */
  node: string;
  /** The browser's version (absent when it did not open). */
  chromium?: string;
  /** Platform, release and architecture, e.g. "darwin 25.6.0 arm64". */
  os: string;
  /** The fonts installed on the machine: the number of font files and a digest (sha256, 12 hex) of their names. */
  fonts?: { files: number; digest: string };
}

// runs/<id>/run.json — the run record, its states and its reader: run-record.ts (RunRecord, StoredRunRecord).

/** run.json `perf` (R-FLD-23): what a take cost and how smoothly it was filmed. */
export interface RunPerf {
  /** Seconds of the take (capture time 0 to its end; the pauses of a take paused from the Studio left out). */
  seconds: number;
  /** CPU seconds per process group over the take, sampled from the system's process table (absent when it failed). */
  cpu?: RunPerfCpu;
  /**
   * The machine during the take: logical CPUs and the 1-minute load average (mean and highest). Captures first:
   * `takes_beside` — the most other takes filming at once on this Mac while it filmed (absent: not sampled, an older
   * run); `heavy_slowed` — heavy work (a render, a review, an export, a preview, a site extraction) of its workspace's
   * jobs worker ran slowed at background priority during it. Not counted: a terminal `retake render` that waited or
   * slowed itself (it has no job), heavy work of another workspace.
   */
  machine: { cpus: number; load_mean: number; load_max: number; takes_beside?: number; heavy_slowed?: true };
  /** Chromium's GPU status (its own feature report): hardware accelerated or not, and the features that fell back to software. */
  gpu?: { accelerated: boolean; renderer?: string; software?: string[] };
  /** Chromium's frame-rate limiter was on (browser.frame_rate_limit). */
  frame_rate_limit: boolean;
  /**
   * Screencast frames received, their mean rate over the take, the lowest rate of a cursor move, the frames dropped by
   * the size check, and the fresh frames asked for while a click ripple played (R-FLD-20).
   */
  frames: { received: number; fps: number; motion_fps_min?: number; dropped: number; kicked: number };
  /** Freezes of the capture while the cursor moved or a click ripple played (≥ 150 ms). */
  stalls: Array<{ t: number; ms: number; during: 'move' | 'ripple' }>;
  /** Click → stable content: the clicks measured and the slow ones (over 800 ms), slowest first. */
  transitions?: { measured: number; slow: PerfTransition[] };
  /**
   * The Studio's live picture was watched during the take — the seconds its screencast ran and the frames it sent
   * (Chromium's browser process encoded them on top of the capture). Absent when nobody watched.
   */
  live_preview?: { seconds: number; frames_sent: number };
  /** The encoder fed during the take: codec, quality, the wait for its end after the take, frames that came too late for their tick. */
  encode?: { codec: string; quality: string; finish_ms: number; late_frames: number };
  /** The run folder (MB), whether its frames were kept, and the free space left on its disk (GB). */
  disk?: { run_mb: number; frames_kept: boolean; free_gb?: number };
}

/** CPU seconds per process group of a take (`RunPerf.cpu`). */
export interface RunPerfCpu {
  /** Chromium: its browser processes (the screencast's JPEG encoding happens there), GPU processes, page renderers, other helpers. */
  browser: number;
  gpu: number;
  renderer: number;
  chromium_other: number;
  /** Retake's own process (the runner). */
  retake: number;
  /** ffmpeg encoding capture.mp4. */
  encoder: number;
  /** The product's local servers (a sandbox's process services), when known. */
  product?: number;
  total: number;
  /** total / seconds: the cores the take kept busy on average. */
  cores: number;
  /**
   * Per browser (one per persona): CPU seconds of its processes, and of the time no recorder filmed it (R-FLD-25: what
   * a page nobody watches costs — its polling, its animations).
   */
  browsers?: Array<{ persona?: string; cpu: number; unfilmed?: { cpu: number; seconds: number } }>;
}

/** A click whose result took long to settle on screen (`RunPerf.transitions`). */
export interface PerfTransition {
  /** Capture time of the press. */
  t: number;
  /** Press → the last change of the screen before it stood still. */
  ms: number;
  scene: string;
  step: number;
  target?: string;
}

/** One pause of a run: before step `step` of `scene`, from `at` (ISO), `ms` long. */
export interface RunPause {
  scene: string;
  step: number;
  at: string;
  ms: number;
}

/** One step a run executes, as its `outline` event lists it: the step's own description, redacted. */
export interface RunOutlineStep {
  scene: string;
  /** 0-based step index in the scene. */
  step: number;
  action: string;
  desc: string;
  /** A step of an `offscreen: true` scene: played, live and pausable like any other, left out of the video. */
  offscreen?: true;
}

/**
 * A persona's result in a run's preflight: signed in, saved but not checked, no session (the single-account
 * form starts signed out), signed in automatically off camera, or failing (the run stops before anything is filmed).
 */
export type RunSessionStatus = 'valid' | 'unchecked' | 'none' | 'signed_in_auto' | 'failed';

// The progress events a runner streams (RunProgress) carry the run record: run-record.ts.
