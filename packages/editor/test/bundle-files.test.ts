/**
 * L4.7 review A H1: a component folder's content hash (componentFolderHash / bundleHash: the render bundle cache, the
 * Studio's preview allow-list, library preview keys) covers every file a bundler loads of it.
 * - for every built-in component, every scaffold and a crafted workspace component (subfolder, JSON, `.js` sibling
 *   import), the files esbuild actually loads (the compile check's metafile) are all hashed, and changing any one of
 *   them (in a copy) changes the hash;
 * - ⚑ the render bundler's guard (`bundledFileProblem`, applied by the `componentFilesGuard` webpack plugin) refuses a
 *   loaded file the hash skips (dot folder, node_modules, previews, dist, a preview artifact) and a file of the folders
 *   holding components that belongs to none (a planted node_modules there); the plugin turns each into a build error.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENT_KINDS } from '@demo-studio/core';
import { checkComponentEntry, loadComponentRegistry, paramDefaults, scaffoldDir } from '@demo-studio/components';
import type { JsonSchemaNode } from '@demo-studio/components';
import { bundledFileProblem, componentFilesGuard, componentFolderHash, componentHashedFiles, scaffoldComponents } from '@demo-studio/editor';
import type { BundleComponent } from '@demo-studio/editor';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'demo-studio-bundle-files-'));
  await writeFile(join(root, 'studio.yaml'), 'projects_dir: projects\n');
  const dir = join(root, 'components', 'acme', 'crafted');
  await mkdir(dir, { recursive: true });
  await cp(scaffoldDir('card'), dir, { recursive: true });
  const manifest = (await readFile(join(dir, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/crafted');
  await writeFile(join(dir, 'component.yaml'), manifest);
  await mkdir(join(dir, 'parts', 'deep'), { recursive: true });
  await writeFile(join(dir, 'parts', 'label.ts'), "import { more } from './deep/more.js';\nexport const label = 'crafted ' + more;\n");
  await writeFile(join(dir, 'parts', 'deep', 'more.ts'), "export const more = 'more';\n");
  await writeFile(join(dir, 'data.json'), '{"n": 3}\n');
  await writeFile(
    join(dir, 'index.tsx'),
    "import { AbsoluteFill } from 'remotion';\nimport { label } from './parts/label';\nimport data from './data.json';\nexport default function C() { return <AbsoluteFill>{label}{data.n}</AbsoluteFill>; }\n",
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function everyComponent(): Promise<BundleComponent[]> {
  const registry = await loadComponentRegistry({ root });
  const out: BundleComponent[] = registry.list().map((i) => ({
    id: i.manifest.id,
    kind: i.manifest.kind,
    dir: i.dir,
    entry: i.entry,
    defaults: paramDefaults(i.manifest.params as JsonSchemaNode | undefined),
  }));
  out.push(...(await scaffoldComponents()));
  return out;
}

const rel = (dir: string, f: string) => relative(dir, f).split(sep).join('/');

describe('the content hash covers what the bundler loads (L4.7 review A H1)', () => {
  it('every built-in, scaffold and a crafted workspace component: each loaded file is hashed, and a change of it is a new hash', async () => {
    const components = await everyComponent();
    expect(components.map((c) => c.id)).toContain('acme/crafted');
    expect(components.filter((c) => c.scaffold)).toHaveLength(COMPONENT_KINDS.length);
    expect(components.filter((c) => c.id.startsWith('studio/')).length).toBeGreaterThan(30);
    const copies = join(root, 'copies');
    let changed = 0;
    for (const c of components) {
      const check = await checkComponentEntry(c.dir, c.entry);
      expect(check.issues.filter((i) => i.severity === 'error'), c.id).toEqual([]);
      const hashed = componentHashedFiles(c.dir).map((f) => rel(c.dir, f));
      for (const f of check.files) expect(hashed, `${c.id}: ${f}`).toContain(f);
      if (c.id === 'acme/crafted') expect(check.files.sort()).toEqual(['data.json', 'index.tsx', 'parts/deep/more.ts', 'parts/label.ts']);
      // In a copy: append a byte to each loaded file in turn; the folder hash moves every time.
      const copy = join(copies, c.id.replace('/', '__'));
      await cp(c.dir, copy, { recursive: true });
      const at = { ...c, dir: copy, entry: join(copy, rel(c.dir, c.entry)) };
      const base = await componentFolderHash(at);
      for (const f of check.files) {
        const file = join(copy, f);
        const before = await readFile(file);
        await writeFile(file, Buffer.concat([before, Buffer.from('\n')]));
        expect(await componentFolderHash(at), `${c.id}: ${f}`).not.toBe(base);
        await writeFile(file, before);
        changed++;
      }
      expect(await componentFolderHash(at)).toBe(base);
      await rm(copy, { recursive: true, force: true });
    }
    expect(changed).toBeGreaterThan(components.length);
  }, 300_000);

  it('⚑ the render bundler guard refuses a loaded file the hash skips, and a file of the components folder no component owns', async () => {
    const dir = join(root, 'components', 'acme', 'crafted');
    const c = [{ id: 'acme/crafted', dir }, { id: 'scaffolds/card', dir: scaffoldDir('card'), scaffold: true }];
    expect(bundledFileProblem(join(dir, 'index.tsx'), c)).toBeUndefined();
    expect(bundledFileProblem(join(dir, 'parts', 'label.ts'), c)).toBeUndefined();
    expect(bundledFileProblem(`${join(dir, 'data.json')}?query`, c)).toBeUndefined();
    for (const [f, what] of [
      ['.impl/code.ts', '".impl" (a dot entry)'],
      ['node_modules/react/index.js', 'node_modules/'],
      ['previews/p.ts', 'previews/'],
      ['dist/x.js', 'dist/'],
      ['preview.json', 'preview.json (a generated preview file)'],
      ['notes.txt', "notes.txt (a file type the component's content hash does not read)"],
    ] as const) {
      expect(bundledFileProblem(join(dir, f), c), f).toBe(`acme/crafted: import "${f}" reaches ${what}: a component's content hash skips dot folders, node_modules, previews and dist, so a change there would go unseen — keep imported code in the component folder or a plain subfolder`);
    }
    for (const f of ['components/acme/node_modules/react/index.js', 'components/node_modules/react/index.js']) {
      expect(bundledFileProblem(join(root, f), c), f).toMatch(/from the folder holding acme\/crafted, but it belongs to no component/);
    }
    // A file elsewhere (a package, the composition) is not the guard's business; a scaffold's parents are not watched.
    expect(bundledFileProblem(join(root, 'node_modules', 'react', 'index.js'), c)).toBeUndefined();
    expect(bundledFileProblem(join(scaffoldDir('card'), '..', '..', 'src', 'kit', 'index.ts'), c)).toBeUndefined();

    // The webpack plugin: one build error per refused module, nothing for the others.
    let tapped: ((modules: Iterable<{ resource?: unknown }>) => void) | undefined;
    const compilation = { errors: [] as Error[], hooks: { finishModules: { tap: (_: string, fn: typeof tapped) => void (tapped = fn) } } };
    componentFilesGuard(c).apply({ hooks: { compilation: { tap: (_: string, fn: (x: typeof compilation) => void) => fn(compilation) } } });
    tapped!([{ resource: join(dir, 'index.tsx') }, { resource: join(dir, '.impl', 'code.ts') }, {}, { resource: join(root, 'components', 'node_modules', 'x.js') }]);
    expect(compilation.errors.map((e) => e.message.slice(0, 40))).toEqual(['acme/crafted: import ".impl/code.ts" rea', 'the render bundle loaded node_modules/x.']);
  });
});
