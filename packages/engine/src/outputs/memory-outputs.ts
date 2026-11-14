/**
 * The Outputs port in memory (outputs.ts), for tests: the generated folders in a Map of files, read by core's own
 * readers of a run folder and of renders/ and reserved by core's own reservation (output-files.ts `runOutputsOn`: the disk adapter's code), so a
 * test reads back what the engine and the in-memory capture runner wrote — no folder of the disk exists for it. The
 * same contract suite runs on both adapters (engine/test/outputs-contract.ts).
 *
 * Limits (what only the disk has, said so a test does not rely on the fake for it): no symbolic link (`inside` is a
 * folder's being there: no real path differs from its spelling), no file mode, no special file, case counts; a write
 * is atomic by being one Map entry. A signature is the path's write count, not a time. What reads a run folder outside
 * the port — a run's pictures, frames and videos (run-files.ts RunFolder, run-data.ts), the editor's and the review's
 * own reads of a take, the real capture runner's writes, the editor's render (its record and video), the review
 * package's review folder — still goes to the disk (a worker handed these outputs must be handed its own capture
 * runner: jobs/worker-ports.ts). Paths are absolute and compared as
 * written (normalised).
 */
import { dirname, normalize, sep } from 'node:path';
import type { OutputFolder, Outputs, RenderOutputs, RunOutputs } from './outputs.js';
import { outputsOn, sha256Of } from './output-files.js';
import type { OutputFs, OutputStat } from './output-files.js';

type Code = 'ENOENT' | 'ENOTDIR' | 'EEXIST' | 'EISDIR' | 'ENOTEMPTY';

function fsError(code: Code, syscall: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });
}

export class MemoryOutputs implements Outputs {
  readonly #files = new Map<string, Buffer>();
  readonly #folders = new Set<string>();
  /** Per path, how many times it was written or made (its signature). */
  readonly #writes = new Map<string, number>();
  #count = 0;
  readonly runs: RunOutputs;
  readonly renders: RenderOutputs;
  readonly reviews: OutputFolder;
  readonly exports: OutputFolder;
  readonly inspections: OutputFolder;

