/**
 * `capture.prewarm` (L5.7, R-FLD-27): before the take, every page the scenario opens is visited once off camera — in a
 * scratch tab of the browser that films it (its persona's), never recorded — so its code, fonts, images and data are
 * cached and the first visit is not filmed cold. The URLs are the scenes' `open`s (and their pages' in multi-page
 * scenes) and the `open` steps', templated as the take will template them; one that cannot be resolved yet (a value a
 * later step produces) is skipped, and so is one the take may not open (opens.ts). A page that changes data when it
 * loads (marks something read) does it here too.
 */
import { isCaptureScene, resolvePageUrl, resolveScenePages } from '@retake/core';
import type { Scenario, SceneEntry } from '@retake/core';
import { errorMessage, isCancelled } from './errors.js';
import type { Runtime } from './runtime.js';
import { wallNow } from './util.js';

/** A page to visit: the page id that films it (its persona's browser) and its absolute URL. */
export interface PrewarmTarget {
  page: string;
  url: string;
}

/** How long one visit may take (load), then how long it may wait for the network to be idle. */
const PREWARM_LOAD_MS = 20_000;
const PREWARM_IDLE_MS = 5_000;

/**
 * The pages a scenario opens, in order, without duplicates (pure). `template` returns a scene as the take templates it
 * (null when it cannot be yet); `resolve` turns a scene's `open` into an absolute URL for a page id (null when it cannot).
 */
export function prewarmTargets(
  scenario: Pick<Scenario, 'scenes'>,
  opts: {
    envPages: Readonly<Record<string, string>>;
    capture: { width: number; height: number };
    template: (entry: SceneEntry, index: number) => SceneEntry | null;
    /** Scenes after this index are not run (`--until`). */
    lastScene?: number;
    /** Whether the take may open an absolute URL (opens.ts); one it may not is left out. Absent: http(s) URLs. */
    mayOpen?: (url: string) => boolean;
  },
): PrewarmTarget[] {
  const out: PrewarmTarget[] = [];
  const seen = new Set<string>();
  const add = (page: string, url: string | null) => {
    if (!url || !/^https?:/i.test(url)) return;
    if (opts.mayOpen && !opts.mayOpen(url)) return;
    const key = `${page} ${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ page, url });
  };
  const envKeys = Object.keys(opts.envPages);
  const resolve = (pathOrUrl: string, page: string | undefined): string | null => {
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathOrUrl)) return pathOrUrl;
      const prefixed = /^([A-Za-z_][A-Za-z0-9_-]*):(\/.*)?$/.exec(pathOrUrl);
      if (prefixed && opts.envPages[prefixed[1]] !== undefined) return resolvePageUrl(opts.envPages[prefixed[1]], prefixed[2] ?? '/');
      const base = page !== undefined ? opts.envPages[page] : undefined;
      return base !== undefined ? resolvePageUrl(base, pathOrUrl) : null;
    } catch {
      return null;
    }
  };
  let pageKey: string | undefined = envKeys[0];
  const declared = new Map<string, string | undefined>();
  scenario.scenes.forEach((raw, si) => {
    if (opts.lastScene !== undefined && si > opts.lastScene) return;
    if (!isCaptureScene(raw) || raw.skip) return;
    const scene = opts.template(raw, si);
    if (!scene || !isCaptureScene(scene)) return;
    if (scene.pages !== undefined) {
      let pages;
      try {
        pages = resolveScenePages(scene, { capture: opts.capture, envPages: envKeys, known: (id) => (declared.has(id) ? { page: declared.get(id) } : undefined) });
      } catch {
        return;
      }
      for (const p of pages) {
        declared.set(p.id, p.page);
        if (p.open) add(p.id, p.open.absolute ? p.open.url : resolve(p.open.url, p.page));
      }
      return;
    }
    pageKey = scene.page ?? pageKey;
    if (pageKey === undefined) return;
    if (scene.open !== undefined) add(pageKey, resolve(scene.open, pageKey));
    for (const step of scene.steps ?? []) {
      const arg = (step as { open?: unknown }).open;
      const url = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && typeof (arg as { url?: unknown }).url === 'string' ? (arg as { url: string }).url : undefined;
      const page = arg && typeof arg === 'object' && typeof (arg as { page?: unknown }).page === 'string' ? (arg as { page: string }).page : pageKey;
      if (url !== undefined) add(page, resolve(url, page));
    }
  });
  return out;
}

/** Visit the targets off camera (see the module comment). Never fails the run: a visit that fails is reported. */
export async function prewarmPages(rt: Runtime, targets: readonly PrewarmTarget[]): Promise<{ visited: number; ms: number; failed: string[] }> {
  const t0 = wallNow();
  const failed: string[] = [];
  let visited = 0;
  for (const t of targets) {
    if (rt.signal.aborted) break;
    let page;
    try {
      page = await rt.session.scratchPage(t.page);
      await page.goto(t.url, { waitUntil: 'load', timeout: PREWARM_LOAD_MS });
      await page.waitForLoadState('networkidle', { timeout: PREWARM_IDLE_MS }).catch(() => undefined);
      visited++;
    } catch (e) {
      if (isCancelled(e)) throw e;
      failed.push(`${t.url}: ${errorMessage(e).split('\n')[0]}`);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
  return { visited, ms: Math.round(wallNow() - t0), failed };
}
