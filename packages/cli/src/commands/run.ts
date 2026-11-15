import { join } from 'node:path';
import { formatIssues } from '@retake/core/base';
import { isAccessError } from '@retake/core/environment';
import { perfSummary } from '@retake/core/run';
import { readTimeline } from '@retake/core/io';
import type { TrustedHookFiles } from '@retake/core/hooks';
import type { Timeline } from '@retake/core/run';
import type { RunProgress, RunRecord } from '@retake/core/run';
import {
  FilmingMarker,
  RunOptionError,
  SandboxTakeError,
  TakeBeside,
  scenarioHooksCheck,
  callerOf,
  listingContext,
  reserveListedRun,
  checkAllowWrites,
  checkHeadedDisplay,
  prepareRun,
  runInProcess,
  selfIdentity,
  writesSummary,
} from '@retake/engine/shell';
import type { FilmingEvent, FilmingReport, PreparedRun } from '@retake/engine';
import { askAgentHooks } from '../agent-hooks.js';
import { heavyGate } from '../heavy-gate.js';
import { EXIT, UsageError, errorMessage, errorText } from '../errors.js';
import { onInterrupt } from '../interrupt.js';
import type { ExitCode } from '../errors.js';
import { ProgressPrinter, runStatusText } from '../progress.js';
import type { Ui } from '../ui.js';
import { formatMs, plural } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
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
  /** Capture, then export the raw package for editors. */
  raw?: boolean;
  /** Let a run on a production environment that allows writes write. */
  allowWrites?: boolean;
  /** Reset the sandbox environment to its seed before the take: up if needed, health, reset. */
  sandbox?: boolean;
  /** `--no-wait` (wait: false): the raw export starts even while another take films, at normal priority. */
  wait?: boolean;
  /** Run the shell hooks of a scenario an agent wrote last without asking. */
  yes?: boolean;
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

type ListedRun = Awaited<ReturnType<typeof reserveListedRun>>;

/** How a run says a line: a JSON event with --json, else a line of the terminal. */
type RunSay = { json: boolean; emitJson: (e: RunProgress) => void; emitNote: (level: 'info' | 'warn', message: string) => void };

/** The check of the scenario's shell hooks before the take: a listing and a yes when an agent wrote them. */
async function checkRunHooks(
  ui: Ui,
  global: GlobalOptions,
  prepared: PreparedRun,
  opts: RunCommandOptions,
  say: RunSay,
): Promise<{ ok: true; listedRun: ListedRun | undefined; trustedHookFiles: TrustedHookFiles | undefined } | { ok: false; message: string }> {
  const { ws, project, scenario, sandboxEnv } = prepared;
  const { json, emitJson, emitNote } = say;
  // The shell hooks of a scenario whose hooks an agent wrote (or whose writer cannot be known) are listed as
  // they will run — rendered with this run's context, its id reserved for it — and run only on a person's yes (a
  // terminal's, or --yes); listed only when they do not run (the runner's default: run for a capture, skip for --dry).
  let listedRun: ListedRun | undefined;
  // The files the person's check read (a trust, or a yes to the listing): the run's hooks are held to them.
  let trustedHookFiles: TrustedHookFiles | undefined;
  try {
    const check = await scenarioHooksCheck(
      ws.root,
      project,
      scenario,
      async () => {
        listedRun = await reserveListedRun(ws.outputs.runs, global.ports.clock, project, scenario.name);
        return listingContext(project, scenario.scenario, sandboxEnv ?? opts.env ?? scenario.scenario.env, { id: listedRun.id, dir: listedRun.dir });
      },
      global.ports.hooks,
    );
    trustedHookFiles = check.bound;
    const agentHooks = check.ask;
    if (agentHooks) {
      const hooksRun = (opts.hooks ?? (opts.dry ? 'skip' : 'run')) === 'run';
      const verdict = await askAgentHooks(ui, agentHooks, {
        scenario: scenario.name,
        run: hooksRun ? true : opts.hooks === 'skip' ? '--hooks skip' : 'dry run',
        yes: opts.yes === true,
        print: (header, lines) => {
          if (json) emitJson({ type: 'log', level: 'warn', message: [header, ...lines].join('\n') });
          else {
            ui.warn(header);
            for (const l of lines) ui.line(l);
          }
        },
        note: (message) => emitNote('warn', message),
      });
      if (!verdict.ok) {
        await listedRun?.release();
        return { ok: false, message: verdict.message };
      }
    }
  } catch (e) {
    await (listedRun as { release(): Promise<void> } | undefined)?.release();
    return { ok: false, message: errorMessage(e) };
  }
  return { ok: true, listedRun, trustedHookFiles };
}

