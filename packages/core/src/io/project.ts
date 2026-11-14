/**
 * The project readers: a workspace's projects, a project loaded (project.yaml, its sandboxes, its README, its
 * scenarios' names) and the plan of a new project checked against the disk.
 */
import { basename, isAbsolute, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { WorkspaceDisk } from '../file-facts.js';
import { FORMAT_VERSIONS } from '../formats.js';
import { ConfigError, hasErrors, issuesMessage } from '../issues.js';
import { projectPath, projectRef } from '../layout.js';
import { DEFAULT_FRAME, createdPages, DEFAULT_TEMPLATE_NAME, PROJECT_FILE, PROJECT_GITIGNORE, PROJECT_SLUG_RE, README_FILE, parseProjectYaml, readmeSkeleton } from '../project.js';
import type { CreateProjectInput, NewProjectPlan } from '../project.js';
import { mergeSandboxes } from '../sandbox.js';
import { DEFAULT_CAPTURE } from '../types.js';
import type { LoadedProject } from '../types.js';
import { slugify } from '../util.js';
import { parseYaml } from '../validation/yaml-source.js';
import { suggestion } from '../validation/suggest.js';
import { insideBundle } from './bundle.js';
import { nodeWorkspaceDisk } from './file-facts.js';
import { loadSandboxesOn } from './sandbox.js';
import { findWorkspaceRootOn, loadWorkspaceConfigOn } from './workspace.js';

/** The largest README.md a project load keeps in memory (the engine's own reader shows why a bigger one is not shown). */
const README_LOAD_MAX_BYTES = 2 * 1024 * 1024;

/**
 * README.md for `project.readme`, or null: missing, or not a small plain file (L4.2, BL-79 residue: a FIFO named
 * README.md held every project load; a link or an oversized file is left to the engine's reader, which says why).
 */
function readmeText(disk: WorkspaceDisk, file: string): string | null {
  const r = disk.readPlain(file, README_LOAD_MAX_BYTES);
  return r.ok ? r.bytes.toString('utf8') : null;
}

async function readOptional(disk: WorkspaceDisk, file: string): Promise<string | null> {
  try {
    return (await disk.readFile(file)).toString('utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function subdirs(disk: WorkspaceDisk, dir: string): Promise<string[]> {
  try {
    const entries = await disk.list(dir);
    return entries.filter((e) => e.kind === 'directory' && !e.name.startsWith('.')).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Names of <projectDir>/scenarios/*.yaml (and *.yml), sorted. */
export async function listScenarioNames(projectDir: string): Promise<string[]> {
  return listScenarioNamesOn(nodeWorkspaceDisk, projectDir);
}

/** listScenarioNames on a disk. */
export async function listScenarioNamesOn(disk: WorkspaceDisk, projectDir: string): Promise<string[]> {
  let files: string[];
  try {
    files = (await disk.list(projectPath(projectDir, 'scenarios'))).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const names = files.filter((f) => /\.ya?ml$/i.test(f) && !f.startsWith('.')).map((f) => f.replace(/\.ya?ml$/i, ''));
  return [...new Set(names)].sort();
}

/** Projects of a workspace (directories of projects_dir holding a project.yaml), sorted by slug. */
export async function listProjects(root: string): Promise<Array<{ slug: string; name: string; dir: string }>> {
  return listProjectsOn(nodeWorkspaceDisk, root);
}

/** listProjects on a disk. */
export async function listProjectsOn(disk: WorkspaceDisk, root: string): Promise<Array<{ slug: string; name: string; dir: string }>> {
  const { projectsDir } = await loadWorkspaceConfigOn(disk, root);
  const out: Array<{ slug: string; name: string; dir: string }> = [];
  for (const slug of (await subdirs(disk, projectsDir)).sort()) {
    const dir = join(projectsDir, slug);
    const text = await readOptional(disk, join(dir, PROJECT_FILE));
    if (text === null) continue;
    const value = parseYaml(text).value as { name?: unknown } | null | undefined;
    const name = value && typeof value.name === 'string' ? value.name : slug;
    out.push({ slug, name, dir });
  }
  return out;
}

async function resolveProjectDir(disk: WorkspaceDisk, dirOrSlug: string, root?: string): Promise<{ dir: string; root: string }> {
  const exists = (p: string) => disk.facts.kind(p) !== undefined;
  const pathLike = isAbsolute(dirOrSlug) || dirOrSlug.startsWith('.') || /[\\/]/.test(dirOrSlug);
  if (pathLike) {
    const dir = resolve(dirOrSlug);
    if (!exists(join(dir, PROJECT_FILE))) throw new ConfigError(`no ${PROJECT_FILE} in ${dir}`);
    return { dir, root: root ? resolve(root) : findWorkspaceRootOn(disk, dir) };
  }
  const ws = await loadWorkspaceConfigOn(disk, root ?? findWorkspaceRootOn(disk));
  const dir = join(ws.projectsDir, dirOrSlug);
  if (exists(join(dir, PROJECT_FILE))) return { dir, root: ws.root };
  const available = (await listProjectsOn(disk, ws.root)).map((p) => p.slug);
  throw new ConfigError(`project "${dirOrSlug}" not found in ${ws.projectsDir}${suggestion(dirOrSlug, available)} (available: ${available.join(', ') || 'none'})`);
}

/**
 * Load a project by slug (in the workspace projects dir) or by directory path.
 * Throws ConfigError when it cannot be found or project.yaml has errors; warnings are kept in `issues`.
 */
export async function loadProject(dirOrSlug: string, root?: string): Promise<LoadedProject> {
  return loadProjectOn(nodeWorkspaceDisk, dirOrSlug, root);
}

/** loadProject on a disk. */
export async function loadProjectOn(disk: WorkspaceDisk, dirOrSlug: string, root?: string): Promise<LoadedProject> {
  const { dir, root: wsRoot } = await resolveProjectDir(disk, dirOrSlug, root);
  const file = join(dir, PROJECT_FILE);
  // Runs, renders and exports are written in the project folder: never one inside the app bundle (a link into it too).
  if (insideBundle(dir)) throw new ConfigError(`the project ${dir} lies inside the Retake app, which nothing may write to: use a folder of your own`, [], file);
  const text = (await disk.readFile(file)).toString('utf8');
  const { config, issues } = parseProjectYaml(text, file, disk.facts);
  if (!config) throw new ConfigError(issuesMessage('project', issues, file), issues, file);
  // Sandbox environments (L1.8): each manifest is read and validated (a broken one throws), then merged in.
  const sandboxes = await loadSandboxesOn(disk, dir, config);
  return {
    slug: basename(dir),
    dir,
    root: wsRoot,
    config: sandboxes ? mergeSandboxes(config, sandboxes) : config,
    readme: readmeText(disk, join(dir, README_FILE)),
    scenarios: await listScenarioNamesOn(disk, dir),
    file,
    issues,
    ...(sandboxes ? { sandboxes } : {}),
  };
}

function projectYamlText(input: CreateProjectInput, slug: string): string {
  const { width, height, scale, fps } = DEFAULT_CAPTURE;
  const data: Record<string, unknown> = {
    version: FORMAT_VERSIONS.project,
    name: input.name,
    environments: input.environments ?? {},
    ...(input.default_env !== undefined ? { default_env: input.default_env } : {}),
    ...(input.auth ? { auth: input.auth } : {}),
    capture: { width, height, scale, fps, ...input.capture },
    frame: input.frame ?? DEFAULT_FRAME,
    template: input.template ?? DEFAULT_TEMPLATE_NAME,
  };
  return [
    `# Retake project "${slug}"`,
    stringify(data, { lineWidth: 0 }).trimEnd(),
    ...(input.auth
      ? []
      : [
          '# auth:              # the accounts the videos are filmed as (global, or keyed by environment); never a password or a path:',
          `#   personas:         # \`retake login ${slug} --persona admin\` keeps a session in ~/.retake`,
          '#     admin: {pages: [app], check: {url: "app:/", expect_text: Your account name}}',
        ]),
    '',
  ].join('\n');
}

/** What planNewProject checks before naming any file: the slug, the folder (absent or empty), the project.yaml. */
async function newProjectPlan(disk: WorkspaceDisk, root: string, input: CreateProjectInput): Promise<{ wsRoot: string; slug: string; dir: string; file: string; yamlText: string }> {
  const ws = await loadWorkspaceConfigOn(disk, root);
  const slug = input.slug ?? slugify(input.name);
  if (!PROJECT_SLUG_RE.test(slug)) {
    throw new ConfigError(`invalid project slug "${slug}": use lower-case letters, digits and "-"`);
  }
  const dir = join(ws.projectsDir, slug);
  if (disk.facts.kind(join(dir, PROJECT_FILE)) !== undefined) throw new ConfigError(`project "${slug}" already exists (${dir})`);
  if (disk.facts.kind(dir) !== undefined && (await disk.list(dir)).length > 0) {
    throw new ConfigError(`cannot create project "${slug}": ${dir} exists and is not empty`);
  }
  const file = join(dir, PROJECT_FILE);
  const yamlText = projectYamlText(input, slug);
  const { issues } = parseProjectYaml(yamlText, file, disk.facts);
  if (hasErrors(issues)) throw new ConfigError(issuesMessage('project', issues, file), issues, file);
  return { wsRoot: ws.root, slug, dir, file, yamlText };
}

/** Throws what planNewProject would refuse (`retake new` checks before asking its questions). */
export async function checkNewProject(root: string, input: CreateProjectInput): Promise<void> {
  await newProjectPlan(nodeWorkspaceDisk, root, input);
}

/**
 * The files of a new project projects/<slug>/ — scenarios/, hooks/ and assets/ (each with an empty .gitkeep),
 * project.yaml, README.md and a .gitignore — checked (planNewProject throws what a creation refuses) but not written:
 * the engine's project store writes them.
 */
export async function planNewProject(root: string, input: CreateProjectInput): Promise<NewProjectPlan> {
  return planNewProjectOn(nodeWorkspaceDisk, root, input);
}

/** planNewProject on a disk. */
export async function planNewProjectOn(disk: WorkspaceDisk, root: string, input: CreateProjectInput): Promise<NewProjectPlan> {
  const { wsRoot, slug, dir, yamlText } = await newProjectPlan(disk, root, input);
  const readme = input.readme ?? readmeSkeleton(input.name, ...createdPages(input.environments));
  return {
    wsRoot,
    slug,
    dir,
    files: [
      ...(['scenarios', 'hooks', 'assets'] as const).map((d) => ({ ref: projectRef(d, '.gitkeep'), text: '' })),
      { ref: PROJECT_FILE, text: yamlText },
      { ref: README_FILE, text: readme.endsWith('\n') ? readme : `${readme}\n` },
      { ref: '.gitignore', text: PROJECT_GITIGNORE.join('\n') + '\n' },
    ],
  };
}
