/**
 * `run` jobs (L3.1): a dry run or a capture submitted by a client outside the CLI (the MCP server) and executed by the
 * jobs worker with the same `executeRun` as `retake run`.
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
  usedNamedHooks,
  writeJson,
} from '@retake/core';
import type { JobApproval, JobClient, LoadedProject, RunJobInput, RunProgress, RunRecord, RunStatus, WorkspaceConfig } from '@retake/core';
import type { FilmingEvent, FilmingReport, LiveSink, PauseGate } from '@retake/runner-web';
import { agentChannel, approvalChecker, checkAgentTrust, preflightHooks, refusedError, seedApprovalItems, takeApprovals } from '../approvals.js';
import type { Approver, Preflight } from '../approvals.js';
import { EngineError, scenarioChangedConflict, toEngineError } from '../errors.js';
import type { EngineErrorCode } from '../errors.js';
import { executeRun, prepareRun } from '../execute-run.js';
import type { PreparedRun, RunPorts } from '../execute-run.js';
import type { InterruptPort } from '../interrupts.js';
import { openProjectBySlug } from '../projects.js';
import { checkWorkspaceProtection } from '../protected-hosts.js';
import { checkProjectSlug, checkScenarioName } from '../refs.js';
import { getScenario } from '../scenarios.js';
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
  /**
   * sha256 of the scenario's bytes the client showed (the Studio's view `hash`): the submit is refused as `conflict`
   * when the bytes it checks are other ones (review A #6: what was clicked is what runs).
   */
  expect_sha256?: string;
}

export interface SubmitContext {
  ws: WorkspaceConfig;
  queue: FileJobQueue;
  /** "retake -C <root>": how the commands a human is asked to run start. */
  cli: string;
  client: JobClient;
}

/** Quote a word for a shell command line when it needs it. */
function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `retake run` command a human runs for the same run. */
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
  return join(project.dir, '.retake', 'journals', `preflight-${randomUUID()}.json`);
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

/** A run request opened and prepared once (its project, its scenario loaded and checked against its environment). */
interface PreparedSubmit {
  project: LoadedProject;
  prepared: PreparedRun;
}

async function prepareSubmit(ctx: SubmitContext, req: RunSubmitRequest): Promise<PreparedSubmit> {
  checkProjectSlug(req.project);
  checkScenarioName(req.scenario);
  const project = await openProjectBySlug(ctx.ws, req.project);
  // The file is read first as the Studio and MCP read scenarios (L4.2): inside the project once links are followed, a
  // regular file of bounded size — never through a link out, never a FIFO that would hold the reader.
  await getScenario(project, req.scenario);
  try {
    return { project, prepared: await prepareRun(ctx.ws, project, req.scenario, { dry: req.mode === 'dry', until: req.until, hooks: req.hooks, env: req.env, sandbox: req.sandbox }) };
  } catch (e) {
    throw toEngineError(e);
  }
}

/**
 * The checks a run must pass before it is queued, in the submit's order, each throwing its refusal: agent trust, the
 * workspace's protected hosts, the hooks a safety rule refuses, then the approvals of the hooks that need a human (the
 * last returns the approvals to write with the job). runBlockers runs the same gates without stopping at the first.
 */
function runGates(ctx: SubmitContext, s: PreparedSubmit, req: RunSubmitRequest, approver: Approver | undefined): Array<() => Promise<JobApproval[] | void>> {
  const { project, prepared } = s;
  const sc = prepared.scenario.scenario;
  const env = resolveEnvironment(project, prepared.sandboxEnv ?? req.env ?? sc.env);
  const hooksMode = req.hooks ?? (req.mode === 'capture' ? 'run' : 'skip');
  const fix = runCommandLine(ctx.cli, { ...req, hooks: hooksMode });
  const what = `${req.mode === 'dry' ? 'the dry run' : 'the capture'} of scenario ${prepared.scenario.name}`;
  // The hooks this run executes, checked with trust `mcp` (R-MCP-35): what a safety rule refuses fails the submit; what
  // needs a human is asked through the client's approver, else refused with the `retake` command a human runs.
  // `hook:` steps (L5.8): each named hook they run is asked about once, wherever its steps are.
  const named = usedNamedHooks(sc, project);
  const hasHooks = hooksMode === 'run' && ((sc.setup?.length ?? 0) > 0 || (sc.teardown?.length ?? 0) > 0 || named.length > 0);
  let pre: Promise<Preflight | undefined> | undefined;
  const preflight = (): Promise<Preflight | undefined> =>
    (pre ??= hasHooks
      ? preflightHooks(
          project,
          [
            // The scenario's own hooks are the agent's (trust `mcp`); a project.yaml one is a person's.
            { phase: 'setup', hooks: sc.setup ?? [], agentWritten: true },
            { phase: 'teardown', hooks: sc.teardown ?? [], agentWritten: true },
            ...named.map((h) => ({ phase: 'step' as const, hooks: h.hooks, agentWritten: h.source === 'scenario' })),
          ],
          { env: env.name, ...(sc.vars ? { vars: sc.vars } : {}), scenario: sc, journalFile: preflightJournal(project), via: agentChannel(ctx.client) },
        ).catch((e: unknown) => {
          throw toEngineError(e);
        })
      : Promise.resolve(undefined));
  return [
    async () => checkAgentTrust(project, sc, fix, ctx.client),
    async () => checkWorkspaceProtection(ctx.ws, project, env.name, fix, agentChannel(ctx.client)),
    async () => {
      const p = await preflight();
      if (p?.refused.length) throw refusedError(p, fix);
    },
    async () => {
      // `sandbox`: the reset before the take may run the seed — its shell steps need a human too.
      const seedItems = prepared.sandboxEnv ? await seedApprovalItems(project, prepared.sandboxEnv) : [];
      const p = await preflight();
      if (p) return takeApprovals({ what, project: project.slug, env: p.env, items: [...seedItems, ...p.items], fix }, approver, ctx.client);
      if (seedItems.length) return takeApprovals({ what, project: project.slug, env: { name: env.name, production: false, access: 'read-write' }, items: seedItems, fix }, approver, ctx.client);
      return [];
    },
  ];
}

