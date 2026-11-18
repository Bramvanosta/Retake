/**
 * The shared part of the engine façade (createEngine, engine.ts): the caller of the client and its decisions, the
 * workspace, the project store's scope, the job queue, the worker starter, the run overlays, the admission rules and the
 * caches the screens share — made once per engine, then handed to the builder of each sub-API (src/facade/*-api.ts).
 */
import { loginCommand as coreLoginCommand } from '@retake/core/environment';
import type { LoadedProject } from '@retake/core/project';
import type { RunMode } from '@retake/core/run';
import type { Scenario } from '@retake/core/scenario';
import type { WorkFileFacts } from '@retake/core/model';
import type { AgentChannel } from '../caller.js';
import { admission } from '../admission.js';
import type { Admission } from '../admission.js';
import { admits, agentChecks, agentWorkspace, callerOf, refusalChannel } from '../caller.js';
import type { Caller } from '../caller.js';
import { CommentIndex } from '../comments.js';
import type { JobQueue } from '../jobs/job-queue.js';
import type { JobFiles } from '../jobs/queue.js';
import { runBlockers } from '../jobs/run-job.js';
import type { SubmitContext } from '../jobs/run-job.js';
import { ensureWorker } from '../jobs/spawn.js';
import type { JobRecord } from '../jobs/types.js';
import { workerEnvOf } from '../jobs/worker-env.js';
import { ProjectBoards } from '../views/project-board.js';
import { RegistryMemo, TimelineMemos } from '../views/timeline-view.js';
import { PreviewSamplesMemo } from '../views/theme-preview.js';
import { RenderMemos } from '../renders.js';
import { ThemeEditMemos } from '../theme-edit.js';
import { VersionLedger } from '../version-ledger.js';
import { openProjectBySlug } from '../projects.js';
import { RenderFrames } from '../render-frames.js';
import { RunDataCache } from '../run-data.js';
import { RunThumbs } from '../run-thumbs.js';
import { ScenarioViews } from '../views/scenario-view.js';
import type { StoreScope } from '../store/store.js';
import { openWorkspace } from '../workspace.js';
import { cachedProjectBrowsers } from '../tools/tool-need.js';
import { scenarioSessions } from './sessions.js';
import type { EngineOptions, RunStatusWithJob, ScenarioSessions } from './types.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { EnginePorts } from '../ports.js';

/** What every sub-API of the façade is built from: made once per engine, shared by its builders. */
export interface EngineContext {
  readonly opts: EngineOptions;
  /** The ports this engine runs with (its composition root's choice, ports.ts). */
  readonly ports: EnginePorts;
  /** The caller of the client and every decision taken from it (caller.ts). */
  readonly caller: Caller;
  /** The agent's checks apply to this caller. */
  readonly agent: boolean;
  /** The channel a refusal is worded for. */
  readonly via: AgentChannel;
  readonly ws: OpenedWorkspace;
  /** How this engine's checks look at the disk (core FileFacts): its videos probed under the workspace's policy. */
  readonly files: WorkFileFacts;
  /** Every authored write of this engine goes through the project store, journaled as this caller's. */
  readonly scope: StoreScope;
  readonly project: (slug: string) => Promise<LoadedProject>;
  /** `retake -C <root>`: the commands a human runs name this workspace explicitly. */
  readonly studio: string;
  readonly loginCommand: (p: { project: string; env: string; persona?: string }) => string;
  /** The workspace's job queue, as its port: the facade never names the class behind it. */
  readonly queue: JobQueue;
  /** The paths of that queue's files (a job's folder, its log), handed beside it. */
  readonly jobFiles: JobFiles;
  /** What a job submission is handed: the workspace, the queue, the command line, the client. */
  readonly submitCtx: SubmitContext;
  /** Start the workspace's worker (unless autoStartWorker is false): after a submit or a cancel. */
  readonly startWorker: () => Promise<Awaited<ReturnType<typeof ensureWorker>> | undefined>;
  /** What run.json cannot say: its worker died (interrupted), or the job ended before the run started. */
  readonly overlaid: (status: RunStatusWithJob['status'], job: JobRecord) => 'interrupted' | 'cancelled' | 'failed' | undefined;
  readonly sessionsOf: (p: LoadedProject, name: string, scenario: Scenario, o: { env?: string; mode?: RunMode }) => Promise<ScenarioSessions>;
  /** The admission rules (admission.ts) of the runs, renders and exports this caller submits; none for the CLI. */
  readonly admitted: Admission | undefined;
  readonly runData: RunDataCache;
  readonly runThumbs: RunThumbs;
  readonly commentIndex: CommentIndex;
  readonly renderFrames: RenderFrames;
  readonly views: ScenarioViews;
  readonly boards: ProjectBoards;
  /** What this engine remembers between calls (never shared with another engine of the process). */
  readonly caches: EngineCaches;
}

