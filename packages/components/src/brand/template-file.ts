/**
 * template.yaml of a theme made from brand inputs (L3.5): the base theme's file as written (its components, frame,
 * captions, durations, motion and style bias), with the brand's colours, background, cursor ripple, fonts, logo,
 * wordmark, brand and outro url put in, its name replaced and a header comment saying where it comes from. Pure: the
 * caller validates the text against the template schema (core parseTemplateYaml) before writing it.
 */
import { Document, isMap, isPair, isScalar, isSeq } from 'yaml';
import type { TemplateFile } from '@retake/core';
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
  /** YYYY-MM-DD, for the header comment. */
  date: string;
}

export interface ThemeFile {
  file: TemplateFile;
  yaml: string;
  /** Colour keys of the base kept as they were (extra keys its components may read). */
  kept_colors: string[];
}

const PALETTE_KEYS = ['accent', 'text', 'muted', 'paper', 'dark'];

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
  out.cursor = { ...(cursor ?? {}), ripple_color: p.ripple_color };
  const outro = out.outro as Record<string, unknown> | undefined;
  if (outro && 'url' in outro) {
    if (i.brand?.url !== undefined) outro.url = i.brand.url;
    else delete outro.url;
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];

  const doc = new Document(out);
  doc.commentBefore = [
    ` Retake theme "${i.name}", made from brand inputs on ${i.date} over the "${i.baseName}" theme`,
    ' (template_create_from_brand / retake theme create): colours from the palette rules, fonts and logo copied into',
    ' this folder (see LICENSES.md). Edit it freely — once a file of this folder changes, the tool no longer replaces it.',
  ].join('\n');
  // The starters' style: flow collections for short sections, block maps for colours, fonts and components.
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      if (!isPair(pair) || !isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      const v = pair.value;
      if (isSeq(v)) v.flow = true;
      else if (isMap(v)) {
        if (key === 'colors') continue;
        if (key === 'fonts' || key === 'components' || key === 'captions') {
          for (const sub of v.items) if (isPair(sub) && (isMap(sub.value) || isSeq(sub.value))) sub.value.flow = true;
        } else v.flow = true;
      }
    }
  }
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return { file: out as TemplateFile, yaml, kept_colors: Object.keys(extra) };
}