/**
 * Which gate refused (L5.11a, critique H3): the generic `code` cannot tell agent trust from a protected host or a refused
 * hook (all `refused`), so the Studio's short words key on this. `agent_trust` — the scenario names a secret or a file
 * outside the project; `protected_host` — the location reaches another project's production / read-only host;
 * `hook_refused` — a hook a safety rule refuses; `read_only` — the same on a read-only location (its writing hooks);
 * `needs_approval` — hooks a person approves first (`count`); `invalid` — the file or the request does not check;
 * `prepare` — anything else that stops the run being prepared.
 */
export type RunBlockerKind = 'agent_trust' | 'protected_host' | 'hook_refused' | 'read_only' | 'needs_approval' | 'invalid' | 'prepare';

/** Why a run would be refused at submit, before anything is clicked (L4.2, critique B2): a refusal and its command. */
export interface RunBlocker {
  code: EngineErrorCode;
  /** The gate that refused (runBlockers sets it; the CLI and MCP ignore it). */
  kind?: RunBlockerKind;
  /** How many: hooks to approve (`needs_approval`), hooks refused (`hook_refused`, `read_only`). */
  count?: number;
  message: string;
  /** The `retake` command a human runs instead, when there is one. */
  fix?: string;
  /** The same command for a person without `retake` on their PATH: `node <repository>/packages/cli/dist/bin.js …` (the Studio's view). */
  fix_node?: string;
  /** The file must be fixed first (it has errors): no command helps (the Studio's view). */
  fix_file?: true;
}

/**
 * What would refuse a dry run and a capture of a scenario submitted by this client with no approver (the Studio's
 * buttons: default hooks — none for a dry run, all for a capture —, no sandbox, no `until`): the submit's own gates
 * (runGates), every one of them run, nothing queued, nothing executed, no run id reserved. Empty: the submit would
 * queue. The submit stays the authority: it checks again.
 */
export async function runBlockers(ctx: SubmitContext, req: { project: string; scenario: string; env?: string }): Promise<{ dry: RunBlocker[]; capture: RunBlocker[] }> {
  const blocker = (e: unknown, gate: number | null): RunBlocker => {
    const err = toEngineError(e);
    const k = blockerKind(err, gate);
    return { code: err.code, kind: k.kind, ...(k.count !== undefined ? { count: k.count } : {}), message: err.message, ...(err.fix ? { fix: err.fix } : {}) };
  };
  const base: RunSubmitRequest = { project: req.project, scenario: req.scenario, mode: 'dry', ...(req.env !== undefined ? { env: req.env } : {}) };
  let s: PreparedSubmit;
  try {
    s = await prepareSubmit(ctx, base);
  } catch (e) {
    const b = blocker(e, null);
    return { dry: [b], capture: [b] };
  }
  const out: { dry: RunBlocker[]; capture: RunBlocker[] } = { dry: [], capture: [] };
  for (const mode of ['dry', 'capture'] as const) {
    const gates = runGates(ctx, s, { ...base, mode }, undefined);
    for (const [i, gate] of gates.entries()) {
      try {
        await gate();
      } catch (e) {
        const b = blocker(e, i);
        // A preflight that failed fails both hook gates with the same error: said once.
        if (!out[mode].some((x) => x.message === b.message)) out[mode].push(b);
      }
    }
  }
  return out;
}

/**
 * The gate that threw, as runGates orders them (0 agent trust, 1 protected hosts, 2 refused hooks, 3 approvals; null:
 * preparing the run): its kind, and how many hooks for the hook gates. An error a gate did not word as its own refusal
 * (a hooks preflight that failed) is `prepare` — never a safety reason it was not (critique H3).
 */
