/**
 * The HookRunner port in memory, for tests: no shell, no request, no database, no file. Not exported from the package
 * (a test imports this file). It lives under src, not test, so that `implements HookRunner` is compiled: the port and
 * its second adapter cannot drift apart unseen.
 *
 * What it does of the port (the contract suite, engine/test/hook-runner-contract.ts, runs it beside the hooks package):
 * - `run`: one result per hook attempted, in order; each hook's outcome is scripted (`outcome`, by its place; default
 *   `ok`); a setup, seed or step list stops at its first failure unless the hook is `optional` (a refusal is never
 *   tolerated), and a setup that stops (a failure, or `ctx.signal`) rolls back what it completed in this call, most
 *   recent first, after its results; `ctx.signal` stops the remaining hooks of any list.
 * - approvals as the package words them: with trust `mcp` a shell hook needs a human ("a shell command (runs local
 *   code)") and so does a hook `needsHuman` names; with any trust a hook declared `destructive` without `confirm: true`
 *   ("declared destructive") — `confirm: true` does not count with trust `mcp`. A seed asks only about a shell step with
 *   trust `mcp`. Asked through `ctx.confirmDestructive` (not asked in a dry run with trust `mcp`): a no is `refused`.
 * - `ctx.dryRun`: nothing runs and nothing is journaled; each result is `dry`, described by the hook's own words
 *   (`describeHook`: not templated).
 * - an in-memory journal per file: every executed or refused hook is an entry; a setup or step hook that ran and
 *   declares a rollback is pending until `rollbackAll` replays it — once (a replayed entry is not pending any more).
 *   Every entry counts as signed.
 * - `ctx.recordRun` once per hook and per rollback run (never in a dry run), awaited, its failure ignored.
 * - fingerprints: core `canonicalJson({ v: 1, phase, index, env, hook, files })`, sha256 — the package's formula, but a
 *   test compares the fake with itself only (the real fingerprints are pinned by hook-fingerprints.test.ts).
 *
 * Every call is kept in `calls`; every hook and rollback it would have executed in `executed` (in order). Limits: no
 * templating (`{{…}}` stays as written), no secret, no allow-list, no read-only refusal, no file a hook references
 * (`files` gives what `approval.files` answers): a test of those belongs on the package's runner.
 */
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
import { canonicalJson, journalsRollback, projectPath, runPath, statePath } from '@retake/core';
import type { HookContext, HookKind, HookPhase, HookResult, HookStep, JournalEntry, RollbackAction } from '@retake/core';
import { describeHook, describeRollback, hookKindOf } from '@retake/hooks/describe';
import { EngineError } from '../errors.js';
import type { HookJournal, HookJournalRollback, HookPlace, HookRunOptions, HookRunner, PendingHookJournal } from './runner.js';

/** What a hook does when it runs (scripted). */
export interface MemoryHookOutcome {
  status: 'ok' | 'failed' | 'refused';
  message?: string;
  error?: string;
}

/** Where a hook stands in the list being run. */
export interface MemoryHookPlace {
  phase: HookPhase;
  index: number;
}

export type MemoryHookCall =
  | { op: 'run'; phase: HookPhase; hooks: readonly HookStep[]; agentWritten?: boolean; dry: boolean; journal: string }
  | { op: 'journals.open' | 'journals.standaloneFile' | 'journals.find' | 'journals.openPending' | 'journals.rollbackPending' | 'journals.pruneDone'; arg?: string }
  | { op: 'journals.rollback'; files: string[] }
  | { op: 'approval.fingerprint'; hook: HookStep; place: HookPlace }
  | { op: 'approval.files'; hook: HookStep; o: { projectDir: string; baseDir?: string; agentWritten?: boolean } };

/** A hook or rollback the fake would have executed. */
export interface MemoryExecution {
  phase: HookPhase | 'rollback';
  index: number;
  name?: string;
  /** The hook (absent for a rollback). */
  hook?: HookStep;
  /** The rollback replayed (absent for a hook). */
  rollback?: RollbackAction;
}

export interface MemoryHookRunnerOptions {
  /** The outcome of each hook that runs (undefined: `ok`). Called once per hook executed, never in a dry run. */
  outcome?: (hook: HookStep, place: MemoryHookPlace) => MemoryHookOutcome | undefined;
  /** With trust `mcp`: why a hook that is no shell one needs a human ("HTTP DELETE"); undefined: it does not. */
  needsHuman?: (hook: HookStep, place: MemoryHookPlace) => string | undefined;
  /** Called as a hook (or a rollback) runs, before its outcome: wait or abort a signal here. */
  onExecute?: (e: MemoryExecution) => void | Promise<void>;
  /** What `approval.files` answers for a hook (default none, no problem). */
  files?: (hook: HookStep) => { files: Record<string, string>; problems: string[] };
}

