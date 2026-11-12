import { confinementOrDefault, confinementWords } from '@retake/core/model';
import { readOnlyHookMessage } from '@retake/core/environment';
import { AGENT_SQL_REASON, shellAlwaysWrites } from '@retake/core/hooks';
import type { HookKind, HookStep, HttpHookSpec } from '@retake/core/model';
import { checkWriteHosts } from './allow-list.js';
import { hookFiles, hookFingerprint } from './approval.js';
import { describeHook, hookKindOf, withName } from './describe.js';
import { HookError, HookSecurityError, errorMessage } from './errors.js';
import type { Journal } from './journal.js';
import { prepareHook } from './kinds/index.js';
import type { ExecutedHook, PreparedHook } from './kinds/index.js';
import { baseDirOf } from './kinds/common.js';
import { JS_NEEDS_PAGE } from './kinds/js.js';
import { logger, redactDeep, redactText } from './secrets.js';
import { actionLines } from './shown.js';
import { addDrySaved, usesAgentVars } from './template.js';
import { journalsRollback } from './types.js';
import { recordHookRun } from './record.js';
import type { HookApprovalRequest, HookContext, HookLogLevel, HookPhase, HookResult, JournalEntry } from './types.js';
import { nowIso } from './util.js';

export interface RunHooksOptions {
  phase: HookPhase;
  journal: Journal;
  /**
   * Trust `mcp`: these hooks were written by the agent (a scenario's setup, teardown or own named hooks) — a shell one
   * is plain words joined by ` && ` under the rules of core agentShellProblems (kinds/shell.ts). A hook of a person's file (project.yaml, hooks/<name>.yaml, a
   * sandbox's seed) is only shown in full, unless its templates use the agent's variables (HookContext.agentVars).
   */
  agentWritten?: boolean;
}

/** What an approval shows of a prepared hook: its fields, then its rollback's, redacted (shown.ts). */
function shownLines(ctx: HookContext, prepared: PreparedHook): string[] {
  const own = actionLines(redactDeep(ctx, prepared.shown));
  const rb = prepared.rollback ? actionLines(redactDeep(ctx, prepared.rollback.shown), 'rollback ') : [];
  return [...own, ...rb];
}

export interface RunHooksResult {
  /** False when a non-optional hook failed or was refused (setup: completed hooks were rolled back). */
  ok: boolean;
  /** One result per hook that was attempted, then (setup failure) one per rollback. */
  results: HookResult[];
}

type Log = (level: HookLogLevel, msg: string) => void;

interface Attempt {
  result: HookResult;
  /** Journal entry written (or kept in memory) for an executed / failed hook. */
  entry?: JournalEntry;
}

/** A seed step written as a js hook (L1.8): a sandbox's seed runs without a browser. */
export const SEED_NO_JS = 'seed steps run without a browser: use http, sql, shell or exec';

/** Setup and seed refuse to start when a hook can obviously not run (malformed, js without a page; js in a seed). */
function preflight(hooks: HookStep[], ctx: HookContext, phase: HookPhase): HookResult[] {
  const failures: HookResult[] = [];
  hooks.forEach((hook, index) => {
    let kind: HookKind | undefined;
    let error: string | undefined;
    try {
      kind = hookKindOf(hook);
      if (kind === 'js' && phase === 'seed') error = SEED_NO_JS;
      else if (kind === 'js' && !ctx.evalInPage) error = JS_NEEDS_PAGE;
    } catch (e) {
      error = errorMessage(e);
    }
    if (error) {
      failures.push({ index, name: hook?.name, kind, phase, description: describeHook(hook), ok: false, status: 'failed', error, ms: 0 });
    }
  });
  return failures;
}

async function confirmDestructive(hook: HookStep, reason: string, description: string, ctx: HookContext, log: Log, request: HookApprovalRequest) {
  // Through MCP (trust `mcp`), the agent can write `confirm: true` itself: only a human approval counts.
  const mcp = ctx.trust === 'mcp';
  if (!mcp && hook.confirm === true) return;
  const approved = ctx.confirmDestructive ? await ctx.confirmDestructive(description, reason, request) : false;
  if (!approved) {
    throw new HookSecurityError(
      mcp
        ? `refusing hook (${reason}) without a human approval: ${confinementWords(ctx.via)}, "confirm: true" does not count${confinementOrDefault(ctx.via).approval}`
        : `refusing destructive hook (${reason}) without "confirm: true"; add it to the hook once you have checked what it does`,
      'destructive',
    );
  }
  log('warn', mcp ? `hook (${reason}) approved by a human: ${description}` : `destructive hook (${reason}) approved without "confirm: true": ${description}`);
}

