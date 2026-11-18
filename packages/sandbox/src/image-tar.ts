/**
 * A `docker save` tar of a project archive, read strictly and written afresh for `docker load` (share.ts): docker never
 * sees the archive's own naming files, only a tar Retake writes.
 *
 * The read (canonicalImageTar), one pass over the file (gzipped or not), its compressed bytes hashed on the way:
 * - only regular files and folders, every header ustar (`ustar\0` `00`) with a good checksum, or a pax header of
 *   known metadata keys only (path, size, times, owners) — a link (symbolic or hard), a contiguous file (type 7), a
 *   device, a FIFO, a GNU header (long names, the atime trap: a GNU header's prefix field is not a prefix), a global
 *   pax header or a pax key of another kind refused;
 * - every name already clean (posix): no leading `/` or `./`, no empty, `.` or `..` segment, no NUL; two names equal
 *   once folded (case, Unicode forms) refused; the only names a by-id `docker save` writes — `blobs/`,
 *   `blobs/sha256/`, `blobs/sha256/<hex>`, `index.json`, `manifest.json`, `oci-layout` — every other refused
 *   (`repositories` included);
 * - each blob's sha256 its name; manifest.json, index.json, oci-layout and the manifests index.json reaches read by a
 *   strict JSON reader (strictJson: a duplicate key, or a key spelt otherwise than a known one but equal to it ignoring
 *   case — `repotags` beside `RepoTags` — refused); manifest.json's RepoTags null or empty, no foreign layer,
 *   index.json's descriptors without a name annotation; its configs exactly the image ids expected; every blob
 *   manifest.json references there;
 * - the bytes after decompression at most `maxBytes`; after the end blocks nothing but zeros.
 *
 * The fresh tar (to `out`, as the read goes; `only`: the blobs an earlier read found referenced — share.ts reads twice,
 * the first time writing nothing): the folders, each referenced blob as it comes (Retake's own headers), then — only
 * once everything checked — Retake's own manifest.json (each image's Config and Layers, `RepoTags: null`), index.json
 * (each descriptor's media type, digest and size: no annotation) and oci-layout, and the end blocks. A refusal leaves
 * `out` without any naming file: docker load then loads nothing (share.ts also stops it).
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/** The largest naming file (manifest.json, index.json, oci-layout) and the largest blob kept to read as a manifest. */
export const IMAGE_TAR_JSON_MAX = 4 * 1024 * 1024;
/** The blobs kept in memory to read as manifests, in all. */
const KEPT_MAX = 64 * 1024 * 1024;

const BLOCK = 512;

const BLOB = /^blobs\/sha256\/([0-9a-f]{64})$/;
const DIRS = new Set(['blobs', 'blobs/sha256']);
const NAMING = new Set(['index.json', 'manifest.json', 'oci-layout']);
/** The pax keys a by-id docker save may write: what is read (path, size) and metadata Retake does not write again. */
const PAX_KEYS = new Set(['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname']);

/** A refusal of an image tar, in words. */
export class ImageTarError extends Error {}
const bad = (why: string): never => {
  throw new ImageTarError(why);
};

// ── strict JSON ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * JSON parsed strictly: a duplicate key in an object refused, and two keys equal ignoring case, and a key equal to one
 * of `known` ignoring case but spelt otherwise (`repotags` for `RepoTags`): what Go's case-insensitive decoding would
 * read differently is refused.
 */
export function strictJson(text: string, known: readonly string[]): unknown {
  // Folded as Go's encoding/json matches names (simple Unicode folding: ſ is s, the Kelvin sign is k).
  const fold = (k: string) =>
    k
      .toLowerCase()
      .replace(/\u017f/g, 's')
      .replace(/\u212a/g, 'k');
  const canon = new Map(known.map((k) => [fold(k), k]));
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i]!)) i++;
  };
  const fail = (why: string): never => bad(`a JSON file does not read strictly (${why} at ${i})`);
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (text[i] !== '"') fail('an open string');
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > 64) fail('too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: Record<string, unknown> = {};
      const folded = new Set<string>();
      ws();
      if (text[i] === '}') return i++, out;
      for (;;) {
        ws();
        if (text[i] !== '"') fail('a key');
        const k = str();
        const f = fold(k);
        if (folded.has(f)) fail(`the key ${JSON.stringify(k.slice(0, 40))} twice (ignoring case)`);
        const want = canon.get(f);
        if (want !== undefined && want !== k) fail(`the key ${JSON.stringify(k.slice(0, 40))} spelt otherwise than ${want}`);
        folded.add(f);
        ws();
        if (text[i++] !== ':') fail('a colon');
        Object.defineProperty(out, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i++] !== '}') fail('a closing brace');
        return out;
      }
    }
    if (c === '[') {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === ']') return i++, out;
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i++] !== ']') fail('a closing bracket');
        return out;
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail('a value');
    i += m![0].length;
    return JSON.parse(m![0]);
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail('text after the value');
  return v;
}

