/**
 * `hooks` and `env_reset` jobs (L3.1): `studio hooks run` and `studio env reset` submitted by a client outside the CLI
 * (the MCP server) and executed by the jobs worker with the same engine code (hooks.ts) — trust `mcp`: the hook files'
 * `confirm: true` does not count, every shell hook needs a human approval and always counts as writing.
 *
 * Submit checks the names and the source, and for a real run takes the approvals (approvals.ts): a dry run executes
 * nothing and asks nobody — its result says which hooks a real run needs approved.
 */
import { ENV_NAME_RE, HOOKS_SOURCE_RE, JOB_INPUT_VERSION, newRunId, resolveEnvironment } from '@demo-studio/core';
import type { EnvResetJobInput, HookStep, HooksJobInput, JobApproval, WorkspaceConfig } from '@demo-studio/core';
import type { HookResult } from '@demo-studio/hooks';
import { approvalChecker, checkAgentTrust, preflightHooks, refusedError, takeApprovals } from '../approvals.js';
import type { Approver } from '../approvals.js';
import { EngineError, toEngineError } from '../errors.js';
import { createHookContext, selectHooks } from '../hooks.js';
import { openProjectBySlug } from '../projects.js';
import { checkWorkspaceProtection } from '../protected-hosts.js';
import { checkProjectSlug } from '../refs.js';
import type { SubmitContext } from './run-job.js';
import { preflightJournal } from './run-job.js';
import type { EnvResetJobResult, HookResultView, HooksJobResult, JobEventBody, JobRecord } from './types.js';

export interface HooksSubmitRequest {
  project: string;
  /** `reset`, `<scenario>:setup`, `<scenario>:teardown` or `hooks/<name>.yaml`. */
  source: string;
  env?: string;
  /** Default true: describe and security-check only. */
  dry?: boolean;
}

export interface EnvResetSubmitRequest {
  project: string;
  env?: string;
  dry?: boolean;
}

function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `studio hooks run` command a human runs for the same hooks. */
export function hooksCommandLine(cli: string, r: HooksSubmitRequest): string {
  return [cli, 'hooks', 'run', r.project, q(r.source), ...(r.env !== undefined ? ['--env', q(r.env)] : []), ...(r.dry ? ['--dry'] : [])].join(' ');
}

/** The `studio env reset` command a human runs for the same reset. */
export function envResetCommandLine(cli: string, r: EnvResetSubmitRequest): string {
  return [cli, 'env', 'reset', r.project, ...(r.env !== undefined ? ['--env', q(r.env)] : []), ...(r.dry ? ['--dry'] : [])].join(' ');
}

export function checkEnvName(env: string | undefined): void {
  if (env !== undefined && (!ENV_NAME_RE.test(env) || env.length > 100)) {
    throw new EngineError('invalid', `invalid environment "${env}": an environment name of project.yaml, never a path`);
  }
}

/** Check, take the approvals of a real run, and queue a `hooks` job. */
export async function submitHooksJob(ctx: SubmitContext, req: HooksSubmitRequest, approver?: Approver): Promise<{ job: JobRecord; journal_id: string }> {
  checkProjectSlug(req.project);
  checkEnvName(req.env);
  if (typeof req.source !== 'string' || !HOOKS_SOURCE_RE.test(req.source)) {
    throw new EngineError('invalid', `invalid hooks source "${String(req.source)}": reset, <scenario>:setup, <scenario>:teardown or hooks/<name>.yaml`);
  }
  const dry = req.dry !== false;
  const project = await openProjectBySlug(ctx.ws, req.project);
  let approvals: JobApproval[] = [];
  let label: string;
  try {
    const sel = await selectHooks(project, req.source, req.env, { projectFilesOnly: true });
    label = sel.label;
    if (sel.scenario) checkAgentTrust(project, sel.scenario, hooksCommandLine(ctx.cli, req));
    const env = req.env ?? sel.env;
    resolveEnvironment(project, env);
    await checkWorkspaceProtection(ctx.ws, project, env, hooksCommandLine(ctx.cli, req));
    if (!dry) {
      const fix = hooksCommandLine(ctx.cli, { ...req, dry: false });
      const pre = await preflightHooks(project, [{ phase: sel.phase, hooks: sel.hooks }], {
        ...(env !== undefined ? { env } : {}),
        ...(sel.vars ? { vars: sel.vars } : {}),
        ...(sel.scenario ? { scenario: sel.scenario } : {}),
        journalFile: preflightJournal(project),
      });
      if (pre.refused.length) throw refusedError(pre, fix);
      approvals = await takeApprovals({ what: `hooks ${req.source}`, project: project.slug, env: pre.env, items: pre.items, fix }, approver);
    }
  } catch (e) {
    throw toEngineError(e);
  }
  const input: HooksJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'hooks',
    project: project.slug,
    source: req.source,
    ...(req.env !== undefined ? { env: req.env } : {}),
    dry,
    journal_id: newRunId(`hooks-${label}`),
    submitted_by: ctx.client,
    ...(approvals.length ? { approvals } : {}),
  };
  return { job: await ctx.queue.enqueue(input), journal_id: input.journal_id };
}

