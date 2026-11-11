import type { JournalEntry } from '@retake/core';

// L7.11: the vocabulary of a hook run lives in core (core hook-run.ts: the engine's HookRunner port names it there);
// this package's API keeps every name.
export { journalsRollback } from '@retake/core';
export type {
  HookApprovalRequest,
  HookContext,
  HookLogLevel,
  HookPhase,
  HookResult,
  HookResultStatus,
  HttpRequestSpec,
  JournalEntry,
  JournalEntryStatus,
  PersonaRequestAuth,
  RollbackAction,
  TemplateSnapshot,
} from '@retake/core';

/** What `save_as` stores in `ctx.saved[name]`, and `{{response…}}` in an http rollback. */
export interface SavedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Parsed body when it is JSON. */
  json?: unknown;
}

export type NewJournalEntry = Omit<JournalEntry, 'seq'>;

/** runs/<id>/hooks-journal.json */
export interface JournalFile {
  version: 1;
  created_at: string;
  updated_at: string;
  entries: JournalEntry[];
}
