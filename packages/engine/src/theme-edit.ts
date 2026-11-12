/**
 * The Studio's theme write path (L4.7, R-UI-07; critique B7, B14, B15 and D A2): one theme as its editor sees it
 * (`templates.view`) and one verified write of its template.yaml (`templates.edit`). MCP never edits a theme (refused
 * here too, whatever the transport); the CLI does not need to (a person edits the file).
 *
 * - Editable by real path, never by `source` (critique B15: a workspace whose templates_dir is the starters folder lists
 *   them as `workspace`): the theme folder must be a real folder (no link) directly in templates_dir, which lies inside
 *   the workspace, outside the Retake package; its template.yaml a regular file with one name (no symbolic or hard
 *   link). Starters, a project's own folder theme and anything else are read-only with why ("Copy to edit").
 * - A write: the hash the page read (`if_match`, a conflict otherwise naming the current one); the edit built by core
 *   applyThemeEdit (allow-list, `from`, splice) and verified (re-parsed, exactly the intended value); no hidden
 *   character added on a changed line; the theme re-parsed (no error), every file it names a regular file inside its
 *   folder with no link on the way (logo / wordmark checked as images — SVGs scanned —, fonts sniffed), the registry
 *   resolving every kind (kept params validated against the new component); then written atomically under the storage
 *   write lock keyed on the file's real path (workspace `.retake/locks/`), its mode kept.
 * - Undo / redo (critique B14): `restore` sends the bytes and their sha256, accepted only for a version this process
 *   showed (view) or wrote — never text a page made up; a restored version skips only the hidden-character check (it was
 *   on disk once) and passes every other check again.
 * - The view is path-free (files relative to the theme folder); a font's name table and anything else a file's maker
 *   wrote is under `untrusted`.
 */
import { readdirSync, statSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseYaml, pathInside } from '@retake/core/base';
import { COMPONENT_KINDS } from '@retake/core/model';
import { realPathOf } from '@retake/core/policy';
import { projectPath } from '@retake/core/project';
import { StepEditError, insideFolder, isTemplatePath, newHiddenCharProblem, verifyEditText } from '@retake/core/scenario';
import { TEMPLATE_FILE, THEME_EDIT_MAX_CHARS, THEME_FIELD_PATHS, applyThemeEdit, isTemplateMediaRef, parseTemplateYaml } from '@retake/core/theme';
import { STARTER_TEMPLATES_DIR, listTemplates, loadProjectTemplate, loadTemplate, readPlainFile, nodeFileFacts, fileFacts } from '@retake/core/io';
import type { ComponentKind, Template } from '@retake/core/model';
import type { TemplateEntry, ThemeEdit, ThemeField } from '@retake/core/theme';
import type { PaletteCheck } from '@retake/components';
import { FONT_MAX_BYTES, IMAGE_MAX_BYTES, SVG_MAX_BYTES, checkImage, sniffFont } from './brand/files.js';
import { components, workspaceRegistry } from './components.js';
import { callerOf, editsThemes } from './caller.js';
import type { Caller, EngineClient } from './caller.js';
import { EngineError, toEngineError } from './errors.js';
import { listProjectSummaries, openProjectBySlug } from './projects.js';
import { sha256Hex } from './storage.js';
import type { StoreScope } from './store/store.js';
import { checkTemplateName } from './templates.js';
import type { OpenedWorkspace } from './workspace.js';

/** The Retake package (the repository or its install folder): its themes are shipped files, never edited. */
const PACKAGE_DIR = resolve(STARTER_TEMPLATES_DIR, '..');
/** Files a theme folder view lists, at most (a theme is a handful of files). */
const THEME_FILES_MAX = 2_000;
const THEME_DEPTH_MAX = 4;
const SCENARIO_READ_MAX = 512 * 1024;
const IMAGE_RE = /\.(svg|png|jpe?g|webp)$/i;
const FONT_RE = /\.(ttf|otf|woff2?)$/i;

export type ThemeEditable = true | { why: string };

/** Where a theme is and whether the Studio may write it (critique B15: by real path). */
interface ThemeLocation {
  entry: TemplateEntry;
  editable: ThemeEditable;
  /** The folder's and template.yaml's real paths. */
  realDir: string;
  realFile: string;
}

