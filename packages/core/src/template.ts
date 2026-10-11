import { statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { z } from 'zod';
import { ConfigError, hasErrors, issuesMessage } from './issues.js';
import { TemplateFileSchema, TemplateSchema } from './schemas/template.js';
import { DEFAULT_TEMPLATE } from './template-defaults.js';
import type { LoadedProject, LoadedTemplate, Template, ValidationIssue } from './types.js';
import { checkYamlDocument } from './validation/document.js';
import { finalizeIssues } from './validation/located.js';
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

/**
 * Validate template.yaml text and merge it over DEFAULT_TEMPLATE. `template` is returned only
 * when there is no error-level issue.
 */
export function parseTemplateYaml(text: string): { template?: Template; issues: ValidationIssue[] } {
  const { value, issues } = checkYamlDocument(text, TemplateFileSchema);
  if (hasErrors(issues)) return { issues };
  const file = value as TemplateFile;
  // The default's name must not leak into other templates: the name comes from the file or the dir.
  const { name: _defaultName, ...defaults } = DEFAULT_TEMPLATE;
  const template = mergeTemplate(defaults, file);
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

/** Templates of a workspace (directories of templates_dir holding a template.yaml), sorted by name. */
export async function listTemplates(root: string): Promise<Array<{ name: string; dir: string }>> {
  const { templatesDir } = await loadWorkspaceConfig(root);
  let names: string[];
  try {
    const entries = await readdir(templatesDir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return names
    .sort()
    .map((name) => ({ name, dir: join(templatesDir, name) }))
    .filter((t) => isFile(join(t.dir, TEMPLATE_FILE)));
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
  const available = (await listTemplates(wsRoot)).map((t) => t.name);
  throw new ConfigError(
    `template "${nameOrDir}" not found in ${templatesDir}${suggestion(nameOrDir, available)} (available: ${available.join(', ') || 'none'})`,
  );
}

async function loadTemplateDir(dir: string): Promise<LoadedTemplate> {
  const file = join(dir, TEMPLATE_FILE);
  const { template, issues } = parseTemplateYaml(await readFile(file, 'utf8'));
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
 * Load templates/<name> (or a template directory path, relative to the cwd), merged over
 * DEFAULT_TEMPLATE, with asset paths resolved and checked. Throws ConfigError listing every
 * missing asset file.
 */
export async function loadTemplate(nameOrDir: string, root?: string): Promise<LoadedTemplate> {
  return loadTemplateDir(await resolveTemplateDir(nameOrDir, root, process.cwd()));
}

/**
 * The template of a project: `override` ?? project.config.template. A path-like reference
 * ("./template") is resolved against the project directory, a name against the workspace templates.
 */
export async function loadProjectTemplate(project: LoadedProject, override?: string): Promise<LoadedTemplate> {
  return loadTemplateDir(await resolveTemplateDir(override ?? project.config.template, project.root, project.dir));
}
