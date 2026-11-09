/**
 * `export` jobs (L3.2, R-MCP-32): delivery files of a render in exports/<render_id>/ (+ manifest.json), submitted by
 * a client outside the CLI and run by the jobs worker with the editor's `exportRender`. Formats derived from the master
 * are transcoded with ffmpeg; the others (vertical, square, 4K from a smaller master) are re-rendered through the
 * planner from the master's run, theme and overrides — under the trust rules of a render job (planRun's gates, the
 * network guard), and they count as renders in the history.
 *
 * The render is named by its id (`latest` resolved at submit) and read from renders/<id>.json only; its video and run
 * must lie in the project folder. No output location: the folder is fixed. A cancel stops between formats and kills
 * ffmpeg or the re-render; a killed worker's leftovers (the re-render's browser, partial files) are removed by the next.
 */
import { EXPORT_FORMAT_NAMES, JOB_INPUT_VERSION, projectPath } from '@retake/core';
import type { ExportFormatName, ExportJobInput, WorkspaceConfig } from '@retake/core';
import type { BrowserProcessInfo, ExportProgress } from '@retake/editor';
import { ENGINE_TRUST } from '../caller.js';
import { EngineError, toEngineError } from '../errors.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug, checkScenarioName } from '../refs.js';
import { renderForWork } from '../renders.js';
import { editor } from '../lazy.js';
import { killRecordedBrowser, removePartials } from './render-job.js';
import type { JobFiles } from './queue.js';
import type { SubmitContext } from './run-job.js';
import type { ExportJobResult, JobEventBody, JobProgress, JobRecord } from './types.js';

/** Formats exported when none are named (derived from the master: no re-render). */
export const DEFAULT_JOB_EXPORT_FORMATS: readonly ExportFormatName[] = ['mp4_1080p', 'webm', 'gif_preview'];

export interface ExportRequest {
  project: string;
  /** A render id, or `latest` (of `scenario`). */
  render_id: string;
  scenario?: string;
  formats?: readonly string[];
  gif?: { start_s?: number; duration_s?: number };
}

/** The `retake export` command a human runs for the same export. */
export function exportCommandLine(cli: string, r: { project: string; render_id: string; formats?: readonly string[] }): string {
  return [cli, 'export', r.project, r.render_id, ...(r.formats?.length ? ['--formats', r.formats.join(',')] : [])].join(' ');
}

function checkFormats(formats: readonly string[] | undefined): ExportFormatName[] {
  const list = formats && formats.length ? [...formats] : [...DEFAULT_JOB_EXPORT_FORMATS];
  for (const f of list) {
    if (!(EXPORT_FORMAT_NAMES as readonly string[]).includes(f)) throw new EngineError('invalid', `unknown export format "${String(f)}": use ${EXPORT_FORMAT_NAMES.join(', ')}`);
  }
  if (new Set(list).size !== list.length) throw new EngineError('invalid', 'each export format once');
  return list as ExportFormatName[];
}

/**
 * Check, resolve the render (then `admit` it: the engine's admission rules) and queue an `export` job. Formats that need a re-render are planned first, here (trust
 * `mcp`: a file outside the project, a theme folder, a remote slot value are refused now, with the command a human runs).
 */
export async function submitExportJob(
  ctx: SubmitContext,
  req: ExportRequest,
  o: { admit?: (renderId: string) => Promise<void> } = {},
): Promise<{ job: JobRecord; render_id: string; formats: ExportFormatName[]; rerendered: ExportFormatName[] }> {
  checkProjectSlug(req.project);
  if (req.scenario !== undefined) checkScenarioName(req.scenario);
  const formats = checkFormats(req.formats);
  const gif = req.gif;
  if (gif && ((gif.start_s !== undefined && !(gif.start_s >= 0 && gif.start_s <= 3600)) || (gif.duration_s !== undefined && !(gif.duration_s >= 0.5 && gif.duration_s <= 30)))) {
    throw new EngineError('invalid', 'gif: start_s 0–3600 s, duration_s 0.5–30 s');
  }
  const project = await openProjectBySlug(ctx.ws, req.project);
  const fix = (id: string) => exportCommandLine(ctx.cli, { project: req.project, render_id: id, formats });
  const record = await renderForWork(project, req.render_id, { ...(req.scenario !== undefined ? { scenario: req.scenario } : {}), fix });
  // The admission rules see the render this export is of once `latest` is resolved (admission.ts export_cap).
  await o.admit?.(record.id);
  const ed = await editor();
  const rerendered = formats.filter((f) => ed.exportMethod(record, f) === 'render');
  if (rerendered.length) {
    // A re-render plans the master's run with its theme and overrides: through the same gates as a render job.
    try {
      await ed.planRun({ project, run: record.run_dir, scenario: record.scenario, template: record.template, overrides: record.overrides, root: ctx.ws.root, trust: ENGINE_TRUST, measureMusic: false, ...(record.edit?.from === 'scenario' ? {} : { edit: 'run' as const }) });
    } catch (e) {
      if (e instanceof ed.PlanTrustError) throw new EngineError('refused', e.message, { fix: fix(record.id), details: { problems: e.problems } });
      throw toEngineError(e);
    }
  }
  const input: ExportJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'export',
    project: project.slug,
    render_id: record.id,
    formats,
    ...(gif && (gif.start_s !== undefined || gif.duration_s !== undefined) ? { gif: { ...(gif.start_s !== undefined ? { start_s: gif.start_s } : {}), ...(gif.duration_s !== undefined ? { duration_s: gif.duration_s } : {}) } } : {}),
    submitted_by: ctx.client,
  };
  return { job: await ctx.queue.enqueue(input), render_id: record.id, formats, rerendered };
}

