/**
 * What a project uses of the library (its themes; its components and its export build on the same reads): the theme
 * references a project's files hold — project.yaml's `template:` and each scenario's own `template:` — and, across the
 * workspace, which projects and scenarios reach a given theme folder. A reference is judged by the folder the project's
 * work would load for it (core io projectTemplateFolder: its own themes first, then the workspace's, then the
 * starters; a path against the project), so a project whose own `templates/brand/` hides the workspace's `brand` does
 * not use the workspace's, and a path reference to the workspace's folder does.
 */
import { join } from 'node:path';
import { parseYaml } from '@retake/core/base';
import { projectPath } from '@retake/core/project';
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
