/**
 * The ZIP records a project archive is made of, as our writer writes them and our reader reads them (APPNOTE 6.3): a
 * local header before each entry's data, the central directory, the ZIP64 end record and its locator when a count, a
 * size or an offset does not fit, the end record. Little-endian; names in UTF-8 (flag bit 11); no data descriptor, no
 * encryption, no comment, no extra field but ZIP64's (0x0001). Encoders only, and the shared constants: the reader
 * parses with the same offsets.
 */

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_EOCD64 = 0x06064b50;
export const SIG_LOCATOR = 0x07064b50;

/** A 32-bit field's sentinel: the value is in the ZIP64 extra (a value equal to it goes there too). */
export const MAX32 = 0xffffffff;
/** A 16-bit count's sentinel. */
export const MAX16 = 0xffff;
/** The only flag our archives carry: the name is UTF-8. */
export const FLAG_UTF8 = 0x0800;
/** The ZIP64 extended information extra field. */
export const EXTRA_ZIP64 = 0x0001;
export const METHOD_STORED = 0;
export const METHOD_DEFLATED = 8;
export const VERSION_PLAIN = 20;
export const VERSION_ZIP64 = 45;
/** Version made by: Unix (3), spec 4.5. */
export const MADE_BY_UNIX = (3 << 8) | VERSION_ZIP64;

export const LOCAL_FIXED = 30;
export const CENTRAL_FIXED = 46;
export const EOCD_SIZE = 22;
export const EOCD64_SIZE = 56;
export const LOCATOR_SIZE = 20;

/** A regular file's and a folder's type bits in the external attributes' high half. */
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFMT = 0o170000;

/** An entry's place and values, the fields its headers hold. */
export interface ZipRecord {
  name: Buffer;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
  mode: number;
  /** The sizes are in the ZIP64 extra (local and central headers alike). */
  zip64Sizes: boolean;
  /** The central header's offset is in the ZIP64 extra. */
  zip64Offset: boolean;
}

/** An MS-DOS time and date of a moment (local time), clamped to what the fields hold: 1980-01-01 to 2107-12-31. */
export function dosDateTime(d: Date): { time: number; date: number } {
  const min = new Date(1980, 0, 1, 0, 0, 0).getTime();
  const max = new Date(2107, 11, 31, 23, 59, 58).getTime();
  const t = new Date(Math.min(max, Math.max(min, Number.isFinite(d.getTime()) ? d.getTime() : min)));
  return {
    time: (t.getHours() << 11) | (t.getMinutes() << 5) | Math.floor(t.getSeconds() / 2),
    date: ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate(),
  };
}

