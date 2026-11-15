/**
 * The one implementation of the Outputs port (outputs.ts) over a file layer: core's reader of a run folder (core io
 * run-folder.ts, whose `fs` seam this layer answers), core's reservation of a run id (core io reserveRunId, its `fs`
 * seam too) and core's reader of renders/ (core io render-folder.ts, its RecordFs seam), so the disk's adapter (disk-outputs.ts) and the memory's (memory-outputs.ts) differ only in where the
 * bytes lie — never in a rule.
 */
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { pathInside } from '@retake/core/base';
import { isRunId } from '@retake/core/ids';
import { orderRuns } from '@retake/core/run';
import { findNamedRender, readListedRender, readNamedRun, readRenderById, readRendersFolder, readRunFolder, readRunRecord, reserveRunId } from '@retake/core/io';
import type { PlainFileRead, RecordFs, RunFolderFs, RunFolderStat } from '@retake/core/io';
import { EngineError } from '../errors.js';
import type { OutputFolder, OutputKind, Outputs, RenderOutputs, RunOutputs } from './outputs.js';
import { OUTPUT_DIRS, oneName, runsDirOf } from './outputs.js';

/** A path's facts as the layer gives them (node's Stats has them all). */
export interface OutputStat extends RunFolderStat {
  /** What the signature is made of: an inode (or the memory's write count), the size, the last change. */
  ino: number;
  mtimeMs: number;
  /** The file's names (its hard links); 1 in the memory, which has none. */
  nlink: number;
}

/** What the outputs ask of a storage: core's RunFolderFs and RecordFs, and the writes, the removal, the hash and the real path. */
export interface OutputFs extends RunFolderFs, RecordFs {
  lstat(path: string): Promise<OutputStat>;
  /** A file's bytes, as `readFile` reads its text. */
  readBytes(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<OutputStat>;
  readdir(path: string): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>>;
  /** Without `recursive`: fails with code EEXIST when the folder is there (core reserveRunId reserves this way). */
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  /** Write a file whole, atomically (temporary file + rename on a disk), its folder made. */
  writeAtomic(path: string, data: string | Uint8Array): Promise<void>;
  /** Create a file that is not there yet with `text`, its folder made; fails with code EEXIST when anything is there. */
  createExclusive(path: string, text: string): Promise<void>;
  /** The sha256 of a file's bytes (streamed on a disk), never through a link (refused: ELOOP) nor of a file with another name (refused: EMLINK). */
  hash(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  /** The real path as the operating system spells it (its case, on a disk that ignores case); the memory's is `realpath`. */
  nativeRealpath?(path: string): Promise<string>;
  /** Remove a file or a folder and everything under it; nothing there is no failure. */
  remove(path: string): Promise<void>;
  /** Remove an empty folder (fails when it holds anything, as rmdir does). */
  rmdir(path: string): Promise<void>;
  /** Remove one file (a folder there fails); nothing there is no failure. */
  removeFile(path: string): Promise<void>;
  /** A small regular file read whole by the plain-file rule (core readPlainFile; `oneName`: a hard link refused as `link`). Never throws. */
  plain(path: string, max: number, o: { oneName?: boolean }): Promise<PlainFileRead>;
  /** Move a file or a folder (rename). */
  rename(from: string, to: string): Promise<void>;
}

const missing = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException | null)?.code ?? '');

/** A file of a run folder: one plain segment (never a path a client or a run file chose). */
function fileOf(dir: string, file: string): string {
  if (file === '' || file === '.' || file === '..' || /[/\\\0]/.test(file)) throw new EngineError('invalid', `invalid run file name ${JSON.stringify(file)}: one file name of the run folder`);
  return join(dir, file);
}

/** As run-files.ts decides it: a real path inside a root spelt as real (a trailing separator holds nothing but itself). */
const within = (real: string, root: string): boolean =>
  pathInside(real, root, {
    compare: 'spelling',
    trailingSepHoldsNothing: true,
  });

/** The sha256 of bytes, for a layer that holds them (the memory's). */
export function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** What is at `path`, no link followed. */
async function kindOf(fs: OutputFs, path: string): Promise<OutputKind | undefined> {
  try {
    const st = await fs.lstat(path);
    return st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'folder' : 'other';
  } catch {
    return undefined;
  }
}

