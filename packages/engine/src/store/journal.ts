/**
 * The workspace journal: `<workspace>/.retake/journal.jsonl`, one line per authored write (a scenario, the README, a
 * thread, a theme, a component, a project, a workspace) and per hook run (a setup, teardown, step, seed, reset hook or a
 * rollback), saying who (the caller: its client, channel and trust), what (the file or folder written, the hook run —
 * never a value: no text, no templated command, no secret), when and the outcome. This module is its only writer.
 *
 * A file of its own beside the job history (`history.jsonl`): the history counts what was produced (its lines carry
 * `counted`, read by the usage counters and the index's `history` table), the journal records who changed what — mixing
 * them would change both readers. Both are written and read with one discipline (store/append-log.ts, L7.26): each line
 * appended whole under the log's lock (O_APPEND, never through a symbolic link) and synced to disk before the operation
 * that wrote it replies; nothing in Retake truncates, rewrites or removes the file (`retake prune` leaves it alone). A
 * last line left torn (no line break: a crash mid-write) is closed before the next one, so only the torn line is lost.
 * Synced with fsync: a line survives a crash of Retake or of the system, not a power loss on macOS (its fsync does not
 * flush the drive's cache; F_FULLFSYNC would, at a cost every write would pay).
 * A line that cannot be written never fails the work it records (that work is done: failing its reply would make a
 * client retry a write already made): the failure is said on stderr, at most once a minute with the count lost since.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { relativeInside } from '@retake/core/base';
import { STATE_DIR, WORKSPACE_JOURNAL_FILE } from '@retake/core/project';
import type { Caller } from '../caller.js';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import { appendLogLine, logFile, logLinesFromEnd, logWarner, readLogLines } from './append-log.js';
import type { AppendLog } from './append-log.js';

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
  /**
   * The file or folder: workspace-relative POSIX when inside the workspace (its real path or the one given), else its
   * store's label and the path inside that store (`<project>/scenarios/quote.yaml`, `<templates_dir>/mine`) — never an
   * absolute path (journalPath).
   */
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

/**
 * A hook run: one hook or one rollback executed (or refused). A dry run's hooks (`dry` results) are journaled none;
 * hooks a dry run really executes (`retake run --dry --hooks run`) are.
 */
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

/** The journal as a line log (append-log.ts): owner-only, its lock `journal.lock`. */
const JOURNAL_LOG: AppendLog = { file: WORKSPACE_JOURNAL_FILE, lock: 'journal.lock', mode: 0o600 };

export function journalFile(root: string): string {
  return logFile(root, JOURNAL_LOG);
}

/** Where a store outside the workspace is (a projects, templates or components folder configured elsewhere). */
export interface JournalPlace {
  /** How the journal names it: `<project>`, `<templates_dir>`, `<components_dir>`… */
  label: string;
  /** Its folder. */
  base: string;
}

/** A path's real spelling: its deepest existing folder resolved (symbolic links, /var → /private/var), the rest kept. */
function realSpelling(p: string): string {
  let head = p;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return p;
    rest.unshift(basename(head));
    head = up;
  }
  try {
    return join(realpathSync.native(head), ...rest);
  } catch {
    return p;
  }
}

/** `path` relative to `base` (POSIX, `.` for itself), compared as given and by real paths; undefined when outside. */
function relativeTo(base: string, path: string): string | undefined {
  const bases = [base, realSpelling(base)];
  const paths = [path, realSpelling(path)];
  for (const b of bases) {
    for (const q of paths) {
      const rel = relativeInside(q, b, { self: true });
      if (rel !== undefined) return rel === '' ? '.' : rel.split(sep).join('/');
    }
  }
  return undefined;
}

/**
 * A path as the journal names it: workspace-relative POSIX when inside the workspace — compared as given and by real
 * paths, so a store rooted at the workspace's real path (theme edits) or a link to it reads the same — else, for a store
 * configured outside the workspace, its label and the path inside it (`<templates_dir>/mine`), else
 * `<outside workspace>/<name>`. Never an absolute path (the journal travels with the workspace). A relative `path` is
 * kept as it is.
 */