/** The moment an MS-DOS time and date name (local time). */
export function fromDosDateTime(time: number, date: number): Date {
  return new Date(1980 + (date >> 9), ((date >> 5) & 0xf) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/** The version needed to extract an entry. */
export const versionOf = (r: Pick<ZipRecord, 'zip64Sizes' | 'zip64Offset'>): number => (r.zip64Sizes || r.zip64Offset ? VERSION_ZIP64 : VERSION_PLAIN);

/** The ZIP64 extra field holding `values` (8 bytes each), or an empty buffer when there are none. */
export function zip64Extra(values: readonly number[]): Buffer {
  if (!values.length) return Buffer.alloc(0);
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(EXTRA_ZIP64, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

/** An entry's local header (its name and, with ZIP64 sizes, both sizes in the extra). */
export function localHeader(r: ZipRecord): Buffer {
  const extra = zip64Extra(r.zip64Sizes ? [r.size, r.compressedSize] : []);
  const b = Buffer.alloc(LOCAL_FIXED + r.name.length + extra.length);
  b.writeUInt32LE(SIG_LOCAL, 0);
  b.writeUInt16LE(versionOf(r), 4);
  b.writeUInt16LE(FLAG_UTF8, 6);
  b.writeUInt16LE(r.method, 8);
  b.writeUInt16LE(r.dosTime, 10);
  b.writeUInt16LE(r.dosDate, 12);
  b.writeUInt32LE(r.crc32 >>> 0, 14);
  b.writeUInt32LE(r.zip64Sizes ? MAX32 : r.compressedSize, 18);
  b.writeUInt32LE(r.zip64Sizes ? MAX32 : r.size, 22);
  b.writeUInt16LE(r.name.length, 26);
  b.writeUInt16LE(extra.length, 28);
  r.name.copy(b, LOCAL_FIXED);
  extra.copy(b, LOCAL_FIXED + r.name.length);
  return b;
}

/** An entry's central header: the fields that do not fit (or every ZIP64 one) in the extra, in the order the format sets. */
export function centralHeader(r: ZipRecord): Buffer {
  const values = [...(r.zip64Sizes ? [r.size, r.compressedSize] : []), ...(r.zip64Offset ? [r.offset] : [])];
  const extra = zip64Extra(values);
  const b = Buffer.alloc(CENTRAL_FIXED + r.name.length + extra.length);
  b.writeUInt32LE(SIG_CENTRAL, 0);
  b.writeUInt16LE(MADE_BY_UNIX, 4);
  b.writeUInt16LE(versionOf(r), 6);
  b.writeUInt16LE(FLAG_UTF8, 8);
  b.writeUInt16LE(r.method, 10);
  b.writeUInt16LE(r.dosTime, 12);
  b.writeUInt16LE(r.dosDate, 14);
  b.writeUInt32LE(r.crc32 >>> 0, 16);
  b.writeUInt32LE(r.zip64Sizes ? MAX32 : r.compressedSize, 20);
  b.writeUInt32LE(r.zip64Sizes ? MAX32 : r.size, 24);
  b.writeUInt16LE(r.name.length, 28);
  b.writeUInt16LE(extra.length, 30);
  // comment length, disk number start, internal attributes: 0
  b.writeUInt32LE(((r.mode >>> 0) << 16) >>> 0, 38);
  b.writeUInt32LE(r.zip64Offset ? MAX32 : r.offset, 42);
  r.name.copy(b, CENTRAL_FIXED);
  extra.copy(b, CENTRAL_FIXED + r.name.length);
  return b;
}

/** Where the central directory is and what it holds. */
export interface ZipEnd {
  entries: number;
  cdSize: number;
  cdOffset: number;
}

/** The ZIP64 end record (at `at`) and its locator, which follows it. */
export function eocd64(end: ZipEnd, at: number): Buffer {
  const b = Buffer.alloc(EOCD64_SIZE + LOCATOR_SIZE);
  b.writeUInt32LE(SIG_EOCD64, 0);
  b.writeBigUInt64LE(BigInt(EOCD64_SIZE - 12), 4);
  b.writeUInt16LE(MADE_BY_UNIX, 12);
  b.writeUInt16LE(VERSION_ZIP64, 14);
  // this disk, the central directory's disk: 0
  b.writeBigUInt64LE(BigInt(end.entries), 24);
  b.writeBigUInt64LE(BigInt(end.entries), 32);
  b.writeBigUInt64LE(BigInt(end.cdSize), 40);
  b.writeBigUInt64LE(BigInt(end.cdOffset), 48);
  b.writeUInt32LE(SIG_LOCATOR, EOCD64_SIZE);
  b.writeBigUInt64LE(BigInt(at), EOCD64_SIZE + 8);
  b.writeUInt32LE(1, EOCD64_SIZE + 16);
  return b;
}

/** The end record, with no comment; with `zip64`, every field a ZIP64 one holds written as its sentinel. */
export function eocd(end: ZipEnd, zip64: boolean): Buffer {
  const b = Buffer.alloc(EOCD_SIZE);
  b.writeUInt32LE(SIG_EOCD, 0);
  b.writeUInt16LE(zip64 ? MAX16 : end.entries, 8);
  b.writeUInt16LE(zip64 ? MAX16 : end.entries, 10);
  b.writeUInt32LE(zip64 ? MAX32 : end.cdSize, 12);
  b.writeUInt32LE(zip64 ? MAX32 : end.cdOffset, 16);
  return b;
}

/** Whether the end needs the ZIP64 records: a count of MAX16 or more, a size or an offset of MAX32 or more (a value equal to the sentinel included). */
export const endNeedsZip64 = (end: ZipEnd): boolean => end.entries >= MAX16 || end.cdSize >= MAX32 || end.cdOffset >= MAX32;
