import { resolve } from 'node:path';
import { RAW_CURSOR_MODES, RAW_FORMATS, RAW_LAYER_FORMATS } from '@retake/core';
import type { LoadedProject, RawCursorMode, RawFormat, RawFps, RawLayerFormat } from '@retake/core';
import { findRunOf, rawExportWork } from '@retake/engine';
import type { OpenedWorkspace, RawExportProgress, RawExportResult } from '@retake/engine';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { heavyGate } from '../heavy-gate.js';
import type { Ui } from '../ui.js';
import { formatMs } from '../ui.js';
import { cliPorts, openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { formatBytes, warnLatest } from './render.js';

/** The raw export flags shared by `retake export-capture` and `retake run --raw`. */
export interface RawFlags {
  format?: string;
  fps?: string;
  cursor?: string;
  layer?: string;
  selects?: boolean;
  /** Commander's `--no-cuts` (false); undefined = project / default. */
  cuts?: boolean;
  out?: string;
}

export interface ExportCaptureCommandOptions extends RawFlags {
  scenario?: string;
  json?: boolean;
  /** `--no-wait` (wait: false): start even while a take films, at normal priority (L5.14). */
  wait?: boolean;
}

/** Validated raw flags (undefined = project `raw` / default). */
export function parseRawFlags(f: RawFlags): { format?: RawFormat; fps?: RawFps; cursor?: RawCursorMode; layer?: RawLayerFormat; selects?: boolean; cuts?: boolean; out?: string } {
  if (f.format !== undefined && !(RAW_FORMATS as readonly string[]).includes(f.format)) throw new UsageError(`--format "${f.format}": use ${RAW_FORMATS.join(' or ')}`);
  if (f.fps !== undefined && f.fps !== '30' && f.fps !== '60') throw new UsageError(`--fps "${f.fps}": use 30 or 60`);
  if (f.cursor !== undefined && !(RAW_CURSOR_MODES as readonly string[]).includes(f.cursor)) throw new UsageError(`--cursor "${f.cursor}": use ${RAW_CURSOR_MODES.join(', ')}`);
  if (f.layer !== undefined && !(RAW_LAYER_FORMATS as readonly string[]).includes(f.layer)) throw new UsageError(`--layer "${f.layer}": use ${RAW_LAYER_FORMATS.join(' or ')}`);
  return {
    ...(f.format !== undefined ? { format: f.format as RawFormat } : {}),
    ...(f.fps !== undefined ? { fps: Number(f.fps) as RawFps } : {}),
    ...(f.cursor !== undefined ? { cursor: f.cursor as RawCursorMode } : {}),
    ...(f.layer !== undefined ? { layer: f.layer as RawLayerFormat } : {}),
    ...(f.selects !== undefined ? { selects: f.selects } : {}),
    ...(f.cuts === false ? { cuts: false } : {}),
    ...(f.out !== undefined ? { out: resolve(f.out) } : {}),
  };
}

/** The line `retake run --raw --json` prints after its RunProgress events (one JSON object per line). */
export interface RawExportEvent {
  type: 'raw_export';
  dir: string;
  manifest: RawExportResult['manifest'];
}

/**
 * Run the raw export of a run directory (shared by export-capture and run --raw). `json`: the manifest, pretty
 * printed (export-capture --json); `jsonLines`: one `raw_export` event line (run --raw --json, whose stdout is JSON
 * lines).
 */
export async function rawExportOfRun(
  ui: Ui,
  ws: OpenedWorkspace,
  project: LoadedProject,
  runDir: string,
  flags: ReturnType<typeof parseRawFlags>,
  opts: { json?: boolean; jsonLines?: boolean; signal?: AbortSignal },
): Promise<RawExportResult> {
  const t0 = performance.now();
  const status = (p: RawExportProgress) => {
    if (opts.json) return;
    if (p.stage === 'done') ui.clearStatus();
    else ui.setStatus(ui.c.dim(`  … ${p.stage}${p.total > 1 ? ` ${p.done}/${p.total}` : ''}${p.message ? ` ${p.message}` : ''}`));
  };
  try {
    // The engine's raw export (L7.22, U8e: rawExportWork on the capture port): the run's gate (a run it refuses is
    // refused in its words, before the theme is looked for), the run's theme (a note on stderr when it does not load:
    // the default look), the edit's files, the package. Its refusals state their kind: main prints their sentence.
    const r = await rawExportWork({
      capture: cliPorts.capture,
      ws,
      project,
      runDir,
      settings: flags,
      signal: opts.signal,
      onNote: (note) => {
        if (!opts.json) ui.warn(note);
      },
      onProgress: status,
    });
    ui.clearStatus();
    if (opts.jsonLines) ui.result(JSON.stringify({ type: 'raw_export', dir: r.dir, manifest: r.manifest } satisfies RawExportEvent));
    else if (opts.json) ui.result(JSON.stringify(r.manifest, null, 2));
    else printRawExport(ui, r, performance.now() - t0);
    return r;
  } catch (e) {
    ui.clearStatus();
    throw e;
  }
}

/** Human summary of a raw package. */
export function printRawExport(ui: Ui, r: RawExportResult, ms: number): void {
  const c = ui.c;
  const m = r.manifest;
  ui.line(
    `raw export of ${c.bold(m.run.id)} → ${ui.path(r.dir)} ${c.dim(formatMs(ms))}`,
  );
  ui.line(c.dim(`  ${m.settings.codec} · ${m.settings.fps} fps · cursor ${m.cursor.mode}${m.settings.layer ? ` (${m.settings.layer_codec})` : ''} · sequence ${m.sequence.duration_s.toFixed(2)} s (${m.sequence.frames} frames)`));
  for (const k of m.clips) {
    const cuts = k.cuts.length ? c.dim(` · cut ${k.cuts.map((x) => `${x.seconds.toFixed(1)} s ${x.reason}`).join(', ')}`) : '';
    ui.ok(`${k.file.padEnd(34)} ${k.width}×${k.height} ${k.frames} frames ${k.duration_s.toFixed(2)} s @ ${k.seq_start_tc} ${formatBytes(k.size_bytes)}${k.primary ? '' : c.dim(' (other page)')}${cuts}`);
    if (k.layer) ui.line(c.dim(`    ${k.layer.file} ${k.layer.codec} ${k.layer.pix_fmt} ${formatBytes(k.layer.size_bytes)}`));
  }
  if (m.selects) ui.ok(`${m.selects.file.padEnd(34)} ${m.selects.frames} frames ${m.selects.duration_s.toFixed(2)} s ${formatBytes(m.selects.size_bytes)}`);
  const counts = Object.entries(m.markers.count).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ');
  ui.line(`  markers ${c.dim(counts)}: ${m.markers.fcpxml}, ${m.markers.edl}, ${m.markers.otio}, ${m.markers.csv}`);
  ui.line(`  cursor  ${m.cursor.data.json}, ${m.cursor.data.csv}, ${m.cursor.data.clicks_csv}${m.cursor.icons === 'approximated' ? c.dim(' (icons approximated: run before L2.13)') : ''}`);
  for (const w of m.warnings) ui.warn(`  ${w}`);
  ui.line(c.dim(`  manifest ${ui.path(r.manifestFile)} · ${ui.path(r.readme)}`));
}

/**
 * `retake export-capture <project> <run|latest>`: the raw package of a run for another editing tool — a clip per scene
 * (page loads and loading cut), cursor data or layer, FCPXML / EDL / OTIO / CSV markers, manifest + README.
 */
export async function exportCaptureCommand(ui: Ui, global: GlobalOptions, projectArg: string, runArg: string, opts: ExportCaptureCommandOptions): Promise<ExitCode> {
  const flags = parseRawFlags(opts);
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  // The run by the rule every reader of runs shares (findRunOf; its errors state their kind: main prints their sentence).
  const run = await findRunOf(project, runArg, opts.scenario);
  const runDir = run.dir;
  // What `latest` passed over, and a capture stopped by `--until` (stderr; nothing for a run that was named).
  warnLatest(ui, run, { ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}), name: 'name one in place of "latest"', json: opts.json });
  // Captures first (L5.14, critique L8): its encodes are heavy work — the run was resolved before any wait.
  const gate = await heavyGate(ui, { root: ws.root, what: 'exporting', noWait: opts.wait === false });
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once('SIGINT', onSigint);
  try {
    const r = await rawExportOfRun(ui, ws, project, runDir, flags, { json: opts.json, signal: ac.signal });
    return r.manifest.warnings.length > 0 && r.manifest.clips.length === 0 ? EXIT.failure : EXIT.ok;
  } finally {
    process.removeListener('SIGINT', onSigint);
    await gate.dispose();
  }
}
