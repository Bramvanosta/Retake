/**
 * The pipeline's work done in this process, without a job — what the CLI's commands produce: a render, a still, an
 * export, a run, an inspection. Each one is the shared call (pipeline.ts, execute-run.ts, runInspection), then its line
 * of the workspace's history (history.jsonl), written once that call returned, before the caller prints anything: the
 * same line as before these functions, kind by kind (`submitted_by: cli`, what it counted). A render, a still and an
 * export draw with the renderer the caller hands (render/renderer.ts).
 *
 * The history has one writer per kind of line: the worker writes the line of a finished job (historyOf in
 * jobs/run-job-record.ts), these functions the line of a CLI command, record.ts the line of `retake record`. Each
 * option bag carries the caller's `clock` (the CLI's `cliPorts`): what a line without its own `at` is stamped with.
 */
import type { LoadedProject } from '@retake/core/model';
import type { RunRecord } from '@retake/core/run';
import { executeRun } from './execute-run.js';
import type { ExecuteRunOptions, PreparedRun, RunPorts, RunRequest } from './execute-run.js';
import type { Clock } from './clock.js';
import { appendHistory, runCounted } from './history.js';
import type { HistoryEntry } from './history.js';
import { INSPECT_KEEP, pruneInspections, runInspection } from './jobs/inspect-job.js';
import type { InspectionOptions, InspectionRun } from './jobs/inspect-job.js';
import type { JobQueueView } from './jobs/job-queue.js';
import { exportWork, renderWork, stillWork } from './pipeline.js';
import type { ExportRenderOptions, ExportResult, OnRenderer, RenderRecord, RenderStillOptions, RenderVideoOptions } from './pipeline.js';

/** Who submits the work done in process, without a job: the CLI (a person at a terminal). */
const IN_PROCESS: HistoryEntry['submitted_by'] = 'cli';

/** Nothing captured nor dry-run, `renders` rendered (the Remotion usage a licence would track). */
const rendered = (renders: number): HistoryEntry['counted'] => ({ captures: 0, dry_runs: 0, renders });

/** Render without a job (the CLI's `retake render`): the pipeline's render, then the history line of a render. */
export async function renderInProcess(o: OnRenderer<RenderVideoOptions> & { project: LoadedProject; root: string; clock: Clock }): Promise<RenderRecord> {
  // The clock is the history's, never handed to the editor (its options stay what they were).
  const { clock, ...work } = o;
  const record = await renderWork(work);
  await appendHistory(o.root, { kind: 'render', project: o.project.slug, submitted_by: IN_PROCESS, state: 'succeeded', ms: record.timings.total_ms, counted: rendered(1) }, clock);
  return record;
}

/** A still without a job (`retake still`): the pipeline's still, then the history line of a still (a render too). */
export async function stillInProcess(o: OnRenderer<RenderStillOptions> & { root: string; project: Pick<LoadedProject, 'slug'>; clock: Clock }): Promise<string> {
  const { project, clock, ...still } = o;
  const t0 = performance.now();
  const file = await stillWork(still);
  await appendHistory(o.root, { kind: 'still', project: project.slug, submitted_by: IN_PROCESS, state: 'succeeded', ms: Math.round(performance.now() - t0), counted: rendered(1) }, clock);
  return file;
}

/**
 * An export without a job (`retake export`): the pipeline's export, then — when it re-rendered formats through the planner (vertical,
 * square, 4K from a smaller master) — the history line of an export counting them; transcodes count nothing.
 */
export async function exportInProcess(o: OnRenderer<ExportRenderOptions> & { project: LoadedProject; root: string; clock: Clock }): Promise<ExportResult> {
  const { clock, ...work } = o;
  const result = await exportWork(work);
  const renders = result.outputs.filter((x) => x.method === 'render').length;
  if (renders) await appendHistory(o.root, { kind: 'export', project: o.project.slug, submitted_by: IN_PROCESS, state: 'succeeded', counted: rendered(renders) }, clock);
  return result;
}

/** A run without a job (`retake run`): executeRun, then the history line of the run it recorded (a failed run included). */
export async function runInProcess(p: PreparedRun, req: RunRequest, opts: ExecuteRunOptions & { clock: Clock }, ports: RunPorts): Promise<RunRecord> {
  const { clock, ...run } = opts;
  const record = await executeRun(p, req, run, ports);
  await appendHistory(p.ws.root, {
    kind: 'run',
    project: p.project.slug,
    submitted_by: IN_PROCESS,
    state: record.status === 'cancelled' ? 'cancelled' : 'succeeded',
    ...(record.finished_at ? { at: record.finished_at, ms: Date.parse(record.finished_at) - Date.parse(record.started_at) } : {}),
    run: { id: record.id, scenario: record.scenario, mode: record.mode, status: record.status },
    counted: runCounted(record.mode, record.status),
  }, clock);
  return record;
}

/**
 * An inspection without a job (`retake inspect`): runInspection, then — when its folder is the project's
 * (`pruneUnlessOpenIn`: the workspace's job queue, whose open inspections stay) — the older inspections pruned, then the
 * history line (it counts nothing: a dry replay to read a page).
 */
export async function inspectInProcess(o: InspectionOptions & { root: string; clock: Clock; pruneUnlessOpenIn?: JobQueueView }): Promise<InspectionRun> {
  const { root, clock, pruneUnlessOpenIn, ...inspection } = o;
  const { project } = o.prepared;
  const started = Date.now();
  const run = await runInspection(inspection);
  if (pruneUnlessOpenIn) await pruneInspections(project, INSPECT_KEEP, [o.id], pruneUnlessOpenIn);
  const r = run.report;
  await appendHistory(root, {
    kind: 'inspect',
    project: project.slug,
    submitted_by: IN_PROCESS,
    state: run.record.status === 'cancelled' ? 'cancelled' : 'succeeded',
    ms: Date.now() - started,
    inspect: { id: o.id, source: o.prepared.source.kind, status: r ? r.status : 'failed', reported: r !== null },
    counted: rendered(0),
  }, clock);
  return run;
}
