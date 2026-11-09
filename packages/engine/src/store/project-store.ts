/**
 * The project store: every authored write of Retake goes through here — a scenario saved or edited, the README, a
 * comment thread, a theme created, copied or edited, a component scaffolded, a project created, a workspace made by
 * `retake init`, a sandbox scaffold — and each one is journaled (journal.ts: who, what, when, outcome) before the
 * operation replies. Generated outputs (runs, renders, reviews, exports) and machine state (`.retake/`) are not authored
 * and do not come here.
 *
 * A file is written by storage.ts `LocalStorage.writeText` (atomic, `if_match` checked under the file's write lock, a
 * link of the project written through, the mode kept): `ifMatch` a hash replaces the version read, `null` creates a file
 * that must not exist. A folder made whole (a theme, a copy of one) is staged beside its final place and renamed into
 * it, under a lock of its name, once its files are written and checked (`createFolder`).
 *
 * A store is rooted at a folder (a project's, the workspace's, its templates or components folder): its refs are
 * relative to it, and nothing is written outside it. The journal is the workspace's (`scope.workspace`); a store whose
 * folder is configured outside the workspace (`projects_dir`, `templates_dir`, `components_dir` elsewhere) journals its
 * paths under its label (`<project>/scenarios/quote.yaml`, `<templates_dir>/mine`), never an absolute path.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errorKindOf } from '@retake/core';
import type { TakeLock } from '@retake/sandbox';
import { callerOf } from '../caller.js';
import type { Caller } from '../caller.js';
import { EngineError } from '../errors.js';
import { lockHolder, takeProjectLock } from '../project-lock.js';
import { LocalStorage, sha256Hex, WRITE_LOCK_WAIT_MS } from '../storage.js';
import type { WriteResult } from '../storage.js';
import { JOURNAL_FILES_MAX, appendJournal, journalPath } from './journal.js';
import type { JournalPlace, JournalWhat, JournalWrite } from './journal.js';

/** Who writes, and the workspace whose journal records it. */
export interface StoreScope {
  workspace: string;
  caller: Caller;
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

const outcomeOf = (e: unknown): string => errorKindOf(e) ?? (e instanceof EngineError ? e.code : 'internal');

export class ProjectStore {
  readonly #storage: LocalStorage;
  /** How the journal names this store's folder when it is outside the workspace. */
  readonly #place: JournalPlace;

  constructor(
    readonly root: string,
    readonly scope: StoreScope,
    /** The project's slug, journaled with each write (absent for the workspace's files). */
    readonly project?: string,
    /** The journal's name of the folder when it is outside the workspace (default `<project>`, else `<store>`). */
    label?: string,
  ) {
    this.#storage = new LocalStorage(root);
    this.#place = { label: label ?? (project !== undefined ? '<project>' : '<store>'), base: root };
  }

  /** The store of a project's folder. */
  static of(project: { dir: string; slug: string }, scope: StoreScope): ProjectStore {
    return new ProjectStore(project.dir, scope, project.slug);
  }

  resolve(ref: string): string {
    return this.#storage.resolve(ref);
  }

  /** The store-relative ref of an absolute path inside its folder (LocalStorage.refOf: refused outside it). */
  refOf(path: string): string {
    return this.#storage.refOf(path);
  }

  readText(ref: string): ReturnType<LocalStorage['readText']> {
    return this.#storage.readText(ref);
  }

