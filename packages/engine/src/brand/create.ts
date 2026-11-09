/**
 * A new workspace theme from brand inputs (L3.5, R-MCP-10): `template_create_from_brand` (trust `mcp`) and
 * `retake theme create` (trust `author`). It writes one new folder `<templates_dir>/<name>/` — template.yaml over a
 * base theme (components/src/brand), the logo, wordmark and fonts copied after their checks (brand/files.ts),
 * LICENSES.md and a provenance file — and never touches an existing theme, except `replace` of one this tool made and
 * nobody changed since (every file's sha256 as written, no file added); through MCP (trust `mcp`) only a theme made
 * through MCP is replaced, never one a human made with `retake theme create`.
 *
 * Names: lower-case (core THEME_NAME_RE), never a starter's (compared without case: on macOS `Default/` would shadow
 * the starter `default` for every project), never an existing folder's (a `readdir` compared without case, entries of
 * any type, links included — an empty folder or a dangling link counts). Refused when templates_dir lies anywhere
 * inside the Retake package (the repository as a workspace: the new theme would land among the committed
 * starters). The folder is built hidden (`.tmp-<name>-<12 hex>/`, which listTemplates skips; its provenance file
 * written first), validated (schema, loader, asset containment, the registry resolving its components), then renamed
 * into place; a failure removes it. A crash's leftovers (`.tmp-` / `.old-<name>-<12 hex>/` older than an hour, holding
 * this tool's provenance file or nothing) are removed by the next create; any other hidden folder is never touched.
 */
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import {
  AuthorBrandInputSchema,
  BrandInputSchema,
  OLD_MADE_BY,
  OLD_THEME_PROVENANCE_FILE,
  RETAKE_VERSION,
  STARTER_TEMPLATES_DIR,
  TEMPLATE_FILE,
  THEME_NAME_RE,
  fontRefFile,
  insideFolder,
  loadTemplate,
  parseTemplateYaml,
  parseYaml,
  printableText,
  siteRef,
} from '@retake/core';
import type { BrandFontRef, BrandInput, TemplateFile, WorkspaceConfig } from '@retake/core';
import type { Palette } from '@retake/components';
import { components, workspaceRegistry } from '../components.js';
import { EngineError, toEngineError } from '../errors.js';
import { sha256Hex } from '../storage.js';
import { ProjectStore } from '../store/project-store.js';
import type { StoreScope } from '../store/project-store.js';
import { checkTemplateName, themeAssetProblems } from '../templates.js';
import { BRAND_TOTAL_MAX_BYTES, checkImage, fontCopyName, readBrandFile, sniffFont, standardWeight } from './files.js';
import type { BrandTrust, FontInfo, ImageInfo, ResolvedBrandFile } from './files.js';

/** The provenance file of a theme this tool made (hidden: the loader and listTemplates ignore it). */
export const THEME_PROVENANCE_FILE = '.retake-theme.json';
export const DEFAULT_BRAND_BASE = 'editorial';
/** The Retake package (the repository, or its install folder): no theme is ever written inside it. */
export const PACKAGE_ROOT = dirname(STARTER_TEMPLATES_DIR);
/** Hidden build / swap folders older than this are leftovers of a crash, removed by the next create. */
const STALE_MS = 60 * 60 * 1000;
/** A build or swap folder of this tool: `.tmp-<name>-<12 hex>` / `.old-<name>-<12 hex>`. */
const WORK_DIR_RE = /^\.(?:tmp|old)-(.+)-[0-9a-f]{12}$/;

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

export interface ThemeCreated {
  name: string;
  dir: string;
  base: string;
  /** A tool-made theme of that name was replaced. */
  replaced: boolean;
  /** Files written, relative to dir. */
  files: string[];
  template_yaml: string;
  palette: Palette;
  logo: { file: string; source: string } & ImageInfo;
  wordmark?: { file: string; source: string } & ImageInfo;
  fonts: ThemeFontView[];
  warnings: string[];
  /** Strings the font files declare (family, copyright, licence…): third-party text, data only. */
  untrusted: { fonts: Array<{ file: string } & FontInfo['names']> };
}

export interface ThemeCreateOptions {
  trust: BrandTrust;
  /** Where the theme is written and journaled (the caller). */
  scope: StoreScope;
  /** trust `author`: relative file paths resolve against it (default process.cwd()). */
  cwd?: string;
  now?: Date;
}

