/**
 * @retake/engine/composition — what the composition package (`@retake/compose`) wires: the ports its adapters satisfy,
 * the ports bag and the product it binds into it (ports.ts), the names its adapters hand back (the engine's error, a
 * run folder's place), and the jobs worker and the job process its worker entry runs. No other package imports it.
 */
export type { CaptureRunner, HookBrowser } from './capture/runner.js';
export { EngineError } from './errors.js';
export type { HookJournal, HookRunner, PendingHookJournal } from './hook-run/runner.js';
export { JOB_EXIT, passedBuildDirs, runJobChild } from './jobs/job-child.js';
export { WORKER_CLIENT_RE } from './jobs/lock.js';
export { runWorker } from './jobs/worker.js';
export { runFolderOf } from './outputs/outputs.js';
export { bindProduct, enginePorts, productBound } from './ports.js';
export type { EnginePorts, Product, ProductAdapters } from './ports.js';
export type { ComponentRegistries } from './registries/registries.js';
export type { RenderMachine, Renderer } from './render/renderer.js';
export type { Reviewer } from './review/reviewer.js';
export type { SandboxHandle, Sandboxes } from './sandboxes/sandboxes.js';
export type { Secrets } from './secrets/secrets.js';