// The versions of each template.yaml this process showed (view) or wrote: undo / redo restore only these (critique B14).
const VERSIONS_PER_FILE = 128;
const VERSION_FILES = 256;
const versions = new Map<string, string[]>();

function rememberVersion(realFile: string, hash: string): void {
  const list = versions.get(realFile) ?? [];
  versions.delete(realFile);
  const at = list.indexOf(hash);
  if (at !== -1) list.splice(at, 1);
  list.push(hash);
  if (list.length > VERSIONS_PER_FILE) list.shift();
  versions.set(realFile, list);
  if (versions.size > VERSION_FILES) versions.delete(versions.keys().next().value!);
}

/** Whether this process showed or wrote that version of a theme's template.yaml (its real path). */
export function knownThemeVersion(realFile: string, hash: string): boolean {
  return versions.get(realFile)?.includes(hash) ?? false;
}

/** The theme `name` of the workspace (a listed name, never a path) and whether the Studio may edit it. */
async function locateTheme(ws: OpenedWorkspace, name: string): Promise<ThemeLocation> {
  checkTemplateName(name);
  const entry = (await listTemplates(ws.root)).find((e) => e.name === name);
  if (!entry) throw new EngineError('not_found', `theme "${name}" not found (the themes list names them)`);
  const realDir = realPathOf(entry.dir, nodeFileFacts);
  const realFile = realPathOf(join(entry.dir, TEMPLATE_FILE), nodeFileFacts);
  return { entry, realDir, realFile, editable: await editability(ws, entry, realDir) };
}

