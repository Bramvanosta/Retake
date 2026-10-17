/**
 * `run` jobs (L3.1): a dry run or a capture submitted by a client outside the CLI (the MCP server) and executed by the
 * jobs worker with the same `executeRun` as `studio run`.
 *
 * Submit checks everything that can be checked without running anything (names, the scenario against its
 * environment, the sandbox pick, the hooks a human must approve), hashes the scenario's bytes, reserves the run id
 * (runs/<id>/run.json `queued`) and queues the input. The worker re-checks the hash, runs, and finalises a reserved
 * run.json that an early exit left `queued` (cancelled before it started, a refused or failed start).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FORMAT_VERSIONS,
  JOB_INPUT_VERSION,
  listSteps,
  loginCommand as coreLoginCommand,
  reserveRunId,
  resolveEnvironment,
  resolveStepRef,
  writeJson,
} from '@demo-studio/core';
import type { JobApproval, JobClient, LoadedProject, RunJobInput, RunProgress, RunRecord, RunStatus, WorkspaceConfig } from '@demo-studio/core';
import { approvalChecker, checkAgentTrust, preflightHooks, refusedError, seedApprovalItems, takeApprovals } from '../approvals.js';
import type { Approver } from '../approvals.js';
import { EngineError, toEngineError } from '../errors.js';
import { executeRun, prepareRun } from '../execute-run.js';
import type { PreparedRun, RunPorts } from '../execute-run.js';
import type { InterruptPort } from '../interrupts.js';
import { openProjectBySlug } from '../projects.js';
import { checkWorkspaceProtection } from '../protected-hosts.js';
import { checkProjectSlug, checkScenarioName } from '../refs.js';
import { sha256Hex } from '../storage.js';
import type { FileJobQueue } from './queue.js';
import type { JobEventBody, JobProgress, JobRecord, RunJobResult } from './types.js';

export interface RunSubmitRequest {
  project: string;
  scenario: string;
  mode: 'capture' | 'dry';
  env?: string;
  until?: string;
  hooks?: 'run' | 'skip';
  sandbox?: boolean;
}

export interface SubmitContext {
  ws: WorkspaceConfig;
  queue: FileJobQueue;
  /** "studio -C <root>": how the commands a human is asked to run start. */
  cli: string;
  client: JobClient;
}

/** Quote a word for a shell command line when it needs it. */
function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `studio run` command a human runs for the same run. */
export function runCommandLine(cli: string, r: RunSubmitRequest): string {
  const parts = [cli, 'run', r.project, r.scenario];
  if (r.env !== undefined) parts.push('--env', q(r.env));
  if (r.mode === 'dry') parts.push('--dry');
  if (r.until !== undefined) parts.push('--until', q(r.until));
  if (r.hooks !== undefined && (r.mode === 'dry' || r.hooks === 'skip')) parts.push('--hooks', r.hooks);
  if (r.sandbox) parts.push('--sandbox');
  return parts.join(' ');
}

/** A journal file a preflight opens and never writes (a dry run journals nothing). */
export function preflightJournal(project: LoadedProject): string {
  return join(project.dir, '.demo-studio', 'journals', `preflight-${randomUUID()}.json`);
}

/** Steps the run will execute (all, or up to `until`), as the runner counts them. */
function stepsTotal(prepared: PreparedRun, until: string | undefined): number {
  const sc = prepared.scenario.scenario;
  const listed = listSteps(sc);
  const u = until !== undefined ? resolveStepRef(sc, until) : null;
  return u ? listed.filter((s) => s.sceneIndex < u.sceneIndex || (s.sceneIndex === u.sceneIndex && s.step.index <= u.stepIndex)).length : listed.length;
}

async function runRecordOf(dir: string): Promise<RunRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunRecord;
  } catch {
    return undefined;
  }
}

/**
 * Close a reserved run whose run.json an early exit left `queued` (or a runner that threw left `running`): it gets its
 * final status and the reason. A run the runner finished is never touched.
 */
export async function finaliseReservedRun(dir: string, status: Extract<RunStatus, 'failed' | 'cancelled'>, message: string): Promise<void> {
  const rec = await runRecordOf(dir);
  if (!rec || (rec.status !== 'queued' && rec.status !== 'running')) return;
  await writeJson(join(dir, 'run.json'), { ...rec, status, finished_at: new Date().toISOString(), error: { ...(rec.error ?? {}), message } });
}

