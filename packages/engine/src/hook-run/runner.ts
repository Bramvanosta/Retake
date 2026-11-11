/**
 * The HookRunner port (L7.11, U6): how the engine runs hooks outside a capture — the hooks of `retake hooks run`, of a
 * `hooks` or `env_reset` job, a sandbox's approvals, the dry-run preflight of work submitted through MCP or the Studio —
 * and replays the rollbacks their journals hold. Its vocabulary is core's (hook-run.ts); it names no adapter, types
 * included (the import-rules ratchet's `port-types`). Adapters: the hooks package (`packageHookRunner`,
 * package-hooks.ts) and an in-memory one for tests (`MemoryHookRunner`, memory-hooks.ts).
 *
 * What a run does — templates, secrets, trust `mcp`, approvals, the allow-list, read-only access, journaling, signing —
 * is the adapter's. An approval's fingerprint is too: it hashes the project files a hook references, so it is never
 * re-derived on this side (signed approvals are bound to it).
 */
import type { HookContext, HookPhase, HookResult, HookStep, JournalEntry as HookJournalEntry } from '@retake/core';

/** A hooks journal, opened: its pending rollbacks, which entries Retake signed, and their replay. */
export interface HookJournal {
  /** The entries whose rollback has not run yet (nor been superseded). */
  pending(): HookJournalEntry[];
  /** Whether Retake recorded this entry in this journal with this home (its signature holds). */
  isSigned(entry: HookJournalEntry): boolean;
  /** Replay every pending rollback, most recent first. */
  rollbackAll(ctx: HookContext): Promise<HookResult[]>;
}

/** A journal with pending rollbacks, opened (or why it could not be). */
export interface PendingHookJournal {
  file: string;
  journal?: HookJournal;
  error?: string;
}

/** What replaying one journal gave. */
export interface HookJournalRollback {
  file: string;
  results: HookResult[];
  /** The journal could not be opened or replayed. */
  error?: string;
}

/** Where a hook stands when its approval is asked for and checked (the fingerprint's input besides the hook). */
export interface HookPlace {
  phase: HookPhase;
  /** Position in its list (0-based). */
  index: number;
  /** The environment it runs on. */
  env: string;
  /** The project files it references, project-relative ref → sha256 (`approval.files`). */
  files?: Record<string, string>;
}

export interface HookRunOptions {
  phase: HookPhase;
  /** Where executed hooks and their rollbacks are journaled (a dry run writes nothing). */
  journal: HookJournal;
  /** Trust `mcp`: the hooks were written by the agent (a scenario's own). */
  agentWritten?: boolean;
}

export interface HookRunner {
  /** Run one list of hooks in `ctx`: one result per hook attempted, then (a setup that failed) one per rollback. */
  run(hooks: readonly HookStep[], ctx: HookContext, o: HookRunOptions): Promise<{ ok: boolean; results: HookResult[] }>;
  readonly journals: {
    open(file: string): Promise<HookJournal>;
    /** The journal file of a standalone hooks run (`.retake/journals/<id>.json`). */
    standaloneFile(projectDir: string, id: string): Promise<string>;
    /** The journal of `id` (a run's, else a standalone one), null when neither exists, and the two places looked at. */
    find(projectDir: string, id: string): Promise<{ file: string | null; looked: [run: string, standalone: string] }>;
    /** Every journal of a project with pending rollbacks, opened once, most recent run first. */
    openPending(projectDir: string): Promise<PendingHookJournal[]>;
    /** Replay exactly the journals `openPending` listed. */
    rollback(list: readonly PendingHookJournal[], ctx: HookContext): Promise<HookJournalRollback[]>;
    /** `openPending`, then `rollback`. */
    rollbackPending(projectDir: string, ctx: HookContext): Promise<HookJournalRollback[]>;
    /** Forget the records of rollbacks replayed long ago (a worker's start). */
    pruneDone(): Promise<void>;
  };
  readonly approval: {
    /** The fingerprint a human approval of `hook` at `place` is bound to. */
    fingerprint(hook: HookStep, place: HookPlace): Promise<string>;
    /** The project files `hook` references (their sha256: part of its fingerprint) and those it may not use. */
    files(hook: HookStep, o: { projectDir: string; baseDir?: string; agentWritten?: boolean }): Promise<{ files: Record<string, string>; problems: string[] }>;
  };
}
