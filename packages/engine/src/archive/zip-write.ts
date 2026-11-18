/**
 * The writer of a project archive: a ZIP file our reader (zip-read.ts) and the usual tools read, with no dependency.
 * Entries are streamed from their files (deflated, or stored when already compressed) in ascending name order, each
 * local header written first with its values to come and written again once they are known (no data descriptor); the
 * sha256 and crc32 of an entry are those of the very bytes read into it. ZIP64 where a value does not fit — an entry of
 * 0xF0000000 bytes or more (deflate may grow it), an offset or a central directory past 4 GB, 65 535 entries or more —
 * or everywhere with `zip64: 'always'` (tests). Names are archive-names.ts's; the caps are limits.ts's, so an export
 * never writes what an import refuses. The file is created exclusively (never over one).
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { archiveNameProblem, showHiddenCharsLine } from '@retake/core/base';
import { EngineError } from '../errors.js';
import { bombRatio, zipLimits } from './limits.js';
import type { ZipLimits } from './limits.js';
import { MAX32, METHOD_DEFLATED, METHOD_STORED, S_IFREG, centralHeader, dosDateTime, endNeedsZip64, eocd, eocd64, localHeader } from './zip-format.js';
import type { ZipEnd, ZipRecord } from './zip-format.js';

/** Extensions whose bytes are compressed already: stored as they are. */
const STORED_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.gz', '.zip', '.mp3', '.m4a']);
/** From this size on an entry's sizes go into its ZIP64 extra (deflate may grow a file a little). */
const ZIP64_ENTRY_FROM = 0xf0000000;

/** Where an entry's bytes come from: a file (streamed, never followed through a link) or bytes in memory. */
export type ZipSource = { file: string } | { data: Buffer };

/** What an entry is: its permissions (a plain file or an executable one) and its time. */
export interface ZipAddOptions {
  mode: 0o644 | 0o755;
  mtime: Date;
}

/** An entry written: its bytes, their sha256 (hex) and crc32. */
export interface ZipAdded {
  size: number;
  sha256: string;
  crc32: number;
}

export interface ZipWriter {
  /** Add an entry (names in strictly ascending byte order). A failure after its first byte was written leaves only `abort`. */
  add(name: string, source: ZipSource, o: ZipAddOptions): Promise<ZipAdded>;
  /** Write the central directory and the end records, sync and close: the entries and the file's bytes. */
  close(): Promise<{ entries: number; bytes: number }>;
  /** Close and remove the file (a failed or cancelled export). */
  abort(): Promise<void>;
}

const methodFor = (name: string, size: number): number => (size === 0 || STORED_EXTENSIONS.has(extname(name).toLowerCase()) ? METHOD_STORED : METHOD_DEFLATED);

/** The bytes of a file, chunk by chunk, each one hashed and counted as it passes. */
async function* hashed(chunks: AsyncIterable<Buffer>, sum: { hash: ReturnType<typeof createHash>; crc: number; size: number }): AsyncGenerator<Buffer> {
  for await (const c of chunks) {
    sum.hash.update(c);
    sum.crc = zlibCrc32(c, sum.crc);
    sum.size += c.length;
    yield c;
  }
}

class Writer implements ZipWriter {
  #pos = 0;
  #last: Buffer | undefined;
  readonly #records: ZipRecord[] = [];
  #closed = false;
  /** An add failed midway: the file holds a part of an entry, and only abort is left. */
  #broken = false;

  constructor(
    readonly file: string,
    private readonly fh: FileHandle,
    private readonly always: boolean,
    private readonly limits: ZipLimits,
  ) {}

