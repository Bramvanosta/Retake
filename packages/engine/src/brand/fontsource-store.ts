/**
 * The workspace's font store (R-FLD-45): `<workspace>/.retake/fonts/fontsource/<id>@<version>/` — one folder per package
 * version a font fetch kept (fontsource-fetch.ts, the only writer): its latin WOFF2 files by face
 * (`latin-<weight>-<normal|italic>.woff2`), the package's LICENSE text as it was in the archive, and `record.json` — the
 * package, the resolved version, the licence its publisher declares, the registry used, the tarball's URL and integrity,
 * the sha256 of every file, and the record's own sha256 (`record_sha256`). The hashes detect an accidental change (an edit,
 * a half-copied folder); they do not authenticate anything against a program that writes the workspace (it can rewrite
 * a file and the record together).
 *
 * A theme's create, update and the Studio read a `fontsource:` reference from here only, offline: the path is built from
 * the reference's checked id, version and face (never a path of the reference), every folder on the way and every file
 * a plain one (no link), the record's hash and each file's sha256 checked before a byte is used. A reference without a
 * version takes the newest version stored that has every face asked of that family. Nothing here reaches the network; a reference the store
 * does not hold is refused with the exact fetch to make — checked slugs, versions and weights only.
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@retake/core/base';
import { STATE_DIR, STATE_DIRS, statePath } from '@retake/core/project';
import { FONTSOURCE_ID_RE } from '@retake/core/ids';
import { FONTSOURCE_LICENCES, FONTSOURCE_VERSION_RE, formatFontsourceRef, fontsourcePackage, fontsourceRefProblem, newerVersion, parseFontsourceRef } from '@retake/core/theme';
import type { FontsourceRef } from '@retake/core/theme';
import { EngineError } from '../errors.js';
import { sha256Hex } from '../storage.js';
import type { OpenedWorkspace } from '../workspace.js';
import { BRAND_TOTAL_MAX_BYTES, FONT_MAX_BYTES } from './files.js';
import type { ResolvedBrandFile } from './files.js';

export const RECORD_FILE = 'record.json';
export const LICENCE_FILE = 'LICENSE';
/** A package's LICENSE text, at most. */
export const LICENCE_MAX_BYTES = 256 * 1024;
const RECORD_MAX_BYTES = 64 * 1024;
const FACE_FILE_RE = /^latin-([1-9]00)-(normal|italic)\.woff2$/;

/** The store's folder of a workspace (`.retake/fonts/fontsource`). */
export function fontStoreDir(ws: Pick<OpenedWorkspace, 'root'>): string {
  return statePath(ws.root, 'fonts', 'fontsource');
}

/** The file of one face in a package's folder. */
export function storeFaceFile(weight: number, italic: boolean): string {
  return `latin-${weight}-${italic ? 'italic' : 'normal'}.woff2`;
}

export const StoreRecordSchema = z.strictObject({
  kind: z.literal('retake-font-package'),
  version: z.literal(1),
  package: z.string(),
  id: z.string().regex(FONTSOURCE_ID_RE),
  package_version: z.string().regex(FONTSOURCE_VERSION_RE),
  licence: z.enum(FONTSOURCE_LICENCES),
  registry: z.string(),
  test_registry: z.boolean(),
  tarball: z.string(),
  integrity: z.string(),
  fetched_at: z.string(),
  files: z
    .record(z.string().regex(/^(?:LICENSE|latin-[1-9]00-(?:normal|italic)\.woff2)$/), z.string().regex(/^[0-9a-f]{64}$/))
    .refine((f) => f[LICENCE_FILE] !== undefined && Object.keys(f).length > 1, 'the LICENSE and at least one face'),
  record_sha256: z.string(),
});
export type StoreRecord = z.output<typeof StoreRecordSchema>;

/** The record's own hash: sha256 of its canonical JSON without `record_sha256`. */
export function storeRecordHash(r: Omit<StoreRecord, 'record_sha256'> & { record_sha256?: string }): string {
  const { record_sha256: _h, ...rest } = r;
  return sha256Hex(Buffer.from(canonicalJson(rest)));
}

/** What a theme cites about a stored package (LICENSES.md, the provenance): never the font bytes. */
export interface FontsourceLicence {
  package: string;
  version: string;
  licence: string;
  registry: string;
  test_registry: boolean;
  tarball: string;
  integrity: string;
  /** The package's LICENSE text (third-party text: escaped wherever it is shown). */
  text: string;
}