/** The filming marker and the takes filming beside this one, from the capture's start to its stop (captures first). */
function filmingWatch(
  root: string,
  global: GlobalOptions,
  owner: Awaited<ReturnType<typeof selfIdentity>>,
  emitNote: RunSay['emitNote'],
): { onFilming: (state: FilmingEvent) => FilmingReport | undefined; dispose: () => void } {
  let marker: FilmingMarker | null = null;
  // What films or renders beside the take (run.json perf.machine), and one warning when another take films.
  let beside: TakeBeside | undefined;
  const onFilming = (state: FilmingEvent): FilmingReport | undefined => {
    if (state === 'start' && !marker) {
      marker = FilmingMarker.open({ root, source: 'cli', owner, env: global.ports.env });
      beside = new TakeBeside({
        root,
        env: global.ports.env,
        own: () => marker?.name,
        onFirst: (where) => emitNote('warn', `another take films ${where === 'here' ? 'in this workspace' : 'elsewhere on this Mac'} at the same time: both share the machine`),
      });
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
  const dispose = () => {
    (marker as FilmingMarker | null)?.closeSync();
    (beside as TakeBeside | undefined)?.stop();
  };
  return { onFilming, dispose };
}

/** The raw export's flags of `run --raw` (refused without --raw, and with --dry). */
function rawFlagsOf(opts: RunCommandOptions): ReturnType<typeof parseRawFlags> | undefined {
  const stray = rawFlagsWithoutRaw(opts);
  if (!opts.raw && stray.length) throw new UsageError(`${stray.join(', ')} ${stray.length > 1 ? 'shape' : 'shapes'} the raw export: add --raw`);
  if (opts.raw && opts.dry) throw new UsageError('--raw exports a capture: it cannot be combined with --dry');
  return opts.raw ? parseRawFlags(opts) : undefined;
}

/** --allow-writes on a read-only environment is a usage error (it confirms writes, it never grants them). */
function checkWritesAllowed(prepared: PreparedRun, opts: RunCommandOptions): void {
  const { project, scenario, sandboxEnv } = prepared;
  try {
    checkAllowWrites(project, sandboxEnv ?? opts.env ?? scenario.scenario.env);
  } catch (e) {
    if (isAccessError(e)) throw new UsageError(e.message);
    throw e;
  }
}

/** The raw export of a run that succeeded (`run --raw`); the failure's words, or undefined. */
async function rawExportAfterRun(
  ui: Ui,
  global: GlobalOptions,
  prepared: PreparedRun,
  o: { runDir: string; flags: Parameters<typeof rawExportOfRun>[1]['flags']; json: boolean; wait: RunCommandOptions['wait'] },
): Promise<string | undefined> {
  const { ws, project } = prepared;
  const { json } = o;
  if (!json) ui.line();
  // Its encodes are heavy work: they wait for another take filming now, and yield during a later one.
  const gate = await heavyGate(ui, { root: ws.root, env: global.ports.env, what: 'exporting', noWait: o.wait === false });
  try {
    // --json: stdout stays JSON lines — the package is one `raw_export` event after run_end.
    await rawExportOfRun(ui, { ports: global.ports, ws, project, runDir: o.runDir, flags: o.flags, json, jsonLines: json });
  } catch (e) {
    return `raw export: ${errorMessage(e)}`;
  } finally {
    await gate.dispose();
  }
  return undefined;
}

/** `retake run <project> <scenario>`: capture (or dry-run) a scenario; exit 1 unless the run succeeded. */
export async function runCommand(ui: Ui, global: GlobalOptions, projectArg: string, scenarioArg: string, opts: RunCommandOptions): Promise<ExitCode> {
  const json = opts.json === true;
  const emitJson = (e: RunProgress) => ui.result(JSON.stringify(e));
  const rawFlags = rawFlagsOf(opts);
  const fail = (message: string): ExitCode => {
    if (json) emitJson({ type: 'log', level: 'error', message });
    else ui.error(message);
    return EXIT.failure;
  };

  let prepared: PreparedRun;
  try {
    const ws = await openWorkspace(global);
    prepared = await prepareRun(ws, await openProject(ws, projectArg), scenarioArg, opts);
    checkHeadedDisplay(opts, global.ports.env);
  } catch (e) {
    if (e instanceof RunOptionError) throw new UsageError(e.message);
    return fail(errorMessage(e));
  }
  const { ws, project } = prepared;
  if (opts.allowWrites) checkWritesAllowed(prepared, opts);
  // run --raw --cursor none|layer captures without the in-page cursor (its track and effects are still recorded).
  const rawCursor = rawFlags ? (rawFlags.cursor ?? project.config.raw?.cursor ?? 'baked') : undefined;

  // --sandbox resets the sandbox before the take (it stays up after); a sandbox environment without it is filmed as
  // it is, and must be up. A failure there creates no run folder.
  const emitNote = (level: 'info' | 'warn', message: string) => {
    if (json) emitJson({ type: 'log', level, message });
    else if (level === 'warn') ui.warn(message);
    else ui.line(ui.c.dim(message));
  };
  // An agent's shell hooks: listed, and run only on a person's yes (checkRunHooks).
  const hooks = await checkRunHooks(ui, global, prepared, opts, { json, emitJson, emitNote });
  if (!hooks.ok) return fail(hooks.message);
  const { listedRun, trustedHookFiles } = hooks;
  // Captures first: while this capture films, heavy work of every workspace of this user waits or yields
  // (engine captures.ts) — from capture time 0 to the end of its scenes, not around its hooks; none for a dry run.
  const owner = await selfIdentity();
  const { onFilming, dispose: stopWatching } = filmingWatch(ws.root, global, owner, emitNote);
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
        capture: global.ports.capture,
        secrets: global.ports.secrets,
        hooks: global.ports.hooks,
        sandboxes: global.ports.sandboxes,
        // The fix of an expired session names this workspace when the command line did (-C).
        loginCommand: loginCommandFor(global),
        // The id the listing of an agent's shell hooks showed (its folder reserved for this run).
        ...(listedRun ? { runId: (listedRun as { id: string }).id } : {}),
        ...(trustedHookFiles ? { trustedHookFiles } : {}),
        ...(opts.allowWrites ? { allowWrites: true } : {}),
        ...(rawCursor && rawCursor !== 'baked' ? { hideCursor: true } : {}),
        ...(opts.dry ? {} : { onFilming }),
        // Each hook run is a line of the workspace journal, as the person's.
        recordAs: { caller: callerOf('cli'), clock: global.ports.clock },
        // What its history line is stamped with when the run has no end of its own.
        clock: global.ports.clock,
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
        interrupts: { open: (o) => onInterrupt(ui, global.ports, o) },
      },
    );
  } catch (e) {
    // The folder reserved for the listing goes again when the run left it empty (it never started), as the engine's own.
    await (listedRun as { release(): Promise<void> } | undefined)?.release();
    fail(errorText(e));
    return e instanceof SandboxTakeError && e.interrupted ? EXIT.interrupted : EXIT.failure;
  } finally {
    stopWatching();
  }
  if (!json) await printSummary(ui, record, printer?.elapsedMs ?? 0);
  if (record.status !== 'succeeded') return EXIT.failure;
  if (rawFlags) {
    const failed = await rawExportAfterRun(ui, global, prepared, { runDir: record.dir, flags: { ...rawFlags, cursor: rawCursor }, json, wait: opts.wait });
    if (failed !== undefined) return fail(failed);
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
  // What the take cost and how smoothly it was filmed (run.json perf).
  if (r.perf) ui.line(`  ${c.dim('perf')}      ${perfSummary(r.perf)}`);
  if (r.screenshots.length) ui.line(`  ${c.dim('shots')}     ${ui.path(join(r.dir, 'screenshots'))} ${c.dim(`(${r.screenshots.length})`)}`);
  ui.line(`  ${c.dim('run')}       ${ui.path(join(r.dir, 'run.json'))}`);
  if (r.hooks.setup !== 'none' || r.hooks.teardown !== 'none' || r.hooks.steps) {
    ui.line(`  ${c.dim('hooks')}     setup ${r.hooks.setup}, teardown ${r.hooks.teardown}${r.hooks.steps ? `, hook steps ${r.hooks.steps}` : ''}`);
  }
  const sandbox = sandboxSummary(r);
  if (sandbox) ui.line(`  ${c.dim('sandbox')}   ${sandbox}`);
  // What the read-only guard did (timeline.json environment.writes lists each one) — once the run got going.
  const writes = r.steps_done > 0 || (tl?.environment?.writes?.length ?? 0) > 0 ? writesSummary(tl) : undefined;
  if (writes) ui.line(`  ${c.dim('writes')}    ${writes.stopped ? c.yellow(writes.text) : writes.text}`);
  if (r.warnings.length) ui.line(`  ${c.yellow(plural(r.warnings.length, 'warning'))} ${c.dim('(listed in run.json)')}`);
}
