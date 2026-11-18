/**
 * The sandbox context's types (@retake/core/sandbox): a sandbox's shapes: the manifest, its services, seed steps,
 * accounts, mailboxes and databases, the loaded sandbox and a run's sandbox.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */
import type { ValidationIssue } from '../issues.js';
import type { DatabaseConfig, EnvironmentPageSpec, LoginPattern, MailboxConfig, PersonaConfig, SandboxProvider } from './environment.js';
import type { HookCommon, HttpHookSpec, ShellHookSpec, SqlHookSpec } from './hooks.js';

/** How a sandbox goes back to its seed before a take: run the seed again, or restore a database snapshot. */
export const SANDBOX_RESET_STRATEGIES = ['reseed', 'snapshot'] as const;

export type SandboxResetStrategy = (typeof SANDBOX_RESET_STRATEGIES)[number];

/** The version of sandbox.yaml this Retake reads. */
export const SANDBOX_VERSION = 1;

/**
 * How a sandbox tells a service is up: an http(s) GET (`path` on the service's `url`, or an absolute local `url`; ok on
 * 200–399 or `status`, optionally containing `text`) or, for a process service, a TCP connect to `tcp`.
 */
export interface SandboxHealthSpec {
  path?: string;
  url?: string;
  /** A port on this machine (process services only: a port Docker publishes always accepts a connection). */
  tcp?: number;
  status?: number | number[];
  text?: string;
  /** Seconds before the service counts as not healthy. */
  timeout_s?: number;
  /** Delay between two tries (ms). */
  interval_ms?: number;
}

/** `false`: no health check; a string: a path on the service's `url` (or an absolute local URL). */
export type SandboxHealth = false | string | SandboxHealthSpec;

/** One service of a sandbox: a compose service (docker-compose) or a process to start (process). */
export interface SandboxService {
  /** Base URL on this machine (loopback only): the default health check GETs it. */
  url?: string;
  /** Environment pages it serves: page key → URL, or {url, display} (the URL the video shows). */
  pages?: Record<string, EnvironmentPageSpec>;
  health?: SandboxHealth;
  /** process only: argv (a first word `node` runs the CLI's own Node) or a string run by `sh -c`. */
  command?: string | string[];
  /** process only: working directory, relative to sandbox.yaml (default its folder). */
  cwd?: string;
  /** process only: extra environment variables ({{env:VAR}} references are expanded). */
  env?: Record<string, string>;
  /** process only: seconds between SIGTERM and SIGKILL when it stops (default 10). */
  stop_timeout_s?: number;
}

/** A seed step that runs a command inside a compose service (`docker compose exec`): docker-compose sandboxes only. */
export interface ExecStepSpec {
  service: string;
  command: string | string[];
  env?: Record<string, string>;
  /** Seconds (default 300). */
  timeout_s?: number;
}

/** One step of a sandbox seed: an http, sql or shell hook (no js: there is no browser), or `exec`. */
export type SeedStep = HookCommon & ({ http: HttpHookSpec } | { sql: string | SqlHookSpec } | { shell: string | ShellHookSpec } | { exec: ExecStepSpec });

/** A demo account the seed creates, bound to the persona of the same name on the sandbox's environment. */
export interface SandboxAccount extends PersonaConfig {
  /** `{{account.username}}` in its login steps. */
  username?: string;
  /** `{{account.password}}` in its login steps: plain (every sandbox URL is local; redacted) or {{env:…}} / {{keychain:…}}. */
  password?: string;
}

/** The sandbox's test mailbox: the project mailbox's fields, and whether a reset empties it (default true). */
export interface SandboxMailbox extends MailboxConfig {
  clear?: boolean;
  /** The sandbox does not serve it, and it is the sandbox's alone: emptied at every reset all the same. */
  external?: boolean;
}

/** A database of sandbox.yaml. */
export interface SandboxDatabase extends DatabaseConfig {
  /** The sandbox does not start its server, and it is the sandbox's alone: sql seed steps may rewrite it. */
  external?: boolean;
}

/** sandbox.yaml (version 1): how to start a disposable copy of the product, seed it and reset it before a take. */
export interface SandboxManifest {
  version: typeof SANDBOX_VERSION;
  provider: SandboxProvider;
  /**
   * docker-compose only: the compose files (relative to sandbox.yaml; default [compose.yaml]), the project name, and the
   * env file docker compose reads its `${VAR}` values from (default `.env` next to the first compose file when there is
   * one; `false`: none).
   */
  compose?: { files?: string[]; project?: string; env_file?: string | false };
  services: Record<string, SandboxService>;
  /** The steps that build the demo data (paths relative to sandbox.yaml). */
  seed?: SeedStep[];
  reset?: {
    /** Default reseed. */
    strategy?: SandboxResetStrategy;
    /** snapshot: the Postgres database (a key of `databases`, default the first) snapshotted after seeding. */
    snapshot?: { database?: string };
    /** Services restarted after each reset (apps that do not survive a database swap). */
    restart?: string[];
    /**
     * Hotfix v0.2.5 (field point 21): a Firebase Auth emulator of the sandbox — emptied before each seed, its accounts
     * saved after it, put back at every reset (after `restart`).
     */
    firebase_auth?: { url: string; project: string };
    /** Hotfix v0.2.5: steps run at every reset once the data is back (after `restart` and `firebase_auth`). */
    hooks?: SeedStep[];
  };
  databases?: Record<string, SandboxDatabase>;
  mailbox?: SandboxMailbox;
  /** Sign-in pages of every account (auth.login_url of the sandbox's environment). */
  login_url?: LoginPattern | LoginPattern[];
  accounts?: Record<string, SandboxAccount>;
}

/** A sandbox as loadProject reads it (LoadedProject.sandboxes, keyed by its environment name). */
export interface LoadedSandbox {
  /** Its environment name (the key of project.yaml `sandboxes:`). */
  env: string;
  /** Absolute path of sandbox.yaml. */
  file: string;
  /** Its folder: every path of the manifest is relative to it. */
  dir: string;
  manifest: SandboxManifest;
  /** Warnings of sandbox.yaml. */
  issues: ValidationIssue[];
  /**
   * The compose override `retake project trust` wrote for a trusted import whose archive carried the sandbox's images,
   * with the sha256 its signed mark records and its text as read and checked: set by the engine's gate only (never read
   * from sandbox.yaml); the compose provider gives docker that text (`-f -`), only while it hashes to the sha256.
   */
  imagesOverride?: { file: string; sha256: string; text: string };
  /**
   * What its accounts' `{{compose_env:NAME}}` references read from the compose env file, by name (those names only):
   * secret values like `secrets`, never printed.
   */
  composeEnv?: Record<string, string>;
  /** The plain passwords of its accounts, by persona: registered as secret values when one signs in (never printed). */
  secrets: Record<string, string[]>;
  /** Its state file (layout sandboxPaths), set by the loader: its personas read `accounts_at` there (R-SBX-11). */
  stateFile?: string;
}

/** The sandbox of a run (run.json and timeline.json `environment.sandbox`): the reset made before the take, if any. */
export interface RunSandbox {
  /** The sandbox's environment. */
  name: string;
  provider: SandboxProvider;
  /** Absent: no reset before this take (`--env <sandbox>` without `--sandbox`). */
  strategy?: SandboxResetStrategy;
  /** A snapshot was restored (rather than the seed run again). */
  restored?: boolean;
  reset_ms?: number;
  /** The seed's hash (12 characters). */
  seed_hash?: string;
  /** When the reset finished (ISO). */
  at?: string;
}
