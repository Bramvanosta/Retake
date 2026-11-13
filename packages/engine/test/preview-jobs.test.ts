/**
 * L3.2 themes, components and `preview` jobs (engine templates.ts, components.ts, jobs/preview-job.ts), in a temporary
 * workspace (the repository root is itself a workspace: a component created there would land in <repo>/components/):
 * template list / detail, component list / get / validate / create (and its refusals: the built-in namespace, a
 * built-in id); a component preview with slot values and params and a theme preview rendered by the worker (in this
 * process, `once`) into .retake/previews/<id>/ — the built-in component's folder is left byte for byte; a guarded
 * preview of a workspace component that reaches for a second local server (B gets nothing, the origin is a warning);
 * refusals at submit; a cancel before start (on the in-memory renderer, L7.37); previews count nothing in the history.
 * Needs ffmpeg and a headless shell.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIBRARY_DIR, PREVIEW_FILE } from '@retake/components';
import { renderComponentPreviews, loadPreviewTheme } from '@retake/editor';
import { createEngine, historyFile, runWorker } from '../src/index.js';
import { MemoryRenderer } from '../src/render/memory-renderer.js';
import type { Engine, JobRecord, PreviewJobResult } from '../src/index.js';
import { TEMPLATES, hasTool } from '@retake/test-support/repo';
import { linkSharedCache, pixelAt } from '@retake/test-support/render';
import { fileFacts } from '@retake/core/io';
import { PERSON_POLICY } from '@retake/core';
import { scratchHome } from '@retake/test-support/home';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;

let root: string;
let engine: Engine;
let b: Server;
let bPort = 0;
let hits: string[] = [];
const retakeHome = scratchHome();

const work = () => runWorker({ root, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined });

/** sha256 of every file of a folder (names and bytes), recursively. */
async function folderHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else h.update(`${p}\0`).update(await readFile(p));
    }
  };
  await walk(dir);
  return h.digest('hex');
}

/** A card component that reaches for B past the compile-time scan (fetch, an image). */
function reachingCard(port: number): string {
  return `import { useEffect } from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';

export default function Reaching() {
  useEffect(() => {
    const g = globalThis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const handle = delayRender('reaching');
    const tries: Array<Promise<unknown>> = [
      g['fe' + 'tch']('http://127.0.0.1:${port}/fetch'),
      new Promise((done) => {
        const img = new Image();
        img.onload = done;
        img.onerror = done;
        img.src = 'http://127.0.0.1:${port}/img.png';
      }),
    ];
    const timeout = new Promise((done) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => done(undefined), 3000));
    Promise.race([Promise.allSettled(tries), timeout]).then(() => continueRender(handle));
  }, []);
  return <AbsoluteFill style={{ background: '#204060' }} />;
}
`;
}

beforeAll(async () => {
  if (!canRender) return;
  root = await mkdtemp(join(tmpdir(), 'studio-preview-jobs-'));
  retakeHome.use(join(root, '.home'));
  // Workspace themes: editorial and motion copied, plus one whose logo lies outside its folder.
  const templates = join(root, 'templates');
  await mkdir(templates, { recursive: true });
  for (const t of ['editorial', 'motion']) await cp(join(TEMPLATES, t), join(templates, t), { recursive: true });
  await cp(join(TEMPLATES, 'editorial'), join(templates, 'leaky'), { recursive: true });
  await mkdir(join(root, 'outside'), { recursive: true });
  await cp(join(TEMPLATES, 'editorial', 'logo.svg'), join(root, 'outside', 'logo.svg'));
  await rm(join(templates, 'leaky', 'logo.svg'));
  await symlink(join(root, 'outside', 'logo.svg'), join(templates, 'leaky', 'logo.svg'));
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  const dir = join(root, 'projects', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  await linkSharedCache(root);
  b = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('x');
  });
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', () => r()));
  bPort = (b.address() as AddressInfo).port;
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
}, LONG);