/** The file name of a capture's hooks journal in its run folder (the hooks package's JOURNAL_FILE). */
const RUN_JOURNAL_FILE = 'hooks-journal.json';
const SHELL_REASON = 'a shell command (runs local code)';

const isPending = (e: JournalEntry): boolean => e.status === 'ok' && e.rollback !== undefined && e.superseded === undefined && e.rolled_back_at === undefined;

/** The rollback a hook declares, as a journal keeps it (its description: the hooks package's describeRollback). */
function rollbackOf(hook: HookStep, kind: HookKind): RollbackAction | undefined {
  const spec = (hook as unknown as Record<string, unknown>)[kind];
  const rb = spec && typeof spec === 'object' ? (spec as { rollback?: unknown }).rollback : undefined;
  if (rb === undefined) return undefined;
  const description = describeRollback(hook) ?? `${kind} rollback`;
  if (kind === 'http') return { kind, description, data: {}, request: rb as Extract<RollbackAction, { kind: 'http' }>['request'] };
  if (kind === 'sql') return { kind, description, data: {}, db: String((spec as { db?: unknown }).db ?? ''), query: String(rb) };
  if (kind === 'js') return { kind, description, data: {}, code: String(rb) };
  return { kind: 'shell', description, data: {}, run: String(rb) };
}

/** A hooks journal in memory (one per file, shared by every `open` of it in one runner). */
export class MemoryHookJournal implements HookJournal {
  readonly entries: JournalEntry[] = [];

  constructor(
    readonly file: string,
    readonly runner: MemoryHookRunner,
  ) {}

  pending(): JournalEntry[] {
    return this.entries.filter(isPending);
  }

  isSigned(_entry: JournalEntry): boolean {
    return true;
  }

  add(entry: Omit<JournalEntry, 'seq'>): JournalEntry {
    const stored = { ...entry, seq: this.entries.length + 1 };
    this.entries.push(stored);
    return stored;
  }

  rollbackAll(ctx: HookContext): Promise<HookResult[]> {
    return this.rollbackEntries(
      this.pending().map((e) => e.seq),
      ctx,
    );
  }

  /** Replay the given pending entries, most recent first; each one once. A dry run only describes them. */
  async rollbackEntries(seqs: readonly number[], ctx: HookContext): Promise<HookResult[]> {
    const wanted = new Set(seqs);
    const entries = this.entries.filter((e) => wanted.has(e.seq) && isPending(e)).sort((a, b) => b.seq - a.seq);
    const results: HookResult[] = [];
    for (const entry of entries) {
      const action = entry.rollback!;
      const base = { index: entry.seq, ...(entry.name !== undefined ? { name: entry.name } : {}), kind: action.kind, phase: 'rollback' as const, description: action.description, journal_seq: entry.seq, ms: 0 };
      if (ctx.dryRun) {
        results.push({ ...base, ok: true, status: 'dry', message: 'not executed (dry run)' });
        continue;
      }
      await this.runner.executing({ phase: 'rollback', index: entry.seq, ...(entry.name !== undefined ? { name: entry.name } : {}), rollback: action });
      entry.rolled_back_at = new Date(0).toISOString();
      const result: HookResult = { ...base, ok: true, status: 'ok', message: 'rolled back' };
      await record(ctx, result, this.file);
      results.push(result);
    }
    return results;
  }
}

/** HookContext.recordRun as the package calls it: never for a dry run, awaited, its failure ignored. */
async function record(ctx: HookContext, result: HookResult, journalFile?: string): Promise<void> {
  if (!ctx.recordRun || ctx.dryRun || result.status === 'dry') return;
  try {
    await (journalFile !== undefined ? ctx.recordRun(result, journalIdOf(journalFile)) : ctx.recordRun(result));
  } catch {
    // best effort, as the package's
  }
}

const journalIdOf = (file: string): string => {
  const parts = file.split(/[\\/]/);
  const base = parts.at(-1) ?? file;
  return base === RUN_JOURNAL_FILE ? (parts.at(-2) ?? base) : base.replace(/\.json$/i, '');
};

export class MemoryHookRunner implements HookRunner {
  readonly calls: MemoryHookCall[] = [];
  readonly executed: MemoryExecution[] = [];
  /** The journals by file. */
  readonly journalFiles = new Map<string, MemoryHookJournal>();
  readonly #o: MemoryHookRunnerOptions;

  constructor(o: MemoryHookRunnerOptions = {}) {
    this.#o = o;
  }

  /** @internal Record (and announce) an execution. */
  async executing(e: MemoryExecution): Promise<void> {
    this.executed.push(e);
    await this.#o.onExecute?.(e);
  }