  /** How the journal names a path of this store (journal.ts journalPath). */
  private journalPathOf(path: string): string {
    return journalPath(this.scope.workspace, path, this.#place);
  }

  /** Write one file (LocalStorage.writeText), then journal it whatever the outcome: the line is on disk before this returns. */
  async writeText(ref: string, text: string, opts: StoreWriteOptions): Promise<WriteResult> {
    const { what, ...write } = opts;
    const path = this.journalPathOf(this.#storage.resolve(ref));
    const ifMatch = { if_match: opts.ifMatch };
    let res: WriteResult;
    try {
      res = await this.#storage.writeText(ref, text, write);
    } catch (e) {
      await this.journal({ op: 'write', what, path, ...ifMatch, outcome: outcomeOf(e) });
      throw e;
    }
    await this.journal({ op: 'write', what, path, ...ifMatch, sha256: res.sha256, bytes: res.bytes, outcome: 'ok' });
    return res;
  }

  /** writeText of a file given by its absolute path inside the store's folder (the writer an adapter is handed). */
  writeFileAt(path: string, text: string, opts: StoreWriteOptions): Promise<WriteResult> {
    return this.writeText(this.#storage.refOf(path), text, opts);
  }

  /**
   * Create the folder `<parent>/<name>` whole: staged in `<parent>/.tmp-<name>-<random>` (`build` writes its files and
   * checks them), then — under the lock of its name, after `recheck` (which throws when the name is taken, or says that
   * an `existing` folder is replaced) — renamed into place; a replaced folder is set aside first and removed once the
   * new one is in place (put back when the rename fails). A failure removes the stage. Journaled with its files.
   */
  async createFolder<T>(
    parent: string,
    name: string,
    o: {
      what: JournalWhat;
      build: (stage: FolderStage) => Promise<T>;
      recheck: () => Promise<{ existing: boolean }>;
      /** The files to journal (default: those written or copied). */
      files?: (result: T) => string[];
    },
  ): Promise<{ result: T; dir: string; replaced: boolean }> {
    const tmp = join(parent, `.tmp-${name}-${randomBytes(6).toString('hex')}`);
    const final = join(parent, name);
    const written: string[] = [];
    const stage: FolderStage = {
      dir: tmp,
      write: async (rel, data) => {
        const p = join(tmp, ...rel.split('/'));
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, data, { flag: 'wx' });
        written.push(rel);
      },
      copy: async (rel, from) => {
        const p = join(tmp, ...rel.split('/'));
        await mkdir(dirname(p), { recursive: true });
        await copyFile(from, p, 1 /* COPYFILE_EXCL */);
        written.push(rel);
      },
    };
    const path = this.journalPathOf(final);
    let old: string | undefined;
    let result: T;
    try {
      await mkdir(tmp);
      result = await o.build(stage);
      const lock = await this.lockName(parent, name);
      try {
        // Checked again right before the rename (an empty folder of that name would be replaced silently on macOS).
        const { existing } = await o.recheck();
        if (existing) {
          old = join(parent, `.old-${name}-${randomBytes(6).toString('hex')}`);
          await rename(final, old);
        }
        try {
          await rename(tmp, final);
        } catch (e) {
          if (old) await rename(old, final).catch(() => undefined);
          old = undefined;
          throw e;
        }
      } finally {
        await lock.release();
      }
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      await this.journal({ op: 'folder', what: o.what, path, outcome: outcomeOf(e) });
      throw e;
    }
    if (old) await rm(old, { recursive: true, force: true });
    const files = (o.files ? o.files(result) : written).slice();
    await this.journal({ op: 'folder', what: o.what, path, files: files.slice(0, JOURNAL_FILES_MAX), ...(files.length > JOURNAL_FILES_MAX ? { files_more: files.length - JOURNAL_FILES_MAX } : {}), outcome: 'ok' });
    return { result, dir: final, replaced: old !== undefined };
  }

  /**
   * The lock of a folder's creation: `<workspace>/.retake/locks/create-<hash of the folder's real path>.lock`, held from
   * the last check of the name to the rename (two creations of one name, however their folder is spelt: the second
   * finds the first's folder).
   */
  private async lockName(parent: string, name: string): Promise<TakeLock> {
    const key = this.journalPathOf(join(parent, name));
    const real = join(await realpath(parent).catch(() => parent), name);
    return takeProjectLock(this.scope.workspace, `create-${sha256Hex(real).slice(0, 24)}.lock`, {
      command: `create ${key}`.slice(0, 200),
      what: key,
      waitMs: WRITE_LOCK_WAIT_MS,
      busy: (lockRef, held) => {
        const { pid } = lockHolder(held);
        return new EngineError('busy', `${name} is being created by another command${pid ? ` (pid ${pid})` : ''}: try again`, {
          fix: `try again in a moment; if no retake command is running, remove ${lockRef}`,
        });
      },
    });
  }

  private journal(entry: Omit<JournalWrite, 'v' | 'at' | 'by' | 'project'>): Promise<void> {
    const { client, channel, trust } = this.scope.caller;
    return appendJournal(this.scope.workspace, { by: { client, channel, trust }, ...(this.project !== undefined ? { project: this.project } : {}), ...entry });
  }
}

/** The scope of a person's own `retake` command: its writes are journaled as the CLI's (`cli`, trust `author`). */
export function personScope(workspace: string): StoreScope {
  return { workspace, caller: callerOf('cli') };
}

/**
 * A writer of files of `store`'s folder for an adapter that names them by absolute path (a sandbox scaffold, the line
 * project.yaml gains): written on the version the adapter read (`previous`: `if_match` its hash — a change made since
 * is a conflict, never lost), else on the file as it is just before (its hash, or null: created, never over a file).
 */
export function fileWriter(store: ProjectStore, what: JournalWhat): (file: string, text: string, previous?: string) => Promise<void> {
  return async (file, text, previous) => {
    const ref = store.refOf(file);
    const ifMatch = previous !== undefined ? sha256Hex(Buffer.from(previous, 'utf8')) : ((await store.readText(ref))?.sha256 ?? null);
    await store.writeText(ref, text, { ifMatch, what });
  };
}
