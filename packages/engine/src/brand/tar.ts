/**
 * A minimal reader of a gzipped ustar archive (an npm package tarball, fontsource-fetch.ts) that keeps only the entries
 * it is asked for, in memory — nothing is ever written to disk from an archive. No dependency: the format is small.
 *
 * gunzip runs as a stream whose output is counted and cut at `maxUnpacked` and stopped at the end-of-archive block (what
 * follows it is never unpacked); entries are parsed as they arrive, a skipped
 * entry's bytes dropped as they come. Refused (EngineError `refused`, the archive as a whole): a header whose checksum
 * is wrong, a size that is not plain octal (base-256, negative, garbage), a hard or symbolic link (or a GNU long link
 * name), a name that is absolute, has a `..` segment, a backslash or a NUL, a wanted name seen twice, a wanted entry
 * over its cap, more than `maxEntries` entries, a pax header over 64 KB or giving a size, and an archive cut short (no
 * end-of-archive block). The ustar `prefix` field, a pax `path` and a GNU long name (`L`) give the entry's name; a
 * directory, a global pax header and other types are skipped.
 */
import { createGunzip } from 'node:zlib';
import { showHiddenCharsLine } from '@retake/core/base';
import { EngineError } from '../errors.js';

const BLOCK = 512;
const PAX_MAX = 64 * 1024;
const LONG_NAME_MAX = 4096;

export interface TarLimits {
  /** Bytes of the unpacked archive, at most (gunzip's output). */
  maxUnpacked: number;
  /** Entries of the archive, at most (every header but the end blocks). */
  maxEntries: number;
  /** The cap of an entry to keep, by its name; undefined: skipped. */
  want(name: string): number | undefined;
}

const bad = (why: string) => new EngineError('refused', `the package archive is refused: ${why}`);

function octal(b: Buffer, at: number, len: number, what: string): number {
  if ((b[at] & 0x80) !== 0) throw bad(`a ${what} in base-256 (only plain octal sizes are read)`);
  const text = b
    .toString('latin1', at, at + len)
    .replace(/\0.*$/s, '')
    .trim();
  if (text === '') return 0;
  if (!/^[0-7]{1,12}$/.test(text)) throw bad(`a ${what} that is not octal`);
  return parseInt(text, 8);
}

function cString(b: Buffer, at: number, len: number): string {
  const end = b.indexOf(0, at);
  return b.toString('utf8', at, end < 0 || end > at + len ? at + len : end);
}

function checksumOk(h: Buffer): boolean {
  const want = octal(h, 148, 8, 'checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum === want;
}

/** The `path` of a pax extended header; a `size` is refused (sizes are the ustar header's). */
function paxPath(data: Buffer): string | undefined {
  let at = 0;
  let path: string | undefined;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    if (sp < 0) throw bad('a malformed pax header');
    const len = Number(data.toString('latin1', at, sp));
    if (!Number.isInteger(len) || len <= sp - at || at + len > data.length) throw bad('a malformed pax header');
    const rec = data.toString('utf8', sp + 1, at + len - 1);
    const eq = rec.indexOf('=');
    const key = eq < 0 ? rec : rec.slice(0, eq);
    if (key === 'size') throw bad('a pax header that gives a size');
    if (key === 'path') path = rec.slice(eq + 1);
    at += len;
  }
  return path;
}

/** An entry's name as a message shows it: archive text, quoted, at most 200 characters, every hidden character written out. */
const shown = (name: string) => `"${showHiddenCharsLine(name.slice(0, 200))}"`;

function checkName(name: string): string {
  if (name === '' || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw bad(`an entry named ${shown(name)}`);
  if (name.split('/').some((s) => s === '..')) throw bad(`an entry that goes out with ".." (${shown(name)})`);
  return name.replace(/^\.\//, '');
}

/**
 * gunzip's output handed to `take` chunk by chunk until it says the archive ended — then gunzip is stopped: nothing after
 * the end-of-archive block is unpacked or held — or it throws (the stream destroyed, the promise rejected).
 */
function pump(gunzip: ReturnType<typeof createGunzip>, take: (chunk: Buffer) => boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    gunzip.on('data', (chunk: Buffer) => {
      try {
        if (!take(chunk)) return;
        gunzip.destroy();
        resolve();
      } catch (e) {
        gunzip.destroy();
        reject(e);
      }
    });
    gunzip.on('error', (e) => reject(e instanceof EngineError ? e : bad(`not a gzip stream (${e.message})`)));
    gunzip.on('end', () => resolve());
  });
}

