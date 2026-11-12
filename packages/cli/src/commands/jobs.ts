/**
 * `retake jobs [list] | status <id> | cancel <id>` (L3.1): what a Claude session started through the MCP server — dry
 * runs, captures, hooks, environment resets, sign-ins, sandbox up / reset —, for the human at the terminal, also once
 * that session is gone. `retake run` and the other commands run inline and are not jobs.
 */
import { resolve } from 'node:path';
import { isJobId } from '@retake/core/ids';
import { JOB_STATES } from '@retake/engine';
import type { JobState } from '@retake/engine';
import { EngineError, FINISHED_JOB_STATES, createEngine, jobProject, yieldWords } from '@retake/engine';
import type { Engine, JobRecord } from '@retake/engine';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
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
  return createEngine({ ...(global.root ? { root: resolve(global.root) } : {}), client: 'cli', autoStartWorker: false });
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

/** "run quote (dry) → 20261017-142233-quote", "hooks catalogue:setup", "sign-in of supplier (headed)"… */
export function jobWhat(j: JobRecord): string {
  const i = j.input;
  const on = 'env' in i && i.env ? ` on ${i.env}` : '';
  switch (i.kind) {
    case 'render':
      return `render ${i.scenario} (run ${i.run_id}${i.template ? `, theme ${i.template}` : ''}) → ${i.render_id}`;
    case 'review':
      return `review ${i.render_id}${i.fps === 2 ? ' (2 fps)' : ''}`;
    case 'export':
      return `export ${i.render_id} → ${i.formats.join(', ')}`;
    case 'run':
      return `run ${i.scenario} (${i.mode})${on} → ${i.run_id}`;
    case 'hooks':
      return `hooks ${i.source}${i.dry ? ' (dry)' : ''}${on}`;
    case 'env_reset':
      return `env reset${i.dry ? ' (dry)' : ''}${on}`;
    case 'auth_login':
      return `sign-in of ${i.persona ?? 'the persona'} (${i.mode})${on}`;
    case 'sandbox_up':
      return `sandbox up${on}`;
    case 'sandbox_reset':
      return `sandbox reset${i.reseed ? ' (reseed)' : ''}${on}`;
    case 'preview':
      return `preview of ${i.target.kind === 'component' ? i.target.component : i.target.kind === 'library' ? `${i.target.items.length} library component${i.target.items.length === 1 ? '' : 's'}` : 'the theme'}${i.template ? ` (theme ${i.template})` : ''} → ${i.preview_id}`;
    case 'inspect':
      return `inspect ${i.source.kind === 'page' ? `page ${i.source.page} ${i.source.path}` : `scenario ${i.source.scenario}${i.source.until ? ` until ${i.source.until}` : ''}`}${on} → ${i.inspect_id}`;
    case 'record':
      return `record ${i.scenario ?? 'a scenario'} from page ${i.source.page} ${i.source.path}${on} → ${i.rec_id}`;
    case 'site':
      return `site extraction of ${i.url} → ${i.site_id}`;
  }
}

