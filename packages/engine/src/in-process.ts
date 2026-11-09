/**
 * The production operations of work done in this process, without a job — what the CLI's commands produce: a render, a
 * still, an export, a run, an inspection. Each one is the shared step (production.ts, execute-run.ts, runInspection),
 * then its line of the workspace's history (history.jsonl), written once the step returned, before the caller prints
 * anything: the same line as before these operations, kind by kind (`submitted_by: cli`, what it counted).
 *
 * The history has one writer per kind of line: the worker writes the line of a finished job (historyOf in
 * jobs/run-job-record.ts), these operations the line of a CLI command, record.ts the line of `retake record`.
 */
import type { LoadedProject, RunRecord } from '@retake/core';
import { executeRun } from './execute-run.js';
import type { ExecuteRunOptions, PreparedRun, RunPorts, RunRequest } from './execute-run.js';
import { appendHistory, runCounted } from './history.js';
import type { HistoryEntry } from './history.js';
import { INSPECT_KEEP, pruneInspections, runInspection } from './jobs/inspect-job.js';
import type { InspectionOptions, InspectionRun } from './jobs/inspect-job.js';
import type { JobQueueView } from './jobs/job-queue.js';
import { exportStep, renderStep, stillStep } from './production.js';
import type { ExportRenderOptions, ExportResult, RenderRecord, RenderStillOptions, RenderVideoOptions } from './production.js';

/** Who submits the work done in process, without a job: the CLI (a person at a terminal). */
const IN_PROCESS: HistoryEntry['submitted_by'] = 'cli';

/** Nothing captured nor dry-run, `renders` rendered (the Remotion usage a licence would track). */
const rendered = (renders: number): HistoryEntry['counted'] => ({ captures: 0, dry_runs: 0, renders });

/** Render without a job (the CLI's `retake render`): the step, then the history line of a render. */
export async function renderInProcess(o: RenderVideoOptions & { project: LoadedProject; root: string }): Promise<RenderRecord> {
  const record = await renderStep(o);
  await appendHistory(o.root, { kind: 'render', project: o.project.slug, submitted_by: IN_PROCESS, state: 'succeeded', ms: record.timings.total_ms, counted: rendered(1) });
  return record;
}

/** A still without a job (`retake still`): the step, then the history line of a still (a render too). */
export async function stillInProcess(o: RenderStillOptions & { root: string; project: Pick<LoadedProject, 'slug'> }): Promise<string> {
  const { project, ...still } = o;
  const t0 = performance.now();
  const file = await stillStep(still);
  await appendHistory(o.root, { kind: 'still', project: project.slug, submitted_by: IN_PROCESS, state: 'succeeded', ms: Math.round(performance.now() - t0), counted: rendered(1) });
  return file;
}

/**
 * An export without a job (`retake export`): the step, then — when it re-rendered formats through the planner (vertical,
 * square, 4K from a smaller master) — the history line of an export counting them; transcodes count nothing.
 */
export async function exportInProcess(o: ExportRenderOptions & { project: LoadedProject; root: string }): Promise<ExportResult> {
  const result = await exportStep(o);
  const renders = result.outputs.filter((x) => x.method === 'render').length;
  if (renders) await appendHistory(o.root, { kind: 'export', project: o.project.slug, submitted_by: IN_PROCESS, state: 'succeeded', counted: rendered(renders) });
  return result;
}

/** A run without a job (`retake run`): executeRun, then the history line of the run it recorded (a failed run included). */
export async function runInProcess(p: PreparedRun, req: RunRequest, opts: ExecuteRunOptions, ports: RunPorts): Promise<RunRecord> {
  const record = await executeRun(p, req, opts, ports);
  await appendHistory(p.ws.root, {
    kind: 'run',
    project: p.project.slug,
    submitted_by: IN_PROCESS,
    state: record.status === 'cancelled' ? 'cancelled' : 'succeeded',
    ...(record.finished_at ? { at: record.finished_at, ms: Date.parse(record.finished_at) - Date.parse(record.started_at) } : {}),
    run: { id: record.id, scenario: record.scenario, mode: record.mode, status: record.status },
    counted: runCounted(record.mode, record.status),
  });
  return record;
}

/**
 * An inspection without a job (`retake inspect`): runInspection, then — when its folder is the project's
 * (`prune`: the queue whose open inspections stay) — the older inspections pruned, then the history line (it counts
 * nothing: a dry replay to read a page).
 */
export async function inspectInProcess(o: InspectionOptions & { root: string; prune?: JobQueueView }): Promise<InspectionRun> {
  const { root, prune, ...inspection } = o;
  const { project } = o.prepared;
  const started = Date.now();
  const run = await runInspection(inspection);
  if (prune) await pruneInspections(project, INSPECT_KEEP, [o.id], prune);
  const r = run.report;
  await appendHistory(root, {
    kind: 'inspect',
    project: project.slug,
    submitted_by: IN_PROCESS,
    state: run.record.status === 'cancelled' ? 'cancelled' : 'succeeded',
    ms: Date.now() - started,
    inspect: { id: o.id, source: o.prepared.source.kind, status: r ? r.status : 'failed', reported: r !== null },
    counted: rendered(0),
  });
  return run;
}
