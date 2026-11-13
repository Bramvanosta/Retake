import { showHiddenCharsLine } from '@retake/core/base';
import { newRunId } from '@retake/core/ids';
import { isAccessError } from '@retake/core/environment';
import { ScenarioError } from '@retake/core/scenario';
import type { RunAccess } from '@retake/core/environment';
import type { WorkPolicy } from '@retake/core/policy';
import type { HookContext, HookResult } from '@retake/core/hooks';
import {
  HooksSourceError,
  scenarioHooksCheck,
  callerOf,
  envResetWork,
  hooksRunWork,
  hooksTrustView,
  listedAuthor,
  listingContext,
  rollbackActionLines,
  rollbackWork,
  trustScenarioHooks,
} from '@retake/engine';
import type { HookJournal, HookJournalRollback, HookWorkOptions, HooksRunOutcome, PendingHookJournal } from '@retake/engine';
import { fileFacts } from '@retake/core/io';
import { agentHooksListing, askAgentHooks, hooksNoun } from '../agent-hooks.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { onInterrupt } from '../interrupt.js';
import type { Ui } from '../ui.js';
import { formatMs, plural, truncate } from '../ui.js';
import { cliPorts, openProject, openWorkspace } from '../workspace.js';
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
  /**
   * L5.14: ask, in a terminal, about each rollback whose journal entry Retake did not sign for its journal (shown in
   * full; y/N, default no) — never a sql or js one, one with secrets or a shell one on a sandbox.
   */
  replayUnsigned?: boolean;
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
 * What a CLI command's hooks run with (engine hooks-work.ts): trust `author`; destructive hooks approved by --yes or the
 * prompt; `--allow-writes` on a read-only environment is a usage error. While the hooks' sessions are open, Ctrl-C /
 * SIGTERM close the js hooks' browsers (their copies hold a persona's cookies) and exit 130 (the journal keeps what
 * ran: `retake hooks rollback`). No job protection (project files only, approved bytes, agent checks): a person's.
 */
