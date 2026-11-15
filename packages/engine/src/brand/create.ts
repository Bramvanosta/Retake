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
import { RETAKE_VERSION, canonicalJson, parseYaml } from '@retake/core/base';
import { NEW_THEME_NAME_RE } from '@retake/core/ids';
import { insideFolder } from '@retake/core/scenario';
import { AuthorBrandInputSchema, BrandInputSchema, TEMPLATE_FILE, aspectOf, parseTemplateYaml, siteRef } from '@retake/core/theme';
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
  /** template_update: the input keys that changed ("colors.paper", "components.outro"…). */
  changed?: string[];
  /** Files written, relative to dir. */
  files: string[];
  template_yaml: string;
  palette: Palette;
  logo: { file: string; source: string } & ImageInfo;
  /** How the logo is drawn: the input's logo_kind, else wordmark for a logo 3:1 and wider (written), else mark. */
  logo_kind: 'mark' | 'wordmark';
  wordmark?: { file: string; source: string } & ImageInfo;
  fonts: ThemeFontView[];
  warnings: string[];
  /** What the tool chose for the brand, said once (a wide logo drawn as a wordmark, the cursor of the palette's tone). */
  notes?: string[];
  /** Strings the font files declare (family, copyright, licence…): third-party text, data only. */
  untrusted: { fonts: Array<{ file: string } & FontInfo['names']> };
}

/** Who made a theme, recorded in its provenance file: through MCP, in the Studio, or with `retake theme create`. */
export type ThemeMadeVia = 'mcp' | 'studio' | 'cli';

/**
 * What template_update hands the pipeline (update.ts): the theme's own copies of the files its patch does not name —
 * read again and hash-checked against its provenance — so a pruned site candidate or a moved brand file is never read
 * again; the base theme's licences as the theme's own LICENSES.md cites them; the date it was first made.
 */
export interface ThemeReuse {
  /** The copy made from `ref` for that kind (logo, wordmark, font), when the patch does not name it. */
  file(ref: string, kind: 'logo' | 'wordmark' | 'font'): ResolvedBrandFile | undefined;
  /** The copy of a base theme's font (`base:<theme>/<file>`), when the theme holds one. */
  base(source: string): Buffer | undefined;
  /** The base theme's LICENSES.md as the theme's own LICENSES.md holds it, when it does. */
  baseLicences?: string;
  created_at: string;
  changed: string[];
}

export interface ThemeCreateOptions {
  trust: BrandTrust;
  /** Who makes it (recorded as `made_via`): default `cli` for trust author, else `mcp`. */
  via?: ThemeMadeVia;
  /** template_update only (update.ts). */
  reuse?: ThemeReuse;
  /** Where the theme is written and journaled (the caller). */
  scope: StoreScope;
  /** trust `author`: relative file paths resolve against it (default process.cwd()). */
  cwd?: string;
}