/** Check, take the approvals of a real reset's hooks, and queue an `env_reset` job. */
export async function submitEnvResetJob(ctx: SubmitContext, req: EnvResetSubmitRequest, approver?: Approver): Promise<{ job: JobRecord; journal_id: string }> {
  checkProjectSlug(req.project);
  checkEnvName(req.env);
  const dry = req.dry !== false;
  const project = await openProjectBySlug(ctx.ws, req.project);
  let approvals: JobApproval[] = [];
  try {
    resolveEnvironment(project, req.env);
    await checkWorkspaceProtection(ctx.ws, project, req.env, envResetCommandLine(ctx.cli, req));
    const reset = project.config.reset ?? [];
    if (!dry && reset.length) {
      const fix = envResetCommandLine(ctx.cli, { ...req, dry: false });
      const pre = await preflightHooks(project, [{ phase: 'reset', hooks: reset }], { ...(req.env !== undefined ? { env: req.env } : {}), journalFile: preflightJournal(project) });
      if (pre.refused.length) throw refusedError(pre, fix);
      approvals = await takeApprovals({ what: `the environment reset of ${project.slug}`, project: project.slug, env: pre.env, items: pre.items, fix }, approver);
    }
  } catch (e) {
    throw toEngineError(e);
  }
  const input: EnvResetJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'env_reset',
    project: project.slug,
    ...(req.env !== undefined ? { env: req.env } : {}),
    dry,
    journal_id: newRunId('env-reset'),
    submitted_by: ctx.client,
    ...(approvals.length ? { approvals } : {}),
  };
  return { job: await ctx.queue.enqueue(input), journal_id: input.journal_id };
}

