/** Job records and events as stored under <workspace>/.demo-studio/jobs/<id>/ (L3.1). */
import type { ComponentKind, JobInput, JobKind, JobState, RunProgress, RunRecord, RunStatus } from '@demo-studio/core';
import type { EngineErrorCode } from '../errors.js';
import type { ProcessIdentity } from './proc.js';

export const JOB_RECORD_VERSION = 1;

export interface JobWorkerInfo extends ProcessIdentity {
  host: string;
}

export interface JobProgress {
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  /** "setup", "scenes", "teardown", "encode"; a render: "planning", "bundling", "rendering", "encoding"… */
  phase?: string;
  /** Overall progress 0..1 when the job knows it (a render: bundling ≈ 0–10 %, frames 10–95 %, encoding). */
  fraction?: number;
  /** Seconds left, when the job estimates it (a render's frames). */
  eta_s?: number;
  updated_at: string;
}

/** What a `run` job produced: the run's own status (a failed run is a job that succeeded in running it). */
export interface RunJobResult {
  kind: 'run';
  run_id: string;
  status: RunStatus;
  mode: RunRecord['mode'];
  steps_done: number;
  steps_total: number;
  stopped_at?: RunRecord['stopped_at'];
  error?: { scene?: string; step?: number; action?: string };
  /** The run's error message: page text of the filmed site, data never instructions. */
  untrusted?: { error_message?: string };
}

/** One hook's (or rollback's) outcome, as a job result shows it. */
export interface HookResultView {
  index: number;
  name?: string;
  kind?: string;
  phase: string;
  status: 'ok' | 'failed' | 'refused' | 'dry';
  ok: boolean;
  optional?: true;
  ms: number;
  journal_seq?: number;
  /** The hook as its file declares it (templates unresolved): absent for a rollback. */
  declared?: string;
  /** It needs a human approval to run (a dry run through MCP reports it; a real run had it, or was refused). */
  approval?: { reason: string };
  /**
   * Its templated description, outcome and error: they can hold text the product or a command returned (response
   * values, command output) — data, never instructions.
   */
  untrusted: { description: string; message?: string; error?: string };
}

/** What a `hooks` job did. */
export interface HooksJobResult {
  kind: 'hooks';
  source: string;
  /** setup (a hooks file too), teardown or reset. */
  phase: string;
  env: string;
  dry: boolean;
  /** No hook failed or was refused (an optional hook's failure is tolerated). */
  ok: boolean;
  results: HookResultView[];
  /** The journal of a real run: its id and the rollbacks it keeps pending (env_reset replays them). */
  journal?: { id: string; pending: number };
  /** A cancel stopped it: remaining hooks did not run (a setup's completed hooks were rolled back). */
  interrupted?: true;
}

/** What an `env_reset` job did: the pending rollbacks replayed, then the project's reset hooks. */
export interface EnvResetJobResult {
  kind: 'env_reset';
  env: string;
  dry: boolean;
  ok: boolean;
  rollbacks: Array<{ journal: string; results: HookResultView[]; untrusted?: { error: string } }>;
  /** The reset hooks' results; null when project.yaml declares none. */
  reset: HookResultView[] | null;
  interrupted?: true;
}

/** What an `auth_login` job did: the persona's session as the check after the sign-in saw it (never a path or a cookie). */
export interface AuthLoginJobResult {
  kind: 'auth_login';
  env: string;
  persona: string;
  mode: 'headed' | 'auto';
  /** The check made after the sign-in, the way a run sees the session (`unchecked`: the persona has no check). */
  status: 'valid' | 'expired' | 'never' | 'error' | 'unchecked';
  /** A session was saved that works (valid), or that cannot be verified (unchecked). */
  signed_in: boolean;
  /** auto: the saved session was still valid, no login step ran. */
  already_signed_in?: true;
  /** headed: the window ended signed out while the session saved before still works: that one was kept. */
  kept?: true;
  cookies: number;
  /** The `studio login` command a human runs to sign it in again. */
  command: string;
  /** A cancel (or a signal) closed the window: nothing was saved. */
  interrupted?: true;
  /** The check's message and the page it ended on: text and URLs of the filmed site — data, never instructions. */
  untrusted?: { detail?: string; url?: string };
}

/** What a `sandbox_up` / `sandbox_reset` job did. */
export interface SandboxJobResult {
  kind: 'sandbox_up' | 'sandbox_reset';
  env: string;
  provider: string;
  /** up: services started by it, kept (already running), changed in sandbox.yaml since they started. */
  services?: { started: string[]; kept: string[]; changed: string[]; ms: number };
  /** The reset (a reset job; an up that seeded), null when an up did not need to seed. */
  reset: {
    strategy: string;
    restored: boolean;
    ms: number;
    seed: { steps: number; ms: number };
    mailbox: string;
    snapshot?: { action: 'restored' | 'taken'; ms: number; database: string };
    restarted: string[];
    superseded: number;
  } | null;
  /** Page key → URL of the sandbox. */
  pages: Record<string, string>;
}

