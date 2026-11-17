/**
 * What a sandbox provider does: start the services (and wait until they are healthy), stop them, say how they are,
 * restart one, run an `exec` seed step (docker-compose), read their logs, and say whether a port is the sandbox's own
 * (a snapshot's database). The Sandbox (sandbox.ts) holds the take lock, decides when to seed, runs the
 * seed and the reset, and keeps the state file; a provider reads and updates `ctx.state` and calls `ctx.save()` as soon
 * as something it started exists.
 */
import type { ExecStepSpec, LoadedSandbox } from '@retake/core/sandbox';
import type { LoadedProject } from '@retake/core/project';
import type { SandboxProvider } from '@retake/core/environment';
import type { WorkPolicy } from '@retake/core/policy';
import type { HookApprovalRequest, HookTrust, SandboxHookRunner } from '@retake/core/hooks';
import type { SandboxPaths } from './paths.js';
import type { SandboxState } from './state.js';

export type SandboxLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SandboxLog = (level: SandboxLogLevel, message: string) => void;

/**
 * Who stands behind a call's seed steps. Trust `mcp` (a job submitted through the MCP server, whose agent may
 * have edited the files): every shell seed step needs a human approval, bound to its fingerprint (phase `seed`, its
 * position among all the seed steps, the sandbox's environment); `confirm` checks it. Default: trust `author`.
 */
export interface SeedTrust {
  trust: HookTrust;
  confirm?: (description: string, reason: string, request: HookApprovalRequest) => boolean | Promise<boolean>;
}

/**
 * One seed step run as it is reported: a hook step's result (hooks HookResult), or an `exec` step's (kind `exec`; its
 * command is never part of it). `index`: the step's position among all the seed's steps (a rollback: its journal seq).
 */
export interface SeedRunResult {
  index: number;
  name?: string;
  kind?: string;
  phase: string;
  status: string;
  optional?: boolean;
  ms?: number;
}

/** What reports each seed step run (hooks HookContext.recordRun, and each exec step). */
export type SeedRecorder = (result: SeedRunResult, run?: string) => Promise<void>;

/**
 * What a sandbox call is doing, for whoever shows it (the CLI's live line and its summary — hotfix v0.2.2): `step`
 * starts a named step (the one before is over), `note` is one line of what the current step is doing (a line of
 * `docker compose`, of a seed command — already masked).
 */
export interface SandboxProgress {
  step(name: string, detail?: string): void;
  note(text: string): void;
}

export interface ProviderContext {
  project: LoadedProject;
  /** What the work runs under (core WorkPolicy): the programs, the environment of the services and the seed's hooks. */
  policy: WorkPolicy;
  sandbox: LoadedSandbox;
  paths: SandboxPaths;
  state: SandboxState;
  /** Write `state` (synchronously, atomically). */
  save(): void;
  log: SandboxLog;
  progress?: SandboxProgress;
  signal?: AbortSignal;
  seedTrust?: SeedTrust;
  recordSeedRun?: SeedRecorder;
  /**
   * What the sandbox's secret references (sandbox.yaml's service env, exec steps' env, a Postgres URL, the mailbox
   * headers) are resolved with: its opener's (the engine's Secrets port). Required: never read on the way.
   */
  resolveSecret: SecretRefResolver;
  /**
   * What runs the seed steps and reset hooks, fingerprints their approvals and marks the rollbacks a reset makes stale:
   * its opener's (the engine's HookRunner port). The sandbox runs no hook itself.
   */
  hookRunner: SandboxHookRunner;
}

/** Resolves one secret reference (`env:VAR`, `keychain:service/account`) to its value. */
export type SecretRefResolver = (ref: string) => Promise<string>;

export interface UpResult {
  /** Services started by this call (each one healthy). */
  started: string[];
  /** Services that were already running (health checked again). */
  kept: string[];
  /** Kept services whose definition changed in sandbox.yaml since they started (not restarted: down, then up). */
  changed: string[];
  ms: number;
}

/** What `up` may do besides starting (docker-compose: `--build`). */
export interface UpOptions {
  /** Build the images of the services first (docker-compose `up --build`). */
  build?: boolean;
}

/** docker-compose: `--volumes` removes the named volumes too (the data, the snapshot). */
export interface DownOptions {
  volumes?: boolean;
}

