/**
 * The engine facade (L3.1 part A, read side): one typed, in-process API over a workspace for clients other than the
 * CLI's own commands — the MCP server now, the jobs worker and the local HTTP API later. Inputs are slugs and ids, never
 * paths; results carry project refs + local paths; text the filmed site controls is kept under `untrusted`.
 * Nothing here opens a browser or starts a capture: long tasks (runs, hooks, resets, sign-ins, sandboxes) become jobs the
 * workspace's worker runs in a process of its own.
 */
import { hostname } from 'node:os';
import { DEMO_STUDIO_VERSION, listProjects, loginCommand as coreLoginCommand } from '@demo-studio/core';
import type { RunMode, WorkspaceConfig } from '@demo-studio/core';
import { personaStateView, projectPersonaStates } from './auth.js';
import type { PersonaStateView } from './auth.js';
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
import { getScenario, saveScenarioText, validateScenarioText } from './scenarios.js';
import type { SaveResult, ScenarioText, ValidateResult } from './scenarios.js';
import { draftFromScript } from './authoring.js';
import type { ScriptDraftView } from './authoring.js';
import { openWorkspace } from './workspace.js';
import { liveWorker } from './jobs/lock.js';
import type { WorkerLockRecord } from './jobs/lock.js';
import { FileJobQueue } from './jobs/queue.js';
import type { JobFilter } from './jobs/queue.js';
import { submitRunJob } from './jobs/run-job.js';
import { submitEnvResetJob, submitHooksJob } from './jobs/hooks-job.js';
import type { EnvResetSubmitRequest, HooksSubmitRequest } from './jobs/hooks-job.js';
import { submitAuthLoginJob } from './jobs/auth-job.js';
import type { AuthLoginSubmitRequest } from './jobs/auth-job.js';
import { submitSandboxJob } from './jobs/sandbox-job.js';
import { submitRenderJob } from './jobs/render-job.js';
import type { RenderRequest } from './jobs/render-job.js';
import { planPreview, renderStatus } from './renders.js';
import { submitReviewJob } from './jobs/review-job.js';
import type { ReviewRequest } from './jobs/review-job.js';
import { submitExportJob } from './jobs/export-job.js';
import type { ExportRequest } from './jobs/export-job.js';
import { reviewGet, thumbnail } from './reviews.js';
import { submitPreviewJob } from './jobs/preview-job.js';
import { readInspection, submitInspectJob } from './jobs/inspect-job.js';
import type { InspectSubmitRequest } from './jobs/inspect-job.js';
import { readRecording, submitRecordJob } from './jobs/record-job.js';
import type { RecordSubmitRequest } from './jobs/record-job.js';
import type { InspectJobInput } from '@demo-studio/core';
import type { InspectReport } from '@demo-studio/runner-web';
import type { PreviewRequest } from './jobs/preview-job.js';
import { componentCreate, componentGet, componentList, componentValidate } from './components.js';
import type { ComponentCreateRequest, ComponentCreated, ComponentListView, ComponentValidationView, ComponentView } from './components.js';
import { templateGet, templateList } from './templates.js';
import { createThemeFromBrand } from './brand/create.js';
import { readSite, submitSiteJob } from './jobs/site-job.js';
import type { SiteSubmitted } from './jobs/site-job.js';
import type { ThemeCreated } from './brand/create.js';
import type { TemplateDetail, TemplateListView } from './templates.js';
import type { ComponentKind } from '@demo-studio/core';
import type { ReviewImagesMode, ReviewView } from './reviews.js';
import type { PlanPreviewView, RenderStatusView } from './renders.js';
import type { SandboxSubmitRequest } from './jobs/sandbox-job.js';
import { MCP_AUTHOR_NAME, addComment, defaultAuthorName, getComment, listComments, reopenComment, replyComment, resolveComment } from './comments.js';
import type { CommentAddRequest, CommentAdded, CommentListRequest, CommentListView, CommentView, CommentWritten } from './comments.js';
import { entitlements } from './entitlements.js';
import type { Entitlements } from './entitlements.js';
import { usageCounts } from './history.js';
import type { UsageCounts } from './history.js';
import type { Approver } from './approvals.js';
import type { RunSubmitRequest } from './jobs/run-job.js';
import { ensureWorker } from './jobs/spawn.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import type { JobEvent, JobRecord, SiteJobResult } from './jobs/types.js';

export const ENGINE_API_VERSION = 1;

export type EngineClient = 'cli' | 'mcp' | 'test';