/** A store font read for a theme: the file, its face and its package's licence. */
export interface StoreFont extends ResolvedBrandFile {
  fontsource: FontsourceLicence & { ref: string; weight: number; italic: boolean };
}

/** A word of a shell command: as it is when plain, else single-quoted. */
function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The fetch a person makes for refs the store lacks: `retake theme fetch-font <refs>` (checked refs only). */
export function fetchCommand(ws: Pick<OpenedWorkspace, 'root'>, refs: readonly string[]): string {
  return `retake -C ${shellWord(ws.root)} theme fetch-font ${refs.join(' ')}`;
}

/** Who reads the store: a person at a terminal (the fetch to make is their command) or an agent (font_fetch, approved). */
export type StoreReader = 'cli' | 'agent';

function missing(ws: Pick<OpenedWorkspace, 'root'>, refs: FontsourceRef[], why: string, reader: StoreReader): EngineError {
  const r = refs.map(formatFontsourceRef);
  const fix = fetchCommand(ws, r);
  const how =
    reader === 'cli'
      ? `fetch it first: ${fix}`
      : `fetch it first with font_fetch {refs: [${r.map((x) => `"${x}"`).join(', ')}]} (the user approves it), or the person runs it in a terminal`;
  return new EngineError('not_found', `font ${r.join(', ')}: ${why} — ${how}`, { fix });
}

/** A plain folder or file (never a link); null when absent. */
async function plain(p: string, dir: boolean): Promise<boolean> {
  const st = await lstat(p).catch(() => null);
  if (!st) return false;
  if (dir ? !st.isDirectory() : !st.isFile()) throw new EngineError('refused', `${p} in the font store is not a plain ${dir ? 'folder' : 'file'} (a link?): it is never followed`);
  return true;
}

async function storeFolders(ws: Pick<OpenedWorkspace, 'root'>, make = false): Promise<string | null> {
  let at = ws.root;
  // Each level checked before the next is made, one at a time: a link on the way is refused, never written through.
  for (const seg of [STATE_DIR, STATE_DIRS.fonts, 'fontsource']) {
    at = join(at, seg);
    if (await plain(at, true)) continue;
    if (!make) return null;
    await mkdir(at).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    if (!(await plain(at, true))) throw new EngineError('refused', `${at} could not be made as a plain folder: no font is stored there`);
  }
  return at;
}

async function readCapped(p: string, max: number): Promise<Buffer> {
  const st = await lstat(p);
  if (!st.isFile() || st.size > max) throw new EngineError('refused', `${p} in the font store is not a plain file of at most ${max} bytes`);
  const b = await readFile(p);
  if (b.length > max) throw new EngineError('refused', `${p} in the font store grew while it was read`);
  return b;
}

/** The record of a stored package version, checked (its hash, its folder's name); null when the store does not hold it. */
export async function readStoreRecord(ws: Pick<OpenedWorkspace, 'root'>, id: string, version: string): Promise<{ dir: string; record: StoreRecord } | null> {
  const store = await storeFolders(ws);
  if (!store) return null;
  const dir = join(store, `${id}@${version}`);
  if (!(await plain(dir, true))) return null;
  if (!(await plain(join(dir, RECORD_FILE), false))) return null;
  let parsed: StoreRecord;
  try {
    parsed = StoreRecordSchema.parse(JSON.parse((await readCapped(join(dir, RECORD_FILE), RECORD_MAX_BYTES)).toString('utf8')));
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError('refused', `the font store's record of ${fontsourcePackage(id)}@${version} is not one Retake wrote: fetch it again (font_fetch) after removing ${dir}`);
  }
  if (parsed.record_sha256 !== storeRecordHash(parsed) || parsed.id !== id || parsed.package_version !== version || parsed.package !== fontsourcePackage(id)) {
    throw new EngineError('refused', `the font store's record of ${fontsourcePackage(id)}@${version} was changed since it was written: remove ${dir} and fetch it again`);
  }
  return { dir, record: parsed };
}

/** A stored file, read and checked against the record's sha256. */
export async function readStoreFile(dir: string, record: StoreRecord, file: string, max: number): Promise<Buffer> {
  const want = record.files[file];
  if (want === undefined) throw new EngineError('internal', `${file} is not in the record`);
  const bytes = await readCapped(join(dir, file), max).catch((e: unknown) => {
    throw e instanceof EngineError ? e : new EngineError('refused', `${join(dir, file)} is missing from the font store: remove ${dir} and fetch the package again`);
  });
  if (sha256Hex(bytes) !== want) throw new EngineError('refused', `${join(dir, file)} was changed since it was fetched: remove ${dir} and fetch the package again`);
  return bytes;
}