  #own(journal: HookJournal): MemoryHookJournal {
    if (journal instanceof MemoryHookJournal && journal.runner === this) return journal;
    throw new EngineError('internal', 'a hooks journal opened by another hook runner was handed to the memory runner');
  }

  #journal(file: string): MemoryHookJournal {
    let j = this.journalFiles.get(file);
    if (!j) {
      j = new MemoryHookJournal(file, this);
      this.journalFiles.set(file, j);
    }
    return j;
  }

  #reason(hook: HookStep, kind: HookKind, place: MemoryHookPlace, ctx: HookContext): string | null {
    const mcp = ctx.trust === 'mcp';
    const declared = hook.destructive === true && (mcp || hook.confirm !== true) ? 'declared destructive' : null;
    const own = mcp ? (declared ?? this.#o.needsHuman?.(hook, place) ?? (kind === 'shell' ? SHELL_REASON : null)) : declared;
    if (!own) return null;
    return place.phase !== 'seed' || (mcp && kind === 'shell') ? own : null;
  }

  async run(hooks: readonly HookStep[], ctx: HookContext, o: HookRunOptions): Promise<{ ok: boolean; results: HookResult[] }> {
    const journal = this.#own(o.journal);
    this.calls.push({ op: 'run', phase: o.phase, hooks, ...(o.agentWritten !== undefined ? { agentWritten: o.agentWritten } : {}), dry: ctx.dryRun === true, journal: journal.file });
    const results: HookResult[] = [];
    const completed: number[] = [];
    const stops = o.phase === 'setup' || o.phase === 'seed' || o.phase === 'step';
    let ok = true;
    const rollBack = async () => {
      if (o.phase !== 'setup' || !completed.length) return;
      const signal = ctx.signal;
      ctx.signal = undefined;
      try {
        results.push(...(await journal.rollbackEntries(completed, ctx)));
      } finally {
        ctx.signal = signal;
      }
    };
    for (const [index, hook] of hooks.entries()) {
      if (ctx.signal?.aborted) {
        ok = false;
        await rollBack();
        break;
      }
      const { result, entry } = await this.#one(hook, { phase: o.phase, index }, ctx, journal);
      await record(ctx, result);
      results.push(result);
      if (entry?.rollback && entry.status === 'ok') completed.push(entry.seq);
      if (result.ok) continue;
      if (hook.optional === true && result.status !== 'refused') continue;
      ok = false;
      if (!stops) continue;
      await rollBack();
      break;
    }
    if (ok && o.phase === 'setup' && ctx.signal?.aborted) {
      ok = false;
      await rollBack();
    }
    return { ok, results };
  }

  async #one(hook: HookStep, place: MemoryHookPlace, ctx: HookContext, journal: MemoryHookJournal): Promise<{ result: HookResult; entry?: JournalEntry }> {
    const description = describeHook(hook);
    const base = { index: place.index, ...(hook.name !== undefined ? { name: hook.name } : {}), phase: place.phase, description, ...(hook.optional ? { optional: true } : {}), ms: 0 };
    let kind: HookKind;
    try {
      kind = hookKindOf(hook);
    } catch (e) {
      return { result: { ...base, ok: false, status: 'failed', error: e instanceof Error ? e.message : String(e) } };
    }
    const reason = this.#reason(hook, kind, place, ctx);
    const mcp = ctx.trust === 'mcp';
    let approval: HookResult['approval'];
    if (reason) {
      const { files } = await this.approval.files(hook, { projectDir: ctx.project.dir });
      const fingerprint = await this.approval.fingerprint(hook, { phase: place.phase, index: place.index, env: ctx.env.name, files });
      if (mcp) approval = { reason, fingerprint };
      if (!(ctx.dryRun && mcp)) {
        const request = { hook, phase: place.phase, index: place.index, env: ctx.env.name, ...(Object.keys(files).length ? { files } : {}), fingerprint };
        const yes = ctx.confirmDestructive ? await ctx.confirmDestructive(description, reason, request) : false;
        if (!yes) {
          const result: HookResult = { ...base, kind, ...(approval ? { approval } : {}), ok: false, status: 'refused', error: `refusing hook (${reason}) without a human approval` };
          return ctx.dryRun ? { result } : this.#journaled(journal, hook, kind, place, ctx, 'failed', result);
        }
      }
    }
    if (ctx.dryRun) return { result: { ...base, kind, ...(approval ? { approval } : {}), ok: true, status: 'dry', message: 'not executed (dry run)' } };
    await this.executing({ phase: place.phase, index: place.index, ...(hook.name !== undefined ? { name: hook.name } : {}), hook });
    const out = this.#o.outcome?.(hook, place) ?? { status: 'ok' as const };
    const result: HookResult = {
      ...base,
      kind,
      ...(approval ? { approval } : {}),
      ok: out.status === 'ok',
      status: out.status,
      ...(out.message !== undefined ? { message: out.message } : out.status === 'ok' ? { message: 'ok' } : {}),
      ...(out.status !== 'ok' ? { error: out.error ?? out.status } : {}),
    };
    return this.#journaled(journal, hook, kind, place, ctx, out.status === 'ok' ? 'ok' : 'failed', result);
  }

  #journaled(journal: MemoryHookJournal, hook: HookStep, kind: HookKind, place: MemoryHookPlace, ctx: HookContext, status: 'ok' | 'failed', result: HookResult): { result: HookResult; entry: JournalEntry } {
    const at = new Date(0).toISOString();
    const rollback = status === 'ok' && journalsRollback(place.phase) ? rollbackOf(hook, kind) : undefined;
    const entry = journal.add({
      ...(hook.name !== undefined ? { name: hook.name } : {}),
      kind,
      phase: place.phase,
      description: result.description,
      env: ctx.env.name,
      ...(ctx.runId !== undefined ? { run_id: ctx.runId } : {}),
      started_at: at,
      finished_at: at,
      status,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(rollback ? { rollback } : {}),
    });
    return { result: { ...result, journal_seq: entry.seq }, entry };
  }

  readonly journals = {
    open: async (file: string): Promise<HookJournal> => {
      this.calls.push({ op: 'journals.open', arg: file });
      return this.#journal(file);
    },
    standaloneFile: async (projectDir: string, id: string): Promise<string> => {
      this.calls.push({ op: 'journals.standaloneFile', arg: id });
      return join(statePath(projectDir, 'journals'), `${id}.json`);
    },
    find: async (projectDir: string, id: string): Promise<{ file: string | null; looked: [run: string, standalone: string] }> => {
      this.calls.push({ op: 'journals.find', arg: id });
      const looked: [string, string] = [runPath(projectDir, id, RUN_JOURNAL_FILE), join(statePath(projectDir, 'journals'), `${id}.json`)];
      // A journal exists once it holds an entry (the package's is written on its first entry).
      return { file: looked.find((f) => (this.journalFiles.get(f)?.entries.length ?? 0) > 0) ?? null, looked };
    },
    openPending: async (projectDir: string): Promise<PendingHookJournal[]> => {
      this.calls.push({ op: 'journals.openPending', arg: projectDir });
      return this.#pending(projectDir);
    },
    rollback: async (list: readonly PendingHookJournal[], ctx: HookContext): Promise<HookJournalRollback[]> => {
      this.calls.push({ op: 'journals.rollback', files: list.map((p) => p.file) });
      return this.#rollback(list, ctx);
    },
    rollbackPending: async (projectDir: string, ctx: HookContext): Promise<HookJournalRollback[]> => {
      this.calls.push({ op: 'journals.rollbackPending', arg: projectDir });
      return this.#rollback(this.#pending(projectDir), ctx);
    },
    pruneDone: async (): Promise<void> => {
      this.calls.push({ op: 'journals.pruneDone' });
    },
  };

  /** The journals of a project with pending rollbacks, most recent first (journal ids are timestamps). */
  #pending(projectDir: string): PendingHookJournal[] {
    const inside = [projectPath(projectDir, 'runs'), statePath(projectDir, 'journals')].map((d) => `${d}${sep}`);
    return [...this.journalFiles.values()]
      .filter((j) => inside.some((d) => j.file.startsWith(d)) && j.pending().length > 0)
      .sort((a, b) => journalIdOf(b.file).localeCompare(journalIdOf(a.file)))
      .map((journal) => ({ file: journal.file, journal }));
  }

  async #rollback(list: readonly PendingHookJournal[], ctx: HookContext): Promise<HookJournalRollback[]> {
    const out: HookJournalRollback[] = [];
    for (const p of list) {
      if (!p.journal) {
        out.push({ file: p.file, results: [], error: p.error ?? 'not opened' });
        continue;
      }
      out.push({ file: p.file, results: await this.#own(p.journal).rollbackAll(ctx) });
    }
    return out;
  }

  readonly approval = {
    fingerprint: async (hook: HookStep, place: HookPlace): Promise<string> => {
      this.calls.push({ op: 'approval.fingerprint', hook, place });
      const files = place.files && Object.keys(place.files).length ? place.files : undefined;
      return createHash('sha256')
        .update(canonicalJson({ v: 1, phase: place.phase, index: place.index, env: place.env, hook, ...(files ? { files } : {}) }))
        .digest('hex');
    },
    files: async (hook: HookStep, o: { projectDir: string; baseDir?: string; agentWritten?: boolean }): Promise<{ files: Record<string, string>; problems: string[] }> => {
      this.calls.push({ op: 'approval.files', hook, o });
      return this.#o.files?.(hook) ?? { files: {}, problems: [] };
    },
  };
}
