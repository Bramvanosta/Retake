/**
 * The theme readers: a project's own themes (`<project>/templates/`), the workspace's and the starter ones (the app
 * bundle's, else the repository's) — in that order — a theme folder loaded and its asset files checked.
 */
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IMAGE_SIZE_HEAD_BYTES, imageAspect } from '../image-size.js';
import { ConfigError, issuesMessage } from '../issues.js';
import { TEMPLATE_FILE, parseTemplateYaml } from '../template.js';
import type { TemplateEntry } from '../template.js';
import type { LoadedProject } from '../types/project.js';
import type { LoadedTemplate } from '../types/theme.js';
import { suggestion } from '../validation/suggest.js';
import { starterTemplatesDir } from './bundle.js';
import { nodeWorkspaceDisk } from './file-facts.js';
import { projectLibraryDir } from '../layout.js';
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

/** How a theme is listed or resolved for a project: its folder, whose `templates/` comes before the workspace's. */
export interface ThemeScope {
  /** The project folder (`projects/<slug>`): its `templates/<name>/` is found first. */
  projectDir?: string;
}

/**
 * The project's own theme folder (`<project>/templates`), or undefined: none named, or it is the workspace's
 * templates_dir or the starters' folder itself (a workspace may point templates_dir at a project's: then those are
 * the workspace's themes, never shadowing themselves).
 */
function projectThemesDir(disk: WorkspaceDisk, scope: ThemeScope | undefined, templatesDir: string): string | undefined {
  if (scope?.projectDir === undefined) return undefined;
  const dir = projectLibraryDir(scope.projectDir, 'templates');
  return samePath(disk, dir, templatesDir) || samePath(disk, dir, STARTER_TEMPLATES_DIR) ? undefined : dir;
}

/**
 * Templates a workspace can use, sorted by name: its own (templates_dir) and the starter templates whose name none of
 * its folders uses — a new workspace can pick `default`, `editorial` or `motion` without copying them. With a project
 * (`scope.projectDir`), its own themes (`<project>/templates/`) first: a folder of the project hides the workspace's
 * and the starter of its name (`shadows` says which).
 */
export async function listTemplates(root: string, scope?: ThemeScope): Promise<TemplateEntry[]> {
  return listTemplatesOn(nodeWorkspaceDisk, root, scope);
}

/** listTemplates on a disk. */
export async function listTemplatesOn(disk: WorkspaceDisk, root: string, scope?: ThemeScope): Promise<TemplateEntry[]> {
  const { templatesDir } = await loadWorkspaceConfigOn(disk, root);
  const projectDir = projectThemesDir(disk, scope, templatesDir);
  // Any folder of a name shadows the next place's theme of that name, even one without a template.yaml (loadTemplate reports it).
  const projectTaken = new Set(projectDir === undefined ? [] : await subfolders(disk, projectDir));
  const workspaceTaken = new Set(await subfolders(disk, templatesDir));
  const startersShipped = samePath(disk, templatesDir, STARTER_TEMPLATES_DIR) ? [] : await templateFolders(disk, STARTER_TEMPLATES_DIR);
  const starterNames = new Set(startersShipped.map((t) => t.name));
  const mine: TemplateEntry[] = (projectDir === undefined ? [] : await templateFolders(disk, projectDir)).map((t) => {
    const shadows = workspaceTaken.has(t.name) ? 'workspace' : starterNames.has(t.name) ? 'starter' : undefined;
    return { ...t, source: 'project' as const, ...(shadows ? { shadows } : {}) };
  });
  const own = (await templateFolders(disk, templatesDir)).filter((t) => !projectTaken.has(t.name)).map((t) => ({ ...t, source: 'workspace' as const }));
  const starters = startersShipped.filter((t) => !workspaceTaken.has(t.name) && !projectTaken.has(t.name)).map((t) => ({ ...t, source: 'starter' as const }));
  return [...mine, ...own, ...starters].sort((a, b) => a.name.localeCompare(b.name));
}

/** The folder a theme reference names, and how it was found (folderOf). */
interface TemplateFolder {
  dir: string;
  /** A path (resolved against `base`), a folder of the project's own themes, of the workspace's, else the starter of that name. */
  via: 'path' | 'project' | 'workspace' | 'starter';
  /** For a name: the workspace root and its templates folder (a path needs neither), and the project's themes folder when one is looked in. */
  wsRoot?: string;
  templatesDir?: string;
  projectThemes?: string;
}

/**
 * The one rule for the folder a theme reference names, its template.yaml unread: a path-like reference resolved against
 * `base`; a name, the project's own themes folder of that name when one exists (`scope.projectDir`), else the
 * workspace's templates folder of that name when one exists (with or without a template.yaml: either takes precedence
 * over what follows), else the starter of that name. A name never leaves the three theme folders.
 */
