/**
 * The bytes every authored writer puts on disk, pinned (written before the writers moved into the project store, and
 * held since): a new project, the README, a scenario saved and edited, a theme copied, a theme made from brand inputs,
 * a component scaffold and a sandbox scaffold (`retake init`'s workspace files are pinned beside its command, in
 * packages/cli/test/app-bundle.test.ts). Each folder is listed with the sha256 of each file (a line naming a machine
 * path — a component's `$schema`, the tool version of a provenance file — normalised first), and the permissions of a
 * replaced file are checked kept.
 */
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { initSandbox } from '@retake/sandbox';
import { componentCreate, copyTheme, createEngine, createThemeFromBrand, fileWriter, openProjectBySlug, openWorkspace, personScope, ProjectStore } from '../src/index.js';
import type { Engine } from '../src/index.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const T = STARTER_TEMPLATES_DIR;
const NOW = new Date('2026-11-01T10:00:00.000Z');

/** The files of a folder (POSIX paths) → sha256 of their bytes after `norm`. */
async function tree(dir: string, norm: (rel: string, b: Buffer) => string | Buffer = (_r, b) => b): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = (await readdir(dir, { withFileTypes: true, recursive: true })).filter((e) => e.isFile());
  for (const e of entries) {
    const abs = join(e.parentPath, e.name);
    const rel = abs.slice(dir.length + 1).split('\\').join('/');
    out[rel] = sha(norm(rel, await readFile(abs)));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** A provenance file without the tool's version (it changes with every release). */
const noToolVersion = (rel: string, b: Buffer) => (rel.endsWith('.retake-theme.json') ? b.toString('utf8').replace(/"tool_version": "[^"]*"/, '"tool_version": "x"') : b);
/** A component.yaml without its `$schema` line (a path from the temporary folder to the repository). */
const noSchemaLine = (rel: string, b: Buffer) => (/\.ya?ml$/.test(rel) ? b.toString('utf8').replace(/^# yaml-language-server: \$schema=.*$/m, '# schema') : b);

let root: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-authored-writes-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(root, 'projects'), { recursive: true });
  await mkdir(join(root, 'brand'), { recursive: true });
  await cp(join(T, 'editorial', 'logo.svg'), join(root, 'brand', 'logo.svg'));
  engine = await createEngine({ root, client: 'ui', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('the bytes of the authored writers', () => {
  it('a new project: project.yaml, README.md, .gitignore and the .gitkeep of scenarios/, hooks/, assets/', async () => {
    await engine.projects.create({ name: 'Acme Demo', slug: 'acme', environments: { staging: { app: 'https://app.staging.example.com' } } });
    expect(await tree(join(root, 'projects', 'acme'))).toEqual({
      '.gitignore': 'aa5ebb76617eed63570587a7a141a93691f1a2708c9b2790bded5814446623e3',
      'README.md': '83eadcef7ab7fa9259b31f376df3f4d7cf76eca7c31320331676d928729cc9da',
      'assets/.gitkeep': sha(''),
      'hooks/.gitkeep': sha(''),
      'project.yaml': 'aa3623da463cbf8aeb23960e0399940c34212f6d4145f882ac984f77e18ac818',
      'scenarios/.gitkeep': sha(''),
    });
  });

  it('the README (a final line break added) and a scenario saved then edited; a replaced file keeps its mode', async () => {
    const view = await engine.projects.get('acme');
    const readme = await engine.projects.updateReadme('acme', '# Acme\n\nWhat it is.', view.readme_hash);
    expect(await readFile(join(root, 'projects', 'acme', 'README.md'), 'utf8')).toBe('# Acme\n\nWhat it is.\n');
    expect(readme.hash).toBe(sha('# Acme\n\nWhat it is.\n'));
    const yaml = 'version: 1\nvideo: quote\nenv: staging\nscenes:\n  - id: start\n    steps:\n      - open: app\n';
    const saved = await engine.scenarios.save('acme', 'quote', yaml.trimEnd(), {});
    const file = join(root, 'projects', 'acme', 'scenarios', 'quote.yaml');
    expect(await readFile(file, 'utf8')).toBe(yaml);
    await chmod(file, 0o640);
    const next = yaml.replace('video: quote', 'video: quote2');
    await engine.scenarios.edit('acme', 'quote', { hash: saved.hash, edit: { kind: 'replace_text', text: next } });
    expect(await readFile(file, 'utf8')).toBe(next);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it('a theme copied: the starter\'s files verbatim, its name spliced, the provenance file', async () => {
    const ws = await openWorkspace({ root, agent: false });
    await copyTheme(ws, { from: 'default', name: 'mine' }, { now: NOW, scope: personScope(root) });
    expect(await tree(join(root, 'templates', 'mine'), noToolVersion)).toEqual({
      '.retake-theme.json': '7b275d8e5d2e3d99354224699037aea782a421a28bdeeb6c351de13450f05936',
      'LICENSES.md': '106843797aea0fff6c2a3b296b964c54039743211bd3585fe0f3f5e4ac40a166',
      'README.md': 'dd465b1d248779fb07d697463aa71f22b01a31327bb22e23bed863539347b5e0',
      'fonts/Inter-Bold.ttf': 'b37284b5701b6b168dfc770aa1a4ac492106422fd3ba76bc7641e37434e8019c',
      'fonts/Inter-Regular.ttf': '1b08e7fc267a5c7e1d614100f604b83e7e8a0be241f0f288faa2b3ac93a683ba',
      'fonts/Inter-SemiBold.ttf': 'e7a1aaf7eda9f2fad4131725fa556265ec75ca7b2d756260173a040363e8d4f7',
      'logo.svg': '221c06c34100761032ade3067bcca107de75f16035c6e6297bf4945427b0e4ca',
      'template.yaml': 'be26c0cc82193413e43ca2b80412ce58bc7742b409befc32cbaebcb39f5838f0',
      'wordmark.svg': '2b34a446c2dbc91b70cccee695fd5362b21447fe4104cf274de7adcdce773523',
    });
  });

  it('a theme made from brand inputs: template.yaml, the logo, LICENSES.md, the provenance file', async () => {
    const ws = await openWorkspace({ root, agent: false });
    await createThemeFromBrand(ws, { name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg' }, { trust: 'author', cwd: root, now: NOW, scope: personScope(root) });
    expect(await tree(join(root, 'templates', 'acme'), noToolVersion)).toEqual({
      '.retake-theme.json': '050793c9021eb9a558611cb3c1187e32b9f22ece37a194bfb3064bd7168ee9b4',
      'LICENSES.md': '1364d5cf15028b623067fdf8ce19410352d273fc429b1de54707f005e3aef87d',
      'fonts/InstrumentSerif-Regular.ttf': 'a99e3db50076202713812ed541feeb23ffeebb61db1fa6b1cf48fe590d37ef18',
      'fonts/Inter-Bold.ttf': 'b37284b5701b6b168dfc770aa1a4ac492106422fd3ba76bc7641e37434e8019c',
      'fonts/Inter-Regular.ttf': '1b08e7fc267a5c7e1d614100f604b83e7e8a0be241f0f288faa2b3ac93a683ba',
      'fonts/Inter-SemiBold.ttf': 'e7a1aaf7eda9f2fad4131725fa556265ec75ca7b2d756260173a040363e8d4f7',
      'logo.svg': '28ea4c37e464359304b9d7cb5e67a2549251d9b453c1880ca0a11429ebae8ebd',
      'template.yaml': 'c740a63f39fbce306cef123109da679a0c546e4dffa7f08e6baf6fd2628e3901',
    });
  });

  it('a component scaffold: component.yaml, the entry, README.md', async () => {
    const ws = await openWorkspace({ root, agent: false });
    await componentCreate(ws, { id: 'acme/intro-split', kind: 'intro', description: 'A split title card.' }, personScope(root));
    expect(await tree(join(root, 'components', 'acme', 'intro-split'), noSchemaLine)).toEqual({
      'README.md': 'e8ecf52b5ad81b5ba5f49f31e2f22a394ad55c251df1b9bed8262c17df562f99',
      'component.yaml': '2e7b35c2d82c4280f71e578d759fc1c70633873342681b51f5476ee207aef292',
      'index.tsx': 'b12fcacaa1486d65f5e00035a2977b72ea76fee5f824173c806aee6cc0389a26',
    });
  });

  it('a sandbox scaffold: its files and the line project.yaml gains', async () => {
    const project = await openProjectBySlug(await openWorkspace({ root, agent: false }), 'acme');
    const before = await readFile(project.file, 'utf8');
    await initSandbox(project, { isFree: async () => true, write: fileWriter(ProjectStore.of(project, personScope(root)), 'sandbox') });
    const after = await readFile(project.file, 'utf8');
    expect(after.slice(0, before.length)).toBe(before);
    expect(after.slice(before.length)).toBe('sandboxes:\n  sandbox: sandbox/sandbox.yaml\n');
    expect(await tree(join(root, 'projects', 'acme', 'sandbox'), noSchemaLine)).toEqual({
      'README.md': '13c09bcfd37461a7de8bff31ff6e860a8579a7c59afeeb4a0815221c0165f7d2',
      'app/index.html': '8231cd5ea28fdfe291ae78e3a814bdff0313c1974e79d6accf9eb30bb12d88f9',
      'compose.yaml': 'c3843cf7d1e4eac98a90a767548a08515195b956252d34d9fad4cbcd557c9750',
      'sandbox.yaml': '92669262a82eb766ae16bb9f27658ebfc17318cc3b370aca5f855490d0df7439',
      'seed/01-demo-data.sql': 'ea1415a236dbae1a2ed1c24b01362a7390072291a757d2a85d2c00e28d8884c0',
    });
  });
});
