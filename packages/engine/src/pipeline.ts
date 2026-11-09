/**
 * The pipeline, run in this process: plan, render, still, export and review — one function each, shared by the CLI's
 * commands (through in-process.ts: they run no job) and the worker's jobs (render-job.ts, export-job.ts, review-job.ts).
 * Each is the adapter's own call (the editor's planRun / renderVideo / renderStill / exportRender, the review's
 * reviewRender) behind the engine's lazy imports: the caller passes its own options — trust, network guard and reserved
 * id for a job; output location and concurrency for the CLI — and gets the adapter's result and errors unchanged. A run
 * and an inspection have theirs already (executeRun in execute-run.ts, runInspection in jobs/inspect-job.ts). None
 * writes the history: the worker writes a job's line, in-process.ts the CLI's.
 */
import { projectPath } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import type {
  EditOverrides,
  ExportFormat,
  ExportProgress,
  ExportRenderOptions,
  ExportResult,
  PlanRunOptions,
  PlannedRun,
  RenderProgress,
  RenderRecord,
  RenderStillOptions,
  RenderVideoOptions,
  RunRef,
} from '@retake/editor';
import type { ReviewOptions, ReviewResult } from '@retake/review';
import { editor, review } from './lazy.js';

export type { EditOverrides, ExportFormat, ExportProgress, ExportRenderOptions, ExportResult, PlannedRun, RenderProgress, RenderRecord, RenderStillOptions, RenderVideoOptions, ReviewResult, RunRef };

// ── the pipeline ──

/** Plan a run's edit (the editor's planRun: no browser). */
export async function planWork(o: PlanRunOptions): Promise<PlannedRun> {
  return (await editor()).planRun(o);
}

/** Render a run into renders/<scenario>-v<N>.mp4 + .json (the editor's renderVideo). */
export async function renderWork(o: RenderVideoOptions): Promise<RenderRecord> {
  return (await editor()).renderVideo(o);
}

/** Render one output frame of a plan to a PNG (the editor's renderStill). */
export async function stillWork(o: RenderStillOptions): Promise<string> {
  return (await editor()).renderStill(o);
}

/** Export a render's delivery files into exports/<render-id>/ (the editor's exportRender). */
export async function exportWork(o: ExportRenderOptions): Promise<ExportResult> {
  return (await editor()).exportRender(o);
}

/** Review a render into review/<render-id>/ (the review's reviewRender). */
export async function reviewWork(o: ReviewOptions): Promise<ReviewResult> {
  return (await review()).reviewRender(o);
}

// ── lookups and errors of the pipeline, for a caller that does not load the adapters itself ──

/** The run a render works on: a run id, a run directory or `latest` of `scenario` (the editor's findRun; RenderError otherwise). */
export async function findRunOf(project: LoadedProject, arg: string, scenario?: string): Promise<RunRef> {
  return (await editor()).findRun(project, arg, scenario);
}

/** The render record named: `latest` (of `scenario`), an id, or a .json / .mp4 path (the editor's findRenderRecord; ExportError otherwise). */
export async function findRenderOf(project: LoadedProject, arg: string, scenario?: string): Promise<RenderRecord> {
  return (await editor()).findRenderRecord(project, arg, scenario);
}

/** Where a still of `scenario` goes by default: renders/stills/<scenario><variant suffix>-f<frame, 5 digits>.png. */
export async function defaultStillFile(project: Pick<LoadedProject, 'dir'>, scenario: string, variant: PlannedRun['plan']['variant'], frame: number): Promise<string> {
  const { VARIANT_SUFFIX } = await editor();
  return projectPath(project.dir, 'renders', 'stills', `${scenario}${VARIANT_SUFFIX[variant]}-f${String(frame).padStart(5, '0')}.png`);
}

/**
 * Which of the editor's own errors `e` is: a cancelled render (`render_cancelled`), another render error (`render`: a
 * failed render, an unknown run, a plan refused…), an export error (`export`); undefined for anything else.
 */
export async function editorErrorOf(e: unknown): Promise<'render_cancelled' | 'render' | 'export' | undefined> {
  if (!(e instanceof Error)) return undefined;
  const ed = await editor();
  if (e instanceof ed.RenderCancelledError) return 'render_cancelled';
  if (e instanceof ed.RenderError) return 'render';
  if (e instanceof ed.ExportError) return 'export';
  return undefined;
}