interface Provenance {
  version: 1;
  made_by: 'retake';
  tool_version: string;
  created_at: string;
  name: string;
  base: string;
  trust: BrandTrust;
  inputs: Omit<BrandInput, 'replace'>;
  /** The site extraction a `site:` logo or wordmark came from (template_from_site). */
  site_id?: string;
  /** sha256 of every file written (relative path → hex), the provenance file excepted. */
  files: Record<string, string>;
}

/**
 * A base theme's own file, read to be copied into the new theme (its fonts, LICENSES.md): a regular file with one name
 * only — a symbolic or hard link would turn bytes from elsewhere into the new theme's own file (L4.7 review A M1).
 */
async function readOwnThemeFile(abs: string, theme: string): Promise<Buffer> {
  const st = await lstat(abs);
  if (!st.isFile()) throw new EngineError('refused', `base theme ${theme}: ${basename(abs)} is not a regular file (a link?): a new theme copies only the base's own files`);
  if (st.nlink > 1) throw new EngineError('refused', `base theme ${theme}: ${basename(abs)} has another name (a hard link): a new theme copies only the base's own files`);
  return readFile(abs);
}

function parseInput(raw: unknown, trust: BrandTrust): BrandInput {
  const parsed = (trust === 'mcp' ? BrandInputSchema : AuthorBrandInputSchema).safeParse(raw);
  if (!parsed.success) {
    throw new EngineError('invalid', `invalid brand input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`, {
      details: { issues: parsed.error.issues.map((i) => ({ severity: 'error', path: i.path, message: i.message })) },
    });
  }
  return parsed.data;
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Every file of a folder, relative (`/`), recursively; links and other non-files reported in `odd`. */
async function walk(dir: string, rel = ''): Promise<{ files: string[]; odd: string[] }> {
  const out = { files: [] as string[], odd: [] as string[] };
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const sub = await walk(dir, r);
      out.files.push(...sub.files);
      out.odd.push(...sub.odd);
    } else if (e.isFile()) out.files.push(r);
    else out.odd.push(r);
  }
  return out;
}

/**
 * Why a theme folder may not be replaced, or null: it must be this tool's, every file as written, none added — and,
 * for a replace through MCP (`trust` mcp), made through MCP too (a theme a human made with `retake theme create` is
 * theirs).
 */
export async function replaceProblem(dir: string, trust: BrandTrust = 'author'): Promise<string | null> {
  const st = await lstat(dir);
  if (!st.isDirectory()) return `${dir} is not a folder (a link or a file)`;
  let prov: Provenance;
  let provFile = THEME_PROVENANCE_FILE;
  try {
    prov = JSON.parse(await readFile(join(dir, THEME_PROVENANCE_FILE), 'utf8')) as Provenance;
  } catch {
    // A theme the tool made before L5.13 carries the provenance file of that name (legacy.ts): still the tool's.
    try {
      prov = JSON.parse(await readFile(join(dir, OLD_THEME_PROVENANCE_FILE), 'utf8')) as Provenance;
      provFile = OLD_THEME_PROVENANCE_FILE;
    } catch {
      return `${dir} was not made by this tool (no readable ${THEME_PROVENANCE_FILE})`;
    }
  }
  if (!madeByTool(prov) || !prov.files || typeof prov.files !== 'object') return `${dir}: ${provFile} is not this tool's`;
  if (trust === 'mcp' && prov.trust !== 'mcp') return `${dir} was made by a human with retake theme create: through MCP only a theme made through MCP is replaced`;
  const { files, odd } = await walk(dir);
  if (odd.length) return `${dir} holds links or special files (${odd.join(', ')})`;
  const listed = Object.keys(prov.files);
  const added = files.filter((f) => f !== provFile && !listed.includes(f));
  if (added.length) return `files were added since it was made: ${added.join(', ')}`;
  for (const f of listed) {
    let h: string;
    try {
      h = sha256Hex(await readFile(join(dir, ...f.split('/'))));
    } catch {
      return `${f} was removed since it was made`;
    }
    if (h !== prov.files[f]) return `${f} was changed since it was made`;
  }
  return null;
}

