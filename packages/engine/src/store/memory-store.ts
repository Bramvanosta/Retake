/**
 * The ProjectStore port in memory: the adapter tests hand the engine (`createEngine({ ports: { stores } })`) so that an
 * authored write (a README, a file of a scenario's folder) lands in a Map instead of the disk, and its journal line in a
 * list instead of `.retake/journal.jsonl`. It keeps the disk adapter's rules (project-store.ts) — the same contract suite
 * runs on both (engine/test/project-store-contract.ts):
 * - refs and paths are checked and refused in the words of storage.ts (`resolveIn`, `refOfIn`: checkRef's words, the
 *   folder named by its label through FOLDER_NOUNS), shared, never copied;
 * - `ifMatch` a hash replaces that version only, `null` creates a file that must not exist; any other version is a
 *   `conflict` with `details.current` (storage.ts `conflictError`);
 * - each write and each folder is journaled whatever its outcome, as journal.ts `journalLine` builds a line (its version
 *   and the scope's clock first, then the caller, the project and the entry in the disk adapter's key order), the path
 *   named by journal.ts `journalPath` (workspace-relative, else under the store's label);
 * - `createFolder` stages its files under `<parent>/.tmp-<name>-<hex>` (in the Map), and after `recheck` moves them under
 *   `<parent>/<name>` (a replaced folder's files removed); a failure drops the stage. Two creations of one name are
 *   serialised in memory from the recheck to the move, as the disk's lock does: the second finds the first's folder.
 *   No lock file and no stale holder exist here, so the fake waits instead of answering `busy`.
 *
 * Limits (what only the disk can do, said so a test does not rely on the fake for it): a `build` that reads `stage.dir`
 * from the disk (brand/copy.ts, brand/create.ts list or read their stage) fails — the stage is not on the disk;
 * `stage.copy` reads its source from the disk (the fake stands for writes only); there are no symbolic links, file
 * modes, cross-process locks or size refusals (READ_TEXT_MAX_BYTES); the engine's loads (loadProject, scenarios,
 * themes) read the disk unless the WorkspaceReads port is a MemoryWorkspace's over the same Map
 * (workspace-reads/memory-reads.ts); the journal's readers still read the disk. Paths are compared byte for byte: on APFS (the
 * Mac's file system, case-insensitive by default) `README.md` and `readme.md` are one file, here two — a test of
 * a name's case belongs on the disk. A `createFolder` whose recheck says no folder while `<parent>/<name>` holds files
 * fails as the disk's rename does (ENOTEMPTY; ENOTDIR over a file), never merged.
 */
import { isUtf8 } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { errorKindOf } from '@retake/core/base';
import { EngineError } from '../errors.js';
import { conflictError, refOfIn, resolveIn, sha256Hex } from '../storage.js';
import type { WriteResult } from '../storage.js';
import { JOURNAL_FILES_MAX, journalLine, journalPath } from './journal.js';
import type { JournalEntry, JournalPlace, JournalWhat, JournalWrite } from './journal.js';
import { FOLDER_NOUNS } from './store.js';
import type { FolderStage, ProjectFolder, ProjectStore, ProjectStores, StoreLabel, StoreScope, StoreWriteOptions, StoredText } from './store.js';

const outcomeOf = (e: unknown): string => errorKindOf(e) ?? (e instanceof EngineError ? e.code : 'internal');

/** The error a write over an existing file gets on the disk (`wx`, COPYFILE_EXCL): EEXIST. */
function existsError(syscall: string, path: string, from?: string): NodeJS.ErrnoException {
  const where = from !== undefined ? `'${from}' -> '${path}'` : `'${path}'`;
  return Object.assign(new Error(`EEXIST: file already exists, ${syscall} ${where}`), { code: 'EEXIST', errno: -17, syscall, path });
}

/** The error the disk's rename of a stage gives over a name that holds files (macOS: ENOTEMPTY) or is a file (ENOTDIR). */
function renameError(code: 'ENOTEMPTY' | 'ENOTDIR', from: string, to: string): NodeJS.ErrnoException {
  const what = code === 'ENOTEMPTY' ? 'directory not empty' : 'not a directory';
  return Object.assign(new Error(`${code}: ${what}, rename '${from}' -> '${to}'`), { code, errno: code === 'ENOTEMPTY' ? -66 : -20, syscall: 'rename', path: from, dest: to });
}

