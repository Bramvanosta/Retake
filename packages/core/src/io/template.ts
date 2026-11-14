/**
 * The theme readers: the workspace's themes and the starter ones (the app bundle's, else the repository's), a theme
 * folder loaded and its asset files checked.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigError, issuesMessage } from '../issues.js';
import { TEMPLATE_FILE, parseTemplateYaml } from '../template.js';
import type { TemplateEntry } from '../template.js';
import type { LoadedProject, LoadedTemplate } from '../types.js';
import { suggestion } from '../validation/suggest.js';
import { starterTemplatesDir } from './bundle.js';
import { nodeWorkspaceDisk } from './file-facts.js';
import { findWorkspaceRootOn, loadWorkspaceConfigOn } from './workspace.js';
import type { WorkFileFacts, WorkspaceDisk } from '../file-facts.js';

const isFile = (disk: WorkspaceDisk, p: string): boolean => disk.facts.kind(p) === 'file';
const isDirectory = (disk: WorkspaceDisk, p: string): boolean => disk.facts.kind(p) === 'directory';

/** The starter templates shipped with Retake (default, editorial, motion): the app bundle's, else `templates/` of the repository. */
export const STARTER_TEMPLATES_DIR = starterTemplatesDir();

/** Sub-folders of a directory (hidden ones left out); [] when it does not exist. */
async function subfolders(disk: WorkspaceDisk, dir: string): Promise<string[]> {
  try {
    const entries = await disk.list(dir);
    return entries.filter((e) => e.kind === 'directory' && !e.name.startsWith('.')).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Template folders (holding a template.yaml) of a directory, sorted by name; [] when it does not exist. */
async function templateFolders(disk: WorkspaceDisk, dir: string): Promise<Array<{ name: string; dir: string }>> {
  return (await subfolders(disk, dir))
    .sort()
    .map((name) => ({ name, dir: join(dir, name) }))
    .filter((t) => isFile(disk, join(t.dir, TEMPLATE_FILE)));
}

function samePath(disk: WorkspaceDisk, a: string, b: string): boolean {
  const ra = disk.facts.realpath(a);
  const rb = ra === undefined ? undefined : disk.facts.realpath(b);
  return ra !== undefined && rb !== undefined ? ra === rb : resolve(a) === resolve(b);
}

/**
 * Templates a workspace can use, sorted by name: its own (templates_dir) and the starter templates whose name none of
 * its folders uses — a new workspace can pick `default`, `editorial` or `motion` without copying them.
 */
export async function listTemplates(root: string): Promise<TemplateEntry[]> {
  return listTemplatesOn(nodeWorkspaceDisk, root);
}

/** listTemplates on a disk. */
export async function listTemplatesOn(disk: WorkspaceDisk, root: string): Promise<TemplateEntry[]> {
  const { templatesDir } = await loadWorkspaceConfigOn(disk, root);
  const own = (await templateFolders(disk, templatesDir)).map((t) => ({ ...t, source: 'workspace' as const }));
  if (samePath(disk, templatesDir, STARTER_TEMPLATES_DIR)) return own;
  // Any workspace folder of that name shadows the starter, even one without a template.yaml (loadTemplate reports it).
  const taken = new Set(await subfolders(disk, templatesDir));
  const starters = (await templateFolders(disk, STARTER_TEMPLATES_DIR)).filter((t) => !taken.has(t.name)).map((t) => ({ ...t, source: 'starter' as const }));
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
async function folderOf(disk: WorkspaceDisk, nameOrDir: string, root: string | undefined, base: string): Promise<TemplateFolder> {
  const pathLike = isAbsolute(nameOrDir) || nameOrDir.startsWith('.') || /[\\/]/.test(nameOrDir);
  if (pathLike) return { dir: resolve(base, nameOrDir), via: 'path' };
  const wsRoot = root ?? findWorkspaceRootOn(disk);
  const { templatesDir } = await loadWorkspaceConfigOn(disk, wsRoot);
  const dir = join(templatesDir, nameOrDir);
  if (isDirectory(disk, dir)) return { dir, via: 'workspace', wsRoot, templatesDir };
  return { dir: join(STARTER_TEMPLATES_DIR, nameOrDir), via: 'starter', wsRoot, templatesDir };
}

async function resolveTemplateDir(disk: WorkspaceDisk, nameOrDir: string, root: string | undefined, base: string): Promise<string> {
  const f = await folderOf(disk, nameOrDir, root, base);
  if (isFile(disk, join(f.dir, TEMPLATE_FILE))) return f.dir;
  if (f.via === 'path') throw new ConfigError(`no ${TEMPLATE_FILE} in ${f.dir}`);
  if (f.via === 'workspace') {
    throw new ConfigError(`template "${nameOrDir}": no ${TEMPLATE_FILE} in ${f.dir} (a workspace folder of that name takes precedence over the starter template)`);
  }
  const available = (await listTemplatesOn(disk, f.wsRoot!)).map((t) => t.name);
  throw new ConfigError(`template "${nameOrDir}" not found in ${f.templatesDir} or the starter templates${suggestion(nameOrDir, available)} (available: ${available.join(', ') || 'none'})`);
}

/** The starter id's mark: `relative()` never answers a path that starts with `/`, so no folder's path is a starter's id. */
export const STARTER_FOLDER_ID_PREFIX = '/starter:';

/**
 * A path as the disk spells it: the real path of its nearest existing parent (symbolic links and the spelling of the
 * workspace's own path resolved), then the rest as written — the folder itself is never followed, nor need it exist.
 */
function realParentPath(disk: WorkspaceDisk, p: string): string {
  const abs = resolve(p);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  const real = disk.facts.realpath(parent);
  return join(real ?? realParentPath(disk, parent), basename(abs));
}

function realPath(disk: WorkspaceDisk, p: string): string {
  return disk.facts.realpath(p) ?? realParentPath(disk, p);
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
  return templateFolderIdOn(nodeWorkspaceDisk, dir, root);
}

/** templateFolderId on a disk. */
export function templateFolderIdOn(disk: WorkspaceDisk, dir: string, root: string): string {
  const abs = realParentPath(disk, dir);
  if (dirname(abs) === realPath(disk, STARTER_TEMPLATES_DIR)) return `${STARTER_FOLDER_ID_PREFIX}${basename(abs)}`;
  const rel = relative(realPath(disk, root), abs);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

/**
 * The identity (templateFolderId) of the theme a project's work would load for `ref` — the folder loadProjectTemplate
 * resolves, by the same rule, its template.yaml unread (a theme that does not load has an identity all the same; its
 * render fails on it). A name is looked for only in the two theme folders; of a path, only its parents' real path is
 * read. Undefined for no reference.
 */
export async function projectTemplateFolderId(project: Pick<LoadedProject, 'root' | 'dir'>, ref: string | undefined): Promise<string | undefined> {
  return projectTemplateFolderIdOn(nodeWorkspaceDisk, project, ref);
}

/** projectTemplateFolderId on a disk. */
export async function projectTemplateFolderIdOn(disk: WorkspaceDisk, project: Pick<LoadedProject, 'root' | 'dir'>, ref: string | undefined): Promise<string | undefined> {
  if (typeof ref !== 'string' || ref === '') return undefined;
  const f = await folderOf(disk, ref, project.root, project.dir);
  return templateFolderIdOn(disk, f.dir, project.root);
}

/**
 * How a theme is loaded: `files` looks at its own files (core FileFacts) — always given, never a default: the FileFacts
 * of the work that loads it, fileFacts(policy), whose VideoProber checks a video file the theme shows.
 */
export interface TemplateLoadOptions {
  files: WorkFileFacts;
}

async function loadTemplateDir(disk: WorkspaceDisk, dir: string, files: WorkFileFacts): Promise<LoadedTemplate> {
  const file = join(dir, TEMPLATE_FILE);
  const { template, issues } = parseTemplateYaml((await disk.readFile(file)).toString('utf8'), { dir, files });
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
  const declared = [template.logo, template.wordmark, template.fonts.display, ...template.fonts.body].filter((p): p is string => p !== undefined);
  const missing = [...new Set(declared)].filter((p) => !isFile(disk, abs(p)));
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
  return loadTemplateOn(nodeWorkspaceDisk, nameOrDir, root, o);
}

/** loadTemplate on a disk. */
export async function loadTemplateOn(disk: WorkspaceDisk, nameOrDir: string, root: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadTemplateDir(disk, await resolveTemplateDir(disk, nameOrDir, root, process.cwd()), o.files);
}

/**
 * The template of a project: `override` ?? project.config.template. A path-like reference
 * ("./template") is resolved against the project directory, a name against the workspace templates, then the starters.
 */
export async function loadProjectTemplate(project: LoadedProject, override: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadProjectTemplateOn(nodeWorkspaceDisk, project, override, o);
}

/** loadProjectTemplate on a disk. */
export async function loadProjectTemplateOn(disk: WorkspaceDisk, project: LoadedProject, override: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadTemplateDir(disk, await resolveTemplateDir(disk, override ?? project.config.template, project.root, project.dir), o.files);
}
