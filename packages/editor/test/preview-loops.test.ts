/**
 * L4.7 preview sessions with an injected backend (no Remotion, no browser, no bundle): `renderComponentLoops` isolates
 * each component (one that throws while rendering, one whose spec cannot be built — the others are written, the
 * failures listed with their reason, a failed item's files removed), a full disk stops the session (from the renderer
 * or from the caller's writer: RenderDiskFullError, no further item), the 480 px fallback and "too large", a cancel
 * between items, `bundle: 'registry'` (two sessions over disjoint components ask for one bundle; `used` for two) and
 * `renderComponentPreviews` still failing as a whole on its first failure. Review fixes: progress counts failed items
 * (B M2); ⚑ one component of the registry bundle that does not compile or throws at module load fails alone (A M3 / B H1:
 * the others are rendered again with their own components); ⚑ a fresh renderer after a failed item (B M1).
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTemplate, fileFacts } from '@retake/core/io';
import type { LoadedTemplate } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { RenderCancelledError, RenderDiskFullError, bundleHash, isDiskFullError, renderComponentLoops, renderComponentPreviews } from '@retake/editor';
import type { BundleComponent, ComponentPreviewSpec, LoopItem, PreviewBackend, PreviewComponentTarget } from '@retake/editor';
import { REPO } from './render-helpers.js';
import { PERSON_POLICY } from '@retake/core';

let root: string;
let out: string;
let registry: ComponentRegistry;
let editorial: LoadedTemplate;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-preview-loops-'));
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  registry = await loadComponentRegistry({ root });
  editorial = await loadTemplate('editorial', root, { files: fileFacts(PERSON_POLICY) });
  out = join(root, 'out');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function target(id: string): PreviewComponentTarget {
  const i = registry.get(id);
  return { id, dir: i.dir, entry: i.entry, manifest: i.manifest };
}

/** A fresh output folder and the poster + loop files of `ids` in it. */
async function itemsOf(ids: string[], what: { poster?: boolean; loop?: boolean } = { poster: true, loop: true }): Promise<LoopItem[]> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  return ids.map((id) => ({
    target: target(id),
    ...(what.poster ? { poster: join(out, `${id.replace('/', '__')}.png`) } : {}),
    ...(what.loop ? { loop: join(out, `${id.replace('/', '__')}.gif`) } : {}),
  }));
}

interface Fake extends PreviewBackend {
  bundles: BundleComponent[][];
  calls: string[];
}

/**
 * A backend that writes small files instead of rendering: `fail(spec, what)` may throw (the component "throws"),
 * `gifBytes(width)` sizes the GIF.
 */
function fake(o: { fail?: (spec: ComponentPreviewSpec, what: 'still' | 'gif') => void; gifBytes?: (width: number) => number } = {}): Fake {
  const bundles: BundleComponent[][] = [];
  const calls: string[] = [];
  return {
    bundles,
    calls,
    async bundle({ components }) {
      bundles.push(components);
      return { serveUrl: join(root, 'no-bundle'), hash: await bundleHash(components), cached: false };
    },
    async open() {
      return {
        async still(spec, file) {
          calls.push(`still ${spec.main.id}`);
          o.fail?.(spec, 'still');
          await writeFile(file, Buffer.from('\x89PNG\r\n\x1a\nposter', 'binary'));
        },
        async gif(spec, file, g) {
          calls.push(`gif ${spec.main.id} ${Math.round(g.scale * spec.width)}`);
          o.fail?.(spec, 'gif');
          await writeFile(file, Buffer.alloc(o.gifBytes?.(Math.round(g.scale * spec.width)) ?? 1000, 0x47));
        },
        warnings: () => [],
        close: async () => undefined,
      };
    },
  };
}

