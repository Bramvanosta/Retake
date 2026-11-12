/**
 * The hooks use cases outside a capture, orchestrated once (L7.23, U8b) for the two shells that run them: `retake hooks
 * run`, `retake hooks rollback` and `retake env reset` (the CLI, trust `author`, a person at a terminal) and the `hooks`
 * and `env_reset` jobs (the worker, trust `mcp`, the approvals taken at submit). Each work selects, builds the hook
 * context (hooks.ts createHookContext), opens the journal and runs or replays through the HookRunner port; the caller
 * says who it is and how a human answers:
 *
 * - `trust` (`author` / ENGINE_TRUST) and `confirm` (the terminal's prompt / the job's approvalChecker);
 * - `replayUnsigned` (a person's yes in a terminal; createHookContext drops it under trust `mcp`);
 * - `protection` — the jobs' checks only: hooks from project files only, the scenario bytes that were approved
 *   (`expectSha256`) and the caller's own checks (agent trust, workspace protection). The CLI passes none and gains none;
 * - `onInterrupt` (the CLI's Ctrl-C: it closes the sessions and exits 130) or `signal` (a job's cancel);
 * - callbacks, called while the hooks' sessions are open, in the order the work happens, so that a shell that prints
 *   (the CLI) prints what it did before its browsers close: `onStart`, `listed` (what a replay is about to run, before
 *   it runs), `onRollbacks`, `onReset`, `onResults`. The jobs pass none and map the outcome returned.
 */
import type { HookStep, LoadedProject, ResolvedEnvironment } from '@retake/core/model';
import type { RunAccess } from '@retake/core/environment';
import type { WorkPolicy } from '@retake/core/policy';
import type { HookContext, HookResult, HookTrust } from '@retake/core/hooks';
import { fileFacts } from '@retake/core/io';
import type { LoginCommandOf } from './auth.js';
import type { ENGINE_TRUST } from './caller.js';
import { EngineError } from './errors.js';
import type { HookPages } from './capture/runner.js';
import type { HookJournalRollback, HookRunner, PendingHookJournal } from './hook-run/runner.js';
import { createHookContext, selectHooks } from './hooks.js';
import type { HookSelection } from './hooks.js';
import type { JournalAs } from './store/journal.js';

/** A shell's watch on Ctrl-C while hooks hold browsers (the CLI's interrupt.ts onInterrupt with `exit`). */
export interface HookInterrupt {
  readonly interrupted: boolean;
  dispose(): void;
}

/** Who runs the hooks and how a human answers (see the module comment). */
export interface HookWorkOptions {
  /** What the work runs under (core WorkPolicy): the hooks' shell environment and js-hook browser. */
  policy: WorkPolicy;
  /** What runs the hooks and replays journals (the HookRunner port). */
  hooks: HookRunner;
  /** The js hooks' browsers (the capture runner's hook pages). */
  pages: HookPages;
  env?: string;
  /** Let hooks write to a production environment whose project.yaml sets `access: read-write` (the CLI's `--allow-writes`). */
  allowWrites?: boolean;
  /** Describe and security-check without executing. */
  dry: boolean;
  /** `author` (the CLI) or ENGINE_TRUST (every job). */
  trust: HookTrust;
  /** Approves a hook that needs a human (the CLI: --yes or the prompt; a job: its approvals). */
  confirm?: HookContext['confirmDestructive'];
  /** The CLI's question about an unsigned rollback (`--replay-unsigned`), or false. */
  replayUnsigned?: HookContext['replayUnsigned'];
  log: HookContext['log'];
  loginCommand: LoginCommandOf;
  /** Each hook and rollback run is a line of the workspace journal, as this caller's. */
  recordAs: JournalAs;
  /** A job's cancel. */
  signal?: AbortSignal;
  /** Installed once the context exists, with what closes its sessions; disposed after they are closed. */
  onInterrupt?: (closeSessions: () => Promise<void>) => Promise<HookInterrupt>;
  /** What a failure to build the context throws instead (the CLI: an access error is a usage error). */
  contextError?: (e: unknown) => unknown;
}

/**
 * Who may leave the jobs' protection out: a person's own command (trust `author`). Work held to ENGINE_TRUST (every
 * job) must say what protects it — by type, and checked at run time for a caller that casts its way past the type.
 */
export type Protected<P> = { trust: 'author'; protection?: undefined } | { trust: typeof ENGINE_TRUST; protection: P };

/** A trust-`mcp` work without the jobs' protection is a bug of its caller: refused before anything is read. */
function requireProtection(o: { trust: HookTrust; protection?: unknown }, work: string): void {
  if (o.trust === 'mcp' && !o.protection) throw new EngineError('internal', `${work} with trust mcp needs the jobs' protection (project files only, the approved bytes, their checks)`);
}

