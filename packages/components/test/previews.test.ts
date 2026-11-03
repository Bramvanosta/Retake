/**
 * Committed component previews (R-CMP-12/13/14): every built-in component (library/studio/* and the per-kind
 * scaffolds) has a generated preview.png (960×540, editorial theme, ≤ 200 KB), a preview.json sidecar whose source hash
 * matches its sources (manifest + entry + local imports) and a README.md showing it. A component changed without
 * `retake components preview --all --stale` fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPONENT_KINDS } from '@retake/core';
import {
  LIBRARY_DIR,
  PREVIEW_FILE,
  PREVIEW_MAX_BYTES,
  PREVIEW_SIZE,
  PREVIEW_THEME,
  README_BEGIN,
  README_END,
  componentSourceFiles,
  componentSourceHash,
  mergePreviewReadme,
  parseManifest,
  pngSize,
  previewMoment,
  previewReadmeBlock,
  previewStatus,
  scaffoldDir,
} from '@retake/components';
import { tempDir, writeFiles } from './helpers.js';

const BUILTIN = [
  ...readdirSync(join(LIBRARY_DIR, 'studio')).map((n) => ({ id: `studio/${n}`, dir: join(LIBRARY_DIR, 'studio', n) })),
  ...COMPONENT_KINDS.map((k) => ({ id: `scaffolds/${k}`, dir: scaffoldDir(k) })),
];

describe('committed previews of the built-in components', () => {
  it('every built-in component and scaffold has a fresh preview.png (960×540, ≤ 200 KB, editorial theme), its sidecar and a README showing it', () => {
    expect(BUILTIN.length).toBe(49); // 41 studio/* (7 added in L2.9, 11 in L2.10, 2 in L2.11, 2 in L2.12) + 8 scaffolds
    const stale: string[] = [];
    for (const { id, dir } of BUILTIN) {
      const status = previewStatus(dir, { theme: PREVIEW_THEME });
      if (status.state !== 'fresh') {
        stale.push(`${id}: ${status.reason}`);
        continue;
      }
      const file = join(dir, PREVIEW_FILE);
      expect(pngSize(file), id).toEqual(PREVIEW_SIZE);
      expect(statSync(file).size, id).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
      expect(status.meta!.component, id).toBe(id);
      const manifest = parseManifest(readFileSync(join(dir, 'component.yaml'), 'utf8'), 'component.yaml').manifest!;
      expect(status.meta!.version, id).toBe(manifest.version);
      expect(status.meta!.at, id).toBe(previewMoment(manifest));
      const readme = readFileSync(join(dir, 'README.md'), 'utf8');
      expect(readme, id).toContain(README_BEGIN);
      expect(readme, id).toContain(`](${PREVIEW_FILE})`);
      expect(readme, id).toContain(`\`${id}\``);
      expect(readme, id).toContain(`# ${manifest.name}`);
    }
    expect(stale, 'stale previews: run `retake components preview --all --stale` (or --all) and commit them').toEqual([]);
  });
});

describe('preview bookkeeping', () => {
  it('the source files are the manifest, the entry and its local imports (recursively), not README or the preview', async () => {
    const ws = await tempDir();
    try {
      await writeFiles(ws.dir, {
        'acme/card/component.yaml': 'id: acme/card\nentry: main.tsx\n',
        'acme/card/main.tsx': "import { a } from './parts/a.js';\nimport type { T } from './types';\nexport default function C() { return a; }\n",
        'acme/card/parts/a.tsx': "export { b } from '../b.js';\nexport const a = 1;\n",
        'acme/card/b.ts': 'export const b = 2;\n',
        'acme/card/types.ts': 'export type T = number;\n',
        'acme/card/unused.tsx': 'export const z = 3;\n',
        'acme/card/README.md': '# notes\n',
        'acme/card/preview.png': 'x',
      });
      const dir = join(ws.dir, 'acme/card');
      expect(componentSourceFiles(dir)).toEqual(['b.ts', 'component.yaml', 'main.tsx', 'parts/a.tsx', 'types.ts']);
      const h1 = componentSourceHash(dir);
      await writeFile(join(dir, 'README.md'), '# other notes\n');
      await writeFile(join(dir, 'unused.tsx'), 'export const z = 4;\n');
      expect(componentSourceHash(dir)).toBe(h1);
      await writeFile(join(dir, 'b.ts'), 'export const b = 3;\n');
      expect(componentSourceHash(dir)).not.toBe(h1);
      // Missing preview → missing; a wrong sidecar → stale.
      expect(previewStatus(dir).state).toBe('missing');
      await writeFile(join(dir, 'preview.json'), JSON.stringify({ format: 1, source_hash: 'nope', theme: 'editorial' }));
      expect(previewStatus(dir)).toMatchObject({ state: 'stale' });
      await writeFile(join(dir, 'preview.json'), JSON.stringify({ format: 1, source_hash: componentSourceHash(dir), theme: 'motion' }));
      expect(previewStatus(dir).state).toBe('fresh');
      expect(previewStatus(dir, { theme: 'editorial' })).toMatchObject({ state: 'stale', reason: 'rendered with theme "motion", not "editorial"' });
    } finally {
      await ws.cleanup();
    }
  });

  it('the README block lists name, id, kind, the image, slots and params; an author README keeps its text', () => {
    const manifest = parseManifest(readFileSync(join(LIBRARY_DIR, 'studio', 'layout-browser', 'component.yaml'), 'utf8'), 'component.yaml').manifest!;
    const block = previewReadmeBlock(manifest, { theme: 'editorial', at: 1, screen: 'desktop' });
    expect(block.startsWith(README_BEGIN)).toBe(true);
    expect(block.endsWith(README_END)).toBe(true);
    expect(block).toContain('# Browser window');
    expect(block).toContain('`studio/layout-browser` · layout · v1.0.0');
    expect(block).toContain('](preview.png)');
    expect(block).toContain('| `screen` (required) | screen |');
    expect(block).toMatch(/\| `chrome` \| `auto` \\\| `light` \\\| `dark` \| auto \|/);
    expect(block).toContain('| `width` | number (600–1920) | 1560 |');
    const authored = '# My card\n\nNotes written by hand.\n';
    const merged = mergePreviewReadme(authored, block);
    expect(merged).toContain('Notes written by hand.');
    expect(merged.indexOf(README_BEGIN)).toBe(0);
    // Regenerating replaces the block only.
    const again = mergePreviewReadme(merged.replace('Browser window', 'Old name'), block);
    expect(again).toBe(merged);
    expect(mergePreviewReadme(undefined, block)).toBe(`${block}\n`);
  });

  it('the moment shown is the last preview.at (1 s by default)', () => {
    expect(previewMoment({ preview: { at: [0.3, 1.2, 2.8] } })).toBe(2.8);
    expect(previewMoment({})).toBe(1);
    expect(previewMoment({ duration: { default: 0.4 } })).toBe(0.2);
  });
});
