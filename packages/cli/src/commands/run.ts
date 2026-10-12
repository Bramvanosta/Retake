import { join } from 'node:path';
import { formatIssues, loadProjectTemplate, loadScenario, readJson } from '@demo-studio/core';
import type { LoadedTemplate, RunProgress, RunRecord, Timeline } from '@demo-studio/core';
import { CliError, EXIT, UsageError, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { ProgressPrinter, runStatusText } from '../progress.js';
import type { Ui } from '../ui.js';
import { formatMs, plural } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { printIssues } from './validate.js';
import { parseRawFlags, rawExportOfRun } from './export-capture.js';
import type { RawFlags } from './export-capture.js';

export interface RunCommandOptions extends RawFlags {
  dry?: boolean;
  until?: string;
  hooks?: 'run' | 'skip';
  env?: string;
  headed?: boolean;
  json?: boolean;
  /** Capture, then export the raw package for editors (L2.13). */
  raw?: boolean;
}

/** Raw flags given without --raw are a usage error (they only shape the raw export). */
function rawFlagsWithoutRaw(o: RunCommandOptions): string[] {
  const given: string[] = [];
  if (o.cursor !== undefined) given.push('--cursor');
  if (o.format !== undefined) given.push('--format');
  if (o.fps !== undefined) given.push('--fps');
  if (o.layer !== undefined) given.push('--layer');
  if (o.selects !== undefined) given.push('--selects');
  if (o.cuts === false) given.push('--no-cuts');
  if (o.out !== undefined) given.push('--out');
  return given;
}

/** `studio run <project> <scenario>`: capture (or dry-run) a scenario; exit 1 unless the run succeeded. */
export async function runCommand(
  ui: Ui,
  global: GlobalOptions,
  projectArg: string,
  scenarioArg: string,
  opts: RunCommandOptions,
): Promise<ExitCode> {
  const json = opts.json === true;
  const emitJson = (e: RunProgress) => ui.result(JSON.stringify(e));
  const stray = rawFlagsWithoutRaw(opts);
  if (!opts.raw && stray.length) throw new UsageError(`${stray.join(', ')} ${stray.length > 1 ? 'shape' : 'shapes'} the raw export: add --raw`);
  if (opts.raw && opts.dry) throw new UsageError('--raw exports a capture: it cannot be combined with --dry');
  const rawFlags = opts.raw ? parseRawFlags(opts) : undefined;
  const fail = (message: string): ExitCode => {
    if (json) emitJson({ type: 'log', level: 'error', message });
    else ui.error(message);
    return EXIT.failure;
  };

  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(global, projectArg, scenarioArg, opts);
  } catch (e) {
    return fail(errorMessage(e));
  }
  const { ws, project, scenario, template, templateWarning } = prepared;
  // run --raw --cursor none|layer captures without the in-page cursor (its track and effects are still recorded).
  const rawCursor = rawFlags ? (rawFlags.cursor ?? project.config.raw?.cursor ?? 'baked') : undefined;

  const notes = templateWarning ? [templateWarning] : [];
  if (opts.dry && opts.hooks === undefined && (scenario.scenario.setup?.length ?? 0) > 0) {
    notes.push('dry run without its setup hooks: steps that need prepared data may fail (add --hooks run to execute them)');
  }
  if (json) {
    for (const i of scenario.issues) emitJson({ type: 'log', level: 'warn', message: formatIssues([i], scenario.file) });
    for (const n of notes) emitJson({ type: 'log', level: 'warn', message: n });
  } else {
    printIssues(ui, scenario.issues, scenario.file);
    for (const n of notes) ui.warn(n);
  }

  const { runScenario } = await import('@demo-studio/runner-web');
  const printer = new ProgressPrinter(ui);
  let record: RunRecord;
  try {
    record = await runScenario({
      project,
      scenario,
      template,
      mode: opts.dry ? 'dry' : 'capture',
      env: opts.env,
      until: opts.until,
      hooks: opts.hooks,
      headed: opts.headed,
      ffmpeg: ws.ffmpeg,
      ...(rawCursor && rawCursor !== 'baked' ? { hideCursor: true } : {}),
      onProgress: json ? emitJson : (e) => printer.handle(e),
    });
  } catch (e) {
    return fail(errorMessage(e));
  }
  if (!json) await printSummary(ui, record, printer.elapsedMs);
  if (record.status !== 'succeeded') return EXIT.failure;
  if (rawFlags) {
    if (!json) ui.line();
    try {
      // --json: stdout stays JSON lines — the package is one `raw_export` event after run_end.
      await rawExportOfRun(ui, ws, project, record.dir, { ...rawFlags, cursor: rawCursor }, { json, jsonLines: json });
    } catch (e) {
      return fail(`raw export: ${errorMessage(e)}`);
    }
  }
  return EXIT.ok;
}

