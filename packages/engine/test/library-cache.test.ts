/**
 * L4.7 library preview keys and cache (engine library.ts), no render: the key changes with an imported PNG's bytes (where
 * componentSourceHash does not), an unimported JSON, a context component's file (the theme's layout), a theme font, the
 * sample screens, the kind and the composition — and with nothing else (an unrelated component, a fresh context); the
 * cache folder's segments are real folders (a linked `cache` is refused, nothing written through it); entries are read
 * only when complete and plain (planted link, FIFO, hard link, wrong magic, oversize, a meta naming another key: missing),
 * commit replaces a planted link without following it, failed.json, too_large; the prune sweeps old temporary folders,
 * drops other versions of the theme first then the least recently read, ignores other names and never follows a link;
 * reading an image touches its meta; the disk gate refuses under 1 GB with "the disk has N MB free".
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTemplate } from '@demo-studio/core';
import type { WorkspaceConfig } from '@demo-studio/core';
import { PREVIEW_MAX_BYTES, PREVIEW_SAMPLES_DIR, componentSourceHash, createComponent, loadComponentRegistry } from '@demo-studio/components';
import { loadPreviewSamples } from '@demo-studio/editor';
import {
  LIBRARY_FILES,
  LIBRARY_PREVIEW_FORMAT,
  checkLibraryDisk,
  commitLibraryEntry,
  ensureLibraryCacheDir,
  libraryKeyContext,
  libraryPreviewKey,
  pruneLibraryCache,
  readLibraryEntry,
  readLibraryImage,
  stageLibraryEntry,
} from '../src/index.js';
import type { LibraryEntryMeta, LibraryKeyContext } from '../src/index.js';
import { REPO } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('poster')]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from('loop')]);
const THEME = { name: 'brandx', hash: 'h1' };

let root: string;
let ws: WorkspaceConfig;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-library-cache-'));
  await mkdir(join(root, 'templates'), { recursive: true });
  await cp(join(REPO, 'templates', 'editorial'), join(root, 'templates', 'brandx'), { recursive: true });
  const yaml = await readFile(join(root, 'templates', 'brandx', 'template.yaml'), 'utf8');
  await writeFile(join(root, 'templates', 'brandx', 'template.yaml'), yaml.replace(/^name: .*$/m, 'name: brandx').replace(/^  layout: .*$/m, '  layout: acme/frame'));
  await writeFile(join(root, 'studio.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  ws = { root } as WorkspaceConfig;
  await createComponent(root, { id: 'acme/frame', kind: 'layout', description: 'A frame.' });
  const card = await createComponent(root, { id: 'acme/card-x', kind: 'card', description: 'A card with assets.' });
  await writeFile(join(card.dir, 'bg.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]));
  await writeFile(card.entry, `import bg from './bg.png';\n${await readFile(card.entry, 'utf8')}\nexport const background = bg;\n`);
  await writeFile(join(card.dir, 'data.json'), '{"rows": 1}\n');
  await createComponent(root, { id: 'acme/other', kind: 'card', description: 'Unrelated.' });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function context(): Promise<LibraryKeyContext> {
  return libraryKeyContext(await loadTemplate('brandx', root), await loadComponentRegistry({ root }));
}

async function keysOf(ctx?: LibraryKeyContext): Promise<Record<string, string>> {
  const c = ctx ?? (await context());
  const out: Record<string, string> = {};
  for (const id of ['acme/card-x', 'studio/caption-below', 'studio/intro-stack', 'acme/frame']) {
    out[`${id} poster`] = await libraryPreviewKey(c, id, 'poster');
    out[`${id} loop`] = await libraryPreviewKey(c, id, 'loop');
  }
  return out;
}

/** The keys that differ between two sets. */
function changed(a: Record<string, string>, b: Record<string, string>): string[] {
  return Object.keys(a).filter((k) => a[k] !== b[k]).sort();
}

