/**
 * L4.7 part A2: the Studio's theme write path (engine theme-edit.ts; critique B7, B14, B15): the editor's view of a
 * theme and one verified write of its template.yaml, on a scratch workspace with a copy of the editorial starter.
 * - ⚑ editable by real path, never by `source` (B15): a starter, the repository's starters listed as `workspace`, a
 *   linked folder, a linked or hard-linked template.yaml, a theme outside the workspace are read-only with why, and a
 *   write to one is refused;
 * - ⚑ if_match (a conflict names the current hash), a value changed since read (stale), the verify, hidden characters;
 * - ⚑ files a theme names: regular files of its own folder only — no symbolic or hard link, images and SVGs checked,
 *   fonts sniffed; the registry resolves the components (kept params validated);
 * - ⚑ restore only a version shown or written, byte-exact (B14); MCP never edits a theme;
 * - the view: path-free, fields, components, fonts and images checked, palette checks, used by (projects and
 *   scenarios); a scenario's `template` is a theme the workspace lists (B1).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { THEME_USES_STATS, createEngine, openWorkspace, templateView } from '../src/index.js';
import type { Engine, EngineError } from '../src/index.js';
import { REPO } from '@retake/test-support/repo';
import { scratchHome } from '@retake/test-support/home';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
let root: string;
let engine: Engine;
let mcp: Engine;
const retakeHome = scratchHome();
const themeDir = () => join(root, 'templates', 'brand');
const themeFile = () => join(themeDir(), 'template.yaml');
const ORIGINAL = readFileSync(join(STARTER_TEMPLATES_DIR, 'editorial', 'template.yaml'), 'utf8').replace('name: editorial', 'name: brand');
/** A PNG's first bytes (signature + IHDR) of a w × h image: what checkImage reads. */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
async function failure(p: Promise<unknown>): Promise<EngineError> {
  try {
    await p;
  } catch (e) {
    return e as EngineError;
  }
  throw new Error('did not fail');
}
async function reset(): Promise<string> {
  await writeFile(themeFile(), ORIGINAL);
  return (await engine.templates.view('brand')).sha256;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-theme-edit-'));
  retakeHome.use(join(root, '.home'));
  await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), themeDir(), { recursive: true });
  await writeFile(themeFile(), ORIGINAL);
  const project = join(root, 'projects', 'demo');
  await mkdir(join(project, 'scenarios'), { recursive: true });
  await writeFile(join(project, 'project.yaml'), 'version: 1\nname: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: brand\n');
  await writeFile(join(project, 'scenarios', 'q.yaml'), 'video: Q\ntemplate: brand\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n');
  await writeFile(join(project, 'scenarios', 'other.yaml'), 'video: O\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n');
  engine = await createEngine({ root, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  retakeHome.restore();
  await rm(root, { recursive: true, force: true });
});

