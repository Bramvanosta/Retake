import type { HookKind, HookStep, HttpHookSpec } from '@demo-studio/core';
import { describeHook, hookKindOf, withName } from './describe.js';
import { HookSecurityError, errorMessage } from './errors.js';
import type { Journal } from './journal.js';
import { prepareHook } from './kinds/index.js';
import type { ExecutedHook, PreparedHook } from './kinds/index.js';
import { JS_NEEDS_PAGE } from './kinds/js.js';
import { logger, redactText } from './secrets.js';
import { addDrySaved } from './template.js';
import type { HookContext, HookLogLevel, HookPhase, HookResult, JournalEntry } from './types.js';
import { nowIso } from './util.js';

export interface RunHooksOptions {
  phase: HookPhase;
  journal: Journal;
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

/** Setup refuses to start when a hook can obviously not run (malformed, js without a page). */
function preflight(hooks: HookStep[], ctx: HookContext, phase: HookPhase): HookResult[] {
  const failures: HookResult[] = [];
  hooks.forEach((hook, index) => {
    let kind: HookKind | undefined;
    let error: string | undefined;
    try {
      kind = hookKindOf(hook);
      if (kind === 'js' && !ctx.evalInPage) error = JS_NEEDS_PAGE;
    } catch (e) {
      error = errorMessage(e);
    }
    if (error) {
      failures.push({ index, name: hook?.name, kind, phase, description: describeHook(hook), ok: false, status: 'failed', error, ms: 0 });
    }
  });
  return failures;
}

async function confirmDestructive(hook: HookStep, reason: string, description: string, ctx: HookContext, log: Log) {
  if (hook.confirm === true) return;
  const approved = ctx.confirmDestructive ? await ctx.confirmDestructive(description, reason) : false;
  if (!approved) {
    throw new HookSecurityError(
      `refusing destructive hook (${reason}) without "confirm: true"; add it to the hook once you have checked what it does`,
      'destructive',
    );
  }
  log('warn', `destructive hook (${reason}) approved without "confirm: true": ${description}`);
}

/** Journal an outcome; a journal that cannot be saved turns the result into a failure. */
async function journalOutcome(
  journal: Journal,
  entry: Omit<JournalEntry, 'seq'>,
  result: HookResult,
  log: Log,
): Promise<Attempt> {
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
  const result = (kind: HookKind | undefined, fields: Pick<HookResult, 'ok' | 'status'> & Partial<HookResult>): HookResult => ({
    index,
    name: hook?.name,
    kind,
    phase: opts.phase,
    description,
    ...(hook?.optional ? { optional: true } : {}),
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
  try {
    prepared = await prepareHook(hook, kind, { ctx, phase: opts.phase, log });
    description = withName(hook.name, prepared.description);
    const reason = hook.destructive === true ? 'declared destructive' : prepared.destructive;
    if (reason) await confirmDestructive(hook, reason, description, ctx, log);
    if (ctx.dryRun) {
      const saveAs = kind === 'http' ? (hook as { http: HttpHookSpec }).http.save_as : undefined;
      if (saveAs) addDrySaved(ctx, saveAs);
      log('info', `${label} [dry]: would run ${description}${reason ? ` (destructive: ${reason})` : ''}`);
      return { result: result(kind, { ok: true, status: 'dry', message: 'not executed (dry run)' }) };
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
  const extra = done.rollback && opts.phase === 'setup' ? { rollback: done.rollback } : {};
  return journalOutcome(opts.journal, entry('ok', extra), result(kind, { ok: true, status: 'ok', message }), log);
}

/**
 * Run hooks in order, logging each one (secrets redacted) and journaling every execution.
 * - setup: stops at the first failure that is not tolerated (`optional: true` tolerates failures, never
 *   refusals) and rolls back the hooks completed in this call, most recent first; refuses to start
 *   when a hook is malformed or a js hook has no page to run in.
 * - teardown / reset: every hook runs; failures are collected.
 * With `ctx.dryRun`, hooks are templated and security-checked but not executed, nor journaled.
 */
export async function runHooks(hooks: HookStep[], ctx: HookContext, opts: RunHooksOptions): Promise<RunHooksResult> {
  const log = logger(ctx);
  const results: HookResult[] = [];
  if (!hooks.length) return { ok: true, results };

  if (opts.phase === 'setup' && !ctx.dryRun) {
    const failures = preflight(hooks, ctx, opts.phase);
    if (failures.length) {
      for (const f of failures) log('error', `setup hook ${f.index + 1}/${hooks.length} cannot run: ${f.description}: ${f.error}`);
      log('error', 'setup not started: no hook was executed');
      return { ok: false, results: failures };
    }
  }

  const completed: number[] = [];
  let ok = true;
  for (let i = 0; i < hooks.length; i++) {
    const { result, entry } = await runOne(hooks[i], i, hooks.length, ctx, opts, log);
    results.push(result);
    if (entry?.rollback && entry.status === 'ok') completed.push(entry.seq);
    if (result.ok) continue;
    if (hooks[i]?.optional === true && result.status !== 'refused') {
      log('warn', `${opts.phase} hook ${i + 1}/${hooks.length} is optional: continuing`);
      continue;
    }
    ok = false;
    if (opts.phase !== 'setup') continue;
    const skipped = hooks.length - i - 1;
    if (skipped) log('warn', `setup stopped: ${skipped} remaining hook(s) not run`);
    if (completed.length) {
      log('info', `rolling back ${completed.length} completed setup hook(s)`);
      results.push(...(await opts.journal.rollbackEntries(completed, ctx)));
    }
    break;
  }
  return { ok, results };
}
