/**
 * The renderer's contract (the Renderer port, src/render/renderer.ts), one suite every adapter passes: the in-memory
 * renderer (tests) and the editor's driver (the product's: real renders, where the tools are). A video is whole or
 * absent, a cancel is said as `cancelled` (before and during), progress keeps its order, stills come back in the order
 * asked and refuse a frame outside the plan, a render that cannot write its file fails as a failure (not a cancel, not
 * a full disk) and what it says beside its message has the port's shape, a preview bundle is named by its components
 * and serves sessions that write a PNG or a GIF until they are closed.
 *
 * No case passes by returning early: an adapter whose fixture has no preview material says so (`previews: false`) and
 * its two preview cases are reported skipped. The values a result names (which GL, which encoder, where the browser
 * came from) are the adapter's: the suite checks that they are said and agree with each other, not which they are.
 * Not here, because it is not an adapter's: the engine refusing work with no renderer (pipeline.test.ts), and what the
 * use cases do with a failure's fields (the editor's render-driver.test.ts; an adapter's own fields, its own test).
 */
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorKindOf } from '@retake/core';
import type { WorkPolicy } from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import type { BundleComponent, ComponentPreviewSpec, EditPlan, RenderProgress } from '@retake/editor';
import type { RenderProcess, Renderer, RendererFailure } from '../src/render/renderer.js';

