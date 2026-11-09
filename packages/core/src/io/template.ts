/**
 * The theme readers: the workspace's themes and the starter ones (the app bundle's, else the repository's), a theme
 * folder loaded and its asset files checked.
 */
import { realpathSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ConfigError, issuesMessage } from '../issues.js';
import { TEMPLATE_FILE, parseTemplateYaml } from '../template.js';
import type { TemplateEntry } from '../template.js';
import type { LoadedProject, LoadedTemplate } from '../types.js';
import { suggestion } from '../validation/suggest.js';
import { starterTemplatesDir } from './bundle.js';
import { nodeFileFacts } from './file-facts.js';
import { findWorkspaceRoot, loadWorkspaceConfig } from './workspace.js';
import type { FileFacts } from '../file-facts.js';

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

/**
 * How a theme is loaded: `files` looks at its own files (core FileFacts; default nodeFileFacts, which probes no video —
 * a theme showing a video file of its own is checked with the FileFacts of the work that loads it, fileFacts(policy)).
 */
export interface TemplateLoadOptions {
  files?: FileFacts;
}

async function loadTemplateDir(dir: string, files: FileFacts): Promise<LoadedTemplate> {
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
export async function loadTemplate(nameOrDir: string, root?: string, o: TemplateLoadOptions = {}): Promise<LoadedTemplate> {
  return loadTemplateDir(await resolveTemplateDir(nameOrDir, root, process.cwd()), o.files ?? nodeFileFacts);
}

/**
 * The template of a project: `override` ?? project.config.template. A path-like reference
 * ("./template") is resolved against the project directory, a name against the workspace templates, then the starters.
 */
export async function loadProjectTemplate(project: LoadedProject, override?: string, o: TemplateLoadOptions = {}): Promise<LoadedTemplate> {
  return loadTemplateDir(await resolveTemplateDir(override ?? project.config.template, project.root, project.dir), o.files ?? nodeFileFacts);
}
