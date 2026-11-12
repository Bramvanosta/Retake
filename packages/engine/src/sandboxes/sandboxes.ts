/**
 * The Sandboxes port (L7.25, U14; the target architecture's "SandboxProvider" — named for what it hands out, since
 * core's `SandboxProvider` is a provider's kind, `process` or `docker-compose`): what starts, seeds, resets, stops and
 * reads a project's sandboxes for the engine — the MCP `sandbox_status` answer, the `sandbox_up` / `sandbox_reset`
 * jobs, a run's take on a sandbox (`--sandbox`) and the check of a sandbox environment without it — and what the CLI's
 * `retake sandbox …` commands will need (U8c: the scaffold, the capabilities its usage errors read, the progress of a
 * call, the logs followed, the two-stage Ctrl-C's synchronous kill). The composition roots choose it (ports.ts
 * `EnginePorts.sandboxes`): the sandbox package with its process and docker-compose providers (`packageSandboxes()`),
 * or an in-memory one in tests (memory-sandboxes.ts). One contract suite holds them (engine
 * test/sandbox-contract.ts).
 *
 * Its vocabulary is the sandbox package's own, named through its type-only domain entry `@retake/sandbox/types`, and
 * core's (a sandbox's paths and error class, the lock record of core's io side). A handle is one sandbox, as
 * `openSandbox` gives it: every refusal is a SandboxError (core), with its code and its words.
 */
import type { LoadedProject, LoadedSandbox, SandboxPaths, SandboxResetStrategy, WorkPolicy } from '@retake/core';
import type { LockRecord } from '@retake/core/io';
import type { DownResult, InitSandboxOptions, InitSandboxResult, ProviderCapabilities, ResetResult, SandboxCallOptions, SandboxLogs, SandboxStatus, SandboxUpResult, Take } from '@retake/sandbox/types';

/** One sandbox of a project: the sandbox package's Sandbox, structurally. */
export interface SandboxHandle {
  /** Its environment name (project.yaml `sandboxes:`). */
  readonly env: string;
  /** process | docker-compose. */
  readonly kind: LoadedSandbox['manifest']['provider'];
  /** How a reset gets back to the seed (reseed, or snapshot). */
  readonly strategy: SandboxResetStrategy;
  /** Its state, lock, journals and logs (core sandboxPaths). */
  readonly paths: SandboxPaths;
  /** What its provider can do beyond what every provider does: exec steps, its own logs and their follow, snapshots, `--build`, `--volumes`. */
  readonly capabilities: Readonly<ProviderCapabilities>;
  /** Start what is not running, wait until healthy, and seed when needed unless `seed: 'never'` (holds the take lock). */
  up(o?: SandboxCallOptions & { seed?: 'auto' | 'never'; build?: boolean }): Promise<SandboxUpResult>;
  /** Stop every service; the data goes with them unless the provider keeps it (`volumes` removes it too). */
  down(o?: SandboxCallOptions & { volumes?: boolean }): Promise<DownResult>;
  /** Back to the seed; the sandbox must be up (SandboxError `down` otherwise). */
  reset(o?: SandboxCallOptions & { by?: string; reseed?: boolean }): Promise<ResetResult>;
  /** How it is now: no lock taken, nothing written. */
  status(o?: SandboxCallOptions): Promise<SandboxStatus>;
  /** A run on its environment without `--sandbox`: it must be up (SandboxError `down`); a live take lock is returned. */
  checkRunning(o?: SandboxCallOptions): Promise<{ lock?: LockRecord }>;
  /** The last lines of the services' logs (all, or one: an unknown service is a SandboxError). */
  logs(o?: { service?: string; lines?: number }): Promise<SandboxLogs[]>;
  /** Follow the logs until `signal` aborts (capability `followLogs`; otherwise a SandboxError naming the log files). */
  followLogs(o: { service?: string; lines?: number; signal: AbortSignal; write: (line: string) => void }): Promise<void>;
  /** Before a take: the take lock, up (without seeding), health, reset; held until the take's `release()`. */
  prepareTake(o?: SandboxCallOptions & { command?: string }): Promise<Take>;
  /** A second signal: kill what the current call started, synchronously. */
  killStartedSync(): void;
}

export interface Sandboxes {
  /**
   * The sandbox of environment `env` (default: the first project.yaml declares), for work under `policy`. Rejects with
   * a SandboxError when the project has no sandbox or `env` is not one of them (the package's words).
   */
  open(project: LoadedProject, env: string | undefined, policy: WorkPolicy): Promise<SandboxHandle>;
  /** Scaffold a docker-compose sandbox in the project (its files written through `o.write`, the project store). */
  init(project: LoadedProject, o: InitSandboxOptions): Promise<InitSandboxResult>;
}
