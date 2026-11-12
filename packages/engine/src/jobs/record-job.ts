/**
 * `record` jobs (L3.4, R-MCP-24): `retake record` submitted by a client outside the CLI (the MCP server's
 * scenario_record) and run by the jobs worker with the same engine code (record.ts). A HEADED window opens on the
 * machine the worker runs on, for a HUMAN to perform the flow and close the window — the job waits for it, holding the
 * queue like a headed sign-in. Nothing in the job drives the window: its input names a page, a path, a persona and a
 * scenario name, never a step, a URL or typed text.
 *
 * Trust: the environment's own access (never --allow-writes; production read-only), hooks never run, the workspace's
 * protected hosts, the draft saved under agent trust, its check replay with trust `mcp`. Stop and cancel: a worker
 * signal stops the recording and KEEPS it (draft made and saved, the check replay skipped: a human's twenty minutes are
 * not lost to a worker restart); job_cancel while the window is open DISCARDS it (the folder removed); after the
 * recording a cancel only stops the check replay. L4.8: the job's `stop` marker (the Studio's Stop) stops and keeps as
 * closing the window does (the check replay runs) — before the window opened it is a clean cancel (nothing opens, no
 * cancel races the window into a discard); a job the Studio submitted (`submitted_by: 'ui'`) is never saved by the job
 * — the person saves it from the Record screen (engine record-studio.ts) — and a Discard asked during its draft or
 * check removes the folder when the job ends.
 *
 * The result has counts, enums and file paths only: the draft and record.json stay in the recording's folder (typed
 * text and page text never enter job.json, the job's events or the worker log); scene ids (made from page paths), the
 * draft's issues and the check's failure are under `untrusted`. scenario_record reads draft.yaml from the folder.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOB_INPUT_VERSION, SLUG_RE, resolveRunAccess } from '@retake/core';
import type { RecordJobInput, RecordedEvent } from '@retake/core';
import { stampOf } from '../clock.js';
import { ENGINE_TRUST, submittedInStudio } from '../caller.js';
import { EngineError, toEngineError } from '../errors.js';
import { checkSandboxEnv } from '../execute-run.js';
import { openProjectBySlug } from '../projects.js';
import { checkWorkspaceProtection } from '../protected-hosts.js';
import { newRecordId, recordDir, recordScenario, recordStart } from '../record.js';
import type { RecordOutcome, RecordPorts } from '../record.js';
import { settleDiscardAtJobEnd } from '../record-studio.js';
import { checkProjectSlug, checkScenarioName } from '../refs.js';
import { checkEnvName } from './hooks-job.js';
import type { JobQueueView } from './job-queue.js';
import type { SubmitContext } from './run-job.js';
import type { JobEventBody, JobProgress, JobRecord, RecordJobResult } from './types.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { EnginePorts } from '../ports.js';

export interface RecordSubmitRequest {
  project: string;
  env?: string;
  /** The persona the window is signed in as (`none`: signed out); default the persona whose `pages` list the page. */
  persona?: string;
  /** An environment page key (default: the persona's first page, else the environment's first). */
  page?: string;
  /** A path under the page (default `/`). */
  path?: string;
  /** Instead of page + path: an http(s) URL on the exact origin of one of the environment's pages. */
  url?: string;
  /** The draft's name (default recorded-YYYYMMDD-HHMM); saved only when free. */
  scenario?: string;
  /** The headless check replay after the recording (default true). */
  check?: boolean;
}

function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `retake record` command a human runs for the same recording. */
export function recordCommandLine(cli: string, r: { project: string; scenario?: string; env?: string; persona?: string; page?: string; path?: string }): string {
  return [
    cli,
    'record',
    r.project,
    ...(r.scenario !== undefined ? [r.scenario] : []),
    ...(r.env !== undefined ? ['--env', q(r.env)] : []),
    ...(r.persona !== undefined ? ['--persona', q(r.persona)] : []),
    ...(r.page !== undefined ? ['--page', q(r.page)] : []),
    ...(r.path !== undefined && r.path !== '/' ? ['--path', q(r.path)] : []),
  ].join(' ');
}

const hasTemplate = (v: unknown) => v !== undefined && JSON.stringify(v).includes('{{');

