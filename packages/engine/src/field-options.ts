/**
 * What the timeline may switch in one click (L4.5, R-UI-23; critique B7): for a field of the scenario's edit part (core
 * field-edits.ts FIELD_PATHS), the values offered — the theme's default first, then the frame styles or the
 * registry's components of that kind — each `usable` or disabled with why (components package `componentFit`: kind,
 * slots, params, pages, files); and the same check refusing a `set_field` the inspector would have shown disabled.
 */
import { fieldComponentKind, fieldKindOf } from '@retake/core/scenario';
import type { ComponentKind } from '@retake/core/model';
import type { FieldAt, FieldEdit, FieldValue } from '@retake/core/scenario';
import type { ComponentRegistry, ComponentUse } from '@retake/components';
import { components } from './components.js';

/** One value offered for a field: `value` null = the theme's default (the key removed). */
export interface FieldOption {
  value: FieldValue | null;
  label: string;
  usable: true | { why: string };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The frame styles a single-page scene takes, with their names. */
export const FRAME_STYLE_OPTIONS: ReadonlyArray<[string, string]> = [
  ['card', 'Card'],
  ['browser', 'Browser'],
  ['laptop', 'Laptop'],
  ['phone', 'Phone'],
  ['tablet', 'Tablet'],
  ['raw', 'Full screen'],
];
/** The multi-page frames (L2.11). */
export const MULTI_PAGE_OPTIONS: ReadonlyArray<[string, string]> = [
  ['split', 'Split screen'],
  ['pip', 'Picture in picture'],
];
export const TRANSITION_KIND_OPTIONS: ReadonlyArray<[string, string]> = [
  ['crossfade', 'Crossfade'],
  ['fade-black', 'Fade through black'],
  ['cut', 'Cut'],
];

/** The entry a field belongs to in a parsed scenario (the root for the top level), or undefined. */
export function entryOf(root: unknown, at: FieldAt): Obj | undefined {
  if (!isObj(root)) return undefined;
  if (at.entry === 'top') return root;
  const scenes = Array.isArray(root.scenes) ? root.scenes : [];
  return scenes.find((e, i): e is Obj => {
    if (!isObj(e)) return false;
    const type = e.card !== undefined ? 'card' : e.interstitial !== undefined ? 'interstitial' : 'scene';
    const id = typeof e.id === 'string' ? e.id : type === 'scene' ? undefined : `${type}-${i}`;
    return type === at.entry && id === at.id;
  });
}

/** Pages a scene films (its `pages`), 1 for a single-page scene. */
export function scenePages(scene: Obj | undefined): number {
  const p = scene?.pages;
  if (Array.isArray(p)) return Math.max(1, p.length);
  if (isObj(p)) return Math.max(1, Object.keys(p).length);
  return 1;
}

/** The video's capture scenes: how many, and how many film several pages. */
export function videoPages(root: unknown): { scenes: number; multi: number } {
  const scenes = isObj(root) && Array.isArray(root.scenes) ? root.scenes : [];
  let n = 0;
  let multi = 0;
  for (const e of scenes) {
    if (!isObj(e) || e.card !== undefined || e.interstitial !== undefined) continue;
    n++;
    if (scenePages(e) > 1) multi++;
  }
  return { scenes: n, multi };
}

const FILE_KEYS = ['video', 'image', 'lottie'] as const;

/** The use a component field switches, as the scenario writes it (slots, params, a user file). */
export function componentUseOf(entry: Obj | undefined, field: string): ComponentUse | undefined {
  const kind = fieldComponentKind(field);
  if (!kind) return undefined;
  if (kind === 'caption') return { kind };
  const spec = entry?.[kind];
  const s = isObj(spec) ? spec : {};
  return {
    kind,
    ...(isObj(s.slots) ? { slots: s.slots } : {}),
    ...(kind === 'interstitial' ? { named: ['text', 'kicker'] } : kind === 'intro' ? { named: ['title', 'kicker'] } : kind === 'outro' ? { named: ['tagline', 'url'] } : {}),
    ...(isObj(s.params) ? { params: s.params } : {}),
    ...(FILE_KEYS.some((k) => typeof s[k] === 'string') ? { file: true } : {}),
  };
}

/**
 * Why a `set_field` value does not fit (critique B7: the inspector shows it disabled with this reason), or null. Only
 * what needs the registry or the scenario is checked here (the value's kind and range: core fieldValueProblem).
 */
export function fieldFitProblem(registry: ComponentRegistry, componentFit: typeof import('@retake/components').componentFit, root: unknown, edit: Pick<FieldEdit, 'at' | 'field' | 'to'>): string | null {
  const to = edit.to;
  if (to === undefined || typeof to !== 'string') return null;
  const entry = entryOf(root, edit.at);
  const kind = fieldKindOf(edit.field);
  const fit = (id: string, use: ComponentUse) => {
    const r = componentFit(registry, id, use);
    return r.ok ? null : `${id} ${r.why.startsWith(id) ? r.why.slice(id.length).trimStart() : r.why}`;
  };
  if (kind === 'component') {
    const use = componentUseOf(entry, edit.field);
    return use ? fit(to, use) : null;
  }
  if (kind === 'frame') {
    const multiWord = to === 'split' || to === 'pip';
    const styleWord = FRAME_STYLE_OPTIONS.some(([v]) => v === to);
    if (edit.at.entry === 'top') {
      // The video's frame is every scene's without its own: a multi-page frame dresses the scenes that film several
      // pages (one-page scenes keep the theme's layout), a one-page style the others (review B: say when it changes none).
      const v = videoPages(root);
      if (multiWord) return v.multi > 0 ? null : `${to} shows several pages: no scene of this video films more than one`;
      const allMulti = v.scenes > 0 && v.multi === v.scenes;
      if (allMulti && styleWord) return 'every scene of this video films several pages: a one-page layout changes none of them (Split screen, Picture in picture, or a multi-page layout component)';
      return styleWord ? null : fit(to, { kind: 'layout', ...(allMulti ? { pages: v.multi > 0 ? 2 : 1 } : {}) });
    }
    const pages = scenePages(entry);
    if (multiWord) return pages > 1 ? null : `${to} shows several pages: this scene films one`;
    if (styleWord) return pages > 1 ? `${to} shows one page: this scene films ${pages} (split, pip or a multi-page layout)` : null;
    return fit(to, { kind: 'layout', pages });
  }
  if (kind === 'transition') {
    if (TRANSITION_KIND_OPTIONS.some(([v]) => v === to)) return null;
    return fit(to, { kind: 'transition' });
  }
  return null;
}

/**
 * The values the timeline offers for a field, the theme's default first: frame styles (or the multi-page frames) then
 * the layout components; transition kinds then transition components; for a component field, the components of its
 * kind. Each is usable or disabled with why. Fields of other kinds (speed, duration, the intro switch) have none.
 */
export async function fieldOptions(registry: ComponentRegistry, root: unknown, at: FieldAt, field: string): Promise<FieldOption[]> {
  const c = await components();
  const kind = fieldKindOf(field);
  const opt = (value: string, label: string): FieldOption => {
    const why = fieldFitProblem(registry, c.componentFit, root, { at, field, to: value });
    return { value, label, usable: why === null ? true : { why } };
  };
  const listed = (k: ComponentKind, skip: ReadonlySet<string> = new Set()) =>
    registry
      .list(k)
      .filter((i) => !skip.has(i.manifest.id))
      .map((i) => opt(i.manifest.id, i.manifest.name));
  const theme: FieldOption = { value: null, label: 'Theme default', usable: true };
  if (kind === 'frame') {
    const entry = entryOf(root, at);
    // A scene offers the frames of its page count; the video both (each option disabled with why when it fits no scene).
    const words = at.entry === 'scene' ? (scenePages(entry) > 1 ? MULTI_PAGE_OPTIONS : FRAME_STYLE_OPTIONS) : [...FRAME_STYLE_OPTIONS, ...MULTI_PAGE_OPTIONS];
    // A frame style is its built-in layout: listed once, by its name.
    const builtin = new Set(['studio/layout-card', 'studio/layout-browser', 'studio/layout-laptop', 'studio/layout-phone', 'studio/layout-tablet', 'studio/layout-raw', 'studio/layout-split', 'studio/layout-pip']);
    return [theme, ...words.map(([v, l]) => opt(v, l)), ...listed('layout', builtin)];
  }
  if (kind === 'transition') {
    const builtin = new Set(['studio/transition-crossfade', 'studio/transition-fade-black']);
    return [theme, ...TRANSITION_KIND_OPTIONS.map(([v, l]) => opt(v, l)), ...listed('transition', builtin)];
  }
  const ck = fieldComponentKind(field);
  if (kind === 'component' && ck) return [theme, ...listed(ck)];
  return [];
}