// ── tar reading ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Exact reads and skips over a byte stream, its bytes counted. */
class ByteReader {
  readonly #it: AsyncIterator<Buffer>;
  #buf: Buffer = Buffer.alloc(0);
  #done = false;
  read = 0;
  constructor(
    input: AsyncIterable<Buffer>,
    readonly max: number,
  ) {
    this.#it = input[Symbol.asyncIterator]();
  }
  async #fill(n: number): Promise<void> {
    while (this.#buf.length < n && !this.#done) {
      const r = await this.#it.next();
      if (r.done) this.#done = true;
      else {
        this.read += r.value.length;
        if (this.read > this.max) bad(`it holds more than ${this.max} bytes once decompressed (more than its image)`);
        this.#buf = this.#buf.length ? Buffer.concat([this.#buf, r.value]) : r.value;
      }
    }
  }
  /** `n` bytes; undefined at the very end; refused when the stream ends inside them. */
  async take(n: number): Promise<Buffer | undefined> {
    await this.#fill(n);
    if (this.#buf.length === 0 && this.#done) return undefined;
    if (this.#buf.length < n) bad('it ends inside an entry');
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }
  /** Up to `n` bytes (at least one), for streaming an entry's data. */
  async some(n: number): Promise<Buffer> {
    if (this.#buf.length === 0) await this.#fill(1);
    if (this.#buf.length === 0) bad('it ends inside an entry');
    const k = Math.min(n, this.#buf.length);
    const out = this.#buf.subarray(0, k);
    this.#buf = this.#buf.subarray(k);
    return out;
  }
}

const field = (b: Buffer, from: number, len: number): Buffer => {
  const s = b.subarray(from, from + len);
  const nul = s.indexOf(0);
  return nul === -1 ? s : s.subarray(0, nul);
};

function numberField(b: Buffer, from: number, len: number): number {
  const f = b.subarray(from, from + len);
  if (f[0]! & 0x80) {
    let v = f[0]! & 0x7f;
    for (let i = 1; i < f.length; i++) v = v * 256 + f[i]!;
    if (!Number.isSafeInteger(v)) bad('a size too large to read');
    return v;
  }
  const t = field(b, from, len).toString('latin1').trim();
  if (t === '') return 0;
  if (!/^[0-7]+$/.test(t)) bad('a header with a bad number');
  return Number.parseInt(t, 8);
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return numberField(h, 148, 8) === sum;
}

function paxRecords(b: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < b.length) {
    const sp = b.indexOf(0x20, at);
    if (sp === -1) bad('a pax header that does not read');
    const len = Number.parseInt(b.subarray(at, sp).toString('ascii'), 10);
    if (!Number.isSafeInteger(len) || len <= 0 || at + len > b.length || b[at + len - 1] !== 0x0a) bad('a pax header that does not read');
    const rec = b.subarray(sp + 1, at + len - 1);
    if (rec.includes(0)) bad('a pax record with a NUL');
    const t = rec.toString('utf8');
    const eq = t.indexOf('=');
    if (eq <= 0) bad('a pax record that does not read');
    const k = t.slice(0, eq);
    if (!PAX_KEYS.has(k)) bad(`a pax record of another kind (${k.slice(0, 40)})`);
    if (out.has(k)) bad('a pax record twice');
    out.set(k, t.slice(eq + 1));
    at += len;
  }
  return out;
}

const padded = (n: number): number => Math.ceil(n / BLOCK) * BLOCK;

/** A name as it must already be: clean, relative, no NUL. */
function cleanName(raw: string, dir: boolean): string {
  if (raw.includes('\0')) bad('a name with a NUL');
  const name = dir && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (name === '' || name.startsWith('/') || name.split('/').some((s) => s === '' || s === '.' || s === '..') || posix.normalize(name) !== name)
    bad(`a name that is not clean (${JSON.stringify(raw.slice(0, 80))})`);
  return name;
}

// ── tar writing ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A ustar header of Retake's own (mode 0644 / 0755, owner 0, time 0; a size over 8 GiB in base-256). */
function header(name: string, size: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  if (size > 0o77777777777) {
    h[124] = 0x80;
    let v = size;
    for (let i = 135; i > 124; i--) {
      h[i] = v % 256;
      v = Math.floor(v / 256);
    }
  } else h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

/** Writes to `out` (when given), waiting when it asks. */
async function put(out: Writable | undefined, b: Buffer): Promise<void> {
  if (!out || b.length === 0) return;
  if (!out.write(b))
    await new Promise<void>((res, rej) => {
      const done = () => (out.off('error', err), res());
      const err = (e: Error) => (out.off('drain', done), rej(e));
      out.once('drain', done).once('error', err);
    });
}

// ── the whole ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface CanonicalOptions {
  /** The image ids the tar must hold, exactly. */
  expect: readonly string[];
  /** Its bytes once decompressed, at most. */
  maxBytes: number;
  /** The sha256 of the file's own bytes (checked at the end, before any naming file is written). */
  sha256?: string;
  /** Called with the file's bytes read so far. */
  onBytes?: (n: number) => void;
  /**
   * The blobs to write (an earlier read's `referenced`): any other is checked, never written; the read refuses unless
   * it finds the very same set referenced.
   */
  only?: ReadonlySet<string>;
}

export interface CanonicalResult {
  ids: string[];
  /** Its bytes once decompressed. */
  bytes: number;
  /** The sha256 of the file's own bytes. */
  sha256: string;
  /** The blobs a manifest references (those written). */
  referenced: Set<string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MANIFEST_KEYS = ['Config', 'RepoTags', 'Layers', 'LayerSources'];
const OCI_KEYS = ['schemaVersion', 'mediaType', 'manifests', 'config', 'layers', 'annotations', 'digest', 'size', 'platform', 'subject', 'artifactType', 'urls', 'imageLayoutVersion'];
const NAME_ANNOTATIONS = ['io.containerd.image.name', 'org.opencontainers.image.ref.name'];

/** A descriptor's digest (`sha256:<hex>`), or a refusal. */
function digestOf(d: unknown, what: string): string {
  const v = isObj(d) ? d.digest : undefined;
  if (typeof v !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(v)) bad(`${what} without a sha256 digest`);
  return (v as string).slice(7);
}

/** The naming files read and checked; Retake's own written in their place. */
function naming(files: Map<string, Buffer>, kept: Map<string, Buffer>, blobs: Set<string>, expect: readonly string[]): { ids: string[]; tail: Buffer[]; referenced: Set<string> } {
  const man = files.get('manifest.json');
  if (!man) bad('it holds no manifest.json (not a docker save)');
  const doc = strictJson(man!.toString('utf8'), MANIFEST_KEYS);
  if (!Array.isArray(doc) || !doc.length) bad('its manifest.json is not a list of images');
  const required = new Set<string>();
  const images: Array<{ Config: string; RepoTags: null; Layers: string[] }> = [];
  for (const e of doc as unknown[]) {
    if (!isObj(e)) bad('its manifest.json lists something else than an image');
    const ent = e as Record<string, unknown>;
    if (ent.RepoTags !== undefined && ent.RepoTags !== null && !(Array.isArray(ent.RepoTags) && ent.RepoTags.length === 0))
      bad('its manifest.json names tags (RepoTags): it was not saved by image id');
    // LayerSources (each layer's descriptor): read, never written again; a foreign layer (urls: fetched elsewhere) refused.
    if (ent.LayerSources !== undefined && ent.LayerSources !== null) {
      if (!isObj(ent.LayerSources)) bad('its manifest.json has LayerSources that do not read');
      for (const d of Object.values(ent.LayerSources as Record<string, unknown>)) if (!isObj(d) || d.urls !== undefined) bad('its manifest.json names a foreign layer (LayerSources with urls)');
    }
    const config = typeof ent.Config === 'string' ? BLOB.exec(ent.Config)?.[1] : undefined;
    const layers = Array.isArray(ent.Layers) ? ent.Layers.map((l) => (typeof l === 'string' ? BLOB.exec(l)?.[1] : undefined)) : [];
    if (!config || layers.some((l) => !l)) bad('its manifest.json names a config or layer that is not a blob');
    required.add(config!);
    for (const l of layers) required.add(l!);
    images.push({ Config: `blobs/sha256/${config}`, RepoTags: null, Layers: layers.map((l) => `blobs/sha256/${l}`) });
  }
  // index.json, and what it reaches (manifests and indexes kept in memory): their digests are the blobs allowed.
  const allowed = new Set(required);
  const index: Array<{ mediaType: string; digest: string; size: number }> = [];
  const idx = files.get('index.json');
  if (idx) {
    const v = strictJson(idx.toString('utf8'), OCI_KEYS);
    const manifests = isObj(v) && Array.isArray(v.manifests) ? v.manifests : bad('its index.json lists no manifests');
    const queue: string[] = [];
    for (const m of manifests as unknown[]) {
      const ann = isObj(m) && isObj(m.annotations) ? m.annotations : {};
      if (NAME_ANNOTATIONS.some((k) => Object.keys(ann).some((a) => a.toLowerCase() === k))) bad('its index.json names an image (an annotation of a tag)');
      const d = digestOf(m, 'an index entry');
      const size = isObj(m) && Number.isSafeInteger(m.size) ? (m.size as number) : bad('an index entry without a size');
      const mediaType = isObj(m) && typeof m.mediaType === 'string' && m.mediaType.length < 200 ? m.mediaType : bad('an index entry without a media type');
      index.push({ mediaType: mediaType as string, digest: `sha256:${d}`, size: size as number });
      queue.push(d);
    }
    for (let n = 0; n < queue.length && n < 10_000; n++) {
      const d = queue[n]!;
      allowed.add(d);
      const b = kept.get(d);
      if (!b) continue;
      const mv = strictJson(b.toString('utf8'), OCI_KEYS);
      if (!isObj(mv)) continue;
      if (Array.isArray(mv.manifests)) for (const x of mv.manifests) queue.push(digestOf(x, 'a nested index entry'));
      if (mv.config !== undefined) allowed.add(digestOf(mv.config, "a manifest's config"));
      for (const x of [...(Array.isArray(mv.layers) ? mv.layers : []), ...(Array.isArray(mv.manifests) ? mv.manifests : []), mv.config]) {
        if (!isObj(x)) continue;
        if (x.urls !== undefined) bad('a manifest names a layer fetched elsewhere (urls)');
        if (typeof x.mediaType === 'string' && /foreign|nondistributable/i.test(x.mediaType)) bad(`a manifest names a foreign layer (${x.mediaType.slice(0, 80)})`);
      }
      if (Array.isArray(mv.layers)) for (const x of mv.layers) allowed.add(digestOf(x, "a manifest's layer"));
    }
  }
  const lay = files.get('oci-layout');
  if (lay) strictJson(lay.toString('utf8'), OCI_KEYS);
  for (const r of required) if (!blobs.has(r)) bad(`its manifest.json names the blob ${r.slice(0, 12)}, which it does not hold`);
  // A blob nothing references (a by-id save holds a legacy config) is never written again.
  const referenced = new Set([...blobs].filter((b) => allowed.has(b)));
  const ids = [...new Set(images.map((i) => `sha256:${i.Config.slice('blobs/sha256/'.length)}`))].sort();
  const want = [...new Set(expect)].sort();
  if (ids.length !== want.length || ids.some((id, i) => id !== want[i])) bad(`it holds the images ${ids.join(', ')}, not ${want.join(', ')}`);
  const file = (name: string, v: unknown) => {
    const data = Buffer.from(JSON.stringify(v));
    return Buffer.concat([header(name, data.length, '0'), data, Buffer.alloc(padded(data.length) - data.length)]);
  };
  const tail = [
    file('index.json', { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: index }),
    file('manifest.json', images),
    file('oci-layout', { imageLayoutVersion: '1.0.0' }),
    Buffer.alloc(2 * BLOCK),
  ];
  return { ids, tail, referenced };
}

/** A blob's data streamed to `to` (when given) with its padding, its sha256 checked; a small one answered whole. */
async function copyBlob(r: ByteReader, to: Writable | undefined, blob: string, size: number): Promise<Buffer | undefined> {
  const bh = createHash('sha256');
  const keep: Buffer[] = [];
  for (let left = size; left > 0; ) {
    const c = await r.some(Math.min(left, 1 << 20));
    bh.update(c);
    if (size <= IMAGE_TAR_JSON_MAX) keep.push(Buffer.from(c));
    await put(to, c);
    left -= c.length;
  }
  const pad = padded(size) - size;
  if (pad) {
    await r.take(pad);
    await put(to, Buffer.alloc(pad));
  }
  if (bh.digest('hex') !== blob) bad(`the blob ${blob.slice(0, 12)} does not hold the bytes its name says (sha256)`);
  return size <= IMAGE_TAR_JSON_MAX ? Buffer.concat(keep) : undefined;
}

/** Read a docker save tar strictly and write Retake's own (the module's header). */
export async function canonicalImageTar(input: Readable, out: Writable | undefined, o: CanonicalOptions): Promise<CanonicalResult> {
  const hash = createHash('sha256');
  let raw = 0;
  const tee = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      raw += chunk.length;
      o.onBytes?.(raw);
      cb(null, chunk);
    },
  });
  const it = input.pipe(tee)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const first = await it.next();
  if (first.done) bad('it is empty');
  const all = async function* (): AsyncGenerator<Buffer> {
    yield first.value;
    for (let n = await it.next(); !n.done; n = await it.next()) yield n.value;
  };
  const gz = first.value[0] === 0x1f && first.value[1] === 0x8b;
  const bytes: AsyncIterable<Buffer> = gz ? Readable.from(all()).pipe(createGunzip()) : all();
  const r = new ByteReader(bytes, o.maxBytes);
  const files = new Map<string, Buffer>();
  const kept = new Map<string, Buffer>();
  const blobs = new Set<string>();
  const seen = new Set<string>();
  let keptBytes = 0;
  let pax: Map<string, string> | undefined;
  for (const d of ['blobs/', 'blobs/sha256/']) await put(out, header(d, 0, '5'));
  for (;;) {
    const h = await r.take(BLOCK);
    if (!h) bad('it has no end blocks');
    if (h!.every((x) => x === 0)) {
      // The end: a second zero block, then nothing but zeros.
      const next = await r.take(BLOCK);
      if (next && !next.every((x) => x === 0)) bad('data after a single end block');
      for (let rest = await r.take(BLOCK).catch(() => undefined); rest; rest = await r.take(BLOCK).catch(() => undefined)) if (!rest.every((x) => x === 0)) bad('data after the end blocks');
      break;
    }
    if (!checksumOk(h!)) bad('a header whose checksum is wrong');
    if (field(h!, 257, 6).toString('latin1') !== 'ustar' || h![262] !== 0 || h!.subarray(263, 265).toString('latin1') !== '00') bad('a header that is not ustar or pax (a GNU header?)');
    const type = String.fromCharCode(h![156]!);
    let size = numberField(h!, 124, 12);
    if (type === 'x') {
      if (pax) bad('two pax headers in a row');
      if (size > IMAGE_TAR_JSON_MAX) bad('a pax header too large');
      pax = paxRecords((await r.take(padded(size)))!.subarray(0, size));
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '5') bad(`an entry of type ${JSON.stringify(type)} (a link, a device, a FIFO, a contiguous file or a GNU header): only files and folders are read`);
    if (pax?.has('size')) {
      const v = Number(pax.get('size'));
      if (!/^\d+$/.test(pax.get('size') ?? '') || !Number.isSafeInteger(v)) bad('a pax size that does not read');
      size = v;
    }
    const prefix = field(h!, 345, 155).toString('utf8');
    const rawName = pax?.get('path') ?? (prefix ? `${prefix}/${field(h!, 0, 100).toString('utf8')}` : field(h!, 0, 100).toString('utf8'));
    pax = undefined;
    const dir = type === '5';
    const name = cleanName(rawName, dir);
    const folded = name.normalize('NFC').toLowerCase();
    if (seen.has(folded)) bad(`two entries named ${JSON.stringify(name.slice(0, 80))} (once folded)`);
    seen.add(folded);
    if (dir) {
      if (!DIRS.has(name) || size !== 0) bad(`a folder a docker save never writes (${JSON.stringify(name.slice(0, 80))})`);
      continue;
    }
    const blob = BLOB.exec(name)?.[1];
    if (!blob && !NAMING.has(name)) bad(`a file a docker save by id never writes (${JSON.stringify(name.slice(0, 80))})`);
    if (!blob) {
      if (size > IMAGE_TAR_JSON_MAX) bad(`${name} is larger than ${IMAGE_TAR_JSON_MAX} bytes`);
      files.set(name, Buffer.from((await r.take(padded(size)))!.subarray(0, size)));
      continue;
    }
    // A blob: streamed into the fresh tar under its name (when it is one to write), its sha256 checked; a small one kept
    // to read as a manifest.
    const writes = o.only === undefined || o.only.has(blob);
    const to = writes ? out : undefined;
    await put(to, header(name, size, '0'));
    const data = await copyBlob(r, to, blob, size);
    blobs.add(blob);
    if (data && keptBytes + size <= KEPT_MAX) {
      kept.set(blob, data);
      keptBytes += size;
    }
  }
  if (pax) bad('a pax header at the end');
  const sha256 = hash.digest('hex');
  if (o.sha256 !== undefined && sha256 !== o.sha256) bad('the file does not hold the bytes recorded at import (sha256)');
  const { ids, tail, referenced } = naming(files, kept, blobs, o.expect);
  if (o.only !== undefined && (referenced.size !== o.only.size || [...referenced].some((b) => !o.only?.has(b)))) bad('it changed while it was read (another set of blobs)');
  for (const b of tail) await put(out, b);
  return { ids, bytes: r.read, sha256, referenced };
}
