import { realpathSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { z } from 'zod';
import { starterTemplatesDir } from './bundle.js';
import { CheckContext } from './checks/context.js';
import { checkMediaFields } from './checks/media.js';
import { isTemplateMediaRef, resolveThemeComponents } from './components.js';
import { FORMAT_VERSIONS } from './formats.js';
import type { ThemeComponent } from './components.js';
import { ConfigError, hasErrors, issuesMessage } from './issues.js';
import { TemplateFileSchema, TemplateSchema } from './schemas/template.js';
import { DEFAULT_TEMPLATE } from './template-defaults.js';
import type { ComponentKind, LoadedProject, LoadedTemplate, Template, ValidationIssue } from './types.js';
import { checkYamlDocument } from './validation/document.js';
import { finalizeIssues, issue } from './validation/located.js';
import type { LocatedIssue } from './validation/located.js';
import { suggestion } from './validation/suggest.js';
import { zodIssues } from './validation/zod-issues.js';
import { loadWorkspaceConfig, findWorkspaceRoot } from './workspace.js';

export { DEFAULT_TEMPLATE } from './template-defaults.js';

export const TEMPLATE_FILE = 'template.yaml';

/** templates/<name>/template.yaml as written (every section optional). */
export type TemplateFile = z.infer<typeof TemplateFileSchema>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? structuredClone(base) : structuredClone(over);
  const out: Record<string, unknown> = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) out[k] = deepMerge(base[k], v);
  }
  return out;
}

/** Merge a template file over a base template: objects merge recursively, arrays and scalars replace. */
export function mergeTemplate(base: Template, file: TemplateFile): Template {
  return deepMerge(base, file) as Template;
}

/** The default template without its name: the name of a template comes from its file or its directory. */
function nameless(): Template {
  const { name: _defaultName, ...defaults } = DEFAULT_TEMPLATE;
  return defaults;
}

/** Legacy template fields that select a default component when `components` does not (resolveThemeComponents). */
const LEGACY_FIELDS: Partial<Record<ComponentKind, { section: string; keys: string[] }>> = {
  layout: { section: 'frame', keys: ['style', 'width', 'radius', 'shadow'] },
  intro: { section: 'intro', keys: ['layout'] },
  outro: { section: 'outro', keys: ['layout'] },
  interstitial: { section: 'interstitial', keys: ['style'] },
  caption: { section: 'captions', keys: ['position'] },
  transition: { section: 'transitions', keys: ['between_scenes', 'duration'] },
};

/** JSON with object keys in locale order (`localeCompare`): a choice's params as a theme description shows and compares them. */
function localeSortedJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

function describeChoice(c: ThemeComponent | null): string {
  if (!c) return 'none';
  return Object.keys(c.params).length > 0 ? `${c.id} ${localeSortedJson(c.params)}` : c.id;
}

/** A `components` entry contradicting the legacy fields written next to it (checkTemplateFile, theme edits). */
export interface LegacyContradiction {
  kind: ComponentKind;
  /** The legacy fields written in the file for that kind ("frame.style", "transitions.duration"). */
  written: string[];
  message: string;
}

/**
 * The `components` entries of a parsed template file that disagree with a legacy field written in the same file (e.g.
 * `components.layout: studio/layout-browser` next to `frame: {style: card}`): the components entry wins, so the legacy
 * field changes nothing. `value` must be structurally valid. Used by checkTemplateFile (a warning each) and by the
 * Studio's theme edits (L4.7, critique B7: a component change removes the legacy fields it now contradicts).
 */