async function folderOf(disk: WorkspaceDisk, nameOrDir: string, root: string | undefined, base: string, scope?: ThemeScope): Promise<TemplateFolder> {
  const pathLike = isAbsolute(nameOrDir) || nameOrDir.startsWith('.') || /[\\/]/.test(nameOrDir);
  if (pathLike) return { dir: resolve(base, nameOrDir), via: 'path' };
  const wsRoot = root ?? findWorkspaceRootOn(disk);
  const { templatesDir } = await loadWorkspaceConfigOn(disk, wsRoot);
  const projectThemes = projectThemesDir(disk, scope, templatesDir);
  const at = { wsRoot, templatesDir, ...(projectThemes !== undefined ? { projectThemes } : {}) };
  if (projectThemes !== undefined && isDirectory(disk, join(projectThemes, nameOrDir))) return { dir: join(projectThemes, nameOrDir), via: 'project', ...at };
  const dir = join(templatesDir, nameOrDir);
  if (isDirectory(disk, dir)) return { dir, via: 'workspace', ...at };
  return { dir: join(STARTER_TEMPLATES_DIR, nameOrDir), via: 'starter', ...at };
}

async function resolveTemplateDir(disk: WorkspaceDisk, nameOrDir: string, root: string | undefined, base: string, scope?: ThemeScope): Promise<string> {
  const f = await folderOf(disk, nameOrDir, root, base, scope);
  if (isFile(disk, join(f.dir, TEMPLATE_FILE))) return f.dir;
  if (f.via === 'path') throw new ConfigError(`no ${TEMPLATE_FILE} in ${f.dir}`);
  if (f.via === 'project') {
    throw new ConfigError(`template "${nameOrDir}": no ${TEMPLATE_FILE} in ${f.dir} (a folder of the project's templates/ takes precedence over the workspace's theme and the starter of that name)`);
  }
  if (f.via === 'workspace') {
    throw new ConfigError(`template "${nameOrDir}": no ${TEMPLATE_FILE} in ${f.dir} (a workspace folder of that name takes precedence over the starter template)`);
  }
  const available = (await listTemplatesOn(disk, f.wsRoot!, scope)).map((t) => t.name);
  const places = f.projectThemes !== undefined ? `${f.projectThemes}, ${f.templatesDir}` : f.templatesDir;
  throw new ConfigError(`template "${nameOrDir}" not found in ${places} or the starter templates${suggestion(nameOrDir, available)} (available: ${available.join(', ') || 'none'})`);
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

/** Whether a `relative()` answer names a path strictly below its base. */
const insideRel = (rel: string): boolean => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);

/** A project theme's id mark (`/project:templates/brand`): like the starter's, no path `relative()` answers starts with it. */
export const PROJECT_FOLDER_ID_PREFIX = '/project:';

/**
 * A theme folder's identity, as a render record holds it (`template_folder`): `/starter:<name>` for a starter theme of
 * Retake's (where Retake is installed is no part of it, inside a workspace or not); with `projectDir`, a folder inside
 * that project `/project:<path relative to the project>` (`/project:templates/brand`: the project's own theme, the same
 * id wherever the project is moved or under whatever slug it is imported); else its path relative to the workspace
 * root, `/`-separated (`templates/brand`, `../shared/brand`). Both sides are read as the disk spells them (the root's
 * real path; the folder's nearest existing parent's, then its name), so a root named through a link gives the same id.
 * Two folders of one name at different paths are two themes; the folder's content is no part of it. Records written
 * before projects had their own themes hold a project folder workspace-relative (`projects/demo/themes/brand`):
 * sameTemplateFolder reads both.
 */
export function templateFolderId(dir: string, root: string, projectDir?: string): string {
  return templateFolderIdOn(nodeWorkspaceDisk, dir, root, projectDir);
}

