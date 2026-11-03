import { join } from 'node:path';
import { ScenarioError, isAccessError, newRunId } from '@retake/core';
import type { LoadedProject, RunAccess, Scenario } from '@retake/core';
import { HooksSourceError, createHookContext, refuseBesideOldHolder, selectHooks } from '@retake/engine';
import type { HookSelection } from '@retake/engine';
import type { HookContext, HookResult } from '@retake/hooks';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { onInterrupt } from '../interrupt.js';
import type { Ui } from '../ui.js';
import { formatMs, plural, truncate } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { loginCommandFor } from './auth.js';

export interface HookCommandOptions {
  env?: string;
  /** Approve destructive hooks that lack `confirm: true`. */
  yes?: boolean;
  /** Describe and security-check without executing. */
  dry?: boolean;
  /** Let hooks write to a production environment whose project.yaml sets `access: read-write` (L1.7). */
  allowWrites?: boolean;
}

/** ` · production · read-only` for a command header (nothing for an ordinary read-write environment). */
function accessLabel(access: RunAccess): string {
  const parts = [...(access.production ? ['production'] : []), ...(access.mode === 'read-only' ? ['read-only'] : access.production ? ['writes allowed'] : [])];
  return parts.map((p) => ` · ${p}`).join('');
}

function printAccess(ui: Ui, access: RunAccess): void {
  if (access.notice) ui.warn(access.notice);
  if (access.warning) ui.warn(access.warning);
}

/**
 * The hook context of a CLI command (engine createHookContext): destructive hooks approved by --yes or the prompt;
 * `--allow-writes` on a read-only environment is a usage error. Until `close`, Ctrl-C / SIGTERM close the js hooks'
 * browsers (their copies hold a persona's cookies) and exit 130 (the journal keeps what ran: `retake hooks rollback`).
 */
async function hookContext(
  ui: Ui,
  project: LoadedProject,
  opts: HookCommandOptions & { vars?: Record<string, string>; runId?: string; scenario?: Scenario },
  global: GlobalOptions,
): Promise<{ ctx: HookContext; access: RunAccess; close: () => Promise<void>; interrupted: () => boolean }> {
  let made: Awaited<ReturnType<typeof createHookContext>>;
  try {
    made = await createHookContext(project, {
      env: opts.env,
      allowWrites: opts.allowWrites === true,
      dry: opts.dry === true,
      ...(opts.vars ? { vars: opts.vars } : {}),
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.scenario ? { scenario: opts.scenario } : {}),
      loginCommand: loginCommandFor(global),
      log: (level, msg) => {
        // A failing hook is listed with its error by printResults: its error log would print it a second time.
        if (level === 'error') ui.debug(msg);
        else if (level === 'warn') ui.warn(msg);
        else ui.debug(msg);
      },
      confirm: async (description, reason) => {
        if (opts.yes) return true;
        if (!ui.io.canPrompt || !ui.io.confirm) {
          ui.warn(`destructive hook (${reason}) needs approval: add "confirm: true" to it, or pass --yes`);
          return false;
        }
        return ui.io.confirm(`Run destructive hook (${reason}): ${description}?`);
      },
    });
  } catch (e) {
    if (isAccessError(e)) throw new UsageError(e.message);
    throw e;
  }
  const { ctx, access, closeSessions } = made;
  const stop = await onInterrupt(ui, { exit: closeSessions });
  const close = async () => {
    await closeSessions();
    stop.dispose();
  };
  return { ctx, access, close, interrupted: () => stop.interrupted };
}

function printResults(ui: Ui, results: readonly HookResult[]): void {
  const c = ui.c;
  for (const r of results) {
    const icon = r.status === 'ok' ? c.green('✓') : r.status === 'dry' ? c.cyan('◦') : c.red('✗');
    const phase = r.phase === 'rollback' ? c.dim('rollback ') : '';
    const color = r.ok ? c.dim : c.red;
    // A message of several lines: the time ends its first line, the others follow indented.
    const [first, ...more] = (r.ok ? (r.message ?? '') : (r.error ?? r.status)).split('\n');
    ui.line(`  ${icon} ${phase}${truncate(r.description, 90)}  ${color(first)} ${c.dim(formatMs(r.ms))}`);
    for (const l of more) ui.line(`      ${color(l)}`);
  }
}

/**
 * `retake hooks run <project> <source>`: run setup/teardown/reset hooks outside a capture. The journal (with the
 * rollbacks of setup-like runs) is kept in <project>/.retake/journals/<id>.json for `retake hooks rollback`,
 * never in runs/ (which only holds captures).
 */
