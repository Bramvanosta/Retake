/**
 * L4.7 part C: the Studio's library ops (server/library-ops.ts) over HTTP, on a scratch workspace (the fixture project,
 * the starters as templates_dir, one workspace component) with no worker (a queued job stays queued):
 * - `library_view`: every component, workspace first; the keys are the engine's own (`components.library`: the one
 *   builder the worker uses, B3); fresh built-ins are `committed` in the editorial starter, a workspace component never
 *   (its own preview.png is not trusted); path-free; a workspace component's name only under `untrusted`; pinned inputs;
 * - ⚑ B5: a component file rewritten in place (its folder's mtime unchanged) is a new key at once — the memo is keyed on
 *   the file-level stat walk, not on folders;
 * - `library_images`: cached entries by key (PNG / GIF89a, a planted wrong-magic entry is missing), ⚑ committed posters
 *   of built-ins only (B15: a workspace component with its own preview.png is `not_builtin`), the largest committed
 *   poster within POSTER_DATA_MAX (B6); at most 12 keys;
 * - `library_render`: at most 12 components; ⚑ keys already queued are skipped and nothing left queues no job (C1);
 *   library_view then marks them `queued`.
 * - ⚑ review A L2 / B H1: a failure's reason reaches the page path-free under untrusted; a library job that failed as a
 *   whole shows its error (`job_error`) until a later one of the theme succeeds;
 * - `library_component` (part D1): the detail — kit compatibility, slots, ⚑ every manifest word (name, description, slot
 *   and param words, README) only under `untrusted`, path-free (a README naming the component's folder); pinned inputs.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIBRARY_DIR, scaffoldDir } from '@retake/components';
import { LIBRARY_FILES, LIBRARY_PREVIEW_FORMAT, editorRenderer, libraryCacheDir, libraryRegistryHash, memoRegistry, runWorker, withPreviewBackend } from '@retake/engine';
import type { FreeBytes } from '@retake/engine';
import type { PreviewBackend } from '@retake/editor';
import { LOOP_DATA_MAX, POSTER_DATA_MAX, UI_OPS, startStudioServer } from '../src/index.js';
import type { LibraryComponentAnswer, LibraryImagesAnswer, LibraryRenderAnswer, LibraryViewAnswer, StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

const P = 'northfield-fixture';
const MARK = 'MARKED-LIBRARY-3c9d';
const HOSTILE = '<img src=x onerror=alert(1)>';
let ws: string;
let studio: StudioServer;
const savedHome = process.env.RETAKE_HOME;
const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
async function ok<T>(op: string, args: unknown): Promise<{ data: T; body: string }> {
  const r = await call(op, args);
  expect(r.status, r.body.slice(0, 400)).toBe(200);
  return { data: r.json<{ data: T }>().data, body: r.body };
}
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const markedCode = (n: number) => `import { AbsoluteFill } from 'remotion';\nexport default function M() { return <AbsoluteFill>{${JSON.stringify(`${MARK}-${n}`)}}</AbsoluteFill>; }\n`;

async function seed(key: string, kind: 'poster' | 'loop', component: string, image: Buffer): Promise<void> {
  const e = join(libraryCacheDir({ root: ws }), key);
  await mkdir(e, { recursive: true });
  await writeFile(join(e, LIBRARY_FILES[kind]), image);
  await writeFile(join(e, LIBRARY_FILES.meta), JSON.stringify({ format: LIBRARY_PREVIEW_FORMAT, key, kind, component, theme: { name: 'editorial', hash: 'x' }, at: new Date().toISOString(), state: 'ok', bytes: image.length }));
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-library-ops-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  // A workspace card with its own preview.png (never trusted as the library's poster) and an agent's name.
  const comp = join(ws, 'components', 'acme', 'marked');
  await mkdir(comp, { recursive: true });
  await cp(scaffoldDir('card'), comp, { recursive: true });
  const manifest = (await readFile(join(comp, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/marked').replace(/^name: .*$/m, `name: ${JSON.stringify(HOSTILE)}`);
  await writeFile(join(comp, 'component.yaml'), manifest);
  await writeFile(join(comp, 'index.tsx'), markedCode(1));
  await cp(join(LIBRARY_DIR, 'studio', 'card-title', 'preview.png'), join(comp, 'preview.png'));
  studio = await startStudioServer({ root: ws, startWorker: false });
}, 60_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

const viewOf = async (args: Record<string, unknown> = { project: P }) => ok<LibraryViewAnswer>('library_view', args);
const item = (v: LibraryViewAnswer, id: string) => v.items.find((i) => i.component === id)!;

describe('library_view', () => {
  it('every component, workspace first, with the engine\'s own keys; committed built-in posters; path-free; untrusted names', async () => {
    expect(UI_OPS).toEqual(expect.arrayContaining(['library_view', 'library_images', 'library_render']));
    const { data: v, body } = await viewOf();
    expect(v.theme).toMatchObject({ name: 'editorial', editorial_starter: true, project_default: true });
    expect(v.items[0].component).toBe('acme/marked');
    expect(v.items.length).toBeGreaterThan(30);
    // B3: the keys are the worker's (engine components.library), never a second builder.
    const engine = await studio.engine.components.library({ project: P });
    expect(v.items.map((i) => [i.component, i.poster.key, i.loop.key])).toEqual(expect.arrayContaining(engine.items.map((i) => [i.component, i.poster.key, i.loop.key])));
    expect(v.items).toHaveLength(engine.items.length);
    const marked = item(v, 'acme/marked');
    expect(marked).toMatchObject({ source: 'workspace', kind: 'card', poster: { state: 'missing' }, loop: { state: 'missing' } });
    expect(marked.untrusted.name).toBe(HOSTILE);
    expect(v.items.filter((i) => i.source === 'builtin' && i.poster.state === 'committed').length).toBeGreaterThan(20);
    expect(v.themes.find((t) => t.name === 'editorial')).toMatchObject({ default: true });
    expect(item(v, 'studio/card-title').theme_default).toContain('card');
    // Path-free: no folder of this Mac, the agent's text only under untrusted.
    expect(body).not.toContain(ws);
    expect(body).not.toContain(homedir());
    expect(body.split(JSON.stringify(HOSTILE).slice(1, -1)).length - 1).toBe(1);
  });

  it('pinned inputs: a path, an extra key, a theme that is a path → 400', async () => {
    expect((await call('library_view', { project: '../x' })).status).toBe(400);
    expect((await call('library_view', { project: P, dir: '/tmp' })).status).toBe(400);
    expect((await call('library_view', { project: P, theme: '../../templates/editorial' })).status).toBe(400);
  });

  it('⚑ B5: a component file rewritten in place is a new key at once; an unrelated re-read keeps it', async () => {
    const before = item((await viewOf()).data, 'acme/marked').poster.key;
    expect(item((await viewOf()).data, 'acme/marked').poster.key).toBe(before);
    // In place: the folder's mtime does not move (probe E1) — only the file's.
    await writeFile(join(ws, 'components', 'acme', 'marked', 'index.tsx'), markedCode(2));
    const after = item((await viewOf()).data, 'acme/marked').poster.key;
    expect(after).not.toBe(before);
    const engine = await studio.engine.components.library({ project: P, components: ['acme/marked'] });
    expect(after).toBe(engine.items[0].poster.key);
  });
});

describe('library_images', () => {
  it('cached posters and loops by key (magic-checked); ⚑ committed posters of built-ins only (B15); the largest committed poster fits (B6)', async () => {
    const v = (await viewOf()).data;
    const m = item(v, 'acme/marked');
    const png = await readFile(join(LIBRARY_DIR, 'studio', 'card-title', 'preview.png'));
    await seed(m.poster.key, 'poster', 'acme/marked', png);
    await seed(m.loop.key, 'loop', 'acme/marked', GIF);
    // A planted entry: a GIF under a poster key.
    const other = item(v, 'studio/card-title');
    await seed(other.poster.key, 'poster', 'studio/card-title', GIF);
    const { data: d, body } = await ok<LibraryImagesAnswer>('library_images', { project: P, keys: [m.poster.key, m.loop.key, other.poster.key], committed: ['studio/card-before-after', 'acme/marked'] });
    const byKey = new Map(d.images.filter((i) => i.key).map((i) => [i.key, i]));
    expect(byKey.get(m.poster.key)).toMatchObject({ component: 'acme/marked', kind: 'poster', format: 'png' });
    expect(Buffer.from(byKey.get(m.poster.key)!.data, 'base64').equals(png)).toBe(true);
    expect(byKey.get(m.loop.key)).toMatchObject({ kind: 'loop', format: 'gif', data: GIF.toString('base64') });
    expect(d.missing).toEqual(expect.arrayContaining([{ key: other.poster.key, reason: 'missing' }, { component: 'acme/marked', reason: 'not_builtin' }]));
    // B6: the largest committed poster (189,595 bytes raw: over 200,000 base64 characters) is within POSTER_DATA_MAX.
    const largest = d.images.find((i) => i.component === 'studio/card-before-after')!;
    expect(largest).toMatchObject({ kind: 'poster', format: 'png' });
    expect(largest.data.length).toBeGreaterThan(200_000);
    expect(largest.data.length).toBeLessThanOrEqual(POSTER_DATA_MAX);
    expect(LOOP_DATA_MAX).toBe(2_000_000);
    expect(body).not.toContain(ws);
  });

  it('pinned: at most 12 keys, keys by their shape only', async () => {
    const keys = Array.from({ length: 13 }, (_, i) => i.toString(16).padStart(32, '0'));
    expect((await call('library_images', { project: P, keys })).status).toBe(400);
    expect((await call('library_images', { project: P, keys: ['../../etc/passwd'] })).status).toBe(400);
    expect((await call('library_images', { project: P, committed: ['studio/../x'] })).status).toBe(400);
  });
});

describe('library_render', () => {
  it('⚑ queues at most 12 components; keys already queued are skipped and nothing left queues no job (C1); the view says queued', async () => {
    const v = (await viewOf()).data;
    const a = item(v, 'studio/card-title');
    const b = item(v, 'studio/intro-stack');
    const first = (await ok<LibraryRenderAnswer>('library_render', { project: P, items: [{ component: a.component, loop: a.loop.key }] })).data;
    expect(first.job?.state).toBe('queued');
    expect(first.components).toEqual([a.component]);
    const again = (await ok<LibraryRenderAnswer>('library_render', { project: P, items: [{ component: a.component, loop: a.loop.key }] })).data;
    expect(again).toEqual({ job: null, components: [], skipped: [{ component: a.component, kind: 'loop' }] });
    // A mixed request: the queued key skipped, the new one queued.
    const mixed = (await ok<LibraryRenderAnswer>('library_render', { project: P, items: [{ component: a.component, loop: a.loop.key }, { component: b.component, poster: b.poster.key }] })).data;
    expect(mixed.job).not.toBeNull();
    expect(mixed.components).toEqual([b.component]);
    expect(mixed.skipped).toEqual([{ component: a.component, kind: 'loop' }]);
    const after = (await viewOf()).data;
    expect(item(after, a.component).loop.queued).toBe(true);
    expect(item(after, b.component).poster.queued).toBe(true);
    expect(item(after, b.component).loop.queued).toBeUndefined();
    expect(after.queued).toBe(2);
    const jobs = await studio.engine.jobs.list({ project: P, kinds: ['preview'] });
    expect(jobs).toHaveLength(2);
  });

  it('pinned: 13 components, no key, a component twice → refused before anything is queued', async () => {
    const v = (await viewOf()).data;
    const items = v.items.slice(0, 13).map((i) => ({ component: i.component, poster: i.poster.key }));
    expect((await call('library_render', { project: P, items })).status).toBe(400);
    const noKey = await call('library_render', { project: P, items: [{ component: 'studio/card-title' }] });
    expect(noKey.status).toBe(400);
    const twice = await call('library_render', { project: P, items: [items[1], items[1]] });
    expect(twice.status).toBe(400);
    expect((await call('library_render', { project: P, items: [{ component: 'studio/card-title', poster: 'zz' }] })).status).toBe(400);
  });
});

describe('library_component (part D1)', () => {
  it('⚑ the detail: kit, slots, params; every manifest word only under untrusted; path-free', async () => {
    const dir = join(ws, 'components', 'acme', 'marked');
    await writeFile(join(dir, 'README.md'), `# Marked\n\nIts code is ${dir}/index.tsx — ${HOSTILE}\n`);
    const { data: d, body } = await ok<LibraryComponentAnswer>('library_component', { project: P, component: 'acme/marked' });
    expect(d).toMatchObject({ component: 'acme/marked', kind: 'card', source: 'workspace', kit: { needs: 1, provided: 1, compatible: true }, variants: ['landscape', 'vertical'] });
    expect(d.slots.map((x) => [x.name, x.type, x.required])).toEqual([['title', 'text', true], ['kicker', 'text', false], ['text', 'text', false]]);
    expect(d.untrusted.name).toBe(HOSTILE);
    expect(d.untrusted.slots.title).toBe('The card title.');
    expect(d.untrusted.params).toEqual([{ name: 'align', type: 'string', default: 'center', enum: ['center', 'left'], description: 'Alignment of the column.' }]);
    expect(d.untrusted.readme).toContain('index.tsx');
    // Path-free (the README named the folder), no folder, entry or file list.
    expect(body).not.toContain(ws);
    expect(body).not.toContain(homedir());
    for (const k of ['dir', 'entry', 'files', 'manifest', 'preview']) expect(Object.keys(d)).not.toContain(k);
    // The manifest's words appear only under untrusted: the name once in the name, once in the README.
    const top = { ...d, untrusted: undefined };
    expect(JSON.stringify(top)).not.toMatch(/img src|Alignment|card title/);
    expect(body.split(JSON.stringify(HOSTILE).slice(1, -1)).length - 1).toBe(2);
    // A built-in: its duration bounds and kinds.
    const cta = (await ok<LibraryComponentAnswer>('library_component', { project: P, component: 'studio/card-cta' })).data;
    expect(cta).toMatchObject({ source: 'builtin', duration: { default: 4.5, min: 2, max: 15 } });
    expect(cta.untrusted.params.map((x) => x.name)).toEqual(['tone', 'show_qr', 'qr_level']);
    expect(cta.untrusted.params[1]).toMatchObject({ type: 'boolean', default: 'true' });
  });

  it('pinned: a path, an extra key, an unknown component', async () => {
    expect((await call('library_component', { project: P, component: '../x' })).status).toBe(400);
    expect((await call('library_component', { project: P, component: 'acme/marked', dir: '/tmp' })).status).toBe(400);
    expect((await call('library_component', { project: '../p', component: 'acme/marked' })).status).toBe(400);
    expect((await call('library_component', { project: P, component: 'acme/nope' })).status).toBe(404);
  });
});

/** Run the worker (one job at a time: cancelled ones first) until job `id` has finished. */
async function workUntil(id: string, test: { backend?: PreviewBackend; freeBytes: FreeBytes }): Promise<void> {
  // The worker's ports (L7.29): the backend draws the previews of its renderer, the free space its disk gate sees.
  const ports = { ...(test.backend ? { renderer: withPreviewBackend(editorRenderer(), test.backend) } : {}), freeBytes: test.freeBytes };
  for (let i = 0; i < 10 && ['queued', 'running'].includes((await studio.engine.jobs.get(id)).state); i++) {
    await runWorker({ root: ws, once: true, idleExitMs: 0, pollMs: 20, log: () => undefined, ports });
  }
}

