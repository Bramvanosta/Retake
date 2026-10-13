import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { z } from 'zod';
import { checkProject } from './checks/project.js';
import { ConfigError, hasErrors, issuesMessage } from './issues.js';
import { ProjectFileSchema } from './schemas/project.js';
import { DEFAULT_CAPTURE } from './types.js';
import type { CaptureSettings, FrameStyle, LoadedProject, ProjectConfig, ValidationIssue } from './types.js';
import { slugify, writeTextAtomic } from './util.js';
import { checkYamlDocument } from './validation/document.js';
import { parseYaml } from './validation/yaml-source.js';
import { suggestion } from './validation/suggest.js';
import { findWorkspaceRoot, loadWorkspaceConfig } from './workspace.js';

export const PROJECT_FILE = 'project.yaml';
export const README_FILE = 'README.md';
/** Project slugs: lower-case, digits and "-" (directory names, CLI arguments). */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export const DEFAULT_FRAME: FrameStyle = 'card';
export const DEFAULT_TEMPLATE_NAME = 'default';
/** Generated artefacts kept out of git. */
/** Generated folders of a project; `.demo-studio/` holds tool state such as hook journals (`.demo-studio/journals/`). */
export const PROJECT_GITIGNORE = ['runs/', 'renders/', 'review/', 'exports/', 'frames/', '.demo-studio/'];

/** project.yaml as written (before defaults). */
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/** Defaults: capture = DEFAULT_CAPTURE merged, frame 'card', template 'default', environments {}. */
export function applyProjectDefaults(file: ProjectFile): ProjectConfig {
  return {
    ...file,
    environments: file.environments ?? {},
    capture: { ...DEFAULT_CAPTURE, ...file.capture },
    frame: file.frame ?? DEFAULT_FRAME,
    template: file.template ?? DEFAULT_TEMPLATE_NAME,
  };
}

/**
 * Validate project.yaml text. `file` (its path) enables hook-file checks relative to the project dir.
 * `config` (defaults applied) is returned only when there is no error-level issue.
 */
