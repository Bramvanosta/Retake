/**
 * One JSON file of a project read as text, or a typed problem — never a throw. The seam the readers of records take
 * their file system from (a test hands its own; `@retake/core/io` exports the types and the Node implementation, which
 * the reader of renders/ re-exports). Not in an index on purpose: the reader of renders/ is its caller.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { readPlainFile } from './plain-file.js';

export type RecordFileText = { ok: true; text: string; link: boolean } | { ok: false; problem: 'missing' | 'unreadable' | 'too-big' | 'not-a-file'; link: boolean };

export interface RecordFs {
  /** The names of a folder's entries (it may throw: a missing folder). */
  names(dir: string): Promise<string[]>;
  /**
   * A file's text. `follow: false`: opened without following a symbolic link and judged on the open descriptor (no
   * window between the test and the read) — a link is `not-a-file`, `link: true`. `follow: true`: read through a
   * link; `link` then says the entry was one. More than `max` bytes: `too-big`. Never blocks (a pipe, a device).
   */
  text(file: string, o: { max: number; follow: boolean }): Promise<RecordFileText>;
  /**
   * What the file system opens for `file` (links followed), as an identity two paths can be compared by — null when
   * nothing is there. How a name another file of a folder answers to is found as the file system compares names
   * (case, Unicode normalisation). Without it (a file system of a test's), names are compared as texts after Unicode
   * normalisation only.
   */
  identity?(file: string): Promise<string | null>;
}

const gone = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException | null)?.code ?? '');

/** node:fs. Not followed: core/io readPlainFile (O_NOFOLLOW, O_NONBLOCK, fstat on the descriptor, at most max + 1 bytes). */
export const NODE_RECORD_FS: RecordFs = {
  names: (dir) => readdir(dir),
  async text(file, o) {
    if (!o.follow) {
      const r = readPlainFile(file, o.max);
      if (r.ok) return { ok: true, text: r.bytes.toString('utf8'), link: false };
      if (r.reason === 'link') return { ok: false, problem: 'not-a-file', link: true };
      return { ok: false, problem: r.reason === 'missing' ? 'missing' : r.reason === 'not_file' ? 'not-a-file' : r.reason === 'too_large' ? 'too-big' : 'unreadable', link: false };
    }
    let link = false;
    try {
      // For the flag only: what is read is judged on the handle below.
      link = (await lstat(file)).isSymbolicLink();
    } catch (e) {
      return { ok: false, problem: gone(e) ? 'missing' : 'unreadable', link };
    }
    let handle;
    try {
      // O_NONBLOCK: a FIFO with no writer, a device, never hold the reader (it is then no file).
      handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch (e) {
      return { ok: false, problem: gone(e) ? 'missing' : 'unreadable', link };
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) return { ok: false, problem: 'not-a-file', link };
      if (st.size > o.max) return { ok: false, problem: 'too-big', link };
      return { ok: true, text: await handle.readFile('utf8'), link };
    } catch {
      return { ok: false, problem: 'unreadable', link };
    } finally {
      await handle.close().catch(() => undefined);
    }
  },
  async identity(file) {
    try {
      const st = await stat(file, { bigint: true });
      return `${st.dev}:${st.ino}`;
    } catch {
      return null;
    }
  },
};