export function legacyContradictions(value: unknown): LegacyContradiction[] {
  if (!isPlainObject(value) || !isPlainObject(value.components)) return [];
  const file = value as TemplateFile;
  const merged = mergeTemplate(nameless(), file);
  const chosen = resolveThemeComponents(merged);
  const legacy = resolveThemeComponents({ ...merged, components: undefined });
  const out: LegacyContradiction[] = [];
  for (const [kind, fields] of Object.entries(LEGACY_FIELDS) as Array<[ComponentKind, { section: string; keys: string[] }]>) {
    if (file.components?.[kind] === undefined) continue;
    const section = (value as Record<string, unknown>)[fields.section];
    const written = isPlainObject(section) ? fields.keys.filter((k) => section[k] !== undefined) : [];
    if (written.length === 0) continue;
    const a = chosen[kind];
    const b = legacy[kind];
    const same = a === null || b === null ? a === b : a.id === b.id && localeSortedJson(a.params) === localeSortedJson(b.params);
    if (same) continue;
    out.push({
      kind,
      written: written.map((k) => `${fields.section}.${k}`),
      message:
        `components.${kind} (${describeChoice(a)}) takes precedence over ${written.map((k) => `${fields.section}.${k}`).join(', ')} ` +
        `(which ${written.length > 1 ? 'map' : 'maps'} to ${describeChoice(b)}): change components.${kind}, or remove it to use ${fields.section}`,
    });
  }
  return out;
}

/**
 * Semantic check of a template file: a `components` entry that disagrees with a legacy field written in the same
 * file (e.g. `components.layout: studio/layout-browser` next to `frame: {style: card}`) is a warning — the
 * components entry wins, so editing the legacy field would change nothing.
 */
function checkTemplateFile(value: unknown, structural: readonly LocatedIssue[]): LocatedIssue[] {
  if (hasErrors(structural)) return [];
  return legacyContradictions(value).map((c) => issue('warning', ['components', c.kind], c.message));
}

/**
 * The theme's own files (L2.12, `components.intro: {video: …}`): checked like a scenario's (container, existence,
 * codec, from / to) relative to the template folder `dir` — skipped without one.
 */
function checkTemplateMedia(value: unknown, structural: readonly LocatedIssue[], dir: string | undefined): LocatedIssue[] {
  if (!dir || !isPlainObject(value) || !isPlainObject(value.components)) return [];
  const ctx = new CheckContext(structural, dir, 'the template folder');
  for (const [kind, ref] of Object.entries(value.components)) {
    if (isTemplateMediaRef(ref as never)) checkMediaFields(ref, ['components', kind], ctx);
  }
  return ctx.out;
}

/**
 * Validate template.yaml text and merge it over DEFAULT_TEMPLATE. `template` is returned only
 * when there is no error-level issue. With `dir` (the template folder), the theme's own files are checked too.
 */