/** Check, reserve the run id and queue a `run` job. */
export async function submitRunJob(ctx: SubmitContext, req: RunSubmitRequest, approver?: Approver): Promise<{ job: JobRecord; run_id: string; dir: string; warnings: string[] }> {
  checkProjectSlug(req.project);
  checkScenarioName(req.scenario);
  const project = await openProjectBySlug(ctx.ws, req.project);
  let prepared: PreparedRun;
  try {
    prepared = await prepareRun(ctx.ws, project, req.scenario, { dry: req.mode === 'dry', until: req.until, hooks: req.hooks, env: req.env, sandbox: req.sandbox });
  } catch (e) {
    throw toEngineError(e);
  }
  const sc = prepared.scenario.scenario;
  const env = resolveEnvironment(project, prepared.sandboxEnv ?? req.env ?? sc.env);
  const hooksMode = req.hooks ?? (req.mode === 'capture' ? 'run' : 'skip');
  // The hooks this run executes, checked with trust `mcp` (R-MCP-35): what a safety rule refuses fails the submit; what
  // needs a human is asked through the client's approver, else refused with the `studio` command a human runs.
  let approvals: JobApproval[] = [];
  const fix = runCommandLine(ctx.cli, { ...req, hooks: hooksMode });
  checkAgentTrust(project, sc, fix);
  await checkWorkspaceProtection(ctx.ws, project, env.name, fix);
  const what = `${req.mode === 'dry' ? 'the dry run' : 'the capture'} of scenario ${prepared.scenario.name}`;
  // `sandbox`: the reset before the take may run the seed — its shell steps need a human too.
  const seedItems = prepared.sandboxEnv ? await seedApprovalItems(project, prepared.sandboxEnv) : [];
  if (hooksMode === 'run' && ((sc.setup?.length ?? 0) > 0 || (sc.teardown?.length ?? 0) > 0)) {
    const pre = await preflightHooks(
      project,
      [
        { phase: 'setup', hooks: sc.setup ?? [] },
        { phase: 'teardown', hooks: sc.teardown ?? [] },
      ],
      { env: env.name, ...(sc.vars ? { vars: sc.vars } : {}), scenario: sc, journalFile: preflightJournal(project) },
    ).catch((e: unknown) => {
      throw toEngineError(e);
    });
    if (pre.refused.length) throw refusedError(pre, fix);
    approvals = await takeApprovals({ what, project: project.slug, env: pre.env, items: [...seedItems, ...pre.items], fix }, approver);
  } else if (seedItems.length) {
    approvals = await takeApprovals({ what, project: project.slug, env: { name: env.name, production: false, access: 'read-write' }, items: seedItems, fix }, approver);
  }
  const sha = sha256Hex(await readFile(prepared.scenario.file));
  const { id: runId, dir } = await reserveRunId(join(project.dir, 'runs'), prepared.scenario.name);
  const queued: RunRecord = {
    version: FORMAT_VERSIONS.run,
    id: runId,
    project: project.slug,
    scenario: prepared.scenario.name,
    mode: req.mode,
    status: 'queued',
    started_at: new Date().toISOString(),
    dir,
    env: env.name,
    options: { hooks: hooksMode, headed: false, ...(req.until !== undefined ? { until: req.until } : {}) },
    steps_total: stepsTotal(prepared, req.until),
    steps_done: 0,
    screenshots: [],
    hooks: { setup: 'none', teardown: 'none' },
    warnings: [],
  };
  await writeJson(join(dir, 'run.json'), queued);
  const input: RunJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'run',
    project: project.slug,
    scenario: prepared.scenario.name,
    scenario_sha256: sha,
    mode: req.mode,
    ...(req.env !== undefined ? { env: req.env } : {}),
    ...(req.until !== undefined ? { until: req.until } : {}),
    ...(req.hooks !== undefined ? { hooks: req.hooks } : {}),
    ...(req.sandbox ? { sandbox: true } : {}),
    run_id: runId,
    submitted_by: ctx.client,
    ...(approvals.length ? { approvals } : {}),
  };
  let job: JobRecord;
  try {
    job = await ctx.queue.enqueue(input);
  } catch (e) {
    await finaliseReservedRun(dir, 'failed', `not queued: ${(e as Error).message}`);
    throw e;
  }
  const warnings = [...prepared.scenario.issues.map((i) => i.message), ...(prepared.templateWarning ? [prepared.templateWarning] : [])];
  if (req.mode === 'dry' && req.hooks === undefined && (sc.setup?.length ?? 0) > 0) {
    warnings.push('dry run without its setup hooks: steps that need prepared data may fail (hooks: "run" executes them)');
  }
  return { job, run_id: runId, dir, warnings };
}

