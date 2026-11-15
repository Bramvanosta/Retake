/**
 * A new workspace theme from brand inputs (R-MCP-10): `template_create_from_brand` (trust `mcp`) and
 * `retake theme create` (trust `author`). It writes one new folder `<templates_dir>/<name>/` — template.yaml over a
 * base theme (components/src/brand), the logo, wordmark and fonts copied after their checks (brand/files.ts),
 * LICENSES.md and a provenance file — and never touches an existing theme, except `replace` of one this tool made and
 * nobody changed since (every file's sha256 as written, no file added); through MCP (trust `mcp`) only a theme made
 * through MCP is replaced, never one a human made with `retake theme create`.
 *
 * Names: lower-case (core NEW_THEME_NAME_RE), never a starter's (compared without case: on macOS `Default/` would shadow
 * the starter `default` for every project), never an existing folder's (a `readdir` compared without case, entries of
 * any type, links included — an empty folder or a dangling link counts). Refused when templates_dir lies anywhere
 * inside the Retake package (the repository as a workspace: the new theme would land among the committed
 * starters). The folder is built hidden (`.tmp-<name>-<12 hex>/`, which listTemplates skips; its provenance file
 * written first), validated (schema, loader, asset containment, the registry resolving its components), then renamed
 * into place; a failure removes it. A crash's leftovers (`.tmp-` / `.old-<name>-<12 hex>/` older than an hour, holding
 * this tool's provenance file or nothing) are removed by the next create; any other hidden folder is never touched.
 */
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RETAKE_VERSION, parseYaml } from '@retake/core/base';
import { NEW_THEME_NAME_RE } from '@retake/core/ids';
import { insideFolder } from '@retake/core/scenario';
import { AuthorBrandInputSchema, BrandInputSchema, TEMPLATE_FILE, parseTemplateYaml, siteRef } from '@retake/core/theme';
import { STARTER_TEMPLATES_DIR, nodeFileFacts } from '@retake/core/io';
import type { NewThemeName } from '@retake/core/ids';
import type { BrandInput, TemplateFile, LoadedTemplate } from '@retake/core/theme';
import type { Palette } from '@retake/components/geometry';
import { workspaceRegistry } from '../components.js';
import { componentCalls } from '../registries/component-calls.js';
import { EngineError, toEngineError } from '../errors.js';
import { sha256Hex } from '../storage.js';
import type { StoreScope } from '../store/store.js';
import { dateOf } from '../clock.js';
import { checkNewThemeName, checkTemplateName, themeAssetProblems } from '../templates.js';
import { BRAND_TOTAL_MAX_BYTES, checkImage, readBrandFile } from './files.js';
import type { BrandTrust, FontInfo, ImageInfo, ResolvedBrandFile } from './files.js';
import { licencesMarkdown } from './licences.js';
import { planThemeFonts, readOwnThemeFile } from './theme-fonts.js';
import type { FontPlan, ThemeFontView } from './theme-fonts.js';

export { fileNameFace } from './theme-fonts.js';
export type { ThemeFontView } from './theme-fonts.js';
import type { OpenedWorkspace } from '../workspace.js';
import { storedJson } from '../stored-json.js';
import { z } from 'zod';

/** The provenance file of a theme this tool made (hidden: the loader and listTemplates ignore it). */
export const THEME_PROVENANCE_FILE = '.retake-theme.json';
export const DEFAULT_BRAND_BASE = 'editorial';
/** The Retake package (the repository, or its install folder): no theme is ever written inside it. */
export const PACKAGE_ROOT = dirname(STARTER_TEMPLATES_DIR);
/** Hidden build / swap folders older than this are leftovers of a crash, removed by the next create. */
const STALE_MS = 60 * 60 * 1000;
/** A build or swap folder of this tool: `.tmp-<name>-<12 hex>` / `.old-<name>-<12 hex>`. */
const WORK_DIR_RE = /^\.(?:tmp|old)-(.+)-[0-9a-f]{12}$/;

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

/** What makes a provenance file this tool's: made by it, with the hash of every file it wrote. */
const ProvenanceSchema = z.object({ made_by: z.literal('retake'), files: z.record(z.string(), z.string()), trust: z.string().optional() });

/**
 * A theme folder's provenance file: its record, `unreadable` (none, or not JSON — read as not this tool's), or
 * `foreign` (JSON this tool did not write).
 */
