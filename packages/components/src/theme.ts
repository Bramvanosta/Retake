import { basename } from 'node:path';
import type { LoadedTemplate, Template, TextStyle } from '@demo-studio/core';
import type { ThemeFontFace, ThemeTextStyle, ThemeTokens } from './types.js';

/** URLs of the template assets as served to the renderer / UI (file paths are not usable in a browser page). */
export interface ThemeUrls {
  logo?: string;
  wordmark?: string;
  /** Font URLs, in the order of the template's `fonts` (display, then each body file). */
  fonts?: { display?: string; body?: string[] };
}

/** CSS font-family names under which the host composition registers the template fonts. */
export function themeFontFamilies(templateName: string): { display: string; body: string } {
  const slug = templateName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme';
  return { display: `ds-${slug}-display`, body: `ds-${slug}-body` };
}

const WEIGHTS: Array<[RegExp, number]> = [
  [/hairline|thin/, 100],
  [/extra-?light|ultra-?light/, 200],
  [/light/, 300],
  [/semi-?bold|demi-?bold/, 600],
  [/extra-?bold|ultra-?bold/, 800],
  [/black|heavy/, 900],
  [/bold/, 700],
  [/medium/, 500],
];

/** Font weight and style from a font file name ("Inter-SemiBold.ttf" → 600 normal; default 400). */
export function fontFileFace(file: string): { weight: number; style: 'normal' | 'italic' } {
  const name = basename(file).replace(/\.[^.]+$/, '').toLowerCase();
  const style = /italic|oblique/.test(name) ? 'italic' : 'normal';
  for (const [re, weight] of WEIGHTS) if (re.test(name)) return { weight, style };
  return { weight: 400, style };
}

function resolveColor(colors: Template['colors'], c: string | undefined, fallback: string): string {
  if (c === undefined) return fallback;
  return colors[c] ?? c;
}

function textStyle(t: Template, s: TextStyle, families: { display: string; body: string }): ThemeTextStyle {
  const out: ThemeTextStyle = {
    font: s.font === 'display' ? families.display : families.body,
    size: s.size,
    color: resolveColor(t.colors, s.color, t.colors.text),
  };
  if (s.weight !== undefined) out.weight = s.weight;
  if (s.uppercase !== undefined) out.uppercase = s.uppercase;
  if (s.letter_spacing !== undefined) out.letter_spacing = s.letter_spacing;
  return out;
}

/**
 * The tokens every component reads (`props.theme`), from a loaded template and the URLs its assets are served at:
 * colours, background, font family names (+ the font faces to register when font URLs are given), logo, wordmark
 * (image and/or the brand name drawn as text), brand, cursor ripple colour, style bias, caption text styles,
 * brandmark and motion easing. Pure.
 */
export function themeTokens(loaded: LoadedTemplate, urls: ThemeUrls = {}): ThemeTokens {
  const t = loaded.template;
  const families = themeFontFamilies(t.name ?? loaded.name);
  const brand: ThemeTokens['brand'] = {};
  if (t.brand?.name !== undefined) brand.name = t.brand.name;
  if (t.brand?.url !== undefined) brand.url = t.brand.url;
  const tokens: ThemeTokens = {
    name: t.name ?? loaded.name,
    colors: { ...t.colors },
    background: { ...t.background },
    fonts: families,
    brand,
    cursor: { ripple_color: t.cursor.ripple_color },
    style_bias: t.style_bias,
    captions: { kicker: textStyle(t, t.captions.kicker, families), line: textStyle(t, t.captions.line, families) },
    motion: { zoom_ease: [...t.motion.zoom_ease] as [number, number, number, number] },
  };
  if (t.brandmark) tokens.brandmark = { ...t.brandmark };
  if (urls.logo) tokens.logo = { url: urls.logo };
  if (urls.wordmark || brand.name) {
    tokens.wordmark = {};
    if (urls.wordmark) tokens.wordmark.url = urls.wordmark;
    if (brand.name) tokens.wordmark.text = brand.name;
  }
  const faces: ThemeFontFace[] = [];
  if (urls.fonts?.display) faces.push({ family: families.display, url: urls.fonts.display, ...fontFileFace(loaded.assets.display) });
  urls.fonts?.body?.forEach((url, i) => {
    const file = loaded.assets.body[i] ?? t.fonts.body[i] ?? '';
    if (url) faces.push({ family: families.body, url, ...fontFileFace(file) });
  });
  if (faces.length > 0) tokens.font_faces = faces;
  return tokens;
}
