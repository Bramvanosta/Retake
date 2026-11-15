import type { LoadedTemplate, Template, TextStyle } from '@retake/core/theme';
import type { FontWeight, ThemeFontFace, ThemeTextStyle, ThemeTokens } from './types.js';

/** URLs of the template assets as served to the renderer / UI (file paths are not usable in a browser page). */
export interface ThemeUrls {
  logo?: string;
  wordmark?: string;
  /** Font URLs, in the order of the template's `fonts` (display, then each body file). */
  fonts?: { display?: string; body?: string[] };
}

/** CSS font-family names under which the host composition registers the template fonts. */
export function themeFontFamilies(templateName: string): { display: string; body: string } {
  const slug =
    templateName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'theme';
  return { display: `retake-${slug}-display`, body: `retake-${slug}-body` };
}

/** Width / height from which a logo is a wordmark when template.yaml does not say (`logo_kind`): 3:1. */
export const LOGO_WORDMARK_ASPECT = 3;

/**
 * A theme's logo kind: the `logo_kind` template.yaml names, else a wordmark when the logo is LOGO_WORDMARK_ASPECT times
 * wider than high or more (its declared size), else a mark (an unknown size included).
 */
export function resolveLogoKind(declared: 'mark' | 'wordmark' | undefined, aspect: number | undefined): 'mark' | 'wordmark' {
  if (declared !== undefined) return declared;
  return aspect !== undefined && aspect >= LOGO_WORDMARK_ASPECT ? 'wordmark' : 'mark';
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

/** The last part of a `/` path, trailing slashes ignored (POSIX `basename`, without node:path: this module is pure). */
function lastPart(file: string): string {
  const s = file.replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}

/**
 * A variable font's weight range written in its file name: the `wght<min>-<max>` token (each a hundred from 100 to 900,
 * min below max), optionally followed by Italic, ending the name — `fonts/body-wght200-800.woff2`,
 * `Brand_wght300-700Italic.ttf` (the name `retake theme create` gives a variable font's copy; a hand-made theme opts in
 * by naming its file that way). Null for any other name: a plain weight, a family word, a token elsewhere in the name.
 */
export function fontFileRange(file: string): { weight: [number, number]; italic: boolean } | null {
  const name = lastPart(file).replace(/\.[^.]+$/, '');
  const m = /(?:^|[-_])wght([1-9]00)-([1-9]00)(italic|oblique)?$/i.exec(name);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!(min < max)) return null;
  return { weight: [min, max], italic: m[3] !== undefined };
}

/**
 * Font weight and style from a font file name: a variable font's range first (fontFileRange, `body-wght200-800` →
 * [200, 800]), else a weight word ("Inter-SemiBold.ttf" → 600 normal; default 400).
 */
export function fontFileFace(file: string): { weight: FontWeight; style: 'normal' | 'italic' } {
  const range = fontFileRange(file);
  if (range) return { weight: range.weight, style: range.italic ? 'italic' : 'normal' };
  const name = lastPart(file)
    .replace(/\.[^.]+$/, '')
    .toLowerCase();
  const style = /italic|oblique/.test(name) ? 'italic' : 'normal';
  for (const [re, weight] of WEIGHTS) if (re.test(name)) return { weight, style };
  return { weight: 400, style };
}

/** A face's weight as a CSS `font-weight` descriptor: `"600"`, or a variable font's range `"200 800"`. */
export function fontWeightDescriptor(w: FontWeight): string {
  return typeof w === 'number' ? String(w) : `${w[0]} ${w[1]}`;
}

/** Whether a face of weight `w` (a number or a range) serves `weight`. */
export function weightCovers(w: FontWeight, weight: number): boolean {
  return typeof w === 'number' ? w === weight : weight >= w[0] && weight <= w[1];
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
 * colours, background, font family names (+ the font faces to register when font URLs are given), logo (with its
 * aspect and kind: template.yaml's `logo_kind`, else core resolveLogoKind's 3:1 rule), wordmark (image and/or the
 * brand name drawn as text), brand, cursor ripple colour, style bias, caption text styles,
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
  if (urls.logo) {
    // A mark stays `{url}` (as before logo kinds); a wordmark carries its kind and aspect (the kit sizes it by width).
    tokens.logo = { url: urls.logo };
    if (resolveLogoKind(t.logo_kind, loaded.assets.logo_aspect) === 'wordmark') {
      tokens.logo.kind = 'wordmark';
      if (loaded.assets.logo_aspect !== undefined) tokens.logo.aspect = loaded.assets.logo_aspect;
    }
  }
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
