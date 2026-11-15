/**
 * The product's ComponentRegistries: the components package behind the port — its registry loader and its catalogue's
 * disk work (validation, scaffold, preview status, source files) — loaded through the composition package's loader on the first call
 * (lazy.ts `components`: esbuild comes with it). Each member calls the package's function with the same arguments: its
 * answers and its refusals are the package's, unchanged. Made by the composition package only (ports.ts productPorts).
 */
import type { ComponentRegistries } from '@retake/engine/composition';
import { components } from './lazy.js';

export function packageRegistries(): ComponentRegistries {
  return {
    load: async (root) => (await components()).loadComponentRegistry({ root }),
    catalogue: {
      validate: async (dir) => (await components()).validateComponentDir(dir),
      create: async (root, opts) => (await components()).createComponent(root, opts),
      previewStatus: async (dir, opts) => (await components()).previewStatus(dir, opts),
      sourceFiles: async (dir, manifest) => (await components()).componentSourceFiles(dir, manifest),
    },
  };
}
