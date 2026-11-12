/**
 * Multi-page scenes (L2.11): the `pages:` of a scene normalised (ids, environment pages, `open`, viewports). Pure;
 * shared by the validation, the runner and the editor.
 */
import { VIEWPORT_PRESETS, VIEWPORT_PRESET_NAMES } from './types.js';
import type { Scene, SceneCursor, ScenePageSpec, ScenePages, Step, ViewportPreset, ViewportSpec } from './types.js';

/** A viewport resolved to CSS px (`preset` when it came from one). */
export type ResolvedViewport = Required<Pick<ViewportSpec, 'width' | 'height'>> & { mobile: boolean; touch: boolean; preset?: ViewportPreset };

/** One page of a multi-page scene, as written, with its id and its path in the scenario (for positioned issues). */
export interface ScenePageEntry {
  id: string;
  spec: ScenePageSpec;
  /** Path of the entry under the scene: ['pages', <key or index>]. */
  path: Array<string | number>;
  /** The id was derived (list form without `id`). */
  derived: boolean;
}

/** A page of a multi-page scene, resolved for the runner. */
export interface ResolvedScenePage {
  id: string;
  /** Environment page key its relative URLs resolve against (undefined: none — `open` must be absolute). */
  page?: string;
  /** What to open at the scene start: a path relative to `page`, or an absolute URL (`absolute`). */
  open?: { url: string; absolute: boolean };
  viewport: ResolvedViewport;
  label?: string;
  cursor?: SceneCursor;
  /** The persona written on the page (L1.6; the runner binds every page from its static plan, core auth.ts). */
  persona?: string;
}

/** Whether a scene films several pages at the same time. */
export function isMultiPageScene(scene: Pick<Scene, 'pages'>): boolean {
  return scene.pages !== undefined;
}

/** `shop:/products` → {page: shop, path: /products} when `shop` is an environment page key; else null. */
export function splitPageOpen(open: string, envPages: readonly string[]): { page: string; path: string } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(open);
  if (!m || !envPages.includes(m[1])) return null;
  const path = m[2] === '' ? '/' : m[2];
  return { page: m[1], path };
}

/** A URL with a scheme (http:, https:, file:, about:…) and no environment page prefix. */
export function isAbsoluteUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(s);
}

/** The entries of `pages:` (map or list) with their ids: list items default to the environment key (+ `-<preset>`). */
export function scenePageEntries(pages: ScenePages | undefined): ScenePageEntry[] {
  if (pages === undefined || pages === null) return [];
  if (Array.isArray(pages)) {
    return pages.map((item, i) => {
      // A plain string: an environment page key, or the id of a page an earlier scene declared (it continues as it is).
      if (typeof item === 'string') return { id: item, spec: {}, path: ['pages', i], derived: true };
      const { id, ...spec } = item ?? {};
      if (typeof id === 'string' && id !== '') return { id, spec, path: ['pages', i], derived: false };
      const base = spec.page ?? (typeof spec.open === 'string' ? /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(spec.open)?.[1] : undefined) ?? `page${i + 1}`;
      const preset = typeof spec.viewport === 'string' && spec.viewport !== 'desktop' ? `-${spec.viewport}` : typeof spec.viewport === 'object' ? `-${i + 1}` : '';
      return { id: `${base}${preset}`, spec, path: ['pages', i], derived: true };
    });
  }
  return Object.entries(pages).map(([id, spec]) => ({ id, spec: spec ?? {}, path: ['pages', id], derived: false }));
}

/** A viewport preset or explicit size in CSS px; `desktop` (and the default) = the capture size. */
export function resolveViewport(v: ScenePageSpec['viewport'], capture: { width: number; height: number }): ResolvedViewport {
  if (v === undefined || v === 'desktop') return { width: capture.width, height: capture.height, mobile: false, touch: false, preset: 'desktop' };
  if (typeof v === 'string') {
    const p = VIEWPORT_PRESETS[v as Exclude<ViewportPreset, 'desktop'>];
    if (!p) throw new Error(`unknown viewport preset "${v}" (presets: ${VIEWPORT_PRESET_NAMES.join(', ')})`);
    return { width: p.width, height: p.height, mobile: p.mobile ?? false, touch: p.touch ?? false, preset: v };
  }
  return { width: v.width, height: v.height, mobile: v.mobile ?? false, touch: v.touch ?? v.mobile ?? false };
}

/** Whether a viewport is the capture size without mobile emulation (recorded like the main capture). */
export function isDesktopViewport(v: ResolvedViewport, capture: { width: number; height: number }): boolean {
  return v.width === capture.width && v.height === capture.height && !v.mobile && !v.touch;
}

/**
 * The pages of a multi-page scene resolved for a run: environment page, what to open, viewport. Throws on what the
 * validation reports as errors (unknown preset, a relative `open` without an environment page).
 */
export function resolveScenePages(
  scene: Pick<Scene, 'pages' | 'id'>,
  opts: {
    capture: { width: number; height: number };
    envPages: readonly string[];
    /** A page an earlier scene declared: what this scene inherits when it does not say (environment page, viewport, label). */
    known?: (id: string) => { page?: string; viewport?: ResolvedViewport; label?: string } | undefined;
  },
): ResolvedScenePage[] {
  return scenePageEntries(scene.pages).map((e) => {
    const s = e.spec;
    const prev = opts.known?.(e.id);
    let page = s.page ?? prev?.page ?? (opts.envPages.includes(e.id) ? e.id : undefined);
    let open: ResolvedScenePage['open'];
    if (typeof s.open === 'string') {
      const split = splitPageOpen(s.open, opts.envPages);
      if (split) {
        page = s.page ?? split.page;
        if (s.page !== undefined && s.page !== split.page) throw new Error(`scene ${scene.id}, page ${e.id}: \`page: ${s.page}\` and \`open: ${s.open}\` name two environment pages`);
        open = { url: split.path, absolute: false };
      } else if (isAbsoluteUrl(s.open)) open = { url: s.open, absolute: true };
      else {
        if (page === undefined)
          throw new Error(`scene ${scene.id}, page ${e.id}: \`open: ${s.open}\` is relative but the page names no environment page (add \`page:\` or write \`<page>:${s.open}\`)`);
        open = { url: s.open, absolute: false };
      }
    }
    const viewport = s.viewport === undefined && prev?.viewport ? { ...prev.viewport } : resolveViewport(s.viewport, opts.capture);
    const out: ResolvedScenePage = { id: e.id, viewport };
    if (page !== undefined) out.page = page;
    if (open) out.open = open;
    const label = s.label ?? prev?.label;
    if (label !== undefined) out.label = label;
    if (s.cursor !== undefined) out.cursor = s.cursor;
    if (s.persona !== undefined) out.persona = s.persona;
    return out;
  });
}

/** The page a step of a multi-page scene acts on: its `on`, else the scene's first page. */
export function stepPageOf(step: Pick<Step, 'on'>, pages: readonly { id: string }[]): string | undefined {
  return step.on ?? pages[0]?.id;
}