/** The context's sessions, opened for `body` and closed after it (the interrupt watch disposed after them). */
async function inHookContext<T>(
  project: LoadedProject,
  o: HookWorkOptions,
  extra: { runId?: string; vars?: Record<string, string>; scenario?: HookSelection['scenario'] },
  body: (ctx: HookContext, access: RunAccess, interrupted: () => boolean) => Promise<T>,
): Promise<T> {
  let made: Awaited<ReturnType<typeof createHookContext>>;
  try {
    made = await createHookContext(project, {
      policy: o.policy,
      ...(o.env !== undefined ? { env: o.env } : {}),
      allowWrites: o.allowWrites === true,
      dry: o.dry,
      ...(extra.vars ? { vars: extra.vars } : {}),
      ...(extra.runId !== undefined ? { runId: extra.runId } : {}),
      ...(extra.scenario ? { scenario: extra.scenario } : {}),
      trust: o.trust,
      ...(o.confirm ? { confirm: o.confirm } : {}),
      ...(o.replayUnsigned !== undefined ? { replayUnsigned: o.replayUnsigned } : {}),
      log: o.log,
      loginCommand: o.loginCommand,
      ...(o.signal ? { signal: o.signal } : {}),
      recordAs: o.recordAs,
      pages: o.pages,
    });
  } catch (e) {
    throw o.contextError ? o.contextError(e) : e;
  }
  const { ctx, access, closeSessions } = made;
  const stop = o.onInterrupt ? await o.onInterrupt(closeSessions) : undefined;
  const interrupted = () => stop?.interrupted === true || o.signal?.aborted === true;
  try {
    return await body(ctx, access, interrupted);
  } finally {
    await closeSessions();
    stop?.dispose();
  }
}

/** The jobs' checks of a hooks source (never the CLI's). */
export interface HooksRunProtection {
  /** The sha256 of the scenario bytes submitted and approved (a scenario's hooks): other bytes are refused. */
  expectSha256?: string;
  /** Checked on the selection, before anything opens (agent trust, workspace protection). */
  check(sel: HookSelection): Promise<void>;
}

export interface HooksRunOutcome {
  sel: HookSelection;
  env: ResolvedEnvironment;
  access: RunAccess;
  runId: string;
  journalFile: string;
  ok: boolean;
  results: HookResult[];
  /** Pending rollbacks in the journal after the run. */
  pending: number;
  interrupted: boolean;
}

interface HooksRunWorkBase extends Omit<HookWorkOptions, 'trust'> {
  /** The journal's id: given (a job's), or made from the selection (the CLI's `hooks-<label>`). */
  runId: string | ((sel: HookSelection) => string);
  /** What a failed selection throws instead. */
  selectError?: (e: unknown) => unknown;
  /**
   * After the selection, before anything opens: a person's command asks here about what it is about to run (the CLI's
   * shell hooks of a scenario an agent wrote, L7.27, rendered with the run's id); what it throws ends the work.
   */
  onSelected?: (sel: HookSelection, s: { runId: string }) => Promise<void>;
  onStart?: (s: { sel: HookSelection; ctx: HookContext; access: RunAccess; runId: string; journalFile: string }) => void;
  onResults?: (out: HooksRunOutcome) => void;
}

/** `protection`: the jobs' checks — required with ENGINE_TRUST, absent for the CLI. */
export type HooksRunWorkOptions = HooksRunWorkBase & Protected<HooksRunProtection>;

/** Run a hooks source (`reset`, `<scenario>:setup|teardown`, `hooks/<name>.yaml`): select → context → journal → run. */
export async function hooksRunWork(project: LoadedProject, source: string, o: HooksRunWorkOptions): Promise<HooksRunOutcome> {
  requireProtection(o, 'hooksRunWork');
  const p = o.protection;
  const sel = await selectHooks(project, source, o.env, {
    ...(p ? { projectFilesOnly: true, ...(p.expectSha256 !== undefined ? { expectSha256: p.expectSha256 } : {}) } : {}),
    files: fileFacts(o.policy),
  }).catch((e: unknown) => {
    throw o.selectError ? o.selectError(e) : e;
  });
  if (p) await p.check(sel);
  const runId = typeof o.runId === 'function' ? o.runId(sel) : o.runId;
  await o.onSelected?.(sel, { runId });
  const journalFile = await o.hooks.journals.standaloneFile(project.dir, runId);
  const env = o.env ?? sel.env;
  return inHookContext(project, { ...o, ...(env !== undefined ? { env } : {}) }, { runId, ...(sel.vars ? { vars: sel.vars } : {}), ...(sel.scenario ? { scenario: sel.scenario } : {}) }, async (ctx, access, interrupted) => {
    o.onStart?.({ sel, ctx, access, runId, journalFile });
    const journal = await o.hooks.journals.open(journalFile);
    // Trust `mcp`: a scenario's hooks are the agent's (the adapter reads this under that trust only).
    const res = await o.hooks.run(sel.hooks, ctx, { phase: sel.phase, journal, ...(o.trust === 'mcp' ? { agentWritten: sel.scenario !== undefined } : {}) });
    const out: HooksRunOutcome = { sel, env: ctx.env, access, runId, journalFile, ok: res.ok, results: res.results, pending: journal.pending().length, interrupted: interrupted() };
    o.onResults?.(out);
    return out;
  });
}