/** Why the Studio may not write this theme (critique B15), or true. */
async function editability(ws: OpenedWorkspace, entry: TemplateEntry, realDir: string): Promise<ThemeEditable> {
  if (entry.source === 'starter') return { why: `${entry.name} is a starter theme shipped with Retake: copy it to edit it` };
  if (pathInside(realDir, realPathOf(PACKAGE_DIR, nodeFileFacts), { dotDotPrefix: true }))
    return { why: `${entry.name} is a theme shipped with Retake (its folder lies in the Retake package): copy it to edit it` };
  const realRoot = realPathOf(resolve(ws.root), nodeFileFacts);
  const realTemplates = realPathOf(resolve(ws.templatesDir), nodeFileFacts);
  if (!pathInside(realTemplates, realRoot, { dotDotPrefix: true }))
    return { why: `templates_dir lies outside the workspace: the Studio edits themes of the workspace only — edit ${entry.name} by hand` };
  try {
    const st = await lstat(entry.dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { why: `${entry.name} is a link to another folder: the Studio edits only real theme folders — edit it by hand` };
  } catch {
    return { why: `${entry.name} cannot be read` };
  }
  if (relative(realTemplates, realDir) !== entry.name) return { why: `${entry.name} does not lie in templates_dir once links are followed: edit it by hand` };
  try {
    const st = await lstat(join(entry.dir, TEMPLATE_FILE));
    if (st.isSymbolicLink()) return { why: `${entry.name}/template.yaml is a symbolic link: the Studio writes only a theme's own file — edit it by hand` };
    if (!st.isFile()) return { why: `${entry.name}/template.yaml is not a regular file` };
    if (st.nlink > 1) return { why: `${entry.name}/template.yaml has another name (a hard link): a write would change the other file too — edit it by hand` };
  } catch {
    return { why: `${entry.name} has no template.yaml` };
  }
  return true;
}

/** template.yaml of a located theme, read without following a link: text, sha256, UTF-8 or not. */
function readThemeText(loc: ThemeLocation): { text: string; sha256: string; utf8: boolean; unread?: string } {
  const r = readPlainFile(join(loc.realDir, TEMPLATE_FILE), 4 * THEME_EDIT_MAX_CHARS);
  if (!r.ok) {
    if (r.reason === 'missing') throw new EngineError('not_found', `theme ${loc.entry.name} has no template.yaml`);
    // Larger than the Studio edits, a link, not a regular file: shown read-only (textBlocker says why).
    return { text: '', sha256: '', utf8: false, unread: r.reason === 'too_large' ? 'larger than the Studio edits' : r.reason === 'link' ? 'a symbolic link' : 'not a regular file' };
  }
  const buf = r.bytes;
  return { text: buf.toString('utf8'), sha256: sha256Hex(buf), utf8: Buffer.from(buf.toString('utf8'), 'utf8').equals(buf) };
}

/** Why template.yaml's text is not one the Studio writes over (it is then shown read-only), or null. */
function textBlocker(name: string, t: { text: string; utf8: boolean; sha256: string; unread?: string }): string | null {
  if (t.unread !== undefined) return `${name}/template.yaml is ${t.unread}: edit it by hand`;
  if (!t.utf8) return `${name}/template.yaml is not UTF-8 text: saving it here would replace the bytes that cannot be read — edit it by hand`;
  if (t.text.length > THEME_EDIT_MAX_CHARS)
    return `${name}/template.yaml holds ${t.text.length.toLocaleString('en')} characters: the Studio edits themes of at most ${THEME_EDIT_MAX_CHARS.toLocaleString('en')} — edit it by hand`;
  const cr = /\r(?!\n)/.exec(t.text);
  if (cr) return `${name}/template.yaml holds a carriage return without a line feed (line ${t.text.slice(0, cr.index).split('\n').length}): fix its line breaks in your editor`;
  return null;
}

/**
 * Why a file a theme names may not be served (a logo, a wordmark, a font): a relative path whose every segment below
 * the theme folder is a real folder / a regular file (no symbolic link on the way), with one name (no hard link), inside
 * the folder, within its size cap, and its bytes what its role needs (images: magic, size, the SVG scan; fonts: a
 * signature). Null when it may.
 */
export async function themeFileProblem(realDir: string, rel: string, role: 'logo' | 'wordmark' | 'font'): Promise<string | null> {
  if (typeof rel !== 'string' || isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === '..' || s === '' || s.startsWith('.'))) return `${rel} is not a file of the theme folder`;
  const segs = rel.split('/');
  let p = realDir;
  for (let i = 0; i < segs.length; i++) {
    p = join(p, segs[i]);
    let st;
    try {
      st = await lstat(p);
    } catch {
      return `${rel} does not exist in the theme folder`;
    }
    if (st.isSymbolicLink()) return `${rel} goes through a symbolic link: a theme serves only its own files`;
    if (i < segs.length - 1 && !st.isDirectory()) return `${rel} is not a file of the theme folder`;
    if (i === segs.length - 1) {
      if (!st.isFile()) return `${rel} is not a regular file`;
      if (st.nlink > 1) return `${rel} has another name (a hard link): a theme serves only its own files`;
    }
  }
  if (!insideFolder(realDir, p, nodeFileFacts)) return `${rel} lies outside the theme folder`;
  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
  const max = role === 'font' ? FONT_MAX_BYTES : ext === '.svg' ? SVG_MAX_BYTES : IMAGE_MAX_BYTES;
  const r = readPlainFile(p, max);
  if (!r.ok) return `${rel} cannot be read (${r.reason === 'too_large' ? `larger than ${max.toLocaleString('en')} bytes` : r.reason})`;
  try {
    if (role === 'font') sniffFont({ ref: rel, ext, bytes: r.bytes }, 'the font');
    else checkImage({ ref: rel, ext, bytes: r.bytes }, `the ${role}`);
  } catch (e) {
    return toEngineError(e).message;
  }
  return null;
}

/** The files a theme names (merged over the defaults: what a render loads), each with its role. */
function namedFiles(t: Template): Array<{ rel: string; role: 'logo' | 'wordmark' | 'font' }> {
  return [
    { rel: t.logo, role: 'logo' as const },
    ...(t.wordmark ? [{ rel: t.wordmark, role: 'wordmark' as const }] : []),
    { rel: t.fonts.display, role: 'font' as const },
    ...t.fonts.body.map((rel) => ({ rel, role: 'font' as const })),
  ];
}

export interface ThemeComponentView {
  /** How template.yaml writes the kind: absent (a legacy field or the default), none (null), an id, an id with params, the theme's own file, or another form. */
  written: 'absent' | 'none' | 'id' | 'params' | 'file' | 'other';
  id?: string;
  params?: Record<string, unknown>;
  /** What a render uses (the registry's resolution, defaults applied), null for none. */
  resolved: { id: string; params: Record<string, unknown> } | null;
}

