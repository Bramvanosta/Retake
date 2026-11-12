/**
 * L7.2 a workspace component keeps importing the renderer library directly, and it is the same library the kit
 * re-exports: one component reads the frame from `remotion` and from `@retake/components/kit` and paints what it
 * found — green when both give the same frame and it is not frame 0, red when they differ, blue at frame 0. A real
 * preview (validated, compiled, bundled, rendered), one pixel read. Needs ffmpeg/ffprobe and a headless shell.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTemplate, fileFacts } from '@retake/core/io';
import { PERSON_POLICY } from '@retake/core';
import { createComponent, loadComponentRegistry, validateComponentDir } from '@retake/components';
import { renderComponentPreviews } from '@retake/editor';
import { REPO, SHARED_CACHE, hasTool, pixelAt } from './render-helpers.js';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;

const plainWrite = async (file: string, text: string): Promise<void> => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text);
};

const TWO_FRAMES = `import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { useCurrentFrame as kitFrame } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

/** Paints what the two frame hooks say: the library's own and the kit's. */
export default function TwoFrames(_props: ComponentProps) {
  const a = useCurrentFrame();
  const b = kitFrame();
  const backgroundColor = a !== b ? 'rgb(255, 0, 0)' : a === 0 ? 'rgb(0, 0, 255)' : 'rgb(0, 255, 0)';
  return <AbsoluteFill style={{ backgroundColor }} />;
}
`;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-user-component-'));
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!canRender)('L7.2 a workspace component importing the renderer library directly', () => {
  it(
    'validates, bundles and renders; the frame it reads from `remotion` is the frame the kit gives (one library in the bundle)',
    async () => {
      const created = await createComponent(root, { write: plainWrite, id: 'acme/two-frames', kind: 'card', description: 'Reads the frame twice.' });
      await writeFile(created.entry, TWO_FRAMES);
      const checked = await validateComponentDir(created.dir);
      expect(checked.issues.filter((i) => i.severity === 'error')).toEqual([]);
      const registry = await loadComponentRegistry({ root });
      const template = await loadTemplate('editorial', root, { files: fileFacts(PERSON_POLICY) });
      const outDir = join(root, 'out');
      const [p] = await renderComponentPreviews({
        workPolicy: PERSON_POLICY,
        root,
        registry,
        template,
        targets: [{ id: 'acme/two-frames', dir: created.dir, entry: created.entry, manifest: created.manifest }],
        cacheDir: SHARED_CACHE,
        outDir,
      });
      expect(p.file).toBe(join(outDir, 'acme', 'two-frames.png'));
      const [r, g, b] = pixelAt(p.file, 0, 480, 270);
      expect({ r: r < 40, g: g > 215, b: b < 40 }, `pixel ${r},${g},${b}`).toEqual({ r: true, g: true, b: true });
    },
    LONG,
  );
});
