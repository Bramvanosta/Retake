/**
 * L4.7 part C: the Studio's theme ops (server/theme-ops.ts) over HTTP, on a scratch workspace whose templates_dir is
 * its own `templates/` (the starters stay starters) and the fixture project:
 * - theme_copy → theme_view: editable by real path, text and sha256; a starter read-only with why; path-free;
 * - ⚑ theme_edit: pinned inputs (a field outside the allow-list, an extra key, a path for a name → 400 before anything
 *   is read), if_match (409), restore only of a version shown (403 otherwise), two writes on one version → one 409;
 * - theme_create: `replace` pinned out; a new theme from a workspace logo; no folder in the answer;
 * - brand_files; site_list: a URL → the command to copy (no job queued, template_from_site not an op), a local URL → why;
 * - theme_preview: a `component-preview` served on the player origin under the project's capability (every URL one of
 *   the scope's, nothing of this Mac's folders), draft colours in memory only; ⚑ B10: a theme whose intro is its own
 *   image is not previewed; ⚑ a workspace component the preview renders is held until preview_allow; a theme page's
 *   lease ends with timeline_leave (the project's URLs revoked);
 * - the `themes` watch: a theme edit is a change of that theme only (library-watch.ts);
 * - L4.7 part D2: theme_list — ⚑ editable by real path (starters read-only with why, a workspace copy editable, the
 *   project's own folder theme read-only), hex colours only, what uses each, the components by id and kind, the
 *   project's scenarios; path-free.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { LIBRARY_DIR, scaffoldDir } from '@retake/components';
import type { ComponentPreviewSpec } from '@retake/editor';
import type { ThemeEditView } from '@retake/engine';
import { COMPONENT_PREVIEW_FORMAT, UI_OPS, WATCH_SCAN_BUDGET, libraryChanges, libraryWatchScan, startStudioServer } from '../src/index.js';
import type { SiteListAnswer, StudioServer, ThemePreviewAnswer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

const P = 'northfield-fixture';
const LEASE = 'themeLeaseAAAAAAAAAAA';
let ws: string;
let studio: StudioServer;
const savedHome = process.env.RETAKE_HOME;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
async function ok<T>(op: string, args: unknown): Promise<{ data: T; body: string }> {
  const r = await call(op, args);
  expect(r.status, `${op}: ${r.body.slice(0, 400)}`).toBe(200);
  return { data: r.json<{ data: T }>().data, body: r.body };
}
const pathFree = (body: string) => {
  expect(body).not.toContain(ws);
  expect(body).not.toContain(homedir());
};
/** A GET on the player origin (no Origin: the gate takes it), its path only. */
const playerGet = (url: string) => {
  const u = new URL(url);
  return raw(Number(u.port), 'GET', u.pathname);
};

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-theme-ops-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(ws, 'templates'));
  await mkdir(join(ws, 'brand'));
  await cp(join(LIBRARY_DIR, 'studio', 'card-title', 'preview.png'), join(ws, 'brand', 'logo.png'));
  // A workspace card the preview of it renders (held until allowed).
  const comp = join(ws, 'components', 'acme', 'held');
  await mkdir(comp, { recursive: true });
  await cp(scaffoldDir('card'), comp, { recursive: true });
  await writeFile(join(comp, 'component.yaml'), (await readFile(join(comp, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/held'));
  studio = await startStudioServer({ root: ws, startWorker: false });
}, 60_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

const viewOf = async (theme: string) => (await ok<ThemeEditView>('theme_view', { theme })).data;

describe('theme_copy, theme_view, theme_edit', () => {
  it('copy a starter, then its view: editable, text and sha256; the starter read-only with why; path-free', async () => {
    expect(UI_OPS).toEqual(expect.arrayContaining(['theme_view', 'theme_edit', 'theme_copy', 'theme_create', 'brand_files', 'site_list', 'theme_preview']));
    const c = await ok<{ name: string; from: string; files: string[] }>('theme_copy', { from: 'editorial', name: 'mine' });
    expect(c.data).toMatchObject({ name: 'mine', from: 'editorial' });
    expect(c.data.files).toContain('template.yaml');
    pathFree(c.body);
    const r = await ok<ThemeEditView>('theme_view', { theme: 'mine' });
    expect(r.data).toMatchObject({ name: 'mine', editable: true });
    expect(sha(r.data.yaml!)).toBe(r.data.sha256);
    expect(r.data.yaml).toBe(await readFile(join(ws, 'templates', 'mine', 'template.yaml'), 'utf8'));
    pathFree(r.body);
    const starter = await viewOf('editorial');
    expect(starter.editable).toEqual({ why: expect.stringMatching(/starter|copy it/) });
    // A second copy of that name: a conflict, nothing written.
    expect((await call('theme_copy', { from: 'editorial', name: 'mine' })).status).toBe(409);
  });

  it('⚑ pinned inputs: a field outside the allow-list, an extra key, a theme that is a path → 400 before anything is read', async () => {
    const v = await viewOf('mine');
    const bad = [
      { theme: 'mine', if_match: v.sha256, edit: { kind: 'set_field', field: 'captions.kicker.color', to: '#000000' } },
      { theme: 'mine', if_match: v.sha256, edit: { kind: 'set_field', field: 'colors.accent', to: '#000000', extra: 1 } },
      { theme: 'mine', if_match: v.sha256, edit: { kind: 'set_component', component: 'intro', id: '../x', params: 'keep' } },
      { theme: '../mine', if_match: v.sha256, edit: { kind: 'set_field', field: 'colors.accent', to: '#000000' } },
      { theme: 'mine', if_match: 'nope', edit: { kind: 'set_field', field: 'colors.accent', to: '#000000' } },
      { theme: 'mine', if_match: v.sha256, edit: { kind: 'restore', text: 'x', text_hash: 'nope' } },
      { theme: 'mine', if_match: v.sha256, edit: { kind: 'write_file', path: '/etc/hosts' } },
    ];
    for (const b of bad) expect((await call('theme_edit', b)).status, JSON.stringify(b.edit)).toBe(400);
    expect(await readFile(join(ws, 'templates', 'mine', 'template.yaml'), 'utf8')).toBe(v.yaml);
  });

  it('⚑ a write: the new sha256; if_match 409; restore of a version shown only; two writes on one version → one 409', async () => {
    const v = await viewOf('mine');
    const accent = v.fields['colors.accent'] as string;
    const w = await ok<{ sha256: string; label: string }>('theme_edit', { theme: 'mine', if_match: v.sha256, edit: { kind: 'set_field', field: 'colors.accent', from: accent, to: '#224466' } });
    const text = await readFile(join(ws, 'templates', 'mine', 'template.yaml'), 'utf8');
    expect(sha(text)).toBe(w.data.sha256);
    expect(text).toContain('#224466');
    pathFree(w.body);
    const stale = await call('theme_edit', { theme: 'mine', if_match: v.sha256, edit: { kind: 'set_field', field: 'style_bias', from: v.fields.style_bias, to: 'motion' } });
    expect(stale.status).toBe(409);
    // A logo outside the theme folder: refused, nothing written.
    const outside = await call('theme_edit', { theme: 'mine', if_match: w.data.sha256, edit: { kind: 'set_field', field: 'logo', from: v.fields.logo, to: '../../brand/logo.png' } });
    expect([400, 403]).toContain(outside.status);
    // Undo: the version shown (v.yaml) restored byte for byte; text never shown is refused.
    const forged = `${v.yaml}# made up\n`;
    expect((await call('theme_edit', { theme: 'mine', if_match: w.data.sha256, edit: { kind: 'restore', text: forged, text_hash: sha(forged) } })).status).toBe(403);
    const u = await ok<{ sha256: string }>('theme_edit', { theme: 'mine', if_match: w.data.sha256, edit: { kind: 'restore', text: v.yaml, text_hash: v.sha256 } });
    expect(u.data.sha256).toBe(v.sha256);
    expect(await readFile(join(ws, 'templates', 'mine', 'template.yaml'), 'utf8')).toBe(v.yaml);
    // One at a time: two edits on the same version → one written, one 409.
    const both = await Promise.all([
      call('theme_edit', { theme: 'mine', if_match: v.sha256, edit: { kind: 'set_field', field: 'style_bias', from: v.fields.style_bias, to: 'motion' } }),
      call('theme_edit', { theme: 'mine', if_match: v.sha256, edit: { kind: 'set_field', field: 'style_bias', from: v.fields.style_bias, to: 'real' } }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('the themes watch: an edit of a theme changes that theme only', async () => {
    const o = { root: ws, componentsDir: join(ws, 'components'), templatesDir: join(ws, 'templates') };
    const before = await libraryWatchScan(o);
    const v = await viewOf('mine');
    await ok('theme_edit', { theme: 'mine', if_match: v.sha256, edit: { kind: 'set_background', from: v.background, to: { type: 'solid', color: '#fafafa' } } });
    expect(libraryChanges(before, await libraryWatchScan(o))).toEqual({ themes: ['mine'] });
  });

  it('⚑ review A L4: one entry budget per scan; past it, folders get a coarse signature (their own stat), nothing walked', async () => {
    const comps = join(ws, 'watch-budget', 'components');
    for (const ns of ['aa', 'bb', 'cc']) {
      for (let i = 0; i < 4; i++) {
        await mkdir(join(comps, ns, `c${i}`), { recursive: true });
        await writeFile(join(comps, ns, `c${i}`, 'index.tsx'), `export const x = ${i};\n`);
      }
    }
    const templatesDir = join(ws, 'watch-budget', 'templates');
    for (const t of ['t1', 't2']) await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), join(templatesDir, t), { recursive: true });
    const o = { root: join(ws, 'watch-budget'), componentsDir: comps, templatesDir };
    // Unbounded enough: every namespace and theme walked.
    const full = await libraryWatchScan(o);
    expect([...full.values()].some((v) => v.startsWith('coarse'))).toBe(false);
    // 10 entries: "aa" (4 folders + 4 files) fits, "bb" is cut, "cc" and every theme are coarse.
    const small = await libraryWatchScan({ ...o, budget: 10 });
    expect(small.get('components:aa')).toBe(full.get('components:aa'));
    expect(small.get('components:bb')).not.toBe(full.get('components:bb'));
    expect(small.get('components:cc')).toMatch(/^coarse /);
    expect([...small].filter(([k]) => k.startsWith('themes:')).map(([k, v]) => [k, v.slice(0, 7)])).toEqual([
      ['themes:t1', 'coarse '],
      ['themes:t2', 'coarse '],
    ]);
    // A coarse folder still says when an entry is added to it.
    await mkdir(join(comps, 'cc', 'c9'));
    const next = await libraryWatchScan({ ...o, budget: 10 });
    expect(libraryChanges(small, next).components).toEqual(['cc']);
    expect(WATCH_SCAN_BUDGET).toBe(20_000);
  });
});

describe('theme_create, brand_files, site_list', () => {
  it('theme_create: replace pinned out; a new theme from a workspace logo; no folder in the answer', async () => {
    const input = { name: 'brandy', colors: { accent: '#3355aa' }, logo: 'brand/logo.png' };
    expect((await call('theme_create', { ...input, replace: true })).status).toBe(400);
    expect((await call('theme_create', { ...input, logo: '/etc/hosts' })).status).toBe(400);
    const r = await ok<Record<string, unknown>>('theme_create', input);
    expect(r.data).toMatchObject({ name: 'brandy', base: 'editorial', replaced: false });
    expect(r.data.dir).toBeUndefined();
    pathFree(r.body);
    expect((await viewOf('brandy')).editable).toBe(true);
  });

  it('brand_files lists the workspace images; site_list: a URL → the command to copy, never a job; a local URL → why', async () => {
    const f = await ok<{ files: Array<{ ref: string }> }>('brand_files', { kind: 'image' });
    expect(f.data.files.map((x) => x.ref)).toContain('brand/logo.png');
    expect((await call('brand_files', { kind: 'script' })).status).toBe(400);
    expect(UI_OPS).not.toContain('template_from_site');
    const s = await ok<SiteListAnswer>('site_list', { url: 'https://example.com/pricing' });
    expect(s.data.sites).toEqual([]);
    // The command keeps the workspace (the person copies it into a terminal).
    expect(s.data.command?.line).toBe(`${studio.engine.cli} theme from-site https://example.com/pricing`);
    expect(s.data.command?.untrusted.host).toBe('example.com');
    const local = await ok<SiteListAnswer>('site_list', { url: 'http://127.0.0.1:4401/' });
    expect(local.data.command).toBeUndefined();
    expect(local.data.url_problem).toBeTruthy();
    expect(await studio.engine.jobs.list({ kinds: ['site'] })).toEqual([]);
  });
});

describe('theme_preview', () => {
  const previewOf = async (args: Record<string, unknown>) => (await ok<ThemePreviewAnswer>('theme_preview', { project: P, lease: LEASE, ...args })).data;
  const served = async (d: ThemePreviewAnswer): Promise<ComponentPreviewSpec> => {
    if (!('plan_url' in d)) throw new Error(`no preview: ${JSON.stringify(d)}`);
    const r = await playerGet(d.plan_url);
    expect(r.status).toBe(200);
    const doc = r.json<{ format: string; spec: ComponentPreviewSpec }>();
    expect(doc.format).toBe(COMPONENT_PREVIEW_FORMAT);
    return doc.spec;
  };

  it('intro, clip, outro and one component: a component-preview on the player origin, every URL one of the scope\'s; drafts in memory only', async () => {
    const before = await readFile(join(ws, 'templates', 'mine', 'template.yaml'), 'utf8');
    for (const target of ['intro', 'clip', 'outro', { component: 'studio/card-title' }]) {
      const r = await call('theme_preview', { project: P, theme: 'mine', target, lease: LEASE });
      expect(r.status, r.body.slice(0, 300)).toBe(200);
      pathFree(r.body);
      const d = r.json<{ data: ThemePreviewAnswer }>().data;
      expect('preview_error' in d ? d.preview_error : '').toBe('');
      expect(d).toMatchObject({ theme: 'mine', frame_url: expect.stringContaining(`${studio.player.origin}/s/`) });
      const spec = await served(d);
      // The address a browser layout draws in its bar is text (PREVIEW_DISPLAY_TEXT); every other URL is the scope's.
      const text = JSON.stringify({ ...spec, ...(spec.scene ? { scene: { ...spec.scene, url: undefined } } : {}) });
      expect(text).not.toContain(ws);
      expect(text).not.toContain(homedir());
      const media = d.plan_url.slice(0, d.plan_url.indexOf('/plan/') + 1);
      for (const u of text.match(/https?:\/\/[^"]+/g) ?? []) expect(u.startsWith(media), u).toBe(true);
      if (target === 'clip') expect(spec.scene).toBeDefined();
    }
    const d = await previewOf({ theme: 'mine', target: 'intro', draft: { colors: { accent: '#AA0000' } } });
    const spec = await served(d);
    expect(spec.theme.colors.accent).toBe('#aa0000');
    // A font of the theme is served under the capability.
    const font = spec.theme.font_faces?.[0]?.url;
    expect(font).toBeTruthy();
    expect((await playerGet(font!)).status).toBe(200);
    expect(await readFile(join(ws, 'templates', 'mine', 'template.yaml'), 'utf8')).toBe(before);
    // Pinned: a draft colour that is not hex, a target that is a path.
    expect((await call('theme_preview', { project: P, theme: 'mine', target: 'intro', lease: LEASE, draft: { colors: { accent: 'url(x)' } } })).status).toBe(400);
    expect((await call('theme_preview', { project: P, theme: 'mine', target: { component: '../../x' }, lease: LEASE })).status).toBe(400);
    // Review A N2: a page always holds a lease (a preview no lease holds would lose its URLs to another page's leave).
    expect((await call('theme_preview', { project: P, theme: 'mine', target: 'intro' })).status).toBe(400);
  });

  it('⚑ B10: a theme whose intro is its own image is not previewed (no sample stands for it)', async () => {
    await ok('theme_copy', { from: 'editorial', name: 'media' });
    const dir = join(ws, 'templates', 'media');
    await cp(join(LIBRARY_DIR, 'studio', 'card-title', 'preview.png'), join(dir, 'intro.png'));
    const yaml = await readFile(join(dir, 'template.yaml'), 'utf8');
    await writeFile(join(dir, 'template.yaml'), yaml.replace('  intro: studio/intro-stack', '  intro: {image: intro.png}'));
    const d = await previewOf({ theme: 'media', target: 'intro' });
    expect(d).toMatchObject({ theme: 'media', not_previewed: expect.stringMatching(/its own video, image or Lottie/) });
    expect('frame_url' in d).toBe(false);
    // Its outro (a component) still previews.
    expect('frame_url' in (await previewOf({ theme: 'media', target: 'outro' }))).toBe(true);
  });

  it('⚑ a workspace component the preview renders is held until the person allows it (preview_allow)', async () => {
    const d = await previewOf({ theme: 'mine', target: { component: 'acme/held' } });
    expect(d.preview_held).toEqual([{ id: 'acme/held', kind: 'card', hash: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    const allowed = await call('preview_allow', { id: 'acme/held', hash: d.preview_held![0].hash });
    expect(allowed.status).toBe(200);
    expect((await previewOf({ theme: 'mine', target: { component: 'acme/held' } })).preview_held).toBeUndefined();
    // A built-in never is.
    expect((await previewOf({ theme: 'mine', target: 'intro' })).preview_held).toBeUndefined();
  });

  it("a theme page's lease ends with timeline_leave: the project's preview URLs are revoked", async () => {
    const d = await previewOf({ theme: 'mine', target: 'intro', lease: LEASE });
    if (!('plan_url' in d)) throw new Error('no preview');
    expect((await playerGet(d.plan_url)).status).toBe(200);
    const left = await ok<{ revoked: boolean }>('timeline_leave', { project: P, lease: LEASE });
    expect(left.data.revoked).toBe(true);
    expect((await playerGet(d.plan_url)).status).toBe(404);
  });
});

describe('theme_list (part D2)', () => {
  it('⚑ editable by real path: starters read-only with why, a workspace theme editable, the project\'s own folder theme read-only; path-free', async () => {
    // A second project whose theme is its own folder (a path in project.yaml).
    const own = join(ws, 'projects', 'own');
    await mkdir(join(own, 'scenarios'), { recursive: true });
    await cp(join(ws, 'templates', 'mine'), join(own, 'theme'), { recursive: true });
    await writeFile(join(own, 'project.yaml'), 'version: 1\nname: Own\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ./theme\n');
    type List = { project: string; project_theme?: string; themes: Array<{ name: string; source: string; default?: true; editable: true | { why: string }; colors: Record<string, string>; issues: string[]; used_by: { projects: string[]; scenarios: unknown[] } }>; components: Array<{ id: string; kind: string; source: string }>; scenarios: string[] };
    const r = await ok<List>('theme_list', { project: P });
    pathFree(r.body);
    const by = new Map(r.data.themes.map((t) => [t.name, t]));
    expect(r.data.project_theme).toBe('editorial');
    expect(by.get('editorial')).toMatchObject({ source: 'starter', default: true, editable: { why: expect.stringMatching(/starter theme shipped with Retake: copy it to edit it/) }, colors: { accent: '#8a2332' } });
    expect(by.get('editorial')!.used_by.projects).toContain(P);
    for (const n of ['default', 'motion']) expect(by.get(n)!.editable).toMatchObject({ why: expect.any(String) });
    expect(by.get('mine')).toMatchObject({ source: 'workspace', editable: true, issues: [] });
    expect(by.get('mine')!.default).toBeUndefined();
    expect(r.data.components.find((c) => c.id === 'acme/held')).toEqual({ id: 'acme/held', kind: 'card', source: 'workspace' });
    expect(r.data.components.find((c) => c.id === 'studio/card-title')).toMatchObject({ kind: 'card', source: 'builtin' });
    expect(r.data.scenarios).toContain('quote');
    for (const t of r.data.themes) for (const v of Object.values(t.colors)) expect(v).toMatch(/^#[0-9a-f]{3,6}$/);
    // The project whose theme is its own folder: listed first, read-only (by hand), never a folder path beyond its own ref.
    const o = await ok<List>('theme_list', { project: 'own' });
    expect(o.data.themes[0]).toMatchObject({ name: './theme', source: 'project', default: true, editable: { why: expect.stringMatching(/project's own theme folder/) } });
    pathFree(o.body);
    // Pinned input: a path for a project → 400.
    expect((await call('theme_list', { project: '../x' })).status).toBe(400);
    expect((await call('theme_list', { project: P, extra: 1 })).status).toBe(400);
    await rm(own, { recursive: true, force: true });
  });
});