/** The shared state of one MemoryProjectStores: the files (absolute path → bytes) and the journal lines. */
interface Memory {
  files: Map<string, Buffer>;
  lines: { workspace: string; line: string }[];
  /** The folder creations in progress, by final path (from the recheck to the move). */
  creating: Map<string, Promise<void>>;
}

const under = (dir: string): string => (dir.endsWith(sep) ? dir : dir + sep);

/** A folder of the Map, read by ref (the port's ProjectFolder). */
class MemoryFolder implements ProjectFolder {
  constructor(
    protected readonly memory: Memory,
    readonly root: string,
    /** How refusals name the root (FOLDER_NOUNS; default: the project folder). */
    protected readonly noun?: string,
  ) {}

  resolve(ref: string): string {
    return resolveIn(this.root, ref);
  }

  refOf(path: string): string {
    return refOfIn(this.root, path, this.noun);
  }

  async readText(ref: string): Promise<StoredText | undefined> {
    const buf = this.memory.files.get(this.resolve(ref));
    return buf === undefined ? undefined : { text: buf.toString('utf8'), sha256: sha256Hex(buf), utf8: isUtf8(buf) };
  }
}

class MemoryProjectStore extends MemoryFolder implements ProjectStore {
  readonly #place: JournalPlace;

  constructor(
    memory: Memory,
    root: string,
    readonly scope: StoreScope,
    readonly project?: string,
    label?: StoreLabel,
  ) {
    const place: StoreLabel = label ?? (project !== undefined ? '<project>' : '<store>');
    super(memory, root, FOLDER_NOUNS[place]);
    this.#place = { label: place, base: root };
  }

