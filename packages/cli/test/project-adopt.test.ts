/**
 * At a terminal (trust `author`): `retake project adopt` moves a workspace theme into the project by default
 * (refused while another project uses it, the users listed, exit 1), `--copy` leaves the workspace's, `--brand` takes
 * brand files, `--component` workspace components, `--json` prints the engine's answer; `retake theme list [--project]` says each theme's origin;
 * `retake theme create --project` makes the project's own theme from the project's brand file first; `retake list`
 * names each project's own themes. In process (main + memoryIo), a scratch workspace; nothing is rendered.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { EXIT, main, memoryIo } from '../src/index.js';

const T = STARTER_TEMPLATES_DIR;
let ws: string;
const proj = (slug = 'demo') => join(ws, 'projects', slug);

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

async function project(slug: string, theme: string): Promise<void> {
  await mkdir(join(proj(slug), 'scenarios'), { recursive: true });
  await writeFile(join(proj(slug), 'project.yaml'), `name: ${slug}\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ${theme}\n`);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-adopt-cli-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await cp(join(T, 'editorial'), join(ws, 'templates', 'brand'), { recursive: true });
  await mkdir(join(ws, 'brand'), { recursive: true });
  await cp(join(T, 'editorial', 'logo.svg'), join(ws, 'brand', 'logo.svg'));
  await project('demo', 'brand');
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('retake project adopt', () => {
  it("--component: moves a workspace component into the project's components/ (refused while a workspace theme picks it), --copy leaves it", async () => {
    const r1 = await retake('components', 'create', 'acme/card', '--kind', 'card', '--description', 'A card.', '--no-preview');
    expect(r1.code, r1.err).toBe(EXIT.ok);
    await writeFile(join(ws, 'templates', 'brand', 'template.yaml'), `${await readFile(join(ws, 'templates', 'brand', 'template.yaml'), 'utf8')}\n# picks acme/card\n`);
    const no = await retake('project', 'adopt', 'demo', '--component', 'acme/card');
    expect(no.code).toBe(EXIT.failure);
    expect(no.err).toMatch(/the workspace component acme\/card is used by theme brand: it is not moved — adopt a copy \(--copy\)/);
    const copy = await retake('project', 'adopt', 'demo', '--component', 'acme/card', '--copy', '--json');
    expect(copy.code, copy.err).toBe(EXIT.ok);
    expect(JSON.parse(copy.out).components).toEqual([expect.objectContaining({ id: 'acme/card', dir: join(proj(), 'components', 'acme', 'card') })]);
    expect(await readdir(join(ws, 'components', 'acme'))).toEqual(['card']);
    await rm(join(proj(), 'components'), { recursive: true });
    await cp(join(T, 'editorial'), join(ws, 'templates', 'brand'), { recursive: true, force: true });
    await writeFile(join(ws, 'templates', 'brand', 'template.yaml'), await readFile(join(T, 'editorial', 'template.yaml'), 'utf8'));
    const ok = await retake('project', 'adopt', 'demo', '--component', 'acme/card');
    expect(ok.code, ok.err).toBe(EXIT.ok);
    expect(ok.out + ok.err).toMatch(/component acme\/card moved into project demo/);
    expect(ok.out + ok.err).toMatch(/set aside in \.retake\/adopted\/\d{8}T\d{6}Z-component-acme-card/);
    expect(await readdir(join(ws, 'components', 'acme'))).toEqual([]);
    expect((await retake('components', 'list', '--project', 'demo')).out).toMatch(/acme\/card\s+card\s+project/);
    // A workspace override of a built-in (studio/) stays the workspace's: refused, moved or copied.
    expect((await retake('components', 'create', 'studio/card-title', '--kind', 'card', '--no-preview')).code).toBe(EXIT.ok);
    for (const extra of [[], ['--copy']]) {
      const r = await retake('project', 'adopt', 'demo', '--component', 'studio/card-title', ...extra);
      expect(r.code).toBe(EXIT.failure);
      expect(r.err).toMatch(/"studio\/" namespace belongs to the built-in library — a workspace component of that id overrides the built-in one for every project and stays a workspace item/);
    }
    expect(await readdir(join(ws, 'components', 'studio'))).toEqual(['card-title']);
  });

  it('moves by default: refused while another project uses the theme (listed, exit 1), then moved once nothing else does', async () => {
    await project('other', 'brand');
    const no = await retake('project', 'adopt', 'demo', '--theme', 'brand');
    expect(no.code).toBe(EXIT.failure);
    expect(no.err).toMatch(/the workspace theme brand is used by other \(project\.yaml\): it is not moved — adopt a copy \(--copy\)/);
    await writeFile(join(proj('other'), 'project.yaml'), 'name: other\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: default\n');
    const ok = await retake('project', 'adopt', 'demo', '--theme', 'brand');
    expect(ok.code).toBe(EXIT.ok);
    expect(ok.out + ok.err).toMatch(/theme brand moved into project demo/);
    expect(ok.out + ok.err).toMatch(/set aside in \.retake\/adopted\/\d{8}T\d{6}Z-theme-brand/);
    expect(await readdir(join(ws, 'templates'))).toEqual([]);
    expect(await readdir(join(proj(), 'templates', 'brand'))).toContain('template.yaml');
    // The journal says the move and where the folder went.
    const j = await retake('journal', '--writes');
    expect(j.out).toMatch(/cli {2}moved theme templates\/brand → \.retake\/adopted\/\d{8}T\d{6}Z-theme-brand {2}ok/);
    expect(j.out).toMatch(/cli {2}created theme projects\/demo\/templates\/brand \(\d+ files\) {2}ok/);
  });

  it('--copy leaves the workspace theme; --brand takes brand files; --json prints the answer', async () => {
    const r = await retake('project', 'adopt', 'demo', '--theme', 'brand', '--brand', 'brand/logo.svg', '--copy', '--json');
    expect(r.code).toBe(EXIT.ok);
    const v = JSON.parse(r.out) as { mode: string; themes: Array<{ name: string }>; brand: Array<{ files: string[] }> };
    expect([v.mode, v.themes.map((t) => t.name), v.brand[0].files]).toEqual(['copy', ['brand'], ['brand/logo.svg']]);
    expect(await readdir(join(ws, 'templates'))).toEqual(['brand']);
    expect(await readFile(join(proj(), 'brand', 'logo.svg'))).toEqual(await readFile(join(ws, 'brand', 'logo.svg')));
  });

  it('nothing named is a usage error', async () => {
    const r = await retake('project', 'adopt', 'demo');
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/name what the project adopts: --theme <name>/);
  });
});

describe("a project's own themes at a terminal", () => {
  it('retake theme list [--project] says each origin and what a project theme hides', async () => {
    await cp(join(T, 'default'), join(proj(), 'templates', 'brand'), { recursive: true });
    const plain = await retake('theme', 'list', '--json');
    expect((JSON.parse(plain.out) as { templates: Array<{ name: string; source: string }> }).templates.map((t) => `${t.name}:${t.source}`)).toEqual([
      'brand:workspace',
      'default:starter',
      'editorial:starter',
      'motion:starter',
    ]);
    const mine = await retake('theme', 'list', '--project', 'demo');
    expect(mine.code).toBe(EXIT.ok);
    expect(mine.out).toMatch(/brand \(project, instead of the workspace's\) — the project's theme/);
    expect(mine.out + mine.err).toMatch(/note: the project's theme "brand" is used instead of the workspace's theme of that name/);
  });

  it("retake theme create --project: the project's own theme, its brand file taken from the project first; retake list names it", async () => {
    await mkdir(join(proj(), 'brand'), { recursive: true });
    await cp(join(T, 'motion', 'logo.svg'), join(proj(), 'brand', 'logo.svg'));
    const r = await retake('theme', 'create', 'acme', '--accent', '#0e7c66', '--logo', 'brand/logo.svg', '--project', 'demo', '--json');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect((JSON.parse(r.out) as { dir: string }).dir).toBe(join(proj(), 'templates', 'acme'));
    expect(await readFile(join(proj(), 'templates', 'acme', 'logo.svg'))).toEqual(await readFile(join(T, 'motion', 'logo.svg')));
    const list = await retake('list');
    expect(list.out).toMatch(/its own themes: acme/);
    const json = JSON.parse((await retake('list', '--json')).out) as { projects: Array<{ slug: string; themes: string[] }> };
    expect(json.projects.find((p) => p.slug === 'demo')?.themes).toEqual(['acme']);
  });
});
