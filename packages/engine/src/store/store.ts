/**
 * The project store as a port: what every authored write of Retake goes through (project-store.ts says what an authored
 * write is and how the disk adapter makes one). The engine is handed a `ProjectStores` (the factory) inside each
 * `StoreScope`, with the clock its journal lines are stamped by: who writes, when, and through which store. The adapter
 * is chosen at the composition roots (ports.ts `enginePorts`): the disk's (`diskProjectStores`, project-store.ts) for
 * the product. A store is rooted at a folder; its refs are relative to it, and nothing is written outside it.
 */
import type { Caller } from '../caller.js';
import type { Clock } from '../clock.js';
import type { WriteResult } from '../storage.js';
import type { JournalWhat } from './journal.js';

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
}

/** How a refusal names the folder of a store with a label of its own (default: the project folder). */
export const FOLDER_NOUNS: Readonly<Partial<Record<StoreLabel, string>>> = { '<components_dir>': 'the components folder', '<templates_dir>': 'the themes folder' };

/** The store of a project's folder for a scope (its own stores). */
export function storeOf(project: { dir: string; slug: string }, scope: StoreScope): ProjectStore {
  return scope.stores.of(project, scope);
}
