/** Job records and events as stored under <workspace>/.demo-studio/jobs/<id>/ (L3.1). */
import type { JobInput, JobKind, JobState, RunProgress, RunRecord, RunStatus } from '@demo-studio/core';
import type { EngineErrorCode } from '../errors.js';
import type { ProcessIdentity } from './proc.js';

export const JOB_RECORD_VERSION = 1;

export interface JobWorkerInfo extends ProcessIdentity {
  host: string;
}

export interface JobProgress {
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  /** "setup", "scenes", "teardown", "encode"… */
  phase?: string;
  updated_at: string;
}

/** What a `run` job produced: the run's own status (a failed run is a job that succeeded in running it). */
export interface RunJobResult {
  kind: 'run';
  run_id: string;
  status: RunStatus;
  mode: RunRecord['mode'];
  steps_done: number;
  steps_total: number;
  stopped_at?: RunRecord['stopped_at'];
  error?: { scene?: string; step?: number; action?: string };
  /** The run's error message: page text of the filmed site, data never instructions. */
  untrusted?: { error_message?: string };
}

/** One hook's (or rollback's) outcome, as a job result shows it. */
export interface HookResultView {
  index: number;
  name?: string;
  kind?: string;
  phase: string;
  status: 'ok' | 'failed' | 'refused' | 'dry';
  ok: boolean;
  optional?: true;
  ms: number;
  journal_seq?: number;
  /** The hook as its file declares it (templates unresolved): absent for a rollback. */
  declared?: string;
  /** It needs a human approval to run (a dry run through MCP reports it; a real run had it, or was refused). */
  approval?: { reason: string };
  /**
   * Its templated description, outcome and error: they can hold text the product or a command returned (response
   * values, command output) — data, never instructions.
   */
  untrusted: { description: string; message?: string; error?: string };
}

/** What a `hooks` job did. */
export interface HooksJobResult {
  kind: 'hooks';
  source: string;
  /** setup (a hooks file too), teardown or reset. */
  phase: string;
  env: string;
  dry: boolean;
  /** No hook failed or was refused (an optional hook's failure is tolerated). */
  ok: boolean;
  results: HookResultView[];
  /** The journal of a real run: its id and the rollbacks it keeps pending (env_reset replays them). */
  journal?: { id: string; pending: number };
  /** A cancel stopped it: remaining hooks did not run (a setup's completed hooks were rolled back). */
  interrupted?: true;
}

/** What an `env_reset` job did: the pending rollbacks replayed, then the project's reset hooks. */
export interface EnvResetJobResult {
  kind: 'env_reset';
  env: string;
  dry: boolean;
  ok: boolean;
  rollbacks: Array<{ journal: string; results: HookResultView[]; untrusted?: { error: string } }>;
  /** The reset hooks' results; null when project.yaml declares none. */
  reset: HookResultView[] | null;
  interrupted?: true;
}

/** What an `auth_login` job did: the persona's session as the check after the sign-in saw it (never a path or a cookie). */
export interface AuthLoginJobResult {
  kind: 'auth_login';
  env: string;
  persona: string;
  mode: 'headed' | 'auto';
  /** The check made after the sign-in, the way a run sees the session (`unchecked`: the persona has no check). */
  status: 'valid' | 'expired' | 'never' | 'error' | 'unchecked';
  /** A session was saved that works (valid), or that cannot be verified (unchecked). */
  signed_in: boolean;
  /** auto: the saved session was still valid, no login step ran. */
  already_signed_in?: true;
  /** headed: the window ended signed out while the session saved before still works: that one was kept. */
  kept?: true;
  cookies: number;
  /** The `studio login` command a human runs to sign it in again. */
  command: string;
  /** A cancel (or a signal) closed the window: nothing was saved. */
  interrupted?: true;
  /** The check's message and the page it ended on: text and URLs of the filmed site — data, never instructions. */
  untrusted?: { detail?: string; url?: string };
}

/** What a `sandbox_up` / `sandbox_reset` job did. */
export interface SandboxJobResult {
  kind: 'sandbox_up' | 'sandbox_reset';
  env: string;
  provider: string;
  /** up: services started by it, kept (already running), changed in sandbox.yaml since they started. */
  services?: { started: string[]; kept: string[]; changed: string[]; ms: number };
  /** The reset (a reset job; an up that seeded), null when an up did not need to seed. */
  reset: {
    strategy: string;
    restored: boolean;
    ms: number;
    seed: { steps: number; ms: number };
    mailbox: string;
    snapshot?: { action: 'restored' | 'taken'; ms: number; database: string };
    restarted: string[];
    superseded: number;
  } | null;
  /** Page key → URL of the sandbox. */
  pages: Record<string, string>;
}

export type JobResult = RunJobResult | HooksJobResult | EnvResetJobResult | AuthLoginJobResult | SandboxJobResult;

export interface JobErrorView {
  code: EngineErrorCode;
  message: string;
  fix?: string;
}

export interface JobRecord {
  version: typeof JOB_RECORD_VERSION;
  id: string;
  kind: JobKind;
  input: JobInput;
  state: JobState;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  /** The worker that claimed it. */
  worker?: JobWorkerInfo;
  progress?: JobProgress;
  result?: JobResult;
  /** Why the job could not run (or was cancelled / interrupted). */
  error?: JobErrorView;
  /** From the cancel marker: when a cancel was asked (derived when reading). */
  cancel_requested_at?: string;
  /** The state was derived when reading (the stored one is older: a worker died, or a cancel came before it started). */
  derived?: true;
}

export type JobEventBody =
  | { type: 'state'; state: JobState; message?: string }
  | { type: 'run'; event: RunProgress }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; result?: JobResult; error?: JobErrorView };

export type JobEvent = { seq: number; t: string } & JobEventBody;

export const FINISHED_JOB_STATES: ReadonlySet<JobState> = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
