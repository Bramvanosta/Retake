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
import { EditOverridesInputSchema, JOB_INPUT_VERSION, SCENARIO_EDIT_MAX_CHARS, TEMPLATE_NAME_RE } from '@retake/core';
import type { EditOverridesInput, LoadedProject, RenderJobInput, WorkspaceConfig } from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import type { BrowserProcessInfo, EditOverrides, PlannedRun, RenderProgress } from '@retake/editor';
import { EngineError, toEngineError } from '../errors.js';
import { openProjectBySlug } from '../projects.js';
import { RUN_ID_RE, checkProjectSlug, checkRunId, checkScenarioName } from '../refs.js';
import { sha256Hex } from '../storage.js';
import { isAlive } from './proc.js';
import { signalablePid } from './signal.js';
import type { ProcessIdentity } from './proc.js';
import type { SubmitContext } from './run-job.js';
import type { JobFileRead } from './job-queue.js';
import type { JobFiles } from './queue.js';
import type { JobEventBody, JobProgress, JobRecord, RenderJobResult } from './types.js';

/** Lazy: @retake/editor pulls in Remotion's renderer and bundler. */
export const editor = () => import('@retake/editor');

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
  if (req.template !== undefined && (typeof req.template !== 'string' || !TEMPLATE_NAME_RE.test(req.template) || req.template.length > 100)) {
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
 * Plan a render request in this process (no browser), through the trust gates of work submitted through MCP. A
 * refusal is EngineError `refused` with the `retake render` command a human runs. The plan's edit comes from today's
 * scenario file when its filmed part is unchanged since the run, else from the run as captured (L5.5, editor planRun):
 * `source` says which and what changed. `editText` (L4.6): a text read instead of today's file (a proposal's preview).
 */
