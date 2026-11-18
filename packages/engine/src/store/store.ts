/**
 * The project store as a port: what every authored write of Retake goes through (project-store.ts says what an authored
 * write is and how the disk adapter makes one). The engine is handed a `ProjectStores` (the factory) inside each
 * `StoreScope`, with the clock its journal lines are stamped by: who writes, when, and through which store. The adapter
 * is chosen at the composition roots (ports.ts `enginePorts`): the disk's (`diskProjectStores`, project-store.ts) for
 * the product. A store is rooted at a folder; its refs are relative to it, and nothing is written outside it.
 */
import { statePath } from '@retake/core/project';
import type { Caller } from '../caller.js';
import { EngineError } from '../errors.js';
import type { Clock } from '../clock.js';

/** What kind of authored state a write changed. */
export type JournalWhat = 'scenario' | 'readme' | 'thread' | 'theme' | 'component' | 'project' | 'workspace' | 'sandbox' | 'brand';

/** A file written: its ref and path, the hex sha256 of the bytes written and their count. */
export interface WriteResult {
  ref: string;
  path: string;
  /** Hex sha256 of the bytes written. */
  sha256: string;
  bytes: number;
}

/** Who writes (the caller), when (the clock), the workspace whose journal records it, and the stores it writes through. */
export interface StoreScope {
  workspace: string;
  caller: Caller;
  /** What the journal lines and the authored entries (a thread's) are stamped with. */
  clock: Clock;
  /** The stores this scope's writes go through. */
  stores: ProjectStores;
}

export interface StoreWriteOptions {
  /** A hash: the version read must still be there; null: the file must not exist. Every authored write states one. */
  ifMatch: string | null;
  /** The caller holds a lock that serialises every write of this file (a comment thread's). */
  locked?: boolean;
  what: JournalWhat;
}

/** The staged copy of a folder being created (createFolder): its files are written into `dir`, never over one. */
export interface FolderStage {
  /** The staging folder (beside the final one, a hidden name). */
  readonly dir: string;
  /** Write a new file (folder-relative POSIX path; its folders are created). */
  write(rel: string, data: string | Buffer): Promise<void>;
  /** Copy a file into the stage, never over one. */
  copy(rel: string, from: string): Promise<void>;
  /**
   * Write a new file from a stream of bytes (an import): its folders made one at a time, never `recursive` — a folder
   * already there that this stage did not make (a name the disk takes for another: case, Unicode forms) refuses —,
   * the file opened exclusively and never through a link, with the mode given exactly (0644 or 0755: never setuid).
   * Answers the sha256 and the count of the bytes written.
   */
  writeFrom(rel: string, source: AsyncIterable<Buffer | Uint8Array>, o: { mode: 0o644 | 0o755 }): Promise<{ sha256: string; bytes: number }>;
}

/** The text of a file, the sha256 of its bytes and whether they are UTF-8 (storage.ts `Storage.readText`). */
export interface StoredText {
  text: string;
  sha256: string;
  utf8: boolean;
}

/** A folder read by ref (no write): a project's README, a store's current version of a file. */
export interface ProjectFolder {
  readonly root: string;
  /** The local path of a ref; refuses absolute refs, `..`, backslashes and empty segments. */
  resolve(ref: string): string;
  /** The ref of a path inside the folder; refused outside it. */
  refOf(path: string): string;
  /** The file's text, or undefined when it does not exist (storage.ts `Storage.readText`: its refusals). */
  readText(ref: string): Promise<StoredText | undefined>;
}

