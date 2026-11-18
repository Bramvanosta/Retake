/**
 * What the Tools' installer reads of an archive before it lets anything extract it, and what it requires of the tree an
 * extraction left (the decisions' "Extraction" rule). The archive's sha256 is checked before this runs, so an
 * archive here is the publisher's: these rules are defence in depth against an extractor's own behaviour (ditto
 * confines `../` but aborts half-way on a file below a link), never the only check.
 *
 * - **The listing** (`zipListing`: the zip's central directory, read here; `tgzListing`: the tar headers of the
 *   gunzipped stream, read here) is refused when an entry is absolute, holds a `..` segment, a backslash or a control
 *   character, lies below an entry that is a link (a link-then-file), is of another kind than a file, a folder or a link,
 *   or carries a setuid / setgid bit; and, for a tgz with a `root`, when an entry lies outside that folder.
 * - **The tree** (`treeProblem`) is refused when an entry is not a file, a folder or a link (a device, a fifo, a socket),
 *   has a setuid / setgid bit, or is a link whose target is absolute or leads out of the tree.
 *
 * No program runs here: the listings are parsed from the bytes, the tree read with lstat.
 */
import { closeSync, createReadStream, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

/** One entry of an archive's listing: its name as stored, its kind and its unix mode bits (permissions and setuid). */
export interface ArchiveEntry {
  name: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  mode: number;
}

/** An archive or a tree the installer refuses (one sentence, the entry named). */
export class ArchiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveRefused';
  }
}

const S_IFMT = 0o170000;
/** The file kinds of a unix mode's type bits (S_IFREG, S_IFDIR, S_IFLNK). */
const KIND_OF_MODE: Record<number, ArchiveEntry['kind']> = { 32768: 'file', 16384: 'dir', 40960: 'link' };

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return b.subarray(0, got);
}

/** Where the central directory starts and how many entries it holds (the end record, ZIP64's when the zip has one). */
function centralDirectory(fd: number, size: number): { offset: number; count: number } {
  const tail = readAt(fd, Math.max(0, size - 65_557), Math.min(size, 65_557));
  const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0 || at + 22 > tail.length) throw new ArchiveRefused('the zip has no end of central directory record');
  let count = tail.readUInt16LE(at + 10);
  let offset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), at);
    if (locator < 0) throw new ArchiveRefused('the zip is a ZIP64 one without its locator');
    const end64 = Number(tail.readBigUInt64LE(locator + 8));
    const rec = readAt(fd, end64, 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new ArchiveRefused('the zip has no ZIP64 end of central directory record');
    count = Number(rec.readBigUInt64LE(32));
    offset = Number(rec.readBigUInt64LE(48));
  }
  return { offset, count };
}

/**
 * The entries of a zip, from its central directory (what an extractor reads): each name, and its kind and mode from the
 * unix attributes (an entry made elsewhere without them: a folder when its name ends in `/`, else a file).
 */