export async function planRenderRequest(
  ws: WorkspaceConfig,
  cli: string,
  req: RenderRequest,
  o: { registry?: ComponentRegistry; musicLength?: (file: string) => Promise<number | undefined>; editText?: string } = {},
): Promise<{ project: LoadedProject; planned: PlannedRun; overrides: EditOverridesInput; source: RenderEditSource }> {
  const overrides = checkRenderRequest(req);
  const project = await openProjectBySlug(ws, req.project);
  const ed = await editor();
  try {
    const planned = await ed.planRun({
      project,
      run: req.run_id ?? 'latest',
      scenario: req.scenario,
      ...(req.template !== undefined ? { template: req.template } : {}),
      overrides: overrides as EditOverrides,
      root: ws.root,
      trust: 'mcp',
      ...(o.registry ? { registry: o.registry } : {}),
      ...(o.musicLength ? { musicLength: o.musicLength } : {}),
      // L4.6 (critique B9): a proposal previewed in the timeline is planned from its text in memory, never written.
      ...(o.editText !== undefined ? { editText: o.editText } : {}),
    });
    // The run id reaches trusted summaries: `latest` picks only run ids (editor findRun); never one of another shape.
    if (!RUN_ID_RE.test(planned.run.id) || planned.run.id.length > 200) {
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
    throw new EngineError('conflict', `scenarios/${scenario} changed since it was shown: look at the timeline again, then render`, {
      details: { shown, ...(now !== undefined ? { current: now } : {}) },
    });
  }
}

/** The version and variant a render id names ("quote-v3-vertical" → 3, vertical). */
export function parseRenderId(renderId: string, scenario: string): { version: number; variant: 'landscape' | 'vertical' | 'square' } {
  const m = /-v(\d+)(-vertical|-square)?$/.exec(renderId);
  if (!m || renderId.slice(0, m.index) !== scenario) throw new EngineError('invalid', `render id ${renderId} is not a render of scenario ${scenario}`);
  return { version: Number(m[1]), variant: m[2] === '-vertical' ? 'vertical' : m[2] === '-square' ? 'square' : 'landscape' };
}

/** Check, plan, reserve the render id and queue a `render` job. */
export async function submitRenderJob(
  ctx: SubmitContext,
  req: RenderRequest,
): Promise<{ job: JobRecord; render_id: string; run_id: string; variant: string; duration_s: number; warnings: string[] } & RenderEditSource> {
  const { project, planned, overrides, source } = await planRenderRequest(ctx.ws, ctx.cli, req);
  if (req.expect_edit_sha256 !== undefined) await checkShownEdit(project, req.scenario, planned, req.expect_edit_sha256);
  const ed = await editor();
  const timelineSha = sha256Hex(await readFile(join(planned.run.dir, 'timeline.json')));
  const scenario = planned.timeline.scenario;
  const dir = ed.rendersDir(project);
  await mkdir(dir, { recursive: true });
  const { version, release } = await ed.reserveVersion(dir, scenario, `submitted by ${ctx.client} (pid ${process.pid})`);
  const renderId = `${scenario}-v${version}${ed.VARIANT_SUFFIX[planned.plan.variant]}`;
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
  return {
    job,
    render_id: renderId,
    run_id: planned.run.id,
    variant: plan.variant,
    duration_s: Math.round((plan.durationInFrames / plan.fps) * 1000) / 1000,
    warnings: plan.warnings,
    ...source,
  };
}

/** Remove the version lock a render job reserved (a cancel before it started, an early failure). */
export async function releaseRenderLock(ws: WorkspaceConfig, input: Pick<RenderJobInput, 'project' | 'scenario' | 'render_id'>): Promise<void> {
  const project = await openProjectBySlug(ws, input.project);
  const ed = await editor();
  const { version } = parseRenderId(input.render_id, input.scenario);
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
 * version lock and the partial video files. Best effort: what fails is logged.
 */
export async function cleanupInterruptedRender(ws: WorkspaceConfig, files: JobFiles, job: JobRecord, log: (m: string) => void): Promise<void> {
  if (job.input.kind !== 'render') return;
  const input = job.input;
  await killRecordedBrowser(files, job, log);
  try {
    await releaseRenderLock(ws, input);
    const project = await openProjectBySlug(ws, input.project);
    await removePartials(join(project.dir, 'renders'), `.${input.render_id}.partial-`);
    // A worker killed during the inline review (L4.5): the previous review set aside comes back.
    if (input.review) await (await import('./review-job.js')).review().then((rv) => rv.recoverReviewDir(join(project.dir, 'review', input.render_id)));
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

export interface RenderJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: RenderJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
  /** The render browser runs: the worker records it (job folder, browser.json). */
  browser(b: BrowserProcessInfo): void;
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
  ctx: Pick<RenderJobContext, 'ws' | 'cli' | 'signal' | 'event' | 'progress'> & { input: Pick<RenderJobInput, 'project' | 'submitted_by'> },
  renderId: string,
  fps: 1 | 2,
  exec?: (c: import('./review-job.js').ReviewJobContext) => Promise<import('./types.js').ReviewJobResult>,
): Promise<InlineReview> {
  const run = exec ?? (await import('./review-job.js')).executeReviewJob;
  try {
    const r = await run({
      ws: ctx.ws,
      cli: ctx.cli,
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

/** Execute a `render` job: the timeline check, then `renderVideo` (trust `mcp`, network guard) with the reserved id. */
export async function executeRenderJob(ctx: RenderJobContext): Promise<RenderJobResult> {
  const { input } = ctx;
  const ed = await editor();
  const project = await openProjectBySlug(ctx.ws, input.project);
  const { version, variant } = parseRenderId(input.render_id, input.scenario);
  try {
    const sha = sha256Hex(await readFile(join(project.dir, 'runs', input.run_id, 'timeline.json')));
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
  const record = await ed.renderVideo({
    project,
    run: input.run_id,
    scenario: input.scenario,
    ...(input.template !== undefined ? { template: input.template } : {}),
    overrides: input.overrides as EditOverrides,
    root: ctx.ws.root,
    trust: 'mcp',
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
        updated_at: new Date().toISOString(),
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