/** Whether a provenance record is this tool's — `made_by` of today, or of before L5.13 (legacy.ts). */
function madeByTool(prov: Partial<Provenance> | null | undefined): boolean {
  return prov?.made_by === 'retake' || (prov?.made_by as string | undefined) === OLD_MADE_BY;
}

/** Remove this tool's build / swap folders left by a crash (see the module comment); anything else stays. */
export async function removeStale(templatesDir: string, now: number): Promise<void> {
  for (const e of await entries(templatesDir)) {
    const m = WORK_DIR_RE.exec(e);
    if (!m || !THEME_NAME_RE.test(m[1])) continue;
    const p = join(templatesDir, e);
    try {
      const st = await lstat(p);
      if (!st.isDirectory() || now - st.mtimeMs <= STALE_MS) continue;
      if ((await readdir(p)).length) {
        const prov = JSON.parse(await readFile(join(p, THEME_PROVENANCE_FILE), 'utf8')) as Partial<Provenance> | null;
        if (!madeByTool(prov)) continue;
      }
      await rm(p, { recursive: true, force: true });
    } catch {
      /* gone meanwhile, or not this tool's (no readable provenance file): left alone */
    }
  }
}

/** The name checks: lower-case, not a starter's, not an existing folder's (unless `replace` of an unchanged tool-made one). */
export async function checkNewName(templatesDir: string, name: string, replace: boolean, trust: BrandTrust): Promise<{ existing: boolean }> {
  const lower = name.toLowerCase();
  const starters = (await entries(STARTER_TEMPLATES_DIR)).filter((e) => !e.startsWith('.'));
  const starter = starters.find((s) => s.toLowerCase() === lower);
  if (starter) {
    throw new EngineError('refused', `"${name}" is the name of the starter theme ${starter}: a workspace theme of that name would replace it for every project of the workspace — choose another name`);
  }
  const taken = (await entries(templatesDir)).find((e) => e.toLowerCase() === lower);
  if (taken === undefined) return { existing: false };
  if (!replace) {
    throw new EngineError('conflict', `templates_dir already has "${taken}" (${join(templatesDir, taken)}): choose another name (e.g. ${name}-2), or replace: true for a theme this tool made`, {
      details: { existing: join(templatesDir, taken) },
    });
  }
  if (taken !== name) throw new EngineError('refused', `"${taken}" exists with another case than "${name}": it is not replaced`);
  const why = await replaceProblem(join(templatesDir, taken), trust);
  if (why) {
    throw new EngineError('refused', `theme ${name} is not replaced: ${why} — a human's theme is never overwritten. Choose another name (e.g. ${name}-2), or edit ${join(templatesDir, taken)} by hand`);
  }
  return { existing: true };
}

