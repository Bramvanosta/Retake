/**
 * Brand inputs of a new theme (L3.5, R-MCP-10): what `template_create_from_brand` / `retake theme create` take — a new
 * theme name, a base theme, hex colours, a logo, an optional wordmark and fonts, the brand's name and URL. Pure:
 * schemas and the syntax rules of file references; the engine (brand/files.ts) resolves references on disk (links,
 * agent-writable folders, the components folder) and checks the bytes; the components package derives the palette.
 *
 * A file reference (`BrandFileRef`) is a path relative to the workspace root (recommended folder: `<workspace>/brand/`)
 * or `site:<site_id>/<candidate>`, a logo candidate of a site extraction (template_from_site: a PNG the worker made).
 */
import { z } from 'zod';
import { PROJECT_SLUG_RE } from './project.js';
import { SITE_ID_RE, TEMPLATE_NAME_RE } from './jobs.js';

/** A new theme's name: lower-case (compared without case with the starters and the folders of templates_dir). */
export const THEME_NAME_RE = PROJECT_SLUG_RE;
export const THEME_NAME_MAX = 60;

/** `#rgb` or `#rrggbb` (normalised to lower-case `#rrggbb` by normalizeHex). */
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** One logo candidate of a site extraction (its id: SITE_ID_RE of jobs.ts). */
export const SITE_CANDIDATE_RE = /^logo-[1-9]$/;
const SITE_REF_RE = /^site:([^/]*)\/(.*)$/;

export const BRAND_REF_MAX = 300;
/** A logo or wordmark image file, at most (an SVG: engine brand/files.ts SVG_MAX_BYTES). A site candidate stays under it. */
export const BRAND_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** A raster logo's height, at least (px). A site candidate is never made lower. */
export const BRAND_IMAGE_MIN_HEIGHT = 64;

/** Body font files of a brand input, at most. */
export const BRAND_BODY_FONTS_MAX = 4;

