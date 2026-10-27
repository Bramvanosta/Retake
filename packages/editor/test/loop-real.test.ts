/**
 * L4.7 looping previews rendered for real (Remotion, guarded, one whole-registry bundle in a temporary cache) —
 * gated slow (DEMO_STUDIO_TEST_SLOW=1): GIF89a 640×360 looping forever (NETSCAPE2.0, count 0) at 15 fps over the
 * spec's length, a poster beside it; a transition's loop opens on the outgoing scene (the theme layout's own first
 * frame) and ends on the settled card (the card's still); a workspace component that throws while rendering fails
 * alone. Review fixes: a component that throws at module load, then one that does not compile, in the registry bundle —
 * the others are rendered again with their own components, each fails alone (A M3 / B H1); a hidden import (a dot
 * folder) fails webpack's bundle (A H1). Needs ffmpeg and a headless shell; bundles in temporary caches, removed after.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTemplate } from '@demo-studio/core';
import { PREVIEW_SIZE, createComponent, loadComponentRegistry, pngSize } from '@demo-studio/components';
import { ensureBundle, renderComponentLoops, scaffoldComponents } from '@demo-studio/editor';
import type { LoopItem, PreviewComponentTarget } from '@demo-studio/editor';
import { REPO, hasTool } from './render-helpers.js';

const GATED = process.env.DEMO_STUDIO_TEST_SLOW === '1' && hasTool('ffmpeg');
const LONG = 600_000;

let root: string;

beforeAll(async () => {
  if (!GATED) return;
  root = await mkdtemp(join(tmpdir(), 'demo-studio-loop-real-'));
  await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A GIF's size, loop count and frames (delays in 1/100 s), read block by block. */
function gifInfo(file: string): { magic: string; width: number; height: number; loops: number | null; frames: number; delay_s: number } {
  const b = readFileSync(file);
  const magic = b.subarray(0, 6).toString('latin1');
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  let p = 13;
  if (b[10] & 0x80) p += 3 * 2 ** ((b[10] & 7) + 1);
  let loops: number | null = null;
  let frames = 0;
  let delay = 0;
  const skipSubBlocks = () => {
    while (b[p] !== 0) p += b[p] + 1;
    p++;
  };
  while (p < b.length && b[p] !== 0x3b) {
    if (b[p] === 0x21) {
      const label = b[p + 1];
      p += 2;
      if (label === 0xff && b.subarray(p + 1, p + 12).toString('latin1') === 'NETSCAPE2.0') loops = b.readUInt16LE(p + 12 + 2);
      if (label === 0xf9) delay += b.readUInt16LE(p + 2);
      skipSubBlocks();
    } else if (b[p] === 0x2c) {
      frames++;
      const flags = b[p + 9];
      p += 10;
      if (flags & 0x80) p += 3 * 2 ** ((flags & 7) + 1);
      p++; // LZW minimum code size
      skipSubBlocks();
    } else throw new Error(`unexpected GIF block 0x${b[p].toString(16)} at ${p}`);
  }
  return { magic, width, height, loops, frames, delay_s: delay / 100 };
}

