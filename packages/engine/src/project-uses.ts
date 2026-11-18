/**
 * What a project uses of the library (its themes and components; its export builds on the same reads): the theme
 * references a project's files hold — project.yaml's `template:` and each scenario's own `template:` — and, across the
 * workspace, which projects and scenarios reach a given theme folder. A reference is judged by the folder the project's
 * work would load for it (core io projectTemplateFolder: its own themes first, then the workspace's, then the
 * starters; a path against the project), so a project whose own `templates/brand/` hides the workspace's `brand` does
 * not use the workspace's, and a path reference to the workspace's folder does.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '@retake/core/base';
import { projectLibraryDir, projectPath } from '@retake/core/project';
import { TEMPLATE_FILE, resolveThemeComponents } from '@retake/core/theme';
import type { LoadedProject } from '@retake/core/project';
import { readPlainFile, nodeFileFacts } from '@retake/core/io';
import { realPathOf } from '@retake/core/policy';
import { isTemplatePath } from '@retake/core/scenario';
import { listProjectSummaries, openProjectBySlug } from './projects.js';
import type { OpenedWorkspace } from './workspace.js';

/** The longest scenario file read for its theme reference. */
const SCENARIO_READ_MAX = 512 * 1024;

/** A theme reference of a project: project.yaml's (`scenario` absent) or a scenario's own. */
export interface ThemeRef {
  ref: string;
  scenario?: string;
}

