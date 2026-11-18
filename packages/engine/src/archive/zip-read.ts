/**
 * The reader of a project archive: only what our writer (zip-write.ts) writes is read, everything else refused before
 * a byte of an entry is handed out. Positional reads through one open handle — never the whole file in memory.
 *
 * The shape is fixed: the end record exactly at the file's last 22 bytes with no comment (it is never searched for: a
 * planted one in a comment or in data is never found), the ZIP64 locator right before it and the ZIP64 end record
 * right before that exactly when the end record holds a sentinel, one disk; the first local header at offset 0, each
 * entry's local header exactly where the previous entry's data ended (no gap, no overlap, nothing prepended), the
 * central directory right after the last entry's data and ending where the end records begin. Refused besides (an
 * EngineError `refused`, "the project archive is refused: …", any name shown with its hidden characters written out):
 * a flag other than bit 11 (encryption, a data descriptor…) or bit 11 missing, a version needed over 4.5, a method
 * other than stored or deflated, a stored entry whose sizes differ, an extra field other than ZIP64's or one whose
 * length is not the sentinels', a name that is not strict UTF-8 or not an archive name (core archive-names.ts), a local
 * header that differs from its central one (name, method, flags, crc, sizes once resolved), an entry that is neither
 * a plain file of mode 0644 or 0755 nor a folder of 0755 made on Unix (links, devices, FIFOs, sockets, other modes), two
 * names of one folded key, a file that is another entry's folder, more entries, a larger entry, a larger total or a
 * higher compression ratio than the limits (limits.ts). An entry's bytes are counted as they are inflated and cut at its
 * declared size (more is a bomb, fewer a truncated entry), and its crc32 is checked at its end.
 */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, crc32 as zlibCrc32 } from 'node:zlib';
import { ARCHIVE_NAME_MAX_BYTES, archiveNameProblem, foldedArchiveKey, showHiddenCharsLine } from '@retake/core/base';
import { EngineError } from '../errors.js';
import { ZIP_RATIO_MAX, bombRatio, zipLimits } from './limits.js';
import type { ZipLimits } from './limits.js';
import {
  CENTRAL_FIXED,
  EOCD64_SIZE,
  EOCD_SIZE,
  EXTRA_ZIP64,
  FLAG_UTF8,
  LOCAL_FIXED,
  LOCATOR_SIZE,
  MAX16,
  MAX32,
  METHOD_DEFLATED,
  METHOD_STORED,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_EOCD64,
  SIG_LOCAL,
  SIG_LOCATOR,
  S_IFDIR,
  S_IFMT,
  S_IFREG,
  VERSION_ZIP64,
  fromDosDateTime,
} from './zip-format.js';
import type { ZipEnd } from './zip-format.js';

/** An entry of an archive, as its headers say (both agree). */
export interface ZipEntry {
  readonly name: string;
  /** A folder entry (its name ends with `/`; no bytes). */
  readonly dir: boolean;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly crc32: number;
  readonly mode: 0o644 | 0o755;
  readonly mtime: Date;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  /** An entry's bytes: inflated, counted, cut at its size and crc-checked (the stream errors with the refusal). */
  read(e: ZipEntry): Readable;
  /** An entry's bytes in memory, refused when its size is over `max`. */
  readAll(e: ZipEntry, max: number): Promise<Buffer>;
  close(): Promise<void>;
}

const bad = (why: string) => new EngineError('refused', `the project archive is refused: ${why}`);
/** An entry's name as a refusal shows it: quoted, at most 200 characters, every hidden character written out. */
const shown = (name: string) => `"${showHiddenCharsLine(name.slice(0, 200))}"`;
const CHUNK = 256 * 1024;
const NAMES = new TextDecoder('utf-8', { fatal: true });

/** What a central header says, resolved (ZIP64 values in place). */
interface Central {
  nameBytes: Buffer;
  name: string;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  size: number;
  offset: number;
  mode: number;
}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(b, got, len - got, pos + got);
    if (bytesRead === 0) throw bad('it is cut short');
    got += bytesRead;
  }
  return b;
}