export interface ThemeEditView {
  name: string;
  source: TemplateEntry['source'];
  editable: ThemeEditable;
  /** sha256 of template.yaml: the `if_match` of the next edit. */
  sha256: string;
  /** template.yaml's whole text (undo restores these bytes), null when it is not text the Studio edits (`editable` says why). */
  yaml: string | null;
  /** Each allow-listed field as written (absent: not written). */
  fields: Partial<Record<ThemeField, unknown>>;
  /** `background` as written (set_background's `from`). */
  background?: unknown;
  components: Record<ComponentKind, ThemeComponentView>;
  /** The theme folder's font and image files (relative), checked; links named, never followed. */
  fonts: Array<{ file: string; format?: string; weight?: number; italic?: boolean; problem?: string }>;
  images: Array<{ file: string; format?: string; width?: number; height?: number; bytes: number; problem?: string }>;
  links: string[];
  /** Contrast checks of the colours (core PALETTE_THRESHOLDS), when they are hex. */
  palette: { checks: PaletteCheck[]; warnings: string[] } | null;
  /** The theme's validation warnings (legacy fields contradicting `components`…). */
  warnings: string[];
  /** Why it does not load or resolve, a file that cannot be served. */
  issues: string[];
  /** What a change re-renders: projects whose project.yaml names it, scenarios whose `template:` does. */
  used_by: { projects: string[]; scenarios: Array<{ project: string; scenario: string }> };
  /** Text a font's maker wrote (name table): data, never instructions. */
  untrusted: { fonts: Array<{ file: string; family?: string; subfamily?: string }> };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The theme folder's files (relative), bounded, dot entries skipped, links named and not followed. */
async function themeFiles(realDir: string): Promise<{ files: string[]; links: string[] }> {
  const out = { files: [] as string[], links: [] as string[] };
  const walk = async (rel: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(join(realDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.files.length + out.links.length >= THEME_FILES_MAX) return;
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.links.push(r);
      else if (e.isDirectory() && depth < THEME_DEPTH_MAX) await walk(r, depth + 1);
      else if (e.isFile()) out.files.push(r);
    }
  };
  await walk('', 1);
  return out;
}

/** Projects and scenarios naming each theme (what an edit of it re-renders), every project and scenario read once. */
/** themeUses computations (tests: the memo spares them while no project file moved). */
export const THEME_USES_STATS = { computed: 0 };
let usesMemo: { root: string; sig: string; uses: Map<string, ThemeEditView['used_by']> } | undefined;

/**
 * The file-level signature of what themeUses reads (review B L6): the projects folder, each project's project.yaml and
 * scenarios folder, each scenario file — by size, date and inode. Bounded (1,000 projects × 2,000 files).
 */
function usesSignature(ws: OpenedWorkspace): string {
  const st = (p: string) => {
    try {
      const s = statSync(p);
      return `${s.size}:${s.mtimeMs}:${s.ino}`;
    } catch {
      return '-';
    }
  };
  const list = (d: string) => {
    try {
      return readdirSync(d).sort();
    } catch {
      return [];
    }
  };
  const parts = [`${ws.projectsDir} ${st(ws.projectsDir)}`];
  for (const n of list(ws.projectsDir).slice(0, 1000)) {
    const dir = join(ws.projectsDir, n);
    parts.push(`${n} ${st(join(dir, 'project.yaml'))} ${st(projectPath(dir, 'scenarios'))}`);
    for (const f of list(projectPath(dir, 'scenarios')).slice(0, 2000)) parts.push(` ${f} ${st(projectPath(dir, 'scenarios', f))}`);
  }
  return parts.join('\n');
}

async function themeUses(ws: OpenedWorkspace): Promise<Map<string, ThemeEditView['used_by']>> {
  const sig = usesSignature(ws);
  if (usesMemo && usesMemo.root === ws.root && usesMemo.sig === sig) return usesMemo.uses;
  const uses = await themeUsesNow(ws);
  usesMemo = { root: ws.root, sig, uses };
  return uses;
}

async function themeUsesNow(ws: OpenedWorkspace): Promise<Map<string, ThemeEditView['used_by']>> {
  THEME_USES_STATS.computed++;
  const out = new Map<string, ThemeEditView['used_by']>();
  const of = (name: string) => {
    let u = out.get(name);
    if (!u) out.set(name, (u = { projects: [], scenarios: [] }));
    return u;
  };
  for (const p of await listProjectSummaries(ws)) {
    if (p.error) continue;
    let project;
    try {
      project = await openProjectBySlug(ws, p.slug);
    } catch {
      continue;
    }
    if (typeof project.config.template === 'string') of(project.config.template).projects.push(p.slug);
    for (const s of project.scenarios) {
      const r = readPlainFile(projectPath(project.dir, 'scenarios', `${s}.yaml`), SCENARIO_READ_MAX);
      const r2 = r.ok ? r : readPlainFile(projectPath(project.dir, 'scenarios', `${s}.yml`), SCENARIO_READ_MAX);
      if (!r2.ok) continue;
      const v = parseYaml(r2.bytes.toString('utf8')).value;
      if (isObj(v) && typeof v.template === 'string') of(v.template).scenarios.push({ project: p.slug, scenario: s });
    }
  }
  return out;
}

/** Projects and scenarios that name the theme (what an edit of it re-renders). */
async function usedBy(ws: OpenedWorkspace, name: string): Promise<ThemeEditView['used_by']> {
  return (await themeUses(ws)).get(name) ?? { projects: [], scenarios: [] };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** One theme as its editor shows it (see the header); remembers the version shown (undo restores only those). */
export async function templateView(ws: OpenedWorkspace, name: string): Promise<ThemeEditView> {
  const loc = await locateTheme(ws, name);
  const read = readThemeText(loc);
  const blocker = textBlocker(name, read);
  const editable: ThemeEditable = loc.editable !== true ? loc.editable : blocker ? { why: blocker } : true;
  if (read.sha256) rememberVersion(loc.realFile, read.sha256);
  const value = read.utf8 ? parseYaml(read.text).value : undefined;
  const root = isObj(value) ? value : {};
  const fields: ThemeEditView['fields'] = {};
  for (const f of THEME_FIELD_PATHS) {
    let cur: unknown = root;
    for (const k of f.split('.')) cur = isObj(cur) ? cur[k] : undefined;
    if (cur !== undefined && cur !== null) fields[f] = cur;
  }
  const parsed = read.utf8 ? parseTemplateYaml(read.text, { dir: loc.realDir, files: fileFacts(ws.policy) }) : { issues: [], template: undefined };
  const issues: string[] = parsed.issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = parsed.issues.filter((i) => i.severity === 'warning').map((i) => `${i.path.join('.')}: ${i.message}`);
  const comps = isObj(root.components) ? root.components : {};
  const componentsView = {} as Record<ComponentKind, ThemeComponentView>;
  let resolved: Partial<Record<ComponentKind, { id: string; params: Record<string, unknown> } | null>> = {};
  const lib = await components();
  if (parsed.template) {
    parsed.template.name ??= name;
    try {
      const r = (await workspaceRegistry(ws)).resolveTheme(parsed.template);
      resolved = Object.fromEntries(COMPONENT_KINDS.map((k) => [k, r[k] ? { id: r[k]!.id, params: r[k]!.params } : null]));
    } catch (e) {
      issues.push(toEngineError(e).message);
    }
    for (const f of namedFiles(parsed.template)) {
      const p = await themeFileProblem(loc.realDir, f.rel, f.role);
      if (p) issues.push(`${f.role}: ${p}`);
    }
  }
  for (const kind of COMPONENT_KINDS) {
    const w = comps[kind];
    const view: ThemeComponentView =
      w === undefined
        ? { written: 'absent', resolved: null }
        : w === null
          ? { written: 'none', resolved: null }
          : typeof w === 'string'
            ? { written: 'id', id: w, resolved: null }
            : isObj(w) && typeof w.id === 'string'
              ? { written: 'params', id: w.id, ...(isObj(w.params) ? { params: w.params } : {}), resolved: null }
              : isTemplateMediaRef(w as never)
                ? { written: 'file', resolved: null }
                : { written: 'other', resolved: null };
    view.resolved = resolved[kind] ?? null;
    componentsView[kind] = view;
  }
  const { files, links } = await themeFiles(loc.realDir);
  const fonts: ThemeEditView['fonts'] = [];
  const images: ThemeEditView['images'] = [];
  const untrustedFonts: ThemeEditView['untrusted']['fonts'] = [];
  for (const file of files) {
    if (FONT_RE.test(file)) {
      const r = readPlainFile(join(loc.realDir, ...file.split('/')), FONT_MAX_BYTES);
      if (!r.ok) {
        fonts.push({ file, problem: `cannot be read (${r.reason})` });
        continue;
      }
      try {
        const info = sniffFont({ ref: file, ext: file.slice(file.lastIndexOf('.')).toLowerCase(), bytes: r.bytes });
        const face = lib.fontFileFace(join(loc.realDir, ...file.split('/')));
        fonts.push({ file, format: info.format, weight: info.weight ?? face.weight, italic: info.italic ?? face.style === 'italic' });
        if (info.names.family || info.names.subfamily)
          untrustedFonts.push({ file, ...(info.names.family ? { family: info.names.family.slice(0, 120) } : {}), ...(info.names.subfamily ? { subfamily: info.names.subfamily.slice(0, 120) } : {}) });
      } catch (e) {
        fonts.push({ file, problem: toEngineError(e).message });
      }
    } else if (IMAGE_RE.test(file)) {
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      const r = readPlainFile(join(loc.realDir, ...file.split('/')), ext === '.svg' ? SVG_MAX_BYTES : IMAGE_MAX_BYTES);
      if (!r.ok) {
        images.push({ file, bytes: r.size ?? 0, problem: `cannot be read (${r.reason})` });
        continue;
      }
      try {
        const info = checkImage({ ref: file, ext, bytes: r.bytes }, 'image');
        images.push({ file, format: info.format, ...(info.width !== undefined ? { width: info.width } : {}), ...(info.height !== undefined ? { height: info.height } : {}), bytes: r.bytes.length });
      } catch (e) {
        images.push({ file, bytes: r.bytes.length, problem: toEngineError(e).message });
      }
    }
  }
  let palette: ThemeEditView['palette'] = null;
  const c = parsed.template?.colors;
  if (c && [c.accent, c.text, c.muted, c.paper].every((x) => HEX.test(x)) && (c.dark === undefined || HEX.test(c.dark))) {
    const bg = parsed.template!.background;
    const background =
      bg.type === 'solid'
        ? bg.color && HEX.test(bg.color)
          ? bg.color
          : undefined
        : bg.from && bg.to && HEX.test(bg.from) && HEX.test(bg.to)
          ? { type: bg.type, from: bg.from, to: bg.to }
          : undefined;
    const p = lib.derivePalette({
      accent: c.accent,
      text: c.text,
      muted: c.muted,
      paper: c.paper,
      ...(c.dark !== undefined ? { dark: c.dark } : {}),
      ...(background !== undefined ? { background } : {}),
      adjust: false,
    });
    palette = { checks: p.checks, warnings: p.warnings };
  }
  return {
    name,
    source: loc.entry.source,
    editable,
    sha256: read.sha256,
    yaml: blocker ? null : read.text,
    fields,
    ...(root.background !== undefined ? { background: root.background } : {}),
    components: componentsView,
    fonts,
    images,
    links,
    palette,
    warnings,
    issues,
    used_by: await usedBy(ws, name),
    untrusted: { fonts: untrustedFonts },
  };
}

export interface ThemeEditRequest {
  /** sha256 of template.yaml as the page read it (view): a conflict otherwise, naming the current one. */
  if_match: string;
  edit: ThemeEdit;
}

export interface ThemeEditResult {
  name: string;
  /** sha256 of the bytes written: the next edit's if_match. */
  sha256: string;
  label: string;
  /** Legacy fields the write removed (named in the confirmation; undo restores them). */
  removed: string[];
  kept_params?: Record<string, unknown>;
  dropped_params?: string[];
  /** The theme's validation warnings and its palette's, after the write. */
  warnings: string[];
}

/**
 * The theme-edit caller rule (editsThemes): MCP is refused — themes are never edited through it. theme_edit's `callers`
 * (operations/themes.ts: checked after the parse, before the theme is read) and editTemplate's own first check, in the
 * same words.
 */
export function themeEditRefused(c: Caller): EngineError | undefined {
  return editsThemes(c) ? undefined : new EngineError('refused', 'themes are never edited through MCP: a person edits them in the Studio or by hand (template_create_from_brand makes new ones)');
}

/**
 * One write of a theme from the Studio (see the header). `client` is the engine's: MCP is refused (themes are never
 * edited through it). Errors: conflict (if_match; a value changed since the page read it: `details.stale`), refused
 * (not editable, a file the theme may not serve, not a known version), invalid (the edit or its value).
 */
export async function editTemplate(ws: OpenedWorkspace, name: string, req: ThemeEditRequest, o: { client: EngineClient; scope: StoreScope }): Promise<ThemeEditResult> {
  const refused = themeEditRefused(callerOf(o.client));
  if (refused) throw refused;
  const loc = await locateTheme(ws, name);
  if (loc.editable !== true) throw new EngineError('refused', `not saved: ${loc.editable.why}`);
  const base = readThemeText(loc);
  const blocker = textBlocker(name, base);
  if (blocker) throw new EngineError('refused', `not saved: ${blocker}`);
  if (typeof req?.if_match !== 'string' || req.if_match !== base.sha256) {
    throw new EngineError('conflict', `${name}/template.yaml changed since it was read (its hash is no longer the one the edit was made on): read it again`, { details: { current: base.sha256 } });
  }
  const edit = req.edit;
  let text: string;
  let label: string;
  let removed: string[] = [];
  let extra: Pick<ThemeEditResult, 'kept_params' | 'dropped_params'> = {};
  if (edit?.kind === 'restore') {
    if (typeof edit.text !== 'string' || sha256Hex(edit.text) !== edit.text_hash) {
      throw new EngineError('invalid', 'the text to restore is not the version named by text_hash: nothing written', { details: { argument: 'edit.text_hash' } });
    }
    if (!knownThemeVersion(loc.realFile, edit.text_hash)) {
      throw new EngineError('refused', `the text to restore is not a version of ${name}/template.yaml the Studio showed or wrote: nothing written — read the theme again`, {
        details: { argument: 'edit.text_hash' },
      });
    }
    text = edit.text;
    label = 'Restored an earlier version';
  } else {
    let applied;
    try {
      applied = applyThemeEdit(base.text, edit);
    } catch (e) {
      if (!(e instanceof StepEditError)) throw e;
      const field = e.field !== undefined ? { field: e.field } : {};
      if (e.code === 'stale') throw new EngineError('conflict', `not saved: ${e.message}`, { details: { current: base.sha256, stale: true, ...field } });
      throw new EngineError(e.code === 'invalid' ? 'invalid' : 'refused', `not saved: ${e.message}`, e.field !== undefined ? { details: field } : {});
    }
    const wrong = verifyEditText(applied.text, applied.intended);
    if (wrong) throw new EngineError('refused', `not saved: ${wrong}`);
    ({ text, label, removed } = applied);
    extra = { ...(applied.kept_params ? { kept_params: applied.kept_params } : {}), ...(applied.dropped_params ? { dropped_params: applied.dropped_params } : {}) };
    const hidden = newHiddenCharProblem(text, base.text);
    if (hidden) throw new EngineError('invalid', `not saved: ${hidden}`);
  }
  if (text.length > THEME_EDIT_MAX_CHARS) throw new EngineError('invalid', `not saved: the theme would hold more than ${THEME_EDIT_MAX_CHARS.toLocaleString('en')} characters`);
  // The theme as a render will load it: valid, every file it names served from its own folder, every kind resolved.
  const parsed = parseTemplateYaml(text, { dir: loc.realDir, files: fileFacts(ws.policy) });
  const errors = parsed.issues.filter((i) => i.severity === 'error');
  if (!parsed.template || errors.length)
    throw new EngineError(
      'invalid',
      `not saved: the theme would not validate (${errors
        .map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`)
        .slice(0, 3)
        .join('; ')})`,
    );
  parsed.template.name ??= name;
  for (const f of namedFiles(parsed.template)) {
    const p = await themeFileProblem(loc.realDir, f.rel, f.role);
    if (p) throw new EngineError('refused', `not saved: the ${f.role} ${p}`, { details: { file: f.rel } });
  }
  try {
    (await workspaceRegistry(ws)).resolveTheme(parsed.template);
  } catch (e) {
    throw new EngineError('invalid', `not saved: ${toEngineError(e).message}`);
  }
  const realRoot = realPathOf(resolve(ws.root), nodeFileFacts);
  const ref = relative(realRoot, loc.realFile).split(sep).join('/');
  const res = await o.scope.stores.at(realRoot, o.scope).writeText(ref, text, { ifMatch: base.sha256, what: 'theme' });
  rememberVersion(loc.realFile, base.sha256);
  rememberVersion(loc.realFile, res.sha256);
  const warnings = parsed.issues.filter((i) => i.severity === 'warning').map((i) => `${i.path.join('.')}: ${i.message}`);
  return { name, sha256: res.sha256, label, removed, ...extra, warnings };
}

/** One theme of the Studio's theme list (editable or read-only by real path, critique B15). */
export interface ThemeListItem {
  name: string;
  /** `project`: the project's own theme folder (project.yaml names a path) — never edited nor copied from the Studio. */
  source: TemplateEntry['source'] | 'project';
  /** The project's theme (with a project). */
  default?: true;
  editable: ThemeEditable;
  /** Its colours as written, hex only (the list's swatches). */
  colors: { accent?: string; text?: string; paper?: string };
  /** Why it does not load (its first problems). */
  issues: string[];
  used_by: ThemeEditView['used_by'];
}

export interface ThemeEditList {
  themes: ThemeListItem[];
  /** With a project: its theme as project.yaml names it. */
  project_theme?: string;
}

/**
 * Every theme of the workspace as the Studio's theme list shows it: the listed ones (workspace, starters), each
 * editable or read-only with why — decided by real path (critique B15), the starters and anything in the package
 * read-only ("Copy to edit") —, and with a project its own theme folder (read-only: edit it by hand). Path-free.
 */
export async function themeEditList(ws: OpenedWorkspace, projectSlug?: string): Promise<ThemeEditList> {
  const project = projectSlug !== undefined ? await openProjectBySlug(ws, projectSlug) : undefined;
  const own = typeof project?.config.template === 'string' ? project.config.template : undefined;
  const uses = await themeUses(ws);
  const colorsOf = (t: Template | undefined): ThemeListItem['colors'] => {
    const c = t?.colors;
    const pick = (v: unknown) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined);
    const out: ThemeListItem['colors'] = {};
    for (const k of ['accent', 'text', 'paper'] as const) {
      const v = pick(c?.[k]);
      if (v) out[k] = v;
    }
    return out;
  };
  const themes: ThemeListItem[] = [];
  if (project && own !== undefined && isTemplatePath(own)) {
    let t: Template | undefined;
    const issues: string[] = [];
    try {
      t = (await loadProjectTemplate(project, undefined, { files: fileFacts(ws.policy) })).template;
    } catch (e) {
      issues.push(toEngineError(e).message);
    }
    themes.push({
      name: own,
      source: 'project',
      default: true,
      editable: { why: `${own} is the project's own theme folder: the Studio edits workspace themes only — edit its template.yaml by hand` },
      colors: colorsOf(t),
      issues,
      used_by: { projects: [project.slug], scenarios: [] },
    });
  }
  for (const e of await listTemplates(ws.root)) {
    let editable: ThemeEditable;
    try {
      editable = await editability(ws, e, realPathOf(e.dir, nodeFileFacts));
    } catch (err) {
      editable = { why: toEngineError(err).message };
    }
    let t: Template | undefined;
    const issues: string[] = [];
    try {
      t = (await loadTemplate(e.dir, undefined, { files: fileFacts(ws.policy) })).template;
    } catch (err) {
      issues.push(toEngineError(err).message);
    }
    themes.push({
      name: e.name,
      source: e.source,
      ...(own === e.name ? { default: true as const } : {}),
      editable,
      colors: colorsOf(t),
      issues: issues.slice(0, 3),
      used_by: uses.get(e.name) ?? { projects: [], scenarios: [] },
    });
  }
  return { themes, ...(own !== undefined ? { project_theme: own } : {}) };
}
