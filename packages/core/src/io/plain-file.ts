import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import type { Stats } from 'node:fs';

/** Why `readPlainFile` read nothing. */
export type PlainFileProblem = 'missing' | 'link' | 'not_file' | 'too_large' | 'unreadable';

export type PlainFileRead = { ok: true; bytes: Buffer } | { ok: false; reason: PlainFileProblem; size?: number; error?: string };

/**
 * A small regular file read whole — the one reader of the files a person or an agent may have replaced by something
 * else (L3.8, L4.2): opened without following a symbolic link (`O_NOFOLLOW`) and without blocking (`O_NONBLOCK`: a
 * FIFO with no writer, a device, never hold the reader), then checked on the open descriptor — a regular file of at
 * most `max` bytes — so nothing can be swapped between the check and the read. At most `max + 1` bytes are ever read
 * (a file that grows meanwhile is refused as too large). Never throws.
 *
 * `verify` (optional) sees the open descriptor's stat before anything is read: false refuses the file as `link` — the
 * caller's check that the file opened is still the one its folder names (O_NOFOLLOW guards the last path segment
 * only: a folder swapped for a link between a check and the open is caught there, review A #7).
 */
export function readPlainFile(file: string, max: number, o: { verify?: (st: Stats) => boolean } = {}): PlainFileRead {
  let fd: number | undefined;
  try {
    try {
      fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
      // O_NOFOLLOW on a link: ELOOP (macOS, Linux), EMLINK (FreeBSD), EFTYPE (some BSDs).
      if (code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE') return { ok: false, reason: 'link' };
      if (code === 'EISDIR') return { ok: false, reason: 'not_file' };
      return { ok: false, reason: 'unreadable', error: code ?? String(e) };
    }
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not_file' };
    if (o.verify && !o.verify(st)) return { ok: false, reason: 'link' };
    if (st.size > max) return { ok: false, reason: 'too_large', size: st.size };
    let buf = Buffer.allocUnsafe(Math.min(max, st.size) + 1);
    let n = 0;
    for (;;) {
      if (n === buf.length) {
        if (n > max) break;
        const next = Buffer.allocUnsafe(Math.min(max + 1, buf.length * 2));
        buf.copy(next, 0, 0, n);
        buf = next;
      }
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > max) return { ok: false, reason: 'too_large', size: n };
    return { ok: true, bytes: buf.subarray(0, n) };
  } catch (e) {
    return { ok: false, reason: 'unreadable', error: (e as NodeJS.ErrnoException).code ?? String(e) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
