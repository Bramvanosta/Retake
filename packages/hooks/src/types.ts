import type { HookKind, HttpHookSpec, LoadedProject, ResolvedEnvironment } from '@demo-studio/core';

/** Which list of hooks is being run. Only `setup` hooks journal a rollback action. */
export type HookPhase = 'setup' | 'teardown' | 'reset';

export type HookLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface HookContext {
  project: LoadedProject;
  /** Selected environment: its pages are the `{{page}}` template keys. */
  env: ResolvedEnvironment;
  /** `{{vars.x}}` / `{{x}}` (merged over project.config.vars). */
  vars: Record<string, unknown>;
  /** `{{run.id}}`; also stored in journal entries. */
  runId?: string;
  /** Describe (and security-check) what would run, without executing anything. */
  dryRun?: boolean;
  /** Every message is redacted of the secret values resolved so far for this context. */
  log: (level: HookLogLevel, msg: string) => void;
  /** Provided by the runner: evaluates a function body in the page of an environment page key. */
  evalInPage?: (pageKey: string | undefined, code: string) => Promise<unknown>;
  /** `save_as` results, exposed to templating as `{{hooks.<name>.status|headers|body|json…}}`. Mutated in place. */
  saved: Record<string, unknown>;
  /**
   * Approves a destructive hook that lacks `confirm: true` (CLI `--yes`, interactive prompt).
   * Without it, such hooks are refused.
   */
  confirmDestructive?: (description: string, reason: string) => boolean | Promise<boolean>;
}

/** What `save_as` stores in `ctx.saved[name]`, and `{{response…}}` in an http rollback. */
export interface SavedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Parsed body when it is JSON. */
  json?: unknown;
}

/**
 * ok: executed. failed: execution or preparation error. refused: allow-list / destructive refusal
 * (never tolerated by `optional`). dry: described only (`ctx.dryRun`).
 */
export type HookResultStatus = 'ok' | 'failed' | 'refused' | 'dry';

export interface HookResult {
  /** Position in the hook list (for rollbacks: the journal entry seq). */
  index: number;
  name?: string;
  /** Absent when the hook entry is malformed. */
  kind?: HookKind;
  phase: HookPhase | 'rollback';
  /** Runtime description (templated, secrets redacted). */
  description: string;
  ok: boolean;
  status: HookResultStatus;
  /** The hook was `optional: true` (its failure did not stop the phase). */
  optional?: boolean;
  /** Short outcome: "201 Created", "2 statements, 3 rows", "exit 0"… */
  message?: string;
  error?: string;
  ms: number;
  /** Journal entry written for this execution. */
  journal_seq?: number;
}

/** HTTP request part of a hook (also the shape of an http rollback). */
export type HttpRequestSpec = Omit<HttpHookSpec, 'rollback' | 'save_as'>;

/**
 * Non-secret template data a rollback needs, captured when the hook ran: only the paths its
 * template references (`{{response.json.id}}`, `{{console}}`, `{{vars.x}}`…). Secret references
 * (`{{env:X}}`, `{{keychain:a/b}}`) stay in template form and are resolved again at rollback time.
 */
export interface TemplateSnapshot {
  pages?: Record<string, string>;
  vars?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  run?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

interface RollbackBase {
  /** Templated, redacted description (for logs and listings). */
  description: string;
  data: TemplateSnapshot;
}

/** Template form of the action that undoes a hook (interpolated with `data` + fresh secrets at rollback time). */
export type RollbackAction =
  | (RollbackBase & { kind: 'http'; request: HttpRequestSpec })
  | (RollbackBase & { kind: 'sql'; db: string; file?: string; query: string })
  | (RollbackBase & { kind: 'shell'; run: string; cwd?: string; env?: Record<string, string>; timeout?: number })
  | (RollbackBase & { kind: 'js'; code: string; page?: string });

/** ok: executed (its rollback, if any, is pending). failed: did not complete. rolled_back: undone. */
export type JournalEntryStatus = 'ok' | 'failed' | 'rolled_back';

export interface JournalEntry {
  /** 1-based, increasing within a journal file. */
  seq: number;
  name?: string;
  kind: HookKind;
  phase: HookPhase;
  description: string;
  env?: string;
  run_id?: string;
  started_at: string;
  finished_at: string;
  status: JournalEntryStatus;
  error?: string;
  /** Only setup hooks that executed and declare a rollback. */
  rollback?: RollbackAction;
  rolled_back_at?: string;
  /** Last failed rollback attempt (the entry stays pending). */
  rollback_error?: string;
  rollback_attempts?: number;
}

export type NewJournalEntry = Omit<JournalEntry, 'seq'>;

/** runs/<id>/hooks-journal.json */
export interface JournalFile {
  version: 1;
  created_at: string;
  updated_at: string;
  entries: JournalEntry[];
}
