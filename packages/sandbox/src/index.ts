/**
 * @retake/sandbox: start, seed, reset and stop a project's sandboxes — disposable, local copies of the
 * product declared by a sandbox.yaml (core `sandbox.ts` reads them into environments). docs/DESIGN.md §3.8.
 * Its vocabulary as types only: `@retake/sandbox/types`. Its OS utilities (process table and groups,
 * the lock file, who listens on a port), its error class and a sandbox's paths are core's (`@retake/core/io`,
 * `@retake/core`): re-exported here unchanged.
 */
export type * from './types-entry.js';
export { Sandbox, openSandbox } from './sandbox.js';
export { SandboxError } from './errors.js';
export { dockerEnv, dockerPlaces, findDocker } from './docker.js';
export { TakeLock } from './lock.js';
export { sandboxPaths } from './paths.js';
export { probePort } from './ports.js';
export type { ProcInfo } from './proc.js';
export { initSandbox } from './init.js';