/** A hook result as a job shows it: what the product or a command returned stays under `untrusted`. */
export function hookResultView(r: HookResult, declared?: HookStep, describe?: (h: HookStep) => string): HookResultView {
  return {
    index: r.index,
    ...(r.name !== undefined ? { name: r.name } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
    phase: r.phase,
    status: r.status,
    ok: r.ok,
    ...(r.optional ? { optional: true as const } : {}),
    ms: r.ms,
    ...(r.journal_seq !== undefined ? { journal_seq: r.journal_seq } : {}),
    ...(declared && describe ? { declared: describe(declared) } : {}),
    ...(r.approval ? { approval: { reason: r.approval.reason } } : {}),
    untrusted: { description: r.description, ...(r.message !== undefined ? { message: r.message } : {}), ...(r.error !== undefined ? { error: r.error } : {}) },
  };
}

export interface HooksJobContext<I> {
  ws: WorkspaceConfig;
  cli: string;
  input: I;
  signal: AbortSignal;
  /** Job events (the worker appends them to events.jsonl). */
  event(e: JobEventBody): void;
}

const levelOf = (l: string): 'debug' | 'info' | 'warn' | 'error' => (l === 'error' || l === 'warn' || l === 'info' ? l : 'debug');

/** Execute a `hooks` job: the hooks of its source, with trust `mcp` and the approvals taken at submit. */
export async function executeHooksJob(ctx: HooksJobContext<HooksJobInput>): Promise<HooksJobResult> {
  const { input } = ctx;
  const hooks = await import('@demo-studio/hooks');
  const project = await openProjectBySlug(ctx.ws, input.project);
  const sel = await selectHooks(project, input.source, input.env, { projectFilesOnly: true });
  // Checked again here: the scenario may have changed since the submit (its hooks' approvals are bound to fingerprints).
  if (sel.scenario) checkAgentTrust(project, sel.scenario, hooksCommandLine(ctx.cli, { project: input.project, source: input.source, ...(input.env !== undefined ? { env: input.env } : {}), dry: input.dry }));
  await checkWorkspaceProtection(ctx.ws, project, input.env ?? sel.env);
  const { ctx: hctx, closeSessions } = await createHookContext(project, {
    env: input.env ?? sel.env,
    dry: input.dry,
    ...(sel.vars ? { vars: sel.vars } : {}),
    runId: input.journal_id,
    ...(sel.scenario ? { scenario: sel.scenario } : {}),
    trust: 'mcp',
    confirm: approvalChecker(input.approvals),
    log: (level, message) => ctx.event({ type: 'log', level: levelOf(level), message }),
    loginCommand: (p) => `${ctx.cli} login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`,
    signal: ctx.signal,
  });
  try {
    const journal = await hooks.Journal.open(hooks.standaloneJournalFile(project.dir, input.journal_id));
    const res = await hooks.runHooks(sel.hooks, hctx, { phase: sel.phase, journal });
    const pending = journal.pending().length;
    return {
      kind: 'hooks',
      source: input.source,
      phase: sel.phase,
      env: hctx.env.name,
      dry: input.dry,
      ok: res.ok,
      results: res.results.map((r) => hookResultView(r, r.phase === 'rollback' ? undefined : sel.hooks[r.index], hooks.describeHook)),
      ...(!input.dry ? { journal: { id: input.journal_id, pending } } : {}),
      ...(ctx.signal.aborted ? { interrupted: true as const } : {}),
    };
  } finally {
    await closeSessions();
  }
}

/** Execute an `env_reset` job: every pending rollback, then the project's reset hooks (trust `mcp`, approvals). */
export async function executeEnvResetJob(ctx: HooksJobContext<EnvResetJobInput>): Promise<EnvResetJobResult> {
  const { input } = ctx;
  const hooks = await import('@demo-studio/hooks');
  const project = await openProjectBySlug(ctx.ws, input.project);
  await checkWorkspaceProtection(ctx.ws, project, input.env);
  const { ctx: hctx, closeSessions } = await createHookContext(project, {
    env: input.env,
    dry: input.dry,
    runId: input.journal_id,
    trust: 'mcp',
    confirm: approvalChecker(input.approvals),
    log: (level, message) => ctx.event({ type: 'log', level: levelOf(level), message }),
    loginCommand: (p) => `${ctx.cli} login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`,
    signal: ctx.signal,
  });
  try {
    const outcomes = await hooks.rollbackPendingJournals(project.dir, hctx);
    const rollbacks = outcomes.map((o) => ({
      journal: o.file.replace(/^.*[\\/]runs[\\/]([^\\/]+)[\\/][^\\/]+$/, '$1').replace(/^.*[\\/]([^\\/]+)\.json$/, '$1'),
      results: o.results.map((r) => hookResultView(r)),
      ...(o.error ? { untrusted: { error: o.error } } : {}),
    }));
    let ok = outcomes.every((o) => !o.error && o.results.every((r) => r.ok));
    const resetHooks = project.config.reset ?? [];
    let reset: HookResultView[] | null = null;
    if (resetHooks.length && !ctx.signal.aborted) {
      const journal = await hooks.Journal.open(hooks.standaloneJournalFile(project.dir, input.journal_id));
      const res = await hooks.runHooks(resetHooks, hctx, { phase: 'reset', journal });
      reset = res.results.map((r) => hookResultView(r, resetHooks[r.index], hooks.describeHook));
      ok &&= res.ok;
    }
    return {
      kind: 'env_reset',
      env: hctx.env.name,
      dry: input.dry,
      ok,
      rollbacks,
      reset,
      ...(ctx.signal.aborted ? { interrupted: true as const } : {}),
    };
  } finally {
    await closeSessions();
  }
}
