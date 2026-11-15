/**
 * template.yaml of a theme made from brand inputs: the base theme's file as written (its components, frame,
 * captions, durations, motion and style bias), with the brand's colours, background, cursor (ripple, and its style
 * and size when given), fonts, logo (and its kind), wordmark, brand and outro url put in, the components given merged
 * over the base's (a legacy field the new entry contradicts removed, as the Studio's set_component does), its name
 * replaced and a header comment saying where it comes from. Pure: the caller validates the text against the template
 * schema (core parseTemplateYaml) and the registry before writing it.
 */
import { Document, isMap, isPair, isScalar, isSeq } from 'yaml';
import { isTemplateMediaRef, legacyContradictions, mergeTemplate, resolveThemeComponents, DEFAULT_TEMPLATE } from '@retake/core/theme';
import type { ComponentKind } from '@retake/core/model';
import type { TemplateFile } from '@retake/core/theme';
import type { Palette } from './palette.js';

export interface ThemeFileInput {
  /** The base theme's template.yaml as parsed (not merged over the defaults). */
  base: TemplateFile;
  baseName: string;
  name: string;
  palette: Palette;
  /** Files relative to the new theme folder. */
  logo: string;
  wordmark?: string;
  fonts: { display: string; body: string[] };
  brand?: { name?: string; url?: string };
  /** Written after `logo` when given (absent: the loader's 3:1 rule). */
  logo_kind?: 'mark' | 'wordmark';
  /** Per kind: the component to use — no id or the base's id: its params merged over the base's; another id: only these params. */
  components?: Partial<Record<ComponentKind, { id?: string; params?: Record<string, unknown> }>>;
  /** The cursor's style and size, over the base's (the ripple always follows the palette). */
  cursor?: { style?: 'arrow-dark' | 'arrow-light'; size?: number };
  /** YYYY-MM-DD, for the header comment. */
  date: string;
}

export interface ThemeFile {
  file: TemplateFile;
  yaml: string;
  /** Colour keys of the base kept as they were (extra keys its components may read). */
  kept_colors: string[];
  /** Legacy fields removed because a `components` entry given contradicts them ("intro.layout"…). */
  removed_legacy: string[];
}

