/**
 * ZIP archives crafted byte by byte, for the tests of the project archive's reader (engine archive/zip-read.ts): every
 * header field can be set by hand, so a test builds exactly the hostile archive it refuses — a name that climbs, a
 * symbolic link, an encrypted flag, a planted extra field, entries that overlap or leave a gap, bytes before or after.
 * Independent of the engine's writer on purpose (a bug shared by both would hide).
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** One entry as the craft writes it: each field defaults to what a plain stored file would hold. */
export interface CraftEntry {
  name: string | Buffer;
  /** The uncompressed bytes (default empty). */
  data?: Buffer;
  /** Deflate `data` (method 8). */
  deflate?: boolean;
  /** The bytes written after the local header, instead of `data` (or its deflated form). */
  body?: Buffer;
  method?: number;
  flags?: number;
  /** Local header's flags, when they differ from the central ones. */
  localFlags?: number;
  version?: number;
  madeBy?: number;
  /** The high half of the external attributes (type and permission bits; default 0o100644). */
  mode?: number;
  crc32?: number;
  size?: number;
  compressedSize?: number;
  /** The local header's name, when it differs from the central one. */
  localName?: string | Buffer;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  /** The local header's sizes (ZIP64 or a lie), when they differ from the central ones. */
  localSize?: number;
  localCompressedSize?: number;
  /** The central header's offset, instead of where the local header was written. */
  offset?: number;
  /** Bytes written after this entry's data (a gap). */
  gapAfter?: Buffer;
}

export interface CraftOptions {
  /** Bytes before the first local header. */
  prefix?: Buffer;
  /** The end record's comment. */
  comment?: Buffer;
  /** Bytes after the end record. */
  trailing?: Buffer;
  /** Write a ZIP64 end record and locator, with every end field a sentinel. */
  zip64End?: boolean;
  /** The entry count written in the end records (default: the entries'). */
  count?: number;
}

const bytesOf = (n: string | Buffer): Buffer => (typeof n === 'string' ? Buffer.from(n, 'utf8') : n);

/** An extra field: its id, its length and its data. */
export function extraField(id: number, data: Buffer): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(id, 0);
  b.writeUInt16LE(data.length, 2);
  return Buffer.concat([b, data]);
}

/** A ZIP64 extra field of 8-byte values. */
export function zip64Field(values: readonly number[]): Buffer {
  const d = Buffer.alloc(8 * values.length);
  values.forEach((v, i) => d.writeBigUInt64LE(BigInt(v), 8 * i));
  return extraField(0x0001, d);
}

interface Resolved {
  name: Buffer;
  body: Buffer;
  method: number;
  flags: number;
  version: number;
  crc: number;
  size: number;
  csize: number;
}

function resolved(e: CraftEntry): Resolved {
  const data = e.data ?? Buffer.alloc(0);
  const body = e.body ?? (e.deflate ? deflateRawSync(data) : data);
  return {
    name: bytesOf(e.name),
    body,
    method: e.method ?? (e.deflate ? 8 : 0),
    flags: e.flags ?? 0x0800,
    version: e.version ?? 20,
    crc: e.crc32 ?? crc32(data),
    size: e.size ?? data.length,
    csize: e.compressedSize ?? body.length,
  };
}

/** A local header (30 bytes, the name, the extra). */
export function localHeaderOf(e: CraftEntry): Buffer {
  const r = resolved(e);
  const name = e.localName !== undefined ? bytesOf(e.localName) : r.name;
  const extra = e.localExtra ?? Buffer.alloc(0);
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(r.version, 4);
  b.writeUInt16LE(e.localFlags ?? r.flags, 6);
  b.writeUInt16LE(r.method, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(0x21, 12);
  b.writeUInt32LE(r.crc >>> 0, 14);
  b.writeUInt32LE(e.localCompressedSize ?? r.csize, 18);
  b.writeUInt32LE(e.localSize ?? r.size, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(extra.length, 28);
  return Buffer.concat([b, name, extra]);
}

/** A central header (46 bytes, the name, the extra) for an entry whose local header is at `offset`. */
export function centralHeaderOf(e: CraftEntry, offset: number): Buffer {
  const r = resolved(e);
  const extra = e.centralExtra ?? Buffer.alloc(0);
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(e.madeBy ?? (3 << 8) | 45, 4);
  b.writeUInt16LE(r.version, 6);
  b.writeUInt16LE(r.flags, 8);
  b.writeUInt16LE(r.method, 10);
  b.writeUInt16LE(0, 12);
  b.writeUInt16LE(0x21, 14);
  b.writeUInt32LE(r.crc >>> 0, 16);
  b.writeUInt32LE(r.csize, 20);
  b.writeUInt32LE(r.size, 24);
  b.writeUInt16LE(r.name.length, 28);
  b.writeUInt16LE(extra.length, 30);
  b.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
  b.writeUInt32LE(e.offset ?? offset, 42);
  return Buffer.concat([b, r.name, extra]);
}

/** The end record. */
export function eocdOf(o: { count: number; cdSize: number; cdOffset: number; comment?: Buffer }): Buffer {
  const comment = o.comment ?? Buffer.alloc(0);
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(o.count, 8);
  b.writeUInt16LE(o.count, 10);
  b.writeUInt32LE(o.cdSize, 12);
  b.writeUInt32LE(o.cdOffset, 16);
  b.writeUInt16LE(comment.length, 20);
  return Buffer.concat([b, comment]);
}

/** The ZIP64 end record written at `at`, then its locator. */
export function eocd64Of(o: { count: number; cdSize: number; cdOffset: number; at: number }): Buffer {
  const b = Buffer.alloc(76);
  b.writeUInt32LE(0x06064b50, 0);
  b.writeBigUInt64LE(44n, 4);
  b.writeUInt16LE((3 << 8) | 45, 12);
  b.writeUInt16LE(45, 14);
  b.writeBigUInt64LE(BigInt(o.count), 24);
  b.writeBigUInt64LE(BigInt(o.count), 32);
  b.writeBigUInt64LE(BigInt(o.cdSize), 40);
  b.writeBigUInt64LE(BigInt(o.cdOffset), 48);
  b.writeUInt32LE(0x07064b50, 56);
  b.writeBigUInt64LE(BigInt(o.at), 64);
  b.writeUInt32LE(1, 72);
  return b;
}

/** A whole archive of `entries`, laid out as the options say. */
export function craftZip(entries: readonly CraftEntry[], o: CraftOptions = {}): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  const push = (b: Buffer) => {
    parts.push(b);
    pos += b.length;
  };
  if (o.prefix) push(o.prefix);
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(pos);
    push(localHeaderOf(e));
    push(resolved(e).body);
    if (e.gapAfter) push(e.gapAfter);
  }
  const cdOffset = pos;
  entries.forEach((e, i) => push(centralHeaderOf(e, offsets[i]!)));
  const cdSize = pos - cdOffset;
  const count = o.count ?? entries.length;
  if (o.zip64End) {
    push(eocd64Of({ count, cdSize, cdOffset, at: pos }));
    push(eocdOf({ count: 0xffff, cdSize: 0xffffffff, cdOffset: 0xffffffff, ...(o.comment ? { comment: o.comment } : {}) }));
  } else push(eocdOf({ count, cdSize, cdOffset, ...(o.comment ? { comment: o.comment } : {}) }));
  if (o.trailing) push(o.trailing);
  return Buffer.concat(parts);
}
