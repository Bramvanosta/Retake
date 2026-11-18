/**
 * The ComponentRegistries port (src/registries/registries.ts): its contract on the components package's adapter (a
 * workspace of the disk) and on the memory one, the memory adapter's own record of loads, the empty registry a test
 * hands where none is read, and the loader the engine hands a plan or a review (refused without a port).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createComponent, loadComponentRegistry } from '@retake/components';
import { packageRegistries } from '@retake/compose';
import { MemoryRegistries, emptyRegistry } from '../src/registries/memory-registries.js';
import { registryLoader } from '../src/registries/registries.js';
import { componentCalls } from '../src/registries/component-calls.js';
import type { ComponentRegistries } from '../src/registries/registries.js';
import { registriesContract } from './registries-contract.js';
import { openWorkspace } from '../src/workspace.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';

const dir = await mkdtemp(join(tmpdir(), 'retake-registries-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const COMPONENT = 'acme/contract-card';
const PROJECT_ONLY = 'acme/project-card';
/** A workspace with one card of its own, and one whose retake.yaml does not parse. */
const made = (async () => {
  const root = join(dir, 'ws');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await createComponent(root, { id: COMPONENT, kind: 'card', write: async (file, text) => (await mkdir(dirname(file), { recursive: true }), await writeFile(file, text)) });
  const broken = join(dir, 'broken');
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, 'retake.yaml'), 'components_dir: [unclosed\n');
  const componentDir = join(root, 'components', COMPONENT);
  const notComponent = join(dir, 'not-a-component');
  await mkdir(notComponent, { recursive: true });
  // A project with its own card of the workspace's id, and one only it holds.
  const projectDir = join(root, 'projects', 'demo');
  const write = async (file: string, text: string) => (await mkdir(dirname(file), { recursive: true }), await writeFile(file, text));
  for (const id of [COMPONENT, PROJECT_ONLY]) await createComponent(root, { id, kind: 'card', componentsDir: join(projectDir, 'components'), write });
  return { root, broken, componentDir, notComponent, projectDir, projectOnly: PROJECT_ONLY };
})();

registriesContract('the components package (packageRegistries)', async () => ({ registries: packageRegistries(), component: COMPONENT, ...(await made) }));

registriesContract('in memory (MemoryRegistries)', async () => {
  const w = await made;
  // Seeded with what the package answers for this workspace's component (the contract checks the shapes both give).
  const disk = packageRegistries().catalogue;
  const seed = {
    validations: { [w.componentDir]: await disk.validate(w.componentDir) },
    previews: { [w.componentDir]: await disk.previewStatus(w.componentDir) },
    files: { [w.componentDir]: await disk.sourceFiles(w.componentDir) },
  };
  const project = await loadComponentRegistry({ root: w.root, projectComponentsDir: join(w.projectDir, 'components') });
  return { registries: new MemoryRegistries({ [w.root]: await loadComponentRegistry({ root: w.root }), [w.projectDir]: project }, seed), component: COMPONENT, ...w };
});

describe('the in-memory registries', () => {
  it('lists every root asked (resolved), and hands back the registry it was given', async () => {
    const reg = emptyRegistry();
    const m = new MemoryRegistries({ '/ws/a/': reg });
    expect(await m.load('/ws/a')).toBe(reg);
    await expect(m.load('/ws/b')).rejects.toThrow("no component registry for the workspace /ws/b (not among the test's registries)");
    expect(m.loads).toEqual(['/ws/a', '/ws/b']);
  });

  it('the empty registry holds no component and refuses every lookup', () => {
    const reg = emptyRegistry();
    expect([reg.list(), reg.has('acme/x'), reg.notices]).toEqual([[], false, []]);
    expect(() => reg.get('acme/x')).toThrow(/not found/);
    expect(() => reg.resolve({ id: 'acme/x' }, 'card')).toThrow(/not found/);
  });
});

describe('the loader the engine hands a plan or a review', () => {
  it("asks the port with the root the work names, at the work's call", async () => {
    const reg = emptyRegistry();
    const m = new MemoryRegistries({ '/ws/a': reg });
    const load = registryLoader(m);
    expect(m.loads).toEqual([]);
    expect(await load('/ws/a')).toBe(reg);
    expect(m.loads).toEqual(['/ws/a']);
    // A project's: the port is asked with its folder (the work's project), never a load of the workspace's alone.
    const own = emptyRegistry('/ws/a/projects/p/components');
    const m2 = new MemoryRegistries({ '/ws/a': reg, '/ws/a/projects/p': own });
    expect(await registryLoader(m2)('/ws/a', { projectDir: '/ws/a/projects/p' })).toBe(own);
    expect([m2.loads, m2.projects]).toEqual([['/ws/a'], ['/ws/a/projects/p']]);
  });

  it('refuses a missing port at once (a caller outside the type checker), never a load of its own', () => {
    for (const given of [undefined, null, {}]) {
      expect(() => registryLoader(given as unknown as ComponentRegistries), String(given)).toThrow(
        expect.objectContaining({ name: 'EngineError', code: 'internal', message: 'no component registries were handed to the engine' }),
      );
    }
  });
});

describe("the components package's pure members, handed on beside the port", () => {
  it("are these, by name: none reads or writes a component's files or compiles its code (the port's catalogue does)", async () => {
    expect(Object.keys(await componentCalls()).sort()).toEqual([
      'KIT_API_VERSION',
      'PREVIEW_FILE',
      'PREVIEW_MAX_BYTES',
      'PREVIEW_SAMPLES_DIR',
      'PREVIEW_SIZE',
      'PREVIEW_THEME',
      'applyParamDefaults',
      'componentFit',
      'derivePalette',
      'fontFileFace',
      'generateThemeFile',
      'kitMajorOf',
      'paletteTone',
      'paramDefaults',
      'resolveLogoKind',
      'scaffoldDir',
      'themeTokens',
      'validateParamValue',
    ]);
  });
});

describe('a review handed no registry', () => {
  it("is refused in the components' one sentence (the editor's test checks its own)", async () => {
    const { NO_REGISTRY_HANDED } = await import('@retake/components/geometry');
    const { NOT_HANDED_REGISTRY } = await import('@retake/review/checks');
    expect(NOT_HANDED_REGISTRY).toBe(NO_REGISTRY_HANDED);
  });
});

describe('a workspace opened without its registries', () => {
  it('is refused at the open, in plain words, before anything is read', async () => {
    const { root } = await made;
    for (const registries of [undefined, null, {}]) {
      await expect(openWorkspace({ root, agent: false, reads: diskWorkspaceReads, outputs: diskOutputs, registries: registries as never }), String(registries)).rejects.toMatchObject({
        name: 'EngineError',
        code: 'internal',
        message: 'no component registries were handed to the engine',
      });
    }
    expect((await openWorkspace({ root, agent: false, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() })).root).toBe(root);
  });
});