/**
 * Why a hook needs a human before it runs, or null: destructive (declared, or found in its templated content); with
 * trust `mcp` also any shell hook (arbitrary local code), an sql hook the agent wrote (`agentWritten`, or a person's
 * whose file, rollback file or database URL uses the agent's vars: PreparedHook.agentVars — treated like its shell
 * hooks, core AGENT_SQL_REASON), and a setup hook whose rollback is destructive, a shell command or
 * JavaScript — the rollback runs later, without asking again.
 */
function approvalReason(hook: HookStep, kind: HookKind, prepared: PreparedHook, ctx: HookContext, agentWritten: boolean): string | null {
  const own = hook.destructive === true ? 'declared destructive' : prepared.destructive;
  if (ctx.trust !== 'mcp') return own;
  const reasons = [
    own ?? (kind === 'shell' ? 'a shell command (runs local code)' : kind === 'sql' && (agentWritten || prepared.agentVars === true) ? AGENT_SQL_REASON : null),
    prepared.rollback?.reason ? `its rollback: ${prepared.rollback.reason}` : null,
  ];
  const r = reasons.filter((x): x is string => x !== null);
  return r.length ? r.join('; ') : null;
}

/** Journal an outcome; a journal that cannot be saved turns the result into a failure. */
async function journalOutcome(journal: Journal, entry: Omit<JournalEntry, 'seq'>, result: HookResult, log: Log): Promise<Attempt> {
  const stored = journal.add(entry);
  result.journal_seq = stored.seq;
  try {
    await journal.save();
  } catch (e) {
    const error = errorMessage(e);
    log('error', error);
    return { result: { ...result, ok: false, status: 'failed', error: result.error ? `${result.error}; ${error}` : error }, entry: stored };
  }
  return { result, entry: stored };
}

