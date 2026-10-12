import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ScenarioError, hasErrors, loadScenario, newRunId, parseHookFile, resolveEnvironment } from '@demo-studio/core';
import type { HookStep, LoadedProject } from '@demo-studio/core';
import type { HookContext, HookPhase, HookResult } from '@demo-studio/hooks';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { formatMs, plural, truncate } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface HookCommandOptions {
  env?: string;
  /** Approve destructive hooks that lack `confirm: true`. */
  yes?: boolean;
  /** Describe and security-check without executing. */
  dry?: boolean;
}

/** A hook context for CLI commands; js hooks get a headless browser opened on first use. */
async function hookContext(
  ui: Ui,
  project: LoadedProject,
  opts: HookCommandOptions & { vars?: Record<string, string>; runId?: string },
): Promise<{ ctx: HookContext; close: () => Promise<void> }> {
  const env = resolveEnvironment(project, opts.env);
  let session: import('@demo-studio/runner-web').BrowserSession | null = null;
  const ctx: HookContext = {
    project,
    env,
    vars: { ...(project.config.vars ?? {}), ...(opts.vars ?? {}) },
    runId: opts.runId,
    dryRun: opts.dry === true,
    saved: {},
    log: (level, msg) => {
      // A failing hook is listed with its error by printResults: its error log would print it a second time.
      if (level === 'error') ui.debug(msg);
      else if (level === 'warn') ui.warn(msg);
      else ui.debug(msg);
    },
    confirmDestructive: async (description, reason) => {
      if (opts.yes) return true;
      if (!ui.io.canPrompt || !ui.io.confirm) {
        ui.warn(`destructive hook (${reason}) needs approval: add "confirm: true" to it, or pass --yes`);
        return false;
      }
      return ui.io.confirm(`Run destructive hook (${reason}): ${description}?`);
    },
    evalInPage: async (pageKey, code) => {
      const rw = await import('@demo-studio/runner-web');
      if (!session) {
        const capture = project.config.capture;
        const auth = rw.resolveAuth(project, env.name);
        session = await rw.openSession({
          width: capture.width,
          height: capture.height,
          scale: capture.scale,
          kit: rw.kitConfigFor(undefined),
          browser: rw.projectBrowser(project),
          profileDir: auth.profileDir,
          storageState: auth.storageState,
          log: (level, msg) => ctx.log(level, msg),
        });
      }
      const key = pageKey ?? Object.keys(env.pages)[0];
      if (!key) throw new CliError(`environment "${env.name}" declares no pages for the js hook to run in`);
      const page = await session.page(key);
      if ((page.url() === 'about:blank' || page.url() === '') && env.pages[key]) {
        await page.goto(env.pages[key], { waitUntil: 'load', timeout: 60_000 });
      }
      return rw.evalInPage(page, code);
    },
  };
  return { ctx, close: async () => void (await session?.close()) };
}

function printResults(ui: Ui, results: readonly HookResult[]): void {
  const c = ui.c;
  for (const r of results) {
    const icon = r.status === 'ok' ? c.green('✓') : r.status === 'dry' ? c.cyan('◦') : c.red('✗');
    const phase = r.phase === 'rollback' ? c.dim('rollback ') : '';
    const detail = r.ok ? c.dim(r.message ?? '') : c.red(r.error ?? r.status);
    ui.line(`  ${icon} ${phase}${truncate(r.description, 90)}  ${detail} ${c.dim(formatMs(r.ms))}`);
  }
}

interface HookSelection {
  label: string;
  hooks: HookStep[];
  phase: HookPhase;
  vars?: Record<string, string>;
  env?: string;
}

async function selectHooks(project: LoadedProject, spec: string, envOpt?: string): Promise<HookSelection> {
  if (spec === 'reset') {
    const hooks = project.config.reset ?? [];
    if (!hooks.length) throw new CliError(`project "${project.slug}" declares no reset hooks (add \`reset:\` to project.yaml)`);
    return { label: 'reset', hooks, phase: 'reset' };
  }
  const m = /^([^:/\\]+):(setup|teardown)$/.exec(spec);
  if (m) {
    const [, name, which] = m;
    const loaded = await loadScenario(project, name, { env: envOpt });
    const hooks = (which === 'setup' ? loaded.scenario.setup : loaded.scenario.teardown) ?? [];
    if (!hooks.length) throw new CliError(`scenario "${loaded.name}" has no ${which} hooks`);
    return { label: `${loaded.name}-${which}`, hooks, phase: which as HookPhase, vars: loaded.scenario.vars, env: loaded.scenario.env };
  }
  if (/\.ya?ml$/i.test(spec)) {
    const candidates = isAbsolute(spec) ? [spec] : [resolve(project.dir, spec), resolve(spec)];
    const file = candidates.find((f) => existsSync(f));
    if (!file) throw new CliError(`hooks file "${spec}" not found (looked in ${candidates.join(' and ')})`);
    const { hooks, issues } = parseHookFile(await readFile(file, 'utf8'), { file, project });
    if (!hooks || hasErrors(issues)) throw new ScenarioError(`hooks file ${file} is invalid`, issues, file);
    const base = file.replace(/^.*[\\/]/, '').replace(/\.ya?ml$/i, '');
    return { label: base, hooks, phase: 'setup' };
  }
  throw new UsageError(`"${spec}" is not a hooks source: use <scenario>:setup, <scenario>:teardown, reset, or a .yaml file of hooks`);
}

/**
 * `studio hooks run <project> <source>`: run setup/teardown/reset hooks outside a capture. The journal (with the
 * rollbacks of setup-like runs) is kept in <project>/.demo-studio/journals/<id>.json for `studio hooks rollback`,
 * never in runs/ (which only holds captures).
 */