async function prepare(global: GlobalOptions, projectArg: string, scenarioArg: string, opts: RunCommandOptions) {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const scenario = await loadScenario(project, scenarioArg, { env: opts.env, until: opts.until });
  let template: LoadedTemplate | undefined;
  let templateWarning: string | undefined;
  try {
    template = await loadProjectTemplate(project, scenario.scenario.template);
  } catch (e) {
    // Phase 1 only takes the cursor ripple colour from the template: capture with the defaults.
    templateWarning = `${errorMessage(e)} — capturing with the default cursor colours`;
  }
  if (opts.headed && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new CliError('--headed needs a display, and none is available (DISPLAY / WAYLAND_DISPLAY are not set)');
  }
  return { ws, project, scenario, template, templateWarning };
}

async function printSummary(ui: Ui, r: RunRecord, elapsedMs: number): Promise<void> {
  const c = ui.c;
  ui.line();
  ui.line(`${r.status === 'succeeded' ? c.green('✓') : c.red('✗')} ${runStatusText(ui, r)} in ${formatMs(elapsedMs)} ${c.dim('·')} ${r.steps_done}/${plural(r.steps_total, 'step')}`);
  if (r.error) {
    const where = r.error.scene !== undefined ? `${r.error.scene}.${r.error.step ?? '?'} ${r.error.action ?? ''}: ` : '';
    ui.line(`  ${c.red('error')}     ${where}${r.error.message}`);
    if (r.error.screenshot) ui.line(`  ${c.dim('screenshot')} ${ui.path(r.error.screenshot)}`);
    if (r.error.dom) ui.line(`  ${c.dim('dom')}       ${ui.path(r.error.dom)}`);
  }
  if (r.stopped_at) {
    const why = r.stopped_at.reason === 'until' ? '--until' : 'irreversible step (dry run)';
    ui.line(`  ${c.dim('stopped')}   ${r.stopped_at.scene}.${r.stopped_at.step} (${why})`);
  }
  if (r.capture) {
    let detail = '';
    if (r.timeline) {
      try {
        const tl = await readJson<Timeline>(r.timeline);
        detail = ` ${c.dim(`(${tl.capture.duration.toFixed(1)} s, ${tl.capture.width * tl.capture.scale}×${tl.capture.height * tl.capture.scale} @ ${tl.capture.fps} fps)`)}`;
      } catch {
        /* the timeline is reported below anyway */
      }
    }
    ui.line(`  ${c.dim('capture')}   ${ui.path(r.capture)}${detail}`);
  }
  if (r.timeline) ui.line(`  ${c.dim('timeline')}  ${ui.path(r.timeline)}`);
  if (r.screenshots.length) ui.line(`  ${c.dim('shots')}     ${ui.path(join(r.dir, 'screenshots'))} ${c.dim(`(${r.screenshots.length})`)}`);
  ui.line(`  ${c.dim('run')}       ${ui.path(join(r.dir, 'run.json'))}`);
  if (r.hooks.setup !== 'none' || r.hooks.teardown !== 'none') {
    ui.line(`  ${c.dim('hooks')}     setup ${r.hooks.setup}, teardown ${r.hooks.teardown}`);
  }
  if (r.warnings.length) ui.line(`  ${c.yellow(plural(r.warnings.length, 'warning'))} ${c.dim('(listed in run.json)')}`);
}
