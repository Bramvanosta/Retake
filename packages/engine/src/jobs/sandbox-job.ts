/**
 * `sandbox_up` / `sandbox_reset` jobs (L3.1, R-SBX-07): `retake sandbox up | reset` submitted by a client outside the
 * CLI (the MCP server) and run by the jobs worker with @retake/sandbox, as the CLI runs them. A sandbox is local
 * and disposable (core refuses one that is not), and a reset rewrites only the data the sandbox owns (checked by the
 * sandbox before it changes anything). Its seed steps run with trust `mcp`: a shell seed step needs a human approval,
 * taken at submit and bound to its fingerprint, like a hook.
 */
import { JOB_INPUT_VERSION, resolveEnvironment } from '@retake/core';
import type { JobApproval, LoadedProject, SandboxResetJobInput, SandboxUpJobInput, WorkspaceConfig } from '@retake/core';
import type { ResetResult, Sandbox, SandboxLog } from '@retake/sandbox';
import { approvalChecker, seedApprovalItems, takeApprovals } from '../approvals.js';
import type { Approver } from '../approvals.js';
import { toEngineError } from '../errors.js';
import { ENGINE_TRUST, callerOf } from '../caller.js';
import { hookRunRecorder } from '../store/journal.js';
import type { InterruptPort } from '../interrupts.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug } from '../refs.js';
import { checkEnvName } from './hooks-job.js';
import type { SubmitContext } from './run-job.js';
import type { JobEventBody, JobRecord, SandboxJobResult } from './types.js';

export type SandboxJobKind = 'sandbox_up' | 'sandbox_reset';

export interface SandboxSubmitRequest {
  project: string;
  /** The sandbox environment (default: the first of project.yaml `sandboxes`). */
  env?: string;
  /** sandbox_reset: run the seed even when a snapshot could be restored. */
  reseed?: boolean;
}

function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `retake sandbox up | reset` command a human runs for the same work. */
export function sandboxCommandLine(cli: string, kind: SandboxJobKind, r: SandboxSubmitRequest): string {
  return [cli, 'sandbox', kind === 'sandbox_up' ? 'up' : 'reset', r.project, ...(r.env !== undefined ? ['--env', q(r.env)] : []), ...(kind === 'sandbox_reset' && r.reseed ? ['--reseed'] : [])].join(' ');
}

async function openProjectSandbox(project: LoadedProject, env: string | undefined): Promise<Sandbox> {
  const { openSandbox } = await import('@retake/sandbox');
  try {
    return openSandbox(project, env);
  } catch (e) {
    throw toEngineError(e);
  }
}

/** Check, take the approvals of the seed's shell steps, and queue a `sandbox_up` or `sandbox_reset` job. */
export async function submitSandboxJob(
  ctx: SubmitContext,
  kind: SandboxJobKind,
  req: SandboxSubmitRequest,
  approver?: Approver,
): Promise<{ job: JobRecord; env: string }> {
  checkProjectSlug(req.project);
  checkEnvName(req.env);
  const project = await openProjectBySlug(ctx.ws, req.project);
  const sb = await openProjectSandbox(project, req.env);
  const items = await seedApprovalItems(project, sb.env);
  const approvals: JobApproval[] = await takeApprovals(
    {
      what: `${kind === 'sandbox_up' ? 'sandbox up' : 'the sandbox reset'} of ${project.slug} (${sb.env})`,
      project: project.slug,
      env: { name: sb.env, production: false, access: 'read-write' },
      items,
      fix: sandboxCommandLine(ctx.cli, kind, req),
    },
    approver,
    ctx.client,
  );
  const base = { project: project.slug, ...(req.env !== undefined ? { env: req.env } : {}), submitted_by: ctx.client, ...(approvals.length ? { approvals } : {}) };
  const input: SandboxUpJobInput | SandboxResetJobInput =
    kind === 'sandbox_up' ? { version: JOB_INPUT_VERSION, kind, ...base } : { version: JOB_INPUT_VERSION, kind, ...base, ...(req.reseed ? { reseed: true } : {}) };
  return { job: await ctx.queue.enqueue(input), env: sb.env };
}

export interface SandboxJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: SandboxUpJobInput | SandboxResetJobInput;
  signal: AbortSignal;
  interrupts: InterruptPort;
  event(e: JobEventBody): void;
}

function resetView(r: ResetResult): NonNullable<SandboxJobResult['reset']> {
  return {
    strategy: r.strategy,
    restored: r.restored,
    ms: r.ms,
    seed: r.seed,
    mailbox: r.mailbox,
    ...(r.snapshot ? { snapshot: r.snapshot } : {}),
    restarted: r.restarted,
    superseded: r.superseded,
  };
}

/**
 * Execute a sandbox job under the interrupt port (a cancel stops what the call started; a second signal kills it), the
 * seed with trust `mcp` and the approvals taken at submit. A SandboxError (busy, down, a refused seed…) fails the job.
 */
export async function executeSandboxJob(ctx: SandboxJobContext): Promise<SandboxJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  const sb = await openProjectSandbox(project, input.env);
  const log: SandboxLog = (level, message) => {
    if (level !== 'debug') ctx.event({ type: 'log', level, message });
  };
  const seedTrust = { trust: ENGINE_TRUST, confirm: approvalChecker(input.approvals) };
  const recordSeedRun = hookRunRecorder(project.root, callerOf(input.submitted_by), { project: project.slug });
  const stop = await ctx.interrupts.open({ message: 'interrupted: stopping what this command started…', onQuitSync: () => sb.killStartedSync() });
  const pages = resolveEnvironment(project, sb.env).pages;
  try {
    if (input.kind === 'sandbox_up') {
      const res = await sb.up({ signal: stop.signal, log, seedTrust, recordSeedRun });
      return {
        kind: 'sandbox_up',
        env: sb.env,
        provider: sb.kind,
        services: { started: res.started, kept: res.kept, changed: res.changed, ms: res.ms },
        reset: res.reset ? resetView(res.reset) : null,
        pages,
      };
    }
    const res = await sb.reset({ signal: stop.signal, log, seedTrust, recordSeedRun, ...(input.reseed ? { reseed: true } : {}) });
    return { kind: 'sandbox_reset', env: sb.env, provider: sb.kind, reset: resetView(res), pages };
  } finally {
    stop.dispose();
  }
}