/** Who uses a theme folder: projects (by project.yaml) and scenarios (by their own `template:`). */
export interface ThemeUses {
  projects: string[];
  scenarios: Array<{ project: string; scenario: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The theme references a project's files hold: project.yaml's `template:`, then each scenario's own `template:`. */
export function themeRefsOf(project: LoadedProject): ThemeRef[] {
  const out: ThemeRef[] = [];
  if (typeof project.config.template === 'string') out.push({ ref: project.config.template });
  for (const s of project.scenarios) {
    const r = readPlainFile(projectPath(project.dir, 'scenarios', `${s}.yaml`), SCENARIO_READ_MAX);
    const r2 = r.ok ? r : readPlainFile(projectPath(project.dir, 'scenarios', `${s}.yml`), SCENARIO_READ_MAX);
    if (!r2.ok) continue;
    const v = parseYaml(r2.bytes.toString('utf8')).value;
    if (isObj(v) && typeof v.template === 'string') out.push({ ref: v.template, scenario: s });
  }
  return out;
}

/** The real path of the folder a project's work would load for a theme reference. */
async function folderOfRef(ws: OpenedWorkspace, project: LoadedProject, ref: string): Promise<string> {
  return realPathOf((await ws.reads.projectTemplateFolder(project, ref)).dir, nodeFileFacts);
}

/** Every project of the workspace that opens (one that does not is skipped: it uses nothing anyone can render). */
async function openProjects(ws: OpenedWorkspace): Promise<LoadedProject[]> {
  const out: LoadedProject[] = [];
  for (const p of await listProjectSummaries(ws)) {
    if (p.error) continue;
    try {
      out.push(await openProjectBySlug(ws, p.slug));
    } catch {
      /* a project that does not open uses nothing */
    }
  }
  return out;
}

/** Who uses each theme folder of the workspace, keyed by the folder's real path (shadowing and path references followed). */
export async function themeUsesByFolder(ws: OpenedWorkspace): Promise<Map<string, ThemeUses>> {
  const out = new Map<string, ThemeUses>();
  const of = (dir: string): ThemeUses => {
    let u = out.get(dir);
    if (!u) out.set(dir, (u = { projects: [], scenarios: [] }));
    return u;
  };
  for (const project of await openProjects(ws)) {
    for (const r of themeRefsOf(project)) {
      const dir = await folderOfRef(ws, project, r.ref);
      if (r.scenario === undefined) of(dir).projects.push(project.slug);
      else of(dir).scenarios.push({ project: project.slug, scenario: r.scenario });
    }
  }
  return out;
}

/** Who reaches a theme folder (usersOfThemeFolder): `slug (project.yaml)` / `slug/scenario`, and the projects that do not open. */
export interface ThemeFolderUsers {
  users: string[];
  /** The adopting project's own references by path (`except`'s: a copy in its templates/ does not serve them). */
  own_paths: string[];
  /** Projects that do not open: whether they use it cannot be told. */
  unreadable: string[];
}

/**
 * The projects and scenarios that reach the theme folder `dir`. Of the project `except` (the one adopting it) only its
 * references by path count (`own_paths`: a name finds its own copy, a path keeps naming this folder). A project that
 * does not open is named in `unreadable`.
 */
export async function usersOfThemeFolder(ws: OpenedWorkspace, dir: string, o: { except?: string } = {}): Promise<ThemeFolderUsers> {
  const real = realPathOf(dir, nodeFileFacts);
  const out: ThemeFolderUsers = { users: [], own_paths: [], unreadable: [] };
  for (const p of await listProjectSummaries(ws)) {
    let project: LoadedProject;
    try {
      if (p.error) throw new Error(p.error);
      project = await openProjectBySlug(ws, p.slug);
    } catch {
      out.unreadable.push(p.slug);
      continue;
    }
    const own = project.slug === o.except;
    for (const r of themeRefsOf(project)) {
      if (own && !isTemplatePath(r.ref)) continue;
      if ((await folderOfRef(ws, project, r.ref)) !== real) continue;
      const who = r.scenario === undefined ? `${project.slug} (project.yaml)` : `${project.slug}/${r.scenario}`;
      (own ? out.own_paths : out.users).push(who);
    }
  }
  return out;
}

/** The workspace theme `name`'s users (usersOfThemeFolder of `<templates_dir>/<name>`), the adopting project `except` by its paths only. */
export function usersOfWorkspaceTheme(ws: OpenedWorkspace, name: string, o: { except?: string } = {}): Promise<ThemeFolderUsers> {
  return usersOfThemeFolder(ws, join(ws.templatesDir, name), o);
}

/**
 * The render records of projects other than `except` that name the theme folder `id` (`template_folder`), counted per
 * project (`other (3 renders)`): what a move leaves naming a folder set aside. Read through the outputs port.
 */
export async function rendersOfThemeFolder(ws: OpenedWorkspace, id: string, o: { except?: string } = {}): Promise<string[]> {
  const out: string[] = [];
  const renders = ws.outputs.renders;
  for (const project of await openProjects(ws)) {
    if (project.slug === o.except) continue;
    let n = 0;
    for (const e of await renders.entries(renders.dirOf(project.dir)).catch(() => [])) {
      const folder = e.read.ok ? e.read.value.template_folder : undefined;
      if (typeof folder === 'string' && ws.reads.sameTemplateFolder(folder, id, project)) n++;
    }
    if (n) out.push(`${project.slug} (${n} ${n === 1 ? 'render' : 'renders'})`);
  }
  return out;
}

/** Who uses a workspace component (usersOfWorkspaceComponent): `slug/scenario`, `slug theme <t>`, `theme <t>`, and the projects that do not open. */
export interface ComponentUsers {
  users: string[];
  /** Projects (and workspace themes) that do not open: whether they use it cannot be told. */
  unreadable: string[];
}

/** Whether a text names the component id `id` as a value (never a part of a longer id or path). */
export function namesComponent(text: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9/_.-])${esc}($|[^A-Za-z0-9/_.-])`).test(text);
}

/** The text of a project file, or undefined (missing, too large, not a plain file). */
function textOf(file: string): string | undefined {
  const r = readPlainFile(file, SCENARIO_READ_MAX);
  return r.ok ? r.bytes.toString('utf8') : undefined;
}

/** Whether a theme folder picks the component `id`: its template.yaml names it, or one of its kinds resolves to it (the defaults too). */
async function themePicks(ws: OpenedWorkspace, dir: string, id: string): Promise<boolean | 'unreadable'> {
  const text = textOf(join(dir, TEMPLATE_FILE));
  if (text === undefined) return 'unreadable';
  if (namesComponent(text, id)) return true;
  try {
    const t = await ws.reads.loadTemplate(dir, undefined, { files: ws.reads.fileFacts(ws.policy) });
    return Object.values(resolveThemeComponents(t.template)).some((c) => c !== null && c.id === id);
  } catch {
    return 'unreadable';
  }
}

/**
 * The users of the workspace component `id` (a move sets its folder aside): every theme of the workspace's
 * templates_dir that picks it (any project may render with it), and in each other project that does not hold its own
 * component of that id — the project's own themes picking it, its project.yaml and scenarios naming it. Of the project
 * `except` (the one adopting it) nothing counts: its own copy is found first. A project or a workspace theme that does
 * not open is named in `unreadable`.
 */
export async function usersOfWorkspaceComponent(ws: OpenedWorkspace, id: string, o: { except?: string } = {}): Promise<ComponentUsers> {
  const out: ComponentUsers = { users: [], unreadable: [] };
  for (const e of await ws.reads.listTemplates(ws.root)) {
    if (e.source !== 'workspace') continue;
    const picks = await themePicks(ws, e.dir, id);
    if (picks === 'unreadable') out.unreadable.push(`theme ${e.name}`);
    else if (picks) out.users.push(`theme ${e.name}`);
  }
  for (const p of await listProjectSummaries(ws)) {
    if (p.slug === o.except) continue;
    let project: LoadedProject;
    try {
      if (p.error) throw new Error(p.error);
      project = await openProjectBySlug(ws, p.slug);
    } catch {
      out.unreadable.push(p.slug);
      continue;
    }
    // A project holding its own component of that id never reaches the workspace's.
    if (existsSync(projectLibraryDir(project.dir, 'components', ...id.split('/'), 'component.yaml'))) continue;
    for (const e of await ws.reads.listTemplates(project.root, { projectDir: project.dir })) {
      if (e.source !== 'project') continue;
      const picks = await themePicks(ws, e.dir, id);
      if (picks === 'unreadable') out.unreadable.push(`${project.slug} theme ${e.name}`);
      else if (picks) out.users.push(`${project.slug} theme ${e.name}`);
    }
    const yaml = textOf(join(project.dir, 'project.yaml'));
    if (yaml !== undefined && namesComponent(yaml, id)) out.users.push(`${project.slug} (project.yaml)`);
    for (const s of project.scenarios) {
      const text = textOf(projectPath(project.dir, 'scenarios', `${s}.yaml`)) ?? textOf(projectPath(project.dir, 'scenarios', `${s}.yml`));
      if (text !== undefined && namesComponent(text, id)) out.users.push(`${project.slug}/${s}`);
    }
  }
  return out;
}