export interface Provenance {
  version: 1;
  made_by: 'retake';
  tool_version: string;
  created_at: string;
  /** template_update: when it was last re-made. */
  updated_at?: string;
  name: string;
  base: string;
  trust: BrandTrust;
  /** Who made it (absent in a file written before Retake recorded it: such a theme is not replaced nor updated through MCP). */
  made_via?: ThemeMadeVia;
  inputs: Omit<BrandInput, 'replace'>;
  /**
   * sha256 of the canonical JSON of the record minus `files`, `tool_version` and itself (inputs, sources, who made it…):
   * template_update merges from it only while it is as written.
   */
  record_sha256?: string;
  /** The input reference each copied file came from (relative path → ref; a base font: `base:<theme>/<file>`). */
  sources?: Record<string, string>;
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
const ProvenanceSchema = z.object({
  made_by: z.literal('retake'),
  files: z.record(z.string(), z.string()),
  trust: z.string().optional(),
  made_via: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  record_sha256: z.string().optional(),
  sources: z.record(z.string(), z.string()).optional(),
});

/**
 * sha256 of a provenance record as written (canonical JSON): `files` (checked file by file), `record_sha256` itself and
 * `tool_version` (which Retake wrote it: no guard reads it, and a release must not move it) left out.
 */
export function recordHash(prov: Record<string, unknown>): string {
  const { files: _files, record_sha256: _hash, tool_version: _version, ...rest } = prov;
  return sha256Hex(Buffer.from(canonicalJson(rest)));
}

/** A path a provenance file names in its theme folder: relative, `/` between plain names (no `..`, `.`, backslash, NUL). */
const PLAIN_REL = /^(?!\/)(?:(?!\.\.?(?:\/|$))[^/\\\0]+\/)*(?!\.\.?$)[^/\\\0]+$/;

/** A theme file this guard reads at most (the brand budget: no copy of a theme is larger). */
const THEME_FILE_MAX_BYTES = BRAND_TOTAL_MAX_BYTES;
/** The provenance file, at most. */
const PROVENANCE_MAX_BYTES = 1024 * 1024;

/** A regular file of a theme folder (never followed, never larger than `max`), read; undefined when it is no such file. */
export async function readThemeFile(abs: string, max = THEME_FILE_MAX_BYTES): Promise<Buffer | undefined> {
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile() || st.size > max) return undefined;
  const b = await readFile(abs);
  return b.length > max ? undefined : b;
}

/**
 * A theme folder's provenance file: its record, `unreadable` (none, or not JSON — read as not this tool's), or
 * `foreign` (JSON this tool did not write).
 */
