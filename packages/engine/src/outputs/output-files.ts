/**
 * The one implementation of the Outputs port (outputs.ts) over a file layer: core's reader of a run folder (core io
 * run-folder.ts, whose `fs` seam this layer answers) and core's reservation of a run id (core io reserveRunId, its
 * `fs` seam too), so the disk's adapter (disk-outputs.ts) and the memory's (memory-outputs.ts) differ only in where the
 * bytes lie — never in a rule.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathInside } from '@retake/core/base';
import { isRunId } from '@retake/core/ids';
import { orderRuns } from '@retake/core/run';
import { readNamedRun, readRunFolder, readRunRecord, reserveRunId } from '@retake/core/io';
import type { RunFolderFs, RunFolderStat } from '@retake/core/io';
import { EngineError } from '../errors.js';
import type { RunOutputs } from './outputs.js';
import { runsDirOf } from './outputs.js';

/** A path's facts as the layer gives them (node's Stats has them all). */
export interface OutputStat extends RunFolderStat {
  /** What the signature is made of: an inode (or the memory's write count), the size, the last change. */
  ino: number;
  mtimeMs: number;
}

/** What the run outputs ask of a storage: core's RunFolderFs, and the writes, the hash and the real path. */
export interface OutputFs extends RunFolderFs {
  lstat(path: string): Promise<OutputStat>;
  stat(path: string): Promise<OutputStat>;
  readdir(path: string): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>>;
  /** Without `recursive`: fails with code EEXIST when the folder is there (core reserveRunId reserves this way). */
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  /** Write a file whole, atomically (temporary file + rename on a disk), its folder made. */
  writeAtomic(path: string, data: string | Uint8Array): Promise<void>;
  /** The sha256 of a file's bytes (streamed on a disk). */
  hash(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
}

const missing = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException | null)?.code ?? '');

/** A file of a run folder: one plain segment (never a path a client or a run file chose). */
function fileOf(dir: string, file: string): string {
  if (file === '' || file === '.' || file === '..' || /[/\\\0]/.test(file)) throw new EngineError('invalid', `invalid run file name ${JSON.stringify(file)}: one file name of the run folder`);
  return join(dir, file);
}

/** As run-files.ts decides it: a real path inside a root spelt as real (a trailing separator holds nothing but itself). */
const within = (real: string, root: string): boolean => pathInside(real, root, { compare: 'spelling', trailingSepHoldsNothing: true });

/** The sha256 of bytes, for a layer that holds them (the memory's). */
export function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
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
    folder: (runsDir, name, o = {}) => readRunFolder(runsDir, name, { fs, ...(o.timeline ? { timeline: o.timeline } : {}), ...(o.filmFirst ? { filmFirst: true } : {}) }),
    named: (dir) => readNamedRun(dir, { fs }),
    record: (dir, o = {}) => readRunRecord(join(dir, 'run.json'), { fs, ...(o.follow ? { follow: true } : {}) }),
    readText: async (dir, file) => {
      const path = fileOf(dir, file);
      try {
        return await fs.readFile(path);
      } catch (e) {
        if (missing(e)) return undefined;
        throw e;
      }
    },
    describe: async (dir, file, o = {}) => {
      const path = fileOf(dir, file);
      let st: OutputStat;
      try {
        st = await fs.stat(path);
      } catch {
        return undefined;
      }
      if (!st.isFile()) return {};
      return { bytes: st.size, ...(o.hash ? { sha256: await fs.hash(path) } : {}) };
    },
    signature: async (path) => {
      try {
        const s = await fs.lstat(path);
        return `${s.ino}:${s.size}:${s.mtimeMs}`;
      } catch {
        return '-';
      }
    },
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