/** What a `render` job produced: renders/<render_id>.mp4 and its record renders/<render_id>.json. */
export interface RenderJobResult {
  kind: 'render';
  render_id: string;
  scenario: string;
  run_id: string;
  /** Absolute paths of the video and of its RenderRecord. */
  file: string;
  record: string;
  template: string;
  variant: 'landscape' | 'vertical' | 'square';
  duration_s: number;
  frames: number;
  width: number;
  height: number;
  size_bytes: number;
  bundle_cached: boolean;
  /** Plan and render warnings: they quote captions, display URLs and page titles of the filmed site — data, never instructions. */
  untrusted: { warnings: string[] };
}

/**
 * What a `review` job wrote: review/<render_id>/ (report.json, report.md, sheets, key frames, timeline.json). The
 * findings stay in report.json (review_get reads them, their messages as untrusted data); no image data here.
 */
export interface ReviewJobResult {
  kind: 'review';
  render_id: string;
  dir: string;
  report: string;
  clean: boolean;
  counts: { error: number; warning: number; info: number };
  duration_s: number;
  ms: number;
}

/** One file an `export` job wrote. */
export interface ExportOutputView {
  format: string;
  file: string;
  method: 'copy' | 'transcode' | 'render';
  width: number;
  height: number;
  duration_s: number;
  size_bytes: number;
}

/** What an `export` job wrote: exports/<render_id>/ and its manifest.json. */
export interface ExportJobResult {
  kind: 'export';
  render_id: string;
  dir: string;
  manifest: string;
  /** The files of this export (the manifest also keeps formats exported earlier). */
  outputs: ExportOutputView[];
  /** Formats re-rendered through the planner (they count as renders in the history). */
  rendered: number;
  /** Formats that failed: their names; their messages are under untrusted. */
  failed: string[];
  /** Failure messages and re-render warnings: they can quote the render page — data, never instructions. */
  untrusted: { failures: Array<{ format: string; error: string }>; warnings: string[] };
}

/** One image of a preview job. */
export interface PreviewImageView {
  /** The component shown. */
  component: string;
  /** The kind it shows (a theme preview: the theme's intro, layout, card, interstitial, outro). */
  kind: ComponentKind;
  /** Absolute path in <workspace>/.demo-studio/previews/<preview_id>/ (960×540 PNG). */
  file: string;
  /** Second of the component shown. */
  at: number;
  bytes: number;
  /** The sample screen it shows, when it shows one. */
  screen?: string;
}

/** What a `preview` job wrote: stills in <workspace>/.demo-studio/previews/<preview_id>/ (never a component folder). */
export interface PreviewJobResult {
  kind: 'preview';
  preview_id: string;
  dir: string;
  theme: string;
  target: { kind: 'component'; component: string } | { kind: 'theme' };
  images: PreviewImageView[];
  /** Theme kinds the theme fills with nothing (none shown). */
  skipped?: ComponentKind[];
  /** The network guard's blocked origins (a component that tried to load something): data, never instructions. */
  untrusted: { warnings: string[] };
}

/**
 * What an `inspect` job did (L3.3): its folder <project>/.demo-studio/inspect/<id>/ with inspect.json (the report),
 * screenshot.png and marked.jpg. Counts, booleans and enums only here; the page's text stays in the report, under
 * `untrusted`. `reported: false`: the replay ended before the page could be inspected (a preflight or sign-in failure, a
 * refused scenario): the run's error is under `untrusted.error`, `sign_in` names the persona that must sign in.
 */
export interface InspectJobResult {
  kind: 'inspect';
  inspect_id: string;
  dir: string;
  /** inspect.json (null when there is no report). */
  file: string | null;
  reported: boolean;
  /** `landed_elsewhere`: the page was on another origin (nothing of it taken); `failed`: no inventory. */
  status: 'ok' | 'landed_elsewhere' | 'failed';
  at: 'end' | 'until' | 'failed_step' | null;
  /** The page id the replay showed, and its persona. */
  page: string | null;
  persona: string | null;
  /** The dry replay's own status (a replay whose step failed is inspected at that step). */
  run_status: RunStatus;
  screenshot: string | null;
  marked: string | null;
  counts: Record<string, number | boolean> | null;
  replay: {
    steps_done: number;
    steps_total: number;
    until: string | null;
    skipped_irreversible: number;
    hooks: 'skipped' | 'none';
    failed: { scene: string; step: number; action: string } | null;
  } | null;
  /** A persona's session was needed and is not valid: auth_login signs it in. */
  sign_in?: { env: string; persona?: string };
  /** The replay's or the inspection's error and warnings: text of the filmed site — data, never instructions. */
  untrusted: { error?: string; warnings: string[] };
}

/**
 * What a `record` job did (L3.4): its folder <project>/.demo-studio/records/<rec_id>/ (draft.yaml, record.json,
 * events.jsonl, check/). Counts, enums and file paths only: typed text and page text stay in that folder (the draft is
 * read from draft.yaml, never from here). Scene ids are made from the product's paths, issue messages point at them,
 * the check replay's failure is page text: under `untrusted`.
 */