export interface DownResult {
  /** Services stopped. */
  stopped: string[];
  /** The sandbox's data is gone with them (in-memory, or volumes removed): the next up seeds again. */
  dataGone: boolean;
  /**
   * Sandbox.down: its seed, reset and snapshot records were forgotten although no volume went — the database's data
   * was in memory (`tmpfs`), in its container's own layer (`container`) or in an anonymous volume (`volume`), or the
   * person asked (`asked`, `--forget`).
   */
  forgotten?: 'tmpfs' | 'container' | 'volume' | 'asked';
}

export interface ServiceStatus {
  name: string;
  /** running: a process / container of ours; starting: not healthy once yet; stopped: nothing of it runs. */
  state: 'running' | 'starting' | 'stopped';
  pid?: number;
  /** docker-compose: its container. */
  container?: string;
  /** docker-compose: docker's own status ("Up 5 minutes (healthy)"). */
  docker?: string;
  started_at?: string;
  command?: string;
  /** Health now (one try of each check): null when not running, else the first failure or 'ok'. */
  health?: string | null;
  healthy?: boolean;
  /** Its definition changed in sandbox.yaml since it started. */
  changed?: boolean;
  /** A service of the state that sandbox.yaml no longer declares (the next up or down stops it). */
  orphan?: boolean;
  note?: string;
}

/** What a port must belong to the sandbox for, in messages: "the mailbox http://localhost:4525", and why it must. */
export interface OwnerUse {
  what: string;
  /** Why it must be the sandbox's own, and what to do instead. */
  why: string;
}

/**
 * Where a database service keeps its data: a volume `down --volumes` removes (named by the compose project, or
 * anonymous), a folder of this machine (a bind mount) or an external volume — both left by `down --volumes` —, memory
 * (a tmpfs) or the container's own layer — both gone with every down —, or not known (nothing read over its data
 * folder, or the service not running).
 */
export interface DataStorage {
  kind: 'volume' | 'bind' | 'external' | 'tmpfs' | 'container' | 'unknown';
  /** The folder or the volume's name (bind, external, a named volume), the data folder (tmpfs, container). */
  where?: string;
}

/** The data goes with the container itself (a tmpfs, its own layer): every down takes it, with or without --volumes. */
export function goesWithContainer(s: DataStorage | null | undefined): boolean {
  return s?.kind === 'tmpfs' || s?.kind === 'container';
}

/**
 * Every down loses the data, `--volumes` or not: a tmpfs, the container's own layer, or an anonymous volume (compose
 * leaves it behind when it removes the container, and the next up makes a new one).
 */
export function goesWithDown(s: DataStorage | null | undefined): boolean {
  return goesWithContainer(s) || (s?.kind === 'volume' && !s.where);
}

/** The services around a sandbox's database (capability `snapshots`): what a restore restarts, and where the data lives. */
export interface ServicesAround {
  /** The compose services running now, in the compose files' order. */
  running: string[];
  /** service → the services it depends on (`depends_on`). */
  depends: Record<string, string[]>;
  /** Where the database's service keeps its data. */
  storage: DataStorage;
}

export interface ServiceLogFile {
  service: string;
  file: string;
}

/** Logs a provider reads itself (docker-compose: `docker compose logs`). */
export interface ProviderLogs {
  service: string;
  /** Where they come from, for the header ("docker compose -p … logs app"). */
  source: string;
  text: string;
}

/**
 * What a provider can do beyond the methods every provider has. Every method of `Provider` exists on every provider; a
 * capability that is false means its method refuses (exec, logs, followLogs, publishedBy: a SandboxError) or gives the
 * neutral answer (address: undefined, hashInputs: none), and the Sandbox tests the capability before it calls, in its
 * own words. A contract suite holds both providers to it (packages/sandbox/test/provider-capabilities.test.ts; the
 * engine's sandboxes contract, through the Sandbox).
 */
export interface ProviderCapabilities {
  /** `exec` seed and reset steps (a command in a service's container). */
  exec: boolean;
  /** The provider reads the services' logs itself (`logs`); otherwise they are files (`logFiles`). */
  logs: boolean;
  /** Follow the logs until a signal aborts (`followLogs`). */
  followLogs: boolean;
  /** Snapshot resets: the database's port is published by a service of the sandbox (`publishedBy`). */
  snapshots: boolean;
  /** Its own address for a port its services publish (`address`: 127.0.0.1 or ::1, never `localhost`). */
  address: boolean;
  /** More inputs of the seed hash (`hashInputs`: the services' image ids). */
  hashInputs: boolean;
  /** `up --build`: the images built first. */
  build: boolean;
  /** `down --volumes`: the named volumes (the data, the snapshot) removed too; without it the data stays. */
  volumes: boolean;
}