export function journalPath(root: string, path: string, outside?: JournalPlace): string {
  if (!isAbsolute(path)) return path;
  const inWorkspace = relativeTo(root, path);
  if (inWorkspace !== undefined) return inWorkspace;
  const inPlace = outside ? relativeTo(outside.base, path) : undefined;
  if (outside && inPlace !== undefined) return inPlace === '.' ? outside.label : `${outside.label}/${inPlace}`;
  return `<outside workspace>/${basename(path)}`;
}

/** The journal's warning when a line cannot be written (stderr, at most once a minute). */
const warnLost = logWarner(`the workspace journal (${STATE_DIR}/${WORKSPACE_JOURNAL_FILE})`);

/** One journal line, its version and stamp first (the shape every store adapter journals). */
export function journalLine(entry: Omit<JournalWrite, 'v' | 'at'> | Omit<JournalHook, 'v' | 'at'>, clock: Clock): string {
  return `${JSON.stringify({ v: JOURNAL_VERSION, at: stampOf(clock), ...entry })}\n`;
}

/**
 * Append one line and sync it to disk before returning (the operation replies after this), under the journal's lock
 * (append-log.ts). The state folder is created when missing; a torn last line (no line break) is closed first. Never
 * throws: a failure is said on stderr.
 */
export async function appendJournal(root: string, entry: Omit<JournalWrite, 'v' | 'at'> | Omit<JournalHook, 'v' | 'at'>, clock: Clock): Promise<void> {
  const line = journalLine(entry, clock);
  try {
    await appendLogLine(root, JOURNAL_LOG, line);
  } catch (e) {
    warnLost(e);
  }
}

/** Who a run of hooks is journaled as (its caller) and what its lines are stamped with (the composition root's clock). */
export interface JournalAs {
  caller: Pick<Caller, 'client' | 'channel' | 'trust'>;
  clock: Clock;
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
export function hookRunRecorder(root: string, as: JournalAs, o: { project?: string; run?: string } = {}): (result: HookRunResult, run?: string) => Promise<void> {
  const { caller, clock } = as;
  const by = { client: caller.client, channel: caller.channel, trust: caller.trust };
  return (result, run = o.run) => appendJournal(root, { by, ...(o.project !== undefined ? { project: o.project } : {}), ...hookEntry(result), ...(run !== undefined ? { run } : {}) }, clock);
}

export interface JournalQuery {
  /** Only this project's lines. */
  project?: string;
  /** Only writes or only hook runs. */
  op?: 'write' | 'hook';
  /** The last `limit` lines (after the filters). */
  limit?: number;
}

/** One line as an entry when it is one of this version that passes the query, else undefined. */
function entryOf(line: string, q: JournalQuery): JournalEntry | undefined {
  if (!line.trim()) return undefined;
  let e: Partial<JournalEntry>;
  try {
    e = JSON.parse(line) as Partial<JournalEntry>;
  } catch {
    return undefined;
  }
  if (e === null || typeof e !== 'object' || e.v !== JOURNAL_VERSION || typeof e.op !== 'string' || typeof e.at !== 'string') return undefined;
  if (q.project !== undefined && e.project !== q.project) return undefined;
  if (q.op === 'hook' && e.op !== 'hook') return undefined;
  if (q.op === 'write' && e.op === 'hook') return undefined;
  return e as JournalEntry;
}

/**
 * The journal's lines, oldest first (a torn, foreign or newer-version line is skipped); [] when there is none. With a
 * `limit`, only the end of the file is read, back to the last `limit` lines that pass the filters.
 */
export async function readJournal(root: string, q: JournalQuery = {}): Promise<JournalEntry[]> {
  const file = journalFile(root);
  if (q.limit !== undefined && q.limit >= 0) {
    const out: JournalEntry[] = [];
    if (q.limit === 0) return out;
    try {
      for await (const line of logLinesFromEnd(file)) {
        const e = entryOf(line, q);
        if (!e) continue;
        out.push(e);
        if (out.length >= q.limit) break;
      }
    } catch {
      return [];
    }
    return out.reverse();
  }
  const out: JournalEntry[] = [];
  for (const line of await readLogLines(file)) {
    const e = entryOf(line, q);
    if (e) out.push(e);
  }
  return out;
}
