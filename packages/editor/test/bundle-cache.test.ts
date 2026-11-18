/**
 * The render bundle cache's prune (bundle.ts pruneBundleCache): it keeps the BUNDLE_CACHE_KEEP most recently used
 * bundles, and never removes one used within BUNDLE_IN_USE_MS — a render in flight in another process (the jobs worker,
 * a Studio preview, a workspace whose cache is shared) serves its bundle for that long. Removing it under that render
 * failed it with nothing written (the slow MCP acceptances, when several files rendered at once on one cache).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUNDLE_CACHE_KEEP, BUNDLE_IN_USE_MS, pruneBundleCache } from '../src/render/bundle.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A cache folder holding `ages.length` complete bundles, bundle i last used `ages[i]` ms before `now`. */
async function cacheOf(ages: number[], now: number): Promise<{ cache: string; bundle: (i: number) => string }> {
  const cache = await mkdtemp(join(tmpdir(), 'retake-bundle-cache-'));
  dirs.push(cache);
  const bundle = (i: number) => join(cache, `remotion-${String(i).padStart(16, '0')}`);
  for (const [i, age] of ages.entries()) {
    await mkdir(join(bundle(i), 'bundle'), { recursive: true });
    await writeFile(join(bundle(i), 'bundle', 'index.html'), '<html></html>');
    await writeFile(join(bundle(i), 'bundle.json'), '{}\n');
    const t = new Date(now - age);
    await utimes(join(bundle(i), 'bundle.json'), t, t);
  }
  return { cache, bundle };
}

describe('the render bundle cache prune', () => {
  it('keeps the most recently used bundles and removes the older ones once they are out of use', async () => {
    const now = Date.now();
    const old = BUNDLE_IN_USE_MS + 60_000;
    // Bundle 0 was just made (kept by name), the others last used one minute apart, all out of use.
    const ages = [0, ...Array.from({ length: BUNDLE_CACHE_KEEP + 2 }, (_, i) => old + i * 60_000)];
    const { cache, bundle } = await cacheOf(ages, now);
    await pruneBundleCache(cache, bundle(0), now);
    const kept = ages.map((_, i) => existsSync(bundle(i)));
    expect(kept).toEqual(ages.map((_, i) => i < BUNDLE_CACHE_KEEP));
  });

  it('⚑ never removes a bundle used within BUNDLE_IN_USE_MS, however many there are (a render in flight serves it)', async () => {
    const now = Date.now();
    // More bundles than the cache keeps, every one used within the window: another process may be rendering from each.
    const ages = Array.from({ length: BUNDLE_CACHE_KEEP + 3 }, (_, i) => i * 60_000);
    expect(ages.at(-1)!).toBeLessThan(BUNDLE_IN_USE_MS);
    const { cache, bundle } = await cacheOf(ages, now);
    await pruneBundleCache(cache, bundle(0), now);
    expect(ages.map((_, i) => existsSync(bundle(i)))).toEqual(ages.map(() => true));
    // Once out of use, the extra ones go (the oldest first).
    const later = now + BUNDLE_IN_USE_MS + ages.at(-1)! + 1;
    await pruneBundleCache(cache, bundle(0), later);
    expect(ages.map((_, i) => existsSync(bundle(i)))).toEqual(ages.map((_, i) => i < BUNDLE_CACHE_KEEP));
  });
});
