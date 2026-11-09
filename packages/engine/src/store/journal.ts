/**
 * The workspace journal: `<workspace>/.retake/journal.jsonl`, one line per authored write (a scenario, the README, a
 * thread, a theme, a component, a project, a workspace) and per hook run (a setup, teardown, step, seed, reset hook or a
 * rollback), saying who (the caller: its client, channel and trust), what (the file or folder written, the hook run —
 * never a value: no text, no templated command, no secret), when and the outcome. This module is its only writer.
 *
 * A file of its own beside the job history (`history.jsonl`): the history counts what was produced (its lines carry
 * `counted`, read by the usage counters and the index's `history` table), the journal records who changed what — mixing
 * them would change both readers. Append-only: each line is appended (O_APPEND) and synced to disk before the operation
 * that wrote it replies; nothing in Retake truncates, rewrites or removes the file (`retake prune` leaves it alone).
 * A line that cannot be written never fails the work it records (that work is done: failing its reply would make a
 * client retry a write already made): the failure is said once on stderr.
 */
import { mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { STATE_DIR, WORKSPACE_JOURNAL_FILE, pathInside, statePath } from '@retake/core';
import type { Caller } from '../caller.js';

export const JOURNAL_VERSION = 1;

/** Who wrote it: the caller (caller.ts). */
export type JournalBy = Pick<Caller, 'client' | 'channel' | 'trust'>;

/** What kind of authored state a write changed. */
export type JournalWhat = 'scenario' | 'readme' | 'thread' | 'theme' | 'component' | 'project' | 'workspace' | 'sandbox';

/** `ok`, or the error kind that stopped it (`conflict`, `refused`, `busy`, `invalid`, `internal`…). */
export type JournalOutcome = string;

interface EntryBase {
  v: typeof JOURNAL_VERSION;
  /** When it ended. */
  at: string;
  by: JournalBy;
  /** The project's slug (absent for a workspace file). */
  project?: string;
  outcome: JournalOutcome;
}

/** A file written: `write` (replaced or created), or a folder created whole (`folder`: a theme, a component, a project). */
export interface JournalWrite extends EntryBase {
  op: 'write' | 'folder';
  what: JournalWhat;
  /** The file or folder: workspace-relative POSIX when inside the workspace, else absolute. */
  path: string;
  /** The hash the write was made on (`if_match`): a hash, null (must not exist) or absent (no check). */
  if_match?: string | null;
  /** The bytes written and their sha256 (a file that was written). */
  sha256?: string;
  bytes?: number;
  /** A folder's files, folder-relative (at most JOURNAL_FILES_MAX), and how many more it holds. */
  files?: string[];
  files_more?: number;
}

/** A hook run: one hook or one rollback executed (a dry run executes none, and journals none). */
export interface JournalHook extends EntryBase {
  op: 'hook';
  /** The hook's name, when it has one. */
  hook?: string;
  /** Its position in its list (a rollback: its journal entry). */
  index: number;
  kind?: string;
  phase: string;
  /** The run (or hooks journal) id it ran for. */
  run?: string;
  optional?: boolean;
  ms?: number;
}

export type JournalEntry = JournalWrite | JournalHook;

/** The files a folder entry lists at most (the rest is counted in `files_more`). */
export const JOURNAL_FILES_MAX = 50;

export function journalFile(root: string): string {
  return statePath(root, undefined, WORKSPACE_JOURNAL_FILE);
}

/** A path as the journal names it: workspace-relative POSIX when inside the workspace, else absolute. */
export function journalPath(root: string, path: string): string {
  if (!isAbsolute(path) || !pathInside(path, root, { self: true })) return path;
  const rel = relative(root, path);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

let warned = false;

/**
 * Append one line and sync it to disk before returning (the operation replies after this). The state folder is
 * created when missing. Never throws: a failure is said once on stderr.
 */
export async function appendJournal(root: string, entry: Omit<JournalWrite, 'v' | 'at'> | Omit<JournalHook, 'v' | 'at'>): Promise<void> {
  const line = `${JSON.stringify({ v: JOURNAL_VERSION, at: new Date().toISOString(), ...entry })}\n`;
  try {
    await mkdir(statePath(root), { recursive: true });
    // O_APPEND: lines of concurrent writers never interleave; the file is never opened for anything but appending.
    const fh = await open(journalFile(root), 'a', 0o600);
    try {
      await fh.write(line);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (e) {
    if (!warned) {
      warned = true;
      process.stderr.write(`retake: the workspace journal (${STATE_DIR}/${WORKSPACE_JOURNAL_FILE}) could not be written: ${(e as Error).message}\n`);
    }
  }
}

/** The fields of a hook result the journal keeps (hooks HookResult, or the runner's view of one). */
export interface HookRunResult {
  index?: number;
  name?: string;
  kind?: string;
  phase?: string;
  status?: string;
  optional?: boolean;
  ms?: number;
}

/** What a hook result is journaled as: its name, position, kind, phase and outcome — never its description or message. */
export function hookEntry(result: HookRunResult): Omit<JournalHook, 'v' | 'at' | 'by' | 'project' | 'run'> {
  return {
    op: 'hook',
    ...(typeof result.name === 'string' ? { hook: result.name.slice(0, 200) } : {}),
    index: Number.isInteger(result.index) ? (result.index as number) : -1,
    ...(typeof result.kind === 'string' ? { kind: result.kind } : {}),
    phase: typeof result.phase === 'string' ? result.phase : 'unknown',
    ...(result.optional === true ? { optional: true } : {}),
    ...(typeof result.ms === 'number' && Number.isFinite(result.ms) ? { ms: Math.round(result.ms) } : {}),
    outcome: typeof result.status === 'string' ? result.status : 'unknown',
  };
}

/**
 * The HookContext.recordRun of a caller's hooks: each hook or rollback run is a journal line of the workspace `root`,
 * with the project and the run (or hooks journal) id it ran for (`run`, or the one given with the result).
 */
export function hookRunRecorder(root: string, caller: Pick<Caller, 'client' | 'channel' | 'trust'>, o: { project?: string; run?: string } = {}): (result: HookRunResult, run?: string) => Promise<void> {
  const by = { client: caller.client, channel: caller.channel, trust: caller.trust };
  return (result, run = o.run) => appendJournal(root, { by, ...(o.project !== undefined ? { project: o.project } : {}), ...hookEntry(result), ...(run !== undefined ? { run } : {}) });
}

export interface JournalQuery {
  /** Only this project's lines. */
  project?: string;
  /** Only writes or only hook runs. */
  op?: 'write' | 'hook';
  /** The last `limit` lines (after the filters). */
  limit?: number;
}

/** The journal's lines, oldest first (a torn, foreign or newer-version line is skipped); [] when there is none. */
export async function readJournal(root: string, q: JournalQuery = {}): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(journalFile(root), 'utf8');
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Partial<JournalEntry>;
    try {
      e = JSON.parse(line) as Partial<JournalEntry>;
    } catch {
      continue;
    }
    if (e === null || typeof e !== 'object' || e.v !== JOURNAL_VERSION || typeof e.op !== 'string' || typeof e.at !== 'string') continue;
    if (q.project !== undefined && e.project !== q.project) continue;
    if (q.op === 'hook' && e.op !== 'hook') continue;
    if (q.op === 'write' && e.op === 'hook') continue;
    out.push(e as JournalEntry);
  }
  return q.limit !== undefined && q.limit >= 0 ? out.slice(Math.max(0, out.length - q.limit)) : out;
}
