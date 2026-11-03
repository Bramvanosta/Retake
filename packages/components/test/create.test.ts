import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENT_KINDS } from '@retake/core';
import { COMPONENT_SCHEMA_FILE, ComponentError, componentDisplayName, createComponent, loadComponentRegistry, parseManifest } from '@retake/components';
import { tempDir, writeFiles } from './helpers.js';

let ws: { dir: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  ws = await tempDir();
});

afterAll(async () => {
  await ws.cleanup();
});

describe('createComponent (R-REG-10, R-DEC-03)', () => {
  it('scaffolds a valid component of every kind in the workspace components/ folder', async () => {
    for (const kind of COMPONENT_KINDS) {
      const id = `acme/my-${kind}`;
      const created = await createComponent(ws.dir, { id, kind, description: `Our ${kind}.` });
      const dir = join(ws.dir, 'components', 'acme', `my-${kind}`);
      expect(created.dir).toBe(dir);
      expect(created.source).toBe('workspace');
      expect(created.entry).toBe(join(dir, 'index.tsx'));
      expect(created.issues, kind).toEqual([]);
      expect(created.files.map((f) => f.slice(dir.length + 1)).sort()).toEqual(['README.md', 'component.yaml', 'index.tsx']);
      expect(created.manifest).toMatchObject({ id, kind, name: `My ${kind}`, description: `Our ${kind}.`, version: '0.1.0' });
      const yaml = readFileSync(join(dir, 'component.yaml'), 'utf8');
      // Comments of the scaffold are kept; the schema comment points at the package schema from the new folder.
      const schemaLine = yaml.split('\n')[0];
      expect(schemaLine).toMatch(/^# yaml-language-server: \$schema=/);
      expect(resolve(dir, schemaLine.split('$schema=')[1])).toBe(COMPONENT_SCHEMA_FILE);
      expect(yaml).toContain(`id: ${id}\n`);
      expect(parseManifest(yaml, 'component.yaml', { folderId: id }).issues).toEqual([]);
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain(`retake components validate ${id}`);
    }
    const reg = await loadComponentRegistry({ root: ws.dir, builtinDir: null });
    expect(reg.list().map((c) => c.manifest.kind).sort()).toEqual([...COMPONENT_KINDS].sort());
    expect(reg.resolve('acme/my-layout', 'layout').params).toEqual({ radius: 18, shadow: 'soft' });
  });

  it('defaults the name and description, and notes an override of a built-in id', async () => {
    const builtin = join(ws.dir, 'lib');
    await writeFiles(builtin, { 'studio/card-title/component.yaml': 'id: studio/card-title\n' });
    const created = await createComponent(ws.dir, { id: 'studio/card-title', kind: 'card', builtinDir: builtin });
    expect(created.manifest.name).toBe('Card title');
    expect(created.manifest.description).toMatch(/^TODO: describe what this card looks like/);
    expect(created.overrides).toBe(join(builtin, 'studio/card-title'));
  });

  it('rejects bad ids, unknown kinds and existing folders', async () => {
    await expect(createComponent(ws.dir, { id: 'Acme/Intro', kind: 'intro' })).rejects.toThrow(/invalid component id "Acme\/Intro": use "namespace\/name"/);
    await expect(createComponent(ws.dir, { id: 'intro', kind: 'intro' })).rejects.toThrow(ComponentError);
    await expect(createComponent(ws.dir, { id: 'acme/x', kind: 'outr' as never })).rejects.toThrow(/unknown component kind "outr" \(did you mean "outro"\?\)/);
    await expect(createComponent(ws.dir, { id: 'acme/my-intro', kind: 'intro' })).rejects.toThrow(/already exists/);
    expect(existsSync(join(ws.dir, 'components', 'acme', 'x'))).toBe(false);
  });

  it('honours retake.yaml components_dir', async () => {
    const other = await tempDir();
    try {
      await writeFiles(other.dir, { 'retake.yaml': 'components_dir: design/components\n' });
      const created = await createComponent(other.dir, { id: 'acme/badge', kind: 'overlay' });
      expect(created.dir).toBe(join(other.dir, 'design/components/acme/badge'));
    } finally {
      await other.cleanup();
    }
  });

  it('componentDisplayName', () => {
    expect(componentDisplayName('acme/intro-split')).toBe('Intro split');
    expect(componentDisplayName('acme/x')).toBe('X');
  });
});
