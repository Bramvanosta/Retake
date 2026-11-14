/**
 * A WorkspaceDisk in memory (core file-facts.ts): the disk the engine's MemoryWorkspace hands core's loaders. It answers
 * as node:fs does — its errors carry node's code, errno, syscall and words (fsError), so a loader that branches on
 * ENOENT branches alike — and decides a plain-file read by the same rule (plainFileVerdict). Here in core io because
 * an errno is the machine's (os.constants).
 */
import { constants } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { plainFileVerdict } from '../file-facts.js';
import type { DiskEntryKind, FileKind, WorkFileFacts, WorkspaceDisk } from '../file-facts.js';
import { MediaProbeError } from '../media.js';
import type { VideoProbe } from '../media.js';

/** The codes the memory disk answers with, as node:fs does. */
export type FsCode = 'ENOENT' | 'EISDIR' | 'ENOTDIR' | 'ELOOP';

const WORDS: Record<FsCode, string> = {
  ENOENT: 'no such file or directory',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  ELOOP: 'too many symbolic links encountered',
};

/** The error node:fs gives for `code` (its message, code, errno and syscall), for a disk that is not node's to answer alike. */
export function fsError(code: FsCode, syscall: 'open' | 'read' | 'scandir', path: string): NodeJS.ErrnoException {
  // node names no path for a read of a folder (EISDIR, syscall read).
  const message = syscall === 'read' ? `${code}: ${WORDS[code]}, read` : `${code}: ${WORDS[code]}, ${syscall} '${path}'`;
  return Object.assign(new Error(message), { code, errno: -constants.errno[code], syscall, ...(syscall === 'read' ? {} : { path }) });
}

/** How many symbolic links one lookup follows before ELOOP (the kernel's MAXSYMLINKS on macOS and Linux's default 40 alike: a loop fails either way). */
const MAX_LINKS = 32;

/** The maps a memoryDisk answers from; read live (a store writing into `files` is read back). */
export interface MemoryDiskSources {
  /** Absolute path → bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Absolute path → a symbolic link's target (relative to its folder, or absolute). */
  readonly links?: ReadonlyMap<string, string>;
  /** Folders that hold nothing (a folder above any file, link or folder exists without being listed). */
  readonly folders?: ReadonlySet<string>;
  /** What probeVideo answers for a file (else MediaProbeError `unreadable`, as memoryFileFacts). */
  readonly videos?: ReadonlyMap<string, VideoProbe>;
}

type Walk = { at: string } | { code: 'ENOENT' | 'ENOTDIR' | 'ELOOP' };

/**
 * A WorkspaceDisk (and its WorkFileFacts) answering from maps (tests: the engine's MemoryWorkspace). Links are followed
 * as the disk does — each segment in turn, ELOOP past MAX_LINKS — but by readPlain's last segment and list's entries; a
 * path through a file is ENOTDIR, through nothing ENOENT; case counts; nothing is executable; no file is special
 * (`other`).
 */
export function memoryDisk(src: MemoryDiskSources): WorkspaceDisk & { readonly facts: WorkFileFacts } {
  const links = src.links ?? new Map<string, string>();
  const folders = src.folders ?? new Set<string>();
  const isFolder = (p: string): boolean => {
    if (p === sep || folders.has(p)) return true;
    const under = p + sep;
    for (const m of [src.files.keys(), links.keys(), folders.values()]) for (const k of m) if (k.startsWith(under)) return true;
    return false;
  };
  const exists = (p: string): boolean => src.files.has(p) || isFolder(p);
  /** The real path of `p` (every link followed), or why there is none, in node's code; `seen` counts the links of one lookup. */
  const walk = (p: string, seen = { links: 0 }): Walk => {
    let at: string = sep;
    for (const part of resolve(p).split(sep).filter(Boolean)) {
      // A segment below a file: the file is no folder.
      if (src.files.has(at)) return { code: 'ENOTDIR' };
      at = join(at, part);
      const to = links.get(at);
      if (to !== undefined) {
        if (++seen.links > MAX_LINKS) return { code: 'ELOOP' };
        const real = walk(resolve(dirname(at), to), seen);
        if ('code' in real) return real;
        at = real.at;
      }
    }
    return exists(at) ? { at } : { code: 'ENOENT' };
  };
  const follow = (p: string): string | undefined => {
    const w = walk(p);
    return 'at' in w ? w.at : undefined;
  };
  /** `p` with its folder's links followed and its last segment not: the entry itself, or why its folder is not there. */
  const own = (p: string): { at: string; kind: DiskEntryKind } | { code: 'ENOENT' | 'ENOTDIR' | 'ELOOP' } => {
    const abs = resolve(p);
    if (abs === sep) return { at: sep, kind: 'directory' };
    const parent = walk(dirname(abs));
    if ('code' in parent) return parent;
    if (src.files.has(parent.at)) return { code: 'ENOTDIR' };
    const at = join(parent.at, basename(abs));
    if (links.has(at)) return { at, kind: 'link' };
    if (src.files.has(at)) return { at, kind: 'file' };
    return isFolder(at) ? { at, kind: 'directory' } : { code: 'ENOENT' };
  };
  const bytesAt = (p: string): Buffer => {
    const w = walk(p);
    if ('code' in w) throw fsError(w.code, 'open', p);
    const b = src.files.get(w.at);
    if (b === undefined) throw fsError('EISDIR', 'read', p);
    return Buffer.from(b);
  };
  const kind = (p: string): FileKind | undefined => {
    const at = follow(p);
    return at === undefined ? undefined : src.files.has(at) ? 'file' : 'directory';
  };
  const facts: WorkFileFacts = {
    kind,
    realpath: (p) => follow(p),
    nativeRealpath: (p) => follow(p),
    readText: (p) => bytesAt(p).toString('utf8'),
    readHead(p, n) {
      const at = follow(p);
      const b = at === undefined ? undefined : src.files.get(at);
      return b === undefined ? Buffer.alloc(0) : Buffer.from(b).subarray(0, n);
    },
    isExecutable: () => false,
    ignoresCase: false,
    probeVideo(file) {
      const v = src.videos?.get(resolve(file));
      if (!v) throw new MediaProbeError(`${file} not found`, 'unreadable');
      return v;
    },
  };
  return {
    facts,
    readFile: async (file) => bytesAt(file),
    async list(dir) {
      const w = walk(dir);
      if ('code' in w) throw fsError(w.code, 'scandir', dir);
      if (src.files.has(w.at)) throw fsError('ENOTDIR', 'scandir', dir);
      const under = w.at === sep ? sep : w.at + sep;
      const names = new Set<string>();
      for (const m of [src.files.keys(), links.keys(), folders.values()]) for (const k of m) if (k.startsWith(under) && k.length > under.length) names.add(k.slice(under.length).split(sep)[0]);
      return [...names].sort().map((name) => {
        const e = own(join(w.at, name));
        return { name, kind: 'kind' in e ? e.kind : 'other' };
      });
    },
    readPlain(file, max) {
      const e = own(file);
      // As readPlainFile maps open's errors: a loop is a link (ELOOP), a path through a file or nothing is missing.
      if ('code' in e) return { ok: false, reason: e.code === 'ELOOP' ? 'link' : 'missing' };
      if (e.kind === 'link') return { ok: false, reason: 'link' };
      const b = src.files.get(e.at);
      const why = plainFileVerdict({ isFile: b !== undefined, size: b?.byteLength ?? 0 }, max);
      if (why) return why === 'too_large' ? { ok: false, reason: why, size: b!.byteLength } : { ok: false, reason: why };
      return { ok: true, bytes: Buffer.from(b!) };
    },
  };
}