/** templateFolderId on a disk. */
export function templateFolderIdOn(disk: WorkspaceDisk, dir: string, root: string, projectDir?: string): string {
  const abs = realParentPath(disk, dir);
  if (dirname(abs) === realPath(disk, STARTER_TEMPLATES_DIR)) return `${STARTER_FOLDER_ID_PREFIX}${basename(abs)}`;
  if (projectDir !== undefined) {
    const inProject = relative(realPath(disk, projectDir), abs);
    if (insideRel(inProject)) return `${PROJECT_FOLDER_ID_PREFIX}${inProject.split(sep).join('/')}`;
  }
  const rel = relative(realPath(disk, root), abs);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

/**
 * A recorded theme folder id in today's form for `project`: an older record's workspace-relative id of a folder inside
 * the project (`projects/demo/templates/brand`) as `/project:templates/brand`; any other id as it is.
 */
export function projectFolderIdOf(disk: WorkspaceDisk, id: string, project: Pick<LoadedProject, 'root' | 'dir'>): string {
  if (id.startsWith('/') || id === '') return id;
  const abs = resolve(realPath(disk, project.root), ...id.split('/'));
  const inProject = relative(realPath(disk, project.dir), abs);
  return insideRel(inProject) ? `${PROJECT_FOLDER_ID_PREFIX}${inProject.split(sep).join('/')}` : id;
}

/** Whether a recorded theme folder id (a render record's `template_folder`) names the folder of today's id `current` (projectTemplateFolderId), older ids read too. */
export function sameTemplateFolder(recorded: string, current: string, project: Pick<LoadedProject, 'root' | 'dir'>): boolean {
  return sameTemplateFolderOn(nodeWorkspaceDisk, recorded, current, project);
}

/** sameTemplateFolder on a disk. */
export function sameTemplateFolderOn(disk: WorkspaceDisk, recorded: string, current: string, project: Pick<LoadedProject, 'root' | 'dir'>): boolean {
  return templateFolderMatcherOn(disk, current, project)(recorded);
}

/**
 * sameTemplateFolder for many recorded ids against one `current` (a board's renders): the project's and the root's
 * real paths read once, `current` normalised once.
 */
export function templateFolderMatcherOn(disk: WorkspaceDisk, current: string, project: Pick<LoadedProject, 'root' | 'dir'>): (recorded: string) => boolean {
  let real: { root: string; dir: string } | undefined;
  const norm = (id: string): string => {
    if (id.startsWith('/') || id === '') return id;
    real ??= { root: realPath(disk, project.root), dir: realPath(disk, project.dir) };
    const inProject = relative(real.dir, resolve(real.root, ...id.split('/')));
    return insideRel(inProject) ? `${PROJECT_FOLDER_ID_PREFIX}${inProject.split(sep).join('/')}` : id;
  };
  let cur: string | undefined;
  return (recorded) => recorded === current || norm(recorded) === (cur ??= norm(current));
}

/**
 * The identity (templateFolderId, with the project) of the theme a project's work would load for `ref` — the folder
 * loadProjectTemplate resolves, by the same rule, its template.yaml unread (a theme that does not load has an identity
 * all the same; its render fails on it). A name is looked for only in the three theme folders; of a path, only its
 * parents' real path is read. Undefined for no reference.
 */
export async function projectTemplateFolderId(project: Pick<LoadedProject, 'root' | 'dir'>, ref: string | undefined): Promise<string | undefined> {
  return projectTemplateFolderIdOn(nodeWorkspaceDisk, project, ref);
}

/** projectTemplateFolderId on a disk. */
export async function projectTemplateFolderIdOn(disk: WorkspaceDisk, project: Pick<LoadedProject, 'root' | 'dir'>, ref: string | undefined): Promise<string | undefined> {
  if (typeof ref !== 'string' || ref === '') return undefined;
  const f = await folderOf(disk, ref, project.root, project.dir, { projectDir: project.dir });
  return templateFolderIdOn(disk, f.dir, project.root, project.dir);
}

/** The folder a project's work would load for theme `ref` (its template.yaml unread): projectTemplateFolderId's folder. */
export async function projectTemplateFolder(project: Pick<LoadedProject, 'root' | 'dir'>, ref: string): Promise<{ dir: string; via: 'path' | 'project' | 'workspace' | 'starter' }> {
  return projectTemplateFolderOn(nodeWorkspaceDisk, project, ref);
}

/** projectTemplateFolder on a disk. */
export async function projectTemplateFolderOn(
  disk: WorkspaceDisk,
  project: Pick<LoadedProject, 'root' | 'dir'>,
  ref: string,
): Promise<{ dir: string; via: 'path' | 'project' | 'workspace' | 'starter' }> {
  const f = await folderOf(disk, ref, project.root, project.dir, { projectDir: project.dir });
  return { dir: f.dir, via: f.via };
}

/**
 * How a theme is loaded: `files` looks at its own files (core FileFacts) — always given, never a default: the FileFacts
 * of the work that loads it, fileFacts(policy), whose VideoProber checks a video file the theme shows.
 */
export interface TemplateLoadOptions extends ThemeScope {
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
  const aspect = imageAspect(disk.facts.readHead(assets.logo, IMAGE_SIZE_HEAD_BYTES), extname(assets.logo));
  if (aspect !== undefined) assets.logo_aspect = aspect;
  return { name, dir, template, assets };
}

/**
 * Load templates/<name> — the project's own first with `o.projectDir`, else the workspace's, else the starter template
 * of that name — (or a template directory path, relative to the cwd), merged over
 * DEFAULT_TEMPLATE, with asset paths resolved and checked. Throws ConfigError listing every
 * missing asset file.
 */
export async function loadTemplate(nameOrDir: string, root: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadTemplateOn(nodeWorkspaceDisk, nameOrDir, root, o);
}

/** loadTemplate on a disk. */
export async function loadTemplateOn(disk: WorkspaceDisk, nameOrDir: string, root: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadTemplateDir(disk, await resolveTemplateDir(disk, nameOrDir, root, process.cwd(), o), o.files);
}

/**
 * The template of a project: `override` ?? project.config.template. A path-like reference
 * ("./template") is resolved against the project directory, a name against the project's own themes (`templates/`),
 * then the workspace templates, then the starters.
 */
export async function loadProjectTemplate(project: LoadedProject, override: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadProjectTemplateOn(nodeWorkspaceDisk, project, override, o);
}

/** loadProjectTemplate on a disk. */
export async function loadProjectTemplateOn(disk: WorkspaceDisk, project: LoadedProject, override: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate> {
  return loadTemplateDir(disk, await resolveTemplateDir(disk, override ?? project.config.template, project.root, project.dir, { projectDir: project.dir }), o.files);
}