export function parseTemplateYaml(text: string, opts: { dir?: string } = {}): { template?: Template; issues: ValidationIssue[] } {
  const { value, issues } = checkYamlDocument(text, TemplateFileSchema, (v, st) => [...checkTemplateFile(v, st), ...checkTemplateMedia(v, st, opts.dir)], {}, {
    formatVersion: { file: TEMPLATE_FILE, supported: FORMAT_VERSIONS.template },
  });
  if (hasErrors(issues)) return { issues };
  // `version` is the file's format, not part of the template merged over the defaults.
  const { version: _version, ...file } = value as TemplateFile;
  const template = mergeTemplate(nameless(), file);
  const merged = finalizeIssues(zodIssues(TemplateSchema, template));
  if (hasErrors(merged)) return { issues: [...issues, ...merged] };
  return { template, issues };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The starter templates shipped with Retake (default, editorial, motion): the app bundle's, else `templates/` of the repository. */
export const STARTER_TEMPLATES_DIR = starterTemplatesDir();

export interface TemplateEntry {
  name: string;
  dir: string;
  /** workspace: in the workspace's templates_dir; starter: shipped with Retake (no workspace template has its name). */
  source: 'workspace' | 'starter';
}

/** Sub-folders of a directory (hidden ones left out); [] when it does not exist. */
async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Template folders (holding a template.yaml) of a directory, sorted by name; [] when it does not exist. */
async function templateFolders(dir: string): Promise<Array<{ name: string; dir: string }>> {
  return (await subfolders(dir))
    .sort()
    .map((name) => ({ name, dir: join(dir, name) }))
    .filter((t) => isFile(join(t.dir, TEMPLATE_FILE)));
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * Templates a workspace can use, sorted by name: its own (templates_dir) and the starter templates whose name none of
 * its folders uses — a new workspace can pick `default`, `editorial` or `motion` without copying them.
 */
export async function listTemplates(root: string): Promise<TemplateEntry[]> {
  const { templatesDir } = await loadWorkspaceConfig(root);
  const own = (await templateFolders(templatesDir)).map((t) => ({ ...t, source: 'workspace' as const }));
  if (samePath(templatesDir, STARTER_TEMPLATES_DIR)) return own;
  // Any workspace folder of that name shadows the starter, even one without a template.yaml (loadTemplate reports it).
  const taken = new Set(await subfolders(templatesDir));
  const starters = (await templateFolders(STARTER_TEMPLATES_DIR)).filter((t) => !taken.has(t.name)).map((t) => ({ ...t, source: 'starter' as const }));
  return [...own, ...starters].sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveTemplateDir(nameOrDir: string, root: string | undefined, base: string): Promise<string> {
  const pathLike = isAbsolute(nameOrDir) || nameOrDir.startsWith('.') || /[\\/]/.test(nameOrDir);
  if (pathLike) {
    const dir = resolve(base, nameOrDir);
    if (!isFile(join(dir, TEMPLATE_FILE))) throw new ConfigError(`no ${TEMPLATE_FILE} in ${dir}`);
    return dir;
  }
  const wsRoot = root ?? findWorkspaceRoot();
  const { templatesDir } = await loadWorkspaceConfig(wsRoot);
  const dir = join(templatesDir, nameOrDir);
  if (isFile(join(dir, TEMPLATE_FILE))) return dir;
  if (isDirectory(dir)) {
    throw new ConfigError(`template "${nameOrDir}": no ${TEMPLATE_FILE} in ${dir} (a workspace folder of that name takes precedence over the starter template)`);
  }
  const starter = join(STARTER_TEMPLATES_DIR, nameOrDir);
  if (isFile(join(starter, TEMPLATE_FILE))) return starter;
  const available = (await listTemplates(wsRoot)).map((t) => t.name);
  throw new ConfigError(
    `template "${nameOrDir}" not found in ${templatesDir} or the starter templates${suggestion(nameOrDir, available)} (available: ${available.join(', ') || 'none'})`,
  );
}

async function loadTemplateDir(dir: string): Promise<LoadedTemplate> {
  const file = join(dir, TEMPLATE_FILE);
  const { template, issues } = parseTemplateYaml(await readFile(file, 'utf8'), { dir });
  if (!template) throw new ConfigError(issuesMessage('template', issues, file), issues, file);
  const name = basename(dir);
  template.name ??= name;
  const abs = (p: string) => resolve(dir, p);
  const assets: LoadedTemplate['assets'] = {
    logo: abs(template.logo),
    display: abs(template.fonts.display),
    body: template.fonts.body.map(abs),
  };
  if (template.wordmark) assets.wordmark = abs(template.wordmark);
  const declared = [template.logo, template.wordmark, template.fonts.display, ...template.fonts.body].filter(
    (p): p is string => p !== undefined,
  );
  const missing = [...new Set(declared)].filter((p) => !isFile(abs(p)));
  if (missing.length > 0) {
    throw new ConfigError(
      `template "${name}" (${dir}) is missing ${missing.length === 1 ? 'an asset file' : `${missing.length} asset files`}: ${missing.join(', ')}`,
      missing.map((p) => ({ severity: 'error', path: [], message: `missing asset file "${p}"` })),
      file,
    );
  }
  return { name, dir, template, assets };
}

/**
 * Load templates/<name> — else the starter template of that name — (or a template directory path, relative to the cwd), merged over
 * DEFAULT_TEMPLATE, with asset paths resolved and checked. Throws ConfigError listing every
 * missing asset file.
 */
export async function loadTemplate(nameOrDir: string, root?: string): Promise<LoadedTemplate> {
  return loadTemplateDir(await resolveTemplateDir(nameOrDir, root, process.cwd()));
}

/**
 * The template of a project: `override` ?? project.config.template. A path-like reference
 * ("./template") is resolved against the project directory, a name against the workspace templates, then the starters.
 */
export async function loadProjectTemplate(project: LoadedProject, override?: string): Promise<LoadedTemplate> {
  return loadTemplateDir(await resolveTemplateDir(override ?? project.config.template, project.root, project.dir));
}