/** The bytes under `path`, no link followed (a link counts its own size). */
async function sizeOf(fs: OutputFs, path: string): Promise<number> {
  let st: OutputStat;
  try {
    st = await fs.lstat(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await fs.names(path).catch(() => [] as string[])) n += await sizeOf(fs, join(path, e));
  return n;
}

async function namesOf(fs: OutputFs, dir: string): Promise<string[]> {
  try {
    return await fs.names(dir);
  } catch {
    return [];
  }
}

async function signatureOf(fs: OutputFs, path: string, o: { follow?: boolean } = {}): Promise<string> {
  try {
    const s = await (o.follow ? fs.stat(path) : fs.lstat(path));
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

/** Whether `path` lies inside the project `projectDir` once links are followed (both real paths; false when either cannot be resolved). */
async function insideProject(fs: OutputFs, projectDir: string, path: string): Promise<boolean> {
  try {
    const [project, real] = await Promise.all([fs.realpath(projectDir), fs.realpath(path)]);
    return pathInside(real, project, { dotDotPrefix: true });
  } catch {
    return false;
  }
}

/** `p` with its links resolved, the part not there yet kept as spelt (core realPathOf, on this storage). */
async function realPathKept(fs: OutputFs, p: string): Promise<string> {
  try {
    return await (fs.nativeRealpath ?? fs.realpath)(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(await realPathKept(fs, parent), basename(p));
  }
}

/** Core insideFolder's rule on this storage: `path` in `dir` once both are resolved (`dir` itself counts). */
async function holdsOf(fs: OutputFs, dir: string, path: string): Promise<boolean> {
  const [real, root] = await Promise.all([realPathKept(fs, resolve(path)), realPathKept(fs, resolve(dir))]);
  return pathInside(real, root);
}

/** A generated folder of the storage `fs`, at `dirOf` of a project. */
function outputFolderOn(fs: OutputFs, dirOf: (projectDir: string) => string): OutputFolder {
  return {
    dirOf,
    names: (dir) => namesOf(fs, dir),
    kind: (path) => kindOf(fs, path),
    readText: async (path) => {
      try {
        return await fs.readFile(path);
      } catch (e) {
        if (missing(e) || (e as NodeJS.ErrnoException | null)?.code === 'EISDIR') return undefined;
        throw e;
      }
    },
    readCapped: (path, o) => fs.text(path, o),
    size: (path) => sizeOf(fs, path),
    remove: (path) => fs.remove(path),
    removeFile: (path) => fs.removeFile(path),
    makeFolder: async (path, projectDir) => {
      const refused = () => new EngineError('refused', `${path} leads out of the project ${projectDir} (a symbolic link): not made`);
      let there = dirname(path);
      while (
        dirname(there) !== there &&
        !(await fs.realpath(there).then(
          () => true,
          () => false,
        ))
      )
        there = dirname(there);
      if (!(await insideProject(fs, projectDir, there))) throw refused();
      await fs.mkdir(path, { recursive: true });
      if (!(await insideProject(fs, projectDir, path))) throw refused();
    },
    write: (path, data) => fs.writeAtomic(path, data),
    writeJson: (path, value) => fs.writeAtomic(path, JSON.stringify(value, null, 2) + '\n'),
    signature: (path, o) => signatureOf(fs, path, o),
    within: (projectDir, path = dirOf(projectDir)) => insideProject(fs, projectDir, path),
    readPlain: (path, o) => fs.plain(path, o.max, o.oneName ? { oneName: true } : {}),
    holds: (dir, path) => holdsOf(fs, dir, path),
    move: (from, to) => fs.rename(from, to),
  };
}

/** The renders of the storage `fs`: a generated folder, and core's reader of renders/ on it. */
function renderOutputsOn(fs: OutputFs): RenderOutputs {
  return {
    ...outputFolderOn(fs, OUTPUT_DIRS.renders),
    lock: (path, text) => fs.createExclusive(path, text),
    unlock: (path) => fs.removeFile(path),
    entries: (rendersDir, only) => readRendersFolder(rendersDir, { fs, ...(only ? { only } : {}) }),
    listed: (rendersDir, name) => readListedRender(rendersDir, name, { fs }),
    byId: (rendersDir, id) => readRenderById(rendersDir, id, { fs }),
    named: (rendersDir, arg, o) => findNamedRender(rendersDir, arg, { ...o, fs }),
  };
}

/** Every member of the Outputs port on the storage `fs`. */
export function outputsOn(fs: OutputFs): Outputs {
  return {
    runs: runOutputsOn(fs),
    renders: renderOutputsOn(fs),
    reviews: outputFolderOn(fs, OUTPUT_DIRS.reviews),
    exports: outputFolderOn(fs, OUTPUT_DIRS.exports),
    inspections: outputFolderOn(fs, OUTPUT_DIRS.inspections),
  };
}

/** The RunOutputs of the storage `fs`. */
export function runOutputsOn(fs: OutputFs): RunOutputs {
  return {
    ids: async (runsDir) => {
      let entries: Awaited<ReturnType<OutputFs['readdir']>>;
      try {
        entries = await fs.readdir(runsDir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
        throw e;
      }
      return orderRuns(entries.filter((d) => d.isDirectory()).map((d) => d.name));
    },
    folder: (runsDir, name, o = {}) =>
      readRunFolder(runsDir, name, {
        fs,
        ...(o.timeline ? { timeline: o.timeline } : {}),
        ...(o.filmFirst ? { filmFirst: true } : {}),
      }),
    named: (dir) => readNamedRun(dir, { fs }),
    record: (dir, o = {}) =>
      readRunRecord(join(dir, 'run.json'), {
        fs,
        ...(o.follow ? { follow: true } : {}),
      }),
    readText: async (dir, file) => {
      const path = fileOf(dir, file);
      try {
        return await fs.readFile(path);
      } catch (e) {
        if (missing(e)) return undefined;
        throw e;
      }
    },
    readBytes: async (dir, file) => {
      const path = fileOf(dir, file);
      try {
        return await fs.readBytes(path);
      } catch (e) {
        if (missing(e)) return undefined;
        throw e;
      }
    },
    describe: async (dir, file, o = {}) => {
      const path = fileOf(dir, file);
      let st: OutputStat;
      try {
        st = await fs.lstat(path);
      } catch {
        return undefined;
      }
      // A link is followed only while its real path stays in the run folder; one that leaves it (or leads nowhere), and
      // a file that has another name (a hard link: any file of the machine), is said as a refused link: no size, no hash
      // of what lies elsewhere.
      let target = path;
      if (st.isSymbolicLink()) {
        try {
          const [real, root] = await Promise.all([fs.realpath(path), fs.realpath(dir)]);
          if (!within(real, root) || real === root) return { link: 'refused' };
          target = real;
          st = await fs.lstat(real);
        } catch {
          return { link: 'refused' };
        }
      }
      if (!st.isFile()) return {};
      if (!oneName(st)) return { link: 'refused' };
      let sha256: string | undefined;
      try {
        if (o.hash) sha256 = await fs.hash(target);
      } catch (e) {
        // Turned into a link, or given another name, between the look and the read (the hash opens without following
        // one and checks the opened file's names): a refused link.
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'EMLINK') return { link: 'refused' };
        throw e;
      }
      return { bytes: st.size, ...(sha256 !== undefined ? { sha256 } : {}) };
    },
    signature: (path, o) => signatureOf(fs, path, o),
    names: (runsDir) => namesOf(fs, runsDir),
    readCapped: (dir, file, o) => fs.text(fileOf(dir, file), o),
    size: (path) => sizeOf(fs, path),
    remove: (dir) => fs.remove(dir),
    unreserve: (dir) => fs.rmdir(dir).catch(() => undefined),
    inside: async (projectDir, id) => {
      if (!isRunId(id)) return false;
      const runsDir = runsDirOf(projectDir);
      const dir = join(runsDir, id);
      try {
        if (!(await fs.lstat(dir)).isDirectory()) return false;
        const [project, root, real] = await Promise.all([fs.realpath(projectDir), fs.realpath(runsDir), fs.realpath(dir)]);
        return within(root, project) && within(real, root) && real !== root;
      } catch {
        return false;
      }
    },
    reserve: (runsDir, scenario, at) => reserveRunId(runsDir, scenario, at, fs),
    write: async (dir, file, data) => fs.writeAtomic(fileOf(dir, file), data),
    writeJson: async (dir, file, value) => fs.writeAtomic(fileOf(dir, file), JSON.stringify(value, null, 2) + '\n'),
  };
}
