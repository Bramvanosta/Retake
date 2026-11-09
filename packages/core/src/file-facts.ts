/**
 * FileFacts: the port through which core's pure rules learn what they need from the disk — whether a file a scenario,
 * a project, a theme or a sandbox names is there, what it is, its real path, its text or first bytes, whether it is a
 * program, what a video file holds. Core declares it; `@retake/core/io` gives the Node implementation (`nodeFileFacts`,
 * `fileFacts(policy)`), and every caller that checks files on the disk passes one in. `memoryFileFacts` answers from a
 * table (tests). A rule that needs the disk and is given no FileFacts throws (FileFactsMissingError): it never reads as
 * "no file there".
 */
import { dirname, resolve } from 'node:path';
import type { VideoProbe } from './media.js';
import { MediaProbeError } from './media.js';

/** What `FileFacts.kind` sees at a path (links followed). */
export type FileKind = 'file' | 'directory' | 'other';

export interface FileFacts {
  /** Whether anything is at `p`, links followed (a broken link: no) — node's existsSync. */
  exists(p: string): boolean;
  /** What is at `p`, links followed; undefined when nothing can be read there. */
  kind(p: string): FileKind | undefined;
  /** The real path of `p` (links followed, the case as given — node's realpathSync); undefined when it cannot be resolved. */
  realpath(p: string): string | undefined;
  /** The real path of `p` with the case of each name as the file system keeps it (realpathSync.native); undefined when it cannot be resolved. */
  nativeRealpath(p: string): string | undefined;
  /** A file's text (UTF-8); throws, as node's readFileSync does, when it cannot be read. */
  readText(p: string): string;
  /** A file's first `n` bytes (fewer at its end); empty when it cannot be read. */
  readHead(p: string, n: number): Buffer;
  /** Whether `p` is a regular file this process may run (links followed). */
  isExecutable(p: string): boolean;
  /** What ffprobe says of a video file: MediaProbeError when it cannot say (`no-ffprobe`, `unreadable`, `no-video`). */
  probeVideo(file: string): VideoProbe;
}

/** A rule that needs the disk was given no FileFacts: a caller's mistake, never a missing file. */
export class FileFactsMissingError extends Error {
  constructor(what: string) {
    super(`${what} needs a FileFacts (core file-facts.ts) to look at the disk: pass nodeFileFacts or fileFacts(policy) of @retake/core/io`);
    this.name = 'FileFactsMissingError';
  }
}

/** `files`, or the refusal of a rule that needs the disk without one. */
export function needFiles(files: FileFacts | undefined, what: string): FileFacts {
  if (!files) throw new FileFactsMissingError(what);
  return files;
}

/**
 * FileFacts answering from a table (tests): `entries` maps absolute paths to a file's text, `null` for a folder, or
 * `{ link: target }` for a symbolic link (followed by every answer). Folders above every entry exist. Nothing is
 * executable unless listed in `executables`; `probeVideo` answers `videos[file]`, else MediaProbeError `unreadable`.
 */
export function memoryFileFacts(
  entries: Readonly<Record<string, string | null | { link: string }>>,
  o: { executables?: readonly string[]; videos?: Readonly<Record<string, VideoProbe>> } = {},
): FileFacts {
  const table = new Map(Object.entries(entries).map(([k, v]) => [resolve(k), v]));
  const folders = new Set<string>();
  for (const k of table.keys()) for (let d = dirname(k); d !== dirname(d); d = dirname(d)) folders.add(d);
  folders.add('/');
  const follow = (p: string, seen = 0): string | undefined => {
    let abs = resolve(p);
    // Each part of the path in turn, so a link in a folder's place leads where it points.
    const parts = abs.split('/').filter(Boolean);
    abs = '/';
    for (const part of parts) {
      abs = resolve(abs, part);
      const v = table.get(abs);
      if (v && typeof v === 'object') {
        if (seen > 32) return undefined;
        const to = follow(resolve(dirname(abs), v.link), seen + 1);
        if (to === undefined) return undefined;
        abs = to;
      }
    }
    return table.has(abs) || folders.has(abs) ? abs : undefined;
  };
  const kind = (p: string): FileKind | undefined => {
    const at = follow(p);
    if (at === undefined) return undefined;
    const v = table.get(at);
    return typeof v === 'string' ? 'file' : 'directory';
  };
  return {
    exists: (p) => follow(p) !== undefined,
    kind,
    realpath: (p) => follow(p),
    nativeRealpath: (p) => follow(p),
    readText(p) {
      const at = follow(p);
      const v = at === undefined ? undefined : table.get(at);
      if (typeof v !== 'string') throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
      return v;
    },
    readHead(p, n) {
      const at = follow(p);
      const v = at === undefined ? undefined : table.get(at);
      return typeof v === 'string' ? Buffer.from(v, 'utf8').subarray(0, n) : Buffer.alloc(0);
    },
    isExecutable: (p) => kind(p) === 'file' && (o.executables ?? []).some((e) => follow(e) === follow(p)),
    probeVideo(file) {
      const v = o.videos?.[resolve(file)];
      if (!v) throw new MediaProbeError(`${file} not found`, 'unreadable');
      return v;
    },
  };
}
