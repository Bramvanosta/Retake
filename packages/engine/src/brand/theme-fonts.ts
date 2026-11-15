/** A new theme's fonts (create.ts): the brand's, sniffed and renamed by role and weight, else the base theme's. */
import { lstat, readFile } from 'node:fs/promises';
import { basename, extname, relative, sep } from 'node:path';
import { fontRefFile } from '@retake/core/theme';
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
  weight: number;
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
 * → 600 italic, "Brand_700" → 700) — so a word of the family ("Lighthouse", "Boldwick") never reads as a weight.
 * Null when there is no such token or it names no weight.
 */
export function fileNameFace(file: string): { weight: number; italic: boolean } | null {
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

function fontFace(info: FontInfo, ref: BrandFontRef): { weight: number; italic: boolean; from: ThemeFontView['weight_from']; warning?: string } {
  const given: { weight?: number; italic?: boolean } = typeof ref === 'string' ? {} : ref;
  const fromName = fileNameFace(fontRefFile(ref));
  const italic = given.italic ?? info.italic ?? fromName?.italic ?? false;
  if (given.weight !== undefined) return { weight: standardWeight(given.weight), italic, from: 'input' };
  if (info.weight !== undefined && info.weight >= 1 && info.weight <= 1000) return { weight: standardWeight(info.weight), italic, from: 'font' };
  // WOFF / WOFF2 (their OS/2 table is compressed): the style token of the file name, else regular — said either way.
  const file = fontRefFile(ref);
  if (!fromName)
    return { weight: 400, italic, from: 'file name', warning: `${file}: no weight in the file (${info.format.toUpperCase()}) nor in its name: 400 assumed — give {file, weight} to set it` };
  return {
    weight: standardWeight(fromName.weight),
    italic,
    from: 'file name',
    warning: `${file}: weight ${standardWeight(fromName.weight)}${italic ? ' italic' : ''} read from the file name (${info.format.toUpperCase()} files keep it compressed) — give {file, weight} if it is wrong`,
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
    const bytes = await readOwnThemeFile(abs, baseName);
    const info = sniffFont({ ref: `base:${baseName}/${relative(base.dir, abs).split(sep).join('/')}`, ext: extname(abs).toLowerCase(), bytes }, `${role} font of ${baseName}`);
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
    };
  };
  const given = input.fonts ?? {};
  const display = given.display !== undefined ? await planFont(given.display, 'display') : await baseFont(base.assets.display, 'display');
  fonts.push(display);
  const body: FontPlan[] = [];
  if (given.body !== undefined) for (const ref of given.body) body.push(await planFont(ref, 'body'));
  else for (const abs of base.assets.body) body.push(await baseFont(abs, 'body'));
  const seen = new Map<string, FontPlan>([[display.view.file, display]]);
  for (const b of body) {
    const prior = seen.get(b.view.file);
    if (prior && !(prior.view.weight_from === 'base' && b.view.weight_from === 'base' && prior.bytes.equals(b.bytes))) {
      throw new EngineError(
        'invalid',
        `two body fonts have the same weight and style (${b.view.weight}${b.view.italic ? ' italic' : ''}): ${prior.view.source} and ${b.view.source} — give each weight once`,
      );
    }
    seen.set(b.view.file, b);
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
      if (!body.some((b) => b.view.weight === w && !b.view.italic))
        warnings.push(`captions.${k} of ${baseName} uses the body font at weight ${w}, which no body file has: the browser synthesises it (give a body file of weight ${w})`);
    }
  }
  return { fonts, display, body };
}
