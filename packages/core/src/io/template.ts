/**
 * The theme readers: the workspace's themes and the starter ones (the app bundle's, else the repository's), a theme
 * folder loaded and its asset files checked.
 */
import { realpathSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigError, issuesMessage } from '../issues.js';
import { TEMPLATE_FILE, parseTemplateYaml } from '../template.js';
import type { TemplateEntry } from '../template.js';
import type { LoadedProject, LoadedTemplate } from '../types.js';
import { suggestion } from '../validation/suggest.js';
import { starterTemplatesDir } from './bundle.js';
import { findWorkspaceRoot, loadWorkspaceConfig } from './workspace.js';
import type { WorkFileFacts } from '../file-facts.js';

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

/** The folder a theme reference names, and how it was found (folderOf). */
interface TemplateFolder {
  dir: string;
  /** A path (resolved against `base`), a folder of the workspace's templates, else the starter of that name. */
  via: 'path' | 'workspace' | 'starter';
  /** For a name: the workspace root and its templates folder (a path needs neither). */
  wsRoot?: string;
  templatesDir?: string;
}

/**
 * The one rule for the folder a theme reference names, its template.yaml unread: a path-like reference resolved against
 * `base`; a name, the workspace's templates folder of that name when one exists (with or without a template.yaml: it
 * takes precedence over the starter), else the starter of that name. A name never leaves the two theme folders.
 */
async function folderOf(nameOrDir: string, root: string | undefined, base: string): Promise<TemplateFolder> {
  const pathLike = isAbsolute(nameOrDir) || nameOrDir.startsWith('.') || /[\\/]/.test(nameOrDir);
  if (pathLike) return { dir: resolve(base, nameOrDir), via: 'path' };
  const wsRoot = root ?? findWorkspaceRoot();
  const { templatesDir } = await loadWorkspaceConfig(wsRoot);
  const dir = join(templatesDir, nameOrDir);
  if (isDirectory(dir)) return { dir, via: 'workspace', wsRoot, templatesDir };
  return { dir: join(STARTER_TEMPLATES_DIR, nameOrDir), via: 'starter', wsRoot, templatesDir };
}

async function resolveTemplateDir(nameOrDir: string, root: string | undefined, base: string): Promise<string> {
  const f = await folderOf(nameOrDir, root, base);
  if (isFile(join(f.dir, TEMPLATE_FILE))) return f.dir;
  if (f.via === 'path') throw new ConfigError(`no ${TEMPLATE_FILE} in ${f.dir}`);
  if (f.via === 'workspace') {
    throw new ConfigError(`template "${nameOrDir}": no ${TEMPLATE_FILE} in ${f.dir} (a workspace folder of that name takes precedence over the starter template)`);
  }
  const available = (await listTemplates(f.wsRoot!)).map((t) => t.name);
  throw new ConfigError(
    `template "${nameOrDir}" not found in ${f.templatesDir} or the starter templates${suggestion(nameOrDir, available)} (available: ${available.join(', ') || 'none'})`,
  );
}

/** The starter id's mark: `relative()` never answers a path that starts with `/`, so no folder's path is a starter's id. */
export const STARTER_FOLDER_ID_PREFIX = '/starter:';

/**
 * A path as the disk spells it: the real path of its nearest existing parent (symbolic links and the spelling of the
 * workspace's own path resolved), then the rest as written — the folder itself is never followed, nor need it exist.
 */
function realParentPath(p: string): string {
  const abs = resolve(p);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  try {
    return join(realpathSync(parent), basename(abs));
  } catch {
    return join(realParentPath(parent), basename(abs));
  }
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return realParentPath(p);
  }
}

/**
 * A theme folder's identity, as a render record holds it (`template_folder`): `/starter:<name>` for a starter theme of
 * Retake's (where Retake is installed is no part of it, inside a workspace or not), else its path relative to the
 * workspace root, `/`-separated (`templates/brand`, `projects/demo/themes/brand`, `../shared/brand`). Both sides are
 * read as the disk spells them (the root's real path; the folder's nearest existing parent's, then its name), so a
 * root named through a link gives the same id. Two folders of one name at different paths are two themes; the folder's
 * content is no part of it.
 */
export function templateFolderId(dir: string, root: string): string {
  const abs = realParentPath(dir);
  if (dirname(abs) === realPath(STARTER_TEMPLATES_DIR)) return `${STARTER_FOLDER_ID_PREFIX}${basename(abs)}`;
  const rel = relative(realPath(root), abs);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

/**
 * The identity (templateFolderId) of the theme a project's work would load for `ref` — the folder loadProjectTemplate
 * resolves, by the same rule, its template.yaml unread (a theme that does not load has an identity all the same; its
 * render fails on it). A name is looked for only in the two theme folders; of a path, only its parents' real path is
 * read. Undefined for no reference.
 */
export async function projectTemplateFolderId(project: Pick<LoadedProject, 'root' | 'dir'>, ref: string | undefined): Promise<string | undefined> {
  if (typeof ref !== 'string' || ref === '') return undefined;
  const f = await folderOf(ref, project.root, project.dir);
  return templateFolderId(f.dir, project.root);
}

/**
 * How a theme is loaded: `files` looks at its own files (core FileFacts) — always given, never a default: the FileFacts
 * of the work that loads it, fileFacts(policy), whose VideoProber checks a video file the theme shows.
 */
export interface TemplateLoadOptions {
  files: WorkFileFacts;
}

async function loadTemplateDir(dir: string, files: WorkFileFacts): Promise<LoadedTemplate> {
  const file = join(dir, TEMPLATE_FILE);
  const { template, issues } = parseTemplateYaml(await readFile(file, 'utf8'), { dir, files });
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
export async function loadTemplate(nameOrDir: string, root: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadTemplateDir(await resolveTemplateDir(nameOrDir, root, process.cwd()), o.files);
}

/**
 * The template of a project: `override` ?? project.config.template. A path-like reference
 * ("./template") is resolved against the project directory, a name against the workspace templates, then the starters.
 */
export async function loadProjectTemplate(project: LoadedProject, override: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadTemplateDir(await resolveTemplateDir(override ?? project.config.template, project.root, project.dir), o.files);
}
