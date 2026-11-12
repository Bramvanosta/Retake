/**
 * The ports through which core's pure rules learn what they need from the machine. FileFacts: the disk — what is at a
 * path a scenario, a project, a theme or a sandbox names, its real path, its text or first bytes, whether it is a
 * program, whether the file system ignores case. VideoProber: what a video file holds (ffprobe, which runs under a
 * work's policy). Core declares them; `@retake/core/io` gives the Node implementations — nodeFileFacts (the disk only)
 * and fileFacts(policy) (WorkFileFacts: the disk and the work's VideoProber) — and every caller that checks files on the
 * disk passes one in; memoryFileFacts answers both from a table (tests). A rule that needs the disk, or a video probed,
 * and is given no such port throws (FileFactsMissingError): it never reads as "no file there".
 */
import { dirname, resolve } from 'node:path';
import type { VideoProbe } from './media.js';
import { MediaProbeError } from './media.js';

/** What `FileFacts.kind` sees at a path (links followed). */
export type FileKind = 'file' | 'directory' | 'other';

export interface FileFacts {
  /** What is at `p`, links followed; undefined when nothing is there (a broken link included) or it cannot be read. */
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
  /**
   * Whether the file system ignores case by default (macOS, Windows): a path that does not exist (yet) is compared
   * without case there (core client-path.ts isUnder).
   */
  readonly ignoresCase: boolean;
}

/** The port that says what a video file holds: ffprobe's answer, under the policy of the work that asks. */
export interface VideoProber {
  /** What ffprobe says of a video file: MediaProbeError when it cannot say (`no-ffprobe`, `unreadable`, `no-video`). */
  probeVideo(file: string): VideoProbe;
}

/** The ports of a work's checks: the disk and the work's VideoProber (`@retake/core/io` fileFacts(policy)). */
export type WorkFileFacts = FileFacts & VideoProber;

/**
 * The FileFacts a check is given, with the VideoProber of its work when it may look into a video file (WorkFileFacts;
 * nodeFileFacts is the disk only: a video check given it throws FileFactsMissingError).
 */
export type CheckFiles = FileFacts & Partial<VideoProber>;

/**
 * Options whose `files` is required as soon as one of `At` is given (finding D8, L7.34): the members that make a rule
 * look at the disk (a file, a folder, a project) come with the port that answers it — a caller that names a place and
 * no FileFacts is refused by the type checker, not at run time. Without any of them, `files` may be left out (a rule
 * that reads nothing: a text parsed on its own).
 */
export type FilesWith<At extends PropertyKey, F extends FileFacts = FileFacts> = ({ [K in At]?: undefined } & { files?: F }) | { files: F };

/** A rule that needs the disk (or a video probed) was given no FileFacts (no VideoProber): a caller's mistake, never a missing file. */
export class FileFactsMissingError extends Error {
  constructor(what: string, port: 'FileFacts' | 'VideoProber' = 'FileFacts') {
    super(
      port === 'VideoProber'
        ? `${what} needs a VideoProber (core file-facts.ts) to probe a video: pass fileFacts(policy) of @retake/core/io`
        : `${what} needs a FileFacts (core file-facts.ts) to look at the disk: pass nodeFileFacts or fileFacts(policy) of @retake/core/io`,
    );
    this.name = 'FileFactsMissingError';
  }
}

/** `files`, or the refusal of a rule that needs the disk without one. */
export function needFiles<F extends FileFacts>(files: F | undefined, what: string): F {
  if (!files) throw new FileFactsMissingError(what);
  return files;
}

/** The VideoProber `files` carries, or the refusal (FileFactsMissingError) of a check that must probe a video without one. */
export function needProber(files: CheckFiles, what: string): VideoProber {
  if (typeof files.probeVideo !== 'function') throw new FileFactsMissingError(what, 'VideoProber');
  return files as WorkFileFacts;
}

/**
 * FileFacts and a VideoProber answering from a table (tests): `entries` maps absolute paths to a file's text, `null` for
 * a folder, or `{ link: target }` for a symbolic link (followed by every answer). Folders above every entry exist.
 * Nothing is executable unless listed in `executables`; `probeVideo` answers `videos[file]`, else MediaProbeError
 * `unreadable`; case counts unless `ignoresCase`.
 */
export function memoryFileFacts(
  entries: Readonly<Record<string, string | null | { link: string }>>,
  o: { executables?: readonly string[]; videos?: Readonly<Record<string, VideoProbe>>; ignoresCase?: boolean } = {},
): WorkFileFacts {
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
    ignoresCase: o.ignoresCase ?? false,
    probeVideo(file) {
      const v = o.videos?.[resolve(file)];
      if (!v) throw new MediaProbeError(`${file} not found`, 'unreadable');
      return v;
    },
  };
}
