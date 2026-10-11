import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from '@demo-studio/core';
import { HookSecurityError, JournalError, errorMessage } from './errors.js';
import { executeRollback } from './kinds/index.js';
import { logger, redactText } from './secrets.js';
import type { HookContext, HookResult, JournalEntry, JournalFile, NewJournalEntry } from './types.js';
import { isRecord, nowIso } from './util.js';

export const JOURNAL_FILE = 'hooks-journal.json';

const KINDS = new Set(['http', 'sql', 'shell', 'js']);
const PHASES = new Set(['setup', 'teardown', 'reset']);
const STATUSES = new Set(['ok', 'failed', 'rolled_back']);

/** Executed, with a rollback action that has not succeeded yet. */
export function isPending(e: JournalEntry): boolean {
  return e.status === 'ok' && e.rollback !== undefined;
}

function validate(value: unknown, file: string): JournalFile {
  const bad = (why: string) => new JournalError(`hooks journal ${file} is malformed: ${why}`, file);
  if (!isRecord(value)) throw bad('expected a JSON object');
  if (value.version !== 1) throw bad(`unsupported version ${JSON.stringify(value.version)} (expected 1)`);
  if (!Array.isArray(value.entries)) throw bad('`entries` must be an array');
  value.entries.forEach((e: unknown, i: number) => {
    if (!isRecord(e)) throw bad(`entries[${i}] is not an object`);
    if (typeof e.seq !== 'number') throw bad(`entries[${i}].seq must be a number`);
    if (!KINDS.has(e.kind as string)) throw bad(`entries[${i}].kind ${JSON.stringify(e.kind)} is unknown`);
    if (!PHASES.has(e.phase as string)) throw bad(`entries[${i}].phase ${JSON.stringify(e.phase)} is unknown`);
    if (!STATUSES.has(e.status as string)) throw bad(`entries[${i}].status ${JSON.stringify(e.status)} is unknown`);
    if (e.rollback !== undefined && (!isRecord(e.rollback) || !KINDS.has(e.rollback.kind as string))) {
      throw bad(`entries[${i}].rollback is invalid`);
    }
  });
  const now = nowIso();
  return {
    version: 1,
    created_at: typeof value.created_at === 'string' ? value.created_at : now,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : now,
    entries: value.entries as JournalEntry[],
  };
}

/**
 * Rollback journal of executed hooks, persisted atomically as JSON after every change
 * (runs/<id>/hooks-journal.json). Not safe for concurrent use by several processes.
 */
