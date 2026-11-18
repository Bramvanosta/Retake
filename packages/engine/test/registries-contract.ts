/**
 * The ComponentRegistries port's contract (src/registries/registries.ts): what every adapter does with a workspace root
 * and with a component folder — its registry, its catalogue's validation, scaffold, preview status and source files — run on
 * the product's (package-registries.ts, on a workspace of the disk) and the memory one (registries.test.ts, seeded with
 * the same workspace's answers). A scaffold writes through the caller's `write` only.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentRegistries } from '../src/registries/registries.js';

export interface RegistriesCase {
  registries: ComponentRegistries;
  /** A workspace whose components/ folder holds `component` (a card). */
  root: string;
  component: string;
  /** A workspace whose settings cannot be read. */
  broken: string;
  /** The folder of `component`, and a folder that is no component. */
  componentDir: string;
  notComponent: string;
  /** A project folder whose components/ holds its own `component` (overriding the workspace's) and `projectOnly`. */
  projectDir: string;
  projectOnly: string;
}

let made = 0;

export function registriesContract(adapter: string, make: () => Promise<RegistriesCase>): void {
  describe(`the ComponentRegistries contract: ${adapter}`, () => {
    it("loads the workspace's registry: its own component, by id, beside the built-in library", async () => {
      const c = await make();
      const reg = await c.registries.load(c.root);
      expect(reg.has(c.component)).toBe(true);
      expect(reg.get(c.component)).toMatchObject({ source: 'workspace', manifest: { id: c.component, kind: 'card' } });
      const ids = reg.list().map((i) => i.manifest.id);
      expect(ids).toEqual([...ids].sort());
      expect(reg.list().some((i) => i.source === 'builtin')).toBe(true);
      expect(reg.list('card').map((i) => i.manifest.id)).toContain(c.component);
    });

    it("a project's registry: its own components first (source project), the workspace's beside them; the workspace's alone unchanged", async () => {
      const c = await make();
      const reg = await c.registries.load(c.root, { projectDir: c.projectDir });
      expect(reg.get(c.component)).toMatchObject({ source: 'project', dir: join(c.projectDir, 'components', c.component) });
      expect(reg.get(c.projectOnly).source).toBe('project');
      expect(reg.list().some((i) => i.source === 'builtin')).toBe(true);
      const ws = await c.registries.load(c.root);
      expect(ws.get(c.component).source).toBe('workspace');
      expect(ws.has(c.projectOnly)).toBe(false);
    });

    it('a component it does not hold is refused by the registry, not by the load', async () => {
      const c = await make();
      const reg = await c.registries.load(c.root);
      expect(reg.has('acme/none-such')).toBe(false);
      expect(() => reg.get('acme/none-such')).toThrow(/not found/);
    });

    it('a workspace whose settings cannot be read rejects (an Error), and the next load of a good one still works', async () => {
      const c = await make();
      await expect(c.registries.load(c.broken)).rejects.toBeInstanceOf(Error);
      expect((await c.registries.load(c.root)).has(c.component)).toBe(true);
    });

    it("the catalogue: a component's folder validates, has no preview yet and lists its manifest and entry; another folder is no component", async () => {
      const c = await make();
      const v = await c.registries.catalogue.validate(c.componentDir);
      expect(v).toMatchObject({ dir: c.componentDir, ok: true, manifest: { id: c.component } });
      expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
      const not = await c.registries.catalogue.validate(c.notComponent);
      expect(not.ok).toBe(false);
      expect(not.issues.some((i) => i.severity === 'error')).toBe(true);
      expect((await c.registries.catalogue.previewStatus(c.componentDir)).state).toBe('missing');
      expect(await c.registries.catalogue.sourceFiles(c.componentDir)).toEqual(expect.arrayContaining(['component.yaml', 'index.tsx']));
    });

    it('the catalogue scaffolds a component through the write it is handed, in the components folder, and refuses an id that is no "namespace/name"', async () => {
      const c = await make();
      const id = `acme/contract-made-${made++}`;
      const written: string[] = [];
      const write = async (file: string, text: string) => {
        written.push(file);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
      };
      const created = await c.registries.catalogue.create(c.root, { id, kind: 'card', write });
      expect(created).toMatchObject({ dir: join(c.root, 'components', id), manifest: { id, kind: 'card' }, source: 'workspace' });
      expect(created.files.length).toBeGreaterThanOrEqual(3);
      expect(created.files).toEqual(written);
      expect(written.map((f) => f.slice(created.dir.length + 1))).toEqual(expect.arrayContaining(['component.yaml', 'README.md']));
      expect(created.issues.filter((i) => i.severity === 'error')).toEqual([]);
      await expect(c.registries.catalogue.create(c.root, { id: 'no-namespace', kind: 'card', write })).rejects.toThrow(/invalid component id "no-namespace"/);
      await expect(c.registries.catalogue.create(c.root, { id, kind: 'card', write })).rejects.toThrow(/already exists/);
    });
  });
}