const u64 = (b: Buffer, at: number): number => {
  const v = b.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw bad('a size or an offset too large to be true');
  return Number(v);
};

/** The ZIP64 end record and its locator, which end where the end record begins. */
async function readEnd64(fh: FileHandle, eocdAt: number, end: ZipEnd): Promise<ZipEnd & { endAt: number }> {
  const locAt = eocdAt - LOCATOR_SIZE;
  const at = locAt - EOCD64_SIZE;
  if (at < 0) throw bad('its ZIP64 end record is missing');
  const b = await readAt(fh, at, EOCD64_SIZE + LOCATOR_SIZE);
  if (b.readUInt32LE(EOCD64_SIZE) !== SIG_LOCATOR || b.readUInt32LE(EOCD64_SIZE + 4) !== 0 || u64(b, EOCD64_SIZE + 8) !== at || b.readUInt32LE(EOCD64_SIZE + 16) !== 1)
    throw bad('its ZIP64 locator is not where it belongs');
  if (b.readUInt32LE(0) !== SIG_EOCD64 || u64(b, 4) !== EOCD64_SIZE - 12 || b.readUInt32LE(16) !== 0 || b.readUInt32LE(20) !== 0) throw bad('its ZIP64 end record is not one this writer makes');
  const z: ZipEnd = { entries: u64(b, 32), cdSize: u64(b, 40), cdOffset: u64(b, 48) };
  if (u64(b, 24) !== z.entries) throw bad('it spans several disks');
  const agrees = (v: number, s: number, w: number) => v === s || v === w;
  if (!agrees(end.entries, MAX16, z.entries) || !agrees(end.cdSize, MAX32, z.cdSize) || !agrees(end.cdOffset, MAX32, z.cdOffset)) throw bad('its end records disagree');
  return { ...z, endAt: at };
}

/** The end record, exactly at the last 22 bytes (no comment), and the ZIP64 one when it holds a sentinel. */
async function readEnd(fh: FileHandle, size: number): Promise<ZipEnd & { endAt: number }> {
  if (size < EOCD_SIZE) throw bad('it is not a ZIP file');
  const at = size - EOCD_SIZE;
  const b = await readAt(fh, at, EOCD_SIZE);
  if (b.readUInt32LE(0) !== SIG_EOCD) throw bad('it does not end with a ZIP end record (a comment or bytes after it)');
  if (b.readUInt16LE(20) !== 0) throw bad('its end record carries a comment');
  if (b.readUInt16LE(4) !== 0 || b.readUInt16LE(6) !== 0 || b.readUInt16LE(8) !== b.readUInt16LE(10)) throw bad('it spans several disks');
  const end: ZipEnd = { entries: b.readUInt16LE(10), cdSize: b.readUInt32LE(12), cdOffset: b.readUInt32LE(16) };
  if (end.entries === MAX16 || end.cdSize === MAX32 || end.cdOffset === MAX32) return readEnd64(fh, at, end);
  return { ...end, endAt: at };
}

/**
 * The ZIP64 values of an extra field — `want` says which fields of the header are sentinels, in the format's order —
 * or a refusal: the extra holds ZIP64's field only, exactly as long as those values.
 */
function zip64Values(extra: Buffer, want: number): number[] {
  if (want === 0) {
    if (extra.length)
      throw bad(
        extra.length >= 2 && extra.readUInt16LE(0) !== EXTRA_ZIP64
          ? `an extra field of a kind it does not read (0x${extra.readUInt16LE(0).toString(16).padStart(4, '0')})`
          : 'an extra field it does not expect',
      );
    return [];
  }
  if (extra.length < 4 || extra.readUInt16LE(0) !== EXTRA_ZIP64)
    throw bad(extra.length >= 2 ? `an extra field of a kind it does not read (0x${extra.readUInt16LE(0).toString(16).padStart(4, '0')})` : 'a ZIP64 field missing');
  if (extra.readUInt16LE(2) !== 8 * want || extra.length !== 4 + 8 * want) throw bad('a ZIP64 field whose length is not its values');
  return Array.from({ length: want }, (_, i) => u64(extra, 4 + 8 * i));
}