export async function readProvenance(dir: string): Promise<Provenance | 'unreadable' | 'foreign'> {
  let text: string;
  try {
    // A regular file of a sane size only: a FIFO or a link there is never opened.
    const b = await readThemeFile(join(dir, THEME_PROVENANCE_FILE), PROVENANCE_MAX_BYTES);
    if (!b) return 'unreadable';
    text = b.toString('utf8');
    JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  return (storedJson(ProvenanceSchema, text) as Provenance | undefined) ?? 'foreign';
}

/**
 * Why a theme folder may not be replaced (or, `update`, re-made by template_update), or null: it must be this tool's,
 * every file as written, none added — and, through MCP (`trust` mcp), made through MCP too (`made_via`: a theme a person
 * made with `retake theme create` or in the Studio is theirs; one whose provenance predates `made_via` is never taken).
 * An update also needs the record it merges from as written (`record_sha256`) and the source of each copy.
 */
export async function replaceProblem(dir: string, trust: BrandTrust = 'author', o: { update?: boolean } = {}): Promise<string | null> {
  const r = await checkedProvenance(dir, trust, o);
  return 'why' in r ? r.why : null;
}

/**
 * replaceProblem's checks, with the provenance record they checked (template_update merges from that one, never from
 * a second read). Before any file is read: every path the record names is a plain relative path, the files it lists are
 * exactly the regular files of the folder (a link, a FIFO or a device refused), its sources among them; each file is
 * then read only as a regular file of at most THEME_FILE_MAX_BYTES and hashed.
 */
export async function checkedProvenance(dir: string, trust: BrandTrust = 'author', o: { update?: boolean } = {}): Promise<{ why: string } | { prov: Provenance }> {
  const no = (why: string) => ({ why });
  const st = await lstat(dir);
  if (!st.isDirectory()) return no(`${dir} is not a folder (a link or a file)`);
  const provFile = THEME_PROVENANCE_FILE;
  const prov = await readProvenance(dir);
  if (prov === 'unreadable') return no(`${dir} was not made by this tool (no readable ${THEME_PROVENANCE_FILE})`);
  if (prov === 'foreign') return no(`${dir}: ${provFile} is not this tool's`);
  const verb = o.update ? 'updated' : 'replaced';
  if (trust === 'mcp' && (prov.trust !== 'mcp' || prov.made_via === 'cli')) return no(`${dir} was made by a human with retake theme create: through MCP only a theme made through MCP is ${verb}`);
  if (trust === 'mcp' && prov.made_via === 'studio') return no(`${dir} was made by a person in the Studio: through MCP only a theme made through MCP is ${verb}`);
  if (trust === 'mcp' && prov.made_via !== 'mcp') {
    return no(
      `${dir} was made before Retake recorded who makes a theme (its ${provFile} has no made_via): through MCP it is no longer ${verb} — make a new theme under another name, or a person replaces it with retake theme create --replace`,
    );
  }
  if (o.update && (prov.inputs === undefined || prov.sources === undefined || prov.record_sha256 !== recordHash(prov as unknown as Record<string, unknown>))) {
    return no(`the record in ${provFile} (its inputs, sources, who made it) was changed since it was made, or is not there: it is not updated from it`);
  }
  const listed = Object.keys(prov.files);
  const named = [...listed, ...Object.keys(prov.sources ?? {})];
  const bad = named.find((f) => !PLAIN_REL.test(f) || f === provFile);
  if (bad !== undefined) return no(`${provFile} names a file outside the theme folder or not a plain path (${JSON.stringify(bad.slice(0, 80))})`);
  const stray = Object.keys(prov.sources ?? {}).find((f) => !listed.includes(f));
  if (stray !== undefined) return no(`${provFile} gives a source for ${stray}, a file it does not list`);
  const { files, odd } = await walk(dir);
  if (odd.length) return no(`${dir} holds links or special files (${odd.join(', ')})`);
  const added = files.filter((f) => f !== provFile && !listed.includes(f));
  if (added.length) return no(`files were added since it was made: ${added.join(', ')}`);
  const gone = listed.find((f) => !files.includes(f));
  if (gone !== undefined) return no(`${gone} was removed since it was made`);
  for (const f of listed) {
    const b = await readThemeFile(join(dir, ...f.split('/')));
    if (!b) return no(`${f} was removed or changed since it was made`);
    if (sha256Hex(b) !== prov.files[f]) return no(`${f} was changed since it was made`);
  }
  return { prov };
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
export async function checkNewName(templatesDir: string, name: NewThemeName, replace: boolean, trust: BrandTrust, o: { update?: boolean } = {}): Promise<{ existing: boolean }> {
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
  const why = await replaceProblem(join(templatesDir, taken), trust, o);
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

/**
 * The logo and the wordmark of a new theme, read and checked, with the names of their copies, and the logo's kind:
 * the input's `logo_kind`, else a wordmark when the logo is 3:1 or wider (components resolveLogoKind) — written into
 * template.yaml then (`written_kind`), so the theme says it whatever reads it.
 */
async function readArtwork(
  input: BrandInput,
  read: (ref: string, kind: 'logo' | 'wordmark') => Promise<ResolvedBrandFile>,
  o: { lib: Awaited<ReturnType<typeof componentCalls>>; warnings: string[]; notes: string[] },
) {
  const { warnings, notes } = o;
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
  // core aspectOf, as the loader reads it: a degenerate size (0, Infinity, beyond 1000:1) is none — a mark.
  const aspect = aspectOf(logoInfo.width, logoInfo.height);
  const logoKind = o.lib.resolveLogoKind(input.logo_kind, aspect);
  const writtenKind = input.logo_kind ?? (logoKind === 'wordmark' ? 'wordmark' : undefined);
  if (input.logo_kind === undefined && logoKind === 'wordmark') {
    notes.push(`the logo is wide (${aspect!.toFixed(1)}:1): drawn as a wordmark — alone, sized by its width (logo_kind: wordmark written; logo_kind: mark draws the brand name beside it)`);
  }
  if (logoKind === 'wordmark' && wordmarkFile)
    warnings.push(`the wordmark image is kept in the theme folder but not drawn by the intro, outro or brand mark while logo_kind is wordmark (the logo is the name)`);
  if (logoKind === 'mark' && !wordmarkFile && input.brand?.name === undefined) warnings.push('no wordmark and no brand.name: the outro shows the logo alone');
  return { logoFile, logoInfo, logoName, logoKind, writtenKind, wordmarkFile, wordmarkInfo, wordmarkName };
}

/**
 * The new theme's palette from the brand colours, over the base theme's tone — and the cursor: the input's, else, when
 * the palette's tone differs from the base's, the arrow of the palette's tone (dark: arrow-light), said in a note (the
 * cursor is filmed over the app, which the palette only approximates). The same tone keeps the base's cursor.
 */
function paletteOver(lib: Awaited<ReturnType<typeof componentCalls>>, o: { input: BrandInput; base: LoadedTemplate; baseName: string; warnings: string[]; notes: string[] }) {
  const { input, base, baseName, warnings, notes } = o;
  const baseTone = lib.paletteTone(base.template.colors.paper.startsWith('#') ? base.template.colors.paper : '#ffffff');
  const palette = lib.derivePalette({ ...input.colors, ...(input.background !== undefined ? { background: input.background } : {}), adjust: input.adjust !== false, tone: baseTone });
  const cursor: { style?: 'arrow-dark' | 'arrow-light'; size?: number } = { ...(input.cursor ?? {}) };
  if (palette.tone !== baseTone && cursor.style === undefined) {
    cursor.style = palette.tone === 'dark' ? 'arrow-light' : 'arrow-dark';
    notes.push(
      `${palette.tone} paper over ${baseName} (a ${baseTone} theme): cursor ${cursor.style} chosen — the cursor is filmed over your app (the next capture): set cursor.style if your app's UI is ${palette.tone === 'dark' ? 'light' : 'dark'}`,
    );
  }
  warnings.push(...palette.warnings);
  return { palette, cursor };
}

/** The base theme's LICENSES.md when a font file comes from it (else undefined; a missing one said and warned). */
async function baseLicencesOf(uniqueFonts: FontPlan[], o: { base: LoadedTemplate; baseName: string; warnings: string[]; own?: string }): Promise<string | undefined> {
  const { base, baseName, warnings } = o;
  let baseLicences: string | undefined;
  const fromBase = uniqueFonts.filter((f) => f.view.weight_from === 'base');
  // template_update: every base font is the theme's own copy — its licences as the theme's LICENSES.md cites them.
  if (fromBase.length && o.own !== undefined && fromBase.every((f) => f.reused)) return o.own;
  if (fromBase.length) {
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
function provenanceOf(o: {
  input: BrandInput;
  now: Date;
  name: string;
  baseName: string;
  trust: BrandTrust;
  via: ThemeMadeVia;
  written: Map<string, Buffer>;
  sources: Record<string, string>;
  createdAt?: string;
}): Provenance {
  const { input, now, name, baseName, written } = o;
  const { replace: _replace, ...inputs } = input;
  const siteId = [input.logo, input.wordmark].map((r) => (r !== undefined ? siteRef(r)?.site_id : undefined)).find((x) => x !== undefined);
  const provenance: Provenance = {
    version: 1,
    made_by: 'retake',
    tool_version: RETAKE_VERSION,
    created_at: o.createdAt ?? now.toISOString(),
    ...(o.createdAt ? { updated_at: now.toISOString() } : {}),
    name,
    base: baseName,
    trust: o.trust,
    made_via: o.via,
    inputs,
    sources: o.sources,
    ...(siteId ? { site_id: siteId } : {}),
    files: Object.fromEntries([...written].map(([f, b]) => [f, sha256Hex(b)])),
  };
  provenance.record_sha256 = recordHash(provenance as unknown as Record<string, unknown>);
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
      // template_update's swap rechecks its own guard (the record as written too).
      recheck: () => checkNewName(templatesDir, name, replace, o.trust, { update: o.reuse !== undefined }),
    });
  } catch (e) {
    throw toEngineError(e);
  }
  return made;
}

/** The new theme's LICENSES.md: its artwork, its fonts and what each declares, the base theme's licences when it copies a base font. */
async function licencesOf(o: {
  name: string;
  base: LoadedTemplate;
  baseName: string;
  date: string;
  logo: { file: string; source: string };
  wordmark?: { file: string; source: string };
  fonts: FontPlan[];
  warnings: string[];
  reuse?: ThemeReuse;
}): Promise<string> {
  const baseLicences = await baseLicencesOf(o.fonts, { base: o.base, baseName: o.baseName, warnings: o.warnings, ...(o.reuse?.baseLicences !== undefined ? { own: o.reuse.baseLicences } : {}) });
  const names = new Map(o.fonts.filter((f) => f.names).map((f) => [f.view.file, f.names!]));
  return licencesMarkdown({
    name: o.name,
    base: o.baseName,
    date: o.date,
    logo: o.logo,
    ...(o.wordmark ? { wordmark: o.wordmark } : {}),
    fonts: o.fonts.map((f) => f.view),
    names,
    ...(baseLicences !== undefined ? { baseLicences } : {}),
  });
}

/** The new theme's template.yaml (components generateThemeFile), checked; what it kept or removed of the base said. */
function themeFileOf(
  lib: Awaited<ReturnType<typeof componentCalls>>,
  o: {
    input: BrandInput;
    baseFile: TemplateFile;
    baseName: string;
    name: string;
    palette: Palette;
    cursor: { style?: 'arrow-dark' | 'arrow-light'; size?: number };
    logoName: string;
    writtenKind?: 'mark' | 'wordmark';
    wordmarkName?: string;
    fonts: { display: string; body: string[] };
    date: string;
    warnings: string[];
    notes: string[];
  },
) {
  const { input, baseName } = o;
  let generated: ReturnType<typeof lib.generateThemeFile>;
  try {
    generated = lib.generateThemeFile({
      base: o.baseFile,
      baseName,
      name: o.name,
      palette: o.palette,
      logo: o.logoName,
      ...(o.writtenKind ? { logo_kind: o.writtenKind } : {}),
      ...(o.wordmarkName ? { wordmark: o.wordmarkName } : {}),
      fonts: o.fonts,
      ...(input.brand ? { brand: input.brand } : {}),
      ...(input.components ? { components: input.components } : {}),
      ...(Object.keys(o.cursor).length ? { cursor: o.cursor } : {}),
      date: o.date,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'ThemeComponentsError') throw new EngineError('invalid', e.message);
    throw e;
  }
  if (generated.kept_colors.length) o.warnings.push(`colour keys of ${baseName} kept as they were: ${generated.kept_colors.join(', ')}`);
  if (generated.removed_legacy.length) o.notes.push(`legacy fields of ${baseName} the components given replace, removed: ${generated.removed_legacy.join(', ')}`);
  const check = parseTemplateYaml(generated.yaml);
  if (check.issues.length) throw new EngineError('internal', `the generated template.yaml does not validate: ${check.issues.map((i) => i.message).join('; ')}`);
  return generated;
}

/** The input reference each copy came from (provenance `sources`): `logo:` / `wordmark:` / `font:<ref>`, a base font's `base:<theme>/<file>`. */
function copySources(input: BrandInput, o: { logoName: string; wordmarkName?: string; fonts: FontPlan[] }): Record<string, string> {
  const sources: Record<string, string> = { [o.logoName]: `logo:${input.logo}` };
  if (o.wordmarkName && input.wordmark !== undefined) sources[o.wordmarkName] = `wordmark:${input.wordmark}`;
  for (const f of o.fonts) sources[f.view.file] = f.view.weight_from === 'base' ? f.view.source : `font:${f.view.source}`;
  return sources;
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
  await checkNewName(templatesDir, name, replace, o.trust, { update: o.reuse !== undefined });
  const baseName = input.base ?? DEFAULT_BRAND_BASE;
  checkTemplateName(baseName);
  if (baseName.toLowerCase() === name.toLowerCase()) throw new EngineError('invalid', `the base theme cannot be the theme being created (${name})`);

  // The base: its components, frame, captions, motion and durations; its fonts when none are given.
  const { base, baseFile } = await loadBase(ws, baseName);

  const lib = await componentCalls();
  const warnings: string[] = [];
  const notes: string[] = [];
  const budget = { left: BRAND_TOTAL_MAX_BYTES };
  // template_update: the theme's own copy of a file its patch does not name (never the original reference again).
  const read = async (ref: string, kind: 'logo' | 'wordmark' | 'font') => {
    const own = o.reuse?.file(ref, kind);
    if (!own) return readBrandFile(ws, ref, kind, { trust: o.trust, ...(o.cwd ? { cwd: o.cwd } : {}), budget });
    // A reused copy counts against the brand budget as the file it was copied from did.
    if (own.bytes.length > budget.left) throw new EngineError('invalid', `the brand files are more than ${BRAND_TOTAL_MAX_BYTES} bytes together`);
    budget.left -= own.bytes.length;
    return own;
  };

  // Logo and wordmark.
  const { logoFile, logoInfo, logoName, logoKind, writtenKind, wordmarkFile, wordmarkInfo, wordmarkName } = await readArtwork(input, read, { lib, warnings, notes });

  // Fonts: the brand's (sniffed, renamed by role and weight), else the base's (copied as they are).
  const { fonts, display, body } = await planThemeFonts({ input, base, baseName, lib, read, warnings, ...(o.reuse ? { reuseBase: o.reuse.base } : {}) });

  // Palette.
  const { palette, cursor } = paletteOver(lib, { input, base, baseName, warnings, notes });

  const uniqueFonts = [...new Map(fonts.map((f) => [f.view.file, f])).values()];
  const generated = themeFileOf(lib, {
    input,
    baseFile,
    baseName,
    name,
    palette,
    cursor,
    logoName,
    ...(writtenKind ? { writtenKind } : {}),
    ...(wordmarkName ? { wordmarkName } : {}),
    fonts: { display: display.view.file, body: body.map((b) => b.view.file) },
    date,
    warnings,
    notes,
  });

  const logo = { file: logoName, source: input.logo, ...logoInfo };
  const wordmark = wordmarkFile && wordmarkName ? { file: wordmarkName, source: input.wordmark!, ...wordmarkInfo! } : undefined;
  const licences = await licencesOf({ name, base, baseName, date, logo, ...(wordmark ? { wordmark } : {}), fonts: uniqueFonts, warnings, ...(o.reuse ? { reuse: o.reuse } : {}) });

  const written = new Map<string, Buffer>([
    [TEMPLATE_FILE, Buffer.from(generated.yaml)],
    [logoName, logoFile.bytes],
    ...(wordmarkFile && wordmarkName ? [[wordmarkName, wordmarkFile.bytes] as [string, Buffer]] : []),
    ...uniqueFonts.map((f) => [f.view.file, f.bytes] as [string, Buffer]),
    ['LICENSES.md', Buffer.from(licences)],
  ]);
  const sources = copySources(input, { logoName, ...(wordmarkName ? { wordmarkName } : {}), fonts: uniqueFonts });
  const via = o.via ?? (o.trust === 'author' ? 'cli' : 'mcp');
  const provenance = provenanceOf({ input, now, name, baseName, trust: o.trust, via, written, sources, ...(o.reuse ? { createdAt: o.reuse.created_at } : {}) });

  const made = await buildThemeFolder(ws, o, { templatesDir, name, replace, baseName, provenance, written, yaml: generated.yaml });
  const final = made.dir;
  return {
    name,
    dir: final,
    base: baseName,
    replaced: made.replaced,
    ...(o.reuse ? { changed: o.reuse.changed } : {}),
    files: [...written.keys(), THEME_PROVENANCE_FILE],
    template_yaml: generated.yaml,
    palette,
    logo,
    logo_kind: logoKind,
    ...(wordmark ? { wordmark } : {}),
    fonts: fonts.map((f) => f.view),
    warnings,
    ...(notes.length ? { notes } : {}),
    untrusted: { fonts: uniqueFonts.filter((f) => f.names && Object.keys(f.names).length).map((f) => ({ file: f.view.file, ...f.names! })) },
  };
}