export interface EngineOptions {
  /** Workspace root; default $DEMO_STUDIO_ROOT, else the studio.yaml lookup from the cwd. */
  root?: string;
  /** Who drives it: recorded with what it starts (jobs) and shapes the safety defaults. */
  client: EngineClient;
  /** Start the workspace's jobs worker when a job is submitted or cancelled (default true). */
  autoStartWorker?: boolean;
  /** The idle exit of a worker this engine starts (ms; default the worker's 60 s). */
  workerIdleExitMs?: number;
}

/** A run's job as run_status shows it. */
export interface RunJobView {
  id: string;
  state: JobRecord['state'];
  /** Queued: how many jobs run or wait before it, and the one running. */
  queue?: { ahead: number; running?: string };
  cancel_requested_at?: string;
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

export interface AuthStatus {
  personas: AuthStatusItem[];
  /** Projects that do not load (listed when no project was named). */
  errors: Array<{ project: string; error: string }>;
}

export interface Engine {
  readonly root: string;
  readonly workspace: WorkspaceConfig;
  /** `studio -C <root>`: how the commands a human is asked to run start (they may be typed in any folder). */
  readonly cli: string;
  info(): EngineInfo;
  /** What the workspace produced, from its job history (history.jsonl: jobs and CLI runs). */
  usage(): Promise<UsageCounts>;
  projects: {
    list(): Promise<ProjectSummary[]>;
    get(project: string): Promise<ProjectView>;
    create(input: CreateProjectRequest): Promise<ProjectView>;
    updateReadme(project: string, markdown: string, ifMatch?: string | null): Promise<{ file: string; path: string; hash: string }>;
  };
  scenarios: {
    get(project: string, name: string): Promise<ScenarioText>;
    validate(project: string, yaml: string, opts?: { env?: string; until?: string; name?: string }): Promise<ValidateResult>;
    save(project: string, name: string, yaml: string, opts?: { ifMatch?: string | null }): Promise<SaveResult>;
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
     * without one, or when not approved, the submit is refused with the `studio` command a human runs.
     */
    submit(req: RunSubmitRequest, o?: { approver?: Approver }): Promise<{ job: JobRecord; run_id: string; warnings: string[]; worker?: { pid?: number; spawned: boolean } }>;
    /** Cancel the job of a run (teardown and rollbacks still run). A run started from the CLI is refused. */
    cancel(project: string, runId: string): Promise<JobRecord>;
  };
  jobs: {
    get(id: string): Promise<JobRecord>;
    list(filter?: JobFilter): Promise<JobRecord[]>;
    events(id: string, opts?: { after?: number; limit?: number }): Promise<JobEvent[]>;
    cancel(id: string): Promise<JobRecord>;
    /** Wait until the job finishes or `timeoutMs` passes; returns it as it is then. */
    wait(id: string, opts: WaitOptions): Promise<JobRecord>;
    position(id: string): Promise<{ ahead: number; running?: string } | undefined>;
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
  };
  renders: {
    /** Plan a render in this process (trust `mcp` gates; no browser): segments, timings, warnings. */
    plan(req: RenderRequest): Promise<PlanPreviewView>;
    /**
     * Queue a render (trust `mcp`: planned and checked first; the worker renders with the network guard). Returns at
     * once with the reserved render id.
     */
    submit(req: RenderRequest): Promise<{ job: JobRecord; render_id: string; run_id: string; variant: string; duration_s: number; warnings: string[]; worker?: { pid?: number; spawned: boolean } }>;
    /** A render's status: its newest job first, then renders/<id>.json. `latest` (of `scenario`) names the newest. */
    status(project: string, renderId: string, o?: { scenario?: string }): Promise<RenderStatusView>;
  };
  reviews: {
    /** Queue a review of a render (its video and run must lie in the project; `latest` is resolved now). */
    submit(req: ReviewRequest): Promise<{ job: JobRecord; render_id: string; worker?: { pid?: number; spawned: boolean } }>;
    /** A render's review: its newest job, then review/<id>/report.json (paths rebuilt from the folder, messages untrusted). */
    get(project: string, renderId: string, o?: { scenario?: string; images?: ReviewImagesMode }): Promise<ReviewView>;
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
    /** Queue stills of a theme (intro, layout + caption, card, interstitial, outro) into .demo-studio/previews/. */
    preview(req: { project: string; template?: string }): Promise<PreviewSubmitted>;
    /**
     * A new workspace theme from brand inputs (L3.5; core BrandInputSchema), under trust `mcp`: brand files are
     * workspace files outside agent-writable, hidden and components folders; never an existing theme, except `replace`
     * of one this tool made that nobody changed. `studio theme create` calls createThemeFromBrand with trust `author`.
     */
    create(input: unknown): Promise<ThemeCreated>;
    /**
     * Queue a site extraction (L3.5, R-MCP-12) after asking the human (through `approver`) to approve the exact URL:
     * colours, font names, logo PNGs and a screenshot into .demo-studio/site/<id>/, and a draft brand input. Refused
     * for an environment page or a protected host; needs_approval when the client cannot ask anyone.
     */
    fromSite(req: { url: string }, o?: { approver?: Approver }): Promise<SiteSubmitted & { worker?: { pid?: number; spawned: boolean } }>;
    /** A site extraction read back (site.json as a file of the workspace) with its draft; null view before it is written. */
    site(siteId: string, url: string): Promise<{ dir: string; view: SiteJobResult | null }>;
  };
  components: {
    list(kind?: string): Promise<ComponentListView>;
    get(id: string): Promise<ComponentView>;
    /** Manifest, entry and compile check (nothing executed). */
    validate(id: string): Promise<ComponentValidationView>;
    /** Scaffold a workspace component (refuses the built-in namespace and built-in ids; no preview rendered). */
    create(req: ComponentCreateRequest): Promise<ComponentCreated>;
    /** Queue a still of a component with a theme, slot values and params into .demo-studio/previews/ (never its folder). */
    preview(req: { project: string; template?: string; component: string; slots?: Record<string, string>; params?: Record<string, unknown>; at_s?: number }): Promise<PreviewSubmitted>;
  };
  inspect: {
    /**
     * Queue an inspection (L3.3): a dry replay of a page (page key + path, or a URL of the environment's own origins) or
     * of a saved scenario up to a step, then the page inventoried into <project>/.demo-studio/inspect/<id>/ — run_dry's
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
  };
  /** A JPEG thumbnail (base64) of an image of the workspace, made on read: never stored. */
  thumbnail(file: string, maxPx?: number): Promise<{ base64: string; width: number; height: number; bytes: number }>;
  /**
   * Frame comments (L3.6): threads on frames of renders. Entries are written as the channel `cli` for client `cli`,
   * `mcp` for any other client (`test` included: fail-safe). Only client `cli` creates and reopens threads; any other
   * client needs `if_match` to resolve.
   */
  comments: {
    list(project: string, req?: CommentListRequest): Promise<CommentListView>;
    get(project: string, id: string): Promise<CommentView>;
    add(project: string, req: CommentAddRequest): Promise<CommentAdded>;
    reply(project: string, id: string, text: string): Promise<CommentWritten>;
    resolve(project: string, id: string, req: { note: string; render_id?: string; if_match?: string }): Promise<CommentWritten>;
    reopen(project: string, id: string, note?: string): Promise<CommentWritten>;
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
  const ws = await openWorkspace({ root: opts.root });
  const project = (slug: string) => openProjectBySlug(ws, slug);
  /** The commands a human runs name this workspace explicitly (they may be typed in any folder). */
  const studio = `studio -C ${shellQuote(ws.root)}`;
  const loginCommand = (p: { project: string; env: string; persona?: string }) => coreLoginCommand(p).replace(/^studio /, `${studio} `);

  const queue = new FileJobQueue(ws.root, studio);
  // Who an entry is written by: the channel, never a person; anything but the CLI counts as the MCP (fail-safe).
  const commentAuthor = () => (opts.client === 'cli' ? { via: 'cli' as const, name: defaultAuthorName() } : { via: 'mcp' as const, name: MCP_AUTHOR_NAME });
  const cliOnly = (what: string) => {
    if (opts.client !== 'cli') throw new EngineError('refused', `${what} is for a person at a terminal (studio comment ${what.split(' ')[0]}): an agent replies to and resolves comments`);
  };
  const submitCtx = { ws, queue, cli: studio, client: opts.client };
  const startWorker = async () =>
    opts.autoStartWorker === false ? undefined : ensureWorker(ws.root, opts.workerIdleExitMs !== undefined ? { idleExitMs: opts.workerIdleExitMs } : {});
  const getJob = async (id: string): Promise<JobRecord> => {
    const job = await queue.get(id);
    if (!job) throw new EngineError('not_found', `job ${id} not found (job_list names the jobs)`);
    return job;
  };
  const wait = async (id: string, w: WaitOptions): Promise<JobRecord> => {
    const deadline = Date.now() + Math.max(0, w.timeoutMs);
    let job = await getJob(id);
    let last = JSON.stringify([job.state, job.progress?.steps_done, job.progress?.current, job.progress?.phase]);
    while (!FINISHED_JOB_STATES.has(job.state) && Date.now() < deadline && !w.signal?.aborted) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(300, Math.max(0, deadline - Date.now())));
        w.signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
      job = await getJob(id);
      const now = JSON.stringify([job.state, job.progress?.steps_done, job.progress?.current, job.progress?.phase]);
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
      version: DEMO_STUDIO_VERSION,
      node: process.versions.node,
      client: opts.client,
      root: ws.root,
      projects_dir: ws.projectsDir,
      host: hostname(),
      pid: process.pid,
      features: [
        'projects',
        'scenarios',
        'scenarios.from_script',
        'runs.read',
        'runs.dry',
        'runs.capture',
        'jobs',
        'hooks',
        'env.reset',
        'approvals',
        'auth.status',
        'auth.login',
        'sandbox.status',
        'sandbox.up',
        'sandbox.reset',
        'renders',
        'renders.plan',
        'reviews',
        'exports',
        'templates.read',
        'templates.preview',
        'templates.create',
        'templates.from_site',
        'components.read',
        'components.create',
        'components.preview',
        'inspect',
        'record',
        'comments',
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
    },
    scenarios: {
      get: async (slug, name) => getScenario(await project(slug), name),
      // What the MCP server's agent writes is checked as the work it submits will be (core agent-trust).
      validate: async (slug, yaml, o) => validateScenarioText(await project(slug), yaml, { ...o, agent: opts.client === 'mcp' }),
      save: async (slug, name, yaml, o) => saveScenarioText(await project(slug), name, yaml, { ...o, agent: opts.client === 'mcp' }),
      fromScript: async (slug, markdown, o) => draftFromScript(await project(slug), markdown, { ...o, agent: opts.client === 'mcp' }),
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
        return { job: r.job, run_id: r.run_id, warnings: r.warnings, ...(worker ? { worker } : {}) };
      },
      cancel: async (slug, runId) => {
        await project(slug);
        const job = await queue.ofRun(slug, runId);
        if (!job) {
          await runStatus(await project(slug), runId); // not_found when there is no such run
          throw new EngineError('refused', `run ${runId} was not started through a job (a \`studio run\` in a terminal): it is stopped with Ctrl-C there`);
        }
        const rec = await queue.cancel(job.id, opts.client);
        await startWorker();
        return rec;
      },
    },
    jobs: {
      get: getJob,
      list: (f) => queue.list(f),
      events: async (id, o) => (await getJob(id), queue.events(id, o)),
      cancel: async (id) => {
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
          for (const { state } of await projectPersonaStates(p, loginCommand, o.env)) {
            const { detail, at, ...rest } = personaStateView(state);
            personas.push({ ...rest, ...(detail !== undefined || at !== undefined ? { untrusted: { ...(detail !== undefined ? { detail } : {}), ...(at !== undefined ? { at } : {}) } } : {}) });
          }
        }
        return { personas, errors };
      },
      login: async (req) => {
        const r = await submitAuthLoginJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
    },
    renders: {
      plan: (req) => planPreview(ws, studio, req),
      submit: async (req) => {
        const r = await submitRenderJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      status: (slug, renderId, o = {}) => renderStatus(ws, queue, slug, renderId, o.scenario),
    },
    reviews: {
      submit: async (req) => {
        const r = await submitReviewJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      get: (slug, renderId, o = {}) => reviewGet(ws, queue, slug, renderId, o),
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
        const r = await submitRecordJob(submitCtx, req);
        const worker = await startWorker();
        return { ...r, ...(worker ? { worker } : {}) };
      },
      get: (slug, id) => readRecording(ws, slug, id),
    },
    thumbnail: (file, maxPx) => thumbnail(ws, file, maxPx),
    comments: {
      list: async (slug, req) => listComments(await project(slug), req),
      get: async (slug, id) => getComment(await project(slug), id),
      add: async (slug, req) => {
        cliOnly('add (creating a thread)');
        return addComment(await project(slug), req, commentAuthor());
      },
      reply: async (slug, id, text) => replyComment(await project(slug), id, text, commentAuthor()),
      resolve: async (slug, id, req) => {
        if (opts.client !== 'cli' && (req.if_match === undefined || req.if_match === null)) {
          throw new EngineError('invalid', 'if_match is required to resolve a comment: the hash comments_list returned for the thread', { details: { argument: 'if_match' } });
        }
        return resolveComment(
          await project(slug),
          id,
          { note: req.note, ...(req.render_id !== undefined ? { render_id: req.render_id } : {}), ...(req.if_match !== undefined ? { ifMatch: req.if_match } : {}) },
          commentAuthor(),
        );
      },
      reopen: async (slug, id, note) => {
        cliOnly('reopen (reopening a thread)');
        return reopenComment(await project(slug), id, note, commentAuthor());
      },
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