function workOptions(ui: Ui, opts: HookCommandOptions, global: GlobalOptions, policy: WorkPolicy): HookWorkOptions & { trust: 'author' } {
  return {
    policy,
    hooks: cliPorts.hooks,
    pages: cliPorts.capture.hookPages,
    secrets: cliPorts.secrets,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    allowWrites: opts.allowWrites === true,
    dry: opts.dry === true,
    trust: 'author',
    loginCommand: loginCommandFor(global),
    // Each hook and rollback run is a line of the workspace journal, as the person's.
    recordAs: { caller: callerOf('cli'), clock: cliPorts.clock },
    replayUnsigned:
      opts.replayUnsigned === true
        ? async (entry, file) => {
            const c = ui.c;
            ui.line(`${c.yellow('not signed by this Retake home')} ${c.dim('journal')} ${ui.path(file)} ${c.dim(`#${entry.seq}${entry.env !== undefined ? ` · env ${entry.env}` : ''}`)}`);
            if (entry.rollback) for (const l of rollbackActionLines(entry.rollback)) ui.line(`      ${l}`);
            return ui.io.confirm ? ui.io.confirm(`Replay this rollback (#${entry.seq}), exactly as shown?`) : false;
          }
        : false,
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
    onInterrupt: (closeSessions) => onInterrupt(ui, { exit: closeSessions }),
    contextError: (e) => (isAccessError(e) ? new UsageError(e.message) : e),
  };
}

/** An unsigned entry is replayed only on a person's yes, typed at the question about it: never without a terminal. */
function checkReplayUnsigned(ui: Ui, opts: HookCommandOptions): void {
  if (opts.replayUnsigned && !opts.dry && !(ui.io.canPrompt && ui.io.confirm)) {
    throw new UsageError('--replay-unsigned asks about each rollback Retake did not sign, in a terminal: run it in an interactive terminal (its input is not one)');
  }
}

/** A failure the command printed itself: it ends with this exit code and nothing more. */
class Printed extends Error {
  constructor(readonly exitCode: ExitCode) {
    super('printed');
  }
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
  // Not reached through `retake` (hooks run declares no --replay-unsigned: commander refuses it, exit 2).
  checkReplayUnsigned(ui, opts);
  const c = ui.c;
  let out: HooksRunOutcome;
  try {
    out = await hooksRunWork(project, spec, {
      ...workOptions(ui, opts, global, ws.policy),
      reads: ws.reads,
      runId: (sel) => newRunId(`hooks-${sel.label}`),
      selectError: (e) => {
        if (e instanceof HooksSourceError) return e.usage ? new UsageError(e.message) : new CliError(e.message);
        if (e instanceof ScenarioError && e.issues.length) {
          ui.error(e.message.split('\n')[0]);
          for (const i of e.issues) ui.line(`  ${ui.issue(i, e.file)}`);
          return new Printed(EXIT.failure);
        }
        return e;
      },
      // L7.27, L7.33: a scenario's setup or teardown whose bytes an agent wrote: its shell and sql hooks are listed, and run only on a
      // person's yes (a terminal's, or --yes); listed only with --dry (nothing executes).
      onSelected: async (sel, { runId }) => {
        if (!sel.scenario || sel.file === undefined || (sel.phase !== 'setup' && sel.phase !== 'teardown')) return;
        const sc = sel.scenario;
        const check = await scenarioHooksCheck(
          ws.root,
          project,
          { file: sel.file, ...(sel.sha256 !== undefined ? { sha256: sel.sha256 } : {}), scenario: sc },
          async () => listingContext(project, sc, opts.env ?? sel.env, { id: runId }),
          cliPorts.hooks,
          [sel.phase],
        );
        const found = check.ask;
        const held = check.bound ? { trustedFiles: check.bound } : undefined;
        if (!found) return held;
        const verdict = await askAgentHooks(ui, found, {
          scenario: sel.label.replace(/-(setup|teardown)$/, ''),
          run: opts.dry ? '--dry' : true,
          yes: opts.yes === true,
          print: (header, lines) => {
            ui.warn(header);
            for (const l of lines) ui.line(l);
          },
          note: (message) => ui.warn(message),
        });
        if (!verdict.ok) {
          ui.error(verdict.message);
          throw new Printed(EXIT.failure);
        }
        return held;
      },
      onStart: ({ sel, ctx, access }) => {
        ui.line(
          `${c.bold(`${project.slug}`)} ${sel.phase} hooks ${c.bold(sel.label)} ${c.dim(`· env ${ctx.env.name}${accessLabel(access)}${opts.dry ? ' · dry' : ''} · ${plural(sel.hooks.length, 'hook')}`)}`,
        );
        printAccess(ui, access);
      },
      onResults: (r) => {
        printResults(ui, r.results);
        if (r.pending && !opts.dry) {
          ui.line(c.dim(`  journal ${ui.path(r.journalFile)} (${plural(r.pending, 'pending rollback')}: retake hooks rollback ${project.slug} ${r.runId})`));
        }
        if (r.interrupted) return;
        if (r.ok) ui.ok(`${r.sel.label}: ${opts.dry ? 'checked (nothing executed)' : 'done'}`);
        else ui.error(`${r.sel.label}: failed`);
      },
    });
  } catch (e) {
    if (e instanceof Printed) return e.exitCode;
    throw e;
  }
  if (out.interrupted) return EXIT.interrupted;
  return out.ok ? EXIT.ok : EXIT.failure;
}

/** `retake hooks rollback <project> [id]`: replay pending rollbacks (one run or hooks journal, or every pending one). */
export async function hooksRollbackCommand(ui: Ui, global: GlobalOptions, projectArg: string, runId: string | undefined, opts: HookCommandOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  checkReplayUnsigned(ui, opts);
  const out = await rollbackWork(project, {
    ...workOptions(ui, opts, global, ws.policy),
    ...(runId !== undefined ? { id: runId } : {}),
    onStart: ({ access }) => printAccess(ui, access),
    listed: (list, ctx) => (runId === undefined ? listAllPending(ui, list, ctx) : listRun(ui, runId, list, ctx)),
    onResults: (r) => {
      if (r.kind === 'run') printResults(ui, r.results);
      else if (r.kind === 'pending') printRollbacks(ui, r.outcomes);
    },
  });
  if (out.kind === 'missing') throw new CliError(`"${out.id}" has no hooks journal (looked for ${out.looked[0]} and ${out.looked[1]})`);
  if (out.interrupted) return EXIT.interrupted;
  return out.ok ? EXIT.ok : EXIT.failure;
}

/** One run's journal about to be replayed (`[]`: nothing pending in it). */
function listRun(ui: Ui, runId: string, list: readonly PendingHookJournal[], ctx: HookContext): void {
  const p = list[0];
  if (!p?.journal) {
    ui.ok(`run ${runId}: nothing to roll back`);
    return;
  }
  ui.line(`${ui.c.bold('rollback')} ${runId} ${ui.c.dim(`(${plural(p.journal.pending().length, 'entry', 'entries')})`)}`);
  ui.line(`${ui.c.dim('journal')} ${ui.path(p.file)}`);
  listPending(ui, p.journal, ctx);
}

/**
 * L5.14: what a replay is about to run, before it runs — each pending rollback, most recent first, and whether Retake
 * recorded it in this journal with this home (its entry is signed). An unsigned one is shown in full, every field as it
 * would run (its description is the writer's words), and replayed only on a yes to it with --replay-unsigned.
 */
function listPending(ui: Ui, journal: HookJournal, ctx: HookContext): void {
  const c = ui.c;
  const entries = [...journal.pending()].sort((a, b) => b.seq - a.seq);
  for (const e of entries) {
    const env = e.env !== undefined ? c.dim(` · env ${e.env}`) : '';
    if (journal.isSigned(e)) {
      ui.line(`  ${c.dim(`#${e.seq}`)} ${truncate(e.rollback?.description ?? e.description, 90)}${env}`);
      continue;
    }
    const note = ctx.dryRun ? 'listed only (dry run)' : ctx.replayUnsigned ? 'asked about below' : 'not replayed without --replay-unsigned (in a terminal)';
    ui.line(`  ${c.dim(`#${e.seq}`)}${env} ${c.yellow(`not signed by this Retake home: ${note}`)}`);
    if (e.rollback) for (const l of rollbackActionLines(e.rollback)) ui.line(`      ${l}`);
  }
}

/** Every pending journal of a project, most recent run first, as the replay is about to run them. */
function listAllPending(ui: Ui, list: readonly PendingHookJournal[], ctx: HookContext): void {
  if (!list.length) {
    ui.ok('no pending rollbacks');
    return;
  }
  ui.line(`${ui.c.bold('pending rollbacks')} ${ui.c.dim(`(${plural(list.length, 'journal')})`)}`);
  for (const p of list) {
    ui.line(`${ui.c.dim('journal')} ${ui.path(p.file)}`);
    if (p.journal) listPending(ui, p.journal, ctx);
  }
}

/** What replaying each pending journal gave. */
function printRollbacks(ui: Ui, outcomes: readonly HookJournalRollback[]): void {
  for (const o of outcomes) {
    ui.line(`${ui.c.bold('rollback')} ${ui.path(o.file)}`);
    if (o.error) ui.error(o.error);
    printResults(ui, o.results);
  }
}

/**
 * `retake env reset <project>`: replay pending rollback journals (runs/ and .retake/journals/), then the
 * project's `reset` hooks (journaled in .retake/journals/).
 */
export async function envResetCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: HookCommandOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const runId = newRunId('env-reset');
  checkReplayUnsigned(ui, opts);
  const c = ui.c;
  const out = await envResetWork(project, {
    ...workOptions(ui, opts, global, ws.policy),
    runId,
    onStart: ({ ctx, access }) => {
      ui.line(`${c.bold(project.slug)} env reset ${c.dim(`· env ${ctx.env.name}${accessLabel(access)}${opts.dry ? ' · dry' : ''}`)}`);
      printAccess(ui, access);
      if (ctx.env.sandbox) ui.line(c.dim(`${ctx.env.name} is a sandbox: \`retake sandbox reset ${project.slug} --env ${ctx.env.name}\` restores its seed`));
    },
    listed: (list, ctx) => listAllPending(ui, list, ctx),
    onRollbacks: (outcomes) => printRollbacks(ui, outcomes),
    onReset: (hooks) => ui.line(hooks.length ? `${c.bold('reset')} ${c.dim(plural(hooks.length, 'hook'))}` : c.dim('no reset hooks in project.yaml')),
    onResults: (r) => {
      if (r.reset) printResults(ui, r.reset.results);
      if (r.interrupted) return;
      if (r.ok) ui.ok(opts.dry ? 'environment reset checked (nothing executed)' : 'environment reset');
      else ui.error('environment reset finished with failures');
    },
  });
  if (out.interrupted) return EXIT.interrupted;
  return out.ok ? EXIT.ok : EXIT.failure;
}

export interface HooksTrustOptions {
  env?: string;
  /** Mark them without asking (they are listed first). */
  yes?: boolean;
}

/**
 * `retake hooks trust <project> <scenario>` (L7.27): a person marks the shell and sql hooks of a scenario an agent wrote as
 * theirs — listed as a run lists them, then asked (y/N; `--yes`; without a terminal and without `--yes`, refused) —
 * and on yes one record line by the person settles them: a run no longer asks until they change. A terminal's command
 * only: no MCP tool or Studio route does this.
 */
export async function hooksTrustCommand(ui: Ui, global: GlobalOptions, projectArg: string, scenarioArg: string, opts: HooksTrustOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const view = await hooksTrustView(ws.root, project, scenarioArg, { files: fileFacts(ws.policy), hooks: cliPorts.hooks, ...(opts.env !== undefined ? { env: opts.env } : {}) });
  const name = showHiddenCharsLine(view.name);
  if (!view.hooks.length) {
    ui.ok(`scenario ${name} has no shell or sql hooks: nothing to trust`);
    return EXIT.ok;
  }
  if (!view.author.agent) {
    ui.ok(`the hooks of scenario ${name} are already yours: a run does not ask about them`);
    return EXIT.ok;
  }
  const listing = agentHooksListing(view.name, { hooks: view.hooks, ...listedAuthor(view.author) });
  ui.warn(listing.header);
  for (const l of listing.lines) ui.line(l);
  const n = view.hooks.length === 1 ? `this ${hooksNoun(view.hooks)}` : `these ${view.hooks.length} ${hooksNoun(view.hooks)}`;
  if (!opts.yes) {
    if (!ui.io.canPrompt || !ui.io.confirm) {
      throw new CliError(`refused: marking the hooks of scenario ${name} as yours takes a person's yes — answer in a terminal, or pass --yes`);
    }
    let yes = false;
    try {
      yes = await ui.io.confirm(`Mark ${n} as yours, as listed (runs no longer ask until they change)?`);
    } catch {
      yes = false; // the input closed: no answer is a no
    }
    if (!yes) throw new CliError(`not trusted: the hooks of scenario ${name} stay asked about (nothing written)`);
  }
  await trustScenarioHooks(project, view, callerOf('cli'), cliPorts);
  ui.ok(`the hooks of scenario ${name} are yours now: a run asks again once they change`);
  return EXIT.ok;
}