  async #write(b: Buffer, at?: number): Promise<void> {
    let done = 0;
    const from = at ?? this.#pos;
    while (done < b.length) done += (await this.fh.write(b, done, b.length - done, from + done)).bytesWritten;
    if (at === undefined) this.#pos += b.length;
  }

  #checkName(name: string, size: number): Buffer {
    const problem = archiveNameProblem(name);
    if (problem) throw new EngineError('invalid', `an archive entry cannot be named "${showHiddenCharsLine(name.slice(0, 200))}": ${problem}`);
    const bytes = Buffer.from(name, 'utf8');
    if (this.#last && Buffer.compare(bytes, this.#last) <= 0)
      throw new EngineError('internal', `archive entries are added in ascending name order: "${showHiddenCharsLine(name.slice(0, 200))}" came late`);
    if (this.#records.length >= this.limits.entries) throw new EngineError('refused', `an archive holds at most ${this.limits.entries} entries`);
    if (size > this.limits.entryMax(name))
      throw new EngineError('refused', `"${showHiddenCharsLine(name.slice(0, 200))}" is larger than an archive entry may be (${this.limits.entryMax(name)} bytes)`);
    return bytes;
  }

  #record(nameBytes: Buffer, size: number, method: number, o: ZipAddOptions): ZipRecord {
    const { time, date } = dosDateTime(o.mtime);
    const zip64Sizes = this.always || size >= ZIP64_ENTRY_FROM;
    return {
      name: nameBytes,
      method,
      crc32: 0,
      compressedSize: 0,
      size,
      offset: this.#pos,
      dosTime: time,
      dosDate: date,
      mode: S_IFREG | o.mode,
      zip64Sizes,
      zip64Offset: this.always || this.#pos >= MAX32,
    };
  }

  async add(name: string, source: ZipSource, o: ZipAddOptions): Promise<ZipAdded> {
    if (this.#closed || this.#broken) throw new EngineError('internal', 'the archive is closed, or an earlier entry failed: abort it');
    if (o.mode !== 0o644 && o.mode !== 0o755) throw new EngineError('invalid', 'an archive entry is 0644 or 0755');
    const at = this.#pos;
    try {
      return await ('data' in source ? this.#addData(name, source.data, o) : this.#addFile(name, source.file, o));
    } catch (e) {
      // A refusal before anything was written leaves the archive as it was; any later failure leaves part of an entry.
      if (this.#pos !== at) this.#broken = true;
      throw e;
    }
  }

  async #addData(name: string, data: Buffer, o: ZipAddOptions): Promise<ZipAdded> {
    const nameBytes = this.#checkName(name, data.length);
    const r = this.#record(nameBytes, data.length, methodFor(name, data.length), o);
    let body = r.method === METHOD_DEFLATED ? deflateRawSync(data, { level: 6 }) : data;
    // Deflated past the reader's bomb ratio: stored instead (limits.ts bombRatio, the one rule).
    if (r.method === METHOD_DEFLATED && bombRatio(data.length, body.length)) {
      r.method = METHOD_STORED;
      body = data;
    }
    r.crc32 = zlibCrc32(data);
    r.compressedSize = body.length;
    this.#fits(r);
    await this.#write(Buffer.concat([localHeader(r), body]));
    this.#records.push(r);
    this.#last = nameBytes;
    return { size: data.length, sha256: createHash('sha256').update(data).digest('hex'), crc32: r.crc32 };
  }

  /** A value of an entry written without ZIP64 that does not fit (never expected: ZIP64_ENTRY_FROM leaves room). */
  #fits(r: ZipRecord): void {
    if (!r.zip64Sizes && (r.size >= MAX32 || r.compressedSize >= MAX32)) throw new EngineError('internal', 'an archive entry outgrew its header (no ZIP64 reserved)');
  }

  /** Stream the file's bytes into the archive at the current end, by `r.method`: the crc, size and sha256 of what was read. */
  async #stream(src: FileHandle, r: ZipRecord): Promise<{ sum: { hash: ReturnType<typeof createHash>; crc: number; size: number }; compressed: number }> {
    const sum = { hash: createHash('sha256'), crc: 0, size: 0 };
    const input = Readable.from(hashed(src.createReadStream({ start: 0, autoClose: false }), sum));
    let compressed = 0;
    const sink = async (chunks: AsyncIterable<Buffer>) => {
      for await (const c of chunks) {
        compressed += c.length;
        await this.#write(c);
      }
    };
    if (r.method === METHOD_DEFLATED) await pipeline(input, createDeflateRaw({ level: 6 }), sink);
    else await pipeline(input, sink);
    return { sum, compressed };
  }

  async #addFile(name: string, file: string, o: ZipAddOptions): Promise<ZipAdded> {
    const src = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await src.stat();
      if (!st.isFile()) throw new EngineError('invalid', `not a plain file: ${file}`);
      const nameBytes = this.#checkName(name, st.size);
      const r = this.#record(nameBytes, st.size, methodFor(name, st.size), o);
      await this.#write(localHeader(r));
      let { sum, compressed } = await this.#stream(src, r);
      if (r.method === METHOD_DEFLATED && bombRatio(sum.size, compressed)) {
        // Deflated past the reader's bomb ratio: the entry is written again, stored (limits.ts bombRatio, the one rule).
        this.#pos = r.offset;
        await this.fh.truncate(r.offset);
        r.method = METHOD_STORED;
        await this.#write(localHeader(r));
        ({ sum, compressed } = await this.#stream(src, r));
      }
      if (sum.size !== st.size || (await src.stat()).size !== st.size) throw new EngineError('conflict', `${file} changed while it was archived: export again`);
      Object.assign(r, { crc32: sum.crc, compressedSize: compressed });
      this.#fits(r);
      await this.#write(localHeader(r), r.offset);
      this.#records.push(r);
      this.#last = nameBytes;
      return { size: sum.size, sha256: sum.hash.digest('hex'), crc32: sum.crc };
    } finally {
      await src.close();
    }
  }

  async close(): Promise<{ entries: number; bytes: number }> {
    if (this.#closed || this.#broken) throw new EngineError('internal', 'the archive is closed, or an earlier entry failed: abort it');
    this.#closed = true;
    const cdOffset = this.#pos;
    const central = this.#records.map(centralHeader);
    for (let i = 0; i < central.length; i += 1024) await this.#write(Buffer.concat(central.slice(i, i + 1024)));
    const end: ZipEnd = { entries: this.#records.length, cdSize: this.#pos - cdOffset, cdOffset };
    const zip64 = this.always || endNeedsZip64(end);
    if (zip64) await this.#write(eocd64(end, this.#pos));
    await this.#write(eocd(end, zip64));
    await this.fh.sync();
    await this.fh.close();
    return { entries: end.entries, bytes: this.#pos };
  }

  async abort(): Promise<void> {
    this.#closed = true;
    await this.fh.close().catch(() => undefined);
    await rm(this.file, { force: true });
  }
}

/**
 * A new archive at `file` (created exclusively: an existing file is never replaced). `zip64: 'always'` writes every
 * ZIP64 field a value may take (tests); `limits`: the caps an import applies (limits.ts).
 */
export async function createZip(file: string, o: { zip64?: 'auto' | 'always'; limits?: Partial<ZipLimits> } = {}): Promise<ZipWriter> {
  const fh = await open(file, 'wx', 0o644);
  return new Writer(file, fh, o.zip64 === 'always', zipLimits(o.limits));
}