/** Check where the recording starts (as the worker will), then queue a `record` job with a reserved recording id. */
export async function submitRecordJob(ctx: SubmitContext, req: RecordSubmitRequest): Promise<{ job: JobRecord; rec_id: string; env: string; page: string; path: string; persona: string | null; warnings: string[] }> {
  checkProjectSlug(req.project);
  checkEnvName(req.env);
  for (const [k, v] of Object.entries({ page: req.page, path: req.path, url: req.url, persona: req.persona })) {
    if (hasTemplate(v)) throw new EngineError('refused', `${k}: no {{…}} template in a recording (no environment variable or keychain value reaches a page through it)`);
  }
  if (req.persona !== undefined && (!SLUG_RE.test(req.persona) || req.persona.length > 100)) {
    throw new EngineError('invalid', `invalid persona "${req.persona}": a persona name of project.yaml (or none)`);
  }
  if (req.scenario !== undefined) checkScenarioName(req.scenario);
  const project = await openProjectBySlug(ctx.ws, req.project);
  const start = recordStart(project, { env: req.env, persona: req.persona, page: req.page, path: req.path, url: req.url });
  const fix = recordCommandLine(ctx.cli, {
    project: project.slug,
    ...(req.scenario !== undefined ? { scenario: req.scenario } : {}),
    ...(req.env !== undefined ? { env: req.env } : {}),
    ...(req.persona !== undefined ? { persona: req.persona } : {}),
    page: start.page,
    path: start.path,
  });
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new EngineError('unavailable', 'a recording opens a browser window for a person and this machine has no display (DISPLAY / WAYLAND_DISPLAY are not set): record on a machine with a screen', { fix });
  }
  // Where it may run (the workspace's protected hosts), as for run_dry.
  await checkWorkspaceProtection(ctx.ws, project, start.env.name, fix);
  const warnings: string[] = [];
  if (req.scenario !== undefined && project.scenarios.includes(req.scenario)) warnings.push(`scenario ${req.scenario} exists: the draft will be kept in the recording's folder only (not saved over it)`);
  if (resolveRunAccess(start.env, { allowWrites: false, project }).mode === 'read-only') warnings.push(`environment ${start.env.name} is read-only: writes made in the window are stopped or answered by a mock, as in a dry run`);
  const recId = newRecordId();
  const input: RecordJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'record',
    project: project.slug,
    rec_id: recId,
    ...(req.env !== undefined ? { env: req.env } : {}),
    source: { page: start.page, path: start.path },
    ...(req.persona !== undefined ? { persona: req.persona } : {}),
    ...(req.scenario !== undefined ? { scenario: req.scenario } : {}),
    check: req.check !== false,
    submitted_by: ctx.client,
  };
  return { job: await ctx.queue.enqueue(input), rec_id: recId, env: start.env.name, page: start.page, path: start.path, persona: start.persona?.name ?? null, warnings };
}

/** Test hooks of the worker (in-process tests only): Playwright plays the person in a headless "headed" window. */
export type RecordJobTestHooks = Pick<RecordPorts, 'drive' | 'headless' | 'windowSize'>;

/** What the job runs with; its ports (ports.ts EnginePorts) are its composition root's, handed on by the job runner. */
export interface RecordJobContext extends EnginePorts {
  ws: OpenedWorkspace;
  cli: string;
  /** The workspace's job queue (a recording whose job is queued or running is never pruned). */
  queue: JobQueueView;
  input: RecordJobInput;
  /** job_cancel: discard while recording; after it, stop the check replay. */
  signal: AbortSignal;
  /** A worker signal: stop and keep, no check replay. */
  stop: AbortSignal;
  /** The job's stop marker (L4.8, the Studio's Stop): stop and keep, as closing the window — the check replay runs. */
  finish?: AbortSignal;
  /** The job's id (written to the recording's meta.json). */
  jobId?: string;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
  test?: RecordJobTestHooks;
}

const ACTIONS = new Set<RecordedEvent['kind']>(['pointer', 'type', 'key', 'select_native', 'file']);

/** The job's result from an outcome: counts and enums trusted; scene ids, issues and the check's failure under `untrusted`. */
export function recordResult(o: RecordOutcome): RecordJobResult {
  const k = o.check;
  const count = (sev: string) => o.issues.filter((i) => i.severity === sev).length;
  return {
    kind: 'record',
    rec_id: o.rec_id,
    dir: o.dir,
    draft: o.draft,
    name: o.name,
    saved: o.saved ? { file: o.saved.file, path: o.saved.path, hash: o.saved.hash } : null,
    ...(o.not_saved ? { not_saved: o.not_saved } : {}),
    env: o.env,
    persona: o.persona,
    access: o.access,
    stop: o.stop,
    ms: o.ms,
    window: o.window,
    capture: o.capture,
    counts: o.counts,
    stats: o.stats,
    issues: { error: count('error'), warning: count('warning'), info: count('info'), codes: [...new Set(o.issues.map((i) => i.code))] },
    warnings: o.warnings,
    writes: { total: o.writes.total, by_steps: o.writes.by_steps, ambient: o.writes.ambient },
    check: { status: k.status, scope: k.scope, ...(k.reason ? { reason: k.reason } : {}), steps_passed: k.steps_passed, steps_total: k.steps_total, ...(k.dir ? { dir: k.dir } : {}) },
    untrusted: {
      scenes: o.scenes,
      issues: o.issues,
      ...(o.writes.first ? { first_write: o.writes.first } : {}),
      ...(k.until !== undefined || k.failed_at || k.untrusted
        ? { check: { ...(k.until !== undefined ? { until: k.until } : {}), ...(k.failed_at ? { failed_at: k.failed_at } : {}), ...(k.untrusted ? { error: k.untrusted.error } : {}) } }
        : {}),
    },
  };
}

