/**
 * The shared part of the engine façade (createEngine, engine.ts): the caller of the client and its decisions, the
 * workspace, the project store's scope, the job queue, the worker starter, the run overlays, the admission rules and the
 * caches the screens share — made once per engine, then handed to the builder of each sub-API (src/facade/*-api.ts).
 */
import { loginCommand as coreLoginCommand } from '@retake/core/environment';
import type { LoadedProject, RunMode, Scenario, WorkFileFacts } from '@retake/core/model';
import type { AgentChannel } from '../caller.js';
import { fileFacts } from '@retake/core/io';
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
import { ProjectBoards } from '../project-board.js';
import { openProjectBySlug } from '../projects.js';
import { RenderFrames } from '../render-frames.js';
import { RunDataCache } from '../run-data.js';
import { RunThumbs } from '../run-thumbs.js';
import { ScenarioViews } from '../scenario-view.js';
import type { StoreScope } from '../store/store.js';
import { openWorkspace } from '../workspace.js';
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
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The context of an engine for a client: its caller, its workspace (opened with the caller's agent policy) and the
 * shared parts. `queueOf` builds the workspace's job queue and names its files (createEngine, the composition root,
 * builds the file queue): the context holds the queue as its port.
 */
export async function engineContext(opts: EngineOptions, ports: EnginePorts, queueOf: (root: string, cli: string) => { queue: JobQueue; files: JobFiles }): Promise<EngineContext> {
  const caller = callerOf(opts.client);
  // The agent's checks and wording of this caller (caller.ts).
  const agent = agentChecks(caller);
  const via = refusalChannel(caller);
  // Every caller but the CLI serves trust mcp in this process (the MCP server, the Studio server; tests: fail-safe).
  const ws = await openWorkspace({ root: opts.root, agent: agentWorkspace(caller) });
  // Every authored write of this engine goes through the project store, journaled as this caller's.
  const scope: StoreScope = { workspace: ws.root, caller, clock: ports.clock, stores: ports.stores };
  const project = (slug: string) => openProjectBySlug(ws, slug);
  /** The commands a human runs name this workspace explicitly (they may be typed in any folder). */
  const studio = `retake -C ${shellQuote(ws.root)}`;
  const loginCommand = (p: { project: string; env: string; persona?: string }) => coreLoginCommand(p).replace(/^retake /, `${studio} `);

  const { queue, files: jobFiles } = queueOf(ws.root, studio);
  const commentIndex = new CommentIndex();
  const submitCtx: SubmitContext = { ws, queue, cli: studio, client: opts.client, ...ports };
  // The scenario screen's reads (L4.2): runs read once and held in memory, shared by the view and the thumbnails.
  const runData = new RunDataCache();
  // Both draw with this engine's reviewer (its frames: the product's load the review's light entry only).
  const runThumbs = new RunThumbs({ policy: ws.policy, frames: ports.reviewer.frames }, runData);
  // The comment viewer's frames wait for the same ffmpeg slots as the run thumbnails (critique B7).
  const renderFrames = new RenderFrames({ policy: ws.policy, frames: ports.reviewer.frames, slots: runThumbs.ffmpegSlots, comments: commentIndex });
  const startWorker: EngineContext['startWorker'] = async () => {
    if (opts.autoStartWorker === false) return undefined;
    // Any caller but the CLI hands its worker a clean environment (a worker an MCP client starts serves the Studio's
    // later jobs too); the Studio passes its own (the same cleaner).
    const env = workerEnvOf(opts, caller, ws);
    return ensureWorker(ws.root, {
      ...(opts.workerIdleExitMs !== undefined ? { idleExitMs: opts.workerIdleExitMs } : {}),
      ...(env ? { env } : {}),
      ...(opts.workerSpawn ? { spawn: opts.workerSpawn } : {}),
      startedBy: opts.client,
    });
  };
  /** What run.json cannot say: its worker died (interrupted), or the job ended before the run started. */
  const overlaid = (status: RunStatusWithJob['status'], job: JobRecord): 'interrupted' | 'cancelled' | 'failed' | undefined =>
    job.state === 'interrupted' || ((job.state === 'cancelled' || job.state === 'failed') && status === 'queued') ? job.state : undefined;
  const views = new ScenarioViews({
    ws,
    project,
    agent,
    via,
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
    files: jobFiles,
    project,
    overlay: async (slug, run) => {
      const job = await queue.ofRun(slug, run.id);
      return (job ? overlaid(run.status, job) : undefined) ?? run.status;
    },
  });
  // The sessions of a parsed scenario on an environment: the Run screen's panel (auth.forScenario) and the capture's
  // sessions_ack rule (on the scenario and environment the run submit settled).
  const sessionsOf: EngineContext['sessionsOf'] = (p, name, scenario, o) => scenarioSessions({ opts, caller, ws, loginCommand, sessions: ports.capture.sessions }, p, name, scenario, o);
  // The admission rules (admission.ts) of the runs, renders and exports this caller submits: the Studio's and MCP's,
  // worded for its channel.
  const admitted = admits(caller)
    ? admission({ queue, channel: via, sessions: (t) => sessionsOf(t.project, t.scenario.name, t.scenario.scenario, { ...(t.env !== undefined ? { env: t.env } : {}), mode: 'capture' }) })
    : undefined;
  return { opts, ports, caller, agent, via, ws, files: fileFacts(ws.policy), scope, project, studio, loginCommand, queue, jobFiles, submitCtx, startWorker, overlaid, sessionsOf, admitted, runData, runThumbs, commentIndex, renderFrames, views, boards };
}
