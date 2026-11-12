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
import type { HookStep } from '@retake/core/model';
import type { CaptureHookRunner, HookContext, HookJournal, HookPhase, HookResult, HookRunOptions } from '@retake/core/hooks';

// L7.25: a journal's handle, a run's options and the capture's part of the port are core's (hook-run.ts), shared with
// runner-web's RunOptions.hookRunner; re-exported here for the engine's modules.
export type { HookJournal, HookRunOptions } from '@retake/core/hooks';

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

/** The port: the capture's part (core CaptureHookRunner, what runner-web's run takes) and the rest the engine uses. */
export interface HookRunner extends CaptureHookRunner {
  /**
   * Load what runs the hooks (the package adapter: the hooks package), so that a caller that must tell a load failure
   * from a hook's — the capture's hooks (runner-web's run, L7.12) — can; resolves at once once loaded. Every other member
   * loads on its own call too.
   */
  load(): Promise<void>;
  /** Run one list of hooks in `ctx`: one result per hook attempted, then (a setup that failed) one per rollback. */
  run(hooks: readonly HookStep[], ctx: HookContext, o: HookRunOptions): Promise<{ ok: boolean; results: HookResult[] }>;
  readonly journals: CaptureHookRunner['journals'] & {
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
