/** A new theme's fonts (create.ts): the brand's, sniffed and renamed by role and weight, else the base theme's. */
import { lstat, readFile } from 'node:fs/promises';
import { basename, extname, relative, sep } from 'node:path';
import { fontFileRange, weightCovers } from '@retake/components/geometry';
import type { FontWeight } from '@retake/components/geometry';
import { fontRefFile, fontWeightRange } from '@retake/core/theme';
import type { BrandFontRef, BrandInput, LoadedTemplate } from '@retake/core/theme';
import type { componentCalls } from '../registries/component-calls.js';
import { EngineError } from '../errors.js';
import { fontCopyName, sniffFont, standardWeight } from './files.js';
import type { FontInfo, ResolvedBrandFile } from './files.js';

export interface ThemeFontView {
  /** The copy in the theme folder (relative). */
  file: string;
  role: 'display' | 'body';
  /** As given; for the base theme's fonts, `base:<theme>/<file>`. */
  source: string;
  format: string;
  /** One weight, or a variable font's range ([200, 800]: one face for every weight between). */
  weight: FontWeight;
  italic: boolean;
  /** Where the weight came from. */
  weight_from: 'input' | 'font' | 'file name' | 'base';
  licence_notes: string[];
}

/**
 * A base theme's own file, read to be copied into the new theme (its fonts, LICENSES.md): a regular file with one name
 * only — a symbolic or hard link would turn bytes from elsewhere into the new theme's own file.
 */
export async function readOwnThemeFile(abs: string, theme: string): Promise<Buffer> {
  const st = await lstat(abs);
  if (!st.isFile()) throw new EngineError('refused', `base theme ${theme}: ${basename(abs)} is not a regular file (a link?): a new theme copies only the base's own files`);
  if (st.nlink > 1) throw new EngineError('refused', `base theme ${theme}: ${basename(abs)} has another name (a hard link): a new theme copies only the base's own files`);
  return readFile(abs);
}

export interface FontPlan {
  view: ThemeFontView;
  bytes: Buffer;
  names?: FontInfo['names'];
  /** template_update: a base font taken from the theme's own copy. */
  reused?: boolean;
}

/** A weight in words: "600", or a range "200–800". */
export function weightWords(w: FontWeight): string {
  return typeof w === 'number' ? String(w) : `${w[0]}–${w[1]}`;
}

/** Whether two faces' weights meet: equal weights, a weight inside a range, two ranges sharing a weight (ends included). */
export function weightsOverlap(a: FontWeight, b: FontWeight): boolean {
  const [a0, a1] = typeof a === 'number' ? [a, a] : a;
  const [b0, b1] = typeof b === 'number' ? [b, b] : b;
  return a0 <= b1 && b0 <= a1;
}

const STYLE_WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  roman: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

/**
 * Weight and style from a font file name's style token — the part after its last "-" or "_" ("Brand-SemiBoldItalic"
 * → 600 italic, "Brand_700" → 700) — so a word of the family ("Lighthouse", "Boldwick") never reads as a weight; a
 * variable font's `wght<min>-<max>` token is its range. Null when there is no such token or it names no weight.
 */
export function fileNameFace(file: string): { weight: FontWeight; italic: boolean } | null {
  // A variable font's `wght<min>-<max>` token first (components fontFileRange: the one reader of it), never its max.
  const range = fontFileRange(file);
  if (range) return { weight: range.weight, italic: range.italic };
  const base = basename(file).replace(/\.[^.]+$/, '');
  const cut = Math.max(base.lastIndexOf('-'), base.lastIndexOf('_'));
  if (cut < 0) return null;
  const token = base.slice(cut + 1).toLowerCase();
  const italic = /(?:italic|oblique)$/.test(token);
  const word = token.replace(/(?:italic|oblique)$/, '');
  if (word === '') return italic ? { weight: 400, italic } : null;
  if (/^[1-9]00$/.test(word)) return { weight: Number(word), italic };
  const weight = STYLE_WEIGHTS[word];
  return weight === undefined ? null : { weight, italic };
}

/** A range's ends rounded to hundreds; invalid when they meet (a range of one weight is a static font: give that weight). */
function standardRange(r: [number, number], file: string): [number, number] {
  const out: [number, number] = [standardWeight(r[0]), standardWeight(r[1])];
  if (out[0] >= out[1]) throw new EngineError('invalid', `${file}: the weight range ${r[0]}–${r[1]} is one weight once rounded to hundreds (${out[0]}): give that weight`);
  return out;
}

function fontFace(info: FontInfo, ref: BrandFontRef): { weight: FontWeight; italic: boolean; from: ThemeFontView['weight_from']; warning?: string } {
  const given: { weight?: number | string; italic?: boolean } = typeof ref === 'string' ? {} : ref;
  const file = fontRefFile(ref);
  const fromName = fileNameFace(file);
  const italic = given.italic ?? info.italic ?? fromName?.italic ?? false;
  if (typeof given.weight === 'string') {
    const r = fontWeightRange(given.weight);
    if (!r) throw new EngineError('invalid', `${file}: weight "${given.weight}" is no range: "<min> <max>", e.g. "200 800"`);
    return { weight: standardRange(r, file), italic, from: 'input' };
  }
  if (given.weight !== undefined) return { weight: standardWeight(given.weight), italic, from: 'input' };
  // A variable TrueType / OpenType font: its wght axis (its OS/2 weight is only the default instance's).
  if (info.weight_range) return { weight: standardRange(info.weight_range, file), italic, from: 'font' };
  if (fromName && typeof fromName.weight !== 'number') return { weight: fromName.weight, italic, from: 'file name' };
  if (info.weight !== undefined && info.weight >= 1 && info.weight <= 1000) return { weight: standardWeight(info.weight), italic, from: 'font' };
  // WOFF / WOFF2 (their OS/2 table is compressed): the style token of the file name, else regular — said either way.
  if (!fromName || typeof fromName.weight !== 'number')
    return { weight: 400, italic, from: 'file name', warning: `${file}: no weight in the file (${info.format.toUpperCase()}) nor in its name: 400 assumed — give {file, weight} to set it` };
  const named = fromName.weight;
  return {
    weight: standardWeight(named),
    italic,
    from: 'file name',
    warning: `${file}: weight ${standardWeight(named)}${italic ? ' italic' : ''} read from the file name (${info.format.toUpperCase()} files keep it compressed) — give {file, weight} if it is wrong`,
  };
}