/** Flags, version and method as our writer writes them. */
function checkCoding(flags: number, version: number, method: number, name: string): void {
  if (flags !== FLAG_UTF8) throw bad(`flags it does not read on ${shown(name)} (encryption, a data descriptor, or a name not marked UTF-8)`);
  if (version > VERSION_ZIP64) throw bad(`${shown(name)} needs a newer ZIP reader`);
  if (method !== METHOD_STORED && method !== METHOD_DEFLATED) throw bad(`${shown(name)} uses a compression method it does not read (${method})`);
}

function decodeName(bytes: Buffer): string {
  try {
    return NAMES.decode(bytes);
  } catch {
    throw bad('a name that is not UTF-8');
  }
}

/** One central header at `at` of the directory `b`, resolved, and where the next one begins. */
function parseCentral(b: Buffer, at: number): { c: Central; next: number } {
  if (at + CENTRAL_FIXED > b.length || b.readUInt32LE(at) !== SIG_CENTRAL) throw bad('its central directory is damaged');
  const nlen = b.readUInt16LE(at + 28);
  const xlen = b.readUInt16LE(at + 30);
  const next = at + CENTRAL_FIXED + nlen + xlen;
  if (next > b.length) throw bad('its central directory is damaged');
  const nameBytes = Buffer.from(b.subarray(at + CENTRAL_FIXED, at + CENTRAL_FIXED + nlen));
  const name = decodeName(nameBytes);
  checkCoding(b.readUInt16LE(at + 8), b.readUInt16LE(at + 6), b.readUInt16LE(at + 10), name);
  if (b.readUInt16LE(at + 4) >> 8 !== 3) throw bad(`${shown(name)} was not made on Unix (its permissions cannot be read)`);
  if (b.readUInt16LE(at + 32) !== 0 || b.readUInt16LE(at + 34) !== 0) throw bad(`${shown(name)} carries a comment or another disk`);
  const raw = [b.readUInt32LE(at + 24), b.readUInt32LE(at + 20), b.readUInt32LE(at + 42)];
  const values = zip64Values(b.subarray(at + CENTRAL_FIXED + nlen, next), raw.filter((v) => v === MAX32).length);
  const [size, compressedSize, offset] = raw.map((v) => (v === MAX32 ? values.shift()! : v)) as [number, number, number];
  const c: Central = {
    nameBytes,
    name,
    flags: b.readUInt16LE(at + 8),
    method: b.readUInt16LE(at + 10),
    dosTime: b.readUInt16LE(at + 12),
    dosDate: b.readUInt16LE(at + 14),
    crc32: b.readUInt32LE(at + 16),
    compressedSize,
    size,
    offset,
    mode: b.readUInt32LE(at + 38) >>> 16,
  };
  return { c, next };
}

/** The longest central header our writer writes. */
export const CENTRAL_HEADER_MAX = CENTRAL_FIXED + ARCHIVE_NAME_MAX_BYTES + 1 + 28;

/** The central directory: exactly `end.entries` headers filling exactly `end.cdSize` bytes. */
async function readCentral(fh: FileHandle, end: ZipEnd & { endAt: number }, limits: ZipLimits): Promise<Central[]> {
  if (end.entries > limits.entries) throw bad(`more than ${limits.entries} entries`);
  if (end.cdOffset + end.cdSize !== end.endAt) throw bad('its central directory does not end where its end record begins');
  // Checked before a byte of it is read: no header of ours is longer than its fixed part, the longest name (and a
  // folder's slash) and a full ZIP64 extra (4 + 3 × 8 bytes), with no comment.
  if (end.cdSize > end.entries * CENTRAL_HEADER_MAX) throw bad('its central directory is damaged');
  const b = await readAt(fh, end.cdOffset, end.cdSize);
  const out: Central[] = [];
  let at = 0;
  for (let i = 0; i < end.entries; i++) {
    const { c, next } = parseCentral(b, at);
    out.push(c);
    at = next;
  }
  if (at !== b.length) throw bad('its central directory holds more than its entries');
  return out;
}