export async function hooksRunCommand(ui: Ui, global: GlobalOptions, projectArg: string, spec: string, opts: HookCommandOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  let sel: HookSelection;
  try {
    sel = await selectHooks(project, spec, opts.env);
  } catch (e) {
    if (e instanceof ScenarioError && e.issues.length) {
      ui.error(e.message.split('\n')[0]);
      for (const i of e.issues) ui.line(`  ${ui.issue(i, e.file)}`);
      return EXIT.failure;
    }
    throw e;
  }
  const hooks = await import('@demo-studio/hooks');
  const runId = newRunId(`hooks-${sel.label}`);
  const journalFile = hooks.standaloneJournalFile(project.dir, runId);
  const { ctx, close } = await hookContext(ui, project, { ...opts, env: opts.env ?? sel.env, vars: sel.vars, runId });
  const c = ui.c;
  ui.line(`${c.bold(`${project.slug}`)} ${sel.phase} hooks ${c.bold(sel.label)} ${c.dim(`· env ${ctx.env.name}${opts.dry ? ' · dry' : ''} · ${plural(sel.hooks.length, 'hook')}`)}`);
  try {
    const journal = await hooks.Journal.open(journalFile);
    const res = await hooks.runHooks(sel.hooks, ctx, { phase: sel.phase, journal });
    printResults(ui, res.results);
    const pending = journal.pending().length;
    if (pending && !opts.dry) {
      ui.line(c.dim(`  journal ${ui.path(journalFile)} (${plural(pending, 'pending rollback')}: studio hooks rollback ${project.slug} ${runId})`));
    }
    if (res.ok) ui.ok(`${sel.label}: ${opts.dry ? 'checked (nothing executed)' : 'done'}`);
    else ui.error(`${sel.label}: failed`);
    return res.ok ? EXIT.ok : EXIT.failure;
  } finally {
    await close();
  }
}

/** `studio hooks rollback <project> [id]`: replay pending rollbacks (one run or hooks journal, or every pending one). */
export async function hooksRollbackCommand(
  ui: Ui,
  global: GlobalOptions,
  projectArg: string,
  runId: string | undefined,
  opts: HookCommandOptions,
): Promise<ExitCode> {
  const project = await openProject(await openWorkspace(global), projectArg);
  const { ctx, close } = await hookContext(ui, project, opts);
  try {
    const ok = runId === undefined ? await rollbackAllPending(ui, project, ctx) : await rollbackRun(ui, project, ctx, runId);
    return ok ? EXIT.ok : EXIT.failure;
  } finally {
    await close();
  }
}

async function rollbackRun(ui: Ui, project: LoadedProject, ctx: HookContext, runId: string): Promise<boolean> {
  const hooks = await import('@demo-studio/hooks');
  const file = hooks.findJournal(project.dir, runId);
  if (!file) {
    throw new CliError(
      `"${runId}" has no hooks journal (looked for ${join(project.dir, 'runs', runId, hooks.JOURNAL_FILE)} and ${hooks.standaloneJournalFile(project.dir, runId)})`,
    );
  }
  const journal = await hooks.Journal.open(file);
  const pending = journal.pending().length;
  if (!pending) {
    ui.ok(`run ${runId}: nothing to roll back`);
    return true;
  }
  ui.line(`${ui.c.bold('rollback')} ${runId} ${ui.c.dim(`(${plural(pending, 'entry', 'entries')})`)}`);
  const results = await journal.rollbackAll(ctx);
  printResults(ui, results);
  return results.every((r) => r.ok);
}

/** Roll back every pending journal of a project, most recent run first. True when all succeeded. */
async function rollbackAllPending(ui: Ui, project: LoadedProject, ctx: HookContext): Promise<boolean> {
  const hooks = await import('@demo-studio/hooks');
  const outcomes = await hooks.rollbackPendingJournals(project.dir, ctx);
  if (!outcomes.length) {
    ui.ok('no pending rollbacks');
    return true;
  }
  let ok = true;
  for (const o of outcomes) {
    ui.line(`${ui.c.bold('rollback')} ${ui.path(o.file)}`);
    if (o.error) {
      ui.error(o.error);
      ok = false;
    }
    printResults(ui, o.results);
    if (o.results.some((r) => !r.ok)) ok = false;
  }
  return ok;
}

/**
 * `studio env reset <project>`: replay pending rollback journals (runs/ and .demo-studio/journals/), then the
 * project's `reset` hooks (journaled in .demo-studio/journals/).
 */
export async function envResetCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: HookCommandOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const hooks = await import('@demo-studio/hooks');
  const runId = newRunId('env-reset');
  const { ctx, close } = await hookContext(ui, project, { ...opts, runId });
  const c = ui.c;
  ui.line(`${c.bold(project.slug)} env reset ${c.dim(`· env ${ctx.env.name}${opts.dry ? ' · dry' : ''}`)}`);
  try {
    let ok = await rollbackAllPending(ui, project, ctx);
    const reset = project.config.reset ?? [];
    if (reset.length) {
      ui.line(`${c.bold('reset')} ${c.dim(plural(reset.length, 'hook'))}`);
      const journal = await hooks.Journal.open(hooks.standaloneJournalFile(project.dir, runId));
      const res = await hooks.runHooks(reset, ctx, { phase: 'reset', journal });
      printResults(ui, res.results);
      ok &&= res.ok;
    } else {
      ui.line(c.dim('no reset hooks in project.yaml'));
    }
    if (ok) ui.ok(opts.dry ? 'environment reset checked (nothing executed)' : 'environment reset');
    else ui.error('environment reset finished with failures');
    return ok ? EXIT.ok : EXIT.failure;
  } finally {
    await close();
  }
}