/** A `components` entry the brand input asks for that cannot be made (a kind the base fills with a file, or none). */
export class ThemeComponentsError extends Error {
  override name = 'ThemeComponentsError';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The base's components with the brand input's entries merged in: for each kind given, the id (default the base's —
 * its written entry, else what its legacy fields map to) and the params (over the base's when the id is the same).
 * An entry of a single id stays a string, as the starters write it.
 */
function mergeComponents(base: TemplateFile, given: NonNullable<ThemeFileInput['components']>): Obj {
  const written = isObj(base.components) ? structuredClone(base.components as Obj) : {};
  const resolved = resolveThemeComponents(mergeTemplate(structuredClone(DEFAULT_TEMPLATE), base));
  for (const [kind, entry] of Object.entries(given) as Array<[ComponentKind, { id?: string; params?: Obj } | undefined]>) {
    if (!entry) continue;
    const cur = written[kind];
    let baseId: string | undefined;
    let baseParams: Obj = {};
    if (typeof cur === 'string') baseId = cur;
    else if (isObj(cur) && typeof cur.id === 'string' && !isTemplateMediaRef(cur as never)) {
      baseId = cur.id;
      baseParams = isObj(cur.params) ? cur.params : {};
    } else if (cur === undefined) {
      const r = resolved[kind];
      if (r && r.source !== 'theme') {
        baseId = r.id;
        baseParams = r.params;
      }
    }
    const id = entry.id ?? baseId;
    if (id === undefined) {
      throw new ThemeComponentsError(`components.${kind}: the base theme has no component for ${kind} (${cur === null ? 'none' : 'a file of its own'}): give an id`);
    }
    const params = id === baseId ? { ...baseParams, ...(entry.params ?? {}) } : { ...(entry.params ?? {}) };
    written[kind] = Object.keys(params).length > 0 ? { id, params } : id;
  }
  return written;
}

const PALETTE_KEYS = ['accent', 'text', 'muted', 'paper', 'dark'];

/** The starters' style: flow collections for short sections, block maps for colours, fonts and components. */
function applyStarterStyle(contents: unknown): void {
  if (!isMap(contents)) return;
  for (const pair of contents.items) {
    if (!isPair(pair) || !isScalar(pair.key)) continue;
    styleSection(String(pair.key.value), pair.value);
  }
}

/** One top-level section in the starters' style (colours as a block map; fonts, components and captions per entry). */
function styleSection(key: string, v: unknown): void {
  if (isSeq(v)) {
    v.flow = true;
    return;
  }
  if (!isMap(v) || key === 'colors') return;
  if (key === 'fonts' || key === 'components' || key === 'captions') {
    for (const sub of v.items) if (isPair(sub) && (isMap(sub.value) || isSeq(sub.value))) sub.value.flow = true;
  } else v.flow = true;
}

/** The new theme's template.yaml (object and text) over its base. */
export function generateThemeFile(i: ThemeFileInput): ThemeFile {
  const base = structuredClone(i.base) as Record<string, unknown>;
  const out: Record<string, unknown> = { version: 1, name: i.name };
  const p = i.palette;
  const extra = Object.fromEntries(Object.entries(i.base.colors ?? {}).filter(([k, v]) => !PALETTE_KEYS.includes(k) && typeof v === 'string'));
  const fields: Record<string, unknown> = {
    colors: { ...p.colors, ...extra },
    fonts: { display: i.fonts.display, body: [...i.fonts.body] },
    logo: i.logo,
    wordmark: i.wordmark,
    brand: i.brand && (i.brand.name !== undefined || i.brand.url !== undefined) ? { ...i.brand } : undefined,
    background: { ...p.background },
  };
  // Keep the base's key order; fields it lacks go after `name`, in the order above.
  const order = ['colors', 'fonts', 'logo', 'wordmark', 'brand', 'background'];
  for (const k of order) if (!(k in base)) out[k] = fields[k];
  for (const [k, v] of Object.entries(base)) {
    if (k === 'version' || k === 'name') continue;
    out[k] = order.includes(k) ? fields[k] : v;
  }
  const cursor = out.cursor as Record<string, unknown> | undefined;
  out.cursor = { ...(cursor ?? {}), ...(i.cursor?.style ? { style: i.cursor.style } : {}), ...(i.cursor?.size !== undefined ? { size: i.cursor.size } : {}), ripple_color: p.ripple_color };
  const removed: string[] = [];
  if (i.components && Object.keys(i.components).length > 0) {
    out.components = mergeComponents(i.base, i.components);
    // A legacy field the new entries contradict goes (the entry wins anyway; left, it would warn on every load).
    for (const c of legacyContradictions(out)) {
      for (const path of c.written) {
        const [section, key] = path.split('.');
        const sec = out[section];
        if (isObj(sec)) {
          delete sec[key];
          removed.push(path);
          if (Object.keys(sec).length === 0) delete out[section];
        }
      }
    }
  }
  const outro = out.outro as Record<string, unknown> | undefined;
  if (outro && 'url' in outro) {
    if (i.brand?.url !== undefined) outro.url = i.brand.url;
    else delete outro.url;
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  let file = out;
  if (i.logo_kind) {
    // Right after `logo` (the key it qualifies).
    file = {};
    for (const [k, v] of Object.entries(out)) {
      if (k === 'logo_kind') continue;
      file[k] = v;
      if (k === 'logo') file.logo_kind = i.logo_kind;
    }
  }

  const doc = new Document(file);
  doc.commentBefore = [
    ` Retake theme "${i.name}", made from brand inputs on ${i.date} over the "${i.baseName}" theme`,
    ' (template_create_from_brand / retake theme create): colours from the palette rules, fonts and logo copied into',
    ' this folder (see LICENSES.md). Edit it freely — once a file of this folder changes, the tool no longer replaces it.',
  ].join('\n');
  applyStarterStyle(doc.contents);
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return { file: file as TemplateFile, yaml, kept_colors: Object.keys(extra), removed_legacy: removed };
}
