/**
 * L4.5 part B: the preview bundle (src/player/bundle-player.ts) — esbuild in memory, every component of the workspace,
 * each loaded lazily (critique B3), under an import allow-list that checks real paths (critique B11):
 * - every built-in component and scaffold bundles; one lazy `import()` per component; no path of this Mac inside;
 * - ⚑ a workspace component that imports a file out of its folder, or a link out of it (`./data.json` → an outside
 *   file), is excluded and the outside bytes are absent from the bundle; ⚑ a planted `node_modules/react` inside a
 *   component's folder is not what `react` resolves to; a component that does not compile is excluded with why;
 * - the memo: the same components → one build; an edited component file → a new hash and a new build;
 * - ⚑ review A H1 c: a workspace component the Studio session did not allow (by id and folder content hash) is held —
 *   absent from the bundle, its bytes too; allowed, it is bundled; changed since, held again;
 * - ⚑ L4.7 review A H1: an import reaching a dot folder, node_modules, previews or dist inside the folder (by its words,
 *   or through a folder's package.json) is excluded even when the component is allowed — the content hash skips them;
 * - ⚑ lint: no sandbox token that loosens the frame (`allow-same-origin`, `allow-top-navigation`, …) in src/app or
 *   src/player.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIBRARY_DIR, loadComponentRegistry, scaffoldDir } from '@demo-studio/components';
import { PlayerBundles, buildPlayerBundle, modulesSource, playerBundleHash, playerComponents, workspaceComponents } from '../src/player/bundle-player.js';

let ws: string;
const MARK_OUTSIDE = 'OUTSIDE-SECRET-7f3a';
const MARK_PLANTED = 'PLANTED-REACT-91c2';
const MARK_GOOD = 'GOOD-COMPONENT-4d1e';

async function addCard(name: string, code: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = join(ws, 'components', 'acme', name);
  await mkdir(dir, { recursive: true });
  await cp(scaffoldDir('card'), dir, { recursive: true });
  const manifest = (await readFile(join(dir, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, `id: acme/${name}`);
  await writeFile(join(dir, 'component.yaml'), manifest);
  await writeFile(join(dir, 'index.tsx'), code);
  for (const [f, text] of Object.entries(extra)) {
    await mkdir(join(dir, f, '..'), { recursive: true });
    await writeFile(join(dir, f), text);
  }
  return dir;
}

const card = (body: string, imports = '') => `${imports}
import { AbsoluteFill } from 'remotion';
export default function C() { ${body} }
`;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-player-bundle-'));
  await writeFile(join(ws, 'studio.yaml'), 'version: 1\nprojects_dir: projects\n');
  await mkdir(join(ws, 'outside'), { recursive: true });
  await writeFile(join(ws, 'outside', 'secret.json'), JSON.stringify({ k: MARK_OUTSIDE }));
  await writeFile(join(ws, 'outside', 'secret.txt'), MARK_OUTSIDE);
  await addCard('good', card(`return <AbsoluteFill>{${JSON.stringify(MARK_GOOD)} + label}</AbsoluteFill>;`, "import { label } from './part';"), { 'part.ts': "export const label = 'part';" });
  await addCard('escape', card('return <AbsoluteFill>{String(s)}</AbsoluteFill>;', "import s from '../../../outside/secret.txt';"));
  const linked = await addCard('linked', card('return <AbsoluteFill>{data.k}</AbsoluteFill>;', "import data from './data.json';"));
  await symlink(join(ws, 'outside', 'secret.json'), join(linked, 'data.json'));
  await addCard('planted', card('return <AbsoluteFill>{String(typeof useState)}</AbsoluteFill>;', "import { useState } from 'react';"), {
    'node_modules/react/package.json': '{"name":"react","main":"index.js"}',
    'node_modules/react/index.js': `export const useState = ${JSON.stringify(MARK_PLANTED)};`,
  });
  await addCard('broken', 'export default function C( { return <div>; }\n');
});

afterAll(async () => {
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the preview bundle', () => {
  it('every component bundles lazily; ⚑ links and files out of a folder are excluded with their bytes; ⚑ no planted react', async () => {
    const registry = await loadComponentRegistry({ root: ws });
    const components = await playerComponents(registry);
    const builtins = (await readdir(join(LIBRARY_DIR, 'studio'))).map((d) => `studio/${d}`);
    for (const id of [...builtins, 'acme/good', 'acme/linked', 'acme/escape', 'acme/planted', 'acme/broken']) expect(components.map((c) => c.id), id).toContain(id);
    const b = await buildPlayerBundle(components);
    expect(b.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(b.excluded.map((e) => e.id).sort()).toEqual(['acme/broken', 'acme/escape', 'acme/linked']);
    const why = Object.fromEntries(b.excluded.map((e) => [e.id, e.why]));
    expect(why['acme/escape']).toMatch(/leaves the component folder/);
    expect(why['acme/linked']).toMatch(/leads out of the component folder \(a link\)/);
    for (const w of Object.values(why)) expect(w).not.toContain(ws);
    expect(b.components).toEqual(expect.arrayContaining([...builtins, 'acme/good', 'acme/planted']));
    expect(b.components).not.toContain('acme/linked');
    const js = b.js.toString('utf8');
    expect(js).toContain(MARK_GOOD);
    for (const bad of [MARK_OUTSIDE, MARK_PLANTED, ws, '/Users/', 'RTCPeerConnection']) expect(js, bad).not.toContain(bad);
    // One lazy import per component and scaffold in the bundle (esbuild: a lazily initialised module each).
    expect(js.match(/Promise\.resolve\(\)\.then\(/g)?.length).toBe(b.components.length + 8);
    expect(b.boot.toString('utf8')).toContain('RTCPeerConnection');
    expect(modulesSource('0123456789abcdef', components.slice(0, 2))).toMatch(/^ {2}"[^"]+": \(\) => import\("/m);
  }, 120_000);

  it('the memo: one build for the same components; an edited component file is a new hash and a new build', async () => {
    const bundles = new PlayerBundles();
    const registry = await loadComponentRegistry({ root: ws });
    const [a, a2] = await Promise.all([bundles.get(registry), bundles.get(registry)]);
    expect(a2).toBe(a);
    expect(bundles.builds).toBe(1);
    expect(await bundles.get(registry)).toBe(a);
    const before = await playerBundleHash(await playerComponents(registry));
    await writeFile(join(ws, 'components', 'acme', 'good', 'part.ts'), "export const label = 'edited';");
    const after = await playerBundleHash(await playerComponents(registry));
    expect(after).not.toBe(before);
    const b = await bundles.get(registry);
    expect(b.hash).toBe(after);
    expect(bundles.builds).toBe(2);
  }, 120_000);

  it('⚑ review A H1 c: a workspace component not allowed is not in the bundle at all (held); allowed by its content hash, it is', async () => {
    const registry = await loadComponentRegistry({ root: ws });
    const listed = await workspaceComponents(registry);
    const good = listed.find((c) => c.id === 'acme/good')!;
    expect(good.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(listed.map((c) => c.id)).not.toContain('studio/card-title');
    const bundles = new PlayerBundles();
    // Nothing allowed: every workspace component held, every built-in bundled.
    const none = await bundles.get(registry, () => false);
    expect(none.held).toEqual(listed.map((c) => c.id).sort());
    expect(none.components).not.toContain('acme/good');
    expect(none.components).toContain('studio/card-title');
    expect(none.js.toString('utf8')).not.toContain(MARK_GOOD);
    expect(none.js.toString('utf8')).toContain(JSON.stringify(none.held));
    // Allowed at its hash: in the bundle; at another hash (the folder changed since it was allowed): held.
    const allowed = await bundles.get(registry, (id, hash) => id === good.id && hash === good.hash);
    expect(allowed.components).toContain('acme/good');
    expect(allowed.held).not.toContain('acme/good');
    expect(allowed.js.toString('utf8')).toContain(MARK_GOOD);
    await writeFile(join(ws, 'components', 'acme', 'good', 'part.ts'), "export const label = 'changed again';");
    const changed = await bundles.get(registry, (id, hash) => id === good.id && hash === good.hash);
    expect(changed.held).toContain('acme/good');
    expect(changed.js.toString('utf8')).not.toContain(MARK_GOOD);
    expect(modulesSource('0123456789abcdef', [], ['acme/x'])).toContain('export const held = ["acme/x"];');
  }, 180_000);

  it('⚑ L4.7 review A H1: an import through a dot folder, node_modules, previews or dist (words or package.json) is excluded, even allowed', async () => {
    // The folder content hash (allow-list, library keys, render bundle cache) skips those folders: code there must never
    // run, or an edit of it would run under a hash the person allowed for other code.
    const ws2 = await mkdtemp(join(tmpdir(), 'ds-player-hidden-'));
    try {
      await writeFile(join(ws2, 'studio.yaml'), 'version: 1\nprojects_dir: projects\n');
      const hidden = (n: number) => `export const v = 'HIDDEN-CODE-${n}-e51a';\n`;
      const cases: Record<string, { imports: string; files: Record<string, string> }> = {
        'hid-dot': { imports: "import { v } from './.impl/code';", files: { '.impl/code.ts': hidden(1) } },
        'hid-nm': { imports: "import { v } from './node_modules/lib/index';", files: { 'node_modules/lib/index.ts': hidden(2) } },
        'hid-prev': { imports: "import { v } from './previews/p';", files: { 'previews/p.ts': hidden(3) } },
        'hid-dist': { imports: "import { v } from './dist/x';", files: { 'dist/x.ts': hidden(4) } },
        'hid-pkg': { imports: "import { v } from './lib';", files: { 'lib/package.json': '{"main": "../.impl/code.ts"}', '.impl/code.ts': hidden(5) } },
      };
      for (const [name, c] of Object.entries(cases)) {
        const dir = join(ws2, 'components', 'acme', name);
        await mkdir(dir, { recursive: true });
        await cp(scaffoldDir('card'), dir, { recursive: true });
        const manifest = (await readFile(join(dir, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, `id: acme/${name}`);
        await writeFile(join(dir, 'component.yaml'), manifest);
        await writeFile(join(dir, 'index.tsx'), card('return <AbsoluteFill>{v}</AbsoluteFill>;', c.imports));
        for (const [f, text] of Object.entries(c.files)) {
          await mkdir(join(dir, f, '..'), { recursive: true });
          await writeFile(join(dir, f), text);
        }
      }
      const registry = await loadComponentRegistry({ root: ws2 });
      const listed = await workspaceComponents(registry);
      expect(listed.map((c) => c.id).sort()).toEqual(Object.keys(cases).map((n) => `acme/${n}`).sort());
      // Every one allowed at its current hash: still never bundled.
      const b = await new PlayerBundles().get(registry, (id, hash) => listed.some((c) => c.id === id && c.hash === hash));
      expect(b.held).toEqual([]);
      expect(b.excluded.map((e) => e.id).sort()).toEqual(listed.map((c) => c.id).sort());
      for (const e of b.excluded) {
        expect(e.why, e.id).toMatch(/content hash skips dot folders, node_modules, previews and dist/);
        expect(e.why).not.toContain(ws2);
      }
      expect(b.excluded.find((e) => e.id === 'acme/hid-pkg')?.why).toMatch(/"\.impl\/code\.ts" reaches "\.impl"/);
      const js = b.js.toString('utf8');
      for (let n = 1; n <= 5; n++) expect(js).not.toContain(`HIDDEN-CODE-${n}-e51a`);
    } finally {
      await rm(ws2, { recursive: true, force: true });
    }
  }, 120_000);

  it('⚑ lint: nothing in src/app or src/player loosens the frame sandbox', async () => {
    const SRC = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    for (const d of ['app', 'player']) for (const f of await readdir(join(SRC, d))) files.push(join(SRC, d, f));
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      expect(text, f).not.toMatch(/allow-(same-origin|top-navigation|popups|forms|downloads|modals|pointer-lock|presentation|storage-access)/);
    }
  });
});
