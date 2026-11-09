/**
 * L6.12: StudioOps — every op the Studio serves, with its arguments and its result: `call` / `useCall` (api.ts) are
 * typed by it, so an op the Studio does not serve, an argument its input refuses or a result read as another type is a
 * compile error.
 *
 * - The arguments are generated (studio-ops.gen.ts) from the Studio's op table: each op's zod input as
 *   `/v1/call/<op>` parses it. The server's tables erase their types (each op is a `ToolDef`, its handler's answer a
 *   `Record<string, unknown>`), so they cannot be inferred: packages/ui/test/studio-ops.test.ts holds the file to them.
 * - The results are declared here: the engine's or the server's type where the op answers exactly that, else the app's
 *   own type of what it reads (the fields the page uses). An op the app never calls answers `unknown`.
 */
import type { FrameCommentAnchor, StepForms, ValidationIssue } from '@retake/core';
import type {
  ActivityItem,
  HeldWork,
  ProjectSummary,
  ProjectView,
  RunListItem,
  RunStatusWithJob,
  ScenarioActions,
  ScenarioEditResult,
  ScenarioRendersView,
  ScenarioSessions,
  ScenarioView,
  SearchHit,
  SessionToConfirm,
  ThemeEditResult,
  ThemeEditView,
} from '@retake/engine';
import type { ThreadAnswer, ThreadApplyAnswer, ThreadGetAnswer, ThreadsListAnswer } from '../../server/comment-ops.js';
import type { LibraryComponentAnswer, LibraryImagesAnswer, LibraryViewAnswer } from '../../server/library-ops.js';
import type { ProjectOverview, RenderReviewAnswer, ReviewExportAnswer, ScenarioRenderAnswer, ScenarioRunAnswer, TimelineViewAnswer } from '../../server/ops.js';
import type { RecordOptionsAnswer, RecordStartAnswer, RecordViewAnswer } from '../../server/record-ops.js';
import type { SiteListAnswer, ThemeListAnswer, ThemePreviewAnswer } from '../../server/theme-ops.js';
import type { StudioOp, StudioOpArgs } from './studio-ops.gen.js';

export type { StudioOp, StudioOpArgs };

// ── The app's own types of what an op answers (the fields the page reads) ─────────────────────────────────────────────

/** engine_info: the engine's version and root, its worker (and the other copy of Retake it runs), held work, legacy notes. */
export interface EngineInfoAnswer {
  version: string;
  root: string;
  projects_dir?: string;
  worker: { pid: number; started_by?: string; other_copy?: boolean } | null;
  /** L5.14: what a filming take holds of this workspace's jobs (absent from an older server). */
  held?: HeldWork | null;
  /** L5.13: the sign-ins of before the rename are left in the old home; old variables are set — neither is read. */
  legacy?: { old_home?: string; old_home_var?: string; old_vars?: string[] };
  /** L5.16c fixes (review c A-L4): the other copy of Retake its worker runs (the lock's text). */
  untrusted?: { worker_other_copy?: unknown };
}

/** project_list: the workspace's projects. */
export interface ProjectList {
  root: string;
  projects_dir: string;
  projects: ProjectSummary[];
}

/** scenario_blocks: the scenario screen's view, and the language's hint of each action the file uses. */
export type ScenarioBlocksView = ScenarioView & { hints?: Record<string, string> };

/** run_thumbs: base64 JPEGs of a run's steps, by the run's own step keys, and the keys without one. */
export interface ThumbAnswer {
  thumbs: Array<{ key: string; mime?: string; base64: string; width: number; height: number; from: string }>;
  missing: Array<{ key: string; reason: string }>;
}

/** A job of the queue, as job_list shows it (the fields the Cast's sessions panel reads); auth_login and sign_in_cancel answer one. */
export interface JobLite {
  id: string;
  kind: string;
  state: string;
  started_at?: string;
  result?: { kind?: string; signed_in?: boolean; status?: string; interrupted?: boolean; profile_kept?: boolean };
  error?: { message?: string };
  untrusted?: { error?: string };
  cancel_requested_at?: string;
}

/** frame_anchor: a frame's anchor for a new thread (its step at that frame now). */
export interface AnchorAnswer {
  frame: number;
  timecode: string;
  anchor: FrameCommentAnchor;
  step_now?: string | null;
  warnings: string[];
}

/** render_frame: one frame of a render as a JPEG. */
export interface FrameAnswer {
  frame: number;
  base64: string;
  width: number;
  height: number;
  timecode: string;
}

/** render_outline: a render's frames, its step markers and its threads' pins. */
export interface Outline {
  render_id: string;
  created_at: string;
  variant: string;
  fps: number;
  frames: number;
  width: number;
  height: number;
  duration_s: number;
  timecode: string;
  markers: Array<{ frame: number; done?: number }>;
  pins: Array<{ id: string; status: 'open' | 'resolved'; frame: number }>;
  untrusted: { markers: string[] };
}

/** threads_counts: each scenario's open and resolved threads. */
export interface ThreadCounts {
  scenarios: Record<string, { open: number; resolved: number }>;
}

/** review_image and thread_still: one picture as a JPEG. */
export interface StillAnswer {
  base64: string;
  width: number;
  height: number;
}

/** brand_files: the workspace's brand images or fonts. */
export interface BrandFiles {
  files: Array<{ ref: string; bytes: number }>;
  truncated: boolean;
}

/** theme_create: the theme made, the palette's adjustments. */
export interface ThemeCreated {
  name: string;
  base: string;
  palette: { adjusted: Array<{ key: string; from: string; to: string; check: string }>; suggestions: { accent?: string } };
  warnings: string[];
}

// The answers of setup_status (the Set-up sheet: shell/setup.ts) and desktop_update_status (the update: shell/update.ts).

