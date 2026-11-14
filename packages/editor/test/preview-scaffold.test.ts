/**
 * L5.13a (review B M3): the previews' bundle components (editor render/preview.ts `previewBundleComponents`). A target
 * that is a package scaffold is bundled once, as the scaffold (flagged `scaffold: true`, so the bundle guard does not
 * ask which component its kit imports belong to); a workspace component that reuses a scaffold's id from another folder
 * keeps no flag — it stays under the guard's holder check (L4.7).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_FILE, parseManifest, scaffoldDir } from '@retake/components';
import type { ComponentManifest, ComponentRegistry } from '@retake/components';
import { previewBundleComponents } from '../src/render/preview.js';
import type { PreviewComponentTarget } from '../src/render/preview.js';

const manifestOf = (dir: string): ComponentManifest => parseManifest(readFileSync(join(dir, MANIFEST_FILE), 'utf8'), MANIFEST_FILE).manifest!;
const noRegistry = {} as ComponentRegistry;

describe("the previews' bundle and the package scaffolds (review B M3)", () => {
  it('a scaffold shown as a target is bundled once, flagged as the scaffold', async () => {
    const dir = scaffoldDir('layout');
    const manifest = manifestOf(dir);
    const target: PreviewComponentTarget = { id: 'scaffolds/layout', dir, entry: resolve(dir, manifest.entry ?? 'index.tsx'), manifest };
    const all = await previewBundleComponents([target], [], noRegistry);
    const layout = all.filter((c) => c.id === 'scaffolds/layout');
    expect(layout).toHaveLength(1);
    expect(layout[0]).toMatchObject({ dir, scaffold: true });
    // Every kind's scaffold is still there, each once.
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });

  it("a workspace component with a scaffold's id but another folder keeps no flag (the holder check applies)", async () => {
    const real = scaffoldDir('layout');
    const manifest = manifestOf(real);
    const dir = join('/scratch', 'ws', 'components', 'scaffolds', 'layout');
    const target: PreviewComponentTarget = { id: 'scaffolds/layout', dir, entry: join(dir, 'index.tsx'), manifest };
    const all = await previewBundleComponents([target], [], noRegistry);
    const mine = all.find((c) => c.id === 'scaffolds/layout' && c.dir === dir);
    expect(mine).toBeDefined();
    expect(mine?.scaffold).toBeUndefined();
  });
});