/** The versions of a fontsource id the store holds, newest first (folders named `<id>@<version>`). */
export async function storedVersions(ws: Pick<OpenedWorkspace, 'root'>, id: string): Promise<string[]> {
  const store = await storeFolders(ws);
  if (!store) return [];
  const names = await readdir(store).catch(() => [] as string[]);
  return names
    .filter((n) => n.startsWith(`${id}@`) && FONTSOURCE_VERSION_RE.test(n.slice(id.length + 1)))
    .map((n) => n.slice(id.length + 1))
    .sort((a, b) => (newerVersion(a, b) ? -1 : newerVersion(b, a) ? 1 : 0));
}

/** A reference parsed, or `invalid` saying why. */
function parsed(raw: string): FontsourceRef {
  const ref = parseFontsourceRef(raw);
  if (!ref) throw new EngineError('invalid', `font ${raw}: ${fontsourceRefProblem(raw)}`);
  return ref;
}

/**
 * References with their version: as given, or — for the unpinned ones of one family together — the newest version stored
 * that holds every face asked of that family (one version per family in a theme). not_found (with the fetch to make)
 * when no stored version holds them all. Keyed by the reference as given.
 */
export async function pinStoreRefs(ws: Pick<OpenedWorkspace, 'root'>, raws: readonly string[], reader: StoreReader = 'agent'): Promise<Map<string, FontsourceRef>> {
  const out = new Map<string, FontsourceRef>();
  const loose = new Map<string, Array<{ raw: string; ref: FontsourceRef }>>();
  for (const raw of raws) {
    const ref = parsed(raw);
    if (ref.version !== undefined) out.set(raw, ref);
    else (loose.get(ref.id) ?? loose.set(ref.id, []).get(ref.id)!).push({ raw, ref });
  }
  for (const [id, refs] of loose) {
    let version: string | undefined;
    for (const v of await storedVersions(ws, id)) {
      const r = await readStoreRecord(ws, id, v);
      if (r && refs.every((x) => r.record.files[storeFaceFile(x.ref.weight, x.ref.italic)])) {
        version = v;
        break;
      }
    }
    if (version === undefined) {
      throw missing(
        ws,
        refs.map((x) => x.ref),
        `the font store has no ${fontsourcePackage(id)} version with ${refs.length === 1 ? 'this face' : 'all these faces'}`,
        reader,
      );
    }
    for (const x of refs) out.set(x.raw, { ...x.ref, version });
  }
  return out;
}

/** One reference with its version (pinStoreRefs of one). */
export async function pinStoreRef(ws: Pick<OpenedWorkspace, 'root'>, raw: string, reader: StoreReader = 'agent'): Promise<FontsourceRef> {
  return (await pinStoreRefs(ws, [raw], reader)).get(raw)!;
}

/** The licence a stored package cites (its record and LICENSE text, checked). */
export async function storeLicence(ws: Pick<OpenedWorkspace, 'root'>, ref: FontsourceRef & { version: string }, reader: StoreReader = 'agent'): Promise<FontsourceLicence> {
  const r = await readStoreRecord(ws, ref.id, ref.version);
  if (!r) throw missing(ws, [ref], `the font store has no ${fontsourcePackage(ref.id)}@${ref.version}`, reader);
  const text = (await readStoreFile(r.dir, r.record, LICENCE_FILE, LICENCE_MAX_BYTES)).toString('utf8');
  const { record } = r;
  return { package: record.package, version: record.package_version, licence: record.licence, registry: record.registry, test_registry: record.test_registry, tarball: record.tarball, integrity: record.integrity, text };
}

/**
 * A `fontsource:` font read from the store for a theme (files.ts readBrandFile, any trust): the face's file, checked, and
 * its package's licence. Counts against the brand budget as a brand file does.
 */