describe('theme view (L4.7)', () => {
  it('fields, components, fonts and images checked, palette checks, used by — path-free', async () => {
    const v = await engine.templates.view('brand');
    expect(v).toMatchObject({ name: 'brand', source: 'workspace', editable: true, sha256: sha(ORIGINAL), yaml: ORIGINAL, issues: [], warnings: [] });
    expect(v.fields).toMatchObject({
      'colors.accent': '#8a2332',
      'background.from': '#f8f4ef',
      'brand.name': 'Atelier',
      logo: 'logo.svg',
      'fonts.body': ['fonts/Inter-Regular.ttf', 'fonts/Inter-SemiBold.ttf', 'fonts/Inter-Bold.ttf'],
      'motion.default_zoom': 'none',
    });
    expect(v.background).toEqual({ type: 'radial', from: '#f8f4ef', to: '#ebe4dc' });
    expect(v.components.layout).toEqual({
      written: 'params',
      id: 'studio/layout-card',
      params: { width: 1560, radius: 18, shadow: 'soft' },
      resolved: { id: 'studio/layout-card', params: expect.objectContaining({ width: 1560 }) },
    });
    expect(v.components.intro).toMatchObject({ written: 'id', id: 'studio/intro-stack', resolved: { id: 'studio/intro-stack' } });
    expect(v.fonts.map((f) => [f.file, f.weight, f.problem]).sort()).toEqual([
      ['fonts/InstrumentSerif-Regular.ttf', 400, undefined],
      ['fonts/Inter-Bold.ttf', 700, undefined],
      ['fonts/Inter-Regular.ttf', 400, undefined],
      ['fonts/Inter-SemiBold.ttf', 600, undefined],
    ]);
    expect(v.images.map((i) => [i.file, i.format])).toEqual([
      ['logo.svg', 'svg'],
      ['wordmark.svg', 'svg'],
    ]);
    expect(v.untrusted.fonts.find((f) => f.file === 'fonts/Inter-Bold.ttf')?.family).toMatch(/Inter/);
    expect(v.palette?.checks.find((c) => c.check === 'text_on_paper')?.ok).toBe(true);
    expect(v.used_by).toEqual({ projects: ['demo'], scenarios: [{ project: 'demo', scenario: 'q' }] });
    const json = JSON.stringify(v);
    for (const bad of [root, themeDir(), '/Users/', tmpdir()]) expect(json, bad).not.toContain(bad);
  });

  it("review B L6: used_by is memoised on the projects' file-level signature (no re-parse while nothing moved)", async () => {
    await engine.templates.view('brand');
    const n = THEME_USES_STATS.computed;
    await engine.templates.view('brand');
    await engine.templates.view('brand');
    expect(THEME_USES_STATS.computed).toBe(n);
    // A scenario naming the theme: the signature moves, used_by follows.
    const extra = join(root, 'projects', 'demo', 'scenarios', 'extra.yaml');
    await writeFile(extra, 'video: E\ntemplate: brand\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n');
    try {
      expect((await engine.templates.view('brand')).used_by.scenarios).toContainEqual({ project: 'demo', scenario: 'extra' });
      expect(THEME_USES_STATS.computed).toBe(n + 1);
    } finally {
      await rm(extra);
    }
    expect((await engine.templates.view('brand')).used_by).toEqual({ projects: ['demo'], scenarios: [{ project: 'demo', scenario: 'q' }] });
  });

  it("⚑ editable by real path (critique B15): starters, the repository's starters, links and hard links are read-only with why", async () => {
    expect((await engine.templates.view('motion')).editable).toEqual({ why: expect.stringMatching(/starter theme shipped with Retake: copy it to edit it/) });
    // The repository as a workspace lists its starters as `workspace` (templates_dir: templates): still not editable.
    const repoWs = await openWorkspace({ root: REPO, agent: false });
    const rv = await templateView(repoWs, 'editorial');
    expect(rv.source).toBe('workspace');
    expect(rv.editable).toEqual({ why: expect.stringMatching(/shipped with Retake \(its folder lies in the Retake package\)/) });
    // A theme folder that is a link to another folder is not even listed (core listTemplates takes real folders).
    await cp(themeDir(), join(root, 'elsewhere', 'real'), { recursive: true });
    await symlink(join(root, 'elsewhere', 'real'), join(root, 'templates', 'linked'));
    expect((await failure(engine.templates.view('linked'))).code).toBe('not_found');
    const e1 = await failure(engine.templates.edit('linked', { if_match: sha(ORIGINAL), edit: { kind: 'set_field', field: 'style_bias', from: 'real', to: 'motion' } }));
    expect(e1.code).toBe('not_found');
    // A template.yaml that is a symbolic link, or that has a second name.
    await cp(themeDir(), join(root, 'templates', 'tlink'), { recursive: true });
    await rm(join(root, 'templates', 'tlink', 'template.yaml'));
    await symlink(themeFile(), join(root, 'templates', 'tlink', 'template.yaml'));
    expect((await engine.templates.view('tlink')).editable).toEqual({ why: expect.stringMatching(/template.yaml is a symbolic link/) });
    await cp(themeDir(), join(root, 'templates', 'hard'), { recursive: true });
    await rm(join(root, 'templates', 'hard', 'template.yaml'));
    await link(join(root, 'elsewhere', 'real', 'template.yaml'), join(root, 'templates', 'hard', 'template.yaml'));
    const hv = await engine.templates.view('hard');
    expect(hv.editable).toEqual({ why: expect.stringMatching(/another name \(a hard link\)/) });
    const e2 = await failure(engine.templates.edit('hard', { if_match: hv.sha256, edit: { kind: 'set_field', field: 'style_bias', from: 'real', to: 'motion' } }));
    expect(e2.code).toBe('refused');
    expect(readFileSync(join(root, 'elsewhere', 'real', 'template.yaml'), 'utf8')).toBe(ORIGINAL);
    // A name that is a path, or not listed.
    expect((await failure(engine.templates.view('../templates/brand'))).code).toBe('invalid');
    expect((await failure(engine.templates.view('nope'))).code).toBe('not_found');
    for (const n of ['linked', 'tlink', 'hard']) await rm(join(root, 'templates', n), { recursive: true, force: true });
  });
});

