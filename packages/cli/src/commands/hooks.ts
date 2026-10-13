import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ScenarioError,
  compileWritePolicy,
  guardsWrites,
  hasErrors,
  isAccessError,
  loadScenario,
  loginMatchers,
  matchLoginUrl,
  newRunId,
  parseHookFile,
  planPersonas,
  resolveEnvironment,
  resolvePersonas,
  resolveRunAccess,
  runAccess,
  urlOriginPath,
} from '@demo-studio/core';
import type { HookStep, LoadedProject, ResolvedPersona, RunAccess, Scenario } from '@demo-studio/core';
import type { HookContext, HookPhase, HookResult } from '@demo-studio/hooks';
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

/**
 * The access of a hooks command (L1.7): its environment's, with `--allow-writes` (a usage error on a read-only
 * environment), and the hosts of the project's read-only environments it must not write to. Journal replays judge
 * each entry by its own environment (`accessOf`).
 */
function commandAccess(project: LoadedProject, env: ReturnType<typeof resolveEnvironment>, allowWrites: boolean): { access: RunAccess; accessOf: (name: string) => RunAccess | undefined } {
  let access: RunAccess;
  try {
    access = resolveRunAccess(env, { allowWrites, project });
  } catch (e) {
    if (isAccessError(e)) throw new UsageError(e.message);
    throw e;
  }
  const accessOf = (name: string): RunAccess | undefined => {
    try {
      return runAccess(resolveEnvironment(project, name), allowWrites, project);
    } catch {
      return undefined; // an environment no longer in project.yaml: the command's access
    }
  };
  return { access, accessOf };
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
 * A hook context for CLI commands; js hooks get a headless browser opened on first use — signed in as the persona of
 * their page (L1.6: a copy of its session, as in a run; a tab landing on its sign-in page fails the hook), one browser
 * per persona. A scenario's hooks bind their tabs as its run does (core planPersonas: the persona its scenes film the
 * page with, `none` included). Until `close`, Ctrl-C / SIGTERM close those browsers (their copies hold a persona's
 * cookies) and exit 130 (the journal keeps what ran: `studio hooks rollback`).
 */
async function hookContext(
  ui: Ui,
  project: LoadedProject,
  opts: HookCommandOptions & { vars?: Record<string, string>; runId?: string; scenario?: Scenario },
  global: GlobalOptions,
): Promise<{ ctx: HookContext; access: RunAccess; close: () => Promise<void>; interrupted: () => boolean }> {
  const env = resolveEnvironment(project, opts.env);
  const { access, accessOf } = commandAccess(project, env, opts.allowWrites === true);
  const personas = resolvePersonas(project, env.name);
  const sessions = new Map<string, Promise<import('@demo-studio/runner-web').BrowserSession>>();
  const command = loginCommandFor(global);
  const runId = opts.runId ?? newRunId('hooks');
  const planned = opts.scenario ? planPersonas(opts.scenario, { env: env.name, envPages: env.pages, personas, hooks: true }).hookPages : undefined;
  // A read-only command (L1.7): a js hook's tab stops its writes (never mocked); its browser is guarded like a run's.
  // Any command: writes to the hosts of the project's read-only environments (production) are stopped too.
  const policy = compileWritePolicy(env, { access });
  const writes = guardsWrites(policy) ? { policy, onWrite: (w: { label: string; outcome: string }) => ctx.log('debug', `js hook tab: ${w.label} ${w.outcome}`) } : undefined;
  /**
   * The persona a js hook tab of page `key` is signed in as: the scenario's binding of that page, else the one whose
   * pages list it, else the legacy one (undefined: none).
   */
  const personaOf = (key: string): ResolvedPersona | undefined => {
    if (planned?.has(key)) {
      const name = planned.get(key);
      return name === null ? undefined : personas.find((p) => p.name === name);
    }
    return personas.find((p) => !p.legacy && p.pages.includes(key)) ?? personas.find((p) => p.legacy);
  };
  const open = async (persona: ResolvedPersona | undefined) => {
    const rw = await import('@demo-studio/runner-web');
    const capture = project.config.capture;
    const prepared = persona
      ? await rw.prepareSessions([persona], { runId, log: (level, msg) => ctx.log(level, msg), failure: `js hooks cannot use the saved session of persona ${persona.name}:` })
      : [];
    return rw.openSession({
      width: capture.width,
      height: capture.height,
      scale: capture.scale,
      kit: rw.kitConfigFor(undefined),
      browser: rw.projectBrowser(project),
      log: (level, msg) => ctx.log(level, msg),
      ...(writes ? { writes: { policy: writes.policy } } : {}),
      ...(persona ? { realms: prepared.map((p) => p.realm), hookRealmOf: () => persona.name } : {}),
    });
  };
  const ctx: HookContext = {
    project,
    env,
    vars: { ...(project.config.vars ?? {}), ...(opts.vars ?? {}) },
    runId: opts.runId,
    dryRun: opts.dry === true,
    saved: {},
    access,
    accessOf,
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
      if (!Object.keys(env.pages).length) throw new CliError(`environment "${env.name}" declares no pages for the js hook to run in`);
      const persona = personaOf(pageKey ?? Object.keys(env.pages)[0]);
      let session = sessions.get(persona?.name ?? '');
      if (!session) {
        session = open(persona);
        sessions.set(persona?.name ?? '', session);
      }
      const matchers = persona ? loginMatchers(persona.loginPatterns, env.pages) : [];
      const loginLanding = (key: string, url: string): string | null =>
        persona && matchLoginUrl(url, matchers)
          ? `js hook page "${key}" (persona ${persona.name}) landed on the sign-in page (${urlOriginPath(url)}): its session expired — sign in again: ${command({ project: project.slug, env: env.name, ...(persona.legacy ? {} : { persona: persona.name }) })}`
          : null;
      // The guarded hook tab of that page (hosts outside the allow-list are blocked), reused by later js hooks.
      return rw.evalHookInPage(await session, { project, env, log: (level, msg) => ctx.log(level, msg), ...(persona ? { loginLanding } : {}), ...(writes ? { writes } : {}) }, pageKey, code);
    },
  };
  const closeSessions = async () => {
    for (const s of sessions.values()) await (await s.catch(() => null))?.close();
  };
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

interface HookSelection {
  label: string;
  hooks: HookStep[];
  phase: HookPhase;
  vars?: Record<string, string>;
  env?: string;
  /** The scenario of `<scenario>:setup|teardown` (its js hook tabs are bound as in its run). */
  scenario?: Scenario;
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
    return { label: `${loaded.name}-${which}`, hooks, phase: which as HookPhase, vars: loaded.scenario.vars, env: loaded.scenario.env, scenario: loaded.scenario };
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
      ui.line(c.dim(`  journal ${ui.path(journalFile)} (${plural(pending, 'pending rollback')}: studio hooks rollback ${project.slug} ${runId})`));
    }
    if (interrupted()) return EXIT.interrupted;
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
  const { ctx, access, close, interrupted } = await hookContext(ui, project, { ...opts, runId }, global);
  const c = ui.c;
  ui.line(`${c.bold(project.slug)} env reset ${c.dim(`· env ${ctx.env.name}${accessLabel(access)}${opts.dry ? ' · dry' : ''}`)}`);
  printAccess(ui, access);
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
