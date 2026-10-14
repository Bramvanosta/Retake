// Where the UI bundle (public/build/, written by build.mjs) lives and whether it is up to date. No npm import: the
// server reads these without esbuild (build.mjs is only loaded when a build is needed), so the Docker image of the
// fixture (Dockerfile) runs with Node alone and a bundle built on the host.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(ROOT, 'public', 'build');
export const STAMP = join(OUT_DIR, 'build.json');
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
