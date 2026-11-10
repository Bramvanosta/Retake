import type { AgentChannel, HookAccess, HookStep, HookTrust, LoadedProject, ResolvedEnvironment, WorkPolicy } from '@retake/core';

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

export interface JournalLike {
  pending(): unknown[];
  rollbackAll(ctx: HookContextLike): Promise<HookResultLike[]>;
}

export interface HooksModule {
  runHooks(
    hooks: HookStep[],
    ctx: HookContextLike,
    opts: { phase: 'setup' | 'teardown' | 'reset' | 'step'; journal: JournalLike; agentWritten?: boolean },
  ): Promise<{ ok: boolean; results: HookResultLike[] }>;
  Journal: { open(file: string): Promise<JournalLike> };
}

/** Loaded on demand: scenarios without hooks never touch the hooks package (or its pg dependency). */
export async function loadHooksModule(): Promise<HooksModule> {
  const specifier = '@retake/hooks';
  try {
    const mod = (await import(specifier)) as Partial<HooksModule>;
    if (typeof mod.runHooks !== 'function' || typeof mod.Journal?.open !== 'function') {
      throw new Error('it does not export runHooks and Journal');
    }
    return mod as HooksModule;
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
