import { resolve } from 'node:path';
import { EXPORT_FORMATS, DEFAULT_EXPORT_FORMATS, ExportError, RenderError, exportRender, findRenderRecord } from '@retake/editor';
import type { ExportFormat, ExportProgress } from '@retake/editor';
import { appendHistory } from '@retake/engine';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { formatMs } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { formatBytes } from './render.js';
import { heavyGate } from '../heavy-gate.js';

export interface ExportCommandOptions {
  /** `--no-wait` (wait: false): start even while a take films, at normal priority (L5.14). */
  wait?: boolean;
  /** Comma-separated formats (default mp4_1080p,webm,gif_preview). */
  formats?: string;
  scenario?: string;
  out?: string;
  concurrency?: string;
  /** GIF window start (s). */
  gifStart?: string;
  json?: boolean;
}

/** `--formats a,b,c` (also `all`). */
export function parseFormats(value: string | undefined): ExportFormat[] {
  if (value === undefined) return [...DEFAULT_EXPORT_FORMATS];
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 1 && list[0] === 'all') return [...EXPORT_FORMATS];
  for (const f of list) if (!(EXPORT_FORMATS as readonly string[]).includes(f)) throw new UsageError(`--formats: unknown format "${f}" (use ${EXPORT_FORMATS.join(', ')} or all)`);
  if (list.length === 0) throw new UsageError('--formats: name at least one format');
  return list as ExportFormat[];
}

const LABEL: Record<ExportFormat, string> = {
  mp4_1080p: 'MP4 1080p',
  mp4_4k: 'MP4 4K',
  webm: 'WebM (VP9)',
  vertical_9x16: 'vertical 9:16',
  square_1x1: 'square 1:1',
  gif_preview: 'GIF preview',
};

/**
 * `retake export <project> <render|latest> --formats …`: delivery files in exports/<render-id>/ + manifest.json —
 * transcoded from the master (1080p, WebM, GIF) or re-rendered from the run (4K from a 1080p master, vertical,
 * square).
 */
export async function exportCommand(ui: Ui, global: GlobalOptions, projectArg: string, renderArg: string, opts: ExportCommandOptions): Promise<ExitCode> {
  const formats = parseFormats(opts.formats);
  const concurrency = opts.concurrency !== undefined ? Number(opts.concurrency) : undefined;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 16)) throw new UsageError(`--concurrency "${opts.concurrency}": use 1–16`);
  const gifStart = opts.gifStart !== undefined ? Number(opts.gifStart) : undefined;
  if (gifStart !== undefined && !(gifStart >= 0)) throw new UsageError(`--gif-start "${opts.gifStart}": use seconds ≥ 0`);
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  // Captures first (L5.14): the render is the one named now ("latest" resolved before any wait, critique M10).
  let render: string;
  try {
    render = renderArg === 'latest' ? (await findRenderRecord(project, renderArg, opts.scenario)).id : renderArg;
  } catch (e) {
    if (e instanceof ExportError || e instanceof RenderError) throw new CliError(e.message);
    throw e;
  }
  const gate = await heavyGate(ui, { root: ws.root, what: 'exporting', noWait: opts.wait === false });
  if (gate.waited) ui.info(`exporting render ${render}`);
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once('SIGINT', onSigint);
  const t0 = performance.now();
  const status = (p: ExportProgress) => {
    if (opts.json) return;
    if (p.stage === 'start') ui.setStatus(ui.c.dim(`  … ${LABEL[p.format]}`));
    else if (p.stage === 'progress') ui.setStatus(ui.c.dim(`  … ${LABEL[p.format]}: re-rendering ${Math.round(p.progress * 100)} %${p.message ? ` (${p.message})` : ''}`));
    else ui.clearStatus();
  };
  try {
    const r = await exportRender({
      project,
      root: ws.root,
      render,
      scenario: opts.scenario,
      formats,
      out: opts.out ? resolve(opts.out) : undefined,
      concurrency,
      ...(gifStart !== undefined ? { gif: { start_s: gifStart } } : {}),
      signal: ac.signal,
      onProgress: status,
    });
    ui.clearStatus();
    // The workspace's job history counts the formats re-rendered by Remotion (best effort, as `retake render`).
    const rendered = r.outputs.filter((o) => o.method === 'render').length;
    if (rendered) await appendHistory(ws.root, { kind: 'export', project: project.slug, submitted_by: 'cli', state: 'succeeded', counted: { captures: 0, dry_runs: 0, renders: rendered } });
    if (opts.json) {
      ui.result(JSON.stringify(r, null, 2));
    } else {
      const c = ui.c;
      ui.line(`export ${c.bold(r.render)} (${r.master.width}×${r.master.height}, ${r.master.duration_s.toFixed(2)} s) → ${ui.path(r.dir)} ${c.dim(formatMs(performance.now() - t0))}`);
      for (const o of r.outputs.filter((x) => formats.includes(x.format))) {
        const audio = o.audio_codec ? ` + ${o.audio_codec}` : o.format === 'gif_preview' ? '' : ' (no audio)';
        const win = o.window ? `, ${o.window.start_s.toFixed(1)}–${(o.window.start_s + o.window.duration_s).toFixed(1)} s (${o.window.reason})` : '';
        ui.ok(`${LABEL[o.format].padEnd(13)} ${ui.path(o.file)}  ${o.width}×${o.height} ${o.video_codec ?? ''}${audio}, ${o.duration_s.toFixed(2)} s${win}, ${formatBytes(o.size_bytes)} ${c.dim(`${o.method} · ${formatMs(o.ms)}`)}`);
        for (const w of o.warnings) ui.warn(`  ${w}`);
      }
      for (const f of r.failures) ui.error(`${LABEL[f.format]}: ${f.error}`);
      ui.line(c.dim(`  manifest ${ui.path(r.manifest)}`));
    }
    return r.failures.length > 0 ? EXIT.failure : EXIT.ok;
  } catch (e) {
    ui.clearStatus();
    if (e instanceof ExportError || e instanceof RenderError) throw new CliError(e.message);
    throw e;
  } finally {
    process.removeListener('SIGINT', onSigint);
    await gate.dispose();
  }
}