/** Open every pending journal, say what will run (`listed`), and replay exactly that (nothing when none is pending). */
async function replayPending(project: LoadedProject, o: HookWorkOptions, ctx: HookContext, listed?: (list: readonly PendingHookJournal[], ctx: HookContext) => void): Promise<HookJournalRollback[]> {
  const list = await o.hooks.journals.openPending(project.dir);
  listed?.(list, ctx);
  return list.length ? o.hooks.journals.rollback(list, ctx) : [];
}

const rollbacksOk = (outcomes: readonly HookJournalRollback[]): boolean => outcomes.every((x) => !x.error && x.results.every((r) => r.ok));

export type RollbackOutcome =
  | { kind: 'missing'; id: string; looked: [run: string, standalone: string] }
  /** One journal: `results` empty when nothing was pending. */
  | { kind: 'run'; id: string; file: string; pending: number; results: HookResult[]; ok: boolean; interrupted: boolean }
  | { kind: 'pending'; outcomes: HookJournalRollback[]; ok: boolean; interrupted: boolean };

export interface RollbackWorkOptions extends HookWorkOptions {
  /** One run's or hooks run's journal; absent: every pending one. */
  id?: string;
  onStart?: (s: { ctx: HookContext; access: RunAccess }) => void;
  /** Before the replay: the journals it will replay (one: `[]` when nothing is pending in it). */
  listed?: (list: readonly PendingHookJournal[], ctx: HookContext) => void;
  onResults?: (out: RollbackOutcome) => void;
}

/** Replay pending rollbacks: one journal (a run's, else a standalone one), or every pending journal of the project. */
export async function rollbackWork(project: LoadedProject, o: RollbackWorkOptions): Promise<RollbackOutcome> {
  return inHookContext(project, o, {}, async (ctx, access, interrupted) => {
    o.onStart?.({ ctx, access });
    let out: RollbackOutcome;
    if (o.id !== undefined) {
      const { file, looked } = await o.hooks.journals.find(project.dir, o.id);
      if (!file) return { kind: 'missing', id: o.id, looked };
      const journal = await o.hooks.journals.open(file);
      const pending = journal.pending().length;
      o.listed?.(pending ? [{ file, journal }] : [], ctx);
      const results = pending ? await journal.rollbackAll(ctx) : [];
      out = { kind: 'run', id: o.id, file, pending, results, ok: results.every((r) => r.ok), interrupted: interrupted() };
    } else {
      const outcomes = await replayPending(project, o, ctx, o.listed);
      out = { kind: 'pending', outcomes, ok: rollbacksOk(outcomes), interrupted: interrupted() };
    }
    o.onResults?.(out);
    return out;
  });
}

export interface EnvResetOutcome {
  env: ResolvedEnvironment;
  rollbacks: HookJournalRollback[];
  /** The project's reset hooks run (null: none declared, or a cancel came first). */
  reset: { hooks: readonly HookStep[]; ok: boolean; results: HookResult[] } | null;
  ok: boolean;
  interrupted: boolean;
}

interface EnvResetWorkBase extends Omit<HookWorkOptions, 'trust'> {
  /** The reset hooks' journal id. */
  runId: string;
  onStart?: (s: { ctx: HookContext; access: RunAccess }) => void;
  listed?: (list: readonly PendingHookJournal[], ctx: HookContext) => void;
  onRollbacks?: (outcomes: readonly HookJournalRollback[]) => void;
  /** Before the reset hooks run (an empty list: the project declares none). Not called after a cancel. */
  onReset?: (hooks: readonly HookStep[]) => void;
  onResults?: (out: EnvResetOutcome) => void;
}

/** `protection`: the jobs' checks, before anything opens (workspace protection) — required with ENGINE_TRUST, absent for the CLI. */
export type EnvResetWorkOptions = EnvResetWorkBase & Protected<{ check(): Promise<void> }>;

/** `env reset`: replay every pending rollback journal, then the project's `reset` hooks (journaled under `runId`). */
export async function envResetWork(project: LoadedProject, o: EnvResetWorkOptions): Promise<EnvResetOutcome> {
  requireProtection(o, 'envResetWork');
  if (o.protection) await o.protection.check();
  return inHookContext(project, o, { runId: o.runId }, async (ctx, access, interrupted) => {
    o.onStart?.({ ctx, access });
    const rollbacks = await replayPending(project, o, ctx, o.listed);
    o.onRollbacks?.(rollbacks);
    let ok = rollbacksOk(rollbacks);
    const hooks = project.config.reset ?? [];
    let reset: EnvResetOutcome['reset'] = null;
    if (!o.signal?.aborted) {
      o.onReset?.(hooks);
      if (hooks.length) {
        const journal = await o.hooks.journals.open(await o.hooks.journals.standaloneFile(project.dir, o.runId));
        const res = await o.hooks.run(hooks, ctx, { phase: 'reset', journal });
        reset = { hooks, ok: res.ok, results: res.results };
        ok &&= res.ok;
      }
    }
    const out: EnvResetOutcome = { env: ctx.env, rollbacks, reset, ok, interrupted: interrupted() };
    o.onResults?.(out);
    return out;
  });
}