/** `#abc` → `#aabbcc`, lower-case; anything else unchanged (the schema refuses it first). */
export function normalizeHex(color: string): string {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`;
  return c;
}

/** A parsed `site:<id>/<candidate>` reference, or null for a path. */
export function siteRef(ref: string): { site_id: string; candidate: string } | null {
  const m = SITE_REF_RE.exec(ref);
  return m ? { site_id: m[1], candidate: m[2] } : null;
}

/**
 * Why a brand file reference is refused by its syntax alone, or null (the engine then checks it on disk). A path is
 * relative to the workspace root: never absolute, `~`, a drive letter, a backslash, a NUL, an empty or `.` / `..`
 * segment, or a hidden one (`.retake/`, `.git/`… — hidden folders are tool or system folders).
 */
export function brandRefSyntaxProblem(ref: string): string | null {
  if (typeof ref !== 'string' || ref.length === 0) return 'an empty file reference';
  if (ref.length > BRAND_REF_MAX) return `a file reference longer than ${BRAND_REF_MAX} characters`;
  if (ref.includes('\0')) return 'a file reference with a NUL character';
  const site = siteRef(ref);
  if (site) {
    if (!SITE_ID_RE.test(site.site_id) || !SITE_CANDIDATE_RE.test(site.candidate)) {
      return `${ref}: a site reference is site:<site id>/logo-<n> (template_from_site lists them)`;
    }
    return null;
  }
  if (ref.startsWith('/') || ref.startsWith('~') || /^[A-Za-z]:/.test(ref)) return `${ref} is an absolute path: name a file relative to the workspace root (e.g. brand/logo.svg)`;
  if (ref.includes('\\')) return `${ref}: use "/" between folders (no backslash)`;
  for (const seg of ref.split('/')) {
    if (seg === '' || seg === '.') return `${ref}: an empty or "." folder in the path`;
    if (seg === '..') return `${ref} goes out with "..": name a file of the workspace (e.g. brand/logo.svg)`;
    if (seg.startsWith('.')) return `${ref} is in a hidden folder or file (${seg}): brand files live in a plain folder such as brand/`;
  }
  return null;
}

export const brandFileRefSchema = z
  .string()
  .min(1)
  .max(BRAND_REF_MAX)
  .superRefine((v, ctx) => {
    const p = brandRefSyntaxProblem(v);
    if (p) ctx.addIssue({ code: 'custom', message: p });
  })
  .describe('A file relative to the workspace root (e.g. brand/logo.svg), or site:<site id>/logo-<n> from template_from_site.');

export const hexColorSchema = z.string().regex(HEX_COLOR_RE, 'a hex colour: #rgb or #rrggbb (no names, rgb() or hsl())');

const fontRefOf = (ref: z.ZodType<string, string>) =>
  z.union([
    ref,
    z.strictObject({
      file: ref,
      weight: z.number().int().min(100).max(900).optional().describe('Weight of this file (default: read from the font, else its file name).'),
      italic: z.boolean().optional().describe('An italic face (default: read from the font, else its file name).'),
    }),
  ]);
export type BrandFontRef = string | { file: string; weight?: number; italic?: boolean };

export const BrandColorsSchema = z.strictObject({
  accent: hexColorSchema.describe('The brand colour: kicker, rules, clock hand, cursor ripple. Never changed: a failing contrast gives a suggestion.'),
  text: hexColorSchema.optional().describe('Titles and caption lines (default derived from the accent).'),
  paper: hexColorSchema.optional().describe('Background / paper (default derived; a dark paper makes a dark theme).'),
  muted: hexColorSchema.optional().describe('Taglines, url (default between text and paper).'),
  dark: hexColorSchema.optional().describe('Night tone of dark cards and interstitials (default derived).'),
});
export type BrandColors = z.output<typeof BrandColorsSchema>;

export const BrandBackgroundSchema = z.union([
  hexColorSchema,
  z.strictObject({ type: z.enum(['radial', 'linear']), from: hexColorSchema, to: hexColorSchema }),
]);
export type BrandBackground = z.output<typeof BrandBackgroundSchema>;

function brandInputSchema(ref: z.ZodType<string, string>) {
  const fontRef = fontRefOf(ref);
  return z.strictObject({
    name: z
      .string()
      .max(THEME_NAME_MAX)
      .regex(THEME_NAME_RE, 'a new theme name: lower-case letters, digits and "-" (e.g. acme), never a path')
      .describe('Name of the new theme (its folder in templates/): lower-case, not a starter\'s or an existing folder\'s.'),
    base: z.string().max(100).regex(TEMPLATE_NAME_RE, 'a theme name').optional().describe('Theme whose components, frame, captions, motion and durations are kept (default editorial).'),
    colors: BrandColorsSchema,
    background: BrandBackgroundSchema.optional().describe('A hex (solid) or {type: radial | linear, from, to} (default derived from the paper).'),
    adjust: z.boolean().optional().describe('Lift derived and given colours (never the accent) that miss a contrast threshold, each change reported (default true).'),
    logo: ref.describe('Logo: .svg, .png, .jpg or .webp.'),
    wordmark: ref.optional().describe('Wordmark image of the outro (default none: the brand name is drawn as text).'),
    fonts: z
      .strictObject({
        display: fontRef.optional().describe('Display font (titles): .ttf, .otf, .woff or .woff2 (default the base theme\'s).'),
        body: z.array(fontRef).min(1).max(BRAND_BODY_FONTS_MAX).optional().describe('Body font files, one per weight / style (default the base theme\'s).'),
      })
      .optional(),
    brand: z
      .strictObject({
        name: z.string().min(1).max(80).optional().describe('Brand name (drawn as text when there is no wordmark).'),
        url: z.string().min(1).max(120).optional().describe('Brand URL as shown in the outro, e.g. example.com.'),
      })
      .optional(),
    replace: z.boolean().optional().describe('Replace a theme this tool made under that name, only when nobody changed its files since.'),
  });
}

/** The input of a new theme from brand files through MCP (trust `mcp`): files are workspace references. */
export const BrandInputSchema = brandInputSchema(brandFileRefSchema);
/** The same typed by a human (`retake theme create`, trust `author`): a file may be any local path. */
export const AuthorBrandInputSchema = brandInputSchema(z.string().min(1).max(4096));
export type BrandInput = z.output<typeof BrandInputSchema>;

/** The file of a font reference. */
export function fontRefFile(f: BrandFontRef): string {
  return typeof f === 'string' ? f : f.file;
}
