/**
 * The engine façade's types: its options, the Engine interface (one member per sub-API) and the views its methods
 * return. engine.ts re-exports each of them (createEngine builds the façade from src/facade/*-api.ts).
 */
import type { ComponentKind, InspectJobInput, RecordAnnotationChange, RunMode } from '@retake/core';
import type { PersonaStateView } from '../auth.js';
import type { CreateProjectRequest, ProjectSummary, ProjectView } from '../projects.js';
import type { RunStatusView, RunSummary } from '../runs.js';
import type { SandboxStatusView } from '../sandbox.js';
import type { SaveResult, ScenarioEditRequest, ScenarioEditResult, ScenarioText, ValidateResult } from '../scenarios.js';
import type { ScriptDraftView } from '../authoring.js';
import type { WorkerLockRecord } from '../jobs/lock.js';
import type { JobFiles } from '../jobs/queue.js';
import type { JobFilter, JobQueueView } from '../jobs/job-queue.js';
import type { RunThumbsView } from '../run-thumbs.js';
import type { ProjectBoardView, RunPoster } from '../project-board.js';
import type { ScenarioActions, ScenarioView } from '../scenario-view.js';
import type { EnvResetSubmitRequest, HooksSubmitRequest } from '../jobs/hooks-job.js';
import type { AuthLoginSubmitRequest } from '../jobs/auth-job.js';
import type { LatestRunNotice, PassedOverRuns, RenderEditSource, RenderRequest } from '../jobs/render-job.js';
import type { TimelineViewRequest, TimelineViewResult } from '../timeline-view.js';
import type { ReviewRequest } from '../jobs/review-job.js';
import type { ExportRequest } from '../jobs/export-job.js';
import type { ReviewImageView, ReviewImagesMode, ReviewView } from '../reviews.js';
import type { InspectSubmitRequest } from '../jobs/inspect-job.js';
import type { RecordAnnotated, RecordDiscarded, RecordListItem, RecordSaved, RecordStopped, RecordView } from '../record-studio.js';
import type { RecordSubmitRequest } from '../jobs/record-job.js';
import type { InspectReport } from '@retake/runner-web/types';
import type { LibraryStatesView } from '../library.js';
import type { ComponentCreateRequest, ComponentCreated, ComponentListView, ComponentValidationView, ComponentView } from '../components.js';
import type { ThemeEditRequest, ThemeEditResult, ThemeEditView } from '../theme-edit.js';
import type { ThemeCopied } from '../brand/copy.js';
import type { BrandFileList } from '../brand/file-list.js';
import type { SiteList } from '../site-list.js';
import type { SiteSubmitted } from '../jobs/site-job.js';
import type { ThemeCreated } from '../brand/create.js';
import type { TemplateDetail, TemplateListView } from '../templates.js';
import type { LatestRenderNotice, PassedOverRenders } from '../render-records.js';
import type { PlanPreviewView, RenderStatusView, ScenarioRendersView } from '../renders.js';
import type { SandboxSubmitRequest } from '../jobs/sandbox-job.js';
import type { CommentAddRequest, CommentAdded, CommentAnchorRequest, CommentAnchorView, CommentApplied, CommentCountsView, CommentListRequest, CommentListView, CommentProposalView, CommentView, CommentWritten } from '../comments.js';
import type { ProposalInput } from '../comment-proposals.js';
import type { RenderFrameRequest, RenderFrameView, RenderOutlineRequest, RenderOutlineView } from '../render-frames.js';
import type { Entitlements } from '../entitlements.js';
import type { UsageCounts } from '../history.js';
import type { EngineClient } from '../caller.js';
import type { Approver } from '../approvals.js';
import type { RunBlocker, RunSubmitRequest } from '../jobs/run-job.js';
import type { WorkerSpawnFn } from '../jobs/spawn.js';
import type { PruneRequest, PruneResult } from '../prune.js';
import type { JobEvent, JobRecord, SiteJobResult } from '../jobs/types.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { EnginePorts } from '../ports.js';