export async function hooksRunCommand(ui: Ui, global: GlobalOptions, projectArg: string, spec: string, opts: HookCommandOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  let sel: HookSelection;
  try {
    sel = await selectHooks(project, spec, opts.env);
  } catch (e) {
    if (e instanceof HooksSourceError) throw e.usage ? new UsageError(e.message) : new CliError(e.message);
    if (e instanceof ScenarioError && e.issues.length) {
      ui.error(e.message.split('\n')[0]);
      for (const i of e.issues) ui.line(`  ${ui.issue(i, e.file)}`);
      return EXIT.failure;
    }
    throw e;
  }
  const hooks = await import('@retake/hooks');
  const runId = newRunId(`hooks-${sel.label}`);
  const journalFile = hooks.standaloneJournalFile(project.dir, runId);
  const { ctx, access, close, interrupted } = await hookContext(ui, project, { ...opts, env: opts.env ?? sel.env, vars: sel.vars, runId, ...(sel.scenario ? { scenario: sel.scenario } : {}) }, global);
  const c = ui.c;
  ui.line(`${c.bold(`${project.slug}`)} ${sel.phase} hooks ${c.bold(sel.label)} ${c.dim(`· env ${ctx.env.name}${accessLabel(access)}${opts.dry ? ' · dry' : ''} · ${plural(sel.hooks.length, 'hook')}`)}`);
  printAccess(ui, access);
  try {
    const journal = await hooks.Journal.open(journalFile);
    const res = await hooks.runHooks(sel.hooks, ctx, { phase: sel.phase, journal });
    printResults(ui, res.results);
    const pending = journal.pending().length;
    if (pending && !opts.dry) {
      ui.line(c.dim(`  journal ${ui.path(journalFile)} (${plural(pending, 'pending rollback')}: retake hooks rollback ${project.slug} ${runId})`));
    }
    if (interrupted()) return EXIT.interrupted;
    if (res.ok) ui.ok(`${sel.label}: ${opts.dry ? 'checked (nothing executed)' : 'done'}`);
    else ui.error(`${sel.label}: failed`);
    return res.ok ? EXIT.ok : EXIT.failure;
  } finally {
    await close();
  }
}

/** `retake hooks rollback <project> [id]`: replay pending rollbacks (one run or hooks journal, or every pending one). */
export async function hooksRollbackCommand(
  ui: Ui,
  global: GlobalOptions,
  projectArg: string,
  runId: string | undefined,
  opts: HookCommandOptions,
): Promise<ExitCode> {
  const project = await openProject(await openWorkspace(global), projectArg);
  const { ctx, access, close, interrupted } = await hookContext(ui, project, opts, global);
  printAccess(ui, access);
  try {
    const ok = runId === undefined ? await rollbackAllPending(ui, project, ctx) : await rollbackRun(ui, project, ctx, runId);
    if (interrupted()) return EXIT.interrupted;
    return ok ? EXIT.ok : EXIT.failure;
  } finally {
    await close();
  }
}

async function rollbackRun(ui: Ui, project: LoadedProject, ctx: HookContext, runId: string): Promise<boolean> {
  const hooks = await import('@retake/hooks');
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
  const hooks = await import('@retake/hooks');
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
 * `retake env reset <project>`: replay pending rollback journals (runs/ and .retake/journals/), then the
 * project's `reset` hooks (journaled in .retake/journals/).
 */
export async function envResetCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: HookCommandOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  // L5.13: never beside an old Studio or worker (engine legacy.ts).
  await refuseBesideOldHolder(project.root, 'this env reset');
  const hooks = await import('@retake/hooks');
  const runId = newRunId('env-reset');
  const { ctx, access, close, interrupted } = await hookContext(ui, project, { ...opts, runId }, global);
  const c = ui.c;
  ui.line(`${c.bold(project.slug)} env reset ${c.dim(`· env ${ctx.env.name}${accessLabel(access)}${opts.dry ? ' · dry' : ''}`)}`);
  printAccess(ui, access);
  if (ctx.env.sandbox) ui.line(c.dim(`${ctx.env.name} is a sandbox: \`retake sandbox reset ${project.slug} --env ${ctx.env.name}\` restores its seed`));
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
    if (interrupted()) return EXIT.interrupted;
    if (ok) ui.ok(opts.dry ? 'environment reset checked (nothing executed)' : 'environment reset');
    else ui.error('environment reset finished with failures');
    return ok ? EXIT.ok : EXIT.failure;
  } finally {
    await close();
  }
}
