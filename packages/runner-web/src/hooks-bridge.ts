import type { AgentChannel, HookAccess, HookPhase, HookStep, HookTrust, JournalEntry, LoadedProject, ResolvedEnvironment, WorkPolicy } from '@retake/core';
// Types only (erased): the runner never loads the hooks package; its types check the mirrors below.
import type { HookApprovalRequest, HookContext, HookResult, Journal, runHooks } from '@retake/hooks';

/** What a hook's approval is asked about (@retake/hooks HookApprovalRequest, structurally). */
export interface HookApprovalRequestLike {
  hook: HookStep;
  phase: string;
  index: number;
  env: string;
  fingerprint: string;
}

/** Approves a hook that needs a human (a destructive one without `confirm: true`; with trust `mcp`, any shell hook too). */
export type ConfirmHook = (description: string, reason: string, request: HookApprovalRequestLike) => boolean | Promise<boolean>;
import { RunnerError, errorMessage } from './errors.js';

/** The part of @retake/hooks the runner uses (docs/DESIGN.md §2). */
export interface HookContextLike {
  project: LoadedProject;
  /** What the run runs under (RunOptions.policy): a shell hook's environment and PATH under the agent policy. */
  policy: WorkPolicy;
  env: ResolvedEnvironment;
  vars: Record<string, string>;
  runId?: string;
  runDir?: string;
  dryRun?: boolean;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Runs a js hook through evalHookInPage (hook-page.ts): the guarded hook tab of the page key. */
  evalInPage?: (pageKey: string | undefined, code: string) => Promise<unknown>;
  saved: Record<string, unknown>;
  /** The run's access (L1.7): read-only refuses hooks that write. */
  access?: HookAccess;
  /** The run's cancel, given to the setup only: it stops a running shell command's process group and the next hooks. */
  signal?: AbortSignal;
  /** The process groups of the shell commands running now (a second signal kills them). */
  running?: Set<number>;
  /** Who stands behind the hook files' trust flags (L3.1): `mcp` for work submitted through the MCP server. */
  trust?: HookTrust;
  /** The channel trust-`mcp` work came through, for the wording of refusals (`studio`: the Studio). */
  via?: AgentChannel;
  /** Trust `mcp`: the scenario's own vars (the agent's): a project hook rendered with them counts as the agent's. */
  agentVars?: readonly string[];
  /** Approves the hooks that need a human (RunOptions.confirmHook). */
  confirmDestructive?: ConfirmHook;
  /** Reports each hook and rollback run (RunOptions.recordHookRun, with this run's id, or a rollback's journal's). */
  recordRun?: (result: HookResultLike, run?: string) => Promise<void>;
  /** `auth: {persona}` of an http hook (@retake/hooks HookContext.personaAuth). */
  personaAuth?: (persona: string, url: string) => Promise<{ authorization?: string; cookie?: string }>;
}

export interface HookResultLike {
  index?: number;
  kind?: string;
  phase?: string;
  ms?: number;
  name?: string;
  description?: string;
  ok?: boolean;
  status?: string;
  error?: string;
  message?: string;
  /** The hook was `optional: true` (its failure did not stop the phase). */
  optional?: boolean;
}

/** A capture's hooks journal (the engine's HookJournal, structurally; the hooks package's Journal): opened by the hook runner. */
export interface JournalLike {
  pending(): JournalEntry[];
  isSigned(entry: JournalEntry): boolean;
  rollbackAll(ctx: HookContextLike): Promise<HookResultLike[]>;
}

/**
 * What runs a capture's hooks (RunOptions.hookRunner; L7.12): the engine's HookRunner port, structurally — its
 * composition root's (the hooks package in the product, an in-memory one in the engine's tests). `load()` is awaited
 * when a run's hooks are opened, so that a hooks package that cannot be loaded is told apart from a hook that failed.
 */
export interface HookRunnerLike {
  load(): Promise<void>;
  // Method syntax on purpose: the journal `run` takes back is the handle this runner's `journals.open` gave out (the
  // engine's runner narrows it back to its own), so `run` cannot be contravariant in it. The engine checks its
  // HookRunner against this mirror strictly, the journal aside (capture/runner-web-capture.ts `HookRunnerChecks`).
  run(
    hooks: HookStep[],
    ctx: HookContextLike,
    opts: { phase: HookPhase; journal: JournalLike; agentWritten?: boolean },
  ): Promise<{ ok: boolean; results: HookResultLike[] }>;
  readonly journals: { open(file: string): Promise<JournalLike> };
}

/**
 * The mirrors above, checked against @retake/hooks by tsc (types only: the runner never loads the hooks package — its
 * caller hands the hook runner), so nothing else compares them. A context the runner builds is one the hooks read (a
 * HookContextLike without the work's `policy` compiled, and every shell hook of a run failed reading it), a journal's
 * rollbacks take it, what the hooks report and ask about reads as the mirrors say, and the package's runHooks and
 * Journal are a HookRunnerLike's run and journal (the engine's HookRunner is checked against it where the engine hands
 * it on: its capture runner's run).
 */
type Assignable<A extends B, B> = [A, B];
type HooksBridgeChecks = [
  Assignable<HookContextLike, HookContext>,
  Assignable<HookResult, HookResultLike>,
  Assignable<HookApprovalRequest, HookApprovalRequestLike>,
  Assignable<Journal['rollbackAll'], JournalLike['rollbackAll']>,
  Assignable<Journal, JournalLike>,
  Assignable<{ run: typeof runHooks }, Pick<HookRunnerLike, 'run'>>,
];

/** Why the run's hooks cannot run: none was handed, or the one handed could not load what runs them. */
export const NO_HOOK_RUNNER = 'this scenario has hooks (setup, teardown or hook steps) but no hook runner was handed to the runner (RunOptions.hookRunner)';

/** Load the handed hook runner: a failure is the runner's error, worded as when the runner loaded @retake/hooks itself. */
export async function loadHookRunner(runner: HookRunnerLike): Promise<void> {
  try {
    await runner.load();
  } catch (e) {
    throw new RunnerError(`this scenario has hooks (setup, teardown or hook steps) but @retake/hooks could not be loaded: ${errorMessage(e)}`);
  }
}

export function hookResultName(r: HookResultLike, i: number): string {
  return r.name ?? r.description ?? `hook ${i + 1}`;
}

export function hookResultFailed(r: HookResultLike): boolean {
  return r.ok === false || r.status === 'failed' || r.status === 'error';
}