/** The local header of `c` at `pos` (where the previous data ended): it agrees with `c`. Where its data begins. */
async function checkLocal(fh: FileHandle, c: Central, pos: number, fileSize: number): Promise<number> {
  if (c.offset !== pos) throw bad(`${shown(c.name)} does not start where the previous entry ends (a gap, an overlap or bytes before it)`);
  const want = Math.min(LOCAL_FIXED + c.nameBytes.length + 20, fileSize - pos);
  const b = await readAt(fh, pos, want);
  if (b.length < LOCAL_FIXED || b.readUInt32LE(0) !== SIG_LOCAL) throw bad(`${shown(c.name)} has no local header where its central header says`);
  const nlen = b.readUInt16LE(26);
  const xlen = b.readUInt16LE(28);
  if (nlen !== c.nameBytes.length || LOCAL_FIXED + nlen + xlen > b.length) throw bad(`the local header of ${shown(c.name)} differs from its central one`);
  checkCoding(b.readUInt16LE(6), b.readUInt16LE(4), b.readUInt16LE(8), c.name);
  const rawC = b.readUInt32LE(18);
  const rawU = b.readUInt32LE(22);
  if ((rawC === MAX32) !== (rawU === MAX32)) throw bad(`the local header of ${shown(c.name)} differs from its central one`);
  const values = zip64Values(b.subarray(LOCAL_FIXED + nlen, LOCAL_FIXED + nlen + xlen), rawU === MAX32 ? 2 : 0);
  const [size, compressed] = rawU === MAX32 ? (values as [number, number]) : [rawU, rawC];
  const same =
    b.subarray(LOCAL_FIXED, LOCAL_FIXED + nlen).equals(c.nameBytes) &&
    b.readUInt16LE(6) === c.flags &&
    b.readUInt16LE(8) === c.method &&
    b.readUInt16LE(10) === c.dosTime &&
    b.readUInt16LE(12) === c.dosDate &&
    b.readUInt32LE(14) === c.crc32 &&
    size === c.size &&
    compressed === c.compressedSize;
  if (!same) throw bad(`the local header of ${shown(c.name)} differs from its central one`);
  return pos + LOCAL_FIXED + nlen + xlen;
}

/** An entry of a central header: its name and kind checked (a plain file or a folder, as our writer makes them). */
function entryOf(c: Central): ZipEntry {
  const type = c.mode & S_IFMT;
  const perms = c.mode & 0o7777;
  const dir = type === S_IFDIR;
  if (type !== S_IFREG && !dir) throw bad(`${shown(c.name)} is not a plain file or a folder (a link, a device or a pipe)`);
  if (dir ? perms !== 0o755 : perms !== 0o644 && perms !== 0o755) throw bad(`${shown(c.name)} has permissions it does not take (${perms.toString(8)})`);
  const problem = archiveNameProblem(c.name, { dir });
  if (problem) throw bad(`an entry named ${shown(c.name)} (${problem})`);
  if (c.method === METHOD_STORED && c.size !== c.compressedSize) throw bad(`${shown(c.name)} is stored with two sizes`);
  if (dir && (c.size !== 0 || c.compressedSize !== 0 || c.crc32 !== 0)) throw bad(`the folder ${shown(c.name)} holds bytes`);
  return Object.freeze({
    name: c.name,
    dir,
    size: c.size,
    compressedSize: c.compressedSize,
    method: c.method,
    crc32: c.crc32,
    mode: perms as 0o644 | 0o755,
    mtime: fromDosDateTime(c.dosTime, c.dosDate),
  });
}

/** No two names of one folded key, and no file standing where another entry needs a folder. */
function checkNames(entries: readonly ZipEntry[]): void {
  const keys = new Map<string, string>();
  const files = new Set<string>();
  for (const e of entries) {
    const key = foldedArchiveKey(e.dir ? e.name.slice(0, -1) : e.name);
    const seen = keys.get(key);
    if (seen !== undefined) throw bad(`two entries of one name on a Mac's disk (${shown(seen)} and ${shown(e.name)})`);
    keys.set(key, e.name);
    if (!e.dir) files.add(key);
  }
  for (const [key, name] of keys) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      if (files.has(folder)) throw bad(`${shown(name)} lies in a folder that is a file of the archive (${shown(keys.get(folder)!)})`);
    }
  }
}

