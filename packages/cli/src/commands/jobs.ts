/**
 * `retake jobs [list] | status <id> | cancel <id>`: what a Claude session started through the MCP server — dry
 * runs, captures, hooks, environment resets, sign-ins, sandbox up / reset —, for the human at the terminal, also once
 * that session is gone. `retake run` and the other commands run inline and are not jobs.
 */
import { resolve } from 'node:path';
import { isJobId } from '@retake/core/ids';
import { JOB_STATES } from '@retake/engine/shell';
import type { JobState } from '@retake/engine';
import { EngineError, createEngine } from '@retake/engine';
import { FINISHED_JOB_STATES, jobOutcome, jobProgress, jobProject, jobWhat, yieldWords } from '@retake/engine/shell';
import type { Engine } from '@retake/engine';
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { invokeOperation } from '../invoke.js';
import type { Ui } from '../ui.js';
import { formatMs } from '../ui.js';
import type { GlobalOptions } from '../workspace.js';
import { ago } from './auth.js';

export interface JobsListOptions {
  project?: string;
  state?: string[];
  limit?: string;
  json?: boolean;
}

export interface JobsStatusOptions {
  json?: boolean;
}

async function engineOf(global: GlobalOptions): Promise<Engine> {
  return createEngine({ ...(global.root ? { root: resolve(global.root) } : {}), client: 'cli', autoStartWorker: false, ports: global.ports });
}

function checkId(id: string): void {
  if (!isJobId(id)) throw new UsageError(`"${id}" is not a job id (j_ followed by 26 characters: retake jobs lists them)`);
}

/** A job's own errors (not found…) as CLI errors with the same message. */
async function engineCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngineError) throw new CliError(e.message.replace('job_list names the jobs', 'retake jobs lists them'));
    throw e;
  }
}

function stateText(ui: Ui, s: JobState): string {
  const c = ui.c;
  const w = s.padEnd(11);
  return s === 'succeeded' ? c.green(w) : s === 'running' || s === 'queued' ? c.bold(w) : s === 'cancelled' ? c.dim(w) : c.red(w);
}

/** `retake jobs [--project] [--state …] [--limit] [--json]`: jobs of the workspace, newest first, and the worker. */
export async function jobsListCommand(ui: Ui, global: GlobalOptions, opts: JobsListOptions): Promise<ExitCode> {
  const limit = opts.limit === undefined ? 20 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive whole number, got "${opts.limit}"`);
  for (const s of opts.state ?? []) {
    if (!(JOB_STATES as readonly string[]).includes(s)) throw new UsageError(`unknown state "${s}" (states: ${JOB_STATES.join(', ')})`);
  }
  const engine = await engineOf(global);
  const jobs = await engine.jobs.list({ ...(opts.project ? { project: opts.project } : {}), ...(opts.state?.length ? { states: opts.state as JobState[] } : {}), limit });
  const worker = await engine.jobs.worker();
  if (opts.json) {
    ui.result(
      JSON.stringify({ jobs, worker: worker ? { pid: worker.pid, since: worker.since, build: worker.build, ...(worker.started_by ? { started_by: worker.started_by } : {}) } : null }, null, 2),
    );
    return EXIT.ok;
  }
  const c = ui.c;
  if (!jobs.length) {
    ui.line(
      `no jobs${opts.project ? ` of ${opts.project}` : ''}${opts.state?.length ? ` ${opts.state.join(' / ')}` : ''} — jobs are what an MCP client (Claude) starts; \`retake run\` runs in the terminal`,
    );
  }
  const now = Date.now();
  for (const j of jobs) {
    const p = j.progress;
    const progress = j.state === 'running' && p ? ` · ${jobProgress(p)}` : '';
    const outcome = j.result ? jobOutcome(j.result, 'full') : '';
    const cancel = j.cancel_requested_at && (j.state === 'running' || j.state === 'queued') ? c.yellow(' · cancel requested') : '';
    // A heavy job a filming take holds (waiting to start, or slowed while it runs).
    const held = j.yield ? c.yellow(` · ${yieldWords(j.yield)}`) : '';
    ui.result(
      `${c.dim(j.id)}  ${stateText(ui, j.state)} ${jobProject(j.input) ?? 'workspace'} · ${jobWhat(j.input)}${held}${progress}${outcome ? ` · ${outcome}` : ''}${cancel} ${c.dim(`(${ago(j.created_at, now)}, by ${j.input.submitted_by})`)}`,
    );
  }
  ui.line(
    c.dim(
      `worker: ${worker ? `running (pid ${worker.pid}${worker.started_by ? `, started by ${worker.started_by}` : ''}, since ${ago(worker.since, now)})` : 'not running (an MCP client or the Studio starts it when it submits a job)'}`,
    ),
  );
  return EXIT.ok;
}