async function runOne(hook: HookStep, index: number, total: number, ctx: HookContext, opts: RunHooksOptions, log: Log): Promise<Attempt> {
  const t0 = Date.now();
  const startedAt = nowIso();
  const label = `${opts.phase} hook ${index + 1}/${total}`;
  let description = describeHook(hook);
  let approval: HookResult['approval'];
  let rollbackShown: string | undefined;
  let shown: string[] | undefined;
  const result = (kind: HookKind | undefined, fields: Pick<HookResult, 'ok' | 'status'> & Partial<HookResult>): HookResult => ({
    index,
    name: hook?.name,
    kind,
    phase: opts.phase,
    description,
    ...(hook?.optional ? { optional: true } : {}),
    ...(approval && ctx.trust === 'mcp' ? { approval } : {}),
    ...(rollbackShown !== undefined && ctx.trust === 'mcp' ? { rollback: rollbackShown } : {}),
    ...(shown && ctx.trust === 'mcp' ? { shown } : {}),
    ms: Date.now() - t0,
    ...fields,
  });
  const failure = (kind: HookKind | undefined, e: unknown): HookResult => {
    const refused = e instanceof HookSecurityError;
    const error = redactText(ctx, errorMessage(e));
    log('error', `${label} ${refused ? 'refused' : 'failed'}: ${description}: ${error}`);
    return result(kind, { ok: false, status: refused ? 'refused' : 'failed', error });
  };

  let kind: HookKind;
  try {
    kind = hookKindOf(hook);
  } catch (e) {
    return { result: failure(undefined, e) }; // malformed: nothing to journal
  }
  const entry = (status: JournalEntry['status'], extra: Partial<JournalEntry> = {}): Omit<JournalEntry, 'seq'> => ({
    ...(hook.name ? { name: hook.name } : {}),
    kind,
    phase: opts.phase,
    description,
    env: ctx.env.name,
    ...(ctx.runId ? { run_id: ctx.runId } : {}),
    started_at: startedAt,
    finished_at: nowIso(),
    status,
    ...extra,
  });

  let prepared: PreparedHook;
  let agentWritten = false;
  try {
    if (kind === 'js' && opts.phase === 'seed') throw new HookError(SEED_NO_JS);
    // Through MCP (core agent-trust): the files a hook references stay in the project, never agent-writable when run as
    // code; their bytes are bound to its approval (fingerprint).
    let files: Record<string, string> | undefined;
    agentWritten = ctx.trust === 'mcp' && (opts.agentWritten === true || usesAgentVars(hook, ctx));
    if (ctx.trust === 'mcp') {
      // An agent-written shell hook's words are judged by core agentShellProblems instead (kinds/shell.ts).
      const found = hookFiles(hook, { projectDir: ctx.project.dir, baseDir: baseDirOf(ctx), ...(agentWritten ? { agentWritten } : {}) });
      if (found.problems.length) throw new HookSecurityError(found.problems.join('; '), 'mcp');
      files = found.files;
    }
    prepared = await prepareHook(hook, kind, { ctx, phase: opts.phase, log, ...(agentWritten ? { agentWritten } : {}) });
    description = withName(hook.name, prepared.description);
    if (prepared.rollback) rollbackShown = prepared.rollback.description;
    if (ctx.trust === 'mcp') shown = shownLines(ctx, prepared);
    // Through MCP a shell hook always writes: its `writes: false` was written by whoever drives the server.
    if (ctx.trust === 'mcp' && kind === 'shell' && !prepared.writes) prepared.writes = shellAlwaysWrites(ctx.via);
    // A read-only run (L1.7) refuses a hook that writes before anything else (no destructive prompt for it).
    if (ctx.access?.mode === 'read-only' && prepared.writes) {
      throw new HookSecurityError(readOnlyHookMessage(prepared.writes, ctx.access), 'read-only');
    }
    // Nor does any run write to the hosts of another, read-only environment (production): refused like the above.
    if (prepared.writes && prepared.hosts) checkWriteHosts(prepared.hosts, prepared.writes, ctx.access);
    const reason = approvalReason(hook, kind, prepared, ctx, agentWritten);
    // A seed rebuilds a local, disposable sandbox (L1.8): destructive steps are its job, never asked about. With trust
    // `mcp` a shell seed step still needs a human: it runs local code, whatever the sandbox is.
    const asks = reason !== null && (opts.phase !== 'seed' || (ctx.trust === 'mcp' && kind === 'shell'));
    const request: HookApprovalRequest | undefined = asks
      ? {
          hook,
          phase: opts.phase,
          index,
          env: ctx.env.name,
          ...(files && Object.keys(files).length ? { files } : {}),
          fingerprint: hookFingerprint(hook, { phase: opts.phase, index, env: ctx.env.name, ...(files ? { files } : {}) }),
        }
      : undefined;
    if (request) approval = { reason: reason!, fingerprint: request.fingerprint };
    // A dry run through MCP asks nobody: its result says which hooks a real run needs approved.
    if (request && !(ctx.dryRun && ctx.trust === 'mcp')) await confirmDestructive(hook, reason!, description, ctx, log, request);
    if (ctx.dryRun) {
      const saveAs = kind === 'http' ? (hook as { http: HttpHookSpec }).http.save_as : undefined;
      if (saveAs) addDrySaved(ctx, saveAs);
      const needs = request && ctx.trust === 'mcp' ? `needs a human approval: ${reason}` : reason ? `destructive: ${reason}` : '';
      log('info', `${label} [dry]: would run ${description}${needs ? ` (${needs})` : ''}`);
      return { result: result(kind, { ok: true, status: 'dry', message: needs && ctx.trust === 'mcp' ? `not executed (dry run); ${needs}` : 'not executed (dry run)' }) };
    }
  } catch (e) {
    const r = failure(kind, e);
    return ctx.dryRun ? { result: r } : journalOutcome(opts.journal, entry('failed', { error: r.error }), r, log);
  }

  log('info', `${label}: ${description}`);
  let done: ExecutedHook;
  try {
    done = await prepared.execute();
  } catch (e) {
    const r = failure(kind, e);
    return journalOutcome(opts.journal, entry('failed', { error: r.error }), r, log);
  }

  const message = redactText(ctx, done.message);
  if (done.rollbackError) {
    const error = `ran (${message}) but its rollback cannot be prepared: ${redactText(ctx, done.rollbackError)}`;
    log('error', `${label}: ${error}`);
    return journalOutcome(opts.journal, entry('ok', { error }), result(kind, { ok: false, status: 'failed', message, error }), log);
  }
  log('info', `${label} ok: ${message} (${Date.now() - t0} ms)`);
  const extra = done.rollback && journalsRollback(opts.phase) ? { rollback: done.rollback } : {};
  return journalOutcome(opts.journal, entry('ok', extra), result(kind, { ok: true, status: 'ok', message }), log);
}

