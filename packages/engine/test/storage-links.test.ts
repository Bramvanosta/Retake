/**
 * L4.1 (critique B6): reads through LocalStorage never follow a symbolic link out of the project. A README.md or a
 * scenario file that links to a file outside the project was returned by project_get / scenario_get (and hashed by
 * scenario_save / project_update_readme); now refused like `writableDir` refuses a write through such a folder — and
 * the refusal never names the outside target (review A). Links inside the project, and a project folder that is
 * itself a link, still read; a write goes through an inside link to its target (review B M3), never through one
 * leading out. project_get keeps opening a project whose README cannot be read (readme_error), and refuses a
 * project.yaml that leads out (review B M5); a README that is not UTF-8 is flagged (review B M1).
 */
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineError, LocalStorage, createEngine, sha256Hex } from '../src/index.js';
import type { Engine } from '../src/index.js';

let base: string;
let ws: string;
let outside: string;
let engine: Engine;
const savedHome = process.env.DEMO_STUDIO_HOME;
const SECRET = 'outside the project: never read through a link\n';
const SHORT = 'video: short\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n';

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'studio-links-'));
  ws = join(base, 'ws');
  outside = join(base, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.md'), SECRET);
  await writeFile(join(outside, 'leak.yaml'), SHORT.replace('video: short', 'video: leak'));
  process.env.DEMO_STUDIO_HOME = join(base, 'home');
  await mkdir(join(ws, 'projects'), { recursive: true });
  await writeFile(join(ws, 'studio.yaml'), 'projects_dir: projects\n');
  const project = (name: string) => `name: ${name}\nenvironments:\n  local:\n    console: http://127.0.0.1:4997\ntemplate: default\n`;
  // linked: README.md and scenarios/leak.yaml are links out of the project; scenarios/inner.yaml links inside it.
  const linked = join(ws, 'projects', 'linked');
  await mkdir(join(linked, 'scenarios'), { recursive: true });
  await writeFile(join(linked, 'project.yaml'), project('Linked'));
  await writeFile(join(linked, 'scenarios', 'short.yaml'), SHORT);
  await symlink(join(outside, 'secret.md'), join(linked, 'README.md'));
  await symlink(join(outside, 'leak.yaml'), join(linked, 'scenarios', 'leak.yaml'));
  await symlink('short.yaml', join(linked, 'scenarios', 'inner.yaml'));
  // folder: its whole scenarios/ folder is a link out of the project.
  const folder = join(ws, 'projects', 'folder');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'project.yaml'), project('Folder'));
  await writeFile(join(folder, 'README.md'), '# Folder\n');
  await symlink(outside, join(folder, 'scenarios'));
  // aliased: the project folder itself is a link (to a folder outside projects/): its own files still read.
  const real = join(base, 'real-project');
  await mkdir(join(real, 'scenarios'), { recursive: true });
  await writeFile(join(real, 'project.yaml'), project('Aliased'));
  await writeFile(join(real, 'README.md'), '# Aliased\n');
  await writeFile(join(real, 'scenarios', 'short.yaml'), SHORT);
  await symlink(real, join(ws, 'projects', 'aliased'));
  engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (base) await rm(base, { recursive: true, force: true });
});

