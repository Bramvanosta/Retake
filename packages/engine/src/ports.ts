/**
 * The engine's ports bag: the adapters a composition root chooses — createEngine (its `ports` option, which the MCP
 * server and the Studio leave out), the jobs worker (`WorkerOptions.ports`), the job process and the CLI
 * (`cli/src/workspace.ts` `cliEnginePorts`). `enginePorts` is the one place their defaults are written: nothing but
 * those roots calls it, nor names `systemClock`, `diskProjectStores`, `diskWorkspaceReads`, `packageHookRunner`,
 * `packageReviewer`, `runnerWebCapture`, `packageSandboxes`, `editorRenderer`, `systemSecrets`, `diskOutputs`,
 * `systemHosts`, `packageRegistries` or `FileJobQueue` (the import-rules ratchet's `clock-read`, `store-new`, `workspace-read`,
 * `loader-use`, `output-read` and `queue` checks).
 */
import { runnerWebCapture } from './capture/runner-web-capture.js';
import type { CaptureRunner } from './capture/runner.js';
import { systemClock } from './clock.js';
import type { EngineEnv } from './env.js';
import type { Clock } from './clock.js';
import { packageHookRunner } from './hook-run/package-hooks.js';
import type { JobQueues } from './jobs/job-queue.js';
import { FileJobQueue } from './jobs/queue.js';
import { editorRenderer } from './render/editor-renderer.js';
import type { Renderer } from './render/renderer.js';
import type { HookRunner } from './hook-run/runner.js';
import { packageReviewer } from './review/review-package.js';
import type { Reviewer } from './review/reviewer.js';
import { packageSandboxes } from './sandboxes/package-sandboxes.js';
import type { Sandboxes } from './sandboxes/sandboxes.js';
import { systemSecrets } from './secrets/system-secrets.js';
import type { Secrets } from './secrets/secrets.js';
import { diskOutputs } from './outputs/disk-outputs.js';
import type { Outputs } from './outputs/outputs.js';
import { packageRegistries } from './registries/package-registries.js';
import type { ComponentRegistries } from './registries/registries.js';
import { diskProjectStores } from './store/project-store.js';
import type { ProjectStores } from './store/store.js';
import { systemHosts } from './host-lookup.js';
import type { HostResolver } from './host-lookup.js';
import { diskWorkspaceReads } from './workspace-reads/disk-reads.js';
import type { WorkspaceReads } from './workspace-reads/reads.js';

export interface EnginePorts {
  /** What the engine stamps what it writes with (clock.ts). */
  clock: Clock;
  /** What every authored write goes through (store/store.ts). */
  stores: ProjectStores;
  /** What a workspace, its projects, scenarios and themes are read by: core's loaders on its disk (workspace-reads/reads.ts). */
  reads: WorkspaceReads;
  /** What runs hooks — outside a capture, and a capture's own through the capture runner — and replays their journals' rollbacks (hook-run/runner.ts). */
  hooks: HookRunner;
  /** What reviews a render and draws the frames and thumbnails the façade serves (review/reviewer.ts). */
  reviewer: Reviewer;
  /** What drives a browser: a run, a recording, a persona's session, js-hook pages, a site (capture/runner.ts). */
  capture: CaptureRunner;
  /** What starts, seeds, resets, stops and reads a project's sandboxes (sandboxes/sandboxes.ts). */
  sandboxes: Sandboxes;
  /** The job queue of a workspace, made for each root that asks (jobs/job-queue.ts JobQueues). */
  queues: JobQueues;
  /** What render, export, still and preview work renders with (render/renderer.ts). */
  renderer: Renderer;
  /** The environment the engine reads (env.ts): this process's for the product. */
  env: EngineEnv;
  /** What resolves the secret references its adapters meet (secrets/secrets.ts): handed to a run, a sign-in, a hook. */
  secrets: Secrets;
  /** What the engine's generated outputs are read and written through — the run folders (outputs/outputs.ts). */
  outputs: Outputs;
  /** What resolves a host name next to an IP literal when the workspace's protected hosts are checked (host-lookup.ts). */
  hosts: HostResolver;
  /** What loads a workspace's component registry, the one the engine hands a plan, a render and a review (registries/registries.ts). */
  registries: ComponentRegistries;
}

/** The product's queue: the file queue of the workspace's `.retake/jobs` (jobs/queue.ts). */
const fileJobQueues: JobQueues = (root, cli, clock, env) => {
  const queue = new FileJobQueue(root, cli, clock, env);
  return { queue, files: queue.files };
};

/**
 * The ports given, the product's adapters for the others: the system's clock, the disk's stores and reads, the hooks package and
 * the review package, the runner package, the file queue, the editor's renderer, the disk's outputs and the components package's
 * registries (none loaded before a member's
 * first call or, for the runner, its `load()`).
 */
export function enginePorts(given: Partial<EnginePorts> = {}): EnginePorts {
  // The one place the engine reads this process's environment (the import-rules ratchet's `env-read` check).
  const env = given.env ?? process.env;
  const secrets = given.secrets ?? systemSecrets(env);
  const hooks = given.hooks ?? packageHookRunner();
  return {
    clock: given.clock ?? systemClock,
    stores: given.stores ?? diskProjectStores,
    reads: given.reads ?? diskWorkspaceReads,
    hooks,
    reviewer: given.reviewer ?? packageReviewer(),
    capture: given.capture ?? runnerWebCapture(),
    sandboxes: given.sandboxes ?? packageSandboxes(secrets, hooks),
    queues: given.queues ?? fileJobQueues,
    renderer: given.renderer ?? editorRenderer(),
    env,
    secrets,
    outputs: given.outputs ?? diskOutputs,
    hosts: given.hosts ?? systemHosts(),
    registries: given.registries ?? packageRegistries(),
  };
}

/** The ports of a bag held by a larger context (a worker, a job runner): each port, nothing else (typed: none forgotten). */
export function portsOf(from: EnginePorts): EnginePorts {
  return {
    clock: from.clock,
    stores: from.stores,
    reads: from.reads,
    hooks: from.hooks,
    reviewer: from.reviewer,
    capture: from.capture,
    sandboxes: from.sandboxes,
    queues: from.queues,
    renderer: from.renderer,
    env: from.env,
    secrets: from.secrets,
    outputs: from.outputs,
    hosts: from.hosts,
    registries: from.registries,
  };
}