/**
 * After an export job was interrupted (its worker killed): the re-render's browser it recorded is killed, and the partial
 * files of exports/<render_id>/ are removed. Best effort.
 */
export async function cleanupInterruptedExport(ws: WorkspaceConfig, files: JobFiles, job: JobRecord, log: (m: string) => void): Promise<void> {
  if (job.input.kind !== 'export') return;
  const input = job.input;
  await killRecordedBrowser(files, job, log);
  try {
    const project = await openProjectBySlug(ws, input.project);
    const dir = projectPath(project.dir, 'exports', input.render_id);
    // ".<id>-vertical.partial-<pid>.mp4" (a format) and ".<id>-vertical.partial-…" (a re-render's own temporary files).
    await removePartials(dir, `.${input.render_id}`);
  } catch (e) {
    log(`job ${job.id}: export leftovers not removed (${(e as Error).message})`);
  }
}

export interface ExportJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: ExportJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
  /** A re-render's browser runs: the worker records it (job folder, browser.json). */
  browser(b: BrowserProcessInfo): void;
}

/** Execute an `export` job: `exportRender` with trust `mcp` and the network guard (re-rendered formats). */
export async function executeExportJob(ctx: ExportJobContext): Promise<ExportJobResult> {
  const { input } = ctx;
  const ed = await editor();
  const project = await openProjectBySlug(ctx.ws, input.project);
  await renderForWork(project, input.render_id, { fix: (id) => exportCommandLine(ctx.cli, { project: input.project, render_id: id, formats: input.formats }) });
  const total = input.formats.length;
  let done = 0;
  let last = '';
  const result = await ed.exportRender({
    project,
    root: ctx.ws.root,
    render: input.render_id,
    formats: input.formats,
    ...(input.gif ? { gif: input.gif } : {}),
    trust: ENGINE_TRUST,
    network: 'guard',
    signal: ctx.signal,
    onBrowser: (b) => ctx.browser(b),
    onProgress: (p: ExportProgress) => {
      if (p.stage === 'done' || p.stage === 'failed') done++;
      const within = p.stage === 'done' || p.stage === 'failed' ? 0 : p.progress;
      const fraction = Math.round(Math.min(1, (done + within) / total) * 1000) / 1000;
      const key = `${p.format}:${p.stage}:${fraction}`;
      if (key === last) return;
      last = key;
      ctx.progress({ steps_done: done, steps_total: total, phase: p.format, fraction, updated_at: new Date().toISOString() });
    },
  });
  // The manifest also keeps formats exported earlier: this export's files are the formats asked that did not fail.
  const outputs = result.outputs.filter((o) => input.formats.includes(o.format) && !result.failures.some((f) => f.format === o.format));
  return {
    kind: 'export',
    render_id: input.render_id,
    dir: result.dir,
    manifest: result.manifest,
    outputs: outputs.map((o) => ({ format: o.format, file: o.file, method: o.method, width: o.width, height: o.height, duration_s: o.duration_s, size_bytes: o.size_bytes })),
    rendered: outputs.filter((o) => o.method === 'render').length,
    failed: result.failures.map((f) => f.format),
    untrusted: { failures: result.failures.map((f) => ({ format: f.format, error: f.error })), warnings: outputs.flatMap((o) => o.warnings) },
  };
}
