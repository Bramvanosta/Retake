import { join } from 'node:path';
import { formatIssues, isAccessError, loadProjectTemplate, loadScenario, readJson, resolveEnvironment, resolveRunAccess, scenarioEnvOf } from '@demo-studio/core';
import type { LoadedTemplate, RunProgress, RunRecord, Timeline } from '@demo-studio/core';
import { CliError, EXIT, UsageError, errorMessage } from '../errors.js';
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
import { checkSandboxEnv, pickSandboxEnv, prepareSandboxTake, sandboxSummary } from './sandbox.js';

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
    if (e instanceof UsageError) throw e;
    return fail(errorMessage(e));
  }
  const { ws, project, scenario, template, templateWarning, sandboxEnv } = prepared;
  // --sandbox (L1.8): the run is on the sandbox environment pickSandboxEnv chose.
  const runEnv = sandboxEnv ?? opts.env;
  // --allow-writes on a read-only environment is a usage error (it confirms writes, it never grants them).
  if (opts.allowWrites) checkAllowWrites(project, runEnv ?? scenario.scenario.env);
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

  // L1.8: --sandbox resets the sandbox before the take (it stays up after); a sandbox environment without it is filmed as
  // it is, and must be up. A failure here creates no run folder.
  const emitNote = (level: 'info' | 'warn', message: string) => {
    if (json) emitJson({ type: 'log', level, message });
    else if (level === 'warn') ui.warn(message);
    else ui.line(ui.c.dim(message));
  };
  let take: Awaited<ReturnType<typeof prepareSandboxTake>>['take'];
  if (sandboxEnv) {
    const r = await prepareSandboxTake(ui, project, sandboxEnv, scenario.name, { json, emit: emitNote });
    if (!r.take) {
      fail(r.error ?? `sandbox ${sandboxEnv} could not be prepared`);
      return r.exit ?? EXIT.failure;
    }
    take = r.take;
  } else {
    try {
      await checkSandboxEnv(project, resolveEnvironment(project, opts.env ?? scenario.scenario.env).name, { emit: emitNote });
    } catch (e) {
      return fail(errorMessage(e));
    }
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
      env: runEnv,
      until: opts.until,
      hooks: opts.hooks,
      headed: opts.headed,
      ffmpeg: ws.ffmpeg,
      // The fix of an expired session names this workspace when the command line did (-C).
      loginCommand: loginCommandFor(global),
      ...(opts.allowWrites ? { allowWrites: true } : {}),
      ...(rawCursor && rawCursor !== 'baked' ? { hideCursor: true } : {}),
      ...(take ? { sandbox: take.info } : {}),
      onProgress: (e) => {
        if (take && e.type === 'run_start') take.note(e.run.id);
        if (json) emitJson(e);
        else printer.handle(e);
      },
    });
  } catch (e) {
    return fail(errorMessage(e));
  } finally {
    await take?.release();
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

/** `--allow-writes` where the environment is read-only in project.yaml: a usage error (exit 2) before anything runs. */
export function checkAllowWrites(project: Parameters<typeof resolveEnvironment>[0], env: string | undefined): void {
  let resolved: ReturnType<typeof resolveEnvironment>;
  try {
    resolved = resolveEnvironment(project, env);
  } catch {
    return; // an unknown environment is reported where it is used
  }
  try {
    resolveRunAccess(resolved, { allowWrites: true });
  } catch (e) {
    if (isAccessError(e)) throw new UsageError(e.message);
    throw e;
  }
}

async function prepare(global: GlobalOptions, projectArg: string, scenarioArg: string, opts: RunCommandOptions) {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  // --sandbox: no sandbox, or an --env that is not one, is a usage error before anything is read. The sandbox is
  // picked from the scenario's raw `env:` first, then the scenario is validated once, against the environment it runs
  // on (its pages, its mailbox): a scenario without `env:` that waits for an email only the sandbox's mailbox receives.
  const sandboxEnv = opts.sandbox ? pickSandboxEnv(project, opts.env, await scenarioEnvOf(project, scenarioArg)) : undefined;
  const scenario = await loadScenario(project, scenarioArg, { env: sandboxEnv ?? opts.env, until: opts.until });
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
  return { ws, project, scenario, template, templateWarning, sandboxEnv };
}

/**
 * "1 mocked, 0 stopped" (+ allowed, to unguarded hosts) for a read-only run; "1 stopped (hosts of read-only
 * environments)" for a read-write run whose guard stopped a write to another environment's host; undefined otherwise.
 * The automated sign-in's exempt writes are not counted.
 */
export function writesSummary(tl: Pick<Timeline, 'environment'> | undefined): { text: string; stopped: number } | undefined {
  const env = tl?.environment;
  if (!env) return undefined;
  const n = { blocked: 0, mocked: 0, allowed: 0, passed: 0 };
  for (const w of env.writes ?? []) if (w.outcome !== 'exempt') n[w.outcome]++;
  if (env.access !== 'read-only') return n.blocked ? { text: `${n.blocked} stopped (hosts of read-only environments)`, stopped: n.blocked } : undefined;
  const parts = [`${n.mocked} mocked`, `${n.blocked} stopped`];
  if (n.allowed) parts.push(`${n.allowed} allowed`);
  if (n.passed) parts.push(`${n.passed} to unguarded hosts`);
  return { text: `${parts.join(', ')} (read-only)`, stopped: n.blocked };
}

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
  if (r.stopped_at) {
    const why = r.stopped_at.reason === 'until' ? '--until' : 'irreversible step (dry run)';
    ui.line(`  ${c.dim('stopped')}   ${r.stopped_at.scene}.${r.stopped_at.step} (${why})`);
  }
  let tl: Timeline | undefined;
  if (r.timeline) {
    try {
      tl = await readJson<Timeline>(r.timeline);
    } catch {
      /* the timeline is reported below anyway */
    }
  }
  if (r.capture) {
    const detail = tl ? ` ${c.dim(`(${tl.capture.duration.toFixed(1)} s, ${tl.capture.width * tl.capture.scale}×${tl.capture.height * tl.capture.scale} @ ${tl.capture.fps} fps)`)}` : '';
    ui.line(`  ${c.dim('capture')}   ${ui.path(r.capture)}${detail}`);
  }
  if (r.timeline) ui.line(`  ${c.dim('timeline')}  ${ui.path(r.timeline)}`);
  if (r.screenshots.length) ui.line(`  ${c.dim('shots')}     ${ui.path(join(r.dir, 'screenshots'))} ${c.dim(`(${r.screenshots.length})`)}`);
  ui.line(`  ${c.dim('run')}       ${ui.path(join(r.dir, 'run.json'))}`);
  if (r.hooks.setup !== 'none' || r.hooks.teardown !== 'none') {
    ui.line(`  ${c.dim('hooks')}     setup ${r.hooks.setup}, teardown ${r.hooks.teardown}`);
  }
  const sandbox = sandboxSummary(r);
  if (sandbox) ui.line(`  ${c.dim('sandbox')}   ${sandbox}`);
  // L1.7: what the read-only guard did (timeline.json environment.writes lists each one) — once the run got going.
  const writes = r.steps_done > 0 || (tl?.environment?.writes?.length ?? 0) > 0 ? writesSummary(tl) : undefined;
  if (writes) ui.line(`  ${c.dim('writes')}    ${writes.stopped ? c.yellow(writes.text) : writes.text}`);
  if (r.warnings.length) ui.line(`  ${c.yellow(plural(r.warnings.length, 'warning'))} ${c.dim('(listed in run.json)')}`);
}