export type InstallLocation = 'ok' | 'translocated' | 'read_only' | 'volumes';

export interface CliStatus {
  dir: string;
  default_dir: string;
  link: string;
  launcher: string;
  state: 'absent' | 'ours' | 'other_app' | 'foreign';
  target?: string;
  dangling?: boolean;
  what?: string;
  chosen: boolean;
  chosen_error?: string;
  /** The shell's folder panel: up (`open`), or no folder came back (`cancelled`: cancelled, or another question was up). */
  panel?: 'open' | 'cancelled';
  /** This app's command (the link the app recorded, else the default folder's), when it runs this app. */
  installed: string | null;
  on_path: boolean;
  first: string | null;
  first_is_this: boolean;
  path_line: string;
  profile: string;
}

export interface SetupStatus {
  available: boolean;
  reason?: 'not_supervised' | 'not_bundled';
  version?: string;
  seen?: boolean;
  location?: InstallLocation;
  location_words?: string;
  workspace?: string;
  home?: string;
  home_from_env?: boolean;
  app?: string;
  cli?: CliStatus;
  claude_code?: { claude: string | null; candidates: string[]; config_dir: string; lines: string[]; plugin: boolean };
  /** `running`: true / false, null when the process list could not be read, absent until it was read. */
  claude_desktop?: { file: string; folder: boolean; state: 'create' | 'add' | 'same' | 'replace' | 'unreadable'; entry: string; running?: boolean | null; backups: string };
  notifications?: 'on' | 'off' | 'unknown';
  untrusted?: { desktop_current?: string; desktop_problem?: string };
}


export type UpdateFailure = 'check' | 'download' | 'install' | 'not_writable';
export type UpdateOffReason = 'build' | 'disabled' | 'translocated' | 'read_only';

export interface UpdateStatus {
  available: boolean;
  reason?: 'not_supervised' | UpdateOffReason;
  state?: 'unknown' | 'off' | 'idle' | 'checking' | 'available' | 'downloading' | 'waiting' | 'installing' | 'failed';
  current?: string;
  version?: string | null;
  jobs?: number;
  failure?: UpdateFailure;
  checked?: number | null;
  /** A failure the shell may try again (Install and Restart stays live). */
  retry?: boolean;
  installable?: boolean;
  untrusted?: { notes?: string };
}

/** A Set-up sheet action's answer: the sheet reads it as it comes (the next setup_status says the state). */
export type SetupAnswer = Record<string, unknown>;

/** What each op answers, for the ops the app calls (by the Studio's name of the op). */
export interface StudioOpResults {
  engine_info: EngineInfoAnswer;
  project_list: ProjectList;
  project_get: ProjectView;
  project_update_readme: { hash: string };
  projects_overview: { projects: ProjectOverview[] };
  activity_list: { items: ActivityItem[] };
  search: { hits: SearchHit[] };
  run_list: { runs: RunListItem[] };
  run_status: RunStatusWithJob;
  run_thumbs: ThumbAnswer;
  scenario_blocks: ScenarioBlocksView;
  scenario_forms: StepForms;
  scenario_validate: { issues: ValidationIssue[] };
  // Path-free (ops.ts): the file's project-relative name, never its absolute path.
  scenario_edit: Omit<ScenarioEditResult, 'path'>;
  scenario_actions: ScenarioActions;
  scenario_run: ScenarioRunAnswer;
  scenario_sessions: ScenarioSessions & { confirm: SessionToConfirm[] };
  auth_login: JobLite;
  sign_in_cancel: JobLite;
  job_list: { jobs: JobLite[] };
  timeline_view: TimelineViewAnswer;
  scenario_render: ScenarioRenderAnswer;
  scenario_renders: ScenarioRendersView;
  render_review: RenderReviewAnswer;
  review_image: StillAnswer;
  review_export: ReviewExportAnswer;
  render_outline: Outline;
  render_frame: FrameAnswer;
  frame_anchor: AnchorAnswer;
  threads_list: ThreadsListAnswer;
  threads_counts: ThreadCounts;
  thread_get: ThreadGetAnswer;
  thread_still: StillAnswer;
  thread_add: { thread: ThreadAnswer; warnings: string[] };
  thread_apply: ThreadApplyAnswer;
  library_view: LibraryViewAnswer;
  library_component: LibraryComponentAnswer;
  library_images: LibraryImagesAnswer;
  theme_list: ThemeListAnswer;
  theme_view: ThemeEditView;
  theme_edit: ThemeEditResult;
  theme_copy: { name: string };
  theme_create: ThemeCreated;
  theme_preview: ThemePreviewAnswer;
  brand_files: BrandFiles;
  site_list: SiteListAnswer;
  record_options: RecordOptionsAnswer;
  record_start: RecordStartAnswer;
  record_view: RecordViewAnswer;
  record_annotate: { rev: number; insert_id?: string; view: RecordViewAnswer };
  record_stop: { action: string; view: RecordViewAnswer };
  record_discard: { rec_id: string; state: 'discarded' | 'discarding' };
  record_save: { name: string; file: string };
  setup_status: SetupStatus;
  setup_cli_install: SetupAnswer;
  setup_cli_choose: SetupAnswer;
  setup_cli_remove: SetupAnswer;
  setup_claude_code_run: SetupAnswer;
  setup_claude_desktop_add: SetupAnswer;
  setup_notifications: SetupAnswer;
  desktop_update_status: UpdateStatus;
}

/** Every op the Studio serves: its arguments (generated) and its result (declared above; `unknown` when the app reads none). */
export type StudioOps = {
  [K in StudioOp]: { args: StudioOpArgs[K]; result: K extends keyof StudioOpResults ? StudioOpResults[K] : unknown };
};
