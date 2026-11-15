/**
 * Brand inputs of a new theme (R-MCP-10): what `template_create_from_brand` / `retake theme create` take — a new
 * theme name, a base theme, hex colours, a logo, an optional wordmark and fonts, the brand's name and URL. Pure:
 * schemas and the syntax rules of file references; the engine (brand/files.ts) resolves references on disk (links,
 * agent-writable folders, the components folder) and checks the bytes; the components package derives the palette.
 *
 * A file reference (`BrandFileRef`) is a path relative to the workspace root (recommended folder: `<workspace>/brand/`)
 * or `site:<site_id>/<candidate>`, a logo candidate of a site extraction (template_from_site: a PNG the worker made).
 */
import { z } from 'zod';
import { SITE_ID_RE } from './id-grammar.js';
import { zNewThemeName, zThemeName } from './ids.js';
import { fontsourceRefProblem, isFontsourceRef } from './fontsource-ref.js';
import { LOGO_KINDS } from './image-size.js';
import { componentIdSchema } from './schemas/primitives.js';
import { COMPONENT_KINDS } from './types/model.js';

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

/** Body font files of a brand input (and of the Studio's theme editor), at most: one per weight or style. */
export const BRAND_BODY_FONTS_MAX = 8;

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
  // A font of the workspace's font store (font_fetch / `retake theme fetch-font`): its grammar, never a path.
  if (isFontsourceRef(ref)) return fontsourceRefProblem(ref);
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
  .describe('A file relative to the workspace root (e.g. brand/logo.svg), or site:<site id>/logo-<n> from template_from_site; a font may be fontsource:<id>[@<version>][:<weight>[italic]] once font_fetch stored it.');

export const hexColorSchema = z.string().regex(HEX_COLOR_RE, 'a hex colour: #rgb or #rrggbb (no names, rgb() or hsl())');

/** A variable font's weight range as CSS writes it: `"<min> <max>"`, each 100 to 900, min below max (e.g. "200 800"). */
export const FONT_WEIGHT_RANGE_RE = /^([1-9]\d{2}) ([1-9]\d{2})$/;

/** The range of a `"<min> <max>"` weight, or null when the text is no such range (bounds 100–900, min < max). */
export function fontWeightRange(v: string): [number, number] | null {
  const m = FONT_WEIGHT_RANGE_RE.exec(v);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  return min >= 100 && max <= 900 && min < max ? [min, max] : null;
}

const fontWeightSchema = z.union([
  z.number().int().min(100).max(900),
  z
    .string()
    .max(16)
    .refine((v) => fontWeightRange(v) !== null, 'a weight range is "<min> <max>", each from 100 to 900 and min below max (e.g. "200 800")'),
]);

/** The `{file, weight}` form names a file: a fontsource reference has its face in it (fontsource:<id>@<version>:600italic). */
const plainFileOf = (ref: z.ZodType<string, string>) =>
  ref.refine((v) => !isFontsourceRef(v), 'a fontsource: reference is given as a plain string, its weight and style in it (e.g. fontsource:inter@5.2.1:600italic)');

const fontRefOf = (ref: z.ZodType<string, string>) =>
  z.union([
    ref,
    z.strictObject({
      file: plainFileOf(ref),
      weight: fontWeightSchema
        .optional()
        .describe(
          'Weight of this file, or a variable font\'s range "<min> <max>" (e.g. "200 800"; default: read from the font — a TrueType / OpenType variable font\'s wght axis —, else its file name).',
        ),
      italic: z.boolean().optional().describe('An italic face (default: read from the font, else its file name).'),
    }),
  ]);
export type BrandFontRef = string | { file: string; weight?: number | string; italic?: boolean };