export async function readStoreFont(ws: Pick<OpenedWorkspace, 'root'>, raw: string, budget?: { left: number }, reader: StoreReader = 'agent'): Promise<StoreFont> {
  const pinned = (await pinStoreRef(ws, raw, reader)) as FontsourceRef & { version: string };
  const r = await readStoreRecord(ws, pinned.id, pinned.version);
  if (!r) throw missing(ws, [pinned], `the font store has no ${fontsourcePackage(pinned.id)}@${pinned.version}`, reader);
  const file = storeFaceFile(pinned.weight, pinned.italic);
  if (!r.record.files[file]) {
    const faces = Object.keys(r.record.files)
      .filter((f) => FACE_FILE_RE.test(f))
      .map((f) => f.replace(FACE_FILE_RE, (_m, w: string, s: string) => `${w}${s === 'italic' ? 'italic' : ''}`));
    throw missing(ws, [pinned], `the font store holds ${fontsourcePackage(pinned.id)}@${pinned.version} with ${faces.join(', ') || 'no face'}, not this one`, reader);
  }
  const bytes = await readStoreFile(r.dir, r.record, file, FONT_MAX_BYTES);
  if (budget) {
    if (bytes.length > budget.left) throw new EngineError('invalid', `the brand files are more than ${BRAND_TOTAL_MAX_BYTES} bytes together`);
    budget.left -= bytes.length;
  }
  const licence = await storeLicence(ws, pinned, reader);
  return { ref: formatFontsourceRef(pinned), path: join(r.dir, file), ext: '.woff2', bytes, fontsource: { ...licence, ref: formatFontsourceRef(pinned), weight: pinned.weight, italic: pinned.italic } };
}

/**
 * Write one package version's folder: its files and record, in a fresh sibling folder renamed into place (the one it
 * replaces — the same version with fewer faces — removed after), so a reader never sees half a package.
 */
export async function writeStorePackage(ws: Pick<OpenedWorkspace, 'root'>, record: Omit<StoreRecord, 'record_sha256'>, files: Map<string, Buffer>): Promise<string> {
  const store = (await storeFolders(ws, true))!;
  const name = `${record.id}@${record.package_version}`;
  const final = join(store, name);
  // What an interrupted write of this package left (its stage, the folder it was replacing): plain folders only.
  for (const left of await readdir(store)) {
    if (!left.startsWith(`.stage-${name}-`) && !left.startsWith(`.old-${name}-`)) continue;
    const st = await lstat(join(store, left));
    if (st.isDirectory()) await rm(join(store, left), { recursive: true, force: true });
  }
  const stage = join(store, `.stage-${name}-${randomBytes(6).toString('hex')}`);
  await mkdir(stage);
  try {
    for (const [name, bytes] of files) await writeFile(join(stage, name), bytes, { flag: 'wx' });
    const full: StoreRecord = { ...record, record_sha256: storeRecordHash(record) };
    await writeFile(join(stage, RECORD_FILE), `${JSON.stringify(full, null, 2)}\n`, { flag: 'wx' });
    let old: string | undefined;
    if (await plain(final, true)) {
      old = join(store, `.old-${name}-${randomBytes(6).toString('hex')}`);
      await rename(final, old);
    }
    await rename(stage, final);
    if (old) await rm(old, { recursive: true, force: true });
  } catch (e) {
    await rm(stage, { recursive: true, force: true });
    throw e;
  }
  return final;
}

/** Every face the store holds, as references (`fontsource:<id>@<version>:<weight>[italic]`), with their sizes: the Studio's brand files. */
export async function storeFaces(ws: Pick<OpenedWorkspace, 'root'>): Promise<Array<{ ref: string; bytes: number }>> {
  const store = await storeFolders(ws).catch(() => null);
  if (!store) return [];
  const out: Array<{ ref: string; bytes: number }> = [];
  for (const name of (await readdir(store).catch(() => [] as string[])).sort()) {
    const at = name.lastIndexOf('@');
    if (at <= 0) continue;
    const id = name.slice(0, at);
    const version = name.slice(at + 1);
    if (!FONTSOURCE_ID_RE.test(id) || !FONTSOURCE_VERSION_RE.test(version)) continue;
    const r = await readStoreRecord(ws, id, version).catch(() => null);
    if (!r) continue;
    for (const f of Object.keys(r.record.files).sort()) {
      const m = FACE_FILE_RE.exec(f);
      if (!m) continue;
      const st = await lstat(join(r.dir, f)).catch(() => null);
      if (st?.isFile()) out.push({ ref: formatFontsourceRef({ id, version, weight: Number(m[1]), italic: m[2] === 'italic' }), bytes: st.size });
    }
  }
  return out;
}
