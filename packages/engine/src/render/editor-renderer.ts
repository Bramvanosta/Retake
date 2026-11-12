/**
 * The product's renderer: the editor's driver (its bundle, the render browser, the encoder and the probe) as the
 * engine's port. The editor is loaded through the engine's loader (lazy.ts), and this is the only place the editor's
 * driver is made: a composition root (the job process, the jobs worker, a shell's command run in process) calls
 * `editorRenderer()` and hands the port to the work.
 */
import type { PreviewBackend } from '@retake/editor';
import { editor } from '../lazy.js';
import type { Renderer } from './renderer.js';

/**
 * Made on first use, once — and again after a failure: a load or a build that failed is not kept, so the next request
 * tries afresh (a rejection cached here would fail every later render of the process for a fault that may have passed).
 */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => {
    if (!made) {
      const p = make();
      made = p;
      p.catch(() => {
        if (made === p) made = undefined;
      });
    }
    return made;
  };
}

/**
 * The editor's driver behind the port. Nothing is loaded before the first request (a capture-only worker never pays
 * for Remotion); the driver is made once and serves every request after it.
 */
export function editorRenderer(): Renderer {
  const driver = once(async () => (await editor()).createRenderer() satisfies Renderer);
  return {
    video: async (req) => (await driver()).video(req),
    stills: async (req) => (await driver()).stills(req),
    previews: {
      bundle: async (o) => (await driver()).previews.bundle(o),
      open: async (bundle, o) => (await driver()).previews.open(bundle, o),
    },
  };
}

/**
 * `renderer` with its previews drawn by a preview backend of the editor's instead (in-process tests of library
 * previews: a worker's `ports.renderer`, worker-ports.ts). The backend becomes the previews of a renderer here, so the
 * work is handed one renderer and nothing beside it.
 */
export function withPreviewBackend(renderer: Renderer, backend: PreviewBackend): Renderer {
  const previews = once(async () => (await editor()).previewDriver(backend) satisfies Renderer['previews']);
  return {
    video: (req) => renderer.video(req),
    stills: (req) => renderer.stills(req),
    previews: {
      bundle: async (o) => (await previews()).bundle(o),
      open: async (bundle, o) => (await previews()).open(bundle, o),
    },
  };
}