export const BrandColorsSchema = z.strictObject({
  accent: hexColorSchema.describe('The brand colour: kicker, rules, clock hand, cursor ripple. Never changed: a failing contrast gives a suggestion.'),
  text: hexColorSchema.optional().describe('Titles and caption lines (default derived from the accent).'),
  paper: hexColorSchema.optional().describe('Background / paper (default derived; a dark paper makes a dark theme).'),
  muted: hexColorSchema.optional().describe('Taglines, url (default between text and paper).'),
  dark: hexColorSchema.optional().describe('Night tone of dark cards and interstitials (default derived).'),
});

/** Params of one `components` entry of a brand input, at most: keys, and characters of their JSON. */
export const BRAND_COMPONENT_PARAMS_MAX_KEYS = 32;
export const BRAND_COMPONENT_PARAMS_MAX_CHARS = 4096;

/** The params cap of a `components` entry (create and update alike): keys, then characters of their JSON. */
function paramsCap(v: { params?: Record<string, unknown> | undefined }, ctx: z.RefinementCtx): void {
  if (!v.params) return;
  if (Object.keys(v.params).length > BRAND_COMPONENT_PARAMS_MAX_KEYS) ctx.addIssue({ code: 'custom', message: `at most ${BRAND_COMPONENT_PARAMS_MAX_KEYS} params` });
  let json: string | undefined;
  try {
    json = JSON.stringify(v.params);
  } catch {
    json = undefined;
  }
  if (json === undefined || json.length > BRAND_COMPONENT_PARAMS_MAX_CHARS) ctx.addIssue({ code: 'custom', message: `params: plain JSON of at most ${BRAND_COMPONENT_PARAMS_MAX_CHARS} characters` });
}

/** One kind's component of a brand input: its id (default the base theme's) and params merged over the base's. */
export const BrandComponentSchema = z
  .strictObject({
    id: componentIdSchema('components.<kind>.id').optional().describe("Component id (default the base theme's for that kind; another id takes only the params given here)."),
    params: z
      .record(z.string().min(1).max(64), z.unknown())
      .optional()
      .describe("Params of that component, merged over the base theme's (e.g. {logo_size: 72}); checked against the component's params."),
  })
  .superRefine(paramsCap);
export type BrandComponent = z.output<typeof BrandComponentSchema>;

/** The `components` of a brand input: per kind, the component the new theme uses (validated against the registry). */
export const BrandComponentsSchema = z
  .strictObject(Object.fromEntries(COMPONENT_KINDS.map((k) => [k, BrandComponentSchema.optional()])) as Record<(typeof COMPONENT_KINDS)[number], z.ZodOptional<typeof BrandComponentSchema>>)
  .describe("Per kind (intro, outro, card, interstitial, caption, layout, overlay, transition): {id?, params?} — e.g. {outro: {params: {logo_size: 72}}}. Default the base theme's components.");

/** The filmed cursor of a brand input (default: the base theme's, or the arrow of the palette's tone when it differs). */
export const BrandCursorSchema = z.strictObject({
  style: z.enum(['arrow-dark', 'arrow-light']).optional().describe('arrow-dark (for a light app) or arrow-light (for a dark app). Filmed: the next capture.'),
  size: z.number().min(12).max(64).optional().describe("Cursor size in px (default the base theme's, else 26)."),
});
export type BrandCursor = z.output<typeof BrandCursorSchema>;

export const BrandBackgroundSchema = z.union([hexColorSchema, z.strictObject({ type: z.enum(['radial', 'linear']), from: hexColorSchema, to: hexColorSchema })]);
export type BrandBackground = z.output<typeof BrandBackgroundSchema>;