/** What a finished job produced, in a few words. */
export function jobOutcome(j: JobRecord): string {
  const r = j.result;
  if (!r) return '';
  switch (r.kind) {
    case 'run':
      return `run ${r.status} · ${r.steps_done}/${r.steps_total} steps`;
    case 'hooks':
    case 'env_reset':
      return r.ok ? 'ok' : 'with failures';
    case 'auth_login':
      return r.signed_in ? `signed in (${r.status})` : `not signed in (${r.status})`;
    case 'render':
      return `${r.duration_s} s ${r.width}×${r.height} → ${r.file}`;
    case 'review':
      return `${r.clean ? 'clean' : `${r.counts.error} errors, ${r.counts.warning} warnings`} → ${r.dir}`;
    case 'export':
      return `${r.outputs.length} files${r.failed.length ? `, ${r.failed.length} failed` : ''} → ${r.dir}`;
    case 'preview':
      return `${r.images.length} image${r.images.length === 1 ? '' : 's'} (${r.theme} theme) → ${r.dir}`;
    case 'inspect':
      return `${r.reported ? `${r.status}${r.counts ? `, ${r.counts.listed} elements listed` : ''}` : `not inspected (replay ${r.run_status})`} → ${r.dir}`;
    case 'record':
      return r.not_saved === 'nothing_recorded' ? 'nothing recorded' : `${r.stats.steps} steps${r.saved ? ` → ${r.saved.file}` : ` (not saved: ${r.not_saved})`} · check ${r.check.status}`;
    case 'site':
      return `${r.status === 'ok' ? `${r.candidates.length} logo candidate${r.candidates.length === 1 ? '' : 's'}${r.palette ? `, accent ${r.palette.roles.accent ?? 'none'}` : ''}` : 'the page could not be read'} → ${r.dir}`;
    default:
      return r.reset ? `reset ${r.reset.strategy}` : 'up, no seed needed';
  }
}

/** A running job's progress: percent for a render, steps for a run. */
function progressText(p: NonNullable<JobRecord['progress']>): string {
  if (p.steps_total === 0 && !p.current && p.phase) return p.phase;
  if (p.fraction !== undefined) return `${Math.round(p.fraction * 100)} %${p.phase ? ` · ${p.phase}` : ''}${p.eta_s !== undefined ? ` · ~${p.eta_s} s left` : ''}`;
  return `${p.steps_done}/${p.steps_total} steps${p.current ? ` · ${p.current.scene}.${p.current.step} ${p.current.action}` : p.phase ? ` · ${p.phase}` : ''}`;
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
    const progress = j.state === 'running' && p ? ` · ${progressText(p)}` : '';
    const outcome = jobOutcome(j);
    const cancel = j.cancel_requested_at && (j.state === 'running' || j.state === 'queued') ? c.yellow(' · cancel requested') : '';
    // L5.14: a heavy job a filming take holds (waiting to start, or slowed while it runs).
    const held = j.yield ? c.yellow(` · ${yieldWords(j.yield)}`) : '';
    ui.result(
      `${c.dim(j.id)}  ${stateText(ui, j.state)} ${jobProject(j.input) ?? 'workspace'} · ${jobWhat(j)}${held}${progress}${outcome ? ` · ${outcome}` : ''}${cancel} ${c.dim(`(${ago(j.created_at, now)}, by ${j.input.submitted_by})`)}`,
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
  row('what', `${jobProject(job.input) ?? 'workspace'} · ${jobWhat(job)}`);
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
  if (p && job.state === 'running') row('progress', progressText(p));
  const outcome = jobOutcome(job);
  if (outcome) row('result', outcome);
  if (job.cancel_requested_at && (job.state === 'running' || job.state === 'queued')) row('cancel', `requested at ${job.cancel_requested_at} (teardown and rollbacks run first)`);
  if (job.error) {
    row('error', job.error.message);
    if (job.error.fix) row('fix', job.error.fix);
  }
  return EXIT.ok;
}

/** `retake jobs cancel <id>`: a queued job never starts; a running one stops (its teardown and rollbacks still run). */
export async function jobsCancelCommand(ui: Ui, global: GlobalOptions, id: string): Promise<ExitCode> {
  checkId(id);
  const engine = await engineOf(global);
  const before = await engineCall(() => engine.jobs.get(id));
  if (FINISHED_JOB_STATES.has(before.state)) {
    ui.line(`${id} is already ${before.state}: nothing to cancel`);
    return EXIT.ok;
  }
  const job = await engineCall(() => engine.jobs.cancel(id));
  if (job.state === 'cancelled') ui.ok(`${id} cancelled (${jobWhat(job)})`);
  else ui.ok(`${id}: cancel requested (${jobWhat(job)}) — its teardown and rollbacks run first; retake jobs status ${id} follows it`);
  return EXIT.ok;
}