/**
 * The memos and ledgers of one engine: what its views reuse while the files they read are unchanged, and the versions
 * of the files it showed or wrote (an undo / redo `restore` writes back only one of these). Bounded as each says.
 */
export interface EngineCaches {
  /** The workspace's component registry. */
  readonly registry: RegistryMemo;
  /** The timeline views (the registry is the one above). */
  readonly timeline: TimelineMemos;
  /** The render list's and the board's report summaries and plan signatures. */
  readonly renders: RenderMemos;
  /** The theme editor's uses and its template.yaml versions. */
  readonly themeEdit: ThemeEditMemos;
  /** The theme preview's samples. */
  readonly previewSamples: PreviewSamplesMemo;
  /** The versions of each scenario file this engine showed or wrote. */
  readonly scenarioVersions: VersionLedger;
}

/** A new engine's caches: empty. */
export function engineCaches(): EngineCaches {
  const registry = new RegistryMemo();
  return {
    registry,
    timeline: new TimelineMemos(registry),
    renders: new RenderMemos(),
    themeEdit: new ThemeEditMemos(),
    previewSamples: new PreviewSamplesMemo(),
    scenarioVersions: new VersionLedger(),
  };
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What run.json cannot say: its worker died (interrupted), or the job ended before the run started. */
const overlaid = (status: RunStatusWithJob['status'], job: JobRecord): 'interrupted' | 'cancelled' | 'failed' | undefined =>
  job.state === 'interrupted' || ((job.state === 'cancelled' || job.state === 'failed') && status === 'queued') ? job.state : undefined;

/** A run's status with its job's state overlaid (the scenario views' and the boards' rule). */
function runOverlay(queue: EngineContext['queue']) {
  return async (slug: string, run: { id: string; status: RunStatusWithJob['status'] }) => {
    const job = await queue.ofRun(slug, run.id);
    return (job ? overlaid(run.status, job) : undefined) ?? run.status;
  };
}

/** A scenario's open render job (queued or running), as the scenario view shows it. */
async function openRenderJob(queue: EngineContext['queue'], slug: string, name: string) {
  const open = (await queue.list({ project: slug, kinds: ['render'], states: ['queued', 'running'] })).find((j) => j.input.kind === 'render' && j.input.scenario === name);
  if (!open) return undefined;
  return { job: open.id, state: open.state === 'running' ? ('running' as const) : ('queued' as const), ...(open.progress?.fraction !== undefined ? { fraction: open.progress.fraction } : {}) };
}

/** What starts this workspace's jobs worker when a job is submitted (nothing when the options say so). */
function workerStarter(opts: EngineOptions, caller: EngineContext['caller'], ws: EngineContext['ws'], ports: EnginePorts): EngineContext['startWorker'] {
  return async () => {
    if (opts.autoStartWorker === false) return undefined;
    // Any caller but the CLI hands its worker a clean environment (a worker an MCP client starts serves the Studio's
    // later jobs too); the Studio passes its own (the same cleaner).
    const env = workerEnvOf(opts, caller, ws, ports.env);
    return ensureWorker(ws.root, {
      ...(opts.workerIdleExitMs !== undefined ? { idleExitMs: opts.workerIdleExitMs } : {}),
      env: env ?? ports.env,
      ...(opts.workerSpawn ? { spawn: opts.workerSpawn } : {}),
      startedBy: opts.client,
    });
  };
}

/**
 * The context of an engine for a client: its caller, its workspace (opened with the caller's agent policy) and the
 * shared parts. The workspace's job queue and the paths of its files come from the ports' queue factory (the file
 * queue for the product, a memory one a test hands): the context holds the queue as its port.
 */
export async function engineContext(opts: EngineOptions, ports: EnginePorts): Promise<EngineContext> {
  const caller = callerOf(opts.client);
  // The agent's checks and wording of this caller (caller.ts).
  const agent = agentChecks(caller);
  const via = refusalChannel(caller);
  // Every caller but the CLI serves trust mcp in this process (the MCP server, the Studio server; tests: fail-safe).
  const ws = await openWorkspace({ root: opts.root, agent: agentWorkspace(caller), reads: ports.reads, outputs: ports.outputs, registries: ports.registries });
  // Every authored write of this engine goes through the project store, journaled as this caller's.
  const scope: StoreScope = { workspace: ws.root, caller, clock: ports.clock, stores: ports.stores };
  const project = (slug: string) => openProjectBySlug(ws, slug);
  /** The commands a human runs name this workspace explicitly (they may be typed in any folder). */
  const studio = `retake -C ${shellQuote(ws.root)}`;
  const loginCommand = (p: { project: string; env: string; persona?: string }) => coreLoginCommand(p).replace(/^retake /, `${studio} `);

  const { queue, files: jobFiles } = ports.queues(ws.root, studio, ports.clock, ports.env);
  // The queue's Tools waiting: each project's own browser (read through the WorkspaceReads port), and a fake app's
  // Tools (tests: the queue's gate reads the same app as engine.tools).
  queue.useTools({ browsers: cachedProjectBrowsers(async (slug) => (await openProjectBySlug(ws, slug)).config.browser), ...(opts.tools?.bundle !== undefined ? { app: opts.tools.bundle } : {}) });
  const caches = engineCaches();
  const commentIndex = new CommentIndex();
  const submitCtx: SubmitContext = { ws, queue, cli: studio, client: opts.client, ...ports };
  // The scenario screen's reads: runs read once and held in memory, shared by the view and the thumbnails.
  const runData = new RunDataCache();
  // Both draw with this engine's reviewer (its frames: the product's load the review's light entry only).
  const runThumbs = new RunThumbs({ policy: ws.policy, frames: ports.reviewer.frames }, runData);
  // The comment viewer's frames wait for the same ffmpeg slots as the run thumbnails.
  const renderFrames = new RenderFrames({ policy: ws.policy, frames: ports.reviewer.frames, renders: ws.outputs.renders, slots: runThumbs.ffmpegSlots, comments: commentIndex });
  const startWorker = workerStarter(opts, caller, ws, ports);
  const overlay = runOverlay(queue);
  const views = new ScenarioViews({
    ws,
    project,
    agent,
    via,
    blockers: (req) => runBlockers(submitCtx, req),
    overlay,
    runJob: async (slug, run) => (await queue.ofRun(slug, run))?.id ?? null,
    renderJob: (slug, name) => openRenderJob(queue, slug, name),
    runs: runData,
    stores: ports.stores,
    seen: caches.scenarioVersions,
  });
  // The Project screen's board, its memos apart from the views' (never evict the open scenario's).
  const boards = new ProjectBoards({
    ws,
    queue,
    files: jobFiles,
    project,
    overlay,
    renderMemos: caches.renders,
    env: ports.env,
    stores: ports.stores,
    seen: caches.scenarioVersions,
  });
  // The sessions of a parsed scenario on an environment: the Run screen's panel (auth.forScenario) and the capture's
  // sessions_ack rule (on the scenario and environment the run submit settled).
  const sessionsOf: EngineContext['sessionsOf'] = (p, name, scenario, o) =>
    scenarioSessions({ opts, caller, ws, loginCommand, sessions: ports.capture.sessions, vars: ports.env }, p, name, scenario, o);
  // The admission rules (admission.ts) of the runs, renders and exports this caller submits: the Studio's and MCP's,
  // worded for its channel.
  const admitted = admits(caller)
    ? admission({ queue, channel: via, sessions: (t) => sessionsOf(t.project, t.scenario.name, t.scenario.scenario, { ...(t.env !== undefined ? { env: t.env } : {}), mode: 'capture' }) })
    : undefined;
  return {
    opts,
    ports,
    caller,
    agent,
    via,
    ws,
    files: ws.reads.fileFacts(ws.policy),
    scope,
    project,
    studio,
    loginCommand,
    queue,
    jobFiles,
    submitCtx,
    startWorker,
    overlaid,
    sessionsOf,
    admitted,
    runData,
    runThumbs,
    commentIndex,
    renderFrames,
    views,
    boards,
    caches,
  };
}
