import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENT_KINDS } from '@retake/core';
import { EXIT, main, memoryIo } from '../src/index.js';

let ws: string;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-components-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('retake components', () => {
  it('list: an empty workspace lists the built-in library (41 components since L2.12, each with its preview)', async () => {
    const r = await retake('components', 'list');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.out).not.toContain('none yet');
    expect(r.out).toMatch(/studio\/layout-card\s+layout\s+built-in\s+1\.0\.0/);
    expect(r.out).toMatch(/studio\/layout-browser\s+layout\s+built-in\s+1\.0\.0/);
    expect(r.out).toMatch(/studio\/layout-tablet\s+layout\s+built-in\s+1\.0\.0/);
    const json = JSON.parse((await retake('components', 'list', '--json')).out) as {
      components: Array<{ id: string; source: string; tags?: string[]; preview?: string; dir: string }>;
      components_dir: string;
    };
    expect(json.components.filter((c) => c.source === 'workspace')).toEqual([]);
    expect(json.components).toHaveLength(41);
    const reference = ['studio/caption-below', 'studio/interstitial-clock', 'studio/intro-stack', 'studio/layout-card', 'studio/outro-stack', 'studio/transition-crossfade'];
    for (const c of json.components) {
      expect(c.tags ?? [], c.id).not.toContain('placeholder');
      expect(c.preview, c.id).toBe(join(c.dir, 'preview.png'));
    }
    expect(
      json.components
        .filter((c) => c.tags?.includes('reference-look'))
        .map((c) => c.id)
        .sort(),
    ).toEqual(reference);
    expect(json.components_dir).toBe(join(ws, 'components'));
  });

  it('create: one component of each kind, each validated; list and validate them', async () => {
    for (const kind of COMPONENT_KINDS) {
      const r = await retake('components', 'create', `acme/my-${kind}`, '--kind', kind, '--description', `Our ${kind}.`, '--no-preview');
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toContain(`created ${kind} component acme/my-${kind}`);
      expect(r.err).toContain(`retake components validate acme/my-${kind}`);
    }
    const list = await retake('components', 'list');
    expect(list.code).toBe(EXIT.ok);
    for (const kind of COMPONENT_KINDS) expect(list.out).toMatch(new RegExp(`acme/my-${kind}\\s+${kind}\\s+workspace\\s+0\\.1\\.0\\s+Our ${kind}\\.`));
    const layouts = JSON.parse((await retake('components', 'list', '--kind', 'layout', '--json')).out) as {
      components: Array<{ id: string; kind: string; source: string; params: Record<string, unknown>; slots: string[] }>;
    };
    expect(layouts.components.filter((c) => c.source === 'builtin').map((c) => c.id)).toEqual([
      'studio/layout-browser',
      'studio/layout-card',
      'studio/layout-laptop',
      'studio/layout-phone',
      'studio/layout-pip',
      'studio/layout-raw',
      'studio/layout-split',
      'studio/layout-tablet',
    ]);
    expect(layouts.components.filter((c) => c.source === 'workspace')).toEqual([
      expect.objectContaining({ id: 'acme/my-layout', kind: 'layout', source: 'workspace', params: { radius: 18, shadow: 'soft' }, slots: ['screen'] }),
    ]);

    const all = await retake('components', 'validate');
    expect(all.code, all.err).toBe(EXIT.ok);
    for (const kind of COMPONENT_KINDS) expect(all.err).toContain(`✓ component acme/my-${kind}`);
    const one = await retake('components', 'validate', 'acme/my-card', '--json');
    expect(JSON.parse(one.out)).toEqual({ ok: true, components: [expect.objectContaining({ id: 'acme/my-card', ok: true, issues: [] })] });
    const byDir = await retake('components', 'validate', join(ws, 'components', 'acme', 'my-intro'));
    expect(byDir.code).toBe(EXIT.ok);
  });

  it('validate reports positioned issues and exits 1; unknown ids get a suggestion', async () => {
    const dir = join(ws, 'components', 'acme', 'my-card');
    const tsx = await readFile(join(dir, 'index.tsx'), 'utf8');
    await writeFile(join(dir, 'index.tsx'), `import fs from 'node:fs';\n${tsx.replace('export default function Card(', 'export default function Card(_x = fs, ')}`);
    const yaml = await readFile(join(dir, 'component.yaml'), 'utf8');
    await writeFile(join(dir, 'component.yaml'), yaml.replace('version: 0.1.0', 'version: one'));
    const r = await retake('components', 'validate', 'acme/my-card');
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toMatch(/✗ component acme\/my-card .* 1 error/);
    expect(r.err).toMatch(/my-card\/component\.yaml:\d+:10 error version: version must be a semantic version/);
    // The manifest is invalid: the entry is not compiled until it is fixed.
    await writeFile(join(dir, 'component.yaml'), yaml);
    const again = await retake('components', 'validate', 'acme/my-card');
    expect(again.code).toBe(EXIT.failure);
    expect(again.err).toMatch(/my-card\/index\.tsx:1:16 error import "node:fs" is not allowed/);
    // The list shows the invalid one as a notice; validating everything fails.
    await writeFile(join(dir, 'component.yaml'), yaml.replace('version: 0.1.0', 'version: one'));
    const list = await retake('components', 'list');
    expect(list.err).toMatch(/✗ invalid component acme\/my-card: 1 error in component\.yaml/);
    expect((await retake('components', 'validate')).code).toBe(EXIT.failure);
    await writeFile(join(dir, 'component.yaml'), yaml);
    await writeFile(join(dir, 'index.tsx'), tsx);

    const unknown = await retake('components', 'validate', 'acme/my-crd');
    expect(unknown.code).toBe(EXIT.failure);
    expect(unknown.err).toMatch(/component "acme\/my-crd" not found in .* \(did you mean "acme\/my-card"\?\)/);
  });

  it('create refuses bad ids, unknown kinds and existing components', async () => {
    const bad = await retake('components', 'create', 'Acme/X', '--kind', 'card');
    expect(bad.code).toBe(EXIT.failure);
    expect(bad.err).toContain('invalid component id "Acme/X"');
    const kind = await retake('components', 'create', 'acme/x', '--kind', 'cardd');
    expect(kind.code).toBe(EXIT.usage);
    expect(kind.err).toMatch(/argument 'cardd' is invalid/);
    expect((await retake('components', 'create', 'acme/x')).code).toBe(EXIT.usage);
    const again = await retake('components', 'create', 'acme/my-card', '--kind', 'card', '--no-preview');
    expect(again.code).toBe(EXIT.failure);
    expect(again.err).toContain('already exists');
    const json = await retake('components', 'create', 'acme/badge', '--kind', 'overlay', '--json', '--no-preview');
    expect(JSON.parse(json.out)).toMatchObject({ id: 'acme/badge', kind: 'overlay', dir: join(ws, 'components', 'acme', 'badge'), issues: [] });
  });

  it('create renders the preview (README block, sidecar); preview re-renders it, --stale skips fresh ones, --out writes images only', async () => {
    const r = await retake('components', 'create', 'acme/chapter', '--kind', 'card', '--description', 'A chapter card.');
    expect(r.code, r.err).toBe(EXIT.ok);
    const dir = join(ws, 'components', 'acme', 'chapter');
    expect(r.err).toContain('preview.png     generated preview (editorial theme');
    expect(existsSync(join(dir, 'preview.png'))).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'preview.json'), 'utf8'))).toMatchObject({ component: 'acme/chapter', theme: 'editorial', kind: 'card' });
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('](preview.png)');
    // Fresh: --stale has nothing to do; after an edit it re-renders.
    const fresh = await retake('components', 'preview', '--all', '--workspace', '--stale', '--json');
    expect(JSON.parse(fresh.out).previews.map((p: { id: string }) => p.id)).not.toContain('acme/chapter');
    const out = join(ws, 'previews-out');
    const one = await retake('components', 'preview', 'acme/chapter', '--out', out, '--theme', 'motion', '--json');
    expect(one.code, one.err).toBe(EXIT.ok);
    expect(JSON.parse(one.out)).toMatchObject({ theme: 'motion', previews: [{ id: 'acme/chapter', file: join(out, 'acme', 'chapter.png') }] });
    expect(existsSync(join(out, 'acme', 'chapter.png'))).toBe(true);
    // --out left the component's own preview (editorial) alone.
    expect(JSON.parse(await readFile(join(dir, 'preview.json'), 'utf8')).theme).toBe('editorial');
    expect((await retake('components', 'preview')).code).toBe(EXIT.failure);
  }, 300_000);
});