type Pending = { kind: 'header' } | { kind: 'data'; name: string; size: number; padded: number; keep: 'file' | 'pax' | 'long' | null; chunks: Buffer[]; got: number };

/** The wanted entries of a gzipped ustar archive, by name (see the module comment). */
export async function readTarGz(tgz: Buffer, limits: TarLimits): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const gunzip = createGunzip();
  let buf: Buffer = Buffer.alloc(0);
  let unpacked = 0;
  let entries = 0;
  let ended = false;
  let state: Pending = { kind: 'header' };
  let nextName: string | undefined;

  const header = (h: Buffer): void => {
    if (h.every((x) => x === 0)) {
      ended = true;
      return;
    }
    if (!checksumOk(h)) throw bad('a header whose checksum is wrong');
    if (++entries > limits.maxEntries) throw bad(`more than ${limits.maxEntries} entries`);
    const size = octal(h, 124, 12, 'size');
    const type = String.fromCharCode(h[156] || 0x30);
    const ustar = h.toString('latin1', 257, 263) === 'ustar\0';
    const prefix = ustar ? cString(h, 345, 155) : '';
    const own = cString(h, 0, 100);
    const name = nextName ?? (prefix ? `${prefix}/${own}` : own);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === '1' || type === '2' || type === 'K') throw bad(`a link (${shown(name)})`);
    if (type === 'x' || type === 'L') {
      if (size > (type === 'x' ? PAX_MAX : LONG_NAME_MAX)) throw bad(`a ${type === 'x' ? 'pax header' : 'long name'} of ${size} bytes`);
      state = { kind: 'data', name, size, padded, keep: type === 'x' ? 'pax' : 'long', chunks: [], got: 0 };
      return;
    }
    nextName = undefined;
    if (type !== '0' && type !== '7') {
      // A directory, a global pax header, a device or a FIFO: never kept, its bytes skipped.
      state = { kind: 'data', name, size, padded, keep: null, chunks: [], got: 0 };
      return;
    }
    const clean = checkName(name);
    const cap = limits.want(clean);
    if (cap !== undefined) {
      if (out.has(clean)) throw bad(`${shown(clean)} twice`);
      if (size > cap) throw bad(`${shown(clean)} is ${size} bytes, more than ${cap}`);
    }
    state = { kind: 'data', name: clean, size, padded, keep: cap !== undefined ? 'file' : null, chunks: [], got: 0 };
  };

  const finish = (s: Extract<Pending, { kind: 'data' }>): void => {
    const data = Buffer.concat(s.chunks, s.size);
    if (s.keep === 'file') out.set(s.name, data);
    else if (s.keep === 'pax') nextName = paxPath(data) ?? nextName;
    else if (s.keep === 'long') nextName = cString(data, 0, data.length);
  };

  const consume = (): void => {
    for (;;) {
      if (ended) return;
      if (state.kind === 'header') {
        if (buf.length < BLOCK) return;
        const h = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        header(h);
        continue;
      }
      const s = state;
      const left = s.padded - s.got;
      if (left === 0 || buf.length === 0) {
        if (left === 0) {
          finish(s);
          state = { kind: 'header' };
          continue;
        }
        return;
      }
      const take = Math.min(left, buf.length);
      const dataLeft = Math.max(0, s.size - s.got);
      if (s.keep && dataLeft > 0) s.chunks.push(Buffer.from(buf.subarray(0, Math.min(take, dataLeft))));
      s.got += take;
      buf = buf.subarray(take);
    }
  };

  const done = pump(gunzip, (chunk) => {
    unpacked += chunk.length;
    if (unpacked > limits.maxUnpacked) throw bad(`more than ${limits.maxUnpacked} bytes once unpacked`);
    if (ended) return true;
    // `buf` holds only what is not consumed yet: less than one header block before this chunk.
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    consume();
    if (ended) buf = Buffer.alloc(0);
    return ended;
  });
  gunzip.end(tgz);
  await done;
  if (!ended) throw bad('it is cut short (no end-of-archive block)');
  return out;
}