export interface RunJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: RunJobInput;
  signal: AbortSignal;
  interrupts: InterruptPort;
  /** Job events (the worker appends them to events.jsonl). */
  event(e: JobEventBody): void;
  /** Progress of the job (the worker writes it to job.json, throttled). */
  progress(p: JobProgress): void;
}

/** Execute a `run` job: the hash check, then `executeRun` with the reserved run id. */
export async function executeRunJob(ctx: RunJobContext): Promise<RunJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  const runDir = join(project.dir, 'runs', input.run_id);
  try {
    const prepared = await prepareRun(ctx.ws, project, input.scenario, { dry: input.mode === 'dry', until: input.until, hooks: input.hooks, env: input.env, sandbox: input.sandbox });
    await checkWorkspaceProtection(ctx.ws, project, resolveEnvironment(project, prepared.sandboxEnv ?? input.env ?? prepared.scenario.scenario.env).name);
    const sha = sha256Hex(await readFile(prepared.scenario.file));
    if (sha !== input.scenario_sha256) {
      throw new EngineError('conflict', `scenarios/${input.scenario} changed since the run was submitted: submit it again (what was checked is what runs)`, {
        details: { submitted: input.scenario_sha256, current: sha },
      });
    }
    const progress: JobProgress = { steps_done: 0, steps_total: 0, updated_at: new Date().toISOString() };
    const update = (patch: Partial<JobProgress>) => {
      Object.assign(progress, patch, { updated_at: new Date().toISOString() });
      ctx.progress({ ...progress });
    };
    const ports: RunPorts = {
      issues: (issues) => {
        for (const i of issues) ctx.event({ type: 'log', level: 'warn', message: i.message });
      },
      note: (level, message) => ctx.event({ type: 'log', level, message }),
      sandboxLog: (level, message) => {
        if (level !== 'debug') ctx.event({ type: 'log', level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', message });
      },
      progress: (e: RunProgress) => {
        ctx.event({ type: 'run', event: e });
        switch (e.type) {
          case 'run_start':
            update({ steps_total: e.run.steps_total, phase: 'starting' });
            break;
          case 'hook':
            if (e.status === 'start') update({ phase: e.phase });
            break;
          case 'step_start':
            update({ phase: 'scenes', current: { scene: e.scene, step: e.step, action: e.action } });
            break;
          case 'step_end':
            update({ steps_done: progress.steps_done + 1 });
            break;
          case 'encode':
            if (e.status === 'start') update({ phase: 'encode' });
            break;
          case 'run_end':
            update({ steps_done: e.run.steps_done, steps_total: e.run.steps_total, phase: 'done' });
            break;
        }
      },
      interrupts: ctx.interrupts,
    };
    const record = await executeRun(
      prepared,
      { dry: input.mode === 'dry', until: input.until, hooks: input.hooks, env: input.env, sandbox: input.sandbox },
      {
        runId: input.run_id,
        signal: ctx.signal,
        loginCommand: (p) => coreLoginCommand(p).replace(/^studio /, `${ctx.cli} `),
        // A queued job came through MCP: the hook files' trust flags do not count; only the approvals taken at submit.
        hookTrust: 'mcp',
        confirmHook: approvalChecker(input.approvals),
      },
      ports,
    );
    const err = record.error;
    return {
      kind: 'run',
      run_id: record.id,
      status: record.status,
      mode: record.mode,
      steps_done: record.steps_done,
      steps_total: record.steps_total,
      ...(record.stopped_at ? { stopped_at: record.stopped_at } : {}),
      ...(err && (err.scene !== undefined || err.step !== undefined || err.action !== undefined)
        ? { error: { ...(err.scene !== undefined ? { scene: err.scene } : {}), ...(err.step !== undefined ? { step: err.step } : {}), ...(err.action !== undefined ? { action: err.action } : {}) } }
        : {}),
      ...(err ? { untrusted: { error_message: err.message } } : {}),
    };
  } catch (e) {
    const cancelled = ctx.signal.aborted || toEngineError(e).code === 'cancelled';
    await finaliseReservedRun(runDir, cancelled ? 'cancelled' : 'failed', (e as Error)?.message ?? String(e));
    throw e;
  }
}