describe('failures on the page (L4.7 review A L2 / B H1)', () => {
  it('⚑ a failure\'s reason is path-free under untrusted; a library job that failed as a whole shows its error until one succeeds', async () => {
    // Nothing else queued: earlier tests' jobs cancelled.
    for (const j of await studio.engine.jobs.list({ project: P, kinds: ['preview'], states: ['queued'] })) await studio.engine.jobs.cancel(j.id);
    const v = (await viewOf()).data;
    const a = item(v, 'studio/card-title');
    // A failure recorded under the registry as it is now (a stale one reads as missing), its words quoting paths.
    const registryHash = await libraryRegistryHash((await memoRegistry(studio.engine.workspace)).registry);
    const e = join(libraryCacheDir({ root: ws }), a.loop.key);
    await mkdir(e, { recursive: true });
    const reason = `its preview failed: Module build failed (from ${ws}/node_modules/x/loader.js): ${ws}/components/acme/marked/index.tsx and /Users/someone/secret/plan.ts`;
    await writeFile(join(e, LIBRARY_FILES.failed), JSON.stringify({ format: LIBRARY_PREVIEW_FORMAT, key: a.loop.key, kind: 'loop', component: a.component, theme: { name: 'editorial', hash: 'x' }, at: new Date().toISOString(), reason, bundle: registryHash }));
    const { data: failed, body } = await viewOf();
    expect(item(failed, a.component).loop.state).toBe('failed');
    const words = item(failed, a.component).loop.untrusted!.reason;
    expect(words).toMatch(/^its preview failed: Module build failed/);
    expect(words).toContain('index.tsx');
    for (const bad of [ws, '/Users/someone', homedir()]) expect(body, bad).not.toContain(bad);
    expect(failed.job_error).toBeUndefined();

    // A job that fails as a whole (the disk gate in the worker): its error on the page, under untrusted.
    const b = item(v, 'studio/intro-stack');
    const sub = (await ok<LibraryRenderAnswer>('library_render', { project: P, theme: 'editorial', items: [{ component: b.component, poster: b.poster.key }] })).data;
    await workUntil(sub.job!.id, { freeBytes: async () => 400_000_000 });
    expect((await studio.engine.jobs.get(sub.job!.id)).state).toBe('failed');
    const shown = (await viewOf()).data;
    expect(shown.job_error).toMatchObject({ job: sub.job!.id, untrusted: { message: expect.stringMatching(/^the disk has 400 MB free/) } });
    // Another theme's view does not show it; a later job of the theme that succeeds hides it.
    expect((await viewOf({ project: P, theme: 'motion' })).data.job_error).toBeUndefined();
    const again = (await ok<LibraryRenderAnswer>('library_render', { project: P, theme: 'editorial', items: [{ component: b.component, poster: b.poster.key }] })).data;
    const backend: PreviewBackend = {
      async bundle({ root, components }) {
        const dir = join(root, '.retake', 'cache', 'remotion-test');
        await mkdir(dir, { recursive: true });
        return { serveUrl: dir, hash: components.length.toString(16).padStart(16, '0'), cached: false };
      },
      async open() {
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('poster')]);
        return { still: async (_s, file) => writeFile(file, png), gif: async (_s, file) => writeFile(file, GIF), warnings: () => [], close: async () => undefined };
      },
    };
    await workUntil(again.job!.id, { backend, freeBytes: async () => 50_000_000_000 });
    expect((await studio.engine.jobs.get(again.job!.id)).state).toBe('succeeded');
    expect((await viewOf()).data.job_error).toBeUndefined();
  });
});