describe('LocalStorage.readText: symbolic links out of the project (B6)', () => {
  it('refuses a file link and a folder link leading out; reads a link inside; a missing or dangling file is undefined', async () => {
    const s = new LocalStorage(join(ws, 'projects', 'linked'));
    const e = await refusal(s.readText('README.md'));
    expect(e.code).toBe('refused');
    expect(e.message).toContain('leads out of the project folder');
    expect(e.message).not.toContain(SECRET.trim());
    // Nor where the link leads: a path outside the project is not the agent's to learn either.
    expect(`${e.message} ${e.fix ?? ''}`).not.toContain(outside);
    expect((await refusal(s.readText('scenarios/leak.yaml'))).code).toBe('refused');
    expect((await s.readText('scenarios/inner.yaml'))?.text).toBe(SHORT);
    expect(await s.readText('scenarios/none.yaml')).toBeUndefined();
    await symlink(join(outside, 'gone.md'), join(ws, 'projects', 'linked', 'dangling.md'));
    expect(await s.readText('dangling.md')).toBeUndefined();
    const f = new LocalStorage(join(ws, 'projects', 'folder'));
    expect((await refusal(f.readText('scenarios/leak.yaml'))).code).toBe('refused');
    const a = new LocalStorage(join(ws, 'projects', 'aliased'));
    expect((await a.readText('README.md'))?.text).toBe('# Aliased\n');
  });

  it('a write never hashes the outside file either (if_match against a link leading out is refused)', async () => {
    const s = new LocalStorage(join(ws, 'projects', 'linked'));
    const e = await refusal(s.writeText('README.md', '# Mine\n', { ifMatch: sha256Hex(SECRET) }));
    expect(e.code).toBe('refused');
    expect(e.details?.current).toBeUndefined();
    expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe(SECRET);
    // Without if_match too: the link is neither followed out nor silently replaced by a regular file.
    const w = await refusal(s.writeText('README.md', '# Mine\n'));
    expect(w.message).toContain('leads out of the project folder');
    expect(w.message).not.toContain(outside);
    expect((await lstat(join(ws, 'projects', 'linked', 'README.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe(SECRET);
  });

  it('a write through a link to another file of the project lands in that file; the link stays (review B M3)', async () => {
    const dir = join(ws, 'projects', 'linked');
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'product.md'), '# Product doc\n');
    await symlink('docs/product.md', join(dir, 'PRODUCT.md'));
    const s = new LocalStorage(dir);
    const before = await s.readText('PRODUCT.md');
    expect(before?.text).toBe('# Product doc\n');
    const r = await s.writeText('PRODUCT.md', '# Product doc, edited\n', { ifMatch: before!.sha256 });
    expect(r.ref).toBe('PRODUCT.md');
    expect((await lstat(join(dir, 'PRODUCT.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, 'docs', 'product.md'), 'utf8')).toBe('# Product doc, edited\n');
    // A dangling link is refused, not replaced.
    await symlink('docs/gone.md', join(dir, 'GONE.md'));
    expect((await refusal(s.writeText('GONE.md', 'x\n'))).message).toContain('does not exist');
    expect((await lstat(join(dir, 'GONE.md'))).isSymbolicLink()).toBe(true);
  });

  it('readText flags bytes that are not UTF-8 (review B M1)', async () => {
    const dir = join(ws, 'projects', 'folder');
    await writeFile(join(dir, 'latin.md'), Buffer.from('# Caf\xe9\n', 'latin1'));
    const s = new LocalStorage(dir);
    expect(await s.readText('latin.md')).toMatchObject({ utf8: false, text: '# Caf\uFFFD\n' });
    expect(await s.readText('README.md')).toMatchObject({ utf8: true, text: '# Folder\n' });
  });
});

describe('engine reads of README and scenarios through links (B6)', () => {
  it('project_get opens the project without the README (readme_error); project_update_readme, scenario_get and scenario_save refuse the outside link; the outside file is untouched', async () => {
    const view = await engine.projects.get('linked');
    expect(view).toMatchObject({ slug: 'linked', readme: null, readme_hash: null, readme_error: expect.stringContaining('symbolic link leading out of the project folder') });
    expect(JSON.stringify(view)).not.toContain(SECRET.trim());
    expect((await refusal(engine.projects.updateReadme('linked', '# Mine', sha256Hex(SECRET)))).code).toBe('refused');
    expect((await refusal(engine.projects.updateReadme('linked', '# Mine', undefined))).code).toBe('refused');
    expect((await refusal(engine.scenarios.get('linked', 'leak'))).code).toBe('refused');
    expect((await refusal(engine.scenarios.save('linked', 'leak', SHORT.replace('video: short', 'video: leak'), { ifMatch: null }))).code).toBe('refused');
    expect((await refusal(engine.scenarios.get('folder', 'leak'))).code).toBe('refused');
    expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe(SECRET);
  });

  it('a project.yaml leading out of the project is never read through the engine (review B M5)', async () => {
    const dir = join(ws, 'projects', 'yamlout');
    await mkdir(dir, { recursive: true });
    await writeFile(join(outside, 'p.yaml'), 'version: 1\nname: "OUTSIDE YAML"\nenvironments:\n  prod: {app: {url: "https://internal.example.com/secret-path"}}\n');
    await symlink(join(outside, 'p.yaml'), join(dir, 'project.yaml'));
    const e = await refusal(engine.projects.get('yamlout'));
    expect(e.code).toBe('refused');
    expect(e.message).toContain('project.yaml leads out of the project folder');
    expect(`${e.message}`).not.toContain('OUTSIDE YAML');
    const summary = (await engine.projects.list()).find((p) => p.slug === 'yamlout');
    expect(summary?.error).toContain('leads out of the project folder');
    expect(JSON.stringify(summary)).not.toContain('secret-path');
    await rm(dir, { recursive: true });
  });

  it('links inside the project and a project folder that is a link still read', async () => {
    expect((await engine.scenarios.get('linked', 'inner')).yaml).toBe(SHORT);
    expect((await engine.scenarios.get('linked', 'short')).yaml).toBe(SHORT);
    const p = await engine.projects.get('aliased');
    expect(p.readme).toBe('# Aliased\n');
    expect((await engine.scenarios.get('aliased', 'short')).yaml).toBe(SHORT);
  });
});