/** A folder the authored writes of one scope go through: each write checked on the version read and journaled. */
export interface ProjectStore extends ProjectFolder {
  readonly scope: StoreScope;
  /** The project's slug, journaled with each write (absent for the workspace's files). */
  readonly project?: string;
  /** Write one file, then journal it whatever the outcome. */
  writeText(ref: string, text: string, opts: StoreWriteOptions): Promise<WriteResult>;
  /** writeText of a file given by its absolute path inside the store's folder. */
  writeFileAt(path: string, text: string, opts: StoreWriteOptions): Promise<WriteResult>;
  /**
   * Make the folder `ref` inside the store's folder, its parents too, when it is not there (a new workspace's
   * `projects/`): refused as a write's ref is; not journaled (an empty folder holds no one's work).
   */
  makeFolder(ref: string): Promise<void>;
  /**
   * Copy the file `from` (a path anywhere: a person's brand file) to `ref`, which must not exist (a conflict otherwise),
   * its folders made inside the store; journaled as a write.
   */
  copyFileIn(ref: string, from: string, o: { what: JournalWhat }): Promise<WriteResult>;
  /**
   * Move the folder or file `ref` to `to` (a ref of the same store, which must not exist; its parents made): under the
   * write lock of `lockRef` when given (a file inside it whose saves take that lock — a save racing the move waits, then
   * finds it gone: a conflict), after `check` (throws to refuse: the source changed since it was read); a rename, else
   * (another volume: EXDEV) a copy then a removal. Journaled (`op: 'move'`, its path and `to`) whatever the outcome.
   */
  moveAside(ref: string, to: string, o: { what: JournalWhat; lockRef?: string; check?: () => Promise<void> }): Promise<{ path: string; to: string }>;
  /**
   * Move a folder or file from anywhere (`from`, absolute: a templates_dir configured outside the workspace) to `to`, a
   * ref of the store, as moveAside does — after `check`, a rename, else (EXDEV) a copy then a removal; journaled
   * (`op: 'move'`) whatever the outcome. No write lock: nothing of the store writes `from`.
   */
  takeIn(from: string, to: string, o: { what: JournalWhat; check?: () => Promise<void> }): Promise<{ path: string; to: string }>;
  /** Create the folder `<parent>/<name>` whole: staged, checked, renamed into place, journaled with its files. */
  createFolder<T>(
    parent: string,
    name: string,
    o: {
      what: JournalWhat;
      build: (stage: FolderStage) => Promise<T>;
      recheck: () => Promise<{ existing: boolean }>;
      /** The files to journal (default: those written or copied). */
      files?: (result: T) => string[];
    },
  ): Promise<{ result: T; dir: string; replaced: boolean }>;
}

/** The labels a store of a folder outside the workspace is journaled and refused under (journal.ts journalPath). */
export type StoreLabel = '<project>' | '<store>' | '<components_dir>' | '<templates_dir>';

/** The port: the stores of a workspace's folders. */
export interface ProjectStores {
  /** The store of a project's folder (journaled with its slug, under `<project>`). */
  of(project: { dir: string; slug: string }, scope: StoreScope): ProjectStore;
  /** The store of any folder (the workspace's, its templates or components folder; a project being created). */
  at(root: string, scope: StoreScope, o?: { project?: string; label?: StoreLabel }): ProjectStore;
  /** A folder to read (a project's README), refused outside it like a store. */
  folder(root: string): ProjectFolder;
  /**
   * Append one line to the record `name` of the project folder `projectDir`'s state folder (recordPath: agent-written.ts'
   * scenario writes and a person's trust): created owner-only with its folder, never through a symbolic link, a torn
   * last line closed first, synced before it returns. A name that is not a plain file name is refused. Not journaled:
   * the record follows writes the journal already holds.
   */
  appendRecord(projectDir: string, name: string, line: string): Promise<void>;
}

/** `<projectDir>/.retake/<name>`: a record of a project's state folder; `invalid` for a name that is not a plain file name. */
export function recordPath(projectDir: string, name: string): string {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name) || name.includes('..')) throw new EngineError('invalid', `not a record of a project's state folder: ${JSON.stringify(name.slice(0, 80))}`);
  return statePath(projectDir, undefined, name);
}

/** How a refusal names the folder of a store with a label of its own (default: the project folder). */
export const FOLDER_NOUNS: Readonly<Partial<Record<StoreLabel, string>>> = { '<components_dir>': 'the components folder', '<templates_dir>': 'the themes folder' };

/** The store of a project's folder for a scope (its own stores). */
export function storeOf(project: { dir: string; slug: string }, scope: StoreScope): ProjectStore {
  return scope.stores.of(project, scope);
}