describe('library preview keys', () => {
  it('stable; poster and loop differ; an unrelated component changes nothing', async () => {
    const a = await keysOf();
    for (const k of Object.values(a)) expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(Object.values(a)).size).toBe(8);
    const other = (await loadComponentRegistry({ root })).get('acme/other');
    await writeFile(other.entry, `${await readFile(other.entry, 'utf8')}\n// edited\n`);
    expect(await keysOf()).toEqual(a);
  });

  it("an imported PNG's bytes (invalid UTF-8 both times) and an unimported JSON change the component's own keys", async () => {
    const card = (await loadComponentRegistry({ root })).get('acme/card-x');
    const before = await keysOf();
    const sourceBefore = componentSourceHash(card.dir);
    await writeFile(join(card.dir, 'bg.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfd, 0x00, 0x01]));
    // componentSourceHash decodes as UTF-8 (both bytes → U+FFFD) and follows imports only: why it is not the key.
    expect(componentSourceHash(card.dir)).toBe(sourceBefore);
    const afterPng = await keysOf();
    expect(changed(before, afterPng)).toEqual(['acme/card-x loop', 'acme/card-x poster']);
    await writeFile(join(card.dir, 'data.json'), '{"rows": 2}\n');
    expect(changed(afterPng, await keysOf())).toEqual(['acme/card-x loop', 'acme/card-x poster']);
  });

  it("a context component's file (the theme's layout) changes the keys of what is shown over it", async () => {
    const before = await keysOf();
    const frame = (await loadComponentRegistry({ root })).get('acme/frame');
    await writeFile(frame.entry, `${await readFile(frame.entry, 'utf8')}\n// a new shadow\n`);
    // The caption is previewed over the theme's layout; the intro alone; the card alone.
    expect(changed(before, await keysOf())).toEqual(['acme/frame loop', 'acme/frame poster', 'studio/caption-below loop', 'studio/caption-below poster']);
  });

  it('a theme font changes every key of the theme', async () => {
    const before = await keysOf();
    const font = join(root, 'templates', 'brandx', 'fonts', 'InstrumentSerif-Regular.ttf');
    const bytes = await readFile(font);
    await writeFile(font, Buffer.concat([bytes, Buffer.from([0])]));
    try {
      expect(changed(before, await keysOf())).toEqual(Object.keys(before).sort());
    } finally {
      await writeFile(font, bytes);
    }
    expect(await keysOf()).toEqual(before);
  });

  it('the sample screens, the kind and the composition are in the key', async () => {
    const ctx = await context();
    const before = await keysOf(ctx);
    const samples = join(root, 'samples');
    await cp(PREVIEW_SAMPLES_DIR, samples, { recursive: true });
    const desktop = join(samples, JSON.parse(readFileSync(join(samples, 'samples.json'), 'utf8')).desktop.file);
    await writeFile(desktop, Buffer.concat([await readFile(desktop), Buffer.from([1])]));
    const moved = await keysOf({ ...ctx, samples: loadPreviewSamples(samples), files: new Map() });
    // Layouts and captions show the desktop sample; intros and cards do not.
    expect(changed(before, moved)).toEqual(['acme/frame loop', 'acme/frame poster', 'studio/caption-below loop', 'studio/caption-below poster']);
    const comp = await keysOf({ ...ctx, composition: '0000000000000000' });
    expect(changed(before, comp)).toEqual(Object.keys(before).sort());
  });

  it('review A L3: the render browser is in the key (a browser update is a new picture)', async () => {
    const tpl = await loadTemplate('brandx', root);
    const reg = await loadComponentRegistry({ root });
    const a = await keysOf(await libraryKeyContext(tpl, reg, { browser: 'playwright /x/chromium_headless_shell-1187/headless_shell 100 1' }));
    const same = await keysOf(await libraryKeyContext(tpl, reg, { browser: 'playwright /x/chromium_headless_shell-1187/headless_shell 100 1' }));
    const updated = await keysOf(await libraryKeyContext(tpl, reg, { browser: 'playwright /x/chromium_headless_shell-1193/headless_shell 104 2' }));
    expect(changed(a, same)).toEqual([]);
    expect(changed(a, updated)).toEqual(Object.keys(a).sort());
    // By default: this machine's render browser (editor renderBrowserIdentity).
    expect((await context()).browser).toMatch(/^(playwright|env) \/.+ \d+ \d+$|^remotion /);
  });
});

/** A complete entry written by hand (what the worker writes). */
async function entry(dir: string, key: string, o: { kind?: 'poster' | 'loop'; image?: Buffer | null; meta?: Partial<LibraryEntryMeta>; theme?: { name: string; hash: string } } = {}): Promise<string> {
  const kind = o.kind ?? 'poster';
  const e = join(dir, key);
  await mkdir(e, { recursive: true });
  if (o.image !== null) await writeFile(join(e, LIBRARY_FILES[kind]), o.image ?? (kind === 'poster' ? PNG : GIF));
  const meta: LibraryEntryMeta = { format: LIBRARY_PREVIEW_FORMAT, key, kind, component: 'studio/intro-stack', theme: o.theme ?? THEME, at: new Date().toISOString(), state: 'ok', bytes: 10, ...o.meta };
  await writeFile(join(e, LIBRARY_FILES.meta), JSON.stringify(meta));
  return e;
}

const key = (n: number) => n.toString(16).padStart(32, '0');

describe('library preview cache', () => {
  it('the cache folder: plain segments made when missing; a linked segment is refused and nothing is written through it', async () => {
    const dir = await ensureLibraryCacheDir(ws);
    expect(dir).toBe(join(root, '.demo-studio', 'cache', 'previews'));
    const other = await mkdtemp(join(root, 'linked-'));
    const ws2 = { root: await mkdtemp(join(root, 'ws2-')) } as WorkspaceConfig;
    try {
      await mkdir(join(ws2.root, '.demo-studio'));
      await symlink(other, join(ws2.root, '.demo-studio', 'cache'));
      await expect(ensureLibraryCacheDir(ws2)).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/is not a folder \(a link or a file\)/) });
      expect(await readdir(other)).toEqual([]);
      expect(await readLibraryImage(ws2, key(1))).toBeNull();
    } finally {
      await rm(other, { recursive: true, force: true });
      await rm(ws2.root, { recursive: true, force: true });
    }
  });

  it('entries are read only when complete and plain; failed.json; too_large; reading an image touches its meta', async () => {
    const dir = await ensureLibraryCacheDir(ws);
    await entry(dir, key(1));
    expect((await readLibraryEntry(dir, key(1))).state).toBe('cached');
    // A meta naming another key, wrong magic, an oversized image, a hard link, a FIFO, a planted link, meta missing.
    await entry(dir, key(2), { meta: { key: key(99) } });
    await entry(dir, key(3), { image: Buffer.from('GIF89a not a png') });
    await entry(dir, key(4), { image: Buffer.concat([PNG, Buffer.alloc(PREVIEW_MAX_BYTES)]) });
    const hard = await entry(dir, key(5), { image: null });
    await writeFile(join(root, 'elsewhere.png'), PNG);
    await link(join(root, 'elsewhere.png'), join(hard, LIBRARY_FILES.poster));
    const fifo = await entry(dir, key(6), { image: null });
    execFileSync('mkfifo', [join(fifo, LIBRARY_FILES.poster)]);
    const outside = await mkdtemp(join(root, 'outside-'));
    await entry(outside, key(7));
    await symlink(join(outside, key(7)), join(dir, key(7)));
    await mkdir(join(dir, key(8)));
    await writeFile(join(dir, key(8), LIBRARY_FILES.poster), PNG);
    for (const n of [2, 3, 4, 5, 6, 7, 8]) expect((await readLibraryEntry(dir, key(n))).state, `entry ${n}`).toBe('missing');
    expect((await readLibraryEntry(dir, '../x')).state).toBe('missing');
    // failed.json and a loop too large to keep.
    await mkdir(join(dir, key(9)));
    await writeFile(join(dir, key(9), LIBRARY_FILES.failed), JSON.stringify({ format: 1, key: key(9), kind: 'loop', component: 'acme/card-x', theme: THEME, at: 'x', reason: 'it threw' }));
    expect(await readLibraryEntry(dir, key(9))).toMatchObject({ state: 'failed', failure: { reason: 'it threw' } });
    await entry(dir, key(10), { kind: 'loop', image: null, meta: { state: 'too_large', bytes: 1_600_000 } });
    expect((await readLibraryEntry(dir, key(10))).state).toBe('too_large');
    // readLibraryImage: the bytes of a complete entry only, its meta touched.
    const metaFile = join(dir, key(1), LIBRARY_FILES.meta);
    await utimes(metaFile, new Date(1_000_000), new Date(1_000_000));
    const img = await readLibraryImage(ws, key(1));
    expect(img).toMatchObject({ kind: 'poster', component: 'studio/intro-stack' });
    expect(img!.bytes.equals(PNG)).toBe(true);
    expect(statSync(metaFile).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(await readLibraryImage(ws, key(7))).toBeNull();
    // The planted link's target is untouched by any of it.
    expect(existsSync(join(outside, key(7), LIBRARY_FILES.poster))).toBe(true);
    await rm(outside, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it('an entry is renamed into place whole: a planted link or an incomplete folder under its key is replaced, never followed', async () => {
    const dir = await ensureLibraryCacheDir(ws);
    const outside = await mkdtemp(join(root, 'outside-'));
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, join(dir, key(20)));
    await mkdir(join(dir, key(21)));
    await writeFile(join(dir, key(21), LIBRARY_FILES.poster), PNG);
    for (const n of [20, 21]) {
      const tmp = await stageLibraryEntry(dir, key(n));
      expect(tmp).toMatch(new RegExp(`${key(n)}\\.tmp-\\d+-[0-9a-f]{8}$`));
      await writeFile(join(tmp, LIBRARY_FILES.poster), PNG);
      const meta: LibraryEntryMeta = { format: LIBRARY_PREVIEW_FORMAT, key: key(n), kind: 'poster', component: 'studio/intro-stack', theme: THEME, at: 'now', state: 'ok', bytes: PNG.length };
      await commitLibraryEntry(dir, key(n), tmp, { meta });
      expect((await readLibraryEntry(dir, key(n))).state, `entry ${n}`).toBe('cached');
      expect(existsSync(tmp)).toBe(false);
    }
    expect(await readdir(outside)).toEqual(['keep.txt']);
    // A complete entry already there (another job, same content) is kept; the new temporary folder goes.
    const tmp = await stageLibraryEntry(dir, key(21));
    await writeFile(join(tmp, LIBRARY_FILES.poster), PNG);
    await commitLibraryEntry(dir, key(21), tmp, { meta: { format: LIBRARY_PREVIEW_FORMAT, key: key(21), kind: 'poster', component: 'x/y', theme: THEME, at: 'later', state: 'ok', bytes: 1 } });
    expect(JSON.parse(readFileSync(join(dir, key(21), LIBRARY_FILES.meta), 'utf8')).component).toBe('studio/intro-stack');
    expect(existsSync(tmp)).toBe(false);
    await expect(stageLibraryEntry(dir, '../x')).rejects.toMatchObject({ code: 'invalid' });
    await rm(outside, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it('the prune: old temporary folders swept, other theme versions first then least recently read, other names and links never followed', async () => {
    const dir = await ensureLibraryCacheDir(ws);
    const now = Date.now();
    const old = new Date(now - 2 * 3600_000);
    const tmpOld = join(dir, `${key(1)}.tmp-123-0badc0de`);
    const tmpNew = join(dir, `${key(2)}.tmp-123-0badc0df`);
    await mkdir(tmpOld);
    await mkdir(tmpNew);
    await utimes(tmpOld, old, old);
    // Five entries: two of another version of brandx (oldest read last), three of the current one.
    const at = (n: number, minutesAgo: number, theme = THEME) => entry(dir, key(n), { theme }).then((e) => utimes(join(e, LIBRARY_FILES.meta), new Date(now - minutesAgo * 60_000), new Date(now - minutesAgo * 60_000)));
    await at(10, 1, { name: 'brandx', hash: 'h0' });
    await at(11, 2, { name: 'brandx', hash: 'h0' });
    await at(12, 50);
    await at(13, 40);
    await at(14, 30);
    // Not ours: another name, and a link named like a key whose target must survive.
    await mkdir(join(dir, 'notes'));
    const outside = await mkdtemp(join(root, 'outside-'));
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, join(dir, key(15)));
    const r = await pruneLibraryCache(dir, { theme: THEME, now, maxEntries: 2 });
    expect(r).toEqual({ swept: 1, pruned: 3 });
    expect(existsSync(tmpOld)).toBe(false);
    expect(existsSync(tmpNew)).toBe(true);
    const left = (await readdir(dir)).sort();
    expect(left).toEqual([key(13), key(14), `${key(2)}.tmp-123-0badc0df`, 'notes'].sort());
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    await rm(outside, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it('the disk gate: under 1 GB free a library job is refused with what is left', async () => {
    await expect(checkLibraryDisk(root, async () => 512_000_000)).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/^the disk has 512 MB free: library previews need at least 1 GB free/) });
    await expect(checkLibraryDisk(root, async () => 2_000_000_000)).resolves.toBeUndefined();
    await expect(checkLibraryDisk(root, async () => undefined)).resolves.toBeUndefined();
  });
});
