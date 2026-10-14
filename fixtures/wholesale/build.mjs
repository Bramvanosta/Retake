#!/usr/bin/env node
// Bundles both SPAs (console + shop) with esbuild into public/build/ (git-ignored).
// Usage: node build.mjs [--dev]   (--dev: no minification)
// esbuild is imported when a build runs, and where the bundle lives / whether it is fresh is bundle.mjs's (no npm
// import): the server needs no npm package at run time.

import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { OUT_DIR, ROOT, STAMP } from './bundle.mjs';

export { OUT_DIR, ROOT, bundleState, bundleVersion } from './bundle.mjs';

const ENTRIES = { console: 'src/console/main.jsx', shop: 'src/shop/main.jsx' };

/**
 * @param {{ minify?: boolean }} [opts]
 * @returns {Promise<{ version: string, ms: number, files: string[] }>}
 */
export async function build({ minify = true } = {}) {
  const started = Date.now();
  const esbuild = await import('esbuild');
  await rm(OUT_DIR, { recursive: true, force: true });
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ENTRIES,
    outdir: OUT_DIR,
    bundle: true,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    minify,
    sourcemap: 'linked',
    target: ['chrome120', 'safari17', 'firefox120'],
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
  });
  for (const w of result.warnings) console.warn(`[northfield build] ${w.text}`);
  const files = Object.keys(result.metafile.outputs).map((f) => f.replace(/^public\/build\//, ''));
  const version = Date.now().toString(36);
  await writeFile(STAMP, JSON.stringify({ version, built_at: new Date().toISOString(), files }, null, 2));
  return { version, ms: Date.now() - started, files };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { ms, files } = await build({ minify: !process.argv.includes('--dev') });
    console.log(`Built ${files.filter((f) => !f.endsWith('.map')).length} files into public/build in ${ms} ms`);
  } catch (err) {
    console.error(`Build failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