/** A file reference inside a code span of LICENSES.md (one line; no backtick, pipe or control). */
function mdCode(s: string | undefined): string {
  return s ? printableText(s).replace(/[|`]+/g, ' ').trim() : '—';
}

/**
 * Third-party text (a font's name strings) as plain Markdown text: one line, every character Markdown or HTML reads as
 * syntax escaped (links, images, emphasis, code, tables, tags) — never a link or a remote image in LICENSES.md.
 */
function mdText(s: string | undefined): string {
  return s ? printableText(s).replace(/[\\`*_[\]()!<>|#~&]/g, '\\$&') || '—' : '—';
}

function licencesMarkdown(o: {
  name: string;
  base: string;
  date: string;
  logo: { file: string; source: string };
  wordmark?: { file: string; source: string };
  fonts: ThemeFontView[];
  names: Map<string, FontInfo['names']>;
  baseLicences?: string;
}): string {
  const lines = [
    `# Licences — \`${o.name}\` theme`,
    '',
    `Made by Retake from brand inputs on ${o.date}, over the \`${o.base}\` theme.`,
    '',
    '## Brand artwork',
    '',
    `- \`${o.logo.file}\` — copied from \`${mdCode(o.logo.source)}\`.`,
    ...(o.wordmark ? [`- \`${o.wordmark.file}\` — copied from \`${mdCode(o.wordmark.source)}\`.`] : []),
    '',
    'The logo and wordmark are the brand\'s own artwork, supplied by the user of this workspace.',
    '',
    '## Fonts',
    '',
    '| File | Supplied as | Face | Notes |',
    '| --- | --- | --- | --- |',
    ...o.fonts.map((f) => `| \`${f.file}\` | \`${mdCode(f.source)}\` | ${f.role}, ${f.weight}${f.italic ? ' italic' : ''} (${f.format}) | ${f.licence_notes.length ? mdText(f.licence_notes.join('; ')) : '—'} |`),
    '',
  ];
  const own = o.fonts.filter((f) => f.weight_from !== 'base');
  if (own.length) {
    lines.push(
      'Fonts supplied by the user: check that their licence allows use in videos (text rendered to pixels) and',
      'redistribution with your projects. What each file declares about itself, as found in it:',
      '',
    );
    for (const f of own) {
      const n = o.names.get(f.file) ?? {};
      lines.push(
        `### \`${f.file}\``,
        '',
        `- Family: ${mdText(n.family)} ${n.subfamily ? `(${mdText(n.subfamily)})` : ''}`.trimEnd(),
        `- Copyright: ${mdText(n.copyright)}`,
        `- Licence: ${mdText(n.licence)}`,
        `- Licence URL: ${mdText(n.licence_url)}`,
        ...(f.licence_notes.length ? [`- Embedding: ${mdText(f.licence_notes.join('; '))}`] : []),
        '',
      );
    }
  }
  if (o.baseLicences !== undefined) {
    lines.push(
      `## Fonts of the base theme \`${o.base}\``,
      '',
      `Some font files come from the \`${o.base}\` theme; its LICENSES.md follows as it is (its notes on artwork do not`,
      'apply to this theme\'s logo and wordmark).',
      '',
      ...o.baseLicences
        .trimEnd()
        .split('\n')
        .map((l) => (l.startsWith('#') ? `##${l}` : l)),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

interface FontPlan {
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
  if (!fromName) return { weight: 400, italic, from: 'file name', warning: `${file}: no weight in the file (${info.format.toUpperCase()}) nor in its name: 400 assumed — give {file, weight} to set it` };
  return { weight: standardWeight(fromName.weight), italic, from: 'file name', warning: `${file}: weight ${standardWeight(fromName.weight)}${italic ? ' italic' : ''} read from the file name (${info.format.toUpperCase()} files keep it compressed) — give {file, weight} if it is wrong` };
}

/** Create a theme from brand inputs (see the module comment). Throws EngineError: invalid, refused, conflict, not_found. */
export async function createThemeFromBrand(ws: WorkspaceConfig, raw: unknown, o: ThemeCreateOptions): Promise<ThemeCreated> {
  const input = parseInput(raw, o.trust);
  const now = o.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const { name } = input;
  const replace = input.replace === true;
  const templatesDir = ws.templatesDir;
  if (insideFolder(PACKAGE_ROOT, templatesDir)) {
    throw new EngineError('refused', `the workspace's templates_dir (${templatesDir}) lies inside the Retake folder (${PACKAGE_ROOT}): a new theme would land among its starter themes`, {
      fix: 'work in a workspace of your own: set RETAKE_ROOT, or a retake.yaml whose templates_dir is outside the Retake folder',
    });
  }
  await mkdir(templatesDir, { recursive: true });
  await removeStale(templatesDir, now.getTime());
  await checkNewName(templatesDir, name, replace, o.trust);
  const baseName = input.base ?? DEFAULT_BRAND_BASE;
  checkTemplateName(baseName);
  if (baseName.toLowerCase() === name.toLowerCase()) throw new EngineError('invalid', `the base theme cannot be the theme being created (${name})`);

  // The base: its components, frame, captions, motion and durations; its fonts when none are given.
  let base;
  try {
    base = await loadTemplate(baseName, ws.root);
  } catch (e) {
    throw toEngineError(e);
  }
  const leaks = themeAssetProblems(base);
  if (leaks.length) throw new EngineError('refused', `base theme ${baseName}: ${leaks.join('; ')}`);
  const baseText = await readFile(join(base.dir, TEMPLATE_FILE), 'utf8');
  const baseFile = parseYaml(baseText).value as TemplateFile;

  const lib = await components();
  const warnings: string[] = [];
  const budget = { left: BRAND_TOTAL_MAX_BYTES };
  const read = (ref: string, kind: 'logo' | 'wordmark' | 'font') => readBrandFile(ws, ref, kind, { trust: o.trust, ...(o.cwd ? { cwd: o.cwd } : {}), budget });

  // Logo and wordmark.
  const logoFile = await read(input.logo, 'logo');
  const logoInfo = checkImage(logoFile, 'logo');
  const logoName = `logo${logoFile.ext}`;
  let wordmarkFile: ResolvedBrandFile | undefined;
  let wordmarkInfo: ImageInfo | undefined;
  if (input.wordmark !== undefined) {
    wordmarkFile = await read(input.wordmark, 'wordmark');
    wordmarkInfo = checkImage(wordmarkFile, 'wordmark');
  }
  const wordmarkName = wordmarkFile ? `wordmark${wordmarkFile.ext}` : undefined;
  if (!wordmarkFile && input.brand?.name === undefined) warnings.push('no wordmark and no brand.name: the outro shows the logo alone');

  // Fonts: the brand's (sniffed, renamed by role and weight), else the base's (copied as they are).
  const fonts: FontPlan[] = [];
  const planFont = async (ref: BrandFontRef, role: 'display' | 'body'): Promise<FontPlan> => {
    const f = await read(fontRefFile(ref), 'font');
    const info = sniffFont(f, `${role} font`);
    const face = fontFace(info, ref);
    if (face.warning) warnings.push(`${role} font ${face.warning}`);
    const file = fontCopyName(role, face.weight, face.italic, f.ext);
    for (const note of info.licence_notes) warnings.push(`${role} font ${fontRefFile(ref)}: ${note} — check its licence before using it in videos`);
    return { view: { file, role, source: fontRefFile(ref), format: info.format, weight: face.weight, italic: face.italic, weight_from: face.from, licence_notes: info.licence_notes }, bytes: f.bytes, names: info.names };
  };
  const baseFont = async (abs: string, role: 'display' | 'body'): Promise<FontPlan> => {
    const bytes = await readOwnThemeFile(abs, baseName);
    const info = sniffFont({ ref: `base:${baseName}/${relative(base.dir, abs).split(sep).join('/')}`, ext: extname(abs).toLowerCase(), bytes }, `${role} font of ${baseName}`);
    const face = lib.fontFileFace(abs);
    return {
      view: { file: `fonts/${basename(abs)}`, role, source: `base:${baseName}/${relative(base.dir, abs).split(sep).join('/')}`, format: info.format, weight: face.weight, italic: face.style === 'italic', weight_from: 'base', licence_notes: info.licence_notes },
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
      throw new EngineError('invalid', `two body fonts have the same weight and style (${b.view.weight}${b.view.italic ? ' italic' : ''}): ${prior.view.source} and ${b.view.source} — give each weight once`);
    }
    seen.set(b.view.file, b);
    fonts.push(b);
  }
  if (given.body !== undefined) {
    const caps = base.template.captions;
    for (const [k, s] of [['kicker', caps.kicker], ['line', caps.line]] as const) {
      if (s.font !== 'body') continue;
      const w = s.weight ?? 400;
      if (!body.some((b) => b.view.weight === w && !b.view.italic)) warnings.push(`captions.${k} of ${baseName} uses the body font at weight ${w}, which no body file has: the browser synthesises it (give a body file of weight ${w})`);
    }
  }

  // Palette.
  const baseTone = lib.paletteTone(base.template.colors.paper.startsWith('#') ? base.template.colors.paper : '#ffffff');
  const palette = lib.derivePalette({ ...input.colors, ...(input.background !== undefined ? { background: input.background } : {}), adjust: input.adjust !== false, tone: baseTone });
  if (palette.tone !== baseTone) {
    warnings.push(
      `the paper ${palette.colors.paper} makes a ${palette.tone} theme over ${baseName}, a ${baseTone} one (its cursor and interstitial styles were chosen for a ${baseTone} paper): consider base ${palette.tone === 'dark' ? 'motion' : 'editorial'}`,
    );
  }
  warnings.push(...palette.warnings);

  const uniqueFonts = [...new Map(fonts.map((f) => [f.view.file, f])).values()];
  const generated = lib.generateThemeFile({
    base: baseFile,
    baseName,
    name,
    palette,
    logo: logoName,
    ...(wordmarkName ? { wordmark: wordmarkName } : {}),
    fonts: { display: display.view.file, body: body.map((b) => b.view.file) },
    ...(input.brand ? { brand: input.brand } : {}),
    date,
  });
  if (generated.kept_colors.length) warnings.push(`colour keys of ${baseName} kept as they were: ${generated.kept_colors.join(', ')}`);
  const check = parseTemplateYaml(generated.yaml);
  if (check.issues.length) throw new EngineError('internal', `the generated template.yaml does not validate: ${check.issues.map((i) => i.message).join('; ')}`);

  let baseLicences: string | undefined;
  if (uniqueFonts.some((f) => f.view.weight_from === 'base')) {
    try {
      baseLicences = (await readOwnThemeFile(join(base.dir, 'LICENSES.md'), baseName)).toString('utf8');
    } catch {
      baseLicences = `(${baseName} has no LICENSES.md: check the licences of fonts/${'…'} yourself)`;
      warnings.push(`base theme ${baseName} has no LICENSES.md for the font files copied from it`);
    }
  }
  const names = new Map(uniqueFonts.filter((f) => f.names).map((f) => [f.view.file, f.names!]));
  const logo = { file: logoName, source: input.logo, ...logoInfo };
  const wordmark = wordmarkFile && wordmarkName ? { file: wordmarkName, source: input.wordmark!, ...wordmarkInfo! } : undefined;
  const licences = licencesMarkdown({ name, base: baseName, date, logo, ...(wordmark ? { wordmark } : {}), fonts: uniqueFonts.map((f) => f.view), names, ...(baseLicences !== undefined ? { baseLicences } : {}) });

  const written = new Map<string, Buffer>([
    [TEMPLATE_FILE, Buffer.from(generated.yaml)],
    [logoName, logoFile.bytes],
    ...(wordmarkFile && wordmarkName ? [[wordmarkName, wordmarkFile.bytes] as [string, Buffer]] : []),
    ...uniqueFonts.map((f) => [f.view.file, f.bytes] as [string, Buffer]),
    ['LICENSES.md', Buffer.from(licences)],
  ]);
  const { replace: _replace, ...inputs } = input;
  const siteId = [input.logo, input.wordmark].map((r) => (r !== undefined ? siteRef(r)?.site_id : undefined)).find((x) => x !== undefined);
  const provenance: Provenance = {
    version: 1,
    made_by: 'retake',
    tool_version: RETAKE_VERSION,
    created_at: now.toISOString(),
    name,
    base: baseName,
    trust: o.trust,
    inputs,
    ...(siteId ? { site_id: siteId } : {}),
    files: Object.fromEntries([...written].map(([f, b]) => [f, sha256Hex(b)])),
  };

  let made: { dir: string; replaced: boolean };
  try {
    made = await new ProjectStore(templatesDir, o.scope, undefined, '<templates_dir>').createFolder(templatesDir, name, {
      what: 'theme',
      build: async (stage) => {
        // The provenance file first: a crash leaves a folder the next create recognises as this tool's (removeStale).
        await stage.write(THEME_PROVENANCE_FILE, `${JSON.stringify(provenance, null, 2)}\n`);
        for (const [f, b] of written) await stage.write(f, b);
        // What a render will load: the loader, the files inside the folder, the components it picks.
        const parsed = parseTemplateYaml(generated.yaml, { dir: stage.dir });
        if (parsed.issues.length) throw new EngineError('internal', `the new theme does not validate: ${parsed.issues.map((i) => i.message).join('; ')}`);
        const loaded = await loadTemplate(stage.dir);
        const outside = themeAssetProblems(loaded);
        if (outside.length) throw new EngineError('internal', outside.join('; '));
        try {
          (await workspaceRegistry(ws)).resolveTheme(loaded.template);
        } catch (e) {
          throw new EngineError('invalid', `the new theme's components do not resolve (from ${baseName}): ${toEngineError(e).message}`);
        }
      },
      recheck: () => checkNewName(templatesDir, name, replace, o.trust),
    });
  } catch (e) {
    throw toEngineError(e);
  }
  const final = made.dir;
  return {
    name,
    dir: final,
    base: baseName,
    replaced: made.replaced,
    files: [...written.keys(), THEME_PROVENANCE_FILE],
    template_yaml: generated.yaml,
    palette,
    logo,
    ...(wordmark ? { wordmark } : {}),
    fonts: fonts.map((f) => f.view),
    warnings,
    untrusted: { fonts: uniqueFonts.filter((f) => f.names && Object.keys(f.names).length).map((f) => ({ file: f.view.file, ...f.names! })) },
  };
}