  private journalPathOf(path: string): string {
    return journalPath(this.scope.workspace, path, this.#place);
  }

  async writeText(ref: string, text: string, opts: StoreWriteOptions): Promise<WriteResult> {
    const { what, ifMatch } = opts;
    const file = this.resolve(ref);
    const path = this.journalPathOf(file);
    const buf = Buffer.from(text, 'utf8');
    const old = this.memory.files.get(file);
    const current = old === undefined ? null : sha256Hex(old);
    // Checked and written with no await in between: no other write of the Map comes between the two.
    const conflict =
      ifMatch === null ? (current !== null ? conflictError(ref, current, 'exists') : undefined) : current !== ifMatch ? conflictError(ref, current, current === null ? 'missing' : 'stale') : undefined;
    if (conflict) {
      this.journal({ op: 'write', what, path, if_match: ifMatch, outcome: outcomeOf(conflict) });
      throw conflict;
    }
    this.memory.files.set(file, buf);
    const res: WriteResult = { ref, path: file, sha256: sha256Hex(buf), bytes: buf.length };
    this.journal({ op: 'write', what, path, if_match: ifMatch, sha256: res.sha256, bytes: res.bytes, outcome: 'ok' });
    return res;
  }

  async writeFileAt(path: string, text: string, opts: StoreWriteOptions): Promise<WriteResult> {
    return this.writeText(this.refOf(path), text, opts);
  }

  async createFolder<T>(
    parent: string,
    name: string,
    o: {
      what: JournalWhat;
      build: (stage: FolderStage) => Promise<T>;
      recheck: () => Promise<{ existing: boolean }>;
      files?: (result: T) => string[];
    },
  ): Promise<{ result: T; dir: string; replaced: boolean }> {
    const files = this.memory.files;
    const tmp = join(parent, `.tmp-${name}-${randomBytes(6).toString('hex')}`);
    const final = join(parent, name);
    const written: string[] = [];
    const put = (rel: string, data: Buffer, exists: () => Error): void => {
      const p = join(tmp, ...rel.split('/'));
      if (files.has(p)) throw exists();
      files.set(p, data);
      written.push(rel);
    };
    const stage: FolderStage = {
      dir: tmp,
      write: async (rel, data) => put(rel, Buffer.from(data), () => existsError('open', join(tmp, ...rel.split('/')))),
      copy: async (rel, from) => {
        const data = await readFile(from);
        put(rel, data, () => existsError('copyfile', join(tmp, ...rel.split('/')), from));
      },
    };
    const path = this.journalPathOf(final);
    const keysUnder = (dir: string): string[] => [...files.keys()].filter((k) => k.startsWith(under(dir)));
    let replaced = false;
    let result: T;
    try {
      result = await o.build(stage);
      const release = await this.lockName(final);
      try {
        const { existing } = await o.recheck();
        // The move, with no await: no other write of the Map comes between the recheck's answer and the folder in place.
        if (existing) {
          for (const k of keysUnder(final)) files.delete(k);
          replaced = true;
        } else if (files.has(final) || keysUnder(final).length) {
          // A recheck that says no folder while one holds files: the disk's rename refuses it (it never merges).
          throw renameError(files.has(final) ? 'ENOTDIR' : 'ENOTEMPTY', tmp, final);
        }
        for (const k of keysUnder(tmp)) {
          files.set(join(final, k.slice(under(tmp).length)), files.get(k)!);
          files.delete(k);
        }
      } finally {
        release();
      }
    } catch (e) {
      for (const k of keysUnder(tmp)) files.delete(k);
      this.journal({ op: 'folder', what: o.what, path, outcome: outcomeOf(e) });
      throw e;
    }
    const listed = (o.files ? o.files(result) : written).slice();
    this.journal({
      op: 'folder',
      what: o.what,
      path,
      files: listed.slice(0, JOURNAL_FILES_MAX),
      ...(listed.length > JOURNAL_FILES_MAX ? { files_more: listed.length - JOURNAL_FILES_MAX } : {}),
      outcome: 'ok',
    });
    return { result, dir: final, replaced };
  }

  /** One creation of a name at a time, from the recheck to the move (the disk's creation lock); resolves to its release. */
  private async lockName(final: string): Promise<() => void> {
    const prev = this.memory.creating.get(final) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = prev.then(() => mine);
    this.memory.creating.set(final, chain);
    await prev;
    return () => {
      release();
      if (this.memory.creating.get(final) === chain) this.memory.creating.delete(final);
    };
  }

  private journal(entry: Omit<JournalWrite, 'v' | 'at' | 'by' | 'project'>): void {
    const { client, channel, trust } = this.scope.caller;
    const line = journalLine({ by: { client, channel, trust }, ...(this.project !== undefined ? { project: this.project } : {}), ...entry }, this.scope.clock);
    this.memory.lines.push({ workspace: this.scope.workspace, line });
  }
}

/** The ProjectStore port in memory (see the head of this file): files in a Map, the journal in a list. */
export class MemoryProjectStores implements ProjectStores {
  readonly #memory: Memory;

  /** `files`: the Map its files are kept in (a MemoryWorkspace shares its own with its reads); default a new one. */
  constructor(o: { files?: Map<string, Buffer> } = {}) {
    this.#memory = { files: o.files ?? new Map(), lines: [], creating: new Map() };
  }

  of(project: { dir: string; slug: string }, scope: StoreScope): ProjectStore {
    return new MemoryProjectStore(this.#memory, project.dir, scope, project.slug);
  }

  at(root: string, scope: StoreScope, o: { project?: string; label?: StoreLabel } = {}): ProjectStore {
    return new MemoryProjectStore(this.#memory, root, scope, o.project, o.label);
  }

  folder(root: string): ProjectFolder {
    return new MemoryFolder(this.#memory, root);
  }

  /** Put a file in place without a journal line (a test's starting state); `path` is absolute. */
  seed(path: string, data: string | Buffer): void {
    this.#memory.files.set(normalize(path), Buffer.from(data));
  }

  /** The files, by absolute path, sorted. */
  files(): Map<string, Buffer> {
    return new Map([...this.#memory.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  /** The journal's lines as written (each ends with a line break), oldest first; of one workspace when it is given. */
  journalLines(workspace?: string): string[] {
    return this.#memory.lines.filter((l) => workspace === undefined || l.workspace === workspace).map((l) => l.line);
  }

  /** The journal's entries, oldest first (journalLines, parsed). */
  journal(workspace?: string): JournalEntry[] {
    return this.journalLines(workspace).map((l) => JSON.parse(l) as JournalEntry);
  }
}