/** Frame n of a GIF / the PNG, scaled to 32×18 RGB. */
function grid(file: string, n = 0): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),scale=32:18:flags=area,format=rgb24`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-']);
}

/** Mean absolute difference of two grids (0–255). */
function diff(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

describe.skipIf(!GATED)('looping previews rendered with Remotion (DEMO_STUDIO_TEST_SLOW=1)', () => {
  it(
    'GIF loops and posters in one guarded registry bundle; a transition from the scene to the card; a throwing component alone',
    async () => {
      const thrower = await createComponent(root, { id: 'acme/thrower', kind: 'card', description: 'A card that throws.' });
      await writeFile(thrower.entry, "export default function Thrower(): never {\n  throw new Error('thrower exploded');\n}\n");
      const registry = await loadComponentRegistry({ root });
      const editorial = await loadTemplate('editorial', root);
      const t = (id: string): PreviewComponentTarget => {
        const i = registry.get(id);
        return { id, dir: i.dir, entry: i.entry, manifest: i.manifest };
      };
      const f = (name: string) => join(root, name);
      const items: LoopItem[] = [
        { target: t('studio/intro-stack'), poster: f('intro.png'), loop: f('intro.gif') },
        { target: t('studio/transition-crossfade'), loop: f('xf.gif') },
        { target: t('studio/layout-card'), loop: f('layout.gif') },
        { target: { ...t('studio/card-title'), at: 2.4 }, poster: f('card.png') },
        { target: t('acme/thrower'), poster: f('thrower.png'), loop: f('thrower.gif') },
      ];
      const r = await renderComponentLoops({ root, registry, template: editorial, items, bundle: 'registry', network: 'guard', cacheDir: join(root, 'cache') });
      expect(r.failed.map((x) => x.id)).toEqual(['acme/thrower']);
      expect(r.failed[0].reason).toContain('thrower exploded');
      expect(r.rendered.map((x) => x.id)).toEqual(['studio/intro-stack', 'studio/transition-crossfade', 'studio/layout-card', 'studio/card-title']);
      expect(r.warnings).toEqual([]);

      const intro = gifInfo(f('intro.gif'));
      expect(intro).toMatchObject({ magic: 'GIF89a', width: 640, height: 360, loops: 0 });
      expect(intro.frames).toBeGreaterThan(40);
      expect(intro.frames).toBeLessThanOrEqual(48);
      expect(intro.delay_s).toBeCloseTo(3.2, 1);
      expect(pngSize(f('intro.png'))).toEqual(PREVIEW_SIZE);

      const xf = gifInfo(f('xf.gif'));
      expect(xf).toMatchObject({ magic: 'GIF89a', width: 640, height: 360, loops: 0 });
      expect(xf.delay_s).toBeCloseTo(2, 1);
      // Opens on the outgoing scene (the theme layout's own preview, frame 0), ends on the settled card.
      const first = grid(f('xf.gif'), 0);
      const last = grid(f('xf.gif'), xf.frames - 1);
      expect(diff(first, grid(f('layout.gif'), 0))).toBeLessThan(8);
      expect(diff(last, grid(f('card.png')))).toBeLessThan(8);
      expect(diff(first, last)).toBeGreaterThan(15);
    },
    LONG,
  );

  it(
    '⚑ review A M3 / B H1: a component throwing at module load, then one that does not compile — the others render, each fails alone; ⚑ A H1: the bundler refuses a hidden import',
    async () => {
      const ws = join(root, 'broken-ws');
      await mkdir(ws, { recursive: true });
      await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
      const cacheDir = join(ws, 'cache');
      const boom = await createComponent(ws, { id: 'acme/load-boom', kind: 'card', description: 'Throws while its module loads.' });
      await writeFile(boom.entry, "throw new Error('boom at load');\nexport default function Boom() {\n  return null;\n}\n");
      const editorial = await loadTemplate('editorial', ws);
      const run = async (ids: string[]) => {
        const registry = await loadComponentRegistry({ root: ws });
        const items: LoopItem[] = ids.map((id) => {
          const i = registry.get(id);
          return { target: { id, dir: i.dir, entry: i.entry, manifest: i.manifest }, poster: join(ws, `${id.replace('/', '__')}.png`) };
        });
        return renderComponentLoops({ root: ws, registry, template: editorial, items, bundle: 'registry', network: 'guard', cacheDir });
      };
      // Its module throws in the page every component of the registry bundle shares.
      const a = await run(['studio/intro-stack', 'acme/load-boom', 'studio/card-title']);
      expect(a.rendered.map((x) => x.id)).toEqual(['studio/intro-stack', 'studio/card-title']);
      expect(a.failed.map((x) => x.id)).toEqual(['acme/load-boom']);
      expect(a.failed[0].reason).toMatch(/^its preview failed: .*boom at load/);
      expect(pngSize(join(ws, 'studio__card-title.png'))).toEqual(PREVIEW_SIZE);

      // A syntax error: the registry bundle does not build at all.
      const syntax = await createComponent(ws, { id: 'acme/no-compile', kind: 'card', description: 'Does not compile.' });
      await writeFile(syntax.entry, 'export default function X( { return <div>; }\n');
      const b = await run(['studio/intro-stack', 'acme/no-compile']);
      expect(b.rendered.map((x) => x.id)).toEqual(['studio/intro-stack']);
      expect(b.failed.map((x) => x.id)).toEqual(['acme/no-compile']);
      expect(b.failed[0].reason).toMatch(/^its preview could not be bundled: /);

      // A hidden import (a dot folder the content hash skips): webpack's guard fails the bundle closed.
      const hidden = await createComponent(ws, { id: 'acme/hidden', kind: 'card', description: 'Imports a dot folder.' });
      await mkdir(join(hidden.dir, '.impl'), { recursive: true });
      await writeFile(join(hidden.dir, '.impl', 'code.ts'), "export const word = 'hidden';\n");
      await writeFile(hidden.entry, "import { word } from './.impl/code';\nexport default function H() {\n  return <div>{word}</div>;\n}\n");
      const reg = await loadComponentRegistry({ root: ws });
      const info = reg.get('acme/hidden');
      const components = [{ id: 'acme/hidden', kind: 'card' as const, dir: info.dir, entry: info.entry, defaults: {} }, ...(await scaffoldComponents())];
      await expect(ensureBundle({ root: ws, components, cacheDir })).rejects.toThrow(/acme\/hidden: import "\.impl\/code\.ts" reaches "\.impl" \(a dot entry\)/);
      await rm(cacheDir, { recursive: true, force: true });
    },
    LONG,
  );
});
