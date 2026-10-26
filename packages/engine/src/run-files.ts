/**
 * A run's files as the Studio's scenario screen reads them (L4.2, critique B6): run.json, timeline.json, the scenario
 * snapshot, frame indexes, frames, screenshots and videos are data a person, an agent or a filmed site's text may have
 * shaped — never paths to follow.
 *
 * - The run folder is `runs/<id>` of the project, a real folder (not a link) whose real path lies inside the project's.
 * - A file is named by the caller from fixed parts (validated names only: frame names `^\d{6}\.(jpe?g|png)$`, track
 *   files `^capture-…\.mp4$` / `^frames-…\.jsonl$`, screenshot names rebuilt from scene ids — never a path a run file
 *   recorded), at most one folder deep; that folder is a real folder (not a link) inside the run; the file is read with
 *   core readPlainFile (no link followed, no FIFO held, size capped on the open descriptor).
 * - Every file is checked once open (review A #7): the run folder, the runs folder and the file's folder are still the
 *   real folders the reader resolved (same inode, not a link) and the name still names the file opened — a folder
 *   swapped for a link between the check and the open is refused.
 * - A video goes to ffmpeg as open descriptors, never as a path (review A #7): opened here without following a link,
 *   checked the same way, read by ffmpeg through its `fd` protocol only (review videoFramesAt).
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { readPlainFile } from '@demo-studio/core';
import type { PlainFileProblem, PlainFileRead } from '@demo-studio/core';
import { RUN_ID_RE } from './refs.js';

/** A frame's file name in a frame index (the recorder writes `NNNNNN.jpg` / `.png`). */
export const RUN_FRAME_NAME_RE = /^\d{6}\.(jpe?g|png)$/;
/** A page track's video (`capture-<page>.mp4`). */
export const TRACK_VIDEO_RE = /^capture-[A-Za-z0-9._-]+\.mp4$/;
/** A page track's frame index (`frames-<page>.jsonl`; its frames are in the folder of the same name without .jsonl). */
export const TRACK_FRAMES_RE = /^frames-[A-Za-z0-9._-]+\.jsonl$/;
/** A file name the run folder reader accepts as one path segment. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type RunFileProblem = PlainFileProblem | 'outside' | 'bad_name';
export type RunFileRead = PlainFileRead | { ok: false; reason: 'outside' | 'bad_name' };

/** lstat signature of a path (`-` when missing): what tells a cached read it is stale. */
export async function lsig(path: string): Promise<string> {
  try {
    const s = await lstat(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

function inside(real: string, root: string): boolean {
  return real === root || real.startsWith(root + sep);
}

/** A folder as resolved: its real path and inode. */
interface Held {
  path: string;
  ino: number;
  dev: number;
}

/** Whether every held folder is still that folder (a real folder, same inode) and `file` still names `st`. */
function stillThere(held: readonly Held[], file: string, st: Stats): boolean {
  try {
    for (const h of held) {
      const d = lstatSync(h.path);
      if (d.isSymbolicLink() || !d.isDirectory() || d.ino !== h.ino || d.dev !== h.dev) return false;
    }
    const l = lstatSync(file);
    return !l.isSymbolicLink() && l.ino === st.ino && l.dev === st.dev;
  } catch {
    return false;
  }
}

/** A ranged read of a growing file (readPlainRange): the bytes from `offset` and the file's size when opened. */
export type RangeRead = { ok: true; bytes: Buffer; size: number } | { ok: false; reason: PlainFileProblem };

/**
 * At most `max` bytes of `file` from `offset` (L4.4: the Studio tails a run's log.jsonl and a job's events.jsonl as
 * they grow) — the same rules as core readPlainFile: opened without following a link and without blocking, a regular
 * file checked on the open descriptor (`verify` sees its stat first: false refuses it as `link`). An offset past the
 * end reads nothing (the caller compares `size`). Never throws.
 */
export function readPlainRange(file: string, offset: number, max: number, o: { verify?: (st: Stats) => boolean } = {}): RangeRead {
  let fd: number | undefined;
  try {
    try {
      fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
      if (code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE') return { ok: false, reason: 'link' };
      if (code === 'EISDIR') return { ok: false, reason: 'not_file' };
      return { ok: false, reason: 'unreadable' };
    }
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not_file' };
    if (o.verify && !o.verify(st)) return { ok: false, reason: 'link' };
    const want = Math.max(0, Math.min(max, st.size - offset));
    const buf = Buffer.allocUnsafe(want);
    let n = 0;
    while (n < want) {
      const r = readSync(fd, buf, n, want - n, offset + n);
      if (r === 0) break;
      n += r;
    }
    return { ok: true, bytes: buf.subarray(0, n), size: st.size };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One run folder of a project, opened safely (RunFolder.open). */
export class RunFolder {
  private constructor(
    readonly id: string,
    /** The run folder's real path. */
    readonly dir: string,
    /** The runs folder and the run folder as resolved (checked again once a file is open). */
    private readonly held: readonly Held[],
  ) {}

  /** `runs/<id>` of the project when it is a real folder inside the project; null otherwise (missing, a link, outside). */
  static async open(projectDir: string, id: string): Promise<RunFolder | null> {
    if (!RUN_ID_RE.test(id) || id.length > 200) return null;
    const path = join(projectDir, 'runs', id);
    try {
      const st = await lstat(path);
      if (!st.isDirectory()) return null;
      const [root, real] = await Promise.all([realpath(join(projectDir, 'runs')), realpath(path)]);
      const project = await realpath(projectDir);
      if (!inside(root, project) || !inside(real, root) || real === root) return null;
      const [rs, ds] = await Promise.all([lstat(root), lstat(real)]);
      return new RunFolder(id, real, [
        { path: root, ino: rs.ino, dev: rs.dev },
        { path: real, ino: ds.ino, dev: ds.dev },
      ]);
    } catch {
      return null;
    }
  }

  /** The real folder `name` of the run (one segment), or why not: missing, a link, not a folder, outside. */
  async folder(name: string): Promise<{ ok: true; path: string; ino: number; dev: number } | { ok: false; reason: RunFileProblem }> {
    if (!SEGMENT_RE.test(name)) return { ok: false, reason: 'bad_name' };
    const path = join(this.dir, name);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) return { ok: false, reason: 'link' };
      if (!st.isDirectory()) return { ok: false, reason: 'not_file' };
      const real = await realpath(path);
      if (!inside(real, this.dir) || real === this.dir) return { ok: false, reason: 'outside' };
      return { ok: true, path: real, ino: st.ino, dev: st.dev };
    } catch {
      return { ok: false, reason: 'missing' };
    }
  }

  /** `rel` = "<file>" or "<folder>/<file>" (segments validated), read whole when at most `max` bytes. */
  async read(rel: string, max: number): Promise<RunFileRead> {
    const parts = rel.split('/');
    if (parts.length > 2 || !parts.every((p) => SEGMENT_RE.test(p))) return { ok: false, reason: 'bad_name' };
    let dir = this.dir;
    const held = [...this.held];
    if (parts.length === 2) {
      const f = await this.folder(parts[0]);
      if (!f.ok) return f.reason === 'missing' ? { ok: false, reason: 'missing' } : { ok: false, reason: f.reason === 'link' ? 'link' : 'outside' };
      dir = f.path;
      held.push({ path: f.path, ino: f.ino, dev: f.dev });
    }
    const file = join(dir, parts[parts.length - 1]);
    return readPlainFile(file, max, { verify: (st) => stillThere(held, file, st) });
  }

  /** At most `max` bytes of a file of the run folder itself (one segment) from `offset`, checked once open (L4.4). */
  readRange(name: string, offset: number, max: number): RangeRead | { ok: false; reason: 'bad_name' } {
    if (!SEGMENT_RE.test(name)) return { ok: false, reason: 'bad_name' };
    const file = join(this.dir, name);
    return readPlainRange(file, offset, max, { verify: (st) => stillThere(this.held, file, st) });
  }

  /** The names in a folder of the run (one segment; a real folder inside the run), or null. */
  async list(name: string): Promise<string[] | null> {
    const f = await this.folder(name);
    if (!f.ok) return null;
    try {
      return await readdir(f.path);
    } catch {
      return null;
    }
  }

  /** The names in the run folder itself ([] when it cannot be read). */
  async names(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch {
      return [];
    }
  }

  /** Whether a video of the run (one segment) is there as ffmpeg may read it: a regular file, not a link, inside the run. */
  async video(name: string): Promise<{ ok: true; path: string; sig: string } | { ok: false; reason: RunFileProblem }> {
    if (!SEGMENT_RE.test(name) || !name.endsWith('.mp4')) return { ok: false, reason: 'bad_name' };
    const path = join(this.dir, name);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) return { ok: false, reason: 'link' };
      if (!st.isFile()) return { ok: false, reason: 'not_file' };
      const real = await realpath(path);
      if (!inside(real, this.dir) || real === this.dir) return { ok: false, reason: 'outside' };
      return { ok: true, path: real, sig: `${st.ino}:${st.size}:${st.mtimeMs}` };
    } catch {
      return { ok: false, reason: 'missing' };
    }
  }

  /**
   * A video of the run (one segment) opened `count` times for ffmpeg (one descriptor per input: each keeps its own
   * offset): not through a link, a regular file, checked once open (stillThere). The caller closes them.
   */
  openVideo(name: string, count: number): { ok: true; fds: number[] } | { ok: false; reason: RunFileProblem } {
    if (!SEGMENT_RE.test(name) || !name.endsWith('.mp4')) return { ok: false, reason: 'bad_name' };
    const file = join(this.dir, name);
    const fds: number[] = [];
    const fail = (reason: RunFileProblem) => {
      for (const fd of fds) closeSync(fd);
      return { ok: false as const, reason };
    };
    let first: Stats | undefined;
    try {
      for (let i = 0; i < count; i++) {
        const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        fds.push(fd);
        const st = fstatSync(fd);
        if (!st.isFile()) return fail('not_file');
        if (first && (st.ino !== first.ino || st.dev !== first.dev)) return fail('link');
        first ??= st;
        if (!stillThere(this.held, file, st)) return fail('link');
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return fail(code === 'ENOENT' ? 'missing' : code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE' ? 'link' : 'unreadable');
    }
    return { ok: true, fds };
  }

  /** lstat signature of a path of the run (`rel` as for read; no validation: a signature reads nothing). */
  sig(rel: string): Promise<string> {
    return lsig(join(this.dir, rel));
  }
}
