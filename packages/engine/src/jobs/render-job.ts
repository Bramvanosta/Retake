/**
 * `render` jobs (L3.2, R-MCP-29): a render submitted by a client outside the CLI (the MCP server) and executed by the
 * jobs worker with the engine's render use case (render/render-video.ts), guarded (trust `mcp`, network guard).
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
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { formatRenderId, renderIdOf } from '@retake/core/ids';
import { projectRef } from '@retake/core/project';
import { SCENARIO_EDIT_MAX_CHARS } from '@retake/core/scenario';
import { JOB_INPUT_VERSION } from './job-input.js';
import type { RenderVariant } from '@retake/core/ids';
import type { LoadedProject } from '@retake/core/model';
import type { RenderJobInput } from './job-input.js';
import type { BrowserProcessInfo, EditOverrides, RenderProgress } from '@retake/editor/plan';
import type { PlannedRun } from '../render/editor-calls.js';
import { latestNoticeOf, planRenderRequest } from '../render-request.js';
import type { RenderRequest, RenderEditSource, LatestRunNotice, PassedOverRuns } from '../render-request.js';
export { renderCommandLine, checkRenderRequest, editSourceOf, latestNoticeOf, planRenderRequest } from '../render-request.js';
export type { RenderRequest, RenderEditSource, LatestRunNotice, PassedOverRuns } from '../render-request.js';
import { stampOf } from '../clock.js';
import { ENGINE_TRUST } from '../caller.js';
import { EngineError } from '../errors.js';
import { openProjectBySlug } from '../projects.js';
import { sha256Hex } from '../storage.js';
import { isAlive } from './proc.js';
import { signalablePid } from './signal.js';
import type { SubmitContext } from './run-job.js';
import type { JobFileRead, JobQueue } from './job-queue.js';
import type { JobEventBody, JobProgress, JobRecord, RenderJobResult } from './types.js';

import { releaseVersion, reserveVersion } from '../render/versions.js';
import { renderWork } from '../pipeline.js';
import type { Renderer } from '../render/renderer.js';
import type { Reviewer } from '../review/reviewer.js';
import type { OpenedWorkspace } from '../workspace.js';
import { runFolderOf } from '../outputs/outputs.js';
import type { OutputFolder, RunOutputs } from '../outputs/outputs.js';
import { portsOf } from '../ports.js';
import type { EnginePorts } from '../ports.js';
import { errorMessage } from '@retake/core/base';

/** The job folder's snapshot of the scenario text a render's edit was planned from (L4.5, critique B5). */
export const EDIT_SNAPSHOT_FILE = 'edit.yaml';

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
  const timelineSha = sha256Hex(await timelineBytes(ctx.ws.outputs.runs, planned.run.dir));
  const scenario = planned.timeline.scenario;
  const renders = ctx.ws.outputs.renders;
  const { version, release } = await reserveVersion(renders, renders.dirOf(project.dir), scenario, `submitted by ${ctx.client} (pid ${process.pid})`);
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
  const { version } = renderVersionOf(input.render_id, input.scenario);
  await releaseVersion(ws.outputs.renders, ws.outputs.renders.dirOf(project.dir), input.scenario, version);
}

/** A render browser recorded by a job: the port's word (job-queue.ts). */
export type { RecordedBrowser } from './job-queue.js';

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
export async function cleanupInterruptedRender(ws: OpenedWorkspace, queue: Pick<JobQueue, 'recordedBrowser'>, job: JobRecord, log: (m: string) => void, reviewer: Reviewer): Promise<void> {
  if (job.input.kind !== 'render') return;
  const input = job.input;
  await killRecordedBrowser(queue, job, log);
  try {
    await releaseRenderLock(ws, input);
    const project = await openProjectBySlug(ws, input.project);
    await removePartials(ws.outputs.renders, ws.outputs.renders.dirOf(project.dir), `.${input.render_id}.partial-`);
    // A worker killed during the inline review (L4.5): the previous review set aside comes back.
    if (input.review) await reviewer.recover(join(ws.outputs.reviews.dirOf(project.dir), input.render_id));
  } catch (e) {
    log(`job ${job.id}: render leftovers not removed (${errorMessage(e)})`);
  }
}

/** Remove the files of `dir` (a folder of `folder`) whose name starts with `prefix` (partial videos of a killed render): files only. */
export async function removePartials(folder: Pick<OutputFolder, 'names' | 'removeFile'>, dir: string, prefix: string): Promise<void> {
  for (const f of await folder.names(dir)) if (f.startsWith(prefix)) await folder.removeFile(join(dir, f));
}

/** The bytes of a run's timeline.json, as the render's check hashes them (read as the run's files are: through the port). */
async function timelineBytes(runs: Pick<RunOutputs, 'readBytes'>, runDir: string): Promise<Buffer> {
  const bytes = await runs.readBytes(runDir, 'timeline.json');
  if (bytes === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${join(runDir, 'timeline.json')}'`), { code: 'ENOENT' });
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The render browser a job recorded (through its queue: JobQueue.recordBrowser) and left running when its worker was
 * killed: killed when it still runs as the same process (pid AND start time), and its temporary profile removed. Best
 * effort.
 */
export async function killRecordedBrowser(queue: Pick<JobQueue, 'recordedBrowser'>, job: JobRecord, log: (m: string) => void): Promise<void> {
  const browser = await queue.recordedBrowser(job.id);
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
      ...portsOf(ctx),
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
    const message = errorMessage(e).slice(0, 2000);
    ctx.event({ type: 'log', level: 'warn', message: `the review of ${renderId} did not finish: the render is done (review it again: MCP review, or retake review)` });
    return { review: { state: 'failed' }, error: message };
  }
}

/** The render's lock released after a refusal before the render; a release that fails is said on the job. */
async function releaseLockSaying(ctx: Pick<RenderJobContext, 'ws' | 'event'>, input: RenderJobInput): Promise<void> {
  await releaseRenderLock(ctx.ws, input).catch((e: unknown) =>
    ctx.event({ type: 'log', level: 'warn', message: `the lock of ${input.render_id} could not be removed (${errorMessage(e)}): its version number stays taken, the next render uses the next one` }),
  );
}

/** Execute a `render` job: the timeline check, then the pipeline's render (pipeline.ts: trust `mcp`, network guard) with the reserved id. */
export async function executeRenderJob(ctx: RenderJobContext): Promise<RenderJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  const { version, variant } = renderVersionOf(input.render_id, input.scenario);
  try {
    const sha = sha256Hex(await timelineBytes(ctx.ws.outputs.runs, runFolderOf(project.dir, input.run_id)));
    if (sha !== input.timeline_sha256) {
      throw new EngineError('conflict', `the timeline of run ${input.run_id} changed since the render was submitted: submit it again`, { details: { submitted: input.timeline_sha256, current: sha } });
    }
  } catch (e) {
    await releaseLockSaying(ctx, input);
    throw e;
  }
  let editText: string | undefined;
  try {
    editText = await renderJobEditText(input, ctx.jobFile);
  } catch (e) {
    await releaseLockSaying(ctx, input);
    throw e;
  }
  let last = '';
  // The pipeline's render that the CLI's `retake render` runs too, with the trust of work submitted through MCP and its reserved id.
  const record = await renderWork({
    renderer: ctx.renderer,
    ws: ctx.ws,
    clock: ctx.clock,
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
