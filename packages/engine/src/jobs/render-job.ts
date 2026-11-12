/**
 * `render` jobs (L3.2, R-MCP-29): a render submitted by a client outside the CLI (the MCP server) and executed by the
 * jobs worker with the editor's `renderVideo`, guarded (trust `mcp`, network guard).
 *
 * Submit plans the run in the client's process (editor `planRun` with trust `mcp`: its two gates refuse files outside
 * the project, a theme named by folder, remote slot values — no browser is opened), hashes the run's timeline, reserves
 * the render id (an O_EXCL `.<scenario>-v<N>.lock` of renders/, the variant's suffix from the plan) and queues the input;
 * a lock whose job cannot be queued is released. An edit planned from the scenario file is snapshotted in the job
 * folder (edit.yaml, L4.5 critique B5): the worker plans from that text, so a switch made while the render waits in the
 * queue never fails it nor changes what it renders. The worker plans again (the same gates), refuses a timeline or a
 * variant that changed, records the render browser's process (job folder, browser.json) and renders — then, when asked
 * (`review`, L4.5 critique B12), reviews it in the same job. A failed or
 * cancelled render writes nothing under its id and releases the lock: the next render of the scenario reuses the id
 * (render_status looks the job up first).
 *
 * The editor is imported lazily: a capture-only worker, and an MCP process that never plans, do not load Remotion.
 */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SLUG_RE } from '@retake/core/model';
import { formatRenderId, isRunId, isThemeName, renderIdOf } from '@retake/core/ids';
import { projectPath, projectRef } from '@retake/core/project';
import { SCENARIO_EDIT_MAX_CHARS } from '@retake/core/scenario';
import { untilStep } from '@retake/core/run';
import { EditOverridesInputSchema, JOB_INPUT_VERSION } from './job-input.js';
import type { RenderVariant } from '@retake/core/ids';
import type { LoadedProject } from '@retake/core/model';
import type { NotUsable } from '@retake/core/run';
import type { EditOverridesInput, RenderJobInput } from './job-input.js';
import type { ComponentRegistry } from '@retake/components';
import type { BrowserProcessInfo, EditOverrides, PlannedRun, RenderProgress } from '@retake/editor';
import { stampOf } from '../clock.js';
import { ENGINE_TRUST } from '../caller.js';
import { EngineError, toEngineError } from '../errors.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug, checkRunId, checkScenarioName } from '../refs.js';
import { sha256Hex } from '../storage.js';
import { isAlive } from './proc.js';
import { signalablePid } from './signal.js';
import type { ProcessIdentity } from './proc.js';
import type { SubmitContext } from './run-job.js';
import type { JobFileRead } from './job-queue.js';
import type { JobFiles } from './queue.js';
import type { JobEventBody, JobProgress, JobRecord, RenderJobResult } from './types.js';

import { editor } from '../lazy.js';
import { planWork, renderWork } from '../pipeline.js';
import type { Renderer } from '../render/renderer.js';
import type { Reviewer } from '../review/reviewer.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { EnginePorts } from '../ports.js';

export interface RenderRequest {
  project: string;
  scenario: string;
  /** A capture run of the scenario (default: its latest capture). */
  run_id?: string;
  /** A theme name (template_list): never a folder. */
  template?: string;
  overrides?: EditOverridesInput;
  /** Review the render in the same job once it is written (L4.5, critique B12): contact sheets at `fps`. */
  review?: { fps: 1 | 2 };
  /**
   * sha256 of the scenario file as the client showed it (the Studio timeline's `hash`, L4.5 part E): after planning and
   * before the id is reserved, the file the edit was planned from — today's file when the edit comes from the run — must
   * still be that one, else `conflict` (nothing reserved, nothing queued): what was clicked is what renders.
   */
  expect_edit_sha256?: string;
}

/** The job folder's snapshot of the scenario text a render's edit was planned from (L4.5, critique B5). */
export const EDIT_SNAPSHOT_FILE = 'edit.yaml';

/** Quote a word for a shell command line when it needs it. */
function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `retake render` command a human runs for (about) the same render (overrides other than the theme are not carried). */
export function renderCommandLine(cli: string, r: { project: string; scenario: string; run_id?: string; template?: string }): string {
  return [cli, 'render', r.project, r.scenario, ...(r.run_id ? ['--run', q(r.run_id)] : []), ...(r.template ? ['--theme', q(r.template)] : [])].join(' ');
}