/** The process provider's capabilities: its services are programs of this machine, their logs files. */
export const PROCESS_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  exec: false,
  logs: false,
  followLogs: false,
  snapshots: false,
  address: false,
  hashInputs: false,
  build: false,
  volumes: false,
});
/** The docker-compose provider's capabilities: all of them. */
export const COMPOSE_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  exec: true,
  logs: true,
  followLogs: true,
  snapshots: true,
  address: true,
  hashInputs: true,
  build: true,
  volumes: true,
});

export interface Provider {
  readonly kind: SandboxProvider;
  /** What it can do beyond the methods every provider answers (ProviderCapabilities). */
  readonly capabilities: Readonly<ProviderCapabilities>;
  /** Start what is not running (declaration order), wait until every service is healthy and serves its own ports. */
  up(ctx: ProviderContext, opts?: UpOptions): Promise<UpResult>;
  /** Stop every service of the state (reverse order), sandbox.yaml's or not. */
  down(ctx: ProviderContext, opts?: DownOptions): Promise<DownResult>;
  /** Each service, as it is now (no lock, no waiting, nothing written). */
  status(ctx: ProviderContext): Promise<ServiceStatus[]>;
  /** Stop then start one service, healthy again (reset.restart). */
  restart(ctx: ProviderContext, service: string): Promise<void>;
  /** An `exec` seed step (capability `exec`; a process sandbox has none: validation refuses them). */
  exec(ctx: ProviderContext, step: ExecStepSpec): Promise<string>;
  /** The services this provider instance started (this call): stopped when the call fails or is interrupted. */
  stopStarted(ctx: ProviderContext): Promise<string[]>;
  /** The same, synchronously, with SIGKILL (a second Ctrl-C: nothing can be awaited). */
  killStartedSync(ctx: ProviderContext): void;
  /** Log files of the services (the process provider's; none when the provider reads its logs itself). */
  logFiles(ctx: ProviderContext): ServiceLogFile[];
  /** The last `lines` lines of each service's logs, read by the provider (capability `logs`). */
  logs(ctx: ProviderContext, opts: { service?: string; lines: number }): Promise<ProviderLogs[]>;
  /** Follow the logs until `signal` aborts (capability `followLogs`). */
  followLogs(ctx: ProviderContext, opts: { service?: string; lines: number; signal: AbortSignal; write: (line: string) => void }): Promise<void>;
  /**
   * The service of the sandbox publishing this host port, which nothing else listens on (a snapshot's database must be
   * the sandbox's own). Throws SandboxError otherwise; capability `snapshots` (a provider without it cannot take
   * snapshots).
   */
  publishedBy(ctx: ProviderContext, port: number, use?: OwnerUse): Promise<string>;
  /**
   * The service of the sandbox serving this host port, which nothing else listens on: what a reset empties or a seed
   * rewrites (the mailbox, a seed's database) must be the sandbox's own. Throws SandboxError otherwise.
   */
  servedBy(ctx: ProviderContext, port: number, use: OwnerUse): Promise<string>;
  /**
   * Where to connect to a port the sandbox's own services publish (capability `address`; docker-compose: the address
   * Docker publishes it on, 127.0.0.1 or ::1 — never `localhost`, which may reach another container publishing the
   * same port on ::1); undefined when the URL's own host is used (always, without the capability).
   */
  address(ctx: ProviderContext, port: number): Promise<string | undefined>;
  /** More inputs of the seed hash (capability `hashInputs`; docker-compose: the services' image ids — a rebuilt app makes the seed stale); none without it. */
  hashInputs(ctx: ProviderContext): Promise<string[]>;
  /**
   * The running services, their dependencies, and where database service `database` keeps its data (capability
   * `snapshots`: a restore of an outdated snapshot restarts the others; a refusal says what `down --volumes` removes).
   */
  servicesAround(ctx: ProviderContext, database: string): Promise<ServicesAround>;
}