const STAGES = ['bundling', 'rendering', 'retrying', 'encoding'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export interface ContractRenderer {
  renderer: Renderer;
  /** A plan the renderer can render, of at least 4 frames. */
  plan: EditPlan;
  workPolicy: WorkPolicy;
  /** Workspace root and registry of the plan's components. */
  root: string;
  registry?: ComponentRegistry;
  /** An empty folder for what the case writes. */
  out: string;
  /** Cancel a video while it renders: resolves once the render has started, having aborted `abort`. */
  cancelDuring(abort: AbortController): { duringVideo?: () => void; onProgress: (p: RenderProgress) => void };
  /** Preview material: two different sets of components, a spec of the first set and where its files are served. */
  previews?: PreviewMaterial;
}
type PreviewMaterial = { sets: [BundleComponent[], BundleComponent[]]; spec: ComponentPreviewSpec; assets: string };

/** The preview material of a fixture that said it has some: a case never passes for want of it. */
function previewsOf(c: ContractRenderer): PreviewMaterial {
  if (!c.previews) throw new Error('this fixture said `previews: true` and gives no preview material');
  return c.previews;
}
const said = (v: unknown): boolean => typeof v === 'string' && v.length > 0;

/**
 * `make(name)`: a renderer and its material, new each call. `previews`: whether the fixture gives preview material
 * (false: the two preview cases are skipped, and reported so). `timeout`: per case (a real render is slow).
 */
export function rendererContract(adapter: string, make: (name: string) => Promise<ContractRenderer>, o: { previews: boolean; timeout?: number; skip?: boolean }): void {
  const t = o.timeout ?? 20_000;
  describe.skipIf(o.skip === true)(`the renderer contract (${adapter})`, () => {
    it('a video is written whole at `out`, with what the record needs and its progress in order', async () => {
      const c = await make('video');
      const out = join(c.out, 'video.mp4');
      const seen: RenderProgress[] = [];
      const processes: RenderProcess[] = [];
      let processAt = -1;
      const res = await c.renderer.video({
        workPolicy: c.workPolicy, plan: c.plan, out, root: c.root, ...(c.registry ? { registry: c.registry } : {}),
        onProgress: (p) => seen.push(p),
        onProcess: (p) => { processes.push(p); processAt = seen.length; },
      });
      expect(res.file).toBe(out);
      expect(res.size_bytes).toBeGreaterThan(0);
      expect((await stat(out)).size).toBe(res.size_bytes);
      expect(res.concurrency).toBeGreaterThanOrEqual(1);
      expect(typeof res.bundle.hash).toBe('string');
      expect(typeof res.bundle.cached).toBe('boolean');
      expect(said(res.browser.source)).toBe(true);
      expect(res.browser.path === null || said(res.browser.path)).toBe(true);
      expect(Array.isArray(res.warnings)).toBe(true);
      expect(said(res.renderPath.gl.used)).toBe(true);
      expect(said(res.renderPath.encoder.used)).toBe(true);
      expect(res.encoding.encoder).toBe(res.renderPath.encoder.used);
      // The port's own name: a result names no `path` (the word is a file's, on a system error).
      expect(Object.hasOwn(res, 'path')).toBe(false);
      // Progress: the port's stages only, never back, the frames of the whole plan.
      expect(seen.length).toBeGreaterThan(0);
      for (const p of seen) expect(STAGES).toContain(p.stage);
      for (let i = 1; i < seen.length; i++) expect(seen[i].overall).toBeGreaterThanOrEqual(seen[i - 1].overall);
      expect(seen.at(-1)!.overall).toBeLessThanOrEqual(1);
      const rendering = seen.findIndex((p) => p.stage === 'rendering');
      expect(rendering).toBeGreaterThanOrEqual(0);
      expect(seen[rendering].totalFrames).toBe(c.plan.durationInFrames);
      // The process: at most once, before the first `rendering` progress.
      expect(processes.length).toBeLessThanOrEqual(1);
      if (processes.length) {
        expect(processes[0].pid).toBeGreaterThan(0);
        expect(processAt).toBeLessThanOrEqual(rendering);
      }
    }, t);

    it('a frame range renders only its frames', async () => {
      const c = await make('range');
      const seen: RenderProgress[] = [];
      await c.renderer.video({ workPolicy: c.workPolicy, plan: c.plan, out: join(c.out, 'range.mp4'), root: c.root, ...(c.registry ? { registry: c.registry } : {}), frameRange: [1, 2], onProgress: (p) => seen.push(p) });
      expect(seen.find((p) => p.stage === 'rendering')?.totalFrames).toBe(2);
    }, t);

    it('a signal aborted before the render rejects `cancelled` and leaves nothing at `out`', async () => {
      const c = await make('cancel-before');
      const out = join(c.out, 'cancelled.mp4');
      const abort = new AbortController();
      abort.abort();
      const e = await c.renderer.video({ workPolicy: c.workPolicy, plan: c.plan, out, root: c.root, ...(c.registry ? { registry: c.registry } : {}), signal: abort.signal }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(errorKindOf(e)).toBe('cancelled');
      expect(existsSync(out)).toBe(false);
    }, t);

    it('a signal aborted while it renders rejects `cancelled` and leaves nothing at `out`', async () => {
      const c = await make('cancel-during');
      const out = join(c.out, 'cancelled.mp4');
      const abort = new AbortController();
      const hooks = c.cancelDuring(abort);
      const e = await c.renderer.video({ workPolicy: c.workPolicy, plan: c.plan, out, root: c.root, ...(c.registry ? { registry: c.registry } : {}), signal: abort.signal, onProgress: hooks.onProgress }).catch((x: unknown) => x);
      expect(abort.signal.aborted).toBe(true);
      expect(e).toBeInstanceOf(Error);
      expect(errorKindOf(e)).toBe('cancelled');
      expect(existsSync(out)).toBe(false);
    }, t);

    it('a render that cannot write at `out` rejects as a failure — not a cancel, not a full disk — and leaves the place as it was', async () => {
      const c = await make('failure');
      // `out` lies under a regular file: no renderer can write there.
      const blocker = join(c.out, 'a-file');
      await writeFile(blocker, 'in the way');
      const out = join(blocker, 'video.mp4');
      const e = await c.renderer.video({ workPolicy: c.workPolicy, plan: c.plan, out, root: c.root, ...(c.registry ? { registry: c.registry } : {}) }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(errorKindOf(e)).not.toBe('cancelled');
      const failure = e as RendererFailure;
      expect(failure.diskFull).toBeUndefined();
      // What a failure may say beside its message has the port's shape (RendererFailure).
      expect(failure.renderWarnings === undefined || (Array.isArray(failure.renderWarnings) && failure.renderWarnings.every((w) => typeof w === 'string'))).toBe(true);
      // The render path has its own name (`renderPath`), and is one only as an object; `path`, when the failure has
      // one, is a system error's file (a string), never a render path.
      const tried: unknown = failure.renderPath;
      expect(tried === undefined || (typeof tried === 'object' && tried !== null && said(failure.renderPath?.gl.used) && said(failure.renderPath?.encoder.used))).toBe(true);
      const file: unknown = (failure as { path?: unknown }).path;
      expect(file === undefined || typeof file === 'string').toBe(true);
      expect(await readFile(blocker, 'utf8')).toBe('in the way');
    }, t);

    it('stills come back in the order asked, one PNG each, with the warnings handed over', async () => {
      const c = await make('stills');
      const frames = [{ frame: 2, out: join(c.out, 'b.png') }, { frame: 0, out: join(c.out, 'a.png') }];
      let warnings: string[] | undefined;
      const files = await c.renderer.stills({ workPolicy: c.workPolicy, plan: c.plan, frames, root: c.root, ...(c.registry ? { registry: c.registry } : {}), onWarnings: (w) => { warnings = w; } });
      expect(files).toEqual(frames.map((f) => f.out));
      for (const f of files) expect((await readFile(f)).subarray(0, 4)).toEqual(PNG);
      expect(Array.isArray(warnings)).toBe(true);
    }, t);

    it('a still outside the plan is refused as `invalid`, nothing written', async () => {
      const c = await make('stills-outside');
      for (const frame of [-1, c.plan.durationInFrames]) {
        const out = join(c.out, `outside-${frame}.png`);
        const e = await c.renderer.stills({ workPolicy: c.workPolicy, plan: c.plan, frames: [{ frame: 0, out: join(c.out, 'in.png') }, { frame, out }], root: c.root, ...(c.registry ? { registry: c.registry } : {}) }).catch((x: unknown) => x);
        expect(errorKindOf(e)).toBe('invalid');
        expect((e as Error).message).toBe(`frame ${frame} is outside the video (0–${c.plan.durationInFrames - 1})`);
        expect(existsSync(out)).toBe(false);
        expect(existsSync(join(c.out, 'in.png'))).toBe(false);
      }
    }, t);

    it.skipIf(!o.previews)('a preview bundle is named by its components; a session writes a PNG and a GIF until it is closed', async () => {
      const c = await make('previews');
      const { sets, spec, assets } = previewsOf(c);
      const one = await c.renderer.previews.bundle({ root: c.root, components: sets[0] });
      const again = await c.renderer.previews.bundle({ root: c.root, components: sets[0] });
      const other = await c.renderer.previews.bundle({ root: c.root, components: sets[1] });
      expect(again.hash).toBe(one.hash);
      expect(again.cached).toBe(true);
      expect(other.hash).not.toBe(one.hash);
      const session = await c.renderer.previews.open(one, { workPolicy: c.workPolicy, assets });
      const png = join(c.out, 'poster.png');
      const gif = join(c.out, 'loop.gif');
      await session.still(spec, png, 0.5);
      await session.gif(spec, gif, { scale: 0.25, everyNthFrame: 2, frames: [0, 3] });
      expect((await readFile(png)).subarray(0, 4)).toEqual(PNG);
      expect((await readFile(gif)).subarray(0, 3).toString('latin1')).toBe('GIF');
      expect(Array.isArray(session.warnings())).toBe(true);
      await session.close();
      await session.close();
      await expect(session.still(spec, join(c.out, 'late.png'), 0.5)).rejects.toThrow();
      expect(existsSync(join(c.out, 'late.png'))).toBe(false);
    }, t);

    it.skipIf(!o.previews)('a preview bundle of another renderer, and an aborted signal, are refused', async () => {
      const c = await make('previews-refused');
      const previews = previewsOf(c);
      const foreign = { hash: 'x', cached: false };
      await expect(c.renderer.previews.open(foreign, { workPolicy: c.workPolicy, assets: previews.assets })).rejects.toThrow();
      const abort = new AbortController();
      abort.abort();
      const e = await c.renderer.previews.bundle({ root: c.root, components: previews.sets[0], signal: abort.signal }).catch((x: unknown) => x);
      expect(errorKindOf(e)).toBe('cancelled');
    }, t);
  });
}
