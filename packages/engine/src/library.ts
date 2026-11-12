/**
 * L4.7 library previews (R-UI-06 / R-UI-06b): the posters and loops of the Studio's component library, rendered by the
 * jobs worker (a `preview` job, target `library`) into a content-keyed cache the Studio reads.
 *
 * **Keys** (critique B3): one builder for the Studio (what is cached?) and the worker (where to write) —
 * `libraryKeyContext` + `libraryPreviewKey`. A key is the sha256 (32 hex) of: LIBRARY_PREVIEW_FORMAT; the editor's
 * `compositionHash()` (composition + kit + Remotion versions); the render browser's identity; the kind and its output settings (poster: 960×540 under
 * 200 KB; loop: LOOP_FORMAT); the theme folder's `themeContentHash`; the spec the worker renders, built with every
 * served URL replaced by `asset:<sha256 of the file>` (theme fonts / logo / wordmark, sample screens and media); and
 * for every component the spec uses (the target and its context: the theme's layout, caption, card) its
 * `componentFolderHash` — every code file, manifest and asset of its registry folder by bytes (the bundle's and the
 * preview allow-list's own definition of "this component's content"). A component whose spec cannot be built gets a
 * key over its folder and the error (a failure recorded under it is retried once the component changes).
 *
 * **Cache** `<workspace>/.retake/cache/previews/<key>/` (B4, B17): `.retake`, `cache` and `previews` are real
 * folders (a link or a file there is refused, nothing is written); an entry is written into `<key>.tmp-<pid>-<hex>/` and
 * the folder renamed into place, `meta.json` (or `failed.json`) last — an entry is complete or absent. One entry per key:
 * `meta.json` + `poster.png` / `loop.gif`, `meta.json` alone for a loop too large to keep, or `failed.json` (the reason:
 * untrusted text, capped, with the registry bundle's hash) — a failed key is left alone until an explicit Retry while
 * the registry is unchanged; a failure under another registry bundle reads as missing (asked again once). Read with `readPlainFile` (no link,
 * regular file, one link count, capped) and a magic check (PNG / GIF89a); the meta must name its key. The prune (end of
 * each library job) sweeps temporary folders older than an hour and, over 400 entries or 200 MB, drops other versions of
 * the job's theme first, then the least recently read (the Studio touches meta.json when it reads an image); it lstat()s
 * every entry and touches only names of the key / temporary shapes.
 *
 * **Disk** (B4): a library job is refused under 1 GB free (`statfs`), and a full disk during one stops it with the same
 * sentence ("the disk has N MB free").
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, lutimes, mkdir, readdir, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { realPathOf } from '@retake/core/policy';
import { statePath, STATE_DIR, STATE_DIRS } from '@retake/core/project';
import { insideFolder } from '@retake/core/scenario';
import { LIBRARY_PREVIEW_KEY_RE } from './jobs/job-input.js';
import { STARTER_TEMPLATES_DIR, readPlainFile, nodeFileFacts } from '@retake/core/io';
import type { LoadedTemplate } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { ComponentRegistry, JsonSchemaNode } from '@retake/components';
import type { PreviewSamples } from '@retake/editor';
import { components } from './components.js';
import { EngineError } from './errors.js';
import { editor } from './lazy.js';
import type { OpenedWorkspace } from './workspace.js';

/** Bump when the cache layout or what a key covers changes (every key changes). */
export const LIBRARY_PREVIEW_FORMAT = 1;
/** The prune keeps at most this many entries… */
export const LIBRARY_CACHE_MAX_ENTRIES = 400;
/** …and at most this many bytes. */
export const LIBRARY_CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** A library job needs this much free disk (critique B4). */
export const LIBRARY_DISK_MIN_BYTES = 1_000_000_000;
/** Abandoned temporary entry folders older than this are swept. */
export const LIBRARY_TMP_MAX_AGE_MS = 3600_000;
/** meta.json / failed.json at most. */
export const LIBRARY_META_MAX = 8192;
/** A failure's reason kept at most (untrusted text). */
export const LIBRARY_REASON_MAX = 2000;

export type LibraryPreviewKind = 'poster' | 'loop';

/** The files of an entry. */
export const LIBRARY_FILES = { poster: 'poster.png', loop: 'loop.gif', meta: 'meta.json', failed: 'failed.json' } as const;

const TMP_RE = /^([0-9a-f]{32})\.tmp-\d+-[0-9a-f]{8}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_MAGIC = Buffer.from('GIF89a', 'latin1');