export function blockerKind(err: EngineError, gate: number | null): { kind: RunBlockerKind; count?: number } {
  const list = (k: string) => {
    const v = err.details?.[k];
    return Array.isArray(v) ? v.length : undefined;
  };
  if (gate === null) return { kind: err.code === 'invalid' || err.code === 'not_found' ? 'invalid' : 'prepare' };
  if (gate === 0 && err.code === 'refused' && Array.isArray(err.details?.problems)) return { kind: 'agent_trust' };
  if (gate === 1 && err.code === 'refused') return { kind: 'protected_host' };
  if (gate === 2 && err.code === 'refused' && Array.isArray(err.details?.refused)) {
    const env = err.details?.env as { access?: string } | undefined;
    const count = list('refused');
    return { kind: env?.access === 'read-only' ? 'read_only' : 'hook_refused', ...(count !== undefined ? { count } : {}) };
  }
  if (gate === 3 && err.code === 'needs_approval') {
    const count = list('hooks');
    return { kind: 'needs_approval', ...(count !== undefined ? { count } : {}) };
  }
  return { kind: err.code === 'invalid' ? 'invalid' : 'prepare' };
}

/** Check, reserve the run id and queue a `run` job. */
export async function submitRunJob(ctx: SubmitContext, req: RunSubmitRequest, approver?: Approver): Promise<{ job: JobRecord; run_id: string; dir: string; warnings: string[] }> {
  const s = await prepareSubmit(ctx, req);
  const { project, prepared } = s;
  const sc = prepared.scenario.scenario;
  const env = resolveEnvironment(project, prepared.sandboxEnv ?? req.env ?? sc.env);
  const hooksMode = req.hooks ?? (req.mode === 'capture' ? 'run' : 'skip');
  let approvals: JobApproval[] = [];
  for (const gate of runGates(ctx, s, req, approver)) {
    const r = await gate();
    if (r) approvals = r;
  }
  // The bytes the gates checked (those prepareRun read once and parsed), never a later read of the file (review A #6);
  // the worker parses only bytes with this hash.
  const sha = prepared.scenario.sha256 ?? sha256Hex(Buffer.from(prepared.scenario.text, 'utf8'));
  if (req.expect_sha256 !== undefined && req.expect_sha256 !== sha) {
    throw new EngineError('conflict', `scenarios/${prepared.scenario.name} changed since it was shown: look at it again, then start the run`, {
      details: { shown: req.expect_sha256, current: sha },
    });
  }
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
  /** L4.4: the live picture's sink (the worker's live channel). */
  live?: LiveSink;
  /** L4.4: the job's pause marker, as the worker polls it. */
  pause?: PauseGate;
  /** L5.14: when the take films (the worker writes its filming marker). */
  onFilming?: (state: FilmingEvent) => void | FilmingReport;
}

/** The environment variable that changes the longest pause of a run (minutes). */
export const PAUSE_MAX_ENV = 'RETAKE_PAUSE_MAX_MIN';

/** The longest pause (ms): RETAKE_PAUSE_MAX_MIN when set (minutes, more than 0 to 1440), else undefined (30 min). */
export function pauseMaxMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[PAUSE_MAX_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) throw new EngineError('invalid', `${PAUSE_MAX_ENV} must be a number of minutes from more than 0 to 1440, got "${raw}"`);
  return Math.round(n * 60_000);
}

/** Execute a `run` job: the hash check, then `executeRun` with the reserved run id. */
export async function executeRunJob(ctx: RunJobContext): Promise<RunJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  const runDir = join(project.dir, 'runs', input.run_id);
  try {
    // One read of the file: only bytes with the submitted hash are parsed and run (core loadScenario's expectSha256).
    const prepared = await prepareRun(ctx.ws, project, input.scenario, { dry: input.mode === 'dry', until: input.until, hooks: input.hooks, env: input.env, sandbox: input.sandbox, expectSha256: input.scenario_sha256 }).catch((e: unknown) => {
      throw scenarioChangedConflict(e, `scenarios/${input.scenario} changed since the run was submitted: submit it again (what was checked is what runs)`);
    });
    await checkWorkspaceProtection(ctx.ws, project, resolveEnvironment(project, prepared.sandboxEnv ?? input.env ?? prepared.scenario.scenario.env).name, undefined, agentChannel(input.submitted_by));
    const progress: JobProgress = { steps_done: 0, steps_total: 0, updated_at: new Date().toISOString() };
    const update = (patch: Partial<JobProgress>) => {
      Object.assign(progress, patch, { updated_at: new Date().toISOString() });
      if (patch.paused === undefined && 'paused' in patch) delete progress.paused;
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
          case 'pause':
            if (e.state === 'paused') update({ paused: { scene: e.scene, step: e.step, since: new Date().toISOString() } });
            else if (e.state === 'resumed') update({ paused: undefined });
            break;
          case 'run_end':
            update({ steps_done: e.run.steps_done, steps_total: e.run.steps_total, phase: 'done', paused: undefined });
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
        loginCommand: (p) => coreLoginCommand(p).replace(/^retake /, `${ctx.cli} `),
        // A queued job came through MCP: the hook files' trust flags do not count; only the approvals taken at submit.
        hookTrust: 'mcp',
        hookVia: agentChannel(input.submitted_by),
        confirmHook: approvalChecker(input.approvals),
        ...(ctx.live ? { live: ctx.live } : {}),
        ...(ctx.pause ? { pause: ctx.pause } : {}),
        ...(ctx.onFilming ? { onFilming: ctx.onFilming } : {}),
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