function brandInputSchema(ref: z.ZodType<string, string>) {
  const fontRef = fontRefOf(ref);
  return z.strictObject({
    name: zNewThemeName('a new theme name: lower-case letters, digits and "-" (e.g. acme), never a path').describe(
      "Name of the new theme (its folder in templates/): lower-case, not a starter's or an existing folder's.",
    ),
    base: zThemeName('a theme name').optional().describe('Theme whose components, frame, captions, motion and durations are kept (default editorial).'),
    colors: BrandColorsSchema,
    background: BrandBackgroundSchema.optional().describe('A hex (solid) or {type: radial | linear, from, to} (default derived from the paper).'),
    adjust: z.boolean().optional().describe('Lift derived and given colours (never the accent) that miss a contrast threshold, each change reported (default true).'),
    logo: ref.describe('Logo: .svg, .png, .jpg or .webp.'),
    logo_kind: z
      .enum(LOGO_KINDS)
      .optional()
      .describe('mark (a pictogram: the brand name is drawn beside it) or wordmark (the name itself: drawn alone, sized by its width). Default: wordmark when the logo is 3:1 or wider.'),
    wordmark: ref.optional().describe('Wordmark image of the outro (default none: the brand name is drawn as text).'),
    fonts: z
      .strictObject({
        display: fontRef
          .optional()
          .describe("Display font (titles): .ttf, .otf, .woff or .woff2, or a fontsource:<id>[@<version>][:<weight>[italic]] font_fetch stored (default the base theme's)."),
        body: z
          .array(fontRef)
          .min(1)
          .max(BRAND_BODY_FONTS_MAX)
          .optional()
          .describe("Body font files (up to 8), one per weight / style — or one variable font for a range of weights (default the base theme's)."),
      })
      .optional(),
    brand: z
      .strictObject({
        name: z.string().min(1).max(80).optional().describe('Brand name (drawn as text when there is no wordmark).'),
        url: z.string().min(1).max(120).optional().describe('Brand URL as shown in the outro, e.g. example.com.'),
      })
      .optional(),
    components: BrandComponentsSchema.optional(),
    cursor: BrandCursorSchema.optional().describe("The filmed cursor (default the base theme's; arrow-light over a dark palette on a light base, arrow-dark the other way)."),
    replace: z.boolean().optional().describe('Replace a theme this tool made under that name through MCP, only when nobody changed its files since.'),
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

// ── template_update: a patch of a tool-made theme's inputs ─────────────────────────────────────────────────────────

const orNull = <T extends z.ZodType>(s: T) => s.nullable().optional();

/** One kind of a patch: another id (null: the base's), params merged per key (a null param removed). */
const PatchComponentSchema = z
  .strictObject({
    id: orNull(componentIdSchema('components.<kind>.id')),
    params: z.record(z.string().min(1).max(64), z.unknown()).optional(),
  })
  .superRefine(paramsCap);

/**
 * The input of `template_update` (trust `mcp`): the theme's name and only the brand inputs that change — every key
 * optional, `null` removes an optional one (back to the base's or the derived value). Merged over the inputs the theme
 * was made from (mergeBrandPatch), then checked as a whole by BrandInputSchema.
 */
export const BrandPatchSchema = z.strictObject({
  name: zNewThemeName('the name of a theme template_create_from_brand made: lower-case letters, digits and "-", never a path').describe(
    'The theme to update: one this tool made through MCP that nobody edited since.',
  ),
  base: zThemeName('a theme name').optional().describe('Another base theme (its components, frame, captions, motion and durations).'),
  colors: z
    .strictObject({
      accent: hexColorSchema.optional(),
      text: orNull(hexColorSchema),
      paper: orNull(hexColorSchema),
      muted: orNull(hexColorSchema),
      dark: orNull(hexColorSchema),
    })
    .optional()
    .describe('Only the colours that change (null: derived again).'),
  background: orNull(BrandBackgroundSchema).describe('A hex, {type, from, to}, or null (derived again).'),
  adjust: orNull(z.boolean()),
  logo: brandFileRefSchema.optional().describe('Another logo file (else the theme keeps its own copy).'),
  logo_kind: orNull(z.enum(LOGO_KINDS)).describe("mark or wordmark; null: from the logo's shape (3:1 and wider: wordmark)."),
  wordmark: orNull(brandFileRefSchema).describe('Another wordmark image, or null (none: the brand name as text).'),
  fonts: orNull(
    z.strictObject({
      display: orNull(fontRefOf(brandFileRefSchema)),
      body: orNull(z.array(fontRefOf(brandFileRefSchema)).min(1).max(BRAND_BODY_FONTS_MAX)),
    }),
  ).describe("Fonts that change (null: the base theme's); files not named are the theme's own copies."),
  brand: orNull(z.strictObject({ name: orNull(z.string().min(1).max(80)), url: orNull(z.string().min(1).max(120)) })).describe('Brand name / URL (null: removed).'),
  components: orNull(
    z.strictObject(
      Object.fromEntries(COMPONENT_KINDS.map((k) => [k, orNull(PatchComponentSchema)])) as Record<(typeof COMPONENT_KINDS)[number], z.ZodOptional<z.ZodNullable<typeof PatchComponentSchema>>>,
    ),
  ).describe("Per kind {id?, params?}: params merged per key over the theme's (a null param removed), null: the base's component again."),
  cursor: orNull(z.strictObject({ style: orNull(z.enum(['arrow-dark', 'arrow-light'])), size: orNull(z.number().min(12).max(64)) })).describe(
    "The filmed cursor's style / size (null: the base's, or the palette tone's).",
  ),
});
export type BrandPatch = z.output<typeof BrandPatchSchema>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `over` merged into `base` key by key: a null removes the key, an object merges one level deeper when `deep`. */
function mergeKeys(base: unknown, over: Obj, deep: (key: string) => boolean): Obj {
  const out: Obj = isObj(base) ? structuredClone(base) : {};
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else if (isObj(v) && deep(k)) {
      const m = mergeKeys(out[k], v, () => false);
      if (Object.keys(m).length) out[k] = m;
      else delete out[k];
    } else out[k] = structuredClone(v);
  }
  return out;
}

/**
 * The inputs a theme was made from with a patch applied: scalars and files replaced, `null` removing a key; colours,
 * brand, fonts and cursor merged per key; components per kind, a kind's params per key (a null param removed, an
 * entry left empty removed). An emptied section is removed. Pure: the result is checked by BrandInputSchema after.
 */
export function mergeBrandPatch(inputs: Obj, patch: Obj): Obj {
  const { name: _name, ...rest } = patch;
  const out: Obj = structuredClone(inputs);
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    if (v === null) {
      delete out[k];
      continue;
    }
    if (k === 'colors' || k === 'brand' || k === 'fonts' || k === 'cursor') {
      const m = mergeKeys(out[k], v as Obj, () => false);
      if (Object.keys(m).length) out[k] = m;
      else delete out[k];
    } else if (k === 'components') {
      const m = mergeKeys(out[k], v as Obj, () => false);
      for (const [kind, entry] of Object.entries(v as Obj)) {
        if (!isObj(entry)) continue;
        const prior = isObj((out.components as Obj | undefined)?.[kind]) ? ((out.components as Obj)[kind] as Obj) : {};
        const e = mergeKeys(prior, entry, (key) => key === 'params');
        if (Object.keys(e).length) m[kind] = e;
        else delete m[kind];
      }
      if (Object.keys(m).length) out.components = m;
      else delete out.components;
    } else out[k] = structuredClone(v);
  }
  return out;
}

/** The input keys whose value differs between two inputs ("colors.paper", "components.outro", "logo"…), sorted. */
export function changedBrandKeys(a: Obj, b: Obj): string[] {
  const nested = new Set(['colors', 'brand', 'fonts', 'cursor', 'components']);
  const same = (x: unknown, y: unknown) => JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(y));
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (nested.has(k) && (isObj(a[k]) || isObj(b[k]))) {
      const x = isObj(a[k]) ? (a[k] as Obj) : {};
      const y = isObj(b[k]) ? (b[k] as Obj) : {};
      for (const s of new Set([...Object.keys(x), ...Object.keys(y)])) if (!same(x[s], y[s])) out.push(`${k}.${s}`);
    } else if (!same(a[k], b[k])) out.push(k);
  }
  return out.sort();
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeys(v[k])]),
  );
}
