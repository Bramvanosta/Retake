/**
 * R-SHR-14: a project adopts workspace themes and brand files (engine project-adopt.ts, `projects.adopt`).
 * - copy: the theme folder verbatim, its provenance kept (an MCP-made theme stays updatable through MCP, as the
 *   project's); a name the project has, a starter, refused;
 * - move (a person): refused while another project or scenario uses the theme (listed; a project whose own theme of
 *   that name hides it does not count), or while a job is queued or running; the workspace folder set aside under
 *   `.retake/adopted/`, journaled `move`; a source changed during the move refused, the copy kept and said;
 * - MCP: copy only, never brand files;
 * - brand files: into `<project>/brand/` (a file, a folder), conflict on an existing one, a hidden path or a project's
 *   file refused; a move sets the original aside.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { STARTER_TEMPLATES_DIR, loadWorkspaceConfig } from '@retake/core/io';
import { packageRegistries } from '@retake/compose';
import { THEME_PROVENANCE_FILE } from '../src/brand/create.js';
import { ManualClock } from '../src/clock.js';
import { callerOf } from '../src/caller.js';
import { createEngine } from '../src/index.js';
import type { Engine, EngineError } from '../src/index.js';
import { adoptIntoProject } from '../src/project-adopt.js';
import { readJournal } from '../src/store/journal.js';
import { diskProjectStores } from '../src/store/project-store.js';
import type { ProjectStores, StoreScope } from '../src/store/store.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';

const T = STARTER_TEMPLATES_DIR;
let root: string;
let mcp: Engine;
let cli: Engine;
const proj = (slug = 'demo') => join(root, 'projects', slug);

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  if (!e) throw new Error('expected a refusal');
  return e;
}
const opened = async () => ({ ...(await loadWorkspaceConfig(root)), policy: PERSON_POLICY, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() });
const scopeOf = (stores: ProjectStores = diskProjectStores): StoreScope => ({ workspace: root, caller: callerOf('cli'), clock: new ManualClock('2026-11-18T00:15:00.000Z'), stores });
const project = async (slug: string, theme: string, scenarios: Record<string, string> = {}) => {
  await mkdir(join(proj(slug), 'scenarios'), { recursive: true });
  await writeFile(join(proj(slug), 'project.yaml'), `name: ${slug}\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ${theme}\n`);
  for (const [n, t] of Object.entries(scenarios))
    await writeFile(join(proj(slug), 'scenarios', `${n}.yaml`), `video: ${n}\ntemplate: ${t}\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-adopt-'));
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(root, 'brand', 'fonts'), { recursive: true });
  await cp(join(T, 'editorial', 'logo.svg'), join(root, 'brand', 'logo.svg'));
  await cp(join(T, 'default', 'fonts', 'Inter-Bold.ttf'), join(root, 'brand', 'fonts', 'Inter-Bold.ttf'));
  await cp(join(T, 'editorial'), join(root, 'templates', 'brand'), { recursive: true });
  await project('demo', 'brand');
  mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  cli = await createEngine({ root, client: 'cli', autoStartWorker: false });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('project_adopt: copy (R-SHR-14)', () => {
  it("the folder verbatim, its provenance kept: an MCP-made theme stays updatable through MCP as the project's", async () => {
    await mcp.templates.create({ name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg' });
    const prov = await readFile(join(root, 'templates', 'acme', THEME_PROVENANCE_FILE), 'utf8');
    const r = await mcp.projects.adopt({ project: 'demo', themes: ['acme'], mode: 'copy' });
    expect(r.themes.map((t) => [t.name, t.dir, t.moved_to])).toEqual([['acme', join(proj(), 'templates', 'acme'), undefined]]);
    expect(await readFile(join(proj(), 'templates', 'acme', THEME_PROVENANCE_FILE), 'utf8')).toBe(prov);
    // The workspace's stays; the project now resolves its own.
    expect((await readdir(join(root, 'templates'))).sort()).toEqual(['acme', 'brand']);
    expect((await mcp.templates.get({ project: 'demo', template: 'acme' })).source).toBe('project');
    const u = await mcp.templates.update({ name: 'acme', project: 'demo', colors: { paper: '#101820' } });
    expect(u.dir).toBe(join(proj(), 'templates', 'acme'));
  });

  it('a name the project has is a conflict; a starter is refused; nothing written', async () => {
    await cp(join(T, 'default'), join(proj(), 'templates', 'brand'), { recursive: true });
    expect(await refusal(mcp.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'copy' }))).toMatchObject({ code: 'conflict' });
    const s = await refusal(mcp.projects.adopt({ project: 'demo', themes: ['motion'], mode: 'copy' }));
    expect([s.code, s.message]).toEqual(['refused', expect.stringMatching(/motion is a starter theme shipped with Retake, not a workspace theme/)]);
    expect((await readdir(join(proj(), 'templates'))).sort()).toEqual(['brand']);
  });

  it('through MCP: never a move, never brand files', async () => {
    expect(await refusal(mcp.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'move' }))).toMatchObject({ code: 'refused', message: expect.stringMatching(/only copied into a project/) });
    expect(await refusal(mcp.projects.adopt({ project: 'demo', brand: ['brand/logo.svg'], mode: 'copy' }))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/brand files are never adopted through MCP/),
    });
    expect(await readdir(join(root, 'templates', 'brand'))).toContain('template.yaml');
  });
});

describe('retake project adopt: move (R-SHR-14)', () => {
  it('refused while another project or scenario uses the theme, listed; a project whose own theme hides it does not count', async () => {
    await project('other', 'brand');
    await project('third', 'default', { intro: 'brand' });
    await project('hides', 'brand');
    await cp(join(T, 'default'), join(proj('hides'), 'templates', 'brand'), { recursive: true });
    const e = await refusal(cli.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'move' }));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/the workspace theme brand is used by other \(project\.yaml\), third\/intro: it is not moved/);
    expect(e.message).not.toMatch(/hides/);
    expect(await readdir(join(root, 'templates'))).toEqual(['brand']);
    expect(await readdir(join(proj(), 'templates')).catch(() => [])).toEqual([]);
  });

  it('moved: the project holds it, the workspace folder set aside under .retake/adopted/, journaled; project.yaml unchanged', async () => {
    const yaml = await readFile(join(proj(), 'project.yaml'), 'utf8');
    const r = await cli.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'move' });
    expect(r.themes[0].moved_to).toMatch(/^\.retake\/adopted\/\d{8}T\d{6}Z-theme-brand$/);
    expect(await readdir(join(root, 'templates'))).toEqual([]);
    expect(await readdir(join(root, r.themes[0].moved_to!))).toContain('template.yaml');
    expect(await readdir(join(proj(), 'templates', 'brand'))).toContain('template.yaml');
    expect(await readFile(join(proj(), 'project.yaml'), 'utf8')).toBe(yaml);
    expect((await cli.templates.get({ project: 'demo' })).dir).toBe(join(proj(), 'templates', 'brand'));
    const j = await readJournal(root);
    expect(j.filter((x) => x.op === 'move')).toEqual([expect.objectContaining({ op: 'move', what: 'theme', path: 'templates/brand', to: r.themes[0].moved_to, outcome: 'ok' })]);
    expect(r.notes.join('\n')).toMatch(/the project's earlier renders made with it still match/);
  });

  it('refused while a job is queued or running; a source changed during the move refused, the copy kept and said', async () => {
    const ws = await opened();
    const busy = await refusal(adoptIntoProject(ws, { project: 'demo', themes: ['brand'], mode: 'move' }, { scope: scopeOf(), trust: 'author', activeJobs: async () => ['render j1'] }));
    expect([busy.code, busy.message]).toEqual(['busy', expect.stringMatching(/a job is queued or running in the workspace \(render j1\): nothing is moved/)]);
    // A store whose move first changes the source (another writer between the copy and the set-aside).
    const racing: ProjectStores = {
      ...diskProjectStores,
      at: (r, scope, o) => {
        const s = diskProjectStores.at(r, scope, o);
        return Object.assign(Object.create(Object.getPrototypeOf(s)), s, {
          moveAside: async (ref: string, to: string, mo: Parameters<typeof s.moveAside>[2]) => {
            await writeFile(join(root, 'templates', 'brand', 'template.yaml'), 'name: brand\n# changed\n');
            return s.moveAside.call(s, ref, to, mo);
          },
        });
      },
    };
    const raced = await refusal(adoptIntoProject(ws, { project: 'demo', themes: ['brand'], mode: 'move' }, { scope: scopeOf(racing), trust: 'author', activeJobs: async () => [] }));
    expect([raced.code, raced.message]).toEqual(['conflict', expect.stringMatching(/changed while it was adopted: the project's copy is made \(templates\/brand\), the workspace theme stays/)]);
    expect(await readdir(join(root, 'templates'))).toEqual(['brand']);
    expect(await readdir(join(proj(), 'templates'))).toEqual(['brand']);
  });
});

describe('retake project adopt --brand (R-SHR-16)', () => {
  it("a file into the project's brand/ (a font below brand/ keeps its place), a conflict on an existing one; a hidden path, a project's file refused", async () => {
    const r = await cli.projects.adopt({ project: 'demo', brand: ['brand/logo.svg'], mode: 'copy' });
    expect(r.brand).toEqual([{ from: 'brand/logo.svg', files: ['brand/logo.svg'] }]);
    expect(await readFile(join(proj(), 'brand', 'logo.svg'))).toEqual(await readFile(join(root, 'brand', 'logo.svg')));
    const again = await refusal(cli.projects.adopt({ project: 'demo', brand: ['brand/logo.svg'], mode: 'copy' }));
    expect(again).toMatchObject({ code: 'conflict', message: expect.stringMatching(/project demo already has brand\/logo\.svg/) });
    const font = await cli.projects.adopt({ project: 'demo', brand: ['brand/fonts/Inter-Bold.ttf'], mode: 'copy' });
    expect(font.brand[0].files).toEqual(['brand/fonts/Inter-Bold.ttf']);
    await mkdir(join(root, '.hidden'), { recursive: true });
    await writeFile(join(root, '.hidden', 'x.svg'), '<svg/>');
    expect(await refusal(cli.projects.adopt({ project: 'demo', brand: ['.hidden/x.svg'], mode: 'copy' }))).toMatchObject({ code: 'invalid' });
    await writeFile(join(proj(), 'mine.svg'), '<svg/>');
    expect(await refusal(cli.projects.adopt({ project: 'demo', brand: ['projects/demo/mine.svg'], mode: 'copy' }))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/lies in a project/),
    });
    expect((await readJournal(root)).filter((x) => x.op === 'write' && x.what === 'brand' && x.outcome === 'ok').map((x) => (x as { path: string }).path)).toEqual([
      'projects/demo/brand/logo.svg',
      'projects/demo/brand/fonts/Inter-Bold.ttf',
    ]);
  });

  it('a move sets the original aside; themes made from it are said (they hold copies)', async () => {
    await mcp.templates.create({ name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg' });
    const r = await cli.projects.adopt({ project: 'demo', brand: ['brand/logo.svg'], mode: 'move' });
    expect(r.brand[0].moved_to).toMatch(/^\.retake\/adopted\/\d{8}T\d{6}Z-brand-logo\.svg$/);
    expect(await readdir(join(root, 'brand'))).toEqual(['fonts']);
    expect(r.notes.join('\n')).toMatch(/workspace themes made from it hold their own copies \(acme\)/);
  });
});

describe('what a move or a brand adopt never takes (R-SHR-14, R-SHR-16)', () => {
  it('--brand takes brand files only: never a folder, the themes or components folder, the configuration, the state folder; nothing copied or moved', async () => {
    await mkdir(join(root, 'components', 'acme', 'x'), { recursive: true });
    await writeFile(join(root, 'components', 'acme', 'x', 'logo.svg'), '<svg/>');
    await mkdir(join(root, 'notes'), { recursive: true });
    // A folder named like a brand file is still a folder.
    await mkdir(join(root, 'brand', 'pack.svg'), { recursive: true });
    await writeFile(join(root, 'notes', 'a.yaml'), 'x: 1');
    for (const [ref, words] of [
      ['templates', /not a brand file/],
      ['brand/fonts', /not a brand file/],
      ['templates/brand/logo.svg', /lies in the workspace's themes folder/],
      ['components/acme/x/logo.svg', /lies in the workspace's components folder/],
      ['retake.yaml', /not a brand file/],
      ['brand/pack.svg', /is not a file: name each brand file/],
      ['notes/a.yaml', /not a brand file/],
    ] as const) {
      for (const mode of ['copy', 'move'] as const) {
        const e = await refusal(cli.projects.adopt({ project: 'demo', brand: [ref], mode }));
        expect([ref, e.code, e.message], ref).toEqual([ref, 'refused', expect.stringMatching(words)]);
      }
    }
    expect(await readdir(join(root, 'templates'))).toEqual(['brand']);
    expect((await readdir(root)).includes('retake.yaml')).toBe(true);
    expect(await readdir(join(proj())).then((n) => n.includes('brand'))).toBe(false);
  });

  it('a move is refused while a project does not open (its use cannot be told), or while the adopting project names the folder by its path; a name passes', async () => {
    await project('other', 'default');
    await writeFile(join(proj('other'), 'project.yaml'), 'name: other\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: brand\nunknown_key: 1\n');
    const broken = await refusal(cli.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'move' }));
    expect([broken.code, broken.message]).toEqual(['refused', expect.stringMatching(/project other does not open: whether it uses the workspace theme brand cannot be told/)]);
    await rm(proj('other'), { recursive: true });
    await project('demo', 'brand', { q: '../../templates/brand' });
    const own = await refusal(cli.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'move' }));
    expect([own.code, own.message]).toEqual(['refused', expect.stringMatching(/demo\/q names the workspace theme brand by its path: it is not moved .* name it by its name \(template: brand\)/)]);
    expect(await readdir(join(root, 'templates'))).toEqual(['brand']);
    await project('demo', 'brand', { q: 'brand' });
    await rm(join(proj(), 'templates'), { recursive: true, force: true });
    expect((await cli.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'move' })).themes[0].moved_to).toMatch(/^\.retake\/adopted\//);
  });

  it('a job queued while the theme was copied: the move refused under the lock and the copy removed', async () => {
    const ws = await opened();
    let calls = 0;
    const e = await refusal(
      adoptIntoProject(ws, { project: 'demo', themes: ['brand'], mode: 'move' }, { scope: scopeOf(), trust: 'author', activeJobs: async () => (++calls === 1 ? [] : ['render j2']) }),
    );
    expect([e.code, calls]).toEqual(['busy', 2]);
    expect(await readdir(join(root, 'templates'))).toEqual(['brand']);
    expect(await readdir(join(proj(), 'templates'))).toEqual([]);
  });

  it("a templates_dir outside the workspace: the theme is set aside in the workspace's .retake/adopted/ all the same", async () => {
    const shared = await mkdtemp(join(tmpdir(), 'retake-shared-themes-'));
    try {
      await cp(join(T, 'editorial'), join(shared, 'house'), { recursive: true });
      await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${shared}\n`);
      const engine = await createEngine({ root, client: 'cli', autoStartWorker: false });
      await project('demo', 'house');
      const r = await engine.projects.adopt({ project: 'demo', themes: ['house'], mode: 'move' });
      expect(r.themes[0].moved_to).toMatch(/^\.retake\/adopted\/\d{8}T\d{6}Z-theme-house$/);
      expect(await readdir(join(root, r.themes[0].moved_to!))).toContain('template.yaml');
      expect(await readdir(shared)).toEqual([]);
    } finally {
      await rm(shared, { recursive: true, force: true });
    }
  });

  it("a workspace theme of a starter's name is adopted with its name, by copy and by move; the project's then hides the starter", async () => {
    await cp(join(T, 'default'), join(root, 'templates', 'editorial'), { recursive: true });
    await project('demo', 'editorial');
    await cli.projects.adopt({ project: 'demo', themes: ['editorial'], mode: 'copy' });
    const l = await cli.templates.list({ project: 'demo' });
    expect(l.templates.find((t) => t.name === 'editorial')).toMatchObject({ source: 'project', shadows: 'workspace' });
    await rm(join(proj(), 'templates'), { recursive: true });
    await cli.projects.adopt({ project: 'demo', themes: ['editorial'], mode: 'move' });
    expect((await cli.templates.list({ project: 'demo' })).templates.find((t) => t.name === 'editorial')).toMatchObject({ source: 'project', shadows: 'starter' });
    // Never for a new name: a theme made or copied under a starter's name is still refused.
    expect(await refusal(cli.templates.copy({ from: 'motion', name: 'motion', project: 'demo' }))).toMatchObject({ code: 'refused' });
  });

  it("a move names other projects' renders of the theme (counts)", async () => {
    await project('other', 'default');
    await mkdir(join(proj('other'), 'renders'), { recursive: true });
    const rec = (id: string) => ({
      version: 2,
      id,
      project: 'other',
      scenario: 'q',
      status: 'succeeded',
      created_at: '2026-01-01T00:00:00.000Z',
      template: 'brand',
      template_folder: 'templates/brand',
      file: `${id}.mp4`,
      record: `${id}.json`,
    });
    for (const id of ['q-v1', 'q-v2']) await writeFile(join(proj('other'), 'renders', `${id}.json`), JSON.stringify(rec(id)));
    const r = await cli.projects.adopt({ project: 'demo', themes: ['brand'], mode: 'move' });
    expect(r.notes.join('\n')).toMatch(/older renders of other projects name the workspace theme brand: other \(2 renders\)/);
  });
});
