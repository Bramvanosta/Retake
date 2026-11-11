import { join } from 'node:path';
import { formatIssues, isAccessError, perfSummary } from '@retake/core';
import { readTimeline } from '@retake/core/io';
import type { RunProgress, RunRecord, Timeline } from '@retake/core';
import { FilmingMarker, RunOptionError, SandboxTakeError, TakeBeside, callerOf, checkAllowWrites, prepareRun, runInProcess, selfIdentity, writesSummary } from '@retake/engine';
import type { FilmingEvent, FilmingReport, PreparedRun } from '@retake/engine';
import { heavyGate } from '../heavy-gate.js';
import { EXIT, UsageError, errorMessage, errorText } from '../errors.js';
import { onInterrupt } from '../interrupt.js';
import type { ExitCode } from '../errors.js';
import { ProgressPrinter, runStatusText } from '../progress.js';
import type { Ui } from '../ui.js';
import { formatMs, plural } from '../ui.js';
import { cliPorts, openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { printIssues } from './validate.js';
import { loginCommandFor } from './auth.js';
import { parseRawFlags, rawExportOfRun } from './export-capture.js';
import type { RawFlags } from './export-capture.js';
import { sandboxSummary } from './sandbox.js';

export interface RunCommandOptions extends RawFlags {
  dry?: boolean;
  until?: string;
  hooks?: 'run' | 'skip';
  env?: string;
  headed?: boolean;
  json?: boolean;
  /** Capture, then export the raw package for editors (L2.13). */
  raw?: boolean;
  /** Let a run on a production environment that allows writes write (L1.7). */
  allowWrites?: boolean;
  /** Reset the sandbox environment to its seed before the take (L1.8): up if needed, health, reset. */
  sandbox?: boolean;
  /** `--no-wait` (wait: false): the raw export starts even while another take films, at normal priority (L5.14). */
  wait?: boolean;
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

/** `retake run <project> <scenario>`: capture (or dry-run) a scenario; exit 1 unless the run succeeded. */
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

  let prepared: PreparedRun;
  try {
    const ws = await openWorkspace(global);
    prepared = await prepareRun(ws, await openProject(ws, projectArg), scenarioArg, opts);
  } catch (e) {
    if (e instanceof RunOptionError) throw new UsageError(e.message);
    return fail(errorMessage(e));
  }
  const { ws, project, scenario, sandboxEnv } = prepared;
  // --allow-writes on a read-only environment is a usage error (it confirms writes, it never grants them).
  if (opts.allowWrites) {
    try {
      checkAllowWrites(project, sandboxEnv ?? opts.env ?? scenario.scenario.env);
    } catch (e) {
      if (isAccessError(e)) throw new UsageError(e.message);
      throw e;
    }
  }
  // run --raw --cursor none|layer captures without the in-page cursor (its track and effects are still recorded).
  const rawCursor = rawFlags ? (rawFlags.cursor ?? project.config.raw?.cursor ?? 'baked') : undefined;

  // L1.8: --sandbox resets the sandbox before the take (it stays up after); a sandbox environment without it is filmed as
  // it is, and must be up. A failure there creates no run folder.
  const emitNote = (level: 'info' | 'warn', message: string) => {
    if (json) emitJson({ type: 'log', level, message });
    else if (level === 'warn') ui.warn(message);
    else ui.line(ui.c.dim(message));
  };
  // Captures first (L5.14): while this capture films, heavy work of every workspace of this user waits or yields
  // (engine captures.ts) — from capture time 0 to the end of its scenes, not around its hooks; none for a dry run.
  const owner = await selfIdentity();
  let marker: FilmingMarker | null = null;
  // What films or renders beside the take (run.json perf.machine), and one warning when another take films.
  let beside: TakeBeside | undefined;
  const onFilming = (state: FilmingEvent): FilmingReport | undefined => {
    if (state === 'start' && !marker) {
      marker = FilmingMarker.open({ root: ws.root, source: 'cli', owner });
      beside = new TakeBeside({ root: ws.root, own: () => marker?.name, onFirst: (where) => emitNote('warn', `another take films ${where === 'here' ? 'in this workspace' : 'elsewhere on this Mac'} at the same time: both share the machine`) });
      beside.start();
    } else if (state === 'pause' || state === 'resume') marker?.setPaused(state === 'pause');
    else if (state === 'stop') {
      marker?.closeSync();
      marker = null;
      const report = beside?.stop();
      beside = undefined;
      return report;
    }
    return undefined;
  };
  // The printer measures the run from its first event (the sandbox take is not part of it).
  let printer: ProgressPrinter | undefined;
  let record: RunRecord;
  try {
    // The run, then its line of the workspace's history — a failed run included (the engine's in-process operation).
    record = await runInProcess(
      prepared,
      opts,
      {
        policy: ws.policy,
        // The fix of an expired session names this workspace when the command line did (-C).
        loginCommand: loginCommandFor(global),
        ...(opts.allowWrites ? { allowWrites: true } : {}),
        ...(rawCursor && rawCursor !== 'baked' ? { hideCursor: true } : {}),
        ...(opts.dry ? {} : { onFilming }),
        // Each hook run is a line of the workspace journal, as the person's.
        recordAs: { caller: callerOf('cli'), clock: cliPorts.clock },
        // What its history line is stamped with when the run has no end of its own.
        clock: cliPorts.clock,
      },
      {
        issues: (issues, file) => {
          if (json) for (const i of issues) emitJson({ type: 'log', level: 'warn', message: formatIssues([i], file) });
          else printIssues(ui, issues, file);
        },
        note: emitNote,
        sandboxLog: (level, msg) => {
          if (level === 'warn') emitNote('warn', msg);
          else if (json) emitNote('info', msg);
          else ui.debug(msg);
        },
        progress: (e) => {
          if (json) emitJson(e);
          else (printer ??= new ProgressPrinter(ui)).handle(e);
        },
        interrupts: { open: (o) => onInterrupt(ui, o) },
      },
    );
  } catch (e) {
    fail(errorText(e));
    return e instanceof SandboxTakeError && e.interrupted ? EXIT.interrupted : EXIT.failure;
  } finally {
    (marker as FilmingMarker | null)?.closeSync();
    (beside as TakeBeside | undefined)?.stop();
  }
  if (!json) await printSummary(ui, record, printer?.elapsedMs ?? 0);
  if (record.status !== 'succeeded') return EXIT.failure;
  if (rawFlags) {
    if (!json) ui.line();
    // Its encodes are heavy work (critique L8): they wait for another take filming now, and yield during a later one.
    const gate = await heavyGate(ui, { root: ws.root, what: 'exporting', noWait: opts.wait === false });
    try {
      // --json: stdout stays JSON lines — the package is one `raw_export` event after run_end.
      await rawExportOfRun(ui, ws, project, record.dir, { ...rawFlags, cursor: rawCursor }, { json, jsonLines: json });
    } catch (e) {
      return fail(`raw export: ${errorMessage(e)}`);
    } finally {
      await gate.dispose();
    }
  }
  return EXIT.ok;
}

export { checkAllowWrites, writesSummary };

async function printSummary(ui: Ui, r: RunRecord, elapsedMs: number): Promise<void> {
  const c = ui.c;
  ui.line();
  ui.line(`${r.status === 'succeeded' ? c.green('✓') : c.red('✗')} ${runStatusText(ui, r)} in ${formatMs(elapsedMs)} ${c.dim('·')} ${r.steps_done}/${plural(r.steps_total, 'step')}`);
  if (r.error) {
    const where = r.error.scene !== undefined ? `${r.error.scene}.${r.error.step ?? '?'} ${r.error.action ?? ''}: ` : '';
    // A multi-line message (the session preflight lists each persona) keeps its own indentation under the first line.
    ui.line(`  ${c.red('error')}     ${where}${r.error.message.replace(/\n/g, `\n${' '.repeat(12)}`)}`);
    if (r.error.screenshot) ui.line(`  ${c.dim('screenshot')} ${ui.path(r.error.screenshot)}`);
    if (r.error.dom) ui.line(`  ${c.dim('dom')}       ${ui.path(r.error.dom)}`);
  }
  // The optional steps that failed (R-FLD-16): the run went on, but the video may miss what they did.
  for (const f of r.optional_failures ?? []) {
    ui.line(`  ${c.yellow('optional')}  ${f.scene}.${f.step} ${f.action} failed: ${f.error.split('\n')[0]}`);
    if (f.screenshot) ui.line(`  ${c.dim('screenshot')} ${ui.path(f.screenshot)}`);
  }
  if (r.stopped_at) {
    const why = r.stopped_at.reason === 'until' ? '--until' : 'irreversible step (dry run)';
    ui.line(`  ${c.dim('stopped')}   ${r.stopped_at.scene}.${r.stopped_at.step} (${why})`);
  }
  let tl: Timeline | undefined;
  if (r.timeline) {
    // Through the one reader: a timeline that does not read adds no detail (it is reported below anyway).
    const read = await readTimeline(r.timeline);
    if (read.ok) tl = read.value;
  }
  if (r.capture) {
    const detail = tl ? ` ${c.dim(`(${tl.capture.duration.toFixed(1)} s, ${tl.capture.width * tl.capture.scale}×${tl.capture.height * tl.capture.scale} @ ${tl.capture.fps} fps)`)}` : '';
    ui.line(`  ${c.dim('capture')}   ${ui.path(r.capture)}${detail}`);
  }
  if (r.timeline) ui.line(`  ${c.dim('timeline')}  ${ui.path(r.timeline)}`);
  // L5.7: what the take cost and how smoothly it was filmed (run.json perf).
  if (r.perf) ui.line(`  ${c.dim('perf')}      ${perfSummary(r.perf)}`);
  if (r.screenshots.length) ui.line(`  ${c.dim('shots')}     ${ui.path(join(r.dir, 'screenshots'))} ${c.dim(`(${r.screenshots.length})`)}`);
  ui.line(`  ${c.dim('run')}       ${ui.path(join(r.dir, 'run.json'))}`);
  if (r.hooks.setup !== 'none' || r.hooks.teardown !== 'none' || r.hooks.steps) {
    ui.line(`  ${c.dim('hooks')}     setup ${r.hooks.setup}, teardown ${r.hooks.teardown}${r.hooks.steps ? `, hook steps ${r.hooks.steps}` : ''}`);
  }
  const sandbox = sandboxSummary(r);
  if (sandbox) ui.line(`  ${c.dim('sandbox')}   ${sandbox}`);
  // L1.7: what the read-only guard did (timeline.json environment.writes lists each one) — once the run got going.
  const writes = r.steps_done > 0 || (tl?.environment?.writes?.length ?? 0) > 0 ? writesSummary(tl) : undefined;
  if (writes) ui.line(`  ${c.dim('writes')}    ${writes.stopped ? c.yellow(writes.text) : writes.text}`);
  if (r.warnings.length) ui.line(`  ${c.yellow(plural(r.warnings.length, 'warning'))} ${c.dim('(listed in run.json)')}`);
}