export function parseProjectYaml(text: string, file?: string): { config?: ProjectConfig; issues: ValidationIssue[] } {
  const projectDir = file ? dirname(resolve(file)) : undefined;
  const { value, issues } = checkYamlDocument(text, ProjectFileSchema, (v, structural) =>
    checkProject(v, structural, { projectDir }),
  );
  if (hasErrors(issues)) return { issues };
  return { config: applyProjectDefaults(value as ProjectFile), issues };
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Names of <projectDir>/scenarios/*.yaml (and *.yml), sorted. */
export async function listScenarioNames(projectDir: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(join(projectDir, 'scenarios'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const names = files.filter((f) => /\.ya?ml$/i.test(f) && !f.startsWith('.')).map((f) => f.replace(/\.ya?ml$/i, ''));
  return [...new Set(names)].sort();
}

/** Projects of a workspace (directories of projects_dir holding a project.yaml), sorted by slug. */
export async function listProjects(root: string): Promise<Array<{ slug: string; name: string; dir: string }>> {
  const { projectsDir } = await loadWorkspaceConfig(root);
  const out: Array<{ slug: string; name: string; dir: string }> = [];
  for (const slug of (await subdirs(projectsDir)).sort()) {
    const dir = join(projectsDir, slug);
    const text = await readOptional(join(dir, PROJECT_FILE));
    if (text === null) continue;
    const value = parseYaml(text).value as { name?: unknown } | null | undefined;
    const name = value && typeof value.name === 'string' ? value.name : slug;
    out.push({ slug, name, dir });
  }
  return out;
}

async function resolveProjectDir(dirOrSlug: string, root?: string): Promise<{ dir: string; root: string }> {
  const pathLike = isAbsolute(dirOrSlug) || dirOrSlug.startsWith('.') || /[\\/]/.test(dirOrSlug);
  if (pathLike) {
    const dir = resolve(dirOrSlug);
    if (!existsSync(join(dir, PROJECT_FILE))) throw new ConfigError(`no ${PROJECT_FILE} in ${dir}`);
    return { dir, root: root ? resolve(root) : findWorkspaceRoot(dir) };
  }
  const ws = await loadWorkspaceConfig(root ?? findWorkspaceRoot());
  const dir = join(ws.projectsDir, dirOrSlug);
  if (existsSync(join(dir, PROJECT_FILE))) return { dir, root: ws.root };
  const available = (await listProjects(ws.root)).map((p) => p.slug);
  throw new ConfigError(
    `project "${dirOrSlug}" not found in ${ws.projectsDir}${suggestion(dirOrSlug, available)} (available: ${available.join(', ') || 'none'})`,
  );
}

/**
 * Load a project by slug (in the workspace projects dir) or by directory path.
 * Throws ConfigError when it cannot be found or project.yaml has errors; warnings are kept in `issues`.
 */
export async function loadProject(dirOrSlug: string, root?: string): Promise<LoadedProject> {
  const { dir, root: wsRoot } = await resolveProjectDir(dirOrSlug, root);
  const file = join(dir, PROJECT_FILE);
  const text = await readFile(file, 'utf8');
  const { config, issues } = parseProjectYaml(text, file);
  if (!config) throw new ConfigError(issuesMessage('project', issues, file), issues, file);
  return {
    slug: basename(dir),
    dir,
    root: wsRoot,
    config,
    readme: await readOptional(join(dir, README_FILE)),
    scenarios: await listScenarioNames(dir),
    file,
    issues,
  };
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  /** Full README.md content (default: a skeleton with the expected sections). */
  readme?: string;
  environments?: ProjectConfig['environments'];
  /** Personas (L1.6): global, or keyed by environment name. */
  auth?: ProjectConfig['auth'];
  template?: string;
  capture?: Partial<CaptureSettings>;
  frame?: FrameStyle;
}

/** README.md skeleton: what an agent needs to write good scenarios for the product. */
export function readmeSkeleton(name: string, environments: ProjectConfig['environments'] = {}): string {
  const links = Object.entries(environments).flatMap(([env, pages]) =>
    Object.entries(pages).map(([page, url]) => `- ${env} · ${page}: ${url}`),
  );
  return [
    `# ${name}`,
    '',
    '## Product',
    '',
    '<!-- What the product is and does, in a few sentences. Key screens and vocabulary. -->',
    '',
    '## Audience',
    '',
    '<!-- Who the videos are for: role, context, familiarity with the product. -->',
    '',
    '## Goals',
    '',
    '<!-- What each video must make the viewer understand, feel or do. -->',
    '',
    '## Tone',
    '',
    '<!-- Pace, wording of captions, how much motion design (real capture first). -->',
    '',
    '## Environments & links',
    '',
    ...(links.length > 0 ? links : ['<!-- Staging / demo URLs (also declared in project.yaml under environments). -->']),
    '',
    '## Accounts (by reference — never passwords)',
    '',
    '<!-- Which account each scenario uses (the personas of project.yaml) and where its credentials live: password',
    '     manager entry or keychain item (keychain:service/account). `studio login` keeps sessions in ~/.demo-studio. -->',
    '',
    "## Do / Don't",
    '',
    '- Do: ',
    "- Don't: ",
    '',
  ].join('\n');
}

function projectYamlText(input: CreateProjectInput, slug: string): string {
  const { width, height, scale, fps } = DEFAULT_CAPTURE;
  const data: Record<string, unknown> = {
    name: input.name,
    environments: input.environments ?? {},
    ...(input.auth ? { auth: input.auth } : {}),
    capture: { width, height, scale, fps, ...input.capture },
    frame: input.frame ?? DEFAULT_FRAME,
    template: input.template ?? DEFAULT_TEMPLATE_NAME,
  };
  return [
    `# Demo Studio project "${slug}"`,
    stringify(data, { lineWidth: 0 }).trimEnd(),
    ...(input.auth
      ? []
      : [
          '# auth:              # the accounts the videos are filmed as (global, or keyed by environment); never a password or a path:',
          `#   personas:         # \`studio login ${slug} --persona admin\` keeps a session in ~/.demo-studio`,
          '#     admin: {pages: [app], check: {url: "app:/", expect_text: Your account name}}',
        ]),
    '',
  ].join('\n');
}

/** What createProject checks before writing anything: the slug, the folder (absent or empty), the project.yaml. */
async function newProjectPlan(root: string, input: CreateProjectInput): Promise<{ wsRoot: string; dir: string; file: string; yamlText: string }> {
  const ws = await loadWorkspaceConfig(root);
  const slug = input.slug ?? slugify(input.name);
  if (!PROJECT_SLUG_RE.test(slug)) {
    throw new ConfigError(`invalid project slug "${slug}": use lower-case letters, digits and "-"`);
  }
  const dir = join(ws.projectsDir, slug);
  if (existsSync(join(dir, PROJECT_FILE))) throw new ConfigError(`project "${slug}" already exists (${dir})`);
  if (existsSync(dir) && (await readdir(dir)).length > 0) {
    throw new ConfigError(`cannot create project "${slug}": ${dir} exists and is not empty`);
  }
  const file = join(dir, PROJECT_FILE);
  const yamlText = projectYamlText(input, slug);
  const { issues } = parseProjectYaml(yamlText, file);
  if (hasErrors(issues)) throw new ConfigError(issuesMessage('project', issues, file), issues, file);
  return { wsRoot: ws.root, dir, file, yamlText };
}

/** Throws what createProject would refuse, writing nothing (`studio new` checks before asking its questions). */
export async function checkNewProject(root: string, input: CreateProjectInput): Promise<void> {
  await newProjectPlan(root, input);
}

/** Create projects/<slug>/ with README.md, project.yaml, scenarios/, hooks/, assets/ and a .gitignore. */
export async function createProject(root: string, input: CreateProjectInput): Promise<LoadedProject> {
  const { wsRoot, dir, file, yamlText } = await newProjectPlan(root, input);
  for (const sub of ['scenarios', 'hooks', 'assets']) {
    await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, sub, '.gitkeep'), '');
  }
  await writeTextAtomic(file, yamlText);
  const readme = input.readme ?? readmeSkeleton(input.name, input.environments);
  await writeTextAtomic(join(dir, README_FILE), readme.endsWith('\n') ? readme : `${readme}\n`);
  await writeTextAtomic(join(dir, '.gitignore'), PROJECT_GITIGNORE.join('\n') + '\n');
  return loadProject(dir, wsRoot);
}

/** Replace README.md (atomically) and update `project.readme`. */
export async function updateReadme(project: LoadedProject, markdown: string): Promise<void> {
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  await writeTextAtomic(join(project.dir, README_FILE), text);
  project.readme = text;
}
