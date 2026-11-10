/**
 * This package's render driver: Remotion in the render browser — renderPlan and the probe of the file it wrote,
 * renderStills, and the component previews on the workspace's bundle cache. What the engine hands its render work
 * (its Renderer port); the use cases here build the same one when they are handed none.
 */
import type { RenderDriver } from './driver-types.js';
import { REMOTION_PREVIEW_BACKEND, previewDriver } from './preview.js';
import { planDriver } from './render.js';
import type { RenderSeams } from './render.js';

export interface RenderDriverOptions {
  /** Bundle cache folder (default <root>/.retake/cache). */
  cacheDir?: string;
  /** Tests only (renderPlan `seams`; `gpuInfo` serves the stills and the previews too). */
  seams?: RenderSeams;
}

export function createRenderer(o: RenderDriverOptions = {}): RenderDriver {
  return {
    ...planDriver(o),
    previews: previewDriver(REMOTION_PREVIEW_BACKEND, { ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}), ...(o.seams?.gpuInfo ? { gpuInfo: o.seams.gpuInfo } : {}) }),
  };
}