describe('preview sessions (injected backend)', () => {
  it('one component that throws, one that cannot be built: the others are written, the failures listed', async () => {
    const items = await itemsOf(['studio/intro-stack', 'studio/card-title', 'studio/outro-stack']);
    // A workspace-like layout whose preview names a sample screen that does not exist: its spec cannot be built.
    const broken = target('studio/layout-card');
    items.splice(1, 0, { target: { ...broken, manifest: { ...broken.manifest, preview: { ...broken.manifest.preview, screen: 'watch' as never } } }, poster: join(out, 'broken.png'), loop: join(out, 'broken.gif') });
    const backend = fake({
      fail: (spec, what) => {
        if (spec.main.id === 'studio/card-title' && what === 'gif') throw new Error('<img src=x onerror=alert(1)> exploded');
      },
    });
    const seen: string[] = [];
    const progress: Array<[number, number]> = [];
    const r = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items, backend, onItem: (it) => void seen.push(it.id), onProgress: (n, of) => void progress.push([n, of]) });
    // Review B M2: every finished item counts, failed ones too — the job's progress reaches its total.
    expect(progress.at(-1)).toEqual([4, 4]);
    expect(progress.map((p) => p[0])).toEqual([1, 2, 3, 4]);
    expect(r.rendered.map((x) => x.id)).toEqual(['studio/intro-stack', 'studio/outro-stack']);
    expect(seen).toEqual(['studio/intro-stack', 'studio/outro-stack']);
    expect(r.failed.map((f) => f.id)).toEqual(['studio/layout-card', 'studio/card-title']);
    expect(r.failed[0].reason).toMatch(/^its preview could not be built: /);
    expect(r.failed[1].reason).toBe('its preview failed: <img src=x onerror=alert(1)> exploded');
    for (const id of ['studio__intro-stack', 'studio__outro-stack']) {
      expect(existsSync(join(out, `${id}.png`)), id).toBe(true);
      expect(existsSync(join(out, `${id}.gif`)), id).toBe(true);
    }
    // The failed item's poster rendered before its loop threw: nothing of it is left.
    expect(existsSync(join(out, 'studio__card-title.png'))).toBe(false);
    expect(existsSync(join(out, 'studio__card-title.gif'))).toBe(false);
    expect(r.rendered[0].poster).toMatchObject({ width: 960, height: 540, quantized: false });
    expect(r.rendered[0].loop).toMatchObject({ width: 640, height: 360, fps: 15, frames: 48, duration_s: 3.2 });
    expect(r.bundle).not.toBeNull();
  });

  it('a full disk stops the session at once — from the renderer or from the caller writing the entry', async () => {
    const ids = ['studio/intro-stack', 'studio/card-title', 'studio/outro-stack'];
    let items = await itemsOf(ids);
    const nospace = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    let backend = fake({
      fail: (spec, what) => {
        if (spec.main.id === 'studio/card-title' && what === 'gif') throw nospace;
      },
    });
    const err = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items, backend }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderDiskFullError);
    expect((err as Error).message).toMatch(/^the disk is full \(preview of studio\/card-title: ENOSPC/);
    expect(backend.calls.some((c) => c.includes('outro-stack'))).toBe(false);
    expect(existsSync(join(out, 'studio__intro-stack.gif'))).toBe(true);
    expect(existsSync(join(out, 'studio__card-title.png'))).toBe(false);

    // A Remotion / ffmpeg message without a code counts too.
    expect(isDiskFullError(new Error('ffmpeg: No space left on device'))).toBe(true);
    expect(isDiskFullError(new Error('a component exploded'))).toBe(false);

    items = await itemsOf(ids);
    backend = fake();
    const written: string[] = [];
    const err2 = await renderComponentLoops({ workPolicy: PERSON_POLICY,
      root,
      registry,
      template: editorial,
      items,
      backend,
      onItem: (it) => {
        if (it.id === 'studio/card-title') throw nospace;
        written.push(it.id);
      },
    }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(RenderDiskFullError);
    expect(written).toEqual(['studio/intro-stack']);
    expect(backend.calls.some((c) => c.includes('outro-stack'))).toBe(false);
  });

  it('a loop over 1.5 MB is rendered again at 480 px; still over: too large, no file', async () => {
    let items = await itemsOf(['studio/intro-stack'], { loop: true });
    let backend = fake({ gifBytes: (w) => (w === 640 ? 1_600_000 : 900_000) });
    let r = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items, backend });
    expect(backend.calls).toEqual(['gif studio/intro-stack 640', 'gif studio/intro-stack 480']);
    expect(r.rendered[0].loop).toMatchObject({ width: 480, height: 270, bytes: 900_000 });
    expect(r.rendered[0].poster).toBeUndefined();

    items = await itemsOf(['studio/intro-stack'], { loop: true });
    backend = fake({ gifBytes: () => 1_600_000 });
    r = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items, backend });
    expect(r.rendered[0].loop).toEqual({ too_large: true, bytes: 1_600_000 });
    expect(existsSync(items[0].loop!)).toBe(false);
    expect(r.failed).toEqual([]);
  });

  it('a transition loops its motion spec; its poster is the still', async () => {
    const items = await itemsOf(['studio/transition-fade-black']);
    const specs: ComponentPreviewSpec[] = [];
    const backend = fake({ fail: (spec) => void specs.push(spec) });
    const r = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items, backend });
    expect(specs.map((s) => [s.motion ?? null, s.durationInFrames])).toEqual([
      [null, 12],
      [{ lead: 18, tail: 30 }, 60],
    ]);
    expect(r.rendered[0].loop).toMatchObject({ frames: 30, duration_s: 2 });
  });

  it('a cancel stops before the next component', async () => {
    const items = await itemsOf(['studio/intro-stack', 'studio/card-title'], { loop: true });
    const stop = new AbortController();
    const backend = fake();
    const err = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items, backend, signal: stop.signal, onItem: () => stop.abort() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderCancelledError);
    expect(backend.calls).toEqual(['gif studio/intro-stack 640']);
  });

  it("bundle 'registry': two sessions over disjoint components ask for the same bundle ('used': two)", async () => {
    const a = ['studio/intro-stack'];
    const b = ['studio/overlay-callout'];
    const reg = fake();
    await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await itemsOf(a, { poster: true }), backend: reg, bundle: 'registry' });
    await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await itemsOf(b, { poster: true }), backend: reg, bundle: 'registry' });
    const [h1, h2] = await Promise.all(reg.bundles.map((c) => bundleHash(c)));
    expect(h1).toBe(h2);
    expect(reg.bundles[0].length).toBe(registry.list().length + 8);
    const used = fake();
    await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await itemsOf(a, { poster: true }), backend: used });
    await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await itemsOf(b, { poster: true }), backend: used });
    const [u1, u2] = await Promise.all(used.bundles.map((c) => bundleHash(c)));
    expect(u1).not.toBe(u2);
  });

  /**
   * A backend whose bundles know their components: `broken` in a bundle either fails its build (`syntax`) or makes every
   * render of that bundle's page throw (`load`: a module-load throw). `poison`: after a failure, the renderer refuses
   * everything (the leaked port of review B M1) — the session must open a fresh one.
   */
  function pageFake(o: { broken?: string; mode?: 'syntax' | 'load'; failOnce?: string; poison?: boolean }) {
    const bundles: string[][] = [];
    const life = { opens: 0, closes: 0 };
    const calls: string[] = [];
    let failedOnce = false;
    const backend: PreviewBackend = {
      async bundle({ components }) {
        const ids = components.map((c) => c.id);
        if (o.mode === 'syntax' && o.broken && ids.includes(o.broken)) throw new Error(`Module build failed (from ${root}/node_modules/x): Unexpected token`);
        bundles.push(ids);
        return { serveUrl: `bundle-${bundles.length - 1}`, hash: await bundleHash(components), cached: false };
      },
      async open({ serveUrl }) {
        life.opens++;
        const ids = bundles[Number(serveUrl.slice('bundle-'.length))];
        let poisoned = false;
        const render = async (spec: ComponentPreviewSpec, file: string, what: string, bytes: Buffer) => {
          calls.push(`${what} ${spec.main.id} @${serveUrl}`);
          if (poisoned) throw new Error('You specified port 57563 to be used for the HTTP server, but it is not available');
          if (o.mode === 'load' && o.broken && ids.includes(o.broken)) {
            if (o.poison) poisoned = true;
            throw new Error('boom at load');
          }
          if (o.failOnce === spec.main.id && !failedOnce) {
            failedOnce = true;
            if (o.poison) poisoned = true;
            throw new Error('select failed once');
          }
          await writeFile(file, bytes);
        };
        return {
          still: (spec, file) => render(spec, file, 'still', Buffer.from('\x89PNG\r\n\x1a\nposter', 'binary')),
          gif: (spec, file) => render(spec, file, 'gif', Buffer.alloc(1000, 0x47)),
          warnings: () => [],
          close: async () => void life.closes++,
        };
      },
    };
    return { backend, bundles, life, calls };
  }

  for (const mode of ['load', 'syntax'] as const) {
    it(`⚑ review A M3 / B H1, ${mode === 'load' ? 'a module-load throw' : 'a syntax error'} in one component of the registry bundle: the others are written, only it fails`, async () => {
      const broken = 'studio/overlay-callout';
      const ids = ['studio/intro-stack', 'studio/card-title', broken, 'studio/outro-stack'];
      const f = pageFake({ broken, mode, poison: true });
      const progress: Array<[number, number]> = [];
      const r = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await itemsOf(ids), backend: f.backend, bundle: 'registry', onProgress: (n, of) => void progress.push([n, of]) });
      expect(r.rendered.map((x) => x.id)).toEqual(['studio/intro-stack', 'studio/card-title', 'studio/outro-stack']);
      expect(r.failed.map((x) => x.id)).toEqual([broken]);
      expect(r.failed[0].reason).toMatch(mode === 'load' ? /^its preview failed: boom at load$/ : /^its preview could not be bundled: Module build failed/);
      for (const id of ['studio__intro-stack', 'studio__card-title', 'studio__outro-stack']) expect(existsSync(join(out, `${id}.gif`)), id).toBe(true);
      expect(existsSync(join(out, 'studio__overlay-callout.png'))).toBe(false);
      // Every item counted once, when it was settled.
      expect(progress.at(-1)).toEqual([4, 4]);
      expect(progress.map((p) => p[0])).toEqual([1, 2, 3, 4]);
      // The broken component's last bundle holds no other target: its failure is its own.
      const builtWith = f.bundles.filter((b) => b.includes(broken));
      if (mode === 'load') {
        expect(builtWith[0].length).toBe(registry.list().length + 8);
        expect(builtWith.at(-1)!.filter((x) => ids.includes(x))).toEqual([broken]);
      } else expect(builtWith).toEqual([]);
    });
  }

  it('⚑ review B M1: after an item fails, the next one runs in a freshly opened renderer (a leaked port fails nothing else)', async () => {
    const f = pageFake({ failOnce: 'studio/card-title', poison: true });
    const r = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await itemsOf(['studio/intro-stack', 'studio/card-title', 'studio/outro-stack'], { poster: true }), backend: f.backend });
    expect(r.rendered.map((x) => x.id)).toEqual(['studio/intro-stack', 'studio/outro-stack']);
    expect(r.failed).toEqual([{ id: 'studio/card-title', reason: 'its preview failed: select failed once' }]);
    expect(f.life).toEqual({ opens: 2, closes: 2 });
    // In registry mode the failed item is tried again alone (bundle of its own components) and then renders.
    const g = pageFake({ failOnce: 'studio/card-title', poison: true });
    const r2 = await renderComponentLoops({ workPolicy: PERSON_POLICY, root, registry, template: editorial, items: await itemsOf(['studio/intro-stack', 'studio/card-title', 'studio/outro-stack'], { poster: true }), backend: g.backend, bundle: 'registry' });
    expect(r2.rendered.map((x) => x.id)).toEqual(['studio/intro-stack', 'studio/card-title', 'studio/outro-stack']);
    expect(r2.failed).toEqual([]);
  });

  it('renderComponentPreviews still fails as a whole on its first failure', async () => {
    const backend = fake({
      fail: (spec) => {
        if (spec.main.id === 'studio/card-title') throw new Error('boom');
      },
    });
    await rm(out, { recursive: true, force: true });
    const targets = ['studio/intro-stack', 'studio/card-title', 'studio/outro-stack'].map(target);
    await expect(renderComponentPreviews({ workPolicy: PERSON_POLICY, root, registry, template: editorial, targets, outDir: out, backend })).rejects.toThrow(/^preview of studio\/card-title: boom$/);
    expect(backend.calls).toEqual(['still studio/intro-stack', 'still studio/card-title']);
    const ok = await renderComponentPreviews({ workPolicy: PERSON_POLICY, root, registry, template: editorial, targets: [target('studio/intro-stack')], outDir: out, backend: fake() });
    expect(ok[0].file).toBe(join(out, 'studio', 'intro-stack.png'));
  });
});