/** Execute a `record` job: every check again, the window for the person, the draft, the check replay. */
export async function executeRecordJob(ctx: RecordJobContext): Promise<RecordJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  const start = recordStart(project, { env: input.env, persona: input.persona, page: input.source.page, path: input.source.path });
  await checkWorkspaceProtection(ctx.ws, project, start.env.name);
  await checkSandboxEnv(project, start.env.name, (level, message) => ctx.event({ type: 'log', level, message }), ctx.ws.policy);
  const progress: JobProgress = { steps_done: 0, steps_total: 0, phase: 'preflight', updated_at: stampOf(ctx.clock) };
  const update = (patch: Partial<JobProgress>) => {
    Object.assign(progress, patch, { updated_at: stampOf(ctx.clock) });
    ctx.progress({ ...progress });
  };
  let actions = 0;
  const loginCommand = (p: { project: string; env: string; persona?: string }) => `${ctx.cli} login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`;
  // The Studio's Stop before the window opened (B-L8): a clean cancel. Once the window is open, it stops and keeps.
  const early = new AbortController();
  let opened = false;
  const onFinish = () => {
    if (!opened) early.abort();
  };
  if (ctx.finish?.aborted) onFinish();
  else ctx.finish?.addEventListener('abort', onFinish, { once: true });
  try {
    const outcome = await recordScenario(
      ctx.ws,
      project,
      {
        id: input.rec_id,
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.persona !== undefined ? { persona: input.persona } : {}),
        page: input.source.page,
        path: input.source.path,
        ...(input.scenario !== undefined ? { name: input.scenario } : {}),
        check: input.check,
        agent: true,
        submittedBy: input.submitted_by,
        ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
      },
      {
        queue: ctx.queue,
        clock: ctx.clock,
        stores: ctx.stores,
        capture: ctx.capture,
        hooks: ctx.hooks,
        // Messages of the engine and the runner: counts and enums, never page text or a typed value.
        log: (level, message) => {
          if (level !== 'debug') ctx.event({ type: 'log', level, message });
        },
        onPhase: (phase) => update({ phase, ...(phase === 'check' ? { steps_done: 0, steps_total: 0 } : {}) }),
        onOpen: () => {
          opened = true;
          ctx.event({ type: 'log', level: 'info', message: 'a browser window is open on this machine — the user performs the flow, then closes the window' });
          update({ phase: 'recording · 0 actions' });
        },
        onEvent: (e) => {
          if (!ACTIONS.has(e.kind)) return;
          actions++;
          update({ phase: `recording · ${actions} action${actions === 1 ? '' : 's'}` });
        },
        onCheckProgress: (e) => {
          if (e.type === 'run_start') update({ phase: 'check', steps_total: e.run.steps_total });
          else if (e.type === 'step_end') update({ steps_done: progress.steps_done + 1 });
        },
        stop: ctx.finish ? AbortSignal.any([ctx.stop, ctx.finish]) : ctx.stop,
        skipCheck: () => ctx.stop.aborted,
        signal: AbortSignal.any([ctx.signal, early.signal]),
        hookTrust: ENGINE_TRUST,
        loginCommand,
        history: false,
        ...(ctx.test ?? {}),
      },
    );
    // A Discard asked during the draft or the check: the folder goes now (B9 / B-L2), even with no Record screen open.
    if (submittedInStudio(input) && outcome.dir && (await settleDiscardAtJobEnd(project, input.rec_id).catch(() => false))) {
      return recordResult({ ...outcome, dir: null, draft: null });
    }
    return recordResult(outcome);
  } catch (e) {
    const err = toEngineError(e);
    if (err.code === 'refused' || err.code === 'unavailable') {
      throw new EngineError(err.code, err.message, {
        fix:
          err.fix ??
          recordCommandLine(ctx.cli, {
            project: project.slug,
            ...(input.scenario !== undefined ? { scenario: input.scenario } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.persona !== undefined ? { persona: input.persona } : {}),
            page: input.source.page,
            path: input.source.path,
          }),
      });
    }
    throw err;
  } finally {
    ctx.finish?.removeEventListener('abort', onFinish);
  }
}

/** Longest draft returned to a client (a draft is small: a recording's steps). */
export const RECORD_DRAFT_MAX = 200_000;

/**
 * A recording's draft read back from its folder (null when there is none: nothing recorded, cancelled, or pruned since).
 * Its text holds what the person typed and the page's names: a client shows it as untrusted data.
 */
export async function readRecording(ws: OpenedWorkspace, slug: string, recId: string): Promise<{ dir: string; draft: string | null; truncated: boolean }> {
  checkProjectSlug(slug);
  const project = await openProjectBySlug(ws, slug);
  const dir = recordDir(project, recId);
  let draft: string | null = null;
  try {
    draft = await readFile(join(dir, 'draft.yaml'), 'utf8');
  } catch {
    draft = null;
  }
  const truncated = draft !== null && draft.length > RECORD_DRAFT_MAX;
  return { dir, draft: truncated ? draft!.slice(0, RECORD_DRAFT_MAX) : draft, truncated };
}
