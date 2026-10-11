#!/usr/bin/env node
// Bundles both SPAs (console + shop) with esbuild into public/build/ (git-ignored).
// Usage: node build.mjs [--dev]   (--dev: no minification)

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(ROOT, 'public', 'build');
const STAMP = join(OUT_DIR, 'build.json');
const ENTRIES = { console: 'src/console/main.jsx', shop: 'src/shop/main.jsx' };
/** Files/dirs whose changes make the bundle stale. */
const SOURCES = ['src', 'build.mjs', 'package.json'];
const EXPECTED = ['console.js', 'console.css', 'shop.js', 'shop.css'];

async function newestMtime(path) {
  const s = await stat(path);
  if (!s.isDirectory()) return s.mtimeMs;
  let newest = s.mtimeMs;
  for (const entry of await readdir(path)) newest = Math.max(newest, await newestMtime(join(path, entry)));
  return newest;
}

/** @returns {Promise<{ fresh: boolean, reason?: string }>} */
export async function bundleState() {
  if (!existsSync(STAMP)) return { fresh: false, reason: 'no bundle yet' };
  const missing = EXPECTED.find((f) => !existsSync(join(OUT_DIR, f)));
  if (missing) return { fresh: false, reason: `${missing} is missing` };
  const built = (await stat(STAMP)).mtimeMs;
  for (const src of SOURCES) {
    if ((await newestMtime(join(ROOT, src))) > built) return { fresh: false, reason: `${src} changed since the last build` };
  }
  return { fresh: true };
}

/** Reads the version written by the last build (used for cache busting). */
export async function bundleVersion() {
  try {
    return JSON.parse(await readFile(STAMP, 'utf8')).version;
  } catch {
    return 'dev';
  }
}

/**
 * @param {{ minify?: boolean }} [opts]
 * @returns {Promise<{ version: string, ms: number, files: string[] }>}
 */
export async function build({ minify = true } = {}) {
  const started = Date.now();
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
