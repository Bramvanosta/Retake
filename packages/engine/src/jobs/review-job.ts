/**
 * `review` jobs (L3.2, R-MCP-31): a render's review — contact sheets, per-scene sheets, key frames, checks, report.json
 * and report.md in review/<render_id>/ — submitted by a client outside the CLI and run by the jobs worker with the
 * review package's `reviewRender` (ffmpeg + sharp; no browser).
 *
 * The render is named by its id (`latest` is resolved at submit) and read from renders/<id>.json only; its video, its
 * run and the render it is compared with must lie in the project folder (the record's paths are absolute). A cancel
 * stops the review between its stages and kills ffmpeg; the previous review of the render stays as it was. No image
 * data goes into job.json: review_get makes thumbnails when it is read. The review package is imported lazily.
 */
import { JOB_INPUT_VERSION, RENDER_ID_RE, projectPath } from '@retake/core';
import type { ReviewJobInput, WorkspaceConfig } from '@retake/core';
import type { ReviewProgress } from '@retake/review';
import { EngineError } from '../errors.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug, checkScenarioName } from '../refs.js';
import { renderForWork } from '../renders.js';
import { editor, review } from '../lazy.js';
import { reviewStep } from '../production.js';
import type { SubmitContext } from './run-job.js';
import type { JobEventBody, JobProgress, JobRecord, ReviewJobResult } from './types.js';

// The lazy @retake/review (lazy.ts), re-exported for the modules that import it from here.
export { review };

export interface ReviewRequest {
  project: string;
  /** A render id, or `latest` (of `scenario`). */
  render_id: string;
  scenario?: string;
  /** Contact sheet rate (default 1). */
  fps?: 1 | 2;
  /** The render compared with: an id, false for none; default the previous render of the scenario. */
  previous?: string | false;
}

/** The `retake review` command a human runs for the same review. */
export function reviewCommandLine(cli: string, r: { project: string; render_id: string; fps?: number; previous?: string | false }): string {
  return [cli, 'review', r.project, r.render_id, ...(r.fps && r.fps !== 1 ? ['--fps', String(r.fps)] : []), ...(r.previous === false ? ['--no-previous'] : r.previous ? ['--previous', r.previous] : [])].join(' ');
}

/** Check, resolve the render (and the one compared with) and queue a `review` job. */
export async function submitReviewJob(ctx: SubmitContext, req: ReviewRequest): Promise<{ job: JobRecord; render_id: string }> {
  checkProjectSlug(req.project);
  if (req.scenario !== undefined) checkScenarioName(req.scenario);
  const fps = req.fps ?? 1;
  if (fps !== 1 && fps !== 2) throw new EngineError('invalid', `fps ${String(fps)}: the contact sheet takes 1 or 2 frames per second`);
  if (req.previous !== undefined && req.previous !== false && (typeof req.previous !== 'string' || !RENDER_ID_RE.test(req.previous))) {
    throw new EngineError('invalid', `invalid previous "${String(req.previous)}": a render id, or false for no comparison`);
  }
  const project = await openProjectBySlug(ctx.ws, req.project);
  const fix = (id: string) => reviewCommandLine(ctx.cli, { project: req.project, render_id: id, fps, ...(req.previous !== undefined ? { previous: req.previous } : {}) });
  const record = await renderForWork(project, req.render_id, { ...(req.scenario !== undefined ? { scenario: req.scenario } : {}), fix });
  if (typeof req.previous === 'string') {
    if (req.previous === record.id) throw new EngineError('invalid', `previous ${req.previous} is the render under review`);
    await renderForWork(project, req.previous, { fix });
  }
  const input: ReviewJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'review',
    project: project.slug,
    render_id: record.id,
    fps,
    ...(req.previous !== undefined ? { previous: req.previous } : {}),
    submitted_by: ctx.client,
  };
  return { job: await ctx.queue.enqueue(input), render_id: record.id };
}

/** review/<render_id>/ of a review job's project. */
export async function reviewDirOf(ws: WorkspaceConfig, input: Pick<ReviewJobInput, 'project' | 'render_id'>): Promise<string> {
  const project = await openProjectBySlug(ws, input.project);
  return projectPath(project.dir, 'review', input.render_id);
}

/** After a review job was interrupted: the previous review set aside comes back, temporary folders go. */
export async function cleanupInterruptedReview(ws: WorkspaceConfig, job: JobRecord, log: (m: string) => void): Promise<void> {
  if (job.input.kind !== 'review') return;
  try {
    const rv = await review();
    await rv.recoverReviewDir(await reviewDirOf(ws, job.input));
  } catch (e) {
    log(`job ${job.id}: review leftovers not removed (${(e as Error).message})`);
  }
}

/** Where each stage of a review lies in its overall progress. */
const STAGE_SPAN: Record<ReviewProgress['stage'], [number, number]> = {
  loading: [0, 0.03],
  frames: [0.03, 0.6],
  capture: [0.6, 0.7],
  previous: [0.7, 0.8],
  checks: [0.8, 0.85],
  sheets: [0.85, 0.95],
  writing: [0.95, 0.99],
  done: [1, 1],
};

export interface ReviewJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: ReviewJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
}

/** Execute a `review` job: the render checked again, then `reviewRender` (no thumbnails: review_get makes them). */
export async function executeReviewJob(ctx: ReviewJobContext): Promise<ReviewJobResult> {
  const { input } = ctx;
  const rv = await review();
  const project = await openProjectBySlug(ctx.ws, input.project);
  const fix = (id: string) => reviewCommandLine(ctx.cli, { project: input.project, render_id: id, fps: input.fps, ...(input.previous !== undefined ? { previous: input.previous } : {}) });
  const record = await renderForWork(project, input.render_id, { fix });
  let previous: string | false;
  if (typeof input.previous === 'string') previous = (await renderForWork(project, input.previous, { fix })).id;
  else if (input.previous === false) previous = false;
  else {
    // The default comparison: the previous render of the scenario, when it may be read (else none).
    const found = await rv.findPrevious(project, record, undefined);
    const ed = await editor();
    const problem = found ? ed.recordPathProblem(project.dir, found) : null;
    if (problem) ctx.event({ type: 'log', level: 'warn', message: `not compared with ${found!.id}: its files are outside the project` });
    previous = found && !problem ? found.id : false;
  }
  let last = '';
  // The review step the CLI's `retake review` runs too.
  const result = await reviewStep({
    project,
    root: ctx.ws.root,
    render: record.id,
    fps: input.fps,
    previous,
    thumbnails: false,
    signal: ctx.signal,
    onProgress: (p) => {
      const [a, b] = STAGE_SPAN[p.stage];
      const fraction = Math.round((a + (b - a) * (p.progress ?? 0)) * 1000) / 1000;
      const key = `${p.stage}:${fraction}`;
      if (key === last) return;
      last = key;
      ctx.progress({ steps_done: 0, steps_total: 0, phase: p.stage, fraction, updated_at: new Date().toISOString() });
    },
  });
  return {
    kind: 'review',
    render_id: record.id,
    dir: result.files.dir,
    report: result.files.report_json,
    clean: result.clean,
    counts: result.counts,
    duration_s: result.render.duration_s,
    ms: result.review.ms,
  };
}