async function readProvenance(dir: string): Promise<Provenance | 'unreadable' | 'foreign'> {
  let text: string;
  try {
    text = await readFile(join(dir, THEME_PROVENANCE_FILE), 'utf8');
    JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  return (storedJson(ProvenanceSchema, text) as Provenance | undefined) ?? 'foreign';
}

/**
 * Why a theme folder may not be replaced, or null: it must be this tool's, every file as written, none added — and,
 * for a replace through MCP (`trust` mcp), made through MCP too (a theme a human made with `retake theme create` is
 * theirs).
 */
export async function replaceProblem(dir: string, trust: BrandTrust = 'author'): Promise<string | null> {
  const st = await lstat(dir);
  if (!st.isDirectory()) return `${dir} is not a folder (a link or a file)`;
  const provFile = THEME_PROVENANCE_FILE;
  const prov = await readProvenance(dir);
  if (prov === 'unreadable') return `${dir} was not made by this tool (no readable ${THEME_PROVENANCE_FILE})`;
  if (prov === 'foreign') return `${dir}: ${provFile} is not this tool's`;
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

/** Remove this tool's build / swap folders left by a crash (see the module comment); anything else stays. */
export async function removeStale(templatesDir: string, now: number): Promise<void> {
  for (const e of await entries(templatesDir)) {
    const m = WORK_DIR_RE.exec(e);
    // The grammar alone, no cap: a work folder left by a longer name of an earlier build is still this tool's.
    if (!m || !NEW_THEME_NAME_RE.test(m[1])) continue;
    const p = join(templatesDir, e);
    try {
      const st = await lstat(p);
      if (!st.isDirectory() || now - st.mtimeMs <= STALE_MS) continue;
      // Not this tool's (no readable provenance file, or another's): left alone.
      if ((await readdir(p)).length && typeof (await readProvenance(p)) === 'string') continue;
      await rm(p, { recursive: true, force: true });
    } catch {
      /* gone meanwhile, or not this tool's (no readable provenance file): left alone */
    }
  }
}

/**
 * The name checks of a new theme's folder: not a starter's, not an existing folder's (unless `replace` of an unchanged
 * tool-made one). `name` passed core `isNewThemeName` (its type says so; templates.ts checkNewThemeName gives it). The
 * folder itself is made by the store from the same checked string, whose parameter is a plain string.
 */
export async function checkNewName(templatesDir: string, name: NewThemeName, replace: boolean, trust: BrandTrust): Promise<{ existing: boolean }> {
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
    throw new EngineError(
      'refused',
      `theme ${name} is not replaced: ${why} — a human's theme is never overwritten. Choose another name (e.g. ${name}-2), or edit ${join(templatesDir, taken)} by hand`,
    );
  }
  return { existing: true };
}

/** The base theme of a new one: loaded, its assets inside it, its template.yaml as written. */
async function loadBase(ws: OpenedWorkspace, baseName: string): Promise<{ base: LoadedTemplate; baseFile: TemplateFile }> {
  let base: LoadedTemplate;
  try {
    base = await ws.reads.loadTemplate(baseName, ws.root, { files: ws.reads.fileFacts(ws.policy) });
  } catch (e) {
    throw toEngineError(e);
  }
  const leaks = themeAssetProblems(base);
  if (leaks.length) throw new EngineError('refused', `base theme ${baseName}: ${leaks.join('; ')}`);
  const baseText = await readFile(join(base.dir, TEMPLATE_FILE), 'utf8');
  const baseFile = parseYaml(baseText).value as TemplateFile;
  return { base, baseFile };
}

/** The logo and the wordmark of a new theme, read and checked, with the names of their copies. */
async function readArtwork(input: BrandInput, read: (ref: string, kind: 'logo' | 'wordmark') => Promise<ResolvedBrandFile>, warnings: string[]) {
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
  return { logoFile, logoInfo, logoName, wordmarkFile, wordmarkInfo, wordmarkName };
}

/** The new theme's palette from the brand colours, over the base theme's tone (a change of tone warned). */
function paletteOver(lib: Awaited<ReturnType<typeof componentCalls>>, o: { input: BrandInput; base: LoadedTemplate; baseName: string; warnings: string[] }) {
  const { input, base, baseName, warnings } = o;
  const baseTone = lib.paletteTone(base.template.colors.paper.startsWith('#') ? base.template.colors.paper : '#ffffff');
  const palette = lib.derivePalette({ ...input.colors, ...(input.background !== undefined ? { background: input.background } : {}), adjust: input.adjust !== false, tone: baseTone });
  if (palette.tone !== baseTone) {
    warnings.push(
      `the paper ${palette.colors.paper} makes a ${palette.tone} theme over ${baseName}, a ${baseTone} one (its cursor and interstitial styles were chosen for a ${baseTone} paper): consider base ${palette.tone === 'dark' ? 'motion' : 'editorial'}`,
    );
  }
  warnings.push(...palette.warnings);
  return palette;
}

/** The base theme's LICENSES.md when a font file comes from it (else undefined; a missing one said and warned). */
async function baseLicencesOf(uniqueFonts: FontPlan[], o: { base: LoadedTemplate; baseName: string; warnings: string[] }): Promise<string | undefined> {
  const { base, baseName, warnings } = o;
  let baseLicences: string | undefined;
  if (uniqueFonts.some((f) => f.view.weight_from === 'base')) {
    try {
      baseLicences = (await readOwnThemeFile(join(base.dir, 'LICENSES.md'), baseName)).toString('utf8');
    } catch {
      baseLicences = `(${baseName} has no LICENSES.md: check the licences of fonts/${'…'} yourself)`;
      warnings.push(`base theme ${baseName} has no LICENSES.md for the font files copied from it`);
    }
  }
  return baseLicences;
}

/** The provenance file of a new theme: what made it, from what, and the sha256 of every file written. */
function provenanceOf(o: { input: BrandInput; now: Date; name: string; baseName: string; trust: BrandTrust; written: Map<string, Buffer> }): Provenance {
  const { input, now, name, baseName, written } = o;
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
  return provenance;
}

/**
 * The new theme's folder, built hidden by the store (the provenance file first, then every file), validated as a render
 * will load it, then moved into place.
 */
async function buildThemeFolder(
  ws: OpenedWorkspace,
  o: ThemeCreateOptions,
  t: { templatesDir: string; name: NewThemeName; replace: boolean; baseName: string; provenance: Provenance; written: Map<string, Buffer>; yaml: string },
): Promise<{ dir: string; replaced: boolean }> {
  const { templatesDir, name, replace, baseName, provenance, written } = t;
  let made: { dir: string; replaced: boolean };
  try {
    made = await o.scope.stores.at(templatesDir, o.scope, { label: '<templates_dir>' }).createFolder(templatesDir, name, {
      what: 'theme',
      build: async (stage) => {
        // The provenance file first: a crash leaves a folder the next create recognises as this tool's (removeStale).
        await stage.write(THEME_PROVENANCE_FILE, `${JSON.stringify(provenance, null, 2)}\n`);
        for (const [f, b] of written) await stage.write(f, b);
        // What a render will load: the loader, the files inside the folder, the components it picks.
        const parsed = parseTemplateYaml(t.yaml, { dir: stage.dir, files: ws.reads.fileFacts(ws.policy) });
        if (parsed.issues.length) throw new EngineError('internal', `the new theme does not validate: ${parsed.issues.map((i) => i.message).join('; ')}`);
        const loaded = await ws.reads.loadTemplate(stage.dir, undefined, { files: ws.reads.fileFacts(ws.policy) });
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
  return made;
}

/** Create a theme from brand inputs (see the module comment). Throws EngineError: invalid, refused, conflict, not_found. */
export async function createThemeFromBrand(ws: OpenedWorkspace, raw: unknown, o: ThemeCreateOptions): Promise<ThemeCreated> {
  const input = parseInput(raw, o.trust);
  // Stamped by the scope's clock (its date and provenance), which also dates the stale stages swept.
  const now = dateOf(o.scope.clock);
  const date = now.toISOString().slice(0, 10);
  // The input schema holds the same rule: the check gives the name its type.
  const name = checkNewThemeName(input.name);
  const replace = input.replace === true;
  const templatesDir = ws.templatesDir;
  if (insideFolder(PACKAGE_ROOT, templatesDir, nodeFileFacts)) {
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
  const { base, baseFile } = await loadBase(ws, baseName);

  const lib = await componentCalls();
  const warnings: string[] = [];
  const budget = { left: BRAND_TOTAL_MAX_BYTES };
  const read = (ref: string, kind: 'logo' | 'wordmark' | 'font') => readBrandFile(ws, ref, kind, { trust: o.trust, ...(o.cwd ? { cwd: o.cwd } : {}), budget });

  // Logo and wordmark.
  const { logoFile, logoInfo, logoName, wordmarkFile, wordmarkInfo, wordmarkName } = await readArtwork(input, read, warnings);

  // Fonts: the brand's (sniffed, renamed by role and weight), else the base's (copied as they are).
  const { fonts, display, body } = await planThemeFonts({ input, base, baseName, lib, read, warnings });

  // Palette.
  const palette = paletteOver(lib, { input, base, baseName, warnings });

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

  const baseLicences = await baseLicencesOf(uniqueFonts, { base, baseName, warnings });
  const names = new Map(uniqueFonts.filter((f) => f.names).map((f) => [f.view.file, f.names!]));
  const logo = { file: logoName, source: input.logo, ...logoInfo };
  const wordmark = wordmarkFile && wordmarkName ? { file: wordmarkName, source: input.wordmark!, ...wordmarkInfo! } : undefined;
  const licences = licencesMarkdown({
    name,
    base: baseName,
    date,
    logo,
    ...(wordmark ? { wordmark } : {}),
    fonts: uniqueFonts.map((f) => f.view),
    names,
    ...(baseLicences !== undefined ? { baseLicences } : {}),
  });

  const written = new Map<string, Buffer>([
    [TEMPLATE_FILE, Buffer.from(generated.yaml)],
    [logoName, logoFile.bytes],
    ...(wordmarkFile && wordmarkName ? [[wordmarkName, wordmarkFile.bytes] as [string, Buffer]] : []),
    ...uniqueFonts.map((f) => [f.view.file, f.bytes] as [string, Buffer]),
    ['LICENSES.md', Buffer.from(licences)],
  ]);
  const provenance = provenanceOf({ input, now, name, baseName, trust: o.trust, written });

  const made = await buildThemeFolder(ws, o, { templatesDir, name, replace, baseName, provenance, written, yaml: generated.yaml });
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