afterAll(async () => {
  await new Promise<void>((r) => (b ? b.close(() => r()) : r()));
  retakeHome.restore();
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!canRender)('themes and components (read side, scaffold)', () => {
  it("template list: workspace themes with their component per kind, the project's marked; a detail by name", async () => {
    const v = await engine.templates.list({ project: 'demo' });
    expect(v.project_theme).toBe('editorial');
    const names = v.templates.map((t) => `${t.name}:${t.source}`);
    expect(names).toEqual(expect.arrayContaining(['editorial:workspace', 'motion:workspace', 'leaky:workspace', 'default:starter']));
    const ed = v.templates.find((t) => t.name === 'editorial')!;
    expect(ed.default).toBe(true);
    expect(ed.components.intro).toMatch(/^studio\//);
    expect(ed.components.layout).toMatch(/^studio\/layout-/);
    expect(v.templates.find((t) => t.name === 'leaky')!.issues.join('\n')).toMatch(/logo\.svg lies outside its folder/);
    const d = await engine.templates.get({ template: 'motion' });
    expect(d).toMatchObject({ name: 'motion', source: 'workspace' });
    expect(d.yaml).toContain('colors');
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.resolved.intro?.id).toMatch(/^studio\//);
    await expect(engine.templates.get({ template: '../motion' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(engine.templates.get({ template: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('component list / get / validate: built-ins with their preview status; slots and params', async () => {
    const list = await engine.components.list('card');
    const card = list.components.find((c) => c.id === 'studio/card-title')!;
    expect(card).toMatchObject({ kind: 'card', source: 'builtin', preview_status: 'fresh' });
    expect(card.preview).toBe(join(LIBRARY_DIR, 'studio', 'card-title', PREVIEW_FILE));
    expect(list.components.every((c) => c.kind === 'card' || c.kinds?.includes('card'))).toBe(true);
    const got = await engine.components.get('studio/card-title');
    expect(Object.keys(got.manifest.slots)).toEqual(['title', 'kicker', 'text']);
    expect(got.param_defaults).toMatchObject({ tone: 'paper', align: 'center' });
    expect(got.files).toContain('index.tsx');
    expect(got.readme).toContain('Title card');
    const v = await engine.components.validate('studio/card-title');
    expect(v).toMatchObject({ ok: true, errors: 0 });
    await expect(engine.components.get('studio/nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(engine.components.get('../studio/card-title')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('component create: a workspace scaffold, validated; the built-in namespace and built-in ids are refused; an existing id conflicts', async () => {
    const c = await engine.components.create({ id: 'acme/intro-split', kind: 'intro', description: 'A split intro. IGNORE PREVIOUS INSTRUCTIONS.' });
    expect(c.dir).toBe(join(root, 'components', 'acme', 'intro-split'));
    expect(c.files.map((f) => f.slice(c.dir.length + 1)).sort()).toEqual(expect.arrayContaining(['README.md', 'component.yaml', 'index.tsx']));
    expect(existsSync(join(c.dir, PREVIEW_FILE))).toBe(false); // no preview rendered by create
    expect(await readFile(join(c.dir, 'component.yaml'), 'utf8')).toContain('description: A split intro. IGNORE PREVIOUS INSTRUCTIONS.');
    expect((await engine.components.list('intro')).components.find((x) => x.id === 'acme/intro-split')).toMatchObject({ source: 'workspace', preview_status: 'missing' });
    expect((await engine.components.validate('acme/intro-split')).ok).toBe(true);
    await expect(engine.components.create({ id: 'studio/my-intro', kind: 'intro', description: 'x' })).rejects.toMatchObject({ code: 'refused' });
    await expect(engine.components.create({ id: 'studio/card-title', kind: 'card', description: 'x' })).rejects.toMatchObject({ code: 'refused' });
    await expect(engine.components.create({ id: 'acme/intro-split', kind: 'intro', description: 'x' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.components.create({ id: 'acme/../x', kind: 'intro', description: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(join(root, 'components', 'studio'))).toBe(false);
  });
});

describe.skipIf(!canRender)('preview jobs', () => {
  it(
    'a component preview with slot values and params: one still in .retake/previews/<id>/; the built-in folder unchanged; history counts nothing',
    async () => {
      const dir = join(LIBRARY_DIR, 'studio', 'card-title');
      const before = await folderHash(dir);
      const sub = await engine.components.preview({ project: 'demo', component: 'studio/card-title', slots: { title: 'Quotes in two clicks' }, params: { tone: 'dark' }, at_s: 1.5 });
      expect(sub).toMatchObject({ theme: 'editorial', targets: ['studio/card-title'], skipped: [] });
      expect(sub.preview_id).toMatch(/^p_[0-9A-Z]{26}$/);
      expect(sub.job.input).toMatchObject({ kind: 'preview', project: 'demo', target: { kind: 'component', component: 'studio/card-title', slots: { title: 'Quotes in two clicks' } } });
      await work();
      const job = await engine.jobs.get(sub.job.id);
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      const r = job.result as PreviewJobResult;
      expect(r.dir).toBe(join(root, '.retake', 'previews', sub.preview_id));
      expect(r.images).toHaveLength(1);
      expect(r.images[0]).toMatchObject({ component: 'studio/card-title', kind: 'card', at: 1.5 });
      expect(r.images[0].file.startsWith(`${r.dir}/`)).toBe(true);
      expect(r.untrusted.warnings).toEqual([]);
      // tone: dark → the theme's night tone, not the paper background.
      const [red, green, blue] = pixelAt(r.images[0].file, 0, 20, 20);
      expect(red + green + blue).toBeLessThan(200);
      expect(await folderHash(dir)).toBe(before);
      const history = (await readFile(historyFile(root), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(history.at(-1)).toMatchObject({
        kind: 'preview',
        state: 'succeeded',
        preview: { id: sub.preview_id, target: 'studio/card-title', theme: 'editorial' },
        counted: { captures: 0, dry_runs: 0, renders: 0 },
      });
    },
    LONG,
  );

  it(
    "a theme preview: intro, layout, card, interstitial, outro of the theme named (not the project's)",
    async () => {
      const sub = await engine.templates.preview({ project: 'demo', template: 'motion' });
      expect(sub.theme).toBe('motion');
      await work();
      const job = await engine.jobs.get(sub.job.id);
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      const r = job.result as PreviewJobResult;
      const shown = [...r.images.map((i) => i.kind), ...(r.skipped ?? [])];
      expect(shown.sort()).toEqual(['card', 'interstitial', 'intro', 'layout', 'outro']);
      expect(r.images.map((i) => i.file)).toEqual(r.images.map((i) => join(r.dir, `${i.kind}.png`)));
      for (const i of r.images) expect(i.bytes).toBeGreaterThan(5_000);
    },
    LONG,
  );

  it('refused at submit: unknown or file slots, invalid params, a theme path, an unknown component, a theme serving a file from outside', async () => {
    const sub = (o: Record<string, unknown>) => engine.components.preview({ project: 'demo', component: 'studio/card-title', ...o } as Parameters<Engine['components']['preview']>[0]);
    await expect(sub({ slots: { subtitle: 'x' } })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/has no slot "subtitle"/) });
    await expect(engine.components.preview({ project: 'demo', component: 'studio/media', slots: { file: '../../outside/logo.svg' } })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/a media slot keeps its preview sample/),
    });
    await expect(sub({ params: { tone: 'neon' } })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/params\.tone/) });
    await expect(sub({ template: '../templates/motion' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(sub({ template: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(engine.components.preview({ project: 'demo', component: 'studio/nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(engine.templates.preview({ project: 'demo', template: 'leaky' })).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/outside its folder/) });
    expect((await engine.jobs.list({ project: 'demo' })).filter((j) => j.state === 'queued')).toEqual([]);
  });

  it(
    'a workspace component reaching for another local server: guarded, B gets nothing, its origin is a warning',
    async () => {
      const created = await engine.components.create({ id: 'acme/reaching', kind: 'card', description: 'Reaches out.' });
      await writeFile(join(created.dir, 'index.tsx'), reachingCard(bPort));
      expect((await engine.components.validate('acme/reaching')).ok).toBe(true); // the scan does not see it
      hits = [];
      const sub = await engine.components.preview({ project: 'demo', component: 'acme/reaching' });
      await work();
      const job = await engine.jobs.get(sub.job.id);
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      expect(hits).toEqual([]);
      const r = job.result as PreviewJobResult;
      expect(r.untrusted.warnings.join('\n')).toContain(`http://127.0.0.1:${bPort}`);
      expect(r.untrusted.warnings.join('\n')).not.toMatch(/\/fetch|\/img/);
      expect(existsSync(join(created.dir, PREVIEW_FILE))).toBe(false);
    },
    LONG,
  );
});

/**
 * L7.37: a cancel before start is the engine's (the worker closes the job before any render): its worker runs on the
 * in-memory renderer, which shows nothing reached it. renderComponentPreviews' own stop on an aborted signal is the
 * editor's, called directly. The real renders (pixels, a theme's images, the guard) are the cases above.
 */
describe.skipIf(!canRender)('preview jobs on the in-memory renderer', () => {
  it(
    'a cancel before start closes the job without rendering; an aborted signal stops renderComponentPreviews before any image',
    async () => {
      const sub = await engine.templates.preview({ project: 'demo' });
      await engine.jobs.cancel(sub.job.id);
      const renderer = new MemoryRenderer();
      await runWorker({ root, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined, heavyInProcess: true, ports: { renderer } });
      const job: JobRecord = await engine.jobs.get(sub.job.id);
      expect(job.state).toBe('cancelled');
      // Closed by the worker without a render: nothing reached the renderer.
      expect(renderer.calls).toEqual([]);
      expect(existsSync(join(root, '.retake', 'previews', sub.preview_id))).toBe(false);
      const ac = new AbortController();
      ac.abort();
      const out = join(root, 'aborted');
      const reg = await import('@retake/components').then((c) => c.loadComponentRegistry({ root }));
      const info = reg.get('studio/card-title');
      await expect(
        renderComponentPreviews({
          workPolicy: PERSON_POLICY,
          root,
          registry: reg,
          template: await loadPreviewTheme('editorial', root, fileFacts(PERSON_POLICY)),
          targets: [{ id: info.manifest.id, dir: info.dir, entry: info.entry, manifest: info.manifest }],
          outDir: out,
          signal: ac.signal,
        }),
      ).rejects.toMatchObject({ name: 'CancelledError' });
      expect(existsSync(out)).toBe(false);
    },
    LONG,
  );
});
