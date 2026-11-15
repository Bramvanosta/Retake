/**
 * The engine's ports bag: the adapters a composition root chooses — createEngine (its `ports` option, which the MCP
 * server and the Studio fill from the composition package), the jobs worker (`WorkerOptions.ports`), the job process
 * and the CLI (`cli/src/workspace.ts` `cliEnginePorts`). `enginePorts` writes the engine's own defaults (the system's
 * clock, the disk's stores, reads and outputs, the file queue, the system's secrets and host resolver); the adapters of
 * the product's packages — the hooks, the review, the runner, the sandboxes, the editor's renderer, the components'
 * registries — are the composition package's (`@retake/compose` productPorts, which binds them here: `bindProduct`).
 * The engine itself loads none of those packages. Nothing but the roots calls `enginePorts`, nor names
 * `systemClock`, `diskProjectStores`, `diskWorkspaceReads`, `systemSecrets`, `diskOutputs`, `systemHosts` or
 * `FileJobQueue` (the import-rules ratchet's `clock-read`, `store-new`, `workspace-read`, `loader-use`, `output-read` and
 * `queue` checks).
 */
import type { CaptureRunner } from './capture/runner.js';
import { systemClock } from './clock.js';
import type { EngineEnv } from './env.js';
import type { Clock } from './clock.js';
import { EngineError } from './errors.js';
import type { JobQueues } from './jobs/job-queue.js';
import { FileJobQueue } from './jobs/queue.js';
import { bindAdapterModules } from './lazy.js';
import type { AdapterModules } from './lazy.js';
import type { Renderer } from './render/renderer.js';
import type { HookRunner } from './hook-run/runner.js';
import type { Reviewer } from './review/reviewer.js';
import type { Sandboxes } from './sandboxes/sandboxes.js';
import { systemSecrets } from './secrets/system-secrets.js';
import type { Secrets } from './secrets/secrets.js';
import { diskOutputs } from './outputs/disk-outputs.js';
import type { Outputs } from './outputs/outputs.js';
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

/** The ports whose product adapters are the packages' (the composition package makes them). */
export type ProductAdapters = Pick<EnginePorts, 'hooks' | 'reviewer' | 'capture' | 'sandboxes' | 'renderer' | 'registries'>;

/**
 * What the composition package binds once per process (`@retake/compose` bindProduct): the adapter modules the engine's
 * render and registries folders hand on (lazy.ts), the product's adapters of the package ports — the given ones kept,
 * each other made, the sandboxes on the bag's secrets and hook runner — and the entry file a jobs worker and a job
 * process run (built `.js`, or the `.ts` source under tsx).
 */
export interface Product {
  modules: AdapterModules;
  adapters(given: Partial<EnginePorts>, secrets: Secrets): ProductAdapters;
  workerEntry: string;
}

// The process's by nature, not an engine's (the import-rules ratchet's engine-state, ENGINE_STATE_PROCESS): the
// product's package adapters and the worker entry this process starts. Two engines of one process share it; their
// ports may still differ (an engine handed every package port uses none of it).
let product: Product | undefined;

/**
 * Bind the product (the composition package, once per process): binding the same product again is a no-op, binding
 * another once one is bound is refused (the engines already made, and the worker they start, would change under them).
 */
export function bindProduct(p: Product): void {
  if (product === p) return;
  if (product) throw new EngineError('internal', 'another product is bound in this process already: a process binds one product (@retake/compose productPorts)');
  bindAdapterModules(p.modules);
  product = p;
}

/** Whether a product is bound in this process. */
export function productBound(): boolean {
  return product !== undefined;
}

/** The bound product, or a refusal that names what is missing (`what`: the work that needed it). */
export function boundProduct(what: string): Product {
  if (!product) throw new EngineError('internal', `${what}: no product is bound — a composition root builds the engine from @retake/compose (productPorts)`);
  return product;
}

/** The bound product's worker entry, undefined before a product is bound (a build stamp then counts the engine's folders only). */
export function boundWorkerEntry(): string | undefined {
  return product?.workerEntry;
}

const PRODUCT_PORTS = ['hooks', 'reviewer', 'capture', 'sandboxes', 'renderer', 'registries'] as const;

/**
 * The ports given, the engine's own adapters for the others — the system's clock, the disk's stores, reads and outputs,
 * the file queue, the system's secrets and host resolver — and the bound product's for the package ports (none loaded
 * before a member's first call or, for the runner, its `load()`). Every package port given: no product needed.
 */
export function enginePorts(given: Partial<EnginePorts> = {}): EnginePorts {
  // The one place the engine reads this process's environment (the import-rules ratchet's `env-read` check).
  const env = given.env ?? process.env;
  const secrets = given.secrets ?? systemSecrets(env);
  const adapters: ProductAdapters = PRODUCT_PORTS.every((k) => given[k] !== undefined) ? (given as ProductAdapters) : boundProduct("the engine's ports").adapters(given, secrets);
  return {
    clock: given.clock ?? systemClock,
    stores: given.stores ?? diskProjectStores,
    reads: given.reads ?? diskWorkspaceReads,
    hooks: given.hooks ?? adapters.hooks,
    reviewer: given.reviewer ?? adapters.reviewer,
    capture: given.capture ?? adapters.capture,
    sandboxes: given.sandboxes ?? adapters.sandboxes,
    queues: given.queues ?? fileJobQueues,
    renderer: given.renderer ?? adapters.renderer,
    env,
    secrets,
    outputs: given.outputs ?? diskOutputs,
    hosts: given.hosts ?? systemHosts(),
    registries: given.registries ?? adapters.registries,
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