/** Check the names of a render request and parse its overrides (strict, bounded): EngineError `invalid`. */
export function checkRenderRequest(req: RenderRequest): EditOverridesInput {
  checkProjectSlug(req.project);
  checkScenarioName(req.scenario);
  if (req.run_id !== undefined) checkRunId(req.run_id);
  if (req.template !== undefined && !isThemeName(req.template)) {
    throw new EngineError('invalid', `invalid theme "${String(req.template)}": a theme name (template_list names them), never a path`);
  }
  if (req.review !== undefined && !(req.review && typeof req.review === 'object' && (req.review.fps === 1 || req.review.fps === 2) && Object.keys(req.review).length === 1)) {
    throw new EngineError('invalid', 'invalid review: {fps: 1} or {fps: 2} (contact sheet frames per second)');
  }
  if (req.expect_edit_sha256 !== undefined && (typeof req.expect_edit_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(req.expect_edit_sha256))) {
    throw new EngineError('invalid', 'invalid expect_edit_sha256: the sha256 of the scenario file as shown (64 lower-case hex characters)');
  }
  const parsed = EditOverridesInputSchema.safeParse(req.overrides ?? {});
  if (!parsed.success) {
    throw new EngineError('invalid', `invalid overrides: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(overrides)'}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

/**
 * Where a planned render's edit comes from (L5.5): `scenario` — today's scenario file re-planned on the run (its filmed
 * part is unchanged since the capture); `run` — the run as captured. `scenario_changed`: the filmed part changed since
 * the capture (re-capture to film it; absent when either file is missing), `filmed_changes` what changed in it,
 * `edit_changes` what today's edit changed. Both lists hold keys, scene ids and step keys only (trusted words).
 */
export interface RenderEditSource {
  edit: 'scenario' | 'run';
  scenario_changed?: boolean;
  filmed_changes?: string[];
  edit_changes?: string[];
}

/** A planned run's edit source, as the engine reports it. */
export function editSourceOf(planned: Pick<PlannedRun, 'edit'>): RenderEditSource {
  const e = planned.edit;
  return {
    edit: e.from,
    ...(e.scenario_changed !== undefined ? { scenario_changed: e.scenario_changed } : {}),
    ...(e.filmed_changes?.length ? { filmed_changes: e.filmed_changes } : {}),
    ...(e.changes?.length ? { edit_changes: e.changes } : {}),
  };
}

/**
 * What `latest` said of the run it picked (core latestTake) — absent members: nothing to say; a run named by its id:
 * none. `passed_over`: how many newer captures of the scenario it did not take (failed, cancelled, not finished,
 * without their film…) — a count, which a trusted line may say. `not_considered`: how many newer run folders it met
 * whose run.json is missing or does not read as a record (nothing says which scenario they are of). `until`: the capture picked was stopped by `--until`:
 * a render shows the scenario up to there — after this step when run.json names it as a scenario does (a scene id and a
 * whole number: run.json is a file anyone may write, and only such words are repeated); else `{}`.
 */
export interface LatestRunNotice {
  passed_over?: number;
  not_considered?: number;
  until?: { scene?: string; step?: number };
}

/**
 * The newer captures `latest` passed over, newest first (at most core PASSED_OVER_MAX; `passed_over` counts them all):
 * each run's folder name and why, in the rule's closed list of reasons. A folder's name is text anyone who can write
 * runs/ chose: it is kept under `untrusted`, never said in a trusted line.
 */
export type PassedOverRuns = Array<{ run_id: string; why: NotUsable }>;

/** What `latest` said of a planned run: the notice, and the runs it passed over (empty: none, or the run was named). */
export function latestNoticeOf(planned: Pick<PlannedRun, 'run'>): { notice: LatestRunNotice; passed: PassedOverRuns } {
  const pick = planned.run.latest;
  if (!pick) return { notice: {}, passed: [] };
  const count = pick.passed.length + pick.passed_more;
  return {
    // Where a capture stopped by `--until` ends, in words that can be repeated (core untilStep), else `{}`.
    notice: {
      ...(count > 0 ? { passed_over: count } : {}),
      ...(pick.without_record > 0 ? { not_considered: pick.without_record } : {}),
      ...(pick.take?.until ? { until: untilStep(pick.take.until) ?? {} } : {}),
    },
    passed: pick.passed.map((p) => ({ run_id: p.run, why: p.why })),
  };
}

/**
 * Plan a render request in this process (no browser), through the trust gates of work submitted through MCP. A
 * refusal is EngineError `refused` with the `retake render` command a human runs. The plan's edit comes from today's
 * scenario file when its filmed part is unchanged since the run, else from the run as captured (L5.5, editor planRun):
 * `source` says which and what changed. `editText` (L4.6): a text read instead of today's file (a proposal's preview).
 */
export async function planRenderRequest(
  ws: OpenedWorkspace,
  cli: string,
  req: RenderRequest,
  o: { registry?: ComponentRegistry; musicLength?: (file: string) => Promise<number | undefined>; editText?: string } = {},
): Promise<{ project: LoadedProject; planned: PlannedRun; overrides: EditOverridesInput; source: RenderEditSource }> {
  const overrides = checkRenderRequest(req);
  const project = await openProjectBySlug(ws, req.project);
  const ed = await editor();
  try {
    const planned = await planWork({
      workPolicy: ws.policy,
      project,
      run: req.run_id ?? 'latest',
      scenario: req.scenario,
      ...(req.template !== undefined ? { template: req.template } : {}),
      overrides: overrides as EditOverrides,
      root: ws.root,
      trust: ENGINE_TRUST,
      ...(o.registry ? { registry: o.registry } : {}),
      ...(o.musicLength ? { musicLength: o.musicLength } : {}),
      // L4.6 (critique B9): a proposal previewed in the timeline is planned from its text in memory, never written.
      ...(o.editText !== undefined ? { editText: o.editText } : {}),
    });
    // The run id reaches trusted summaries: `latest` picks only run ids (editor findRun); never one of another shape.
    if (!isRunId(planned.run.id)) {
      throw new EngineError('invalid', 'the run picked is not a run id of runs/ (letters, digits, ".", "_", "-"): pass run_id (run_list names the runs)');
    }
    return { project, planned, overrides, source: editSourceOf(planned) };
  } catch (e) {
    if (e instanceof ed.PlanTrustError) {
      throw new EngineError('refused', e.message, { fix: renderCommandLine(cli, req), details: { problems: e.problems } });
    }
    throw toEngineError(e);
  }
}

/**
 * `expect_edit_sha256` (L4.5 part E): the file the edit was planned from (its sha256), or — when the edit comes from the
 * run (a filmed change pending, no file) — today's scenario file, must be the version the client showed. A conflict
 * otherwise, before anything is reserved.
 */
async function checkShownEdit(project: LoadedProject, scenario: string, planned: PlannedRun, shown: string): Promise<void> {
  let now = planned.edit.sha256;
  if (now === undefined) {
    const { getScenario } = await import('../scenarios.js');
    now = await getScenario(project, scenario).then(
      (t) => t.hash,
      () => undefined,
    );
  }
  if (now !== shown) {
    throw new EngineError('conflict', `${projectRef('scenarios', scenario)} changed since it was shown: look at the timeline again, then render`, {
      details: { shown, ...(now !== undefined ? { current: now } : {}) },
    });
  }
}

/** The version and variant of a render id of `scenario` ("quote-v3-vertical" → 3, vertical); any other text is refused. */
export function renderVersionOf(renderId: string, scenario: string): { version: number; variant: RenderVariant } {
  const r = renderIdOf(renderId, scenario);
  if (!r) throw new EngineError('invalid', `render id ${renderId} is not a render of scenario ${scenario}`);
  return { version: r.version, variant: r.variant };
}

/** Check, plan, reserve the render id and queue a `render` job. */
export async function submitRenderJob(
  ctx: SubmitContext,
  req: RenderRequest,
): Promise<
  { job: JobRecord; render_id: string; run_id: string; variant: string; duration_s: number; warnings: string[]; untrusted?: { passed_over: PassedOverRuns } } & RenderEditSource & LatestRunNotice
> {
  const { project, planned, overrides, source } = await planRenderRequest(ctx.ws, ctx.cli, req);
  if (req.expect_edit_sha256 !== undefined) await checkShownEdit(project, req.scenario, planned, req.expect_edit_sha256);
  const ed = await editor();
  const timelineSha = sha256Hex(await readFile(join(planned.run.dir, 'timeline.json')));
  const scenario = planned.timeline.scenario;
  const dir = ed.rendersDir(project);
  await mkdir(dir, { recursive: true });
  const { version, release } = await ed.reserveVersion(dir, scenario, `submitted by ${ctx.client} (pid ${process.pid})`);
  const renderId = formatRenderId(scenario, version, planned.plan.variant);
  const input: RenderJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'render',
    project: project.slug,
    scenario,
    run_id: planned.run.id,
    timeline_sha256: timelineSha,
    ...(planned.edit.sha256 ? { edit_sha256: planned.edit.sha256 } : {}),
    render_id: renderId,
    ...(req.template !== undefined ? { template: req.template } : {}),
    overrides,
    ...(req.review ? { review: { fps: req.review.fps } } : {}),
    submitted_by: ctx.client,
  };
  // B5: the text the edit was planned from goes with the job (written before job.json: the worker never sees one without it).
  const snapshot = planned.edit.sha256 && planned.editText !== undefined && sha256Hex(planned.editText) === planned.edit.sha256 ? planned.editText : undefined;
  let job: JobRecord;
  try {
    job = await ctx.queue.enqueue(input, snapshot !== undefined ? { files: { [EDIT_SNAPSHOT_FILE]: snapshot } } : {});
  } catch (e) {
    // Nothing will render it: the id is free again.
    await release();
    throw e;
  }
  const plan = planned.plan;
  const latest = latestNoticeOf(planned);
  return {
    job,
    render_id: renderId,
    run_id: planned.run.id,
    variant: plan.variant,
    duration_s: Math.round((plan.durationInFrames / plan.fps) * 1000) / 1000,
    warnings: plan.warnings,
    ...source,
    ...latest.notice,
    ...(latest.passed.length ? { untrusted: { passed_over: latest.passed } } : {}),
  };
}

/** Remove the version lock a render job reserved (a cancel before it started, an early failure). */
export async function releaseRenderLock(ws: OpenedWorkspace, input: Pick<RenderJobInput, 'project' | 'scenario' | 'render_id'>): Promise<void> {
  const project = await openProjectBySlug(ws, input.project);
  const ed = await editor();
  const { version } = renderVersionOf(input.render_id, input.scenario);
  await rm(ed.versionLockFile(ed.rendersDir(project), input.scenario, version), { force: true });
}

/** A render browser recorded by a job: its process identity and its temporary profile folder. */
export interface RecordedBrowser extends ProcessIdentity {
  user_data_dir?: string;
}

/** A temporary Chromium profile Remotion created (the only folder this cleanup removes). */
function isTempProfile(dir: string): boolean {
  return dirname(dir) === tmpdir().replace(/\/$/, '') && /^puppeteer_dev_chrome_profile-[A-Za-z0-9]+$/.test(basename(dir));
}

/**
 * After a render job was interrupted (its worker killed): kill the render browser it recorded when it still runs (same
 * pid AND start time: Remotion starts it detached, so it outlives its parent), remove its temporary profile, the
 * version lock and the partial video files — and, after an inline review, the review folder put back in order (the
 * reviewer's `recover`). Best effort: what fails is logged.
 */
export async function cleanupInterruptedRender(ws: OpenedWorkspace, files: JobFiles, job: JobRecord, log: (m: string) => void, reviewer: Reviewer): Promise<void> {
  if (job.input.kind !== 'render') return;
  const input = job.input;
  await killRecordedBrowser(files, job, log);
  try {
    await releaseRenderLock(ws, input);
    const project = await openProjectBySlug(ws, input.project);
    await removePartials(projectPath(project.dir, 'renders'), `.${input.render_id}.partial-`);
    // A worker killed during the inline review (L4.5): the previous review set aside comes back.
    if (input.review) await reviewer.recover(projectPath(project.dir, 'review', input.render_id));
  } catch (e) {
    log(`job ${job.id}: render leftovers not removed (${(e as Error).message})`);
  }
}

/** Remove the files of `dir` whose name starts with `prefix` (partial videos of a killed render). */
export async function removePartials(dir: string, prefix: string): Promise<void> {
  for (const f of await readdir(dir).catch(() => [] as string[])) if (f.startsWith(prefix)) await rm(join(dir, f), { force: true });
}

/**
 * The render browser a job recorded (job folder, browser.json) and left running when its worker was killed: killed when
 * it still runs as the same process (pid AND start time), and its temporary profile removed. Best effort.
 */
export async function killRecordedBrowser(files: JobFiles, job: JobRecord, log: (m: string) => void): Promise<void> {
  let browser: RecordedBrowser | undefined;
  try {
    browser = JSON.parse(await readFile(files.browser(job.id), 'utf8')) as RecordedBrowser;
  } catch {
    browser = undefined;
  }
  // signal.ts's rule (L5.14a fixes): never a pid of 0 / 1 / -1, this process or its own group.
  if (browser && signalablePid(browser.pid) && browser.started_at && (await isAlive(browser))) {
    for (const target of [-browser.pid, browser.pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        /* gone, or not a group */
      }
    }
    log(`job ${job.id}: killed the render browser it left (pid ${browser.pid})`);
  }
  if (browser?.user_data_dir && isTempProfile(browser.user_data_dir)) await rm(browser.user_data_dir, { recursive: true, force: true }).catch(() => undefined);
}

/** What the job runs with; its ports (ports.ts EnginePorts) are its composition root's, handed on by the job runner. */
export interface RenderJobContext extends EnginePorts {
  ws: OpenedWorkspace;
  cli: string;
  input: RenderJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
  /** The render browser runs: the worker records it (job folder, browser.json). */
  browser(b: BrowserProcessInfo): void;
  /** What the job renders with (the runner's: render/renderer.ts). */
  renderer: Renderer;
  /** A file the submit added to the job, read through the queue (JobQueue.jobFile): its edit.yaml snapshot, L4.5. */
  jobFile?: (name: string, maxBytes: number) => Promise<JobFileRead>;
}

/**
 * The scenario text a render job plans its edit from (L4.5, critique B5): the job's edit.yaml, read through the queue
 * without following a link, whose sha256 must be the job's `edit_sha256` (a conflict otherwise). Undefined when the job
 * has no edit of the file, or was queued by a build without snapshots (the worker then reads today's file, as before L4.5).
 */
export async function renderJobEditText(input: Pick<RenderJobInput, 'edit_sha256'>, jobFile: RenderJobContext['jobFile']): Promise<string | undefined> {
  if (!input.edit_sha256 || !jobFile) return undefined;
  const read = await jobFile(EDIT_SNAPSHOT_FILE, SCENARIO_EDIT_MAX_CHARS * 4);
  if (!read.ok) {
    if (read.reason === 'missing') return undefined;
    throw new EngineError('conflict', `the scenario snapshot of this render (${EDIT_SNAPSHOT_FILE}) cannot be read (${read.reason}): submit the render again`);
  }
  const text = read.text;
  if (sha256Hex(text) !== input.edit_sha256) {
    throw new EngineError('conflict', `the scenario snapshot of this render (${EDIT_SNAPSHOT_FILE}) is not the version it was submitted with: submit the render again`);
  }
  return text;
}

/** What the inline review of a render reports (RenderJobResult.review and its untrusted reason). */
export type InlineReview = { review: NonNullable<RenderJobResult['review']>; error?: string };

/**
 * The review of a render run inside its render job (L4.5, critique B12; the CLI's `render --review` precedent): the
 * review job's own execution with the same signal — a cancel stops it (`cancelled`: the render, already written, stays
 * the job's result and the previous review of the id comes back); any other failure is reported (`failed`, the reason
 * as untrusted text) and never fails the render. `exec` is the review job's execution (replaced in tests).
 */
export async function reviewInline(
  ctx: Pick<RenderJobContext, 'ws' | 'cli' | 'signal' | 'event' | 'progress' | keyof EnginePorts> & { input: Pick<RenderJobInput, 'project' | 'submitted_by'> },
  renderId: string,
  fps: 1 | 2,
  exec?: (c: import('./review-job.js').ReviewJobContext) => Promise<import('./types.js').ReviewJobResult>,
): Promise<InlineReview> {
  const run = exec ?? (await import('./review-job.js')).executeReviewJob;
  try {
    const r = await run({
      ws: ctx.ws,
      cli: ctx.cli,
      clock: ctx.clock,
      stores: ctx.stores,
      reads: ctx.reads,
      hooks: ctx.hooks,
      reviewer: ctx.reviewer,
      capture: ctx.capture,
      sandboxes: ctx.sandboxes,
      input: { version: JOB_INPUT_VERSION, kind: 'review', project: ctx.input.project, render_id: renderId, fps, submitted_by: ctx.input.submitted_by },
      signal: ctx.signal,
      event: ctx.event,
      // The job's phase says it is reviewing now (its fraction is the review's own).
      progress: (p) => ctx.progress({ ...p, phase: `review:${p.phase ?? ''}` }),
    });
    return { review: { state: 'succeeded', clean: r.clean, counts: r.counts, ms: r.ms } };
  } catch (e) {
    if (ctx.signal.aborted) {
      ctx.event({ type: 'log', level: 'info', message: `the review of ${renderId} was cancelled: the render is done` });
      return { review: { state: 'cancelled' } };
    }
    const message = (e as Error).message.slice(0, 2000);
    ctx.event({ type: 'log', level: 'warn', message: `the review of ${renderId} did not finish: the render is done (review it again: MCP review, or retake review)` });
    return { review: { state: 'failed' }, error: message };
  }
}

/** Execute a `render` job: the timeline check, then the pipeline's render (pipeline.ts: trust `mcp`, network guard) with the reserved id. */
export async function executeRenderJob(ctx: RenderJobContext): Promise<RenderJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  const { version, variant } = renderVersionOf(input.render_id, input.scenario);
  try {
    const sha = sha256Hex(await readFile(projectPath(project.dir, 'runs', input.run_id, 'timeline.json')));
    if (sha !== input.timeline_sha256) {
      throw new EngineError('conflict', `the timeline of run ${input.run_id} changed since the render was submitted: submit it again`, { details: { submitted: input.timeline_sha256, current: sha } });
    }
  } catch (e) {
    await releaseRenderLock(ctx.ws, input).catch(() => undefined);
    throw e;
  }
  let editText: string | undefined;
  try {
    editText = await renderJobEditText(input, ctx.jobFile);
  } catch (e) {
    await releaseRenderLock(ctx.ws, input).catch(() => undefined);
    throw e;
  }
  let last = '';
  // The pipeline's render that the CLI's `retake render` runs too, with the trust of work submitted through MCP and its reserved id.
  const record = await renderWork({
    renderer: ctx.renderer,
    workPolicy: ctx.ws.policy,
    project,
    run: input.run_id,
    scenario: input.scenario,
    ...(input.template !== undefined ? { template: input.template } : {}),
    overrides: input.overrides as EditOverrides,
    root: ctx.ws.root,
    trust: ENGINE_TRUST,
    network: 'guard',
    signal: ctx.signal,
    reserved: { scenario: input.scenario, version, variant },
    editSha256: input.edit_sha256 ?? null,
    ...(editText !== undefined ? { editText } : {}),
    onBrowser: (b) => ctx.browser(b),
    onProgress: (p: RenderProgress) => {
      const key = `${p.stage}:${p.renderedFrames ?? ''}:${Math.round(p.overall * 100)}`;
      if (key === last) return;
      last = key;
      ctx.progress({
        steps_done: p.renderedFrames ?? 0,
        steps_total: p.totalFrames ?? 0,
        phase: p.stage,
        fraction: Math.round(p.overall * 1000) / 1000,
        ...(p.eta_s !== undefined ? { eta_s: p.eta_s } : {}),
        updated_at: stampOf(ctx.clock),
      });
    },
  });
  const reviewed = input.review ? await reviewInline(ctx, record.id, input.review.fps) : undefined;
  return {
    kind: 'render',
    render_id: record.id,
    scenario: record.scenario,
    run_id: record.run_id,
    file: record.file,
    record: record.record,
    template: record.template,
    variant: record.variant,
    duration_s: record.duration_s,
    frames: record.frames,
    width: record.width,
    height: record.height,
    size_bytes: record.size_bytes,
    bundle_cached: record.bundle.cached,
    ...(reviewed ? { review: reviewed.review } : {}),
    untrusted: { warnings: record.warnings, ...(reviewed?.error !== undefined ? { review_error: reviewed.error } : {}) },
  };
}