/**
 * The fonts of a new theme: the brand's (sniffed, renamed by role and weight), else the base's (copied as they are);
 * two body fonts of one face refused; a caption weight no body file has warned.
 */
export async function planThemeFonts(o: {
  input: BrandInput;
  base: LoadedTemplate;
  baseName: string;
  lib: Awaited<ReturnType<typeof componentCalls>>;
  read: (ref: string, kind: 'font') => Promise<ResolvedBrandFile>;
  warnings: string[];
  /** template_update: the theme's own copy of a base font (`base:<theme>/<file>`), else undefined. */
  reuseBase?: (source: string) => Buffer | undefined;
}): Promise<{ fonts: FontPlan[]; display: FontPlan; body: FontPlan[] }> {
  const { input, base, baseName, lib, read, warnings } = o;
  const fonts: FontPlan[] = [];
  const planFont = async (ref: BrandFontRef, role: 'display' | 'body'): Promise<FontPlan> => {
    const f = await read(fontRefFile(ref), 'font');
    const info = sniffFont(f, `${role} font`);
    const face = fontFace(info, ref);
    if (face.warning) warnings.push(`${role} font ${face.warning}`);
    const file = fontCopyName(role, face.weight, face.italic, f.ext);
    for (const note of info.licence_notes) warnings.push(`${role} font ${fontRefFile(ref)}: ${note} — check its licence before using it in videos`);
    return {
      view: { file, role, source: fontRefFile(ref), format: info.format, weight: face.weight, italic: face.italic, weight_from: face.from, licence_notes: info.licence_notes },
      bytes: f.bytes,
      names: info.names,
    };
  };
  const baseFont = async (abs: string, role: 'display' | 'body'): Promise<FontPlan> => {
    const source = `base:${baseName}/${relative(base.dir, abs).split(sep).join('/')}`;
    const own = o.reuseBase?.(source);
    const bytes = own ?? (await readOwnThemeFile(abs, baseName));
    const info = sniffFont({ ref: source, ext: extname(abs).toLowerCase(), bytes }, `${role} font of ${baseName}`);
    const face = lib.fontFileFace(abs);
    return {
      view: {
        file: `fonts/${basename(abs)}`,
        role,
        source: `base:${baseName}/${relative(base.dir, abs).split(sep).join('/')}`,
        format: info.format,
        weight: face.weight,
        italic: face.style === 'italic',
        weight_from: 'base',
        licence_notes: info.licence_notes,
      },
      bytes,
      ...(own ? { reused: true } : {}),
    };
  };
  const given = input.fonts ?? {};
  const display = given.display !== undefined ? await planFont(given.display, 'display') : await baseFont(base.assets.display, 'display');
  fonts.push(display);
  const body: FontPlan[] = [];
  if (given.body !== undefined) for (const ref of given.body) body.push(await planFont(ref, 'body'));
  else for (const abs of base.assets.body) body.push(await baseFont(abs, 'body'));
  const seen = new Map<string, FontPlan>([[display.view.file, display]]);
  const placed: FontPlan[] = [];
  for (const b of body) {
    const prior = seen.get(b.view.file);
    if (prior && !(prior.view.weight_from === 'base' && b.view.weight_from === 'base' && prior.bytes.equals(b.bytes))) {
      throw new EngineError(
        'invalid',
        `two body fonts have the same weight and style (${weightWords(b.view.weight)}${b.view.italic ? ' italic' : ''}): ${prior.view.source} and ${b.view.source} — give each weight once`,
      );
    }
    // A static weight inside a variable font's range of the same style, or two ranges that meet: two faces for one
    // weight. Two static faces keep the rule above (one copy name per weight and style): a base theme's files keep
    // their own names, and two that read as one weight (Inter-Regular, Inter-Text) are its business.
    const ranged = (p: FontPlan) => typeof p.view.weight !== 'number' || typeof b.view.weight !== 'number';
    const overlap = placed.find((p) => ranged(p) && p.view.italic === b.view.italic && p.view.file !== b.view.file && weightsOverlap(p.view.weight, b.view.weight));
    if (overlap) {
      throw new EngineError(
        'invalid',
        `two body fonts serve the same weight (${weightWords(overlap.view.weight)} and ${weightWords(b.view.weight)}${b.view.italic ? ', italic' : ''}): ${overlap.view.source} and ${b.view.source} — a variable font's range holds every weight between its ends`,
      );
    }
    seen.set(b.view.file, b);
    placed.push(b);
    fonts.push(b);
  }
  if (given.body !== undefined) {
    const caps = base.template.captions;
    for (const [k, s] of [
      ['kicker', caps.kicker],
      ['line', caps.line],
    ] as const) {
      if (s.font !== 'body') continue;
      const w = s.weight ?? 400;
      if (!body.some((b) => weightCovers(b.view.weight, w) && !b.view.italic))
        warnings.push(`captions.${k} of ${baseName} uses the body font at weight ${w}, which no body file has: the browser synthesises it (give a body file of weight ${w})`);
    }
  }
  return { fonts, display, body };
}
