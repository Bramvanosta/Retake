/**
 * The engine facade (L3.1 part A, read side): one typed, in-process API over a workspace for clients other than the
 * CLI's own commands — the MCP server now, the jobs worker and the local HTTP API later. Inputs are slugs and ids, never
 * paths; results carry project refs + local paths; text the filmed site controls is kept under `untrusted`.
 * Nothing here opens a browser or starts a capture: long tasks (runs, hooks, resets, sign-ins, sandboxes) become jobs the
 * workspace's worker runs in a process of its own.
 */
import { hostname } from 'node:os';
import { RETAKE_VERSION, listProjects, loginCommand as coreLoginCommand, parseScenario, workspaceFolders } from '@retake/core';
import type { CommentAuthor, RunMode, WorkspaceConfig } from '@retake/core';
import { personaStateView, projectPersonaStates, scenarioPersonaStates } from './auth.js';
import type { PersonaState, PersonaStateView } from './auth.js';
import { EngineError, toEngineError } from './errors.js';
import {
  createProjectFromRequest,
  listProjectSummaries,
  openProjectBySlug,
  projectView,
  updateProjectReadme,
} from './projects.js';
import type { CreateProjectRequest, ProjectSummary, ProjectView } from './projects.js';
import { listRuns, runStatus } from './runs.js';
import type { RunStatusView, RunSummary } from './runs.js';
import { sandboxStatus } from './sandbox.js';
import type { SandboxStatusView } from './sandbox.js';
import { editScenario, getScenario, saveScenarioText, validateScenarioText } from './scenarios.js';
import type { SaveResult, ScenarioEditRequest, ScenarioEditResult, ScenarioText, ValidateResult } from './scenarios.js';
import { draftFromScript } from './authoring.js';
import type { ScriptDraftView } from './authoring.js';
import { openWorkspace } from './workspace.js';
import { liveWorker } from './jobs/lock.js';
import type { WorkerLockRecord } from './jobs/lock.js';
import { FileJobQueue } from './jobs/queue.js';
import type { JobFilter } from './jobs/queue.js';
import { runBlockers, submitRunJob } from './jobs/run-job.js';
import { RunDataCache } from './run-data.js';
import { RunThumbs } from './run-thumbs.js';
import type { RunThumbsView } from './run-thumbs.js';
import { ScenarioViews } from './scenario-view.js';
import { ProjectBoards } from './project-board.js';
import { checkRunId } from './refs.js';
import type { ProjectBoardView, RunPoster } from './project-board.js';
import type { ScenarioActions, ScenarioView } from './scenario-view.js';
import { submitEnvResetJob, submitHooksJob } from './jobs/hooks-job.js';
import type { EnvResetSubmitRequest, HooksSubmitRequest } from './jobs/hooks-job.js';
import { cancelSignIn, submitAuthLoginJob } from './jobs/auth-job.js';
import type { AuthLoginSubmitRequest } from './jobs/auth-job.js';
import { submitSandboxJob } from './jobs/sandbox-job.js';
import { submitRenderJob } from './jobs/render-job.js';
import type { RenderEditSource, RenderRequest } from './jobs/render-job.js';
import { planPreview, renderStatus, scenarioRenders } from './renders.js';
import { memoRegistry, timelineView } from './timeline-view.js';
import type { TimelineViewRequest, TimelineViewResult } from './timeline-view.js';
import { submitReviewJob } from './jobs/review-job.js';
import type { ReviewRequest } from './jobs/review-job.js';
import { submitExportJob } from './jobs/export-job.js';
import type { ExportRequest } from './jobs/export-job.js';
import { reviewGet, reviewImage, thumbnail } from './reviews.js';
import { libraryStatesOf, submitPreviewJob } from './jobs/preview-job.js';
import { readInspection, submitInspectJob } from './jobs/inspect-job.js';
import type { InspectSubmitRequest } from './jobs/inspect-job.js';
import { readRecording, submitRecordJob } from './jobs/record-job.js';
import { checkAgentCancel, recordAnnotate, recordDiscard, recordList, recordSave, recordStop, recordView } from './record-studio.js';
import type { RecordAnnotated, RecordDiscarded, RecordListItem, RecordSaved, RecordStopped, RecordView } from './record-studio.js';
import type { RecordAnnotationChange } from '@retake/core';
import type { RecordSubmitRequest } from './jobs/record-job.js';
import type { InspectJobInput } from '@retake/core';
import type { InspectReport } from '@retake/runner-web';
import type { PreviewRequest } from './jobs/preview-job.js';
import type { LibraryStatesView } from './library.js';
import { componentCreate, componentGet, componentList, componentValidate } from './components.js';
import type { ComponentCreateRequest, ComponentCreated, ComponentListView, ComponentValidationView, ComponentView } from './components.js';
import { templateGet, templateList } from './templates.js';
import { editTemplate, templateView } from './theme-edit.js';
import type { ThemeEditRequest, ThemeEditResult, ThemeEditView } from './theme-edit.js';
import { copyTheme } from './brand/copy.js';
import type { ThemeCopied } from './brand/copy.js';
import { brandFileList } from './brand/file-list.js';
import type { BrandFileList } from './brand/file-list.js';
import { siteList } from './site-list.js';
import type { SiteList } from './site-list.js';
import { createThemeFromBrand } from './brand/create.js';
import { readSite, submitSiteJob } from './jobs/site-job.js';
import type { SiteSubmitted } from './jobs/site-job.js';
import type { ThemeCreated } from './brand/create.js';
import type { TemplateDetail, TemplateListView } from './templates.js';
import type { ComponentKind } from '@retake/core';
import type { ReviewImageView, ReviewImagesMode, ReviewView } from './reviews.js';
import type { PlanPreviewView, RenderStatusView, ScenarioRendersView } from './renders.js';
import type { SandboxSubmitRequest } from './jobs/sandbox-job.js';
import { CommentIndex, MCP_AUTHOR_NAME, addComment, anchorAt, applyProposal, defaultAuthorName, getComment, getProposal, listComments, reopenComment, replyComment, resolveComment } from './comments.js';
import type { CommentAddRequest, CommentAdded, CommentAnchorRequest, CommentAnchorView, CommentApplied, CommentCountsView, CommentListRequest, CommentListView, CommentProposalView, CommentView, CommentWritten } from './comments.js';
import type { ProposalInput } from './comment-proposals.js';
import { RenderFrames } from './render-frames.js';
import type { RenderFrameRequest, RenderFrameView, RenderOutlineRequest, RenderOutlineView } from './render-frames.js';
import { entitlements } from './entitlements.js';
import type { Entitlements } from './entitlements.js';
import { usageCounts } from './history.js';
import type { UsageCounts } from './history.js';
import { agentChannel, pruneApprovalRequest, takePruneApproval } from './approvals.js';
import type { Approver } from './approvals.js';
import type { RunBlocker, RunSubmitRequest } from './jobs/run-job.js';
import { ensureWorker, otherCopyWarning } from './jobs/spawn.js';
import { cleanWorkerEnv } from './jobs/worker-env.js';
import type { WorkerSpawnFn } from './jobs/spawn.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import { DEFAULT_KEEP_RENDERS, pruneKey, pruneProject } from './prune.js';
import type { PruneRequest, PruneResult } from './prune.js';
import type { JobEvent, JobRecord, SiteJobResult } from './jobs/types.js';