/** <workspace>/.retake/cache/previews */
export function libraryCacheDir(ws: Pick<OpenedWorkspace, 'root'>): string {
  return statePath(resolve(ws.root), 'cache', 'previews');
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** What every key of one theme and one registry state shares (built once per Studio read / per job). */
export interface LibraryKeyContext {
  template: LoadedTemplate;
  registry: ComponentRegistry;
  /** themeContentHash of the theme folder. */
  themeHash: string;
  composition: string;
  samples: PreviewSamples;
  /**
   * The render browser's identity (editor renderBrowserIdentity: its executable by path, size and date — review A L3)
   * and the GL the render policy resolves (editor previewGlKey, L5.15).
   */
  browser: string;
  /** Component id → componentFolderHash (memo). */
  folders: Map<string, string>;
  /** File → sha256 (memo). */
  files: Map<string, string>;
  /**
   * The hash of the whole registry's bundle (editor bundleHash of every usable component and the scaffolds; computed once,
   * when first asked). A failure is recorded under it: once any component, the kit or the composition changes, the
   * failure is stale and the key is asked again without a Retry (review A M3 / B H1).
   */
  registryHash: () => Promise<string>;
}

export async function libraryKeyContext(template: LoadedTemplate, registry: ComponentRegistry, o: { browser?: string; policy: WorkPolicy }): Promise<LibraryKeyContext> {
  const ed = await editor();
  let registryHash: Promise<string> | undefined;
  return {
    template,
    registry,
    themeHash: ed.themeContentHash(template.dir),
    composition: await ed.compositionHash(),
    samples: ed.loadPreviewSamples(),
    // The GL the previews are drawn with is part of the picture (L5.15, critique M1): the resolved policy, which the
    // Studio server and the job process compute alike (same retake.yaml, same environment), never the GL a job found.
    browser: o.browser ?? `${ed.renderBrowserIdentity()} gl=${ed.previewGlKey(o.policy)}`,
    folders: new Map(),
    files: new Map(),
    registryHash: () => (registryHash ??= libraryRegistryHash(registry)),
  };
}

/** The registry bundle's hash (see LibraryKeyContext.registryHash). */
export async function libraryRegistryHash(registry: ComponentRegistry): Promise<string> {
  const ed = await editor();
  return ed.bundleHash(await ed.registryBundleComponents(registry));
}

/** Whether a recorded failure still holds: recorded under the registry bundle as it is now (else it is stale: missing). */
export function failureIsCurrent(f: Pick<LibraryFailure, 'bundle'>, registryHash: string): boolean {
  return typeof f.bundle === 'string' && f.bundle === registryHash;
}

function fileSha(ctx: LibraryKeyContext, file: string): string {
  let h = ctx.files.get(file);
  if (h === undefined) {
    try {
      h = createHash('sha256').update(readFileSync(file)).digest('hex');
    } catch (e) {
      h = `unreadable:${(e as NodeJS.ErrnoException).code ?? 'error'}`;
    }
    ctx.files.set(file, h);
  }
  return h;
}

async function folderHashOf(ctx: LibraryKeyContext, id: string): Promise<string> {
  let h = ctx.folders.get(id);
  if (h === undefined) {
    const [ed, comps] = [await editor(), await components()];
    const info = ctx.registry.get(id);
    h = await ed.componentFolderHash({ id, dir: info.dir, entry: info.entry, defaults: comps.paramDefaults(info.manifest.params as JsonSchemaNode | undefined) });
    ctx.folders.set(id, h);
  }
  return h;
}

/** The key of a component's poster or loop in the context's theme (throws when the id is not in the registry). */
export async function libraryPreviewKey(ctx: LibraryKeyContext, id: string, kind: LibraryPreviewKind): Promise<string> {
  const [ed, comps] = [await editor(), await components()];
  const info = ctx.registry.get(id);
  const tpl = ctx.template;
  const url = (f: string) => `asset:${fileSha(ctx, f)}`;
  const h = createHash('sha256');
  const add = (label: string, data: string) => {
    h.update(`${label}\0${Buffer.byteLength(data)}\0`);
    h.update(data);
    h.update('\0');
  };
  add('format', String(LIBRARY_PREVIEW_FORMAT));
  add('composition', ctx.composition);
  add('browser', ctx.browser);
  add('kind', kind);
  add('output', JSON.stringify(kind === 'poster' ? { size: comps.PREVIEW_SIZE, max_bytes: comps.PREVIEW_MAX_BYTES } : ed.LOOP_FORMAT));
  add('theme', ctx.themeHash);
  add('target', `${id} ${await folderHashOf(ctx, id)}`);
  let built: ReturnType<typeof ed.buildComponentPreview> | undefined;
  let error: string | undefined;
  try {
    const tokens = comps.themeTokens(tpl, {
      logo: url(tpl.assets.logo),
      wordmark: tpl.assets.wordmark ? url(tpl.assets.wordmark) : undefined,
      fonts: { display: url(tpl.assets.display), body: tpl.assets.body.map(url) },
    });
    built = ed.buildComponentPreview({
      target: { id, manifest: info.manifest },
      template: tpl,
      tokens,
      registry: ctx.registry,
      samples: ctx.samples,
      sampleUrl: url,
      ...(kind === 'loop' ? { motion: true } : {}),
    });
  } catch (e) {
    error = (e as Error)?.message ?? String(e);
  }
  if (built) {
    add('spec', JSON.stringify(built.spec));
    for (const c of built.components) add(`component:${c}`, await folderHashOf(ctx, c));
  } else add('unbuildable', error ?? '');
  return h.digest('hex').slice(0, 32);
}

// ── Cache folder ─────────────────────────────────────────────────────────────

/**
 * The cache folder, made when missing: `.retake`, `cache` and `previews` each a real folder (not a link, not a
 * file) inside the workspace once links are followed — else refused and nothing is written (B17).
 */
export async function ensureLibraryCacheDir(ws: Pick<OpenedWorkspace, 'root'>): Promise<string> {
  let parent = resolve(ws.root);
  for (const seg of [STATE_DIR, STATE_DIRS.cache, 'previews']) {
    parent = join(parent, seg);
    await mkdir(parent).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const st = await lstat(parent);
    if (!st.isDirectory()) throw new EngineError('refused', `${parent} is not a folder (a link or a file): library previews are written only into plain folders of the workspace — remove it`);
  }
  if (!insideFolder(realPathOf(resolve(ws.root), nodeFileFacts), realPathOf(parent, nodeFileFacts), nodeFileFacts)) throw new EngineError('refused', `${parent} leaves the workspace: library previews stay in it`);
  return parent;
}

/** The cache folder when each segment is a real folder already (reads never make or follow anything), else null. */
export async function plainLibraryCacheDir(ws: Pick<OpenedWorkspace, 'root'>): Promise<string | null> {
  let parent = resolve(ws.root);
  for (const seg of [STATE_DIR, STATE_DIRS.cache, 'previews']) {
    parent = join(parent, seg);
    const st = await lstat(parent).catch(() => null);
    if (!st?.isDirectory()) return null;
  }
  return parent;
}

/** What a cache entry holds. */
export interface LibraryEntryMeta {
  format: typeof LIBRARY_PREVIEW_FORMAT;
  key: string;
  kind: LibraryPreviewKind;
  component: string;
  theme: { name: string; hash: string };
  at: string;
  /** `too_large`: a loop over LOOP_FORMAT.max_bytes even at the fallback width (no image). */
  state: 'ok' | 'too_large';
  bytes: number;
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  duration_s?: number;
}

/** failed.json */
export interface LibraryFailure {
  format: typeof LIBRARY_PREVIEW_FORMAT;
  key: string;
  kind: LibraryPreviewKind;
  component: string;
  theme: { name: string; hash: string };
  at: string;
  /** The editor's / the component's words: untrusted, capped. */
  reason: string;
  /** The registry bundle's hash when it failed (LibraryKeyContext.registryHash); absent or another: stale. */
  bundle?: string;
}

export type LibraryEntry =
  | { state: 'missing' }
  | { state: 'cached'; meta: LibraryEntryMeta }
  | { state: 'too_large'; meta: LibraryEntryMeta }
  | { state: 'failed'; failure: LibraryFailure };

function jsonOf(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

const oneLink = (st: { nlink: number }) => st.nlink === 1;

function metaOk(m: unknown, key: string): m is LibraryEntryMeta {
  const x = m as Partial<LibraryEntryMeta> | undefined;
  return (
    !!x &&
    x.format === LIBRARY_PREVIEW_FORMAT &&
    x.key === key &&
    (x.kind === 'poster' || x.kind === 'loop') &&
    (x.state === 'ok' || (x.state === 'too_large' && x.kind === 'loop')) &&
    typeof x.component === 'string' &&
    typeof x.bytes === 'number'
  );
}

function failureOk(m: unknown, key: string): m is LibraryFailure {
  const x = m as Partial<LibraryFailure> | undefined;
  return (
    !!x &&
    x.format === LIBRARY_PREVIEW_FORMAT &&
    x.key === key &&
    (x.kind === 'poster' || x.kind === 'loop') &&
    typeof x.component === 'string' &&
    typeof x.reason === 'string' &&
    (x.bundle === undefined || typeof x.bundle === 'string')
  );
}

/** The image cap of a kind (bytes). */
async function imageCap(kind: LibraryPreviewKind): Promise<number> {
  return kind === 'poster' ? (await components()).PREVIEW_MAX_BYTES : (await editor()).LOOP_FORMAT.max_bytes;
}

/** An entry's image bytes when it is a plain file of its kind (magic, cap), else null. */
async function entryImage(entryDir: string, kind: LibraryPreviewKind): Promise<Buffer | null> {
  const r = readPlainFile(join(entryDir, LIBRARY_FILES[kind]), await imageCap(kind), { verify: oneLink });
  if (!r.ok) return null;
  const magic = kind === 'poster' ? PNG_MAGIC : GIF_MAGIC;
  return r.bytes.subarray(0, magic.length).equals(magic) ? r.bytes : null;
}

/**
 * The entry of a key: `cached` (meta + a plain image of its kind), `too_large`, `failed` (failed.json), or `missing` —
 * also for anything else there (a link, a file, an incomplete or planted folder: the worker replaces it).
 */
export async function readLibraryEntry(cacheDir: string, key: string, o: { image?: boolean } = {}): Promise<LibraryEntry & { image?: Buffer }> {
  if (!LIBRARY_PREVIEW_KEY_RE.test(key)) return { state: 'missing' };
  const dir = join(cacheDir, key);
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory()) return { state: 'missing' };
  const meta = readPlainFile(join(dir, LIBRARY_FILES.meta), LIBRARY_META_MAX, { verify: oneLink });
  if (meta.ok) {
    const m = jsonOf(meta.bytes);
    if (!metaOk(m, key)) return { state: 'missing' };
    if (m.state === 'too_large') return { state: 'too_large', meta: m };
    const image = await entryImage(dir, m.kind);
    if (!image) return { state: 'missing' };
    return { state: 'cached', meta: m, ...(o.image ? { image } : {}) };
  }
  const failed = readPlainFile(join(dir, LIBRARY_FILES.failed), LIBRARY_META_MAX, { verify: oneLink });
  if (failed.ok) {
    const f = jsonOf(failed.bytes);
    if (failureOk(f, key)) return { state: 'failed', failure: f };
  }
  return { state: 'missing' };
}

/**
 * A cached image for the Studio (B6 caps are the kinds' caps): its bytes and kind, meta.json touched (the prune drops
 * the least recently read first). Null for anything but a complete entry.
 */
export async function readLibraryImage(ws: Pick<OpenedWorkspace, 'root'>, key: string): Promise<{ kind: LibraryPreviewKind; component: string; bytes: Buffer } | null> {
  const dir = await plainLibraryCacheDir(ws);
  if (!dir) return null;
  const e = await readLibraryEntry(dir, key, { image: true });
  if (e.state !== 'cached' || !e.image) return null;
  const now = new Date();
  await lutimes(join(dir, key, LIBRARY_FILES.meta), now, now).catch(() => undefined);
  return { kind: e.meta.kind, component: e.meta.component, bytes: e.image };
}

/** Remove what lies at `p` without following a link (a link or a file unlinked, a real folder removed whole). */
async function removeEntry(p: string): Promise<void> {
  const st = await lstat(p).catch(() => null);
  if (!st) return;
  if (st.isDirectory()) await rm(p, { recursive: true, force: true });
  else await unlink(p).catch(() => undefined);
}

/** A new temporary entry folder for `key` (non-recursive: never an existing one). */
export async function stageLibraryEntry(cacheDir: string, key: string): Promise<string> {
  if (!LIBRARY_PREVIEW_KEY_RE.test(key)) throw new EngineError('invalid', `not a library preview key: ${key}`);
  const tmp = join(cacheDir, `${key}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  await mkdir(tmp);
  return tmp;
}

/**
 * Write `meta` (or the failure) into the temporary folder last and rename it into place. An entry already there that
 * reads complete is kept (another job wrote the same content: the temporary folder goes); anything else there is
 * removed first (never followed).
 */
export async function commitLibraryEntry(cacheDir: string, key: string, tmp: string, record: { meta: LibraryEntryMeta } | { failure: LibraryFailure }): Promise<void> {
  if ('meta' in record) await writeFile(join(tmp, LIBRARY_FILES.meta), `${JSON.stringify(record.meta, null, 1)}\n`, { flag: 'wx' });
  else await writeFile(join(tmp, LIBRARY_FILES.failed), `${JSON.stringify(record.failure, null, 1)}\n`, { flag: 'wx' });
  const final = join(cacheDir, key);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, final);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt > 0 || (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR' && code !== 'EISDIR')) throw e;
      const have = await readLibraryEntry(cacheDir, key);
      if (have.state === 'cached' || have.state === 'too_large') {
        await rm(tmp, { recursive: true, force: true });
        return;
      }
      await removeEntry(final);
    }
  }
}

/** Remove a key's entry (an explicit Retry of a failed key). */
export async function dropLibraryEntry(cacheDir: string, key: string): Promise<void> {
  if (LIBRARY_PREVIEW_KEY_RE.test(key)) await removeEntry(join(cacheDir, key));
}

/** A failure's reason as kept: one line of printable text, capped. */
export function libraryReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = reason
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return flat.length > LIBRARY_REASON_MAX ? `${flat.slice(0, LIBRARY_REASON_MAX - 1)}…` : flat;
}

/** Sweep abandoned temporary folders and prune over the caps (see the module comment). Returns what it removed. */
export async function pruneLibraryCache(cacheDir: string, o: { theme?: { name: string; hash: string }; now?: number; maxEntries?: number; maxBytes?: number } = {}): Promise<{ swept: number; pruned: number }> {
  const now = o.now ?? Date.now();
  const maxEntries = o.maxEntries ?? LIBRARY_CACHE_MAX_ENTRIES;
  const maxBytes = o.maxBytes ?? LIBRARY_CACHE_MAX_BYTES;
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return { swept: 0, pruned: 0 };
  }
  let swept = 0;
  const entries: Array<{ name: string; bytes: number; read: number; otherVersion: boolean }> = [];
  for (const name of names) {
    const p = join(cacheDir, name);
    if (TMP_RE.test(name)) {
      const st = await lstat(p).catch(() => null);
      if (st && now - st.mtimeMs > LIBRARY_TMP_MAX_AGE_MS) {
        await removeEntry(p);
        swept++;
      }
      continue;
    }
    if (!LIBRARY_PREVIEW_KEY_RE.test(name)) continue;
    const st = await lstat(p).catch(() => null);
    if (!st) continue;
    if (!st.isDirectory()) {
      // A link or a file named like a key: never an entry.
      await removeEntry(p);
      continue;
    }
    let bytes = 0;
    // Last read: meta.json's / failed.json's mtime (the Studio touches it), else the folder's.
    let read: number | undefined;
    let theme: { name?: string; hash?: string } | undefined;
    for (const f of await readdir(p).catch(() => [] as string[])) {
      const fst = await lstat(join(p, f)).catch(() => null);
      if (!fst) continue;
      bytes += fst.isFile() ? fst.size : 0;
      if ((f === LIBRARY_FILES.meta || f === LIBRARY_FILES.failed) && fst.isFile()) {
        read = Math.max(read ?? 0, fst.mtimeMs);
        const r = readPlainFile(join(p, f), LIBRARY_META_MAX, { verify: oneLink });
        if (r.ok) theme = (jsonOf(r.bytes) as { theme?: { name?: string; hash?: string } } | undefined)?.theme;
      }
    }
    const otherVersion = !!o.theme && theme?.name === o.theme.name && theme?.hash !== o.theme.hash;
    entries.push({ name, bytes, read: read ?? st.mtimeMs, otherVersion });
  }
  let count = entries.length;
  let total = entries.reduce((s, e) => s + e.bytes, 0);
  let pruned = 0;
  if (count > maxEntries || total > maxBytes) {
    entries.sort((a, b) => Number(b.otherVersion) - Number(a.otherVersion) || a.read - b.read);
    for (const e of entries) {
      if (count <= maxEntries && total <= maxBytes) break;
      await removeEntry(join(cacheDir, e.name));
      count--;
      total -= e.bytes;
      pruned++;
    }
  }
  return { swept, pruned };
}

// ── Disk ─────────────────────────────────────────────────────────────────────

/** Free bytes on the disk of `dir` (statfs), or undefined when it cannot be measured. */
export async function freeBytesOf(dir: string): Promise<number | undefined> {
  try {
    const f = await statfs(dir);
    return f.bavail * f.bsize;
  } catch {
    return undefined;
  }
}

/** The sentence of a library job refused or stopped for disk space. */
export function diskSentence(free: number | undefined): string {
  const mb = free === undefined ? 'almost no' : String(Math.floor(free / 1_000_000));
  return `the disk has ${mb} MB free: library previews need at least 1 GB free — free some space (\`retake prune <project>\` removes failed takes, dry runs and old renders) and try again`;
}

/** Refuse a library job under LIBRARY_DISK_MIN_BYTES free (unmeasurable: allowed). */
export async function checkLibraryDisk(dir: string, freeBytes: (dir: string) => Promise<number | undefined> = freeBytesOf): Promise<void> {
  const free = await freeBytes(dir);
  if (free !== undefined && free < LIBRARY_DISK_MIN_BYTES) throw new EngineError('refused', diskSentence(free), { details: { free_bytes: free } });
}

// ── States ───────────────────────────────────────────────────────────────────

export type LibraryPosterState = 'committed' | 'cached' | 'failed' | 'missing';
export type LibraryLoopState = 'cached' | 'too_large' | 'failed' | 'missing';

export interface LibraryItemState {
  component: string;
  poster: { key: string; state: LibraryPosterState; untrusted?: { reason: string } };
  loop: { key: string; state: LibraryLoopState; untrusted?: { reason: string } };
}

export interface LibraryStatesView {
  theme: { name: string; hash: string; editorial_starter: boolean };
  items: LibraryItemState[];
}

/**
 * Is this theme folder the editorial starter shipped with Retake (by real path, B15: a workspace whose
 * templates_dir is the starters folder lists it as `workspace`)?
 */
export function isEditorialStarter(template: Pick<LoadedTemplate, 'dir'>): boolean {
  return realPathOf(resolve(template.dir), nodeFileFacts) === realPathOf(join(STARTER_TEMPLATES_DIR, 'editorial'), nodeFileFacts);
}

/** readLibraryEntry, a failure recorded under another registry bundle read as `missing` (asked again once). */
export async function currentEntry(ctx: Pick<LibraryKeyContext, 'registryHash'>, cacheDir: string, key: string): Promise<LibraryEntry> {
  const e = await readLibraryEntry(cacheDir, key);
  if (e.state === 'failed' && !failureIsCurrent(e.failure, await ctx.registryHash())) return { state: 'missing' };
  return e;
}

/**
 * The cache states of `ids` (default: every registry component) in the context's theme, with their keys. A built-in's
 * committed preview.png is the poster in the editorial starter while it is fresh (Q7, B15): a workspace component's own
 * preview.png is never used (who wrote it is unknown), nor a workspace override of a built-in id.
 */
export async function libraryStates(ws: Pick<OpenedWorkspace, 'root'>, ctx: LibraryKeyContext, ids?: readonly string[]): Promise<LibraryStatesView> {
  const comps = await components();
  const dir = await plainLibraryCacheDir(ws);
  const editorial = isEditorialStarter(ctx.template);
  const list = ids ?? ctx.registry.list().map((i) => i.manifest.id);
  const items: LibraryItemState[] = [];
  for (const id of list) {
    const info = ctx.registry.get(id);
    const posterKey = await libraryPreviewKey(ctx, id, 'poster');
    const loopKey = await libraryPreviewKey(ctx, id, 'loop');
    const pe = dir ? await currentEntry(ctx, dir, posterKey) : ({ state: 'missing' } as const);
    const le = dir ? await currentEntry(ctx, dir, loopKey) : ({ state: 'missing' } as const);
    let poster: LibraryItemState['poster'] = { key: posterKey, state: pe.state === 'too_large' ? 'missing' : pe.state, ...(pe.state === 'failed' ? { untrusted: { reason: pe.failure.reason } } : {}) };
    if (poster.state !== 'cached' && editorial && info.source === 'builtin' && comps.previewStatus(info.dir, { theme: 'editorial' }).state === 'fresh') poster = { key: posterKey, state: 'committed' };
    items.push({ component: id, poster, loop: { key: loopKey, state: le.state, ...(le.state === 'failed' ? { untrusted: { reason: le.failure.reason } } : {}) } });
  }
  return { theme: { name: ctx.template.name, hash: ctx.themeHash, editorial_starter: editorial }, items };
}