describe('theme edit (L4.7)', () => {
  it('a field written: the file spliced, the new hash, the label; the next edit takes the new hash', async () => {
    const hash = await reset();
    const r = await engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#123456', ripple: true } });
    const now = await readFile(themeFile(), 'utf8');
    expect(r).toMatchObject({ name: 'brand', sha256: sha(now), removed: [], warnings: [] });
    expect(r.label).toMatch(/^Set the accent colour to #123456, the cursor ripple following/);
    expect(now).toBe(ORIGINAL.replace('accent: "#8a2332"', 'accent: "#123456"').replace('"rgba(138, 35, 50, 0.45)"', '"rgba(18, 52, 86, 0.45)"'));
    const r2 = await engine.templates.edit('brand', {
      if_match: r.sha256,
      edit: { kind: 'set_component', component: 'layout', from: 'studio/layout-card', id: 'studio/layout-browser', params: 'keep' },
    });
    expect(r2.removed).toEqual(['frame.style', 'frame.width', 'frame.radius', 'frame.shadow']);
    expect(r2.kept_params).toEqual({ width: 1560, radius: 18, shadow: 'soft' });
    expect((await engine.templates.view('brand')).components.layout).toMatchObject({ written: 'params', id: 'studio/layout-browser' });
  });

  it('⚑ if_match: a stale hash is a conflict naming the current one; a value changed meanwhile is stale; nothing written', async () => {
    const hash = await reset();
    const e = await failure(engine.templates.edit('brand', { if_match: sha('old'), edit: { kind: 'set_field', field: 'style_bias', from: 'real', to: 'motion' } }));
    expect(e.code).toBe('conflict');
    expect(e.details).toMatchObject({ current: hash });
    const s = await failure(engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field: 'style_bias', from: 'balanced', to: 'motion' } }));
    expect(s.code).toBe('conflict');
    expect(s.details).toMatchObject({ stale: true, current: hash });
    expect(await readFile(themeFile(), 'utf8')).toBe(ORIGINAL);
    // Two writes made on the same version: one wins, the other is a conflict (the write lock + if_match).
    const both = await Promise.allSettled([
      engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field: 'style_bias', from: 'real', to: 'motion' } }),
      engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field: 'style_bias', from: 'real', to: 'balanced' } }),
    ]);
    expect(both.filter((b) => b.status === 'fulfilled')).toHaveLength(1);
    expect((both.find((b) => b.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('conflict');
  });

  it('⚑ the allow-list and values (core applyThemeEdit): refused as invalid, nothing written', async () => {
    const hash = await reset();
    for (const edit of [
      { kind: 'set_field', field: 'captions.kicker.color', to: '#000000' },
      { kind: 'set_field', field: 'fonts.display', from: 'fonts/InstrumentSerif-Regular.ttf', to: '../x.ttf' },
      { kind: 'set_field', field: 'logo', from: 'logo.svg', to: '/etc/logo.png' },
      { kind: 'set_component', component: 'intro', from: 'studio/intro-stack', id: 'studio/intro-stack', params: 'drop' },
      { kind: 'replace_text', text: 'x' },
    ]) {
      const e = await failure(engine.templates.edit('brand', { if_match: hash, edit: edit as never }));
      expect(e.code, JSON.stringify(edit)).toBe('invalid');
    }
    expect(await readFile(themeFile(), 'utf8')).toBe(ORIGINAL);
  });

  it('⚑ files a theme names are regular files of its own folder: no link, no hard link, images and fonts checked', async () => {
    const hash = await reset();
    const edit = (field: string, from: unknown, to: unknown) => engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field, from, to } as never });
    expect((await failure(edit('logo', 'logo.svg', 'missing.png'))).message).toMatch(/does not exist in the theme folder/);
    await writeFile(join(root, 'outside.png'), png(400, 200));
    await symlink(join(root, 'outside.png'), join(themeDir(), 'linked.png'));
    expect((await failure(edit('logo', 'logo.svg', 'linked.png'))).message).toMatch(/goes through a symbolic link/);
    await mkdir(join(root, 'elsewhere-dir'), { recursive: true });
    await writeFile(join(root, 'elsewhere-dir', 'logo.png'), png(400, 200));
    await symlink(join(root, 'elsewhere-dir'), join(themeDir(), 'brandlink'));
    expect((await failure(edit('logo', 'logo.svg', 'brandlink/logo.png'))).message).toMatch(/goes through a symbolic link/);
    await link(join(root, 'outside.png'), join(themeDir(), 'hard.png'));
    expect((await failure(edit('logo', 'logo.svg', 'hard.png'))).message).toMatch(/another name \(a hard link\)/);
    await writeFile(join(themeDir(), 'fake.png'), 'not a png at all, just text');
    expect((await failure(edit('logo', 'logo.svg', 'fake.png'))).message).toMatch(/not a PNG, JPEG or WebP/);
    await writeFile(join(themeDir(), 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>');
    expect((await failure(edit('wordmark', 'wordmark.svg', 'evil.svg'))).message).toMatch(/SVG this tool does not copy/);
    await writeFile(join(themeDir(), 'fonts', 'Fake.ttf'), 'not a font');
    expect((await failure(edit('fonts.display', 'fonts/InstrumentSerif-Regular.ttf', 'fonts/Fake.ttf'))).message).toMatch(/not a usable font/);
    expect(await readFile(themeFile(), 'utf8')).toBe(ORIGINAL);
    // A real file of the folder is taken.
    await mkdir(join(themeDir(), 'brand'), { recursive: true });
    await writeFile(join(themeDir(), 'brand', 'logo-2.png'), png(400, 200));
    const ok = await edit('logo', 'logo.svg', 'brand/logo-2.png');
    expect(ok.label).toBe('Set the logo to brand/logo-2.png');
    for (const f of ['linked.png', 'brandlink', 'hard.png', 'fake.png', 'evil.svg', 'fonts/Fake.ttf', 'brand']) await rm(join(themeDir(), f), { recursive: true, force: true });
  });

  it('⚑ the registry resolves the components: an unknown id, the wrong kind, kept params the new component refuses', async () => {
    const hash = await reset();
    const comp = (component: string, from: string, id: string, params: 'keep' | 'drop') =>
      engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_component', component, from, id, params } as never });
    expect((await failure(comp('intro', 'studio/intro-stack', 'acme/missing', 'drop'))).message).toMatch(/acme\/missing/);
    expect((await failure(comp('layout', 'studio/layout-card', 'studio/caption-below', 'drop'))).code).toBe('invalid');
    expect((await failure(comp('layout', 'studio/layout-card', 'studio/layout-raw', 'keep'))).code).toBe('invalid');
    expect(await readFile(themeFile(), 'utf8')).toBe(ORIGINAL);
  });

  it('⚑ hidden characters: an edit of a line holding one is refused; the file keeps its own elsewhere', async () => {
    const text = ORIGINAL.replace('# deep wine', '# deep‮wine');
    await writeFile(themeFile(), text);
    const hash = (await engine.templates.view('brand')).sha256;
    const e = await failure(engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#000000' } }));
    expect(e.message).toMatch(/U\+202E/);
    const ok = await engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field: 'colors.text', from: '#1f1413', to: '#000000' } });
    expect(await readFile(themeFile(), 'utf8')).toContain('# deep‮wine');
    expect(ok.sha256).not.toBe(hash);
  });

  it('⚑ restore (critique B14): only a version shown or written, byte-exact; made-up text refused', async () => {
    const hash = await reset();
    const r = await engine.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field: 'brand.name', from: 'Atelier', to: 'Northfield' } });
    const back = await engine.templates.edit('brand', { if_match: r.sha256, edit: { kind: 'restore', text: ORIGINAL, text_hash: sha(ORIGINAL) } });
    expect(back.label).toBe('Restored an earlier version');
    expect(await readFile(themeFile(), 'utf8')).toBe(ORIGINAL);
    // Redo: the version it wrote.
    const now = await readFile(themeFile(), 'utf8');
    const redoText = ORIGINAL.replace('{name: Atelier,', '{name: Northfield,');
    await engine.templates.edit('brand', { if_match: sha(now), edit: { kind: 'restore', text: redoText, text_hash: sha(redoText) } });
    expect(await readFile(themeFile(), 'utf8')).toBe(redoText);
    const made = ORIGINAL.replace('{name: Atelier,', '{name: Made Up,');
    const e = await failure(engine.templates.edit('brand', { if_match: sha(redoText), edit: { kind: 'restore', text: made, text_hash: sha(made) } }));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/not a version of brand\/template.yaml the Studio showed or wrote/);
    const wrong = await failure(engine.templates.edit('brand', { if_match: sha(redoText), edit: { kind: 'restore', text: ORIGINAL, text_hash: sha('x') } }));
    expect(wrong.code).toBe('invalid');
    expect(await readFile(themeFile(), 'utf8')).toBe(redoText);
  });

  it('⚑ MCP never edits a theme (refused whatever the transport)', async () => {
    const hash = await reset();
    const e = await failure(mcp.templates.edit('brand', { if_match: hash, edit: { kind: 'set_field', field: 'style_bias', from: 'real', to: 'motion' } }));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/never edited through MCP/);
    expect(await readFile(themeFile(), 'utf8')).toBe(ORIGINAL);
  });
});

describe("a scenario's theme (critique B1)", () => {
  it('set_field template takes a theme the workspace lists, never another name', async () => {
    const s = await engine.scenarios.get('demo', 'other');
    const e = await failure(engine.scenarios.edit('demo', 'other', { hash: s.hash, edit: { kind: 'set_field', at: { entry: 'top' }, field: 'template', to: 'nope' } }));
    expect(e.code).toBe('invalid');
    expect(e.message).toMatch(/"nope" is not a theme of this workspace \(themes: brand, default, editorial, motion\)/);
    const ok = await engine.scenarios.edit('demo', 'other', { hash: s.hash, edit: { kind: 'set_field', at: { entry: 'top' }, field: 'template', to: 'motion' } });
    expect(ok).toMatchObject({ label: 'Set the theme to motion', change: 'edit' });
    expect((await engine.templates.view('brand')).used_by.scenarios).toEqual([{ project: 'demo', scenario: 'q' }]);
  });
});
