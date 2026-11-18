/**
 * a project's own themes and brand files through the engine (R-SHR-11 … R-SHR-16), on a scratch workspace.
 * - lists: template_list {project} says each theme's origin, a project theme hiding another (`shadows`, notices), the
 *   folder project.yaml names by its path one row with the named theme; the editor's list the same;
 * - writers: a theme made from brand files, copied or updated with a project lands in `<project>/templates/` through the
 *   project's store (journaled with its slug); through MCP a workspace theme's name is refused for a project theme, at a
 *   terminal said; a project whose templates/ is templates_dir has no target of its own;
 * - the editor: a project theme is editable (a real folder directly in its templates/), its write lands there; a linked
 *   one is read-only; `used_by` follows the folder each reference loads;
 * - brand files: the project folder first, then the workspace root; through MCP a project file leaving the project is
 *   refused without looking elsewhere; a project's scenarios/ and components/ are no source; brand_files lists the
 *   project's first; a recorded input is read again where it was found;
 * - no MCP writer puts anything but template.yaml, its provenance, LICENSES.md and brand files into a theme folder.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { STARTER_TEMPLATES_DIR, loadWorkspaceConfig } from '@retake/core/io';
import { packageRegistries } from '@retake/compose';
import { THEME_PROVENANCE_FILE, createThemeFromBrand } from '../src/brand/create.js';
import { readBrandFile } from '../src/brand/files.js';
import { createEngine } from '../src/index.js';
import type { Engine, EngineError } from '../src/index.js';
import { themeKey } from '../src/operations/themes.js';
import { enginePorts } from '../src/ports.js';
import { readJournal } from '../src/store/journal.js';
import { personScope } from '../src/store/project-store.js';
import { projectThemeTarget } from '../src/theme-target.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';
import { openProjectBySlug } from '../src/projects.js';

const T = STARTER_TEMPLATES_DIR;
let root: string;
let mcp: Engine;
let ui: Engine;
const proj = () => join(root, 'projects', 'demo');

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  if (!e) throw new Error('expected a refusal');
  return e;
}
const input = (o: Record<string, unknown> = {}) => ({ name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg', ...o });
const opened = async () => ({ ...(await loadWorkspaceConfig(root)), policy: PERSON_POLICY, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-theme-project-'));
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  // The workspace's logo is the editorial one; the project's own brand/logo.svg the motion one: told apart by bytes.
  await mkdir(join(root, 'brand'), { recursive: true });
  await cp(join(T, 'editorial', 'logo.svg'), join(root, 'brand', 'logo.svg'));
  await cp(join(T, 'editorial', 'logo.svg'), join(root, 'brand', 'only-here.svg'));
  await mkdir(join(proj(), 'brand'), { recursive: true });
  await mkdir(join(proj(), 'scenarios'), { recursive: true });
  await cp(join(T, 'motion', 'logo.svg'), join(proj(), 'brand', 'logo.svg'));
  await writeFile(join(proj(), 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: brand\n');
  await writeFile(join(proj(), 'scenarios', 'q.yaml'), 'video: Q\ntemplate: brand\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n');
  await mkdir(join(root, 'projects', 'other', 'scenarios'), { recursive: true });
  await writeFile(join(root, 'projects', 'other', 'project.yaml'), 'name: Other\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: brand\n');
  // A workspace theme `brand` and the project's own `brand` (hiding it), plus a project theme of a starter's name.
  await cp(join(T, 'editorial'), join(root, 'templates', 'brand'), { recursive: true });
  await cp(join(T, 'editorial'), join(proj(), 'templates', 'brand'), { recursive: true });
  await cp(join(T, 'default'), join(proj(), 'templates', 'motion'), { recursive: true });
  mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  ui = await createEngine({ root, client: 'ui', autoStartWorker: false });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('lists say each theme origin (R-SHR-11)', () => {
  it("template_list {project}: the project's own first, each origin, what it hides said once; no project: the workspace's", async () => {
    const v = await mcp.templates.list({ project: 'demo' });
    expect(v.templates.map((t) => `${t.name}:${t.source}${t.shadows ? `>${t.shadows}` : ''}${t.default ? '*' : ''}`)).toEqual([
      'brand:project>workspace*',
      'default:starter',
      'editorial:starter',
      'motion:project>starter',
    ]);
    expect(v.project_templates_dir).toBe(join(proj(), 'templates'));
    expect(v.notices).toEqual([
      'the project\'s theme "brand" is used instead of the workspace\'s theme of that name',
      'the project\'s theme "motion" is used instead of the starter theme of that name',
    ]);
    const plain = await mcp.templates.list();
    expect(plain.templates.map((t) => `${t.name}:${t.source}`)).toEqual(['brand:workspace', 'default:starter', 'editorial:starter', 'motion:starter']);
    expect(plain.notices).toBeUndefined();
    expect((await mcp.templates.get({ project: 'demo', template: 'brand' })).dir).toBe(join(proj(), 'templates', 'brand'));
  });

  it('project.yaml naming a folder of its templates/ by its path is that named theme: one row, editable', async () => {
    await writeFile(join(proj(), 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ./templates/brand\n');
    const v = await mcp.templates.list({ project: 'demo' });
    expect(v.templates.filter((t) => t.dir === join(proj(), 'templates', 'brand')).map((t) => [t.name, t.source, t.default, t.by_path])).toEqual([['brand', 'project', true, undefined]]);
    const e = await ui.templates.editList('demo');
    const rows = e.themes.filter((t) => t.name === 'brand');
    expect(rows.map((t) => [t.source, t.default, t.editable === true])).toEqual([['project', true, true]]);
    // A path theme outside templates/: its own read-only row, by_path.
    await cp(join(T, 'editorial'), join(proj(), 'themes', 'own'), { recursive: true });
    await writeFile(join(proj(), 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ./themes/own\n');
    const own = (await ui.templates.editList('demo')).themes.find((t) => t.name === './themes/own');
    expect(own).toMatchObject({ source: 'project', by_path: true, default: true });
    expect(own?.editable).not.toBe(true);
  });

  it('used_by follows the folder each reference loads: the workspace brand is used by the other project only', async () => {
    const e = await ui.templates.editList('demo');
    expect(e.themes.find((t) => t.name === 'brand')?.used_by).toEqual({ projects: ['demo'], scenarios: [{ project: 'demo', scenario: 'q' }] });
    const w = await ui.templates.editList('other');
    expect(w.themes.find((t) => t.name === 'brand')?.used_by).toEqual({ projects: ['other'], scenarios: [] });
  });
});

describe('writers target the project (R-SHR-12)', () => {
  it('template_create_from_brand {project}: written into the project, journaled with its slug, its own logo taken first (R-SHR-16)', async () => {
    const c = await mcp.templates.create(input({ project: 'demo' }));
    expect(c.dir).toBe(join(proj(), 'templates', 'acme'));
    expect(await readFile(join(c.dir, 'logo.svg'))).toEqual(await readFile(join(T, 'motion', 'logo.svg')));
    const prov = JSON.parse(await readFile(join(c.dir, THEME_PROVENANCE_FILE), 'utf8'));
    expect(prov.found_in).toEqual({ 'brand/logo.svg': 'project' });
    expect(prov.inputs.project).toBeUndefined();
    const j = (await readJournal(root)).filter((x) => x.op === 'folder' && x.what === 'theme');
    expect(j.at(-1)).toMatchObject({ project: 'demo', path: 'projects/demo/templates/acme', outcome: 'ok' });
    // A file only the workspace has: the root, said in the provenance.
    const d = await mcp.templates.create(input({ name: 'acme-two', project: 'demo', logo: 'brand/only-here.svg' }));
    expect(JSON.parse(await readFile(join(d.dir, THEME_PROVENANCE_FILE), 'utf8')).found_in).toEqual({ 'brand/only-here.svg': 'workspace' });
    // Nothing in the workspace's templates_dir.
    expect((await readdir(join(root, 'templates'))).filter((n) => !n.startsWith('.'))).toEqual(['brand']);
  });

  it("through MCP a workspace theme's name is refused for a project theme; at a terminal it is said", async () => {
    const e = await refusal(mcp.templates.create(input({ name: 'brand-x', project: 'other' })).then(() => mcp.templates.create(input({ name: 'brand', project: 'other' }))));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/"brand" is the name of a workspace theme: a theme of project other of that name would hide it there .*project_adopt/);
    const ws = await opened();
    await rm(join(proj(), 'templates', 'brand'), { recursive: true });
    const made = await createThemeFromBrand(ws, input({ name: 'brand', project: 'demo' }), { trust: 'author', cwd: root, scope: personScope(root, enginePorts()) });
    expect(made.dir).toBe(join(proj(), 'templates', 'brand'));
    expect(made.warnings).toContain("project demo's theme brand is used there instead of the workspace's theme brand");
  });

  it('theme_copy {project} writes the copy into the project; the key of a theme is per project', async () => {
    const r = await ui.templates.copy({ from: 'editorial', name: 'mine', project: 'demo' });
    expect(r.project).toBe('demo');
    expect((await readdir(join(proj(), 'templates', 'mine'))).includes('template.yaml')).toBe(true);
    // A copy of the project's own theme (found first).
    await ui.templates.copy({ from: 'brand', name: 'mine-2', project: 'demo' });
    expect(await readFile(join(proj(), 'templates', 'mine-2', 'logo.svg'))).toEqual(await readFile(join(proj(), 'templates', 'brand', 'logo.svg')));
    // One key per folder (the name as it resolves): demo's own brand, and the workspace's whatever screen names it.
    const ws = await opened();
    expect(themeKey(ws, 'demo', 'Brand')).toBe(`theme:${join(proj(), 'templates', 'Brand').toLowerCase()}`);
    expect(themeKey(ws, 'other', 'brand')).toBe(themeKey(ws, undefined, 'brand'));
    expect(themeKey(ws, 'demo', 'brand')).not.toBe(themeKey(ws, 'other', 'brand'));
  });

  it("a project whose templates/ is the workspace's templates_dir has no target of its own", async () => {
    await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: projects/demo/templates\n');
    const ws = await opened();
    const p = await openProjectBySlug(ws, 'demo');
    expect(() => projectThemeTarget(ws, p)).toThrow(/project demo's templates\/ is the workspace's templates_dir/);
  });

  it('template_update {project} re-makes the project theme in place; the workspace one is not touched', async () => {
    await mcp.templates.create(input({ project: 'demo' }));
    const u = await mcp.templates.update({ name: 'acme', project: 'demo', colors: { paper: '#101820' } });
    expect(u.dir).toBe(join(proj(), 'templates', 'acme'));
    expect(u.changed).toEqual(['colors.paper']);
    expect(await refusal(mcp.templates.update({ name: 'acme', colors: { paper: '#101820' } }))).toMatchObject({ code: 'not_found' });
  });

  it('no MCP writer puts a Lottie, a video or code into a theme folder', async () => {
    const c = await mcp.templates.create(input({ project: 'demo', wordmark: 'brand/logo.svg' }));
    const files = (await readdir(c.dir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile()).map((f) => f.name);
    const allowed = new Set(['.yaml', '.json', '.md', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ttf', '.otf', '.woff', '.woff2']);
    expect(files.filter((f) => !allowed.has(extname(f).toLowerCase()))).toEqual([]);
  });
});

describe('the editor writes where the theme lives (R-SHR-13)', () => {
  it('a project theme is editable and its write lands in the project, journaled with its slug; the workspace theme of its name is untouched', async () => {
    const before = await readFile(join(root, 'templates', 'brand', 'template.yaml'), 'utf8');
    const v = await ui.templates.view('brand', { project: 'demo' });
    expect([v.source, v.editable]).toEqual(['project', true]);
    const r = await ui.templates.edit(
      'brand',
      { if_match: v.sha256, edit: { kind: 'set_field', field: 'colors.accent', from: v.fields['colors.accent'] as string, to: '#123456' } },
      { project: 'demo' },
    );
    expect(await readFile(join(proj(), 'templates', 'brand', 'template.yaml'), 'utf8')).toContain('#123456');
    expect(await readFile(join(root, 'templates', 'brand', 'template.yaml'), 'utf8')).toBe(before);
    const j = (await readJournal(root)).filter((x) => x.op === 'write' && x.what === 'theme');
    expect(j.at(-1)).toMatchObject({ project: 'demo', path: 'projects/demo/templates/brand/template.yaml', sha256: r.sha256 });
    // Without the project: the workspace's.
    expect((await ui.templates.view('brand')).source).toBe('workspace');
  });

  it('a linked project theme folder is not listed; a linked template.yaml is read-only and its edit refused', async () => {
    await cp(join(T, 'editorial'), join(root, 'elsewhere'), { recursive: true });
    await symlink(join(root, 'elsewhere'), join(proj(), 'templates', 'linked'));
    expect((await refusal(ui.templates.view('linked', { project: 'demo' }))).code).toBe('not_found');
    await rm(join(proj(), 'templates', 'motion', 'template.yaml'));
    await symlink(join(root, 'elsewhere', 'template.yaml'), join(proj(), 'templates', 'motion', 'template.yaml'));
    const v = await ui.templates.view('motion', { project: 'demo' });
    expect(v.editable).toEqual({ why: expect.stringMatching(/template\.yaml is a symbolic link/) });
    const e = await refusal(ui.templates.edit('motion', { if_match: v.sha256, edit: { kind: 'set_field', field: 'style_bias', from: 'real', to: 'motion' } }, { project: 'demo' }));
    expect(e.code).toBe('refused');
  });
});

describe('brand files are looked for in the project first (R-SHR-16)', () => {
  it('through MCP: a project file leaving the project is refused, never looked for again in the workspace; scenarios/ and components/ are no source', async () => {
    const ws = await opened();
    const project = { dir: proj(), slug: 'demo' };
    await mkdir(join(root, 'outside'), { recursive: true });
    await cp(join(T, 'editorial', 'logo.svg'), join(root, 'outside', 'logo.svg'));
    await cp(join(T, 'editorial', 'logo.svg'), join(root, 'brand', 'linked.svg'));
    await symlink(join(root, 'outside', 'logo.svg'), join(proj(), 'brand', 'linked.svg'));
    await expect(readBrandFile(ws, 'brand/linked.svg', 'logo', { trust: 'mcp', project })).rejects.toThrow(/leads out of the project folder/);
    await writeFile(join(proj(), 'scenarios', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(readBrandFile(ws, 'scenarios/logo.svg', 'logo', { trust: 'mcp', project })).rejects.toThrow(/lies in scenarios\/ of project demo, a folder an agent can write/);
    await mkdir(join(proj(), 'components', 'acme', 'x'), { recursive: true });
    await writeFile(join(proj(), 'components', 'acme', 'x', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(readBrandFile(ws, 'components/acme/x/logo.svg', 'logo', { trust: 'mcp', project })).rejects.toThrow(/components/);
    // The workspace-relative spelling of a project's components file is refused too.
    await expect(readBrandFile(ws, 'projects/demo/components/acme/x/logo.svg', 'logo', { trust: 'mcp' })).rejects.toThrow(/components\/ of project demo/);
    // A recorded input pinned to the workspace (template_update of a workspace theme, or one made before): the root.
    expect((await readBrandFile(ws, 'brand/logo.svg', 'logo', { trust: 'mcp', project, only: 'workspace' })).found_in).toBe('workspace');
  });

  it('at a terminal with a project: a bare reference from the project first even when run at the root; ./ and absolute paths as typed', async () => {
    const ws = await opened();
    const project = { dir: proj(), slug: 'demo' };
    const fromRoot = await readBrandFile(ws, 'brand/logo.svg', 'logo', { trust: 'author', cwd: root, project });
    expect([fromRoot.found_in, fromRoot.bytes.equals(await readFile(join(T, 'motion', 'logo.svg')))]).toEqual(['project', true]);
    const typed = await readBrandFile(ws, './brand/logo.svg', 'logo', { trust: 'author', cwd: root, project });
    expect(typed.bytes.equals(await readFile(join(T, 'editorial', 'logo.svg')))).toBe(true);
    // From inside the project, the same bare reference: still the project's.
    expect((await readBrandFile(ws, 'brand/logo.svg', 'logo', { trust: 'author', cwd: proj(), project })).found_in).toBe('project');
    // No project: as typed (today's rule).
    expect((await readBrandFile(ws, 'brand/logo.svg', 'logo', { trust: 'author', cwd: root })).bytes.equals(await readFile(join(T, 'editorial', 'logo.svg')))).toBe(true);
  });

  it("brand_files {project}: the project's files first, tagged; a workspace file of the same reference left out; one budget", async () => {
    const r = await ui.templates.files('image', { project: 'demo' });
    const own = r.files.filter((f) => f.origin === 'project').map((f) => f.ref);
    expect(own).toContain('brand/logo.svg');
    expect(own.some((f) => f.startsWith('scenarios/'))).toBe(false);
    const ws = r.files.filter((f) => f.origin === 'workspace').map((f) => f.ref);
    expect(ws).toContain('brand/only-here.svg');
    expect(ws).not.toContain('brand/logo.svg');
    expect(ws.some((f) => f.startsWith('projects/demo/'))).toBe(false);
    expect((await ui.templates.files('image')).files.every((f) => f.origin === undefined)).toBe(true);
  });
});

describe('theme writers and reads of a project: links, uses, the board, copies, details', () => {
  it("a linked project templates/ is refused to every writer — MCP create, a terminal's create, project_adopt — and the folder it leads to stays empty", async () => {
    const outside = await mkdtemp(join(tmpdir(), 'retake-linked-templates-'));
    try {
      await rm(join(proj(), 'templates'), { recursive: true });
      await symlink(outside, join(proj(), 'templates'));
      const viaMcp = await refusal(mcp.templates.create(input({ project: 'demo' })));
      expect([viaMcp.code, viaMcp.message]).toEqual(['refused', expect.stringMatching(/project demo's templates\/ is a symbolic link/)]);
      const ws = await opened();
      await expect(createThemeFromBrand(ws, input({ project: 'demo' }), { trust: 'author', cwd: root, scope: personScope(root, enginePorts()) })).rejects.toThrow(/is a symbolic link/);
      const adopt = await refusal(mcp.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'copy' }));
      expect(adopt.code).toBe('refused');
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('used_by moves when a workspace theme folder appears (templates_dir is signed)', async () => {
    await writeFile(join(root, 'projects', 'other', 'project.yaml'), 'name: Other\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: fresh\n');
    expect((await ui.templates.editList('other')).themes.find((t) => t.name === 'fresh')).toBeUndefined();
    await cp(join(T, 'editorial'), join(root, 'templates', 'fresh'), { recursive: true });
    expect((await ui.templates.editList('other')).themes.find((t) => t.name === 'fresh')?.used_by.projects).toEqual(['other']);
  });

  it("the board sees the project's own theme break at once (its folder is in the board's signature)", async () => {
    // A zoom of 2.5: above the default theme's max_zoom (a warning), within the project theme's once it allows 3.
    await writeFile(join(proj(), 'scenarios', 'q.yaml'), 'video: Q\ntemplate: brand\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n        camera: {zoom: 2.5}\n');
    const before = (await ui.projects.board('demo')).scenarios.find((x) => x.name === 'q');
    expect(before?.file.warnings).toBeGreaterThan(0);
    const file = join(proj(), 'templates', 'brand', 'template.yaml');
    await writeFile(file, `${await readFile(file, 'utf8')}\nmotion: {max_zoom: 3}\n`.replace(/^motion:(?!.*max_zoom: 3).*$/m, ''));
    const after = (await ui.projects.board('demo')).scenarios.find((x) => x.name === 'q');
    expect(after?.file.warnings).toBe((before?.file.warnings ?? 0) - 1);
  });

  it("the Studio's Copy to edit refuses a project copy of a workspace theme's name, in the words of New theme", async () => {
    await rm(join(proj(), 'templates', 'brand'), { recursive: true });
    const e = await refusal(ui.templates.copy({ from: 'editorial', name: 'brand', project: 'demo' }));
    const n = await refusal(ui.templates.create(input({ name: 'brand', project: 'demo' })));
    expect([e.code, e.message]).toEqual(['refused', n.message]);
  });

  it("template_get {project} of a path to a workspace folder answers as the list's row: the project's, by its path", async () => {
    // The workspace's brand listed for demo too (no project theme of that name hides it).
    await rm(join(proj(), 'templates', 'brand'), { recursive: true });
    await writeFile(join(proj(), 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ../../templates/brand\n');
    const d = await mcp.templates.get({ project: 'demo' });
    const row = (await mcp.templates.list({ project: 'demo' })).templates.find((t) => t.by_path);
    expect([d.source, d.by_path, d.default]).toEqual(['project', true, true]);
    expect([row?.source, row?.by_path, row?.dir]).toEqual(['project', true, d.dir]);
  });

  it("template_update without a project names the project's own theme in its not_found", async () => {
    await mcp.templates.create(input({ name: 'mine', project: 'demo' }));
    const e = await refusal(mcp.templates.update({ name: 'mine', colors: { paper: '#101820' } }));
    expect([e.code, e.message]).toEqual(['not_found', expect.stringMatching(/a project's own theme is named with its project: template_update \{name: "mine", project\}/)]);
  });
});