  constructor() {
    const all = outputsOn(this.#fs());
    this.runs = all.runs;
    this.renders = all.renders;
    this.reviews = all.reviews;
    this.exports = all.exports;
    this.inspections = all.inspections;
  }

  /** Put a file in place (absolute path; its folders exist with it). */
  seed(path: string, data: string | Uint8Array): this {
    this.#put(normalize(path), Buffer.from(data));
    return this;
  }

  /** An empty folder (its parents with it). */
  folder(path: string): this {
    this.#mkdirs(normalize(path));
    return this;
  }

  /** The bytes of a file, or undefined. */
  file(path: string): Buffer | undefined {
    return this.#files.get(normalize(path));
  }

  /** Every file's path, sorted. */
  paths(): string[] {
    return [...this.#files.keys()].sort();
  }

  /** Remove a file, or a folder and everything under it. */
  remove(path: string): this {
    const p = normalize(path);
    const under = p + sep;
    for (const k of [...this.#files.keys()]) if (k === p || k.startsWith(under)) this.#files.delete(k);
    for (const k of [...this.#folders]) if (k === p || k.startsWith(under)) this.#folders.delete(k);
    return this;
  }

  #touch(p: string): void {
    this.#writes.set(p, ++this.#count);
  }

  #mkdirs(p: string): void {
    for (let d = p; !this.#folders.has(d) && d !== dirname(d); d = dirname(d)) {
      this.#folders.add(d);
      this.#touch(d);
    }
  }

  #put(p: string, data: Buffer): void {
    if (this.#isFolder(p)) throw fsError('EISDIR', 'open', p);
    this.#mkdirs(dirname(p));
    this.#files.set(p, data);
    this.#touch(p);
    this.#touch(dirname(p));
  }

  #isFolder(p: string): boolean {
    if (p === sep || this.#folders.has(p)) return true;
    const under = p + sep;
    for (const k of this.#files.keys()) if (k.startsWith(under)) return true;
    return false;
  }

  /** ENOTDIR when a file lies on the way to `p`. */
  #through(p: string, syscall: string): void {
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) if (this.#files.has(d)) throw fsError('ENOTDIR', syscall, p);
  }

  #stat(path: string, syscall: string): OutputStat {
    const p = normalize(path);
    this.#through(p, syscall);
    const data = this.#files.get(p);
    const folder = data === undefined && this.#isFolder(p);
    if (data === undefined && !folder) throw fsError('ENOENT', syscall, p);
    const n = this.#writes.get(p) ?? 0;
    return {
      isFile: () => data !== undefined,
      isDirectory: () => folder,
      isSymbolicLink: () => false,
      size: data?.length ?? 0,
      ino: n,
      mtimeMs: n,
    };
  }

  #fs(): OutputFs {
    return {
      lstat: async (path) => this.#stat(path, 'lstat'),
      stat: async (path) => this.#stat(path, 'stat'),
      readFile: async (path) => {
        const p = normalize(path);
        const data = this.#files.get(p);
        if (data === undefined) throw this.#isFolder(p) ? fsError('EISDIR', 'read', p) : fsError('ENOENT', 'open', p);
        return data.toString('utf8');
      },
      readdir: async (path) => {
        const p = normalize(path);
        if (this.#files.has(p)) throw fsError('ENOTDIR', 'scandir', p);
        if (!this.#isFolder(p)) throw fsError('ENOENT', 'scandir', p);
        const under = p === sep ? sep : p + sep;
        const names = new Map<string, boolean>();
        for (const k of [...this.#files.keys(), ...this.#folders]) {
          if (!k.startsWith(under)) continue;
          const rest = k.slice(under.length);
          const name = rest.split(sep)[0]!;
          const isFile = rest === name && this.#files.has(k);
          names.set(name, (names.get(name) ?? false) || isFile);
        }
        return [...names]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, isFile]) => ({
            name,
            isFile: () => isFile,
            isDirectory: () => !isFile,
          }));
      },
      mkdir: async (path, opts = {}) => {
        const p = normalize(path);
        this.#through(p, 'mkdir');
        if (this.#files.has(p)) throw fsError('EEXIST', 'mkdir', p);
        if (this.#isFolder(p)) {
          if (opts.recursive) return undefined;
          throw fsError('EEXIST', 'mkdir', p);
        }
        if (!opts.recursive && !this.#isFolder(dirname(p))) throw fsError('ENOENT', 'mkdir', p);
        this.#mkdirs(p);
        this.#touch(dirname(p));
        return undefined;
      },
      writeAtomic: async (path, data) => {
        const p = normalize(path);
        this.#through(p, 'open');
        this.#put(p, Buffer.from(data));
      },
      hash: async (path) => {
        const data = this.#files.get(normalize(path));
        if (data === undefined) throw fsError('ENOENT', 'open', path);
        return sha256Of(data);
      },
      names: async (path) => {
        const p = normalize(path);
        if (this.#files.has(p)) throw fsError('ENOTDIR', 'scandir', p);
        if (!this.#isFolder(p)) throw fsError('ENOENT', 'scandir', p);
        const under = p === sep ? sep : p + sep;
        const names = new Set<string>();
        for (const k of [...this.#files.keys(), ...this.#folders]) if (k.startsWith(under)) names.add(k.slice(under.length).split(sep)[0]!);
        return [...names].sort();
      },
      text: async (path, o) => {
        const p = normalize(path);
        const data = this.#files.get(p);
        if (data === undefined)
          return {
            ok: false,
            problem: this.#isFolder(p) ? 'not-a-file' : 'missing',
            link: false,
          };
        if (data.length > o.max) return { ok: false, problem: 'too-big', link: false };
        return { ok: true, text: data.toString('utf8'), link: false };
      },
      remove: async (path) => {
        this.remove(path);
      },
      rmdir: async (path) => {
        const p = normalize(path);
        if (this.#files.has(p)) throw fsError('ENOTDIR', 'rmdir', p);
        if (!this.#isFolder(p)) throw fsError('ENOENT', 'rmdir', p);
        const under = p + sep;
        if ([...this.#files.keys(), ...this.#folders].some((k) => k.startsWith(under))) throw fsError('ENOTEMPTY', 'rmdir', p);
        this.#folders.delete(p);
        this.#touch(dirname(p));
      },
      realpath: async (path) => {
        const p = normalize(path);
        this.#stat(p, 'realpath');
        return p;
      },
    };
  }
}