/** `retake jobs status <id> [--json]`: one job — its input, state, progress, result or error and the fix. */
export async function jobsStatusCommand(ui: Ui, global: GlobalOptions, id: string, opts: JobsStatusOptions): Promise<ExitCode> {
  checkId(id);
  const engine = await engineOf(global);
  const job = await engineCall(() => engine.jobs.get(id));
  const position = job.state === 'queued' ? await engine.jobs.position(id) : undefined;
  if (opts.json) {
    ui.result(JSON.stringify({ ...job, ...(position ? { queue: position } : {}) }, null, 2));
    return EXIT.ok;
  }
  const c = ui.c;
  const row = (k: string, v: string) => ui.result(`  ${c.dim(k.padEnd(9))} ${v}`);
  ui.result(`${c.bold(job.id)} ${stateText(ui, job.state).trimEnd()}`);
  row('what', `${jobProject(job.input) ?? 'workspace'} · ${jobWhat(job.input)}`);
  const approvals = 'approvals' in job.input ? (job.input.approvals ?? []) : [];
  row('by', `${job.input.submitted_by}${approvals.length ? ` · ${approvals.length} ${job.input.kind === 'site' ? 'URL' : 'hook'} approval${approvals.length === 1 ? '' : 's'} given at submit` : ''}`);
  row('created', job.created_at);
  if (job.started_at)
    row('started', `${job.started_at}${job.worker ? (job.supervisor ? ` (job process pid ${job.worker.pid}, worker pid ${job.supervisor.pid})` : ` (worker pid ${job.worker.pid})`) : ''}`);
  if (job.finished_at) row('finished', `${job.finished_at}${job.started_at ? ` · ${formatMs(Date.parse(job.finished_at) - Date.parse(job.started_at))}` : ''}`);
  if (position)
    row(
      'queue',
      position.held_by === 'take'
        ? `${job.yield ? yieldWords(job.yield) : 'waiting for a take to finish'}${position.ahead ? ` · ${position.ahead} ahead` : ''}`
        : position.ahead
          ? `${position.ahead} ahead${position.running ? ` (running: ${position.running})` : ''}`
          : 'next',
    );
  if (job.yield?.state === 'background') row('held', `${yieldWords(job.yield)}${job.yield.since ? ` since ${job.yield.since}` : ''}`);
  const p = job.progress;
  if (p && job.state === 'running') row('progress', jobProgress(p));
  const outcome = job.result ? jobOutcome(job.result, 'full') : '';
  if (outcome) row('result', outcome);
  if (job.cancel_requested_at && (job.state === 'running' || job.state === 'queued')) row('cancel', `requested at ${job.cancel_requested_at} (teardown and rollbacks run first)`);
  if (job.error) {
    row('error', job.error.message);
    if (job.error.fix) row('fix', job.error.fix);
  }
  return EXIT.ok;
}

/**
 * `retake jobs cancel <id>`: a queued job never starts; a running one stops (its teardown and rollbacks still run). The
 * cancel is the job_cancel operation; the job is read first, so that a job finished before it is said so (a queued job
 * just cancelled and one cancelled before both answer `cancelled`).
 */
export async function jobsCancelCommand(ui: Ui, global: GlobalOptions, id: string): Promise<ExitCode> {
  checkId(id);
  const engine = await engineOf(global);
  const before = await engineCall(() => engine.jobs.get(id));
  if (FINISHED_JOB_STATES.has(before.state)) {
    ui.line(`${id} is already ${before.state}: nothing to cancel`);
    return EXIT.ok;
  }
  const { data: job } = await engineCall(() => invokeOperation(OPERATIONS_BY_NAME.job_cancel, engine, { job_id: id }));
  if (job.state === 'cancelled') ui.ok(`${id} cancelled (${jobWhat(job.input)})`);
  else ui.ok(`${id}: cancel requested (${jobWhat(job.input)}) — its teardown and rollbacks run first; retake jobs status ${id} follows it`);
  return EXIT.ok;
}