export class Journal {
  private writing: Promise<void> = Promise.resolve();
  private rolling: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly file: string,
    private readonly data: JournalFile,
  ) {}

  /** Load a journal, or start an empty one (the file is created on the first record). */
  static async open(file: string): Promise<Journal> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        const now = nowIso();
        return new Journal(file, { version: 1, created_at: now, updated_at: now, entries: [] });
      }
      throw new JournalError(`cannot read hooks journal ${file}: ${errorMessage(e)}`, file);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new JournalError(`hooks journal ${file} is not valid JSON: ${errorMessage(e)}`, file);
    }
    return new Journal(file, validate(parsed, file));
  }

  get entries(): readonly JournalEntry[] {
    return this.data.entries;
  }

  /** Append an entry (a fresh `seq` is always assigned) and persist the journal. */
  async record(entry: NewJournalEntry | JournalEntry): Promise<JournalEntry> {
    const stored = this.add(entry);
    await this.save();
    return stored;
  }

  /** Append in memory only (call save()); lets callers keep the entry even when saving fails. */
  add(entry: NewJournalEntry | JournalEntry): JournalEntry {
    const seq = this.data.entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
    const stored: JournalEntry = { ...entry, seq };
    this.data.entries.push(stored);
    return stored;
  }

  /** Persist the current state (writes are serialized; each one is atomic). */
  save(): Promise<void> {
    const run = async () => {
      this.data.updated_at = nowIso();
      await writeJson(this.file, this.data);
    };
    const next = this.writing.catch(() => undefined).then(run);
    this.writing = next;
    return next.catch((e) => {
      throw new JournalError(`cannot write hooks journal ${this.file}: ${errorMessage(e)}`, this.file);
    });
  }

  /** Executed entries whose rollback has not succeeded yet, in execution order. */
  pending(): JournalEntry[] {
    return this.data.entries.filter(isPending);
  }

  /** Roll back every pending entry, most recent first. Rolled-back entries are skipped next time. */
  rollbackAll(ctx: HookContext): Promise<HookResult[]> {
    return this.rollbackEntries(
      this.pending().map((e) => e.seq),
      ctx,
    );
  }

  /**
   * Roll back the given entries (by seq) in reverse execution order; entries that are not pending are
   * skipped. Every rollback is attempted even if one fails. With `ctx.dryRun`, only describes them.
   */
  rollbackEntries(seqs: readonly number[], ctx: HookContext): Promise<HookResult[]> {
    const run = async () => {
      const wanted = new Set(seqs);
      const entries = this.data.entries.filter((e) => wanted.has(e.seq) && isPending(e)).sort((a, b) => b.seq - a.seq);
      const results: HookResult[] = [];
      for (const entry of entries) results.push(await this.rollbackOne(entry, ctx));
      return results;
    };
    const next = this.rolling.catch(() => undefined).then(run);
    this.rolling = next;
    return next;
  }

  private async rollbackOne(entry: JournalEntry, ctx: HookContext): Promise<HookResult> {
    const log = logger(ctx);
    const action = entry.rollback!;
    const t0 = Date.now();
    const base = {
      index: entry.seq,
      name: entry.name,
      kind: action.kind,
      phase: 'rollback' as const,
      description: action.description,
      journal_seq: entry.seq,
    };
    const label = `rollback of #${entry.seq} (${entry.description})`;
    if (ctx.dryRun) {
      log('info', `${label} [dry]: would run ${action.description}`);
      return { ...base, ok: true, status: 'dry', message: 'not executed (dry run)', ms: Date.now() - t0 };
    }
    log('info', `${label}: ${action.description}`);
    let message: string;
    try {
      message = await executeRollback(action, { ctx, log });
    } catch (e) {
      const error = redactText(ctx, errorMessage(e));
      entry.rollback_error = error;
      entry.rollback_attempts = (entry.rollback_attempts ?? 0) + 1;
      log('error', `${label} failed: ${error}`);
      const saved = await this.save().then(
        () => '',
        (se: unknown) => `; ${errorMessage(se)}`,
      );
      const status = e instanceof HookSecurityError ? 'refused' : 'failed';
      return { ...base, ok: false, status, error: error + saved, ms: Date.now() - t0 };
    }
    entry.status = 'rolled_back';
    entry.rolled_back_at = nowIso();
    entry.rollback_attempts = (entry.rollback_attempts ?? 0) + 1;
    delete entry.rollback_error;
    log('info', `${label} ok: ${redactText(ctx, message)}`);
    try {
      await this.save();
    } catch (e) {
      const error = `rolled back, but ${errorMessage(e)}`;
      log('error', `${label}: ${error}`);
      return { ...base, ok: false, status: 'failed', message, error, ms: Date.now() - t0 };
    }
    return { ...base, ok: true, status: 'ok', message: redactText(ctx, message), ms: Date.now() - t0 };
  }
}

/**
 * Journals with pending rollbacks: `<projectDir>/runs/<run-id>/hooks-journal.json` (or under `runsDir`),
 * most recent run first (run ids start with a timestamp). Journals that cannot be read are
 * included so the caller surfaces their error when opening them.
 */
export async function findPendingJournals(projectDir: string, opts: { runsDir?: string } = {}): Promise<string[]> {
  const runsDir = opts.runsDir ?? join(projectDir, 'runs');
  let dirs: string[];
  try {
    dirs = (await readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: string[] = [];
  for (const name of dirs.sort().reverse()) {
    const file = join(runsDir, name, JOURNAL_FILE);
    let journal: Journal;
    try {
      journal = await Journal.open(file);
    } catch {
      out.push(file);
      continue;
    }
    if (journal.pending().length) out.push(file);
  }
  return out;
}

export interface JournalRollback {
  file: string;
  results: HookResult[];
  /** The journal could not be opened. */
  error?: string;
}

/** env_reset helper: roll back every pending journal of a project, most recent run first. */
export async function rollbackPendingJournals(
  projectDir: string,
  ctx: HookContext,
  opts: { runsDir?: string } = {},
): Promise<JournalRollback[]> {
  const out: JournalRollback[] = [];
  for (const file of await findPendingJournals(projectDir, opts)) {
    try {
      const journal = await Journal.open(file);
      out.push({ file, results: await journal.rollbackAll(ctx) });
    } catch (e) {
      out.push({ file, results: [], error: redactText(ctx, errorMessage(e)) });
    }
  }
  return out;
}