export interface EngineOptions {
  /** Workspace root; default $RETAKE_ROOT, else the retake.yaml lookup from the cwd. */
  root?: string;
  /** Who drives it: recorded with what it starts (jobs) and shapes the safety defaults. */
  client: EngineClient;
  /** Start the workspace's jobs worker when a job is submitted or cancelled (default true). */
  autoStartWorker?: boolean;
  /** The idle exit of a worker this engine starts (ms; default the worker's 60 s). */
  workerIdleExitMs?: number;
  /** The environment of a worker this engine starts (default: the CLI's own; any other client's cleanWorkerEnv). */
  workerEnv?: NodeJS.ProcessEnv;
  /** Tests: starts the worker process (default node's spawn). */
  workerSpawn?: WorkerSpawnFn;
  /**
   * Tests: the ports this engine runs with instead of the product's (ports.ts enginePorts: the system's clock, the
   * disk's stores). The MCP server and the Studio pass none. A worker this engine starts runs its own.
   */
  ports?: Partial<EnginePorts>;
}

/** A run's job as run_status shows it. */
export interface RunJobView {
  id: string;
  state: JobRecord['state'];
  /** Queued: how many jobs run or wait before it, and the one running. */
  queue?: { ahead: number; running?: string; held_by?: 'take' };
  cancel_requested_at?: string;
  /** L4.4: a pause was asked (the run pauses before its next step; `paused` says when it is). */
  pause_requested_at?: string;
  error?: JobRecord['error'];
}

/** A run of a list, its status overlaid like run_status's: interrupted (its worker died), cancelled / failed before it started. */
export interface RunListItem extends Omit<RunSummary, 'status'> {
  status: RunSummary['status'] | 'interrupted';
}

/** A run's status with the state of its job (when a client submitted it) overlaid: interrupted, cancelled before it started. */
export interface RunStatusWithJob extends Omit<RunStatusView, 'status'> {
  status: RunStatusView['status'] | 'interrupted';
  job?: RunJobView;
}

/**
 * A run's status as run_status answers it by default (`detail: "compact"`, L5.8; the MCP server's compactRunStatus):
 * no per-step screenshot list, no hashes, the take's cost as one line. Shared by the MCP tool that writes it and the
 * Studio, which serves that tool and reads this answer.
 */
export interface CompactRunStatus {
  id: string;
  project: string;
  scenario: RunStatusWithJob['scenario'];
  mode: RunStatusWithJob['mode'];
  env: RunStatusWithJob['env'];
  status: RunStatusWithJob['status'];
  finished: boolean;
  steps_done: number;
  steps_total: number;
  /** The duration so far, to a tenth of a second. */
  duration_s?: number;
  current?: RunStatusWithJob['current'];
  paused?: RunStatusWithJob['paused'];
  stopped_at?: RunStatusWithJob['stopped_at'];
  /** The hook phases that ran (those `none` or absent left out). */
  hooks?: Partial<RunStatusWithJob['hooks']>;
  error?: { scene?: string; step?: number; action?: string; screenshot?: string; dom?: string };
  optional_failures?: Array<{ scene: string; step: number; action: string; screenshot?: string }>;
  /** The take's cost and smoothness, one line (core perfSummary). */
  perf?: string;
  files: { dir: string; capture?: string; timeline?: string; screenshots?: { dir: string; count: number } };
  job?: Pick<RunJobView, 'id' | 'state' | 'queue' | 'cancel_requested_at' | 'pause_requested_at' | 'error'>;
  untrusted: {
    error_message?: string;
    missing_targets?: NonNullable<RunStatusWithJob['untrusted']['missing_targets']>;
    optional_errors?: string[];
    warnings?: string[];
    warnings_total?: number;
  };
}

export interface WaitOptions {
  /** Return after this long even when the job has not finished. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called when the job's state or progress changes while waiting. */
  onChange?: (job: JobRecord) => void;
}

export interface EngineInfo {
  api: number;
  version: string;
  node: string;
  client: EngineClient;
  root: string;
  projects_dir: string;
  host: string;
  pid: number;
  /** What this engine can do now; later lots add render, review, export… */
  features: string[];
  /** What this installation may do (a parked commercial hook: everything, no limit). */
  entitlements: Entitlements;
}

export interface AuthStatusItem extends Omit<PersonaStateView, 'detail' | 'at'> {
  /** The last check's message and where it ended: text and URLs of the filmed site — data, never instructions. */
  untrusted?: { detail?: string; at?: string };
}