export function zipListing(file: string): ArchiveEntry[] {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const { offset, count } = centralDirectory(fd, size);
    const out: ArchiveEntry[] = [];
    let pos = offset;
    for (let i = 0; i < count; i++) {
      const h = readAt(fd, pos, 46);
      if (h.length < 46 || h.readUInt32LE(0) !== 0x02014b50) throw new ArchiveRefused(`the zip's central directory is damaged at entry ${i + 1}`);
      const nameLen = h.readUInt16LE(28);
      const extraLen = h.readUInt16LE(30);
      const commentLen = h.readUInt16LE(32);
      const madeBy = h.readUInt8(5);
      const attrs = h.readUInt32LE(38) >>> 16;
      const name = readAt(fd, pos + 46, nameLen).toString('utf8');
      const unix = madeBy === 3 && attrs !== 0;
      const kind = unix ? (KIND_OF_MODE[attrs & S_IFMT] ?? 'other') : name.endsWith('/') ? 'dir' : 'file';
      out.push({ name: name.replace(/\/$/, ''), kind, mode: unix ? attrs & 0o7777 : 0o644 });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

const TAR_KIND: Record<string, ArchiveEntry['kind'] | 'meta'> = { '0': 'file', '\0': 'file', '7': 'file', '5': 'dir', '2': 'link', x: 'meta', g: 'meta' };

function tarString(b: Buffer, at: number, len: number): string {
  const s = b.subarray(at, at + len);
  const end = s.indexOf(0);
  return (end < 0 ? s : s.subarray(0, end)).toString('utf8');
}

/** A pax header's `path` (an extended name the next entry takes), if it has one. */
function paxPath(data: Buffer): string | undefined {
  for (const line of data.toString('utf8').split('\n')) {
    const m = /^\d+ path=(.*)$/s.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * The entries of a gzipped tar, from its headers (ustar names with their prefix, pax `path` records; a GNU long name
 * `L` is an entry of kind `other`: refused). Read as a stream: the archive is never held whole.
 */
export async function tgzListing(file: string): Promise<ArchiveEntry[]> {
  const out: ArchiveEntry[] = [];
  let buf = Buffer.alloc(0);
  let skip = 0;
  let pax: { left: number; data: Buffer[] } | undefined;
  let nextName: string | undefined;
  for await (const chunk of createReadStream(file).pipe(createGunzip())) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    for (;;) {
      if (skip > 0) {
        const n = Math.min(skip, buf.length);
        if (pax) pax.data.push(buf.subarray(0, Math.min(n, pax.left)));
        if (pax) pax.left -= Math.min(n, pax.left);
        buf = buf.subarray(n);
        skip -= n;
        if (skip > 0) break;
        if (pax) {
          nextName = paxPath(Buffer.concat(pax.data));
          pax = undefined;
        }
      }
      if (buf.length < 512) break;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every((b) => b === 0)) continue;
      const size = parseInt(tarString(h, 124, 12).trim() || '0', 8);
      const type = String.fromCharCode(h[156]!);
      const prefix = tarString(h, 345, 155);
      const name = nextName ?? (prefix ? `${prefix}/${tarString(h, 0, 100)}` : tarString(h, 0, 100));
      const kind = TAR_KIND[type] ?? 'other';
      skip = Math.ceil(size / 512) * 512;
      if (kind === 'meta') {
        if (type === 'x') pax = { left: size, data: [] };
        continue;
      }
      nextName = undefined;
      out.push({ name: name.replace(/\/$/, ''), kind, mode: parseInt(tarString(h, 100, 8).trim() || '0', 8) & 0o7777 });
    }
  }
  return out;
}

/** Why an entry name may not be extracted (absolute, `..`, a backslash, a control character, empty), or undefined. */
function nameProblem(name: string): string | undefined {
  if (!name || name === '.') return 'an empty name';
  if (isAbsolute(name) || name.startsWith('/')) return 'an absolute path';
  if (name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) return 'a backslash or a control character';
  const parts = name.split('/').filter((p) => p !== '.');
  if (parts.some((p) => p === '..')) return 'a .. segment';
  if (parts.some((p) => p === '')) return 'an empty segment';
  return undefined;
}

/**
 * Refuse a listing (ArchiveRefused naming the entry): a name that is absolute, holds `..`, a backslash or a control
 * character; an entry below one that is a link; an entry that is no file, folder or link; a setuid or setgid bit; for a
 * `root` (a tgz's package folder), an entry outside it.
 */
export function checkListing(entries: readonly ArchiveEntry[], o: { root?: string } = {}): void {
  // The links by the name the disk sees: APFS folds case and Unicode normalisation (`A` and `a`, `café` in NFC and NFD
  // are one path), so a link and an entry below it are compared case-folded and in NFC.
  const links = new Set<string>();
  const key = (p: string) => p.normalize('NFC').toLowerCase();
  for (const e of entries) {
    const what = `the archive's entry ${JSON.stringify(e.name.slice(0, 200))}`;
    const bad = nameProblem(e.name);
    if (bad) throw new ArchiveRefused(`${what} is refused: ${bad}`);
    const parts = e.name.split('/').filter((p) => p !== '.');
    for (let i = 1; i < parts.length; i++)
      if (links.has(key(parts.slice(0, i).join('/')))) throw new ArchiveRefused(`${what} is refused: it lies below a link of the archive (${parts.slice(0, i).join('/')})`);
    if (e.kind === 'other') throw new ArchiveRefused(`${what} is refused: it is not a file, a folder or a link`);
    if (e.mode & 0o6000) throw new ArchiveRefused(`${what} is refused: it carries a setuid or setgid bit`);
    if (o.root && parts[0] !== o.root) throw new ArchiveRefused(`${what} is refused: it lies outside the archive's ${o.root}/ folder`);
    if (e.kind === 'link') links.add(key(parts.join('/')));
  }
}

/** Every path under `dir`, links not followed. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p, out);
  }
  return out;
}

/** The real path of `p` (its links followed), or null when it does not resolve (a link to a name not there). */
function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function inside(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why the extracted tree `dir` may not be installed (one sentence naming the entry), or undefined: an entry that is no
 * file, folder or link (a device, a fifo, a socket), a setuid or setgid bit, a link whose target is absolute or
 * leads out of the tree.
 */
export function treeProblem(dir: string): string | undefined {
  const root = resolve(dir);
  const realRoot = realpathSync(root);
  for (const p of walk(root)) {
    const rel = relative(root, p);
    const st = lstatSync(p);
    if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) return `${rel} is not a file, a folder or a link`;
    if (st.mode & 0o6000) return `${rel} carries a setuid or setgid bit`;
    if (st.isSymbolicLink()) {
      const target = readlinkSync(p);
      if (isAbsolute(target)) return `${rel} is a link to an absolute path (${target.slice(0, 200)})`;
      if (!inside(root, resolve(dirname(p), target))) return `${rel} is a link that leads out of the tree (${target.slice(0, 200)})`;
      // Through the other links too (each one inside lexically, their chain resolved by the system).
      const real = realOrNull(p);
      if (real !== null && !inside(realRoot, real)) return `${rel} is a link that leads out of the tree through another link`;
    }
  }
  return undefined;
}