/** The sizes the entries declare, against the limits. */
function checkSizes(entries: readonly ZipEntry[], limits: ZipLimits): void {
  let total = 0;
  for (const e of entries) {
    if (e.size > limits.entryMax(e.name)) throw bad(`${shown(e.name)} is larger than an entry may be (${limits.entryMax(e.name)} bytes)`);
    if (bombRatio(e.size, e.compressedSize)) throw bad(`${shown(e.name)} inflates more than ${ZIP_RATIO_MAX} times (a bomb)`);
    total += e.size;
    if (total > limits.totalMax) throw bad(`its entries hold more than ${limits.totalMax} bytes (more than the disk can take)`);
  }
}

async function* rawChunks(fh: FileHandle, start: number, len: number): AsyncGenerator<Buffer> {
  let pos = start;
  let left = len;
  while (left > 0) {
    const n = Math.min(left, CHUNK);
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, pos);
    if (bytesRead === 0) throw bad('an entry is cut short');
    yield b.subarray(0, bytesRead);
    pos += bytesRead;
    left -= bytesRead;
  }
}

async function* inflated(raw: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const inflate = createInflateRaw();
  const fed = pipeline(Readable.from(raw), inflate);
  fed.catch(() => undefined);
  try {
    for await (const c of inflate) yield c as Buffer;
    await fed;
  } catch (e) {
    throw e instanceof EngineError ? e : bad('an entry holds damaged compressed data');
  } finally {
    inflate.destroy();
  }
}

/** The entry's bytes counted, cut past its size (a bomb), and its size and crc32 checked at its end. */
async function* checked(e: ZipEntry, chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let size = 0;
  let crc = 0;
  for await (const c of chunks) {
    size += c.length;
    if (size > e.size) throw bad(`${shown(e.name)} inflates past its declared size (a bomb)`);
    crc = zlibCrc32(c, crc);
    yield c;
  }
  if (size !== e.size) throw bad(`${shown(e.name)} is truncated`);
  if (crc >>> 0 !== e.crc32 >>> 0) throw bad(`${shown(e.name)} does not match its checksum`);
}

/** The archive `file`, every header checked (see the module comment); read through one handle until `close`. */
export async function openZip(file: string, given: Partial<ZipLimits> = {}): Promise<ZipArchive> {
  const limits = zipLimits(given);
  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const end = await readEnd(fh, size);
    const central = await readCentral(fh, end, limits);
    const entries = central.map(entryOf);
    checkNames(entries);
    checkSizes(entries, limits);
    const starts = new Map<ZipEntry, number>();
    let pos = 0;
    for (let i = 0; i < central.length; i++) {
      const start = await checkLocal(fh, central[i]!, pos, size);
      starts.set(entries[i]!, start);
      pos = start + central[i]!.compressedSize;
    }
    if (pos !== end.cdOffset) throw bad('its central directory does not follow its last entry');
    return archive(fh, entries, starts);
  } catch (e) {
    await fh.close();
    throw e;
  }
}

function archive(fh: FileHandle, entries: readonly ZipEntry[], starts: Map<ZipEntry, number>): ZipArchive {
  const read = (e: ZipEntry): Readable => {
    const start = starts.get(e);
    if (start === undefined) throw new EngineError('internal', 'not an entry of this archive');
    const raw = rawChunks(fh, start, e.compressedSize);
    return Readable.from(checked(e, e.method === METHOD_DEFLATED ? inflated(raw) : raw));
  };
  return {
    entries,
    read,
    readAll: async (e, max) => {
      if (e.size > max) throw bad(`${shown(e.name)} is larger than ${max} bytes`);
      const chunks: Buffer[] = [];
      for await (const c of read(e)) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    },
    close: () => fh.close(),
  };
}
