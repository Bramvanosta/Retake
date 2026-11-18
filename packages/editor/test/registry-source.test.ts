/**
 * The registry a plan or a render reads comes from its caller (render/registry-source.ts): a registry handed is used,
 * a loader is called with the root, and work handed neither is refused — a plan, a render and a still load none by
 * themselves (the engine hands them its ComponentRegistries port).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { ComponentRegistry } from '@retake/components/geometry';
import type { EditPlan } from '../src/plan-types.js';
import { NO_REGISTRY, handedRegistry, registryFrom } from '../src/render/registry-source.js';
import { renderPlan, renderStill, renderStills } from '../src/render/render.js';
import { renderComponentPreviews } from '../src/render/preview.js';
import { NO_REGISTRY_HANDED } from '@retake/components/geometry';

const dir = await mkdtemp(join(tmpdir(), 'retake-registry-source-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const REG = { list: () => [], get: () => undefined, has: () => false } as unknown as ComponentRegistry;

describe('the registry of a plan or a render', () => {
  it('a registry handed is the one used; a loader is called once, with the root', async () => {
    expect(await registryFrom(REG, '/ws', 'plan')).toBe(REG);
    const asked: string[] = [];
    expect(await registryFrom(async (root) => (asked.push(root), REG), '/ws', 'plan')).toBe(REG);
    expect(asked).toEqual(['/ws']);
    expect(handedRegistry(REG, 'render')).toBe(REG);
  });

  it("a project's work asks the loader with its folder (its own components first)", async () => {
    const asked: Array<[string, string | undefined]> = [];
    const load = async (root: string, o?: { projectDir?: string }) => (asked.push([root, o?.projectDir]), REG);
    expect(await registryFrom(load, '/ws', 'plan', '/ws/projects/demo')).toBe(REG);
    expect(await registryFrom(load, '/ws', 'plan')).toBe(REG);
    expect(asked).toEqual([
      ['/ws', '/ws/projects/demo'],
      ['/ws', undefined],
    ]);
  });

  it('none (or anything else) is refused in the words of the work, never loaded', async () => {
    for (const given of [undefined, null, 'components', { list: [] }]) {
      await expect(registryFrom(given as never, '/ws', 'plan'), String(given)).rejects.toMatchObject({ name: 'RenderError', message: `plan: ${NO_REGISTRY}` });
      expect(() => handedRegistry(given, 'render'), String(given)).toThrow(`render: ${NO_REGISTRY}`);
    }
  });

  it('a render and a still handed no registry are refused before any bundle or browser', async () => {
    const plan = { durationInFrames: 10, fps: 30, width: 192, height: 108, segments: [], assets: {} } as unknown as EditPlan;
    const common = { workPolicy: PERSON_POLICY, plan, root: dir, cacheDir: join(dir, 'cache') };
    await expect(renderPlan({ ...common, out: join(dir, 'a.mp4') } as never)).rejects.toThrow(`render: ${NO_REGISTRY}`);
    await expect(renderStills({ ...common, frames: [{ frame: 0, out: join(dir, 'a.png') }] } as never)).rejects.toThrow(`render: ${NO_REGISTRY}`);
    await expect(renderStill({ ...common, frame: 0, out: join(dir, 'b.png') } as never)).rejects.toThrow(`render: ${NO_REGISTRY}`);
  });

  it('component previews handed no registry are refused before any bundle or browser, nothing asked of a renderer', async () => {
    const asked: string[] = [];
    const renderer = { previews: { bundle: async () => void asked.push('bundle'), open: async () => void asked.push('open') } };
    const o = { workPolicy: PERSON_POLICY, root: dir, template: {} as never, targets: [], renderer };
    await expect(renderComponentPreviews(o as never)).rejects.toThrow(`preview: ${NO_REGISTRY}`);
    expect(asked).toEqual([]);
  });

  it('the plan, the render and the preview refuse in the one sentence of the components', () => {
    expect(NO_REGISTRY).toBe(NO_REGISTRY_HANDED);
  });
});