/**
 * Run hooks in order, logging each one (secrets redacted) and journaling every execution.
 * - setup: stops at the first failure that is not tolerated (`optional: true` tolerates failures, never
 *   refusals) and rolls back the hooks completed in this call, most recent first — also when `ctx.signal` stopped
 *   it, during any hook or between two (a running shell hook is stopped, an http, sql or js one ends first; the
 *   rollbacks run without the signal); refuses to start when a hook is malformed or a js hook has no page to run in.
 * - seed (L1.8): stops at the first failure like setup, rolls nothing back (the next reset rebuilds the data), never
 *   asks to confirm a destructive step and refuses to start on a js step.
 * - step (L5.8, a `hook:` step during the take): stops at the first failure like setup and journals rollbacks like
 *   setup, but rolls nothing back itself — the step fails, the take stops, and the teardown's rollback of every pending
 *   entry undoes what it did; a cancel stops a running shell command (`ctx.signal`).
 * - teardown / reset: every hook runs; failures are collected.
 * With `ctx.dryRun`, hooks are templated and security-checked but not executed, nor journaled.
 */
export async function runHooks(hooks: HookStep[], ctx: HookContext, opts: RunHooksOptions): Promise<RunHooksResult> {
  const log = logger(ctx);
  const results: HookResult[] = [];
  if (!hooks.length) return { ok: true, results };

  if ((opts.phase === 'setup' || opts.phase === 'seed' || opts.phase === 'step') && !ctx.dryRun) {
    const failures = preflight(hooks, ctx, opts.phase);
    if (failures.length) {
      for (const f of failures) log('error', `${opts.phase} hook ${f.index + 1}/${hooks.length} cannot run: ${f.description}: ${f.error}`);
      log('error', `${opts.phase} not started: no hook was executed`);
      return { ok: false, results: failures };
    }
  }

  const completed: number[] = [];
  let ok = true;
  const rollBack = async () => {
    if (opts.phase !== 'setup' || !completed.length) return;
    log('info', `rolling back ${completed.length} completed setup hook(s)`);
    // An interrupt (ctx.signal) stops the setup, never its rollbacks: they undo what it did. The same context object
    // (the secrets it resolved stay registered for redaction), without its signal meanwhile.
    const signal = ctx.signal;
    ctx.signal = undefined;
    try {
      results.push(...(await opts.journal.rollbackEntries(completed, ctx)));
    } finally {
      ctx.signal = signal;
    }
  };
  for (let i = 0; i < hooks.length; i++) {
    // Only a shell hook stops on the signal: a cancel during an http, sql or js hook (or between two hooks) is seen
    // here, and rolls back like a failure — before the caller's teardown, whatever kind of hook was running.
    if (ctx.signal?.aborted) {
      ok = false;
      log('warn', `${opts.phase} interrupted: ${hooks.length - i} remaining hook(s) not run`);
      await rollBack();
      break;
    }
    const { result, entry } = await runOne(hooks[i], i, hooks.length, ctx, opts, log);
    await recordHookRun(ctx, result);
    results.push(result);
    if (entry?.rollback && entry.status === 'ok') completed.push(entry.seq);
    if (result.ok) continue;
    if (hooks[i]?.optional === true && result.status !== 'refused') {
      log('warn', `${opts.phase} hook ${i + 1}/${hooks.length} is optional: continuing`);
      continue;
    }
    ok = false;
    if (opts.phase !== 'setup' && opts.phase !== 'seed' && opts.phase !== 'step') continue;
    const skipped = hooks.length - i - 1;
    if (skipped) log('warn', `${opts.phase} stopped: ${skipped} remaining hook(s) not run`);
    await rollBack();
    break;
  }
  // A cancel during the last hook stops the setup too: interrupted, not completed.
  if (ok && opts.phase === 'setup' && ctx.signal?.aborted) {
    ok = false;
    log('warn', 'setup interrupted during its last hook');
    await rollBack();
  }
  return { ok, results };
}