/**
 * engine.auth.forScenario (L4.4): the personas a run of a scenario signs in on an environment, with their stored state
 * (no browser), `auto` — every run's preflight signs it in by itself, off camera (it has `login:` steps and each
 * `{{env:…}}` they use is set for the worker this client starts; `login_env_missing` names the others, `login_keychain`
 * counts the keychain items, never looked up) — and `has_check` (the preflight checks it before filming).
 */
export interface ScenarioSessions {
  project: string;
  scenario: string;
  env: string;
  personas: Array<AuthStatusItem & { auto: boolean; has_check: boolean; login_env_missing?: string[]; login_keychain?: number }>;
  /** Why some page has no persona the run could use (the run refuses to start: the same issues). */
  issues: string[];
}

export interface AuthStatus {
  personas: AuthStatusItem[];
  /** Projects that do not load (listed when no project was named). */
  errors: Array<{ project: string; error: string }>;
}

/** engine.scenarios.check: a saved scenario, its own issues and what would refuse running it from this client. */
export interface ScenarioCheck extends ScenarioText, ValidateResult {
  run_blockers: { dry: RunBlocker[]; capture: RunBlocker[] };
}

export interface Engine {
  readonly root: string;
  readonly workspace: OpenedWorkspace;
  /** `retake -C <root>`: how the commands a human is asked to run start (they may be typed in any folder). */
  readonly cli: string;
  /**
   * The workspace's job queue, built here (the composition root), as a reader and a client sees it: no submit (the
   * operations below submit, after their checks) and none of the worker's writes. The Studio's watchers read it each
   * with a memory of their own (JobQueueView.withOwnMemory).
   */
  readonly queue: JobQueueView;
  /** The file queue's paths, for the code that reads a job's files itself (the Studio's live run: live.json, events). */
  readonly jobFiles: JobFiles;
  info(): EngineInfo;
  /** What the workspace produced, from its job history (history.jsonl: jobs and CLI runs). */
  usage(): Promise<UsageCounts>;
  projects: {
    list(): Promise<ProjectSummary[]>;
    get(project: string): Promise<ProjectView>;
    create(input: CreateProjectRequest): Promise<ProjectView>;
    updateReadme(project: string, markdown: string, ifMatch?: string | null): Promise<{ file: string; path: string; hash: string }>;
    /**
     * Delete failed takes, dry runs, older captures and renders nothing uses (L5.7, R-FLD-28; prune.ts): `dry_run`
     * (default true) only reports what would go and how much it frees. Whatever a queued or running job names is kept.
     * Under agent trust (every client but the CLI and tests), `dry_run: false` first lists what would go and asks the
     * person through `approver` (approvals.ts `takePruneApproval`: no approver → `needs_approval`, declined →
     * `refused`, nothing deleted), then deletes the items in the approval (all of them, the first ones listed) that can
     * still go at that moment, each with the paths it had when listed.
     */
    prune(project: string, req?: Pick<PruneRequest, 'keep_renders' | 'dry_run'>, o?: { approver?: Approver }): Promise<PruneResult>;
    /**
     * The Studio's Project screen in one read (L5.10a, project-board.ts): every scenario's file facts, running / last
     * take, capture (current or not), dry run, newest render and its review, render job, length and poster — one pass
     * over the runs, one renders readdir, one queue read; memos apart from `scenarios.view`'s. Path-free.
     */
    board(project: string): Promise<ProjectBoardView>;
  };
  scenarios: {
    get(project: string, name: string): Promise<ScenarioText>;
    validate(project: string, yaml: string, opts?: { env?: string; until?: string; name?: string }): Promise<ValidateResult>;
    /**
     * A saved scenario as the Studio's scenario screen reads it (L4.2): its text and hash, its own problems — validated
     * against the project WITHOUT agent trust (a person's `{{env:…}}` is valid in their file) — and, apart, what would
     * refuse a dry run and a capture submitted by this client (`run_blockers`: agent-trust problems, protected hosts,
     * hooks a rule refuses, hooks that need a person), so a screen says it before any click.
     */
    check(project: string, name: string, opts?: { env?: string }): Promise<ScenarioCheck>;
    /**
     * The Studio's scenario screen in one read (L4.2, scenario-view.ts): `check`'s file, issues and run blockers, plus
     * the blocks, the environment and scene URLs, the scenario's runs, the source run of the pictures (the one asked
     * for, else the newest complete one) and every step's binding to it; memoised by file hash and the runs' files.
     */
    view(project: string, name: string, opts?: { run?: string; env?: string }): Promise<ScenarioView>;
    /**
     * L5.11a: the Studio's status bar for one scenario (scenario-view.ts `actions`): hash, validity, run blockers on the
     * location (each with its gate's `kind`), the runs with the unfinished one's job, the capture a render edits, a
     * render queued or running. Memoised apart from `view` (it never evicts the open scenario's text layer).
     */
    actions(project: string, name: string, opts?: { env?: string }): Promise<ScenarioActions>;
    save(project: string, name: string, yaml: string, opts?: { ifMatch?: string | null }): Promise<SaveResult>;
    /**
     * One edit of a saved scenario from the Studio (L4.3, scenarios.ts editScenario): the file the view read, `hash` as
     * if_match, the file itself not blocked (view `edit`), no hidden character added, hooks and mocks unchanged (agent
     * clients), validated (errors refuse, warnings save) with agent trust worded for the client — atomic, mode kept.
     */
    edit(project: string, name: string, req: ScenarioEditRequest): Promise<ScenarioEditResult>;
    /**
     * A timecoded script table → an outline and a draft scenario (one `hold` per beat, the action as its note), validated
     * against the project (L3.3 aid; deterministic, no model call, nothing written — save with `save`).
     */
    fromScript(project: string, markdown: string, opts?: { env?: string; name?: string }): Promise<ScriptDraftView>;
  };
  runs: {
    /** run.json of each run, with the state of its job overlaid when run.json cannot say it (as `status`). */
    list(project: string, opts?: { scenario?: string; mode?: RunMode; limit?: number }): Promise<RunListItem[]>;
    /** run.json with the state of its job overlaid (a CLI run has none). */
    status(project: string, runId: string): Promise<RunStatusWithJob>;
    /**
     * Queue a dry run or a capture for the worker (it returns at once, with the reserved run id). Its hooks that need a
     * human (trust `mcp`: destructive ones whatever `confirm` says, every shell hook) are asked through `approver`;
     * without one, or when not approved, the submit is refused with the `retake` command a human runs.
     */
    submit(req: RunSubmitRequest, o?: { approver?: Approver }): Promise<{ job: JobRecord; run_id: string; warnings: string[]; worker?: { pid?: number; spawned: boolean; /** L5.16c: the live worker runs another copy of Retake (the lock's text). */ other?: { version: string; engine?: string } } }>;
    /** Cancel the job of a run (teardown and rollbacks still run). A run started from the CLI is refused. */
    cancel(project: string, runId: string): Promise<JobRecord>;
    /**
     * Pause (`paused: true`) or resume a running run of a job (L4.4): the job's `pause` marker; the run pauses before its
     * next step (at most RETAKE_PAUSE_MAX_MIN, default 30 min, then it stops) — a capture does not film the pause.
     * Refused: a run started from the CLI; a queued, stopping or finished run (conflict). Resuming always removes the marker.
     */
    pause(project: string, runId: string, paused: boolean): Promise<RunStatusWithJob>;
    /**
     * JPEG thumbnails (base64, ≤ 480 px) of up to 24 steps of a run, by the run's own step keys (L4.2, run-thumbs.ts):
     * dry-run screenshots, error screenshots, the frame on screen at a capture step's end. Made in memory, never stored.
     */
    thumbs(project: string, runId: string, keys: readonly string[], opts?: { signal?: AbortSignal }): Promise<RunThumbsView>;
    /** A run's poster (L5.10a): its timeline's last step with a picture (run_thumbs takes `key`) and its scenes' length. */
    poster(project: string, runId: string): Promise<RunPoster>;
  };
  jobs: {
    get(id: string): Promise<JobRecord>;
    list(filter?: JobFilter): Promise<JobRecord[]>;
    events(id: string, opts?: { after?: number; limit?: number }): Promise<JobEvent[]>;
    cancel(id: string): Promise<JobRecord>;
    /** Wait until the job finishes or `timeoutMs` passes; returns it as it is then. */
    wait(id: string, opts: WaitOptions): Promise<JobRecord>;
    /** Where a queued job stands: jobs ahead of it in its lane, the one running, `held_by: 'take'` (a heavy job a take holds). */
    position(id: string): Promise<{ ahead: number; running?: string; held_by?: 'take' } | undefined>;
    /** The worker serving the workspace, when one runs. */
    worker(): Promise<WorkerLockRecord | null>;
  };
  hooks: {
    /** Queue hooks outside a capture (dry by default: nothing runs, nobody is asked; a real run takes approvals first). */
    submit(req: HooksSubmitRequest, o?: { approver?: Approver }): Promise<{ job: JobRecord; journal_id: string; worker?: { pid?: number; spawned: boolean } }>;
  };
  env: {
    /** Queue an environment reset: pending rollbacks, then the project's reset hooks (dry by default). */
    reset(req: EnvResetSubmitRequest, o?: { approver?: Approver }): Promise<{ job: JobRecord; journal_id: string; worker?: { pid?: number; spawned: boolean } }>;
  };
  auth: {
    /** What is known of each persona's session, without opening a browser (no live check through the engine yet). */
    status(opts?: { project?: string; env?: string }): Promise<AuthStatus>;
    /**
     * Queue a sign-in: `headed` (default) opens a window on this machine for a human to sign in and close; `auto` plays
     * the persona's login steps. Never takes a credential.
     */
    login(req: AuthLoginSubmitRequest): Promise<{ job: JobRecord; persona: string; env: string; worker?: { pid?: number; spawned: boolean } }>;
    /** Stop a sign-in job (its window closes; signInStoppedText says what stays): an `auth_login` job only, anything else refused (L4.4). */
    cancelSignIn(jobId: string): Promise<JobRecord>;
    /**
     * The personas a run of a saved scenario signs in (L4.4: the Run screen's preflight), with their stored state; `mode`
     * capture (default) counts the hooks' tabs too.
     */
    forScenario(project: string, scenario: string, opts?: { env?: string; mode?: RunMode }): Promise<ScenarioSessions>;
  };
  renders: {
    /** Plan a render in this process (trust `mcp` gates; no browser): segments, timings, warnings. */
    plan(req: RenderRequest): Promise<PlanPreviewView>;
    /**
     * Queue a render (trust `mcp`: planned and checked first; the worker renders with the network guard). Returns at
     * once with the reserved render id; `edit`, `scenario_changed`, `filmed_changes`, `edit_changes` as plan_preview's;
     * `passed_over`, `until` and `untrusted.passed_over` when the run was picked as the latest capture (as plan_preview's).
     */
    submit(
      req: RenderRequest,
    ): Promise<{ job: JobRecord; render_id: string; run_id: string; variant: string; duration_s: number; warnings: string[]; worker?: { pid?: number; spawned: boolean; /** L5.16c: the live worker runs another copy of Retake (the lock's text). */ other?: { version: string; engine?: string } }; untrusted?: { passed_over: PassedOverRuns } } & RenderEditSource & LatestRunNotice>;
    /** A render's status: its newest job first, then renders/<id>.json. `latest` (of `scenario`) names the newest. */
    status(project: string, renderId: string, o?: { scenario?: string }): Promise<RenderStatusView>;
    /**
     * A scenario's render jobs (queued / running, with progress and queue position) and renders (newest first, each with
     * its review's verdict) — path-free (L4.5 part E: the Studio's render queue).
     */
    ofScenario(project: string, scenario: string): Promise<ScenarioRendersView>;
    /**
     * One output frame of a succeeded render as a JPEG (≤ 1280 px, base64; L4.6 render-frames.ts): the video's own fps
     * and frames checked against the record, its file opened safely; memory only. `session` (the Studio session):
     * the same session's earlier request on that render is dropped (newest wins); past 4 requests at once, `busy`.
     */
    frame(project: string, req: RenderFrameRequest, o?: { session?: string; signal?: AbortSignal }): Promise<RenderFrameView>;
    /** A render's frames, fps, size, markers and the threads made on it as it is now (the comment viewer's slider). */
    outline(project: string, req: RenderOutlineRequest): Promise<RenderOutlineView>;
  };
  timeline: {
    /**
     * The Studio timeline's view of a scenario's take (L4.5, timeline-view.ts): tracks, pins, the inspector's choices
     * (usable or disabled with why), the capture's codec and keyframes — path-free, text under `untrusted` — and, beside
     * it for the in-process caller only, the plan. Memoised per file / run / components (one planning per change).
     */
    view(req: TimelineViewRequest): Promise<TimelineViewResult>;
  };
  reviews: {
    /**
     * Queue a review of a render (its video and run must lie in the project; `latest` is resolved now — the answer then
     * says how many newer files of renders/ it passed over, their names under `untrusted`).
     */
    submit(req: ReviewRequest): Promise<{ job: JobRecord; render_id: string; worker?: { pid?: number; spawned: boolean }; untrusted?: { renders_passed_over: PassedOverRenders } } & LatestRenderNotice>;
    /** A render's review: its newest job, then review/<id>/report.json (paths rebuilt from the folder, messages untrusted). */
    get(project: string, renderId: string, o?: { scenario?: string; images?: ReviewImagesMode }): Promise<ReviewView>;
    /**
     * One contact sheet of a render's review as a base64 JPEG (L4.5 part E): named by its file name in review/<id>/, read
     * without following a link, JPEG only, scaled and capped.
     */
    image(project: string, renderId: string, image: string): Promise<ReviewImageView>;
  };
  exports: {
    /**
     * Queue an export of a render to delivery formats (exports/<id>/; re-rendered formats are planned and checked first).
     * With `latest`: the answer says how many newer files of renders/ it passed over, their names under `untrusted`.
     */
    submit(req: ExportRequest): Promise<{ job: JobRecord; render_id: string; formats: string[]; rerendered: string[]; worker?: { pid?: number; spawned: boolean }; untrusted?: { renders_passed_over: PassedOverRenders } } & LatestRenderNotice>;
  };
  templates: {
    /** Workspace and starter themes with their component per kind (with `project`: which one is its own). */
    list(o?: { project?: string }): Promise<TemplateListView>;
    /** One theme in detail: template.yaml, colours, fonts, assets, components with params. */
    get(o: { template?: string; project?: string }): Promise<TemplateDetail>;
    /** Queue stills of a theme (intro, layout + caption, card, interstitial, outro) into .retake/previews/. */
    preview(req: { project: string; template?: string }): Promise<PreviewSubmitted>;
    /**
     * A new workspace theme from brand inputs (L3.5; core BrandInputSchema), under trust `mcp`: brand files are
     * workspace files outside agent-writable, hidden and components folders; never an existing theme, except `replace`
     * of one this tool made that nobody changed. `retake theme create` calls createThemeFromBrand with trust `author`.
     */
    create(input: unknown): Promise<ThemeCreated>;
    /**
     * Queue a site extraction (L3.5, R-MCP-12) after asking the human (through `approver`) to approve the exact URL:
     * colours, font names, logo PNGs and a screenshot into .retake/site/<id>/, and a draft brand input. Refused
     * for an environment page or a protected host; needs_approval when the client cannot ask anyone.
     */
    fromSite(req: { url: string }, o?: { approver?: Approver }): Promise<SiteSubmitted & { worker?: { pid?: number; spawned: boolean } }>;
    /** A site extraction read back (site.json as a file of the workspace) with its draft; null view before it is written. */
    site(siteId: string, url: string): Promise<{ dir: string; view: SiteJobResult | null }>;
    /**
     * L4.7: one theme as the Studio's editor shows it — editable or read-only with why (by real path), template.yaml's
     * text and sha256, the allow-listed fields, components, its font and image files checked, palette checks, used by.
     */
    view(name: string): Promise<ThemeEditView>;
    /**
     * L4.7: one verified write of a theme's template.yaml (core applyThemeEdit, if_match, re-parse, files served from
     * its folder only, the registry, the write lock; `restore` of a version shown or written). Refused for MCP.
     */
    edit(name: string, req: ThemeEditRequest): Promise<ThemeEditResult>;
    /** L4.7: a new workspace theme copied from a listed one ("Copy to edit"; refused inside the Retake package). */
    copy(req: { from: string; name: string }): Promise<ThemeCopied>;
    /** L4.7: the workspace's image or font files a new theme may take (names and sizes; brand source rules). */
    files(kind: 'image' | 'font'): Promise<BrandFileList>;
    /** L4.7: the newest site extractions (hex colours and candidates; URL, host and page text under untrusted). */
    sites(): Promise<SiteList>;
  };
  components: {
    list(kind?: string): Promise<ComponentListView>;
    get(id: string): Promise<ComponentView>;
    /** Manifest, entry and compile check (nothing executed). */
    validate(id: string): Promise<ComponentValidationView>;
    /** Scaffold a workspace component (refuses the built-in namespace and built-in ids; no preview rendered). */
    create(req: ComponentCreateRequest): Promise<ComponentCreated>;
    /** Queue a still of a component with a theme, slot values and params into .retake/previews/ (never its folder). */
    preview(req: { project: string; template?: string; component: string; slots?: Record<string, string>; params?: Record<string, unknown>; at_s?: number }): Promise<PreviewSubmitted>;
    /**
     * L4.7, the Studio library: the poster and loop keys of `components` (default: the whole registry) in a theme (a
     * name; default the project's) and what the preview cache holds for each — `committed` for a fresh built-in poster
     * in the editorial starter. Failure reasons under `untrusted`.
     */
    library(req: { project: string; template?: string; components?: string[] }): Promise<LibraryStatesView>;
    /**
     * L4.7: queue posters and / or loops of at most 12 components into the preview cache, each with the key the caller
     * expects (`library` gave them). Refused under 1 GB free.
     */
    libraryRender(req: { project: string; template?: string; items: Array<{ component: string; poster?: string; loop?: string }>; retry?: boolean }): Promise<PreviewSubmitted>;
  };
  inspect: {
    /**
     * Queue an inspection (L3.3): a dry replay of a page (page key + path, or a URL of the environment's own origins) or
     * of a saved scenario up to a step, then the page inventoried into <project>/.retake/inspect/<id>/ — run_dry's
     * trust rules (agent trust, protected hosts, production read-only, no hook, no template).
     */
    submit(req: InspectSubmitRequest): Promise<InspectSubmitted>;
    /** An inspection's report read back (null before it is written); its marked screenshot when drawn. */
    get(project: string, inspectId: string): Promise<{ dir: string; report: InspectReport | null; marked: string | null }>;
  };
  record: {
    /**
     * Queue a recording (L3.4): a headed window opens on this machine for a HUMAN to perform a flow and close it (nobody
     * drives it through the job); a draft scenario is made from it, saved when its name is free, and checked by a
     * headless dry replay. The environment's own access, never --allow-writes; no hook; the workspace's protected hosts.
     */
    submit(req: RecordSubmitRequest): Promise<RecordSubmitted>;
    /** A recording's draft.yaml read back (null when there is none); its text is page and typed text: untrusted. */
    get(project: string, recId: string): Promise<{ dir: string; draft: string | null; truncated: boolean }>;
    /**
     * The Record screen (L4.8, record-studio.ts; clients `ui` and `test` only): a recording's state and live draft —
     * counts and enums, page text under `untrusted`, no path. `job`: the job record_start returned (before the folder
     * exists); `since`: the previous answer's `version` (unchanged: a short answer).
     */
    view(project: string, recId: string, o?: { job?: string; since?: string }): Promise<RecordView>;
    /** One change to a Studio recording's annotations (choose / insert / remove) at the revision the view returned. */
    annotate(project: string, recId: string, req: { rev: number; change: RecordAnnotationChange }): Promise<RecordAnnotated>;
    /**
     * Save a finished Studio recording as a NEW scenarios/<name>.yaml (agent trust, `via: 'studio'`) — only the draft the
     * person saw: `draft` is the view's `draft_sha256` (another draft is a conflict).
     */
    save(project: string, recId: string, req: { name: string; rev: number; draft: string }): Promise<RecordSaved>;
    /** Discard a Studio recording (its folder; an open window is cancelled). The saved scenario is never touched. */
    discard(project: string, recId: string, o?: { job?: string }): Promise<RecordDiscarded>;
    /** Stop and keep: queued = cancel; before the window opened = a clean cancel (the stop marker); while recording = the stop marker (the check runs). */
    stop(project: string, recId: string, o?: { job?: string }): Promise<RecordStopped>;
    /** The project's recordings, newest first (the Record screen's recent list; no page text, no path). */
    list(project: string, o?: { limit?: number }): Promise<RecordListItem[]>;
  };
  /** A JPEG thumbnail (base64) of an image of the workspace, made on read: never stored. */
  thumbnail(file: string, maxPx?: number): Promise<{ base64: string; width: number; height: number; bytes: number }>;
  /**
   * Frame comments (L3.6, L4.6): threads on frames of renders. Entries are written as the channel `cli` for client
   * `cli`, `studio` for client `ui` (the Studio web app; its name the Studio process's $RETAKE_AUTHOR, else the OS
   * user — never a name from the page), `mcp` for any other client (`test` included: fail-safe). Only the person
   * channels (`cli`, `ui`) create and reopen threads and apply proposals. Every client but `cli` needs `if_match` to
   * resolve, to reopen and to apply; `ui` names the render it showed (`render_created_at`) to create. Proposals (L4.6)
   * come from the MCP only (`reply` with `proposal`: client `mcp`, and `test`).
   */
  comments: {
    list(project: string, req?: CommentListRequest): Promise<CommentListView>;
    get(project: string, id: string): Promise<CommentView>;
    add(project: string, req: CommentAddRequest): Promise<CommentAdded>;
    /**
     * A reply; with `proposal` (MCP only, critique B10): Claude's whole new text of the thread's scenario file and the
     * hash it read, checked as the Studio would check it at Apply and stored as the canonical line diff (open threads).
     */
    reply(project: string, id: string, text: string, o?: { proposal?: ProposalInput }): Promise<CommentWritten>;
    resolve(project: string, id: string, req: { note: string; render_id?: string; if_match?: string }): Promise<CommentWritten>;
    reopen(project: string, id: string, note?: string, o?: { if_match?: string }): Promise<CommentWritten>;
    /** The anchor a comment on that frame would store (the same code as `add`) and where its step is today: nothing written. */
    anchorAt(project: string, req: CommentAnchorRequest): Promise<CommentAnchorView>;
    /**
     * Apply a thread's newest pending proposal (person channels; `if_match` but for `cli`): under the thread's lock, the
     * text rebuilt and checked, written by the Studio's own write path (every L4.3 rule), then the apply entry appended.
     */
    apply(project: string, id: string, req: { entry_id: string; if_match?: string }): Promise<CommentApplied>;
    /** A proposal's state and the diff a person reads, computed from the file (rows with context; lines under untrusted). */
    proposal(project: string, id: string, entryId?: string): Promise<CommentProposalView>;
    /** Open and resolved threads per scenario, from the thread files alone (memoised per file; no view, no render record). */
    counts(project: string, o?: { scenario?: string }): Promise<CommentCountsView>;
  };
  sandbox: {
    status(project: string, env?: string): Promise<SandboxStatusView>;
    /** Queue a sandbox up (start, health, seed when needed); its shell seed steps are approved first, as hooks are. */
    up(req: SandboxSubmitRequest, o?: { approver?: Approver }): Promise<{ job: JobRecord; env: string; worker?: { pid?: number; spawned: boolean } }>;
    /** Queue a sandbox reset (back to the seed; the sandbox must be up). */
    reset(req: SandboxSubmitRequest, o?: { approver?: Approver }): Promise<{ job: JobRecord; env: string; worker?: { pid?: number; spawned: boolean } }>;
  };
}

/** A queued preview job. */
export interface PreviewSubmitted {
  job: JobRecord;
  preview_id: string;
  theme: string;
  /** Components it renders, in order. */
  targets: string[];
  /** Theme kinds with nothing to show. */
  skipped: ComponentKind[];
  worker?: { pid?: number; spawned: boolean };
}

/** A queued inspect job. */
export interface InspectSubmitted {
  job: JobRecord;
  inspect_id: string;
  dir: string;
  env: string;
  source: InspectJobInput['source'];
  warnings: string[];
  worker?: { pid?: number; spawned: boolean };
}

/** A queued record job. */
export interface RecordSubmitted {
  job: JobRecord;
  rec_id: string;
  env: string;
  page: string;
  path: string;
  persona: string | null;
  warnings: string[];
  worker?: { pid?: number; spawned: boolean };
}
