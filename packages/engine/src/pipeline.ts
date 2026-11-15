/**
 * The pipeline, run in this process: plan, render, still, export and review — one function each, shared by the CLI's
 * commands (through in-process.ts: they run no job) and the worker's jobs (render-job.ts, export-job.ts, review-job.ts).
 * Each is the engine's render use case (render/render-video.ts) or the adapter's own call (the editor's planRun /
 * renderStill / exportRender, the reviewer's review) behind the engine's lazy imports or its ports: the caller passes its own options — trust, network guard and
 * reserved id for a job; output location and concurrency for the CLI — and gets the adapter's result and errors
 * unchanged. What renders takes the renderer to draw with (render/renderer.ts), what reviews the reviewer
 * (review/reviewer.ts): only a composition root chooses them. A run
 * and an inspection have theirs already (executeRun in execute-run.ts, runInspection in jobs/inspect-job.ts). None
 * writes the history: the worker writes a job's line, in-process.ts the CLI's.
 */
import { RENDER_VARIANT_SUFFIX } from '@retake/core/ids';
import { join } from 'node:path';
import { OUTPUT_DIRS } from './outputs/outputs.js';
import type { LoadedProject } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import type { EditOverrides, ExportProgress, RenderProgress, RenderRecord } from '@retake/editor/plan';
import type { ExportFormat, ExportRenderOptions, ExportResult, FoundRender, PlannedRun, RenderStillOptions, RunRef } from './render/editor-calls.js';
import type { RenderVideoOptions } from './render/render-video.js';
import type { ReviewResult } from '@retake/review/checks';
import { summarizePlan } from '@retake/editor/plan';
import { findRunOf, planWork } from './render/editor-calls.js';

export type {
  EditOverrides,
  ExportFormat,
  ExportProgress,
  ExportRenderOptions,
  ExportResult,
  FoundRender,
  PlannedRun,
  RenderProgress,
  RenderRecord,
  RenderStillOptions,
  RenderVideoOptions,
  ReviewResult,
  RunRef,
};

// ── the pipeline ──

// Planning a run's edit, the run and render lookups and the editor's errors are the render home's (render/editor-calls.ts).
export { editorErrorOf, findRenderOf, findRunOf, planWork } from './render/editor-calls.js';

/** What `planOfRun` is asked: the run's scenario (with `latest`), a theme in place of the run's, the overrides, who asks. */
export interface PlanOfRunOptions {
  /** With `latest`: the latest capture of this scenario; else the run must be of it. */
  scenario?: string;
  /** A theme (a name, or a ./path for a person) instead of the one the run used. */
  theme?: string;
  /** The frame, the variant… (`theme` is set to the theme's name when one is asked). */
  overrides?: EditOverrides;
  /**
   * A person at a terminal only (no trust gate: a theme may be a ./path). The run is resolved as a terminal resolves it
   * (findRun), so work an agent asks never comes through here: plan_preview and the render submit plan under `mcp`.
   */
  trust: 'author';
  /** The run found, before anything of it is read: what a terminal says of `latest` comes before any refusal. */
  onRun?: (run: RunRef) => void;
}

/**
 * A run's edit plan, on its own (`retake plan`, L7.22): the run found by the rule every reader of runs shares (findRunOf:
 * an id, a directory or `latest`), then the planning of a render (planWork: the edit of today's scenario file when
 * its filmed part is unchanged, the theme, the registry, the planner) — for a plan alone (`purpose: 'plan'`: its
 * refusals say plan, a run without its film plans, no music measured). With the summary's lines (the editor's
 * summarizePlan), so a shell prints it without the editor. The plan of plan_preview and of a render is the same
 * function with `purpose: 'render'`.
 */
export async function planOfRun(ws: { root: string; policy: WorkPolicy }, project: LoadedProject, runArg: string, o: PlanOfRunOptions): Promise<PlannedRun & { summary: string[] }> {
  const run = await findRunOf(project, runArg, o.scenario);
  o.onRun?.(run);
  const planned = await planWork({
    workPolicy: ws.policy,
    project,
    run,
    ...(o.scenario !== undefined ? { scenario: o.scenario } : {}),
    ...(o.theme !== undefined ? { template: o.theme } : {}),
    overrides: o.overrides ?? {},
    root: ws.root,
    trust: o.trust,
    measureMusic: false,
    purpose: 'plan',
  });
  return { ...planned, summary: summarizePlan(planned.plan) };
}

// What renders — a video, a still, an export's re-rendered formats — runs on the renderer its caller hands (render/work.ts).
export { exportWork, renderWork, stillWork } from './render/work.js';
export type { ExportWorkOptions, OnRenderer } from './render/work.js';

// What reviews a render runs on the reviewer its caller hands (review/work.ts).
export { reviewWork } from './review/work.js';

// ── lookups and errors of the pipeline, for a caller that does not load the adapters itself ──

/** Where a still of `scenario` goes by default: renders/stills/<scenario><variant suffix>-f<frame, 5 digits>.png. */
export async function defaultStillFile(project: Pick<LoadedProject, 'dir'>, scenario: string, variant: PlannedRun['plan']['variant'], frame: number): Promise<string> {
  return join(OUTPUT_DIRS.renders(project.dir), 'stills', `${scenario}${RENDER_VARIANT_SUFFIX[variant]}-f${String(frame).padStart(5, '0')}.png`);
}
