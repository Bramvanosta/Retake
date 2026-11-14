/**
 * `sandbox_up` / `sandbox_reset` jobs (L3.1, R-SBX-07): `retake sandbox up | reset` submitted by a client outside the
 * CLI (the MCP server) and run by the jobs worker through the Sandboxes port (sandboxes/sandboxes.ts: the sandbox
 * package in the product), as the CLI runs them. A sandbox is local
 * and disposable (core refuses one that is not), and a reset rewrites only the data the sandbox owns (checked by the
 * sandbox before it changes anything). Its seed steps run with trust `mcp`: a shell seed step needs a human approval,
 * taken at submit and bound to its fingerprint, like a hook.
 */
import { resolveEnvironment } from '@retake/core/environment';
import { JOB_INPUT_VERSION } from './job-input.js';
import type { LoadedProject } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { JobApproval, SandboxResetJobInput, SandboxUpJobInput } from './job-input.js';
import type { ResetResult, SandboxLog } from '@retake/sandbox/types';
import { approvalChecker, seedApprovalItems, takeApprovals } from '../approvals.js';
import type { Approver } from '../approvals.js';
import { toEngineError } from '../errors.js';
import { ENGINE_TRUST, callerOf } from '../caller.js';
import { sandboxWork } from '../sandbox-work.js';
import type { InterruptPort } from '../interrupts.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug } from '../refs.js';
import { checkEnvName } from './hooks-job.js';
import type { SubmitContext } from './run-job.js';
import type { JobEventBody, JobRecord, SandboxJobResult } from './types.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { EnginePorts } from '../ports.js';
import type { SandboxHandle, Sandboxes } from '../sandboxes/sandboxes.js';

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
  return [cli, 'sandbox', kind === 'sandbox_up' ? 'up' : 'reset', r.project, ...(r.env !== undefined ? ['--env', q(r.env)] : []), ...(kind === 'sandbox_reset' && r.reseed ? ['--reseed'] : [])].join(
    ' ',
  );
}

async function openProjectSandbox(sandboxes: Sandboxes, project: LoadedProject, env: string | undefined, policy: WorkPolicy): Promise<SandboxHandle> {
  try {
    return await sandboxes.open(project, env, policy);
  } catch (e) {
    throw toEngineError(e);
  }
}

/** Check, take the approvals of the seed's shell steps, and queue a `sandbox_up` or `sandbox_reset` job. */
export async function submitSandboxJob(ctx: SubmitContext, kind: SandboxJobKind, req: SandboxSubmitRequest, approver?: Approver): Promise<{ job: JobRecord; env: string }> {
  checkProjectSlug(req.project);
  checkEnvName(req.env);
  const project = await openProjectBySlug(ctx.ws, req.project);
  const sb = await openProjectSandbox(ctx.sandboxes, project, req.env, ctx.ws.policy);
  const items = await seedApprovalItems(project, sb.env, ctx.hooks);
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
    ctx.clock,
  );
  const base = { project: project.slug, ...(req.env !== undefined ? { env: req.env } : {}), submitted_by: ctx.client, ...(approvals.length ? { approvals } : {}) };
  const input: SandboxUpJobInput | SandboxResetJobInput =
    kind === 'sandbox_up' ? { version: JOB_INPUT_VERSION, kind, ...base } : { version: JOB_INPUT_VERSION, kind, ...base, ...(req.reseed ? { reseed: true } : {}) };
  return { job: await ctx.queue.enqueue(input), env: sb.env };
}

/** What the job runs with; its ports (ports.ts EnginePorts) are its composition root's, handed on by the job runner. */
export interface SandboxJobContext extends EnginePorts {
  ws: OpenedWorkspace;
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
    ...(r.firebase_auth ? { firebase_auth: r.firebase_auth } : {}),
    ...(r.hooks.steps ? { hooks: r.hooks } : {}),
  };
}

/**
 * Execute a sandbox job through the sandbox use cases (sandbox-work.ts: under the interrupt port — a cancel stops what
 * the call started, a second signal kills it —, the seed run journalled as the submitter), the seed with trust `mcp`
 * and the approvals taken at submit. A SandboxError (busy, down, a refused seed…) fails the job.
 */
export async function executeSandboxJob(ctx: SandboxJobContext): Promise<SandboxJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  const sb = await openProjectSandbox(ctx.sandboxes, project, input.env, ctx.ws.policy);
  const log: SandboxLog = (level, message) => {
    if (level !== 'debug') ctx.event({ type: 'log', level, message });
  };
  const seedTrust = { trust: ENGINE_TRUST, confirm: approvalChecker(input.approvals) };
  const recordAs = { caller: callerOf(input.submitted_by), clock: ctx.clock };
  const pages = resolveEnvironment(project, sb.env).pages;
  if (input.kind === 'sandbox_up') {
    const res = await sandboxWork.up(project, sb, { trust: ENGINE_TRUST, interrupts: ctx.interrupts, log, seedTrust, recordAs });
    return {
      kind: 'sandbox_up',
      env: sb.env,
      provider: sb.kind,
      services: { started: res.started, kept: res.kept, changed: res.changed, ms: res.ms },
      reset: res.reset ? resetView(res.reset) : null,
      pages,
    };
  }
  const res = await sandboxWork.reset(project, sb, { trust: ENGINE_TRUST, interrupts: ctx.interrupts, log, seedTrust, recordAs, ...(input.reseed ? { reseed: true } : {}) });
  return { kind: 'sandbox_reset', env: sb.env, provider: sb.kind, reset: resetView(res), pages };
}