export const ENGINE_API_VERSION = 1;

/**
 * Who drives the engine. `ui` (L4.1) is the Studio web app: the server cannot tell a person's click from script running
 * in the page, so the ops L4.1 allows it run under the agent's trust, with no approver (a person proving presence in
 * the UI — approvals, edits with secret refs — stays open: BL-106). Comments (L4.6) are a channel, not presence: `ui`
 * writes as `studio` and, like the CLI, creates and reopens threads — on the thread and render versions it showed.
 */
export type EngineClient = 'cli' | 'mcp' | 'test' | 'ui';

/** Agent trust (core agent-trust) for every client but the CLI (a person at a terminal) and tests: fail-safe. */
export function agentTrust(client: EngineClient): boolean {
  return client !== 'cli' && client !== 'test';
}

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
  readonly workspace: WorkspaceConfig;
  /** `retake -C <root>`: how the commands a human is asked to run start (they may be typed in any folder). */
  readonly cli: string;
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
     * once with the reserved render id; `edit`, `scenario_changed`, `filmed_changes`, `edit_changes` as plan_preview's.
     */
    submit(
      req: RenderRequest,
    ): Promise<{ job: JobRecord; render_id: string; run_id: string; variant: string; duration_s: number; warnings: string[]; worker?: { pid?: number; spawned: boolean; /** L5.16c: the live worker runs another copy of Retake (the lock's text). */ other?: { version: string; engine?: string } } } & RenderEditSource>;
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
    /** Queue a review of a render (its video and run must lie in the project; `latest` is resolved now). */
    submit(req: ReviewRequest): Promise<{ job: JobRecord; render_id: string; worker?: { pid?: number; spawned: boolean } }>;
    /** A render's review: its newest job, then review/<id>/report.json (paths rebuilt from the folder, messages untrusted). */
    get(project: string, renderId: string, o?: { scenario?: string; images?: ReviewImagesMode }): Promise<ReviewView>;
    /**
     * One contact sheet of a render's review as a base64 JPEG (L4.5 part E): named by its file name in review/<id>/, read
     * without following a link, JPEG only, scaled and capped.
     */
    image(project: string, renderId: string, image: string): Promise<ReviewImageView>;
  };
  exports: {
    /** Queue an export of a render to delivery formats (exports/<id>/; re-rendered formats are planned and checked first). */
    submit(req: ExportRequest): Promise<{ job: JobRecord; render_id: string; formats: string[]; rerendered: string[]; worker?: { pid?: number; spawned: boolean } }>;
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

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function createEngine(opts: EngineOptions): Promise<Engine> {
  // Every client but the CLI serves trust mcp in this process (the MCP server, the Studio server; tests: fail-safe).
  const ws = await openWorkspace({ root: opts.root, agent: opts.client !== 'cli' });
  const project = (slug: string) => openProjectBySlug(ws, slug);
  /** The commands a human runs name this workspace explicitly (they may be typed in any folder). */
  const studio = `retake -C ${shellQuote(ws.root)}`;
  const loginCommand = (p: { project: string; env: string; persona?: string }) => coreLoginCommand(p).replace(/^retake /, `${studio} `);

  const queue = new FileJobQueue(ws.root, studio);
  // Who an entry is written by: the channel, never a person; anything but the CLI and the Studio counts as the MCP
  // (fail-safe). The name of a person channel is this process's (the page never names an author).
  const commentAuthor = (): CommentAuthor =>
    opts.client === 'cli' ? { via: 'cli', name: defaultAuthorName() } : opts.client === 'ui' ? { via: 'studio', name: defaultAuthorName() } : { via: 'mcp', name: MCP_AUTHOR_NAME };
  // What only a person channel does (a terminal, the Studio): create and reopen threads.
  const personChannel = (what: string, where = `retake comment ${what.split(' ')[0]} in a terminal, or the Studio`) => {
    if (opts.client !== 'cli' && opts.client !== 'ui') {
      throw new EngineError('refused', `${what} is for a person (${where}): an agent replies to and resolves comments`);
    }
  };
  // Every client but the CLI acts on the version of a thread it read.
  const needIfMatch = (ifMatch: string | undefined | null, what: string) => {
    if (opts.client !== 'cli' && (ifMatch === undefined || ifMatch === null)) {
      throw new EngineError('invalid', `if_match is required to ${what} a comment: the hash comments_list returned for the thread`, { details: { argument: 'if_match' } });
    }
  };
  const commentIndex = new CommentIndex();
  const submitCtx = { ws, queue, cli: studio, client: opts.client };
  // L4.8: the Record screen's operations are the Studio's (and tests'): an agent starts a recording, never arranges one.
  const recordCtx = { queue, client: opts.client };
  let recordChain: Promise<unknown> = Promise.resolve();
  const studioOnly = (what: string) => {
    if (opts.client !== 'ui' && opts.client !== 'test') throw new EngineError('refused', `${what} is the Studio's (its Record screen): ${opts.client === 'mcp' ? 'scenario_record starts a recording and job_status reads its draft' : 'retake record records in a terminal'}`);
  };
  // The scenario screen's reads (L4.2): runs read once and held in memory, shared by the view and the thumbnails.
  const runData = new RunDataCache();
  const runThumbs = new RunThumbs({}, runData);
  // The comment viewer's frames wait for the same ffmpeg slots as the run thumbnails (critique B7).
  const renderFrames = new RenderFrames({ slots: runThumbs.ffmpegSlots, comments: commentIndex });
  const startWorker = async () =>
    opts.autoStartWorker === false
      ? undefined
      : ensureWorker(ws.root, {
          ...(opts.workerIdleExitMs !== undefined ? { idleExitMs: opts.workerIdleExitMs } : {}),
          // Any client but the CLI hands its worker a clean environment (review A #3: a worker an MCP client starts
          // serves the Studio's later jobs too); the Studio passes its own (the same cleaner).
          ...(opts.workerEnv ? { env: opts.workerEnv } : opts.client !== 'cli' ? { env: cleanWorkerEnv(process.env, ws.root, { folders: workspaceFolders(ws) }) } : {}),
          ...(opts.workerSpawn ? { spawn: opts.workerSpawn } : {}),
          startedBy: opts.client,
        });
  const getJob = async (id: string): Promise<JobRecord> => {
    const job = await queue.get(id);
    if (!job) throw new EngineError('not_found', `job ${id} not found (job_list names the jobs)`);
    return job;
  };
  const wait = async (id: string, w: WaitOptions): Promise<JobRecord> => {
    const deadline = Date.now() + Math.max(0, w.timeoutMs);
    let job = await getJob(id);
    let last = JSON.stringify([job.state, job.progress?.steps_done, job.progress?.current, job.progress?.phase, job.progress?.paused]);
    while (!FINISHED_JOB_STATES.has(job.state) && Date.now() < deadline && !w.signal?.aborted) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(300, Math.max(0, deadline - Date.now())));
        w.signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
      job = await getJob(id);
      const now = JSON.stringify([job.state, job.progress?.steps_done, job.progress?.current, job.progress?.phase, job.progress?.paused]);
      if (now !== last) {
        last = now;
        w.onChange?.(job);
      }
    }
    return job;
  };
  /** What run.json cannot say: its worker died (interrupted), or the job ended before the run started. */
  const overlaid = (status: RunStatusWithJob['status'], job: JobRecord): 'interrupted' | 'cancelled' | 'failed' | undefined =>
    job.state === 'interrupted' || ((job.state === 'cancelled' || job.state === 'failed') && status === 'queued') ? job.state : undefined;
  const views = new ScenarioViews({
    ws,
    project,
    agent: agentTrust(opts.client),
    via: agentChannel(opts.client),
    blockers: (req) => runBlockers(submitCtx, req),
    overlay: async (slug, run) => {
      const job = await queue.ofRun(slug, run.id);
      return (job ? overlaid(run.status, job) : undefined) ?? run.status;
    },
    runJob: async (slug, run) => (await queue.ofRun(slug, run))?.id ?? null,
    renderJob: async (slug, name) => {
      const open = (await queue.list({ project: slug, kinds: ['render'], states: ['queued', 'running'] })).find((j) => j.input.kind === 'render' && j.input.scenario === name);
      if (!open) return undefined;
      return { job: open.id, state: open.state === 'running' ? 'running' : 'queued', ...(open.progress?.fraction !== undefined ? { fraction: open.progress.fraction } : {}) };
    },
    runs: runData,
  });
  // L5.10a: the Project screen's board, its memos apart from the views' (critique H1: never evict the open scenario's).
  const boards = new ProjectBoards({
    ws,
    queue,
    project,
    overlay: async (slug, run) => {
      const job = await queue.ofRun(slug, run.id);
      return (job ? overlaid(run.status, job) : undefined) ?? run.status;
    },
  });
  const runStatusWithJob = async (slug: string, runId: string): Promise<RunStatusWithJob> => {
    const view: RunStatusWithJob = await runStatus(await project(slug), runId);
    const job = await queue.ofRun(slug, runId);
    if (!job) return view;
    const position = job.state === 'queued' ? await queue.position(job.id) : undefined;
    view.job = {
      id: job.id,
      state: job.state,
      ...(position ? { queue: position } : {}),
      ...(job.cancel_requested_at ? { cancel_requested_at: job.cancel_requested_at } : {}),
      ...(job.pause_requested_at ? { pause_requested_at: job.pause_requested_at } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
    const status = view.finished ? undefined : overlaid(view.status, job);
    if (status) {
      view.status = status;
      view.finished = true;
    }
    return view;
  };

  return {
    root: ws.root,
    workspace: ws,
    cli: studio,
    info: () => ({
      api: ENGINE_API_VERSION,
      version: RETAKE_VERSION,
      node: process.versions.node,
      client: opts.client,
      root: ws.root,
      projects_dir: ws.projectsDir,
      host: hostname(),
      pid: process.pid,
      features: [
        'projects',
        'projects.board',
        'scenarios',
        'scenarios.from_script',
        'scenarios.view',
        'scenarios.edit',
        'runs.read',
        'runs.thumbs',
        'runs.dry',
        'runs.capture',
        'runs.pause',
        'runs.live',
        'jobs',
        'hooks',
        'env.reset',
        'approvals',
        'auth.status',
        'auth.login',
        'auth.for_scenario',
        'auth.cancel_sign_in',
        'sandbox.status',
        'sandbox.up',
        'sandbox.reset',
        'renders',
        'renders.plan',
        'renders.of_scenario',
        'renders.frame',
        'renders.outline',
        'timeline.view',
        'reviews',
        'reviews.image',
        'exports',
        'templates.read',
        'templates.preview',
        'templates.create',
        'templates.from_site',
        'templates.edit',
        'components.read',
        'components.create',
        'components.preview',
        'components.library',
        'inspect',
        'record',
        'record.studio',
        'comments',
        'comments.studio',
        'comments.anchor',
        'comments.counts',
        'comments.proposals',
        'comments.apply',
        'history',
      ],
      entitlements: entitlements(),
    }),
    usage: () => usageCounts(ws.root),
    projects: {
      list: () => listProjectSummaries(ws),
      get: async (slug) => projectView(await project(slug)),
      create: async (input) => projectView(await createProjectFromRequest(ws, input)),
      updateReadme: async (slug, markdown, ifMatch) => updateProjectReadme(await project(slug), markdown, ifMatch),
      prune: async (slug, req = {}, o = {}) => {
        const p = await project(slug);
        // What a queued or running job names (its run, its render) stays: read again right before each pass.
        const busy = async (): Promise<(id: string) => boolean> => {
          const active = await queue.list({ states: ['queued', 'running'] });
          const named = active.map((j) => JSON.stringify(j.input)).join('\n');
          return (id) => named.includes(`"${id}"`);
        };
        const base = { ...(req.keep_renders !== undefined ? { keep_renders: req.keep_renders } : {}) };
        if (req.dry_run !== false || !agentTrust(opts.client)) return pruneProject(p, { ...base, dry_run: req.dry_run !== false, busy: await busy() });
        // An agent's deletion: the person is asked about what would go; the items in the approval that can still go then
        // go, each with the files it had when listed.
        const listed = await pruneProject(p, { ...base, dry_run: true, busy: await busy() });
        if (!listed.items.length) return { ...listed, dry_run: false, skipped: [], not_asked: 0 };
        const keep = listed.keep_renders !== DEFAULT_KEEP_RENDERS ? ` --keep-renders ${listed.keep_renders}` : '';
        await takePruneApproval(pruneApprovalRequest(listed, `${studio} prune ${p.slug}${keep} --yes`), o.approver, opts.client);
        return pruneProject(p, { ...base, dry_run: false, busy: await busy(), only: new Map(listed.items.map((i) => [pruneKey(i), i.paths])) });
      },
      board: (slug) => boards.board(slug),
    },
    scenarios: {
      get: async (slug, name) => getScenario(await project(slug), name),
      // What an agent (the MCP server, the Studio app) writes is checked as the work it submits will be (core agent-trust).
      validate: async (slug, yaml, o) => validateScenarioText(await project(slug), yaml, { ...o, agent: agentTrust(opts.client), via: agentChannel(opts.client) }),
      check: async (slug, name, o = {}) => {
        const p = await project(slug);
        const text = await getScenario(p, name);
        const { ok, issues } = await validateScenarioText(p, text.yaml, { name, ...(o.env !== undefined ? { env: o.env } : {}) });
        const run_blockers = await runBlockers(submitCtx, { project: slug, scenario: name, ...(o.env !== undefined ? { env: o.env } : {}) });
        return { ...text, ok, issues, run_blockers };
      },
      view: (slug, name, o = {}) => views.view(slug, name, o),
      actions: (slug, name, o = {}) => views.actions(slug, name, o),
      save: async (slug, name, yaml, o) => saveScenarioText(await project(slug), name, yaml, { ...o, agent: agentTrust(opts.client), via: agentChannel(opts.client) }),
      edit: async (slug, name, req) => editScenario(await project(slug), name, req, { agent: agentTrust(opts.client), via: agentChannel(opts.client), registry: async () => (await memoRegistry(ws)).registry }),
      fromScript: async (slug, markdown, o) => draftFromScript(await project(slug), markdown, { ...o, agent: agentTrust(opts.client) }),
    },
    runs: {
      list: async (slug, o) => {
        const runs: RunListItem[] = await listRuns(await project(slug), o);
        for (const r of runs) {
          if (r.newer || (r.status !== 'queued' && r.status !== 'running')) continue;
          const job = await queue.ofRun(slug, r.id);
          const status = job ? overlaid(r.status, job) : undefined;
          if (status) r.status = status;
        }
        return runs;
      },
      status: runStatusWithJob,
      submit: async (req, o = {}) => {
        const r = await submitRunJob(submitCtx, req, o.approver);
        const worker = await startWorker();
        return { job: r.job, run_id: r.run_id, warnings: [...r.warnings, ...(worker?.other ? [otherCopyWarning(worker.other)] : [])], ...(worker ? { worker } : {}) };
      },
      cancel: async (slug, runId) => {
        await project(slug);
        const job = await queue.ofRun(slug, runId);
        if (!job) {
          await runStatus(await project(slug), runId); // not_found when there is no such run
          throw new EngineError('refused', `run ${runId} was not started through a job (a \`retake run\` in a terminal): it is stopped with Ctrl-C there`);
        }
        const rec = await queue.cancel(job.id, opts.client);
        await startWorker();
        return rec;
      },
      pause: async (slug, runId, paused) => {
        const p = await project(slug);
        const job = await queue.ofRun(slug, runId);
        if (!job) {
          await runStatus(p, runId); // not_found when there is no such run
          throw new EngineError('refused', `run ${runId} was not started through a job (a \`retake run\` in a terminal): it cannot be paused from here`);
        }
        if (paused) {
          if (job.state === 'queued') throw new EngineError('conflict', `run ${runId} has not started yet: it can be paused once it runs (between steps)`);
          if (job.state !== 'running') throw new EngineError('conflict', `run ${runId} has ended (${job.state}): there is nothing to pause`);
          if (job.cancel_requested_at) throw new EngineError('conflict', `run ${runId} is stopping: it is not paused`);
        }
        await queue.requestPause(job.id, paused, opts.client);
        return runStatusWithJob(slug, runId);
      },
      thumbs: async (slug, runId, keys, o = {}) => runThumbs.thumbs((await project(slug)).dir, slug, runId, keys, o),
      poster: async (slug, runId) => boards.poster(await project(slug), checkRunId(runId)),
    },
    jobs: {
      get: getJob,
      list: (f) => queue.list(f),
      events: async (id, o) => (await getJob(id), queue.events(id, o)),
      cancel: async (id) => {
        // B16 (L4.8): Claude never discards the person's open Studio recording through job_cancel.
        checkAgentCancel(await getJob(id), opts.client);
        const rec = await queue.cancel(id, opts.client);
        await startWorker();
        return rec;
      },
      wait,
      position: (id) => queue.position(id),
      worker: () => liveWorker(ws.root),
    },
    hooks: {
      submit: async (req, o = {}) => {
        const r = await submitHooksJob(submitCtx, req, o.approver);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
    },
    env: {
      reset: async (req, o = {}) => {
        const r = await submitEnvResetJob(submitCtx, req, o.approver);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
    },
    auth: {
      status: async (o = {}) => {
        if (o.env !== undefined && o.project === undefined) throw new EngineError('invalid', 'env needs project (environments belong to a project)');
        const errors: AuthStatus['errors'] = [];
        const projects = [];
        if (o.project !== undefined) projects.push(await project(o.project));
        else {
          for (const p of await listProjects(ws.root)) {
            try {
              projects.push(await project(p.slug));
            } catch (e) {
              errors.push({ project: p.slug, error: toEngineError(e).message.split('\n')[0] });
            }
          }
        }
        const personas: AuthStatusItem[] = [];
        for (const p of projects) {
          for (const { state } of await projectPersonaStates(p, loginCommand, o.env)) personas.push(authStatusItem(state));
        }
        return { personas, errors };
      },
      login: async (req) => {
        const r = await submitAuthLoginJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      cancelSignIn: async (id) => {
        const rec = await cancelSignIn(queue, id, opts.client);
        await startWorker();
        return rec;
      },
      forScenario: async (slug, name, o = {}) => {
        const p = await project(slug);
        const text = await getScenario(p, name);
        const { scenario } = parseScenario(text.yaml, { file: text.path, project: p });
        if (!scenario) throw new EngineError('invalid', `scenarios/${name} does not parse: fix it first (scenario_check lists its issues)`);
        // The secrets of the login steps are looked for where the worker this client starts finds them.
        const workerEnv = opts.workerEnv ?? (opts.client !== 'cli' ? cleanWorkerEnv(process.env, ws.root, { folders: workspaceFolders(ws) }) : process.env);
        const r = await scenarioPersonaStates(p, scenario, loginCommand, { ...(o.env !== undefined ? { env: o.env } : {}), hooks: (o.mode ?? 'capture') === 'capture', workerEnv });
        return {
          project: p.slug,
          scenario: name,
          env: r.env,
          personas: r.personas.map((x) => ({
            ...authStatusItem(x.state),
            auto: x.auto,
            has_check: x.has_check,
            ...(x.login_env_missing ? { login_env_missing: x.login_env_missing } : {}),
            ...(x.login_keychain ? { login_keychain: x.login_keychain } : {}),
          })),
          issues: r.issues,
        };
      },
    },
    renders: {
      plan: (req) => planPreview(ws, studio, req),
      submit: async (req) => {
        const r = await submitRenderJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker?.other ? { warnings: [...r.warnings, otherCopyWarning(worker.other)] } : {}), ...(worker ? { worker } : {}) };
      },
      status: (slug, renderId, o = {}) => renderStatus(ws, queue, slug, renderId, o.scenario),
      ofScenario: (slug, scenario) => scenarioRenders(ws, queue, slug, scenario),
      frame: async (slug, req, o = {}) => renderFrames.frame(await project(slug), req, o),
      outline: async (slug, req) => renderFrames.outline(await project(slug), req),
    },
    timeline: {
      view: (req) => timelineView(ws, studio, req, { agent: agentTrust(opts.client), via: agentChannel(opts.client) }),
    },
    reviews: {
      submit: async (req) => {
        const r = await submitReviewJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      get: (slug, renderId, o = {}) => reviewGet(ws, queue, slug, renderId, o),
      image: (slug, renderId, image) => reviewImage(ws, slug, renderId, image),
    },
    exports: {
      submit: async (req) => {
        const r = await submitExportJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
    },
    templates: {
      list: (o = {}) => templateList(ws, o.project),
      get: (o) => templateGet(ws, o),
      create: (input) => createThemeFromBrand(ws, input, { trust: 'mcp' }),
      fromSite: async (req, o = {}) => {
        const r = await submitSiteJob(submitCtx, req, o.approver);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      site: (siteId, url) => readSite(ws, siteId, url),
      view: (name) => templateView(ws, name),
      edit: (name, req) => editTemplate(ws, name, req, { client: opts.client }),
      copy: (req) => copyTheme(ws, req),
      files: (kind) => brandFileList(ws, kind),
      sites: () => siteList(ws),
      preview: async (req) => {
        const r = await submitPreviewJob(submitCtx, { project: req.project, ...(req.template !== undefined ? { template: req.template } : {}), target: { kind: 'theme' } });
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
    },
    components: {
      list: (kind) => componentList(ws, kind),
      get: (id) => componentGet(ws, id),
      validate: (id) => componentValidate(ws, id),
      create: (req) => componentCreate(ws, req),
      preview: async (req) => {
        const r = await submitPreviewJob(submitCtx, {
          project: req.project,
          ...(req.template !== undefined ? { template: req.template } : {}),
          target: {
            kind: 'component',
            component: req.component,
            ...(req.slots ? { slots: req.slots } : {}),
            ...(req.params ? { params: req.params } : {}),
            ...(req.at_s !== undefined ? { at_s: req.at_s } : {}),
          },
        });
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      library: async (req) => libraryStatesOf(ws, req),
      libraryRender: async (req) => {
        const r = await submitPreviewJob(submitCtx, {
          project: req.project,
          ...(req.template !== undefined ? { template: req.template } : {}),
          target: { kind: 'library', items: req.items, ...(req.retry ? { retry: true } : {}) },
        });
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
    },
    inspect: {
      submit: async (req) => {
        const r = await submitInspectJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      get: (slug, id) => readInspection(ws, slug, id),
    },
    record: {
      submit: async (req) => {
        // The Studio opens one window at a time in the workspace (critique B5): checked and queued in one chain, so two
        // tabs cannot both pass the check.
        const once = async () => {
          const busy = (await queue.list({ kinds: ['record'], states: ['queued', 'running'], limit: 1 }))[0];
          if (busy && busy.input.kind === 'record') {
            throw new EngineError('conflict', `a recording is already ${busy.state === 'queued' ? 'waiting' : 'open'} in this workspace (project ${busy.input.project}): stop it first — one window at a time`, {
              details: { job: busy.id, project: busy.input.project, rec_id: busy.input.rec_id },
            });
          }
          return submitRecordJob(submitCtx, req);
        };
        let r: Awaited<ReturnType<typeof submitRecordJob>>;
        if (opts.client === 'ui') {
          const next = recordChain.catch(() => undefined).then(once);
          recordChain = next;
          r = await next;
        } else r = await submitRecordJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      get: (slug, id) => readRecording(ws, slug, id),
      view: async (slug, id, o = {}) => {
        studioOnly('record_view');
        return recordView(recordCtx, await project(slug), id, o);
      },
      annotate: async (slug, id, req) => {
        studioOnly('record_annotate');
        return recordAnnotate(recordCtx, await project(slug), id, req);
      },
      save: async (slug, id, req) => {
        studioOnly('record_save');
        return recordSave(recordCtx, await project(slug), id, req);
      },
      discard: async (slug, id, o = {}) => {
        studioOnly('record_discard');
        const r = await recordDiscard(recordCtx, await project(slug), id, o);
        if (r.state === 'discarding') await startWorker();
        return r;
      },
      stop: async (slug, id, o = {}) => {
        studioOnly('record_stop');
        const r = await recordStop(recordCtx, await project(slug), id, o);
        if (r.action !== 'none') await startWorker();
        return r;
      },
      list: async (slug, o = {}) => {
        studioOnly('the recent recordings list');
        return recordList(recordCtx, await project(slug), o);
      },
    },
    thumbnail: (file, maxPx) => thumbnail(ws, file, maxPx),
    comments: {
      list: async (slug, req) => listComments(await project(slug), req),
      get: async (slug, id) => getComment(await project(slug), id),
      add: async (slug, req) => {
        personChannel('add (creating a thread)');
        // The Studio comments the render it showed: a reused id is a conflict, never another render's frame.
        if (opts.client === 'ui' && (req.render_created_at === undefined || req.render_created_at === null)) {
          throw new EngineError('invalid', 'render_created_at is required to comment from the Studio: the created_at of the render shown', { details: { argument: 'render_created_at' } });
        }
        return addComment(await project(slug), req, commentAuthor());
      },
      reply: async (slug, id, text, o = {}) => {
        // Proposals are Claude's (critique B10): a person changes the file; any other channel's entry would be labelled as Claude's.
        if (o.proposal !== undefined && opts.client !== 'mcp' && opts.client !== 'test') {
          throw new EngineError('refused', 'a proposal comes from Claude (comment_reply over MCP): from a terminal or the Studio, change the scenario and reply');
        }
        return replyComment(await project(slug), id, text, commentAuthor(), {
          ...(o.proposal !== undefined ? { proposal: o.proposal } : {}),
          registry: async () => (await memoRegistry(ws)).registry,
        });
      },
      resolve: async (slug, id, req) => {
        needIfMatch(req.if_match, 'resolve');
        return resolveComment(
          await project(slug),
          id,
          { note: req.note, ...(req.render_id !== undefined ? { render_id: req.render_id } : {}), ...(req.if_match !== undefined ? { ifMatch: req.if_match } : {}) },
          commentAuthor(),
        );
      },
      reopen: async (slug, id, note, o = {}) => {
        personChannel('reopen (reopening a thread)');
        needIfMatch(o.if_match, 'reopen');
        return reopenComment(await project(slug), id, note, commentAuthor(), o.if_match !== undefined && o.if_match !== null ? { ifMatch: o.if_match } : {});
      },
      anchorAt: async (slug, req) => anchorAt(await project(slug), req),
      apply: async (slug, id, req) => {
        personChannel('apply (applying a proposal)', 'in the Studio: an agent proposes, a person applies');
        needIfMatch(req.if_match, 'apply');
        return applyProposal(
          await project(slug),
          id,
          { entry_id: req.entry_id, ...(req.if_match !== undefined && req.if_match !== null ? { ifMatch: req.if_match } : {}) },
          commentAuthor(),
          { registry: async () => (await memoRegistry(ws)).registry },
        );
      },
      proposal: async (slug, id, entryId) => getProposal(await project(slug), id, entryId, { registry: async () => (await memoRegistry(ws)).registry }),
      counts: async (slug, o = {}) => commentIndex.counts(await project(slug), o),
    },
    sandbox: {
      status: async (slug, env) => sandboxStatus(await project(slug), env),
      up: async (req, o = {}) => {
        const r = await submitSandboxJob(submitCtx, 'sandbox_up', req, o.approver);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      reset: async (req, o = {}) => {
        const r = await submitSandboxJob(submitCtx, 'sandbox_reset', req, o.approver);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
    },
  };
}

/** A persona's state for a client: no path; the last check's message and page under `untrusted`. */
function authStatusItem(state: PersonaState): AuthStatusItem {
  const { detail, at, ...rest } = personaStateView(state);
  return { ...rest, ...(detail !== undefined || at !== undefined ? { untrusted: { ...(detail !== undefined ? { detail } : {}), ...(at !== undefined ? { at } : {}) } } : {}) };
}