describe('the README of a component preview', () => {
  /** A copy of a built-in component in a folder of its own (`base`), its README as the author wrote it. */
  async function copyOf(id: string, base: string): Promise<PreviewComponentTarget> {
    const t = target(id);
    const dir = join(base, id.replace('/', '__'));
    await rm(dir, { recursive: true, force: true });
    await cp(t.dir, dir, { recursive: true });
    await writeFile(join(dir, 'README.md'), '# Mine\n\nThe author\'s words.\n');
    return { ...t, dir, entry: join(dir, t.entry.slice(t.dir.length + 1)) };
  }

  it('under the writer\'s folder: written through it (the project store), merged into the README as read; elsewhere: written directly', async () => {
    const components = join(root, 'components');
    const inside = await copyOf('studio/intro-stack', components);
    const outside = await copyOf('studio/intro-stack', join(root, 'elsewhere'));
    const writes: Array<{ file: string; text: string; previous: string | null }> = [];
    const readmes = { root: components, write: async (file: string, text: string, previous: string | null) => void writes.push({ file, text, previous }) };
    const [a] = await renderComponentPreviews({ root, registry, template: editorial, targets: [inside], backend: fake(), readmes, workPolicy: PERSON_POLICY });
    expect(writes).toHaveLength(1);
    expect(writes[0].file).toBe(join(inside.dir, 'README.md'));
    expect(writes[0].previous).toBe('# Mine\n\nThe author\'s words.\n');
    expect(writes[0].text).toMatch(/Regenerate the preview and this block with `retake components preview studio\/intro-stack`/);
    expect(writes[0].text).toContain("The author's words.");
    expect(a.readme).toBe(join(inside.dir, 'README.md'));
    // The writer writes: nothing else did.
    expect(await readFile(join(inside.dir, 'README.md'), 'utf8')).toBe('# Mine\n\nThe author\'s words.\n');
    const [b] = await renderComponentPreviews({ root, registry, template: editorial, targets: [outside], backend: fake(), readmes, workPolicy: PERSON_POLICY });
    expect(writes).toHaveLength(1);
    expect(b.readme).toBe(join(outside.dir, 'README.md'));
    expect(await readFile(join(outside.dir, 'README.md'), 'utf8')).toMatch(/Regenerate the preview and this block[\s\S]*The author's words\./);
    // No README yet: the writer is told so (null: created, never over one made in between), not "unknown".
    await rm(join(inside.dir, 'README.md'));
    await renderComponentPreviews({ root, registry, template: editorial, targets: [inside], backend: fake(), readmes, workPolicy: PERSON_POLICY });
    expect(writes).toHaveLength(2);
    expect(writes[1].previous).toBeNull();
    expect(writes[1].text).toMatch(/Regenerate the preview and this block/);
  });

  it('a README the writer refuses: the error says the image and preview.json were written (they are), the README not', async () => {
    const components = join(root, 'components');
    const inside = await copyOf('studio/intro-stack', components);
    const readmes = {
      root: components,
      write: async () => {
        throw new Error(`${join(inside.dir, 'README.md')} leads out of the components folder (a symbolic link): not written`);
      },
    };
    await rm(join(inside.dir, 'preview.png'), { force: true });
    await rm(join(inside.dir, 'preview.json'), { force: true });
    await expect(renderComponentPreviews({ root, registry, template: editorial, targets: [inside], backend: fake(), readmes, workPolicy: PERSON_POLICY })).rejects.toThrow(
      `preview of studio/intro-stack: its preview.png and preview.json were written, its README.md was not — ${join(inside.dir, 'README.md')} leads out of the components folder (a symbolic link): not written`,
    );
    expect([existsSync(join(inside.dir, 'preview.png')), existsSync(join(inside.dir, 'preview.json'))]).toEqual([true, true]);
    expect(await readFile(join(inside.dir, 'README.md'), 'utf8')).toBe('# Mine\n\nThe author\'s words.\n');
  });
});
