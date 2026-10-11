import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENT_KINDS } from '@demo-studio/core';
import { EXIT, main, memoryIo } from '../src/index.js';

let ws: string;

async function studio(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-components-'));
  await writeFile(join(ws, 'studio.yaml'), 'projects_dir: projects\n');
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('studio components', () => {
  it('list: empty workspace (the built-in library arrives in L2.5)', async () => {
    const r = await studio('components', 'list');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.out).toContain('none yet — create one with `studio components create <namespace/name> --kind <kind>`');
    const json = JSON.parse((await studio('components', 'list', '--json')).out) as { components: unknown[]; components_dir: string };
    expect(json.components).toEqual([]);
    expect(json.components_dir).toBe(join(ws, 'components'));
  });

  it('create: one component of each kind, each validated; list and validate them', async () => {
    for (const kind of COMPONENT_KINDS) {
      const r = await studio('components', 'create', `acme/my-${kind}`, '--kind', kind, '--description', `Our ${kind}.`);
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toContain(`created ${kind} component acme/my-${kind}`);
      expect(r.err).toContain(`studio components validate acme/my-${kind}`);
    }
    const list = await studio('components', 'list');
    expect(list.code).toBe(EXIT.ok);
    for (const kind of COMPONENT_KINDS) expect(list.out).toMatch(new RegExp(`acme/my-${kind}\\s+${kind}\\s+workspace\\s+0\\.1\\.0\\s+Our ${kind}\\.`));
    const layouts = JSON.parse((await studio('components', 'list', '--kind', 'layout', '--json')).out) as {
      components: Array<{ id: string; kind: string; source: string; params: Record<string, unknown>; slots: string[] }>;
    };
    expect(layouts.components).toEqual([
      expect.objectContaining({ id: 'acme/my-layout', kind: 'layout', source: 'workspace', params: { radius: 18, shadow: 'soft' }, slots: ['screen'] }),
    ]);

    const all = await studio('components', 'validate');
    expect(all.code, all.err).toBe(EXIT.ok);
    for (const kind of COMPONENT_KINDS) expect(all.err).toContain(`✓ component acme/my-${kind}`);
    const one = await studio('components', 'validate', 'acme/my-card', '--json');
    expect(JSON.parse(one.out)).toEqual({ ok: true, components: [expect.objectContaining({ id: 'acme/my-card', ok: true, issues: [] })] });
    const byDir = await studio('components', 'validate', join(ws, 'components', 'acme', 'my-intro'));
    expect(byDir.code).toBe(EXIT.ok);
  });

  it('validate reports positioned issues and exits 1; unknown ids get a suggestion', async () => {
    const dir = join(ws, 'components', 'acme', 'my-card');
    const tsx = await readFile(join(dir, 'index.tsx'), 'utf8');
    await writeFile(join(dir, 'index.tsx'), `import fs from 'node:fs';\n${tsx.replace('export default function Card(', 'export default function Card(_x = fs, ')}`);
    const yaml = await readFile(join(dir, 'component.yaml'), 'utf8');
    await writeFile(join(dir, 'component.yaml'), yaml.replace('version: 0.1.0', 'version: one'));
    const r = await studio('components', 'validate', 'acme/my-card');
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toMatch(/✗ component acme\/my-card .* 1 error/);
    expect(r.err).toMatch(/my-card\/component\.yaml:\d+:10 error version: version must be a semantic version/);
    // The manifest is invalid: the entry is not compiled until it is fixed.
    await writeFile(join(dir, 'component.yaml'), yaml);
    const again = await studio('components', 'validate', 'acme/my-card');
    expect(again.code).toBe(EXIT.failure);
    expect(again.err).toMatch(/my-card\/index\.tsx:1:16 error import "node:fs" is not allowed/);
    // The list shows the invalid one as a notice; validating everything fails.
    await writeFile(join(dir, 'component.yaml'), yaml.replace('version: 0.1.0', 'version: one'));
    const list = await studio('components', 'list');
    expect(list.err).toMatch(/✗ invalid component acme\/my-card: 1 error in component\.yaml/);
    expect((await studio('components', 'validate')).code).toBe(EXIT.failure);
    await writeFile(join(dir, 'component.yaml'), yaml);
    await writeFile(join(dir, 'index.tsx'), tsx);

    const unknown = await studio('components', 'validate', 'acme/my-crd');
    expect(unknown.code).toBe(EXIT.failure);
    expect(unknown.err).toMatch(/component "acme\/my-crd" not found in .* \(did you mean "acme\/my-card"\?\)/);
  });

  it('create refuses bad ids, unknown kinds and existing components', async () => {
    const bad = await studio('components', 'create', 'Acme/X', '--kind', 'card');
    expect(bad.code).toBe(EXIT.failure);
    expect(bad.err).toContain('invalid component id "Acme/X"');
    const kind = await studio('components', 'create', 'acme/x', '--kind', 'cardd');
    expect(kind.code).toBe(EXIT.usage);
    expect(kind.err).toMatch(/argument 'cardd' is invalid/);
    expect((await studio('components', 'create', 'acme/x')).code).toBe(EXIT.usage);
    const again = await studio('components', 'create', 'acme/my-card', '--kind', 'card');
    expect(again.code).toBe(EXIT.failure);
    expect(again.err).toContain('already exists');
    const json = await studio('components', 'create', 'acme/badge', '--kind', 'overlay', '--json');
    expect(JSON.parse(json.out)).toMatchObject({ id: 'acme/badge', kind: 'overlay', dir: join(ws, 'components', 'acme', 'badge'), issues: [] });
  });
});
