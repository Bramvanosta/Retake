/**
 * The renderer's contract on the product's adapter: the editor's driver, as the engine's composition roots make it
 * (editorRenderer). Real renders of a synthetic run, where ffmpeg and ffprobe are (like the editor's real-render
 * tests). The two preview cases are skipped here, and reported skipped (`previews: false`): this fixture has no
 * preview material, and the editor's previews are checked on the driver in the editor's own tests (render-driver.test.ts,
 * preview-loops.test.ts) — so the product's adapter passes seven of the suite's nine cases.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { editorRenderer, planWork } from '../src/index.js';
import type { PlannedRun } from '../src/index.js';
import { hasTool, linkSharedCache, renderWorkspace } from '../../editor/test/render-helpers.js';
import type { RenderWorkspace } from '../../editor/test/render-helpers.js';
import { rendererContract } from './renderer-contract.js';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;

let ws: RenderWorkspace;
let planned: PlannedRun;

beforeAll(async () => {
  if (!canRender) return;
  ws = await renderWorkspace();
  await linkSharedCache(ws.root);
  planned = await planWork({ workPolicy: PERSON_POLICY, project: ws.project, root: ws.root, run: 'latest', scenario: 'synthetic', overrides: { scale: 0.5 } });
}, LONG);
afterAll(async () => {
  await ws?.cleanup();
});

let n = 0;
rendererContract(
  'editor',
  async (name) => {
    const out = join(ws.root, 'contract', `${name}-${n++}`);
    await mkdir(out, { recursive: true });
    return {
      renderer: editorRenderer(),
      plan: planned.plan,
      workPolicy: PERSON_POLICY,
      root: ws.root,
      registry: planned.registry,
      out,
      cancelDuring: (abort) => ({
        onProgress: (p) => {
          if (p.stage === 'rendering') abort.abort();
        },
      }),
    };
  },
  { previews: false, timeout: LONG, skip: !canRender },
);