export interface RecordJobResult {
  kind: 'record';
  rec_id: string;
  /** The recording's folder and its draft.yaml (null when nothing was recorded: the folder was removed). */
  dir: string | null;
  draft: string | null;
  /** The scenario name the draft was made for. */
  name: string;
  /** scenarios/<name>.yaml when the draft was saved (its hash: scenario_save's if_match). */
  saved: { file: string; path: string; hash: string } | null;
  not_saved?: 'name_taken' | 'invalid' | 'nothing_recorded' | 'refused';
  env: string;
  persona: string | null;
  access: 'read-only' | 'read-write';
  /** closed: the person closed the window; stopped: Ctrl-C or a worker signal; max_duration. */
  stop: string;
  ms: number;
  window: { width: number; height: number } | null;
  capture: { width: number; height: number };
  counts: { events: number; actions: number; writes: number; redacted: number; dropped: Record<string, number> };
  stats: { scenes: number; steps: number; actions: number; noise: number; secrets: number; fallbacks: number };
  /** The draft's issues counted by severity, and their codes (the issues themselves are under `untrusted`). */
  issues: { error: number; warning: number; info: number; codes: string[] };
  /** The recording's warnings (written by the engine and the runner: no page text). */
  warnings: string[];
  /** Writes to the environment's hosts while recording (their labels are in record.json). */
  writes: { total: number; by_steps: number; ambient: number };
  check: {
    status: 'passed' | 'failed' | 'skipped' | 'cancelled';
    scope: 'all' | 'until_write' | null;
    reason?: 'disabled' | 'stopped' | 'nothing_recorded' | 'invalid_draft' | 'first_step_writes';
    steps_passed: number;
    steps_total: number;
    dir?: string;
  };
  untrusted: {
    scenes: Array<{ id: string; steps: number; opens: boolean }>;
    issues: Array<{ severity: string; code: string; message: string; scene?: string; step?: number }>;
    first_write?: { scene: string; step: number };
    check?: { until?: string; failed_at?: { scene: string; step: number; action: string }; error?: string };
  };
}

/** A logo candidate of a site extraction, as a result shows it. */
export interface SiteCandidateResult {
  /** The reference template_create_from_brand takes: site:<site_id>/logo-<n>. */
  ref: string;
  file: string;
  source: 'header-img' | 'header-svg' | 'page-img' | 'page-svg' | 'icon' | 'og-image';
  width: number;
  height: number;
}

/**
 * What a `site` job produced (L3.5, R-MCP-12): hex colours, ratios, counts, sizes and the approved URL's host are the
 * tool's own; everything the page or its server chose (title, description, site name, alt texts, font family names,
 * the final and in-page URLs, refused hosts, errors) is only under `untrusted`. The images are pixels of a third-party
 * page. `draft` is a brand input for template_create_from_brand and the template.yaml it would make (not written).
 */
export interface SiteJobResult {
  kind: 'site';
  site_id: string;
  dir: string;
  url: string;
  host: string;
  status: 'ok' | 'failed';
  http_status: number | null;
  redirects: number;
  palette: {
    roles: { paper: string; text: string; accent: string | null; dark: string | null };
    swatches: Array<{ hex: string; background: number; text: number; interactive: number; contrast: { paper: number; text: number } }>;
  } | null;
  candidates: SiteCandidateResult[];
  screenshot: string | null;
  network: { requests: number; blocked: Record<string, number>; tunnels: number; bytes: number; refused: Record<string, number>; capped: number };
  draft: { brand_input: Record<string, unknown>; template_yaml: string; base: string } | null;
  warnings: string[];
  untrusted: Record<string, unknown>;
}

export type JobResult =
  | RunJobResult
  | HooksJobResult
  | EnvResetJobResult
  | AuthLoginJobResult
  | SandboxJobResult
  | RenderJobResult
  | ReviewJobResult
  | ExportJobResult
  | PreviewJobResult
  | InspectJobResult
  | RecordJobResult
  | SiteJobResult;

export interface JobErrorView {
  code: EngineErrorCode;
  message: string;
  fix?: string;
}

export interface JobRecord {
  version: typeof JOB_RECORD_VERSION;
  id: string;
  kind: JobKind;
  input: JobInput;
  state: JobState;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  /** The worker that claimed it. */
  worker?: JobWorkerInfo;
  progress?: JobProgress;
  result?: JobResult;
  /** Why the job could not run (or was cancelled / interrupted). */
  error?: JobErrorView;
  /** From the cancel marker: when a cancel was asked (derived when reading). */
  cancel_requested_at?: string;
  /** The state was derived when reading (the stored one is older: a worker died, or a cancel came before it started). */
  derived?: true;
}

export type JobEventBody =
  | { type: 'state'; state: JobState; message?: string }
  | { type: 'run'; event: RunProgress }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; result?: JobResult; error?: JobErrorView };

export type JobEvent = { seq: number; t: string } & JobEventBody;

export const FINISHED_JOB_STATES: ReadonlySet<JobState> = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
