/**
 * Themes (templates) as clients outside the CLI see them (R-MCP-09): a project's own (`<project>/templates/`, found
 * first when a project is named), the workspace's templates_dir and the starter templates shipped with Retake, with the component each one picks per kind; one theme in detail
 * (template.yaml, its colours, fonts, brand, assets and resolved components). Through MCP a theme is named, switched
 * per render or per scenario, and previewed (template_preview); a new one may be created from brand inputs
 * (brand/create.ts) — an existing one is never edited (a human does).
 *
 * A theme is named, never given as a folder (a project's own theme is a name too): the only theme folder used is the
 * one project.yaml's own `template:` names (a human wrote it), listed with source `project` and `by_path`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPONENT_KINDS } from '@retake/core/model';
import { isNewThemeName, isThemeName } from '@retake/core/ids';
import { insideFolder, isTemplatePath } from '@retake/core/scenario';
import { TEMPLATE_FILE } from '@retake/core/theme';
import { nodeFileFacts } from '@retake/core/io';
import { realPathOf } from '@retake/core/policy';
import { projectLibraryDir } from '@retake/core/project';
import type { ComponentKind } from '@retake/core/model';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedTemplate, TemplateEntry, ThemeOrigin } from '@retake/core/theme';
import type { NewThemeName, ThemeName } from '@retake/core/ids';
import type { ComponentRegistry } from '@retake/components/geometry';
import { projectRegistry } from './components.js';
import { EngineError, toEngineError } from './errors.js';
import { openProjectBySlug } from './projects.js';
import { checkProjectSlug } from './refs.js';
import { sha256Hex } from './storage.js';
import type { OpenedWorkspace } from './workspace.js';

/** Whether two folders are one, symbolic links followed. */
const samePlace = (a: string, b: string): boolean => realPathOf(a, nodeFileFacts) === realPathOf(b, nodeFileFacts);

/** Longest template.yaml text a detail returns. */
const YAML_MAX = 20_000;

/** `name` as the name of a theme that exists, as a request names one (core `isThemeName`), or the refusal. */
export function checkTemplateName(name: string): ThemeName {
  if (!isThemeName(name)) {
    throw new EngineError('invalid', `invalid theme "${String(name)}": a theme name (template_list names them), never a path`);
  }
  return name;
}

/** `name` as a name a new theme may take (core `isNewThemeName`), or the refusal: what a copy and a theme made from a brand both ask. */
export function checkNewThemeName(name: unknown): NewThemeName {
  if (!isNewThemeName(name)) {
    throw new EngineError('invalid', `invalid theme name "${String(name).slice(0, 80)}": lower-case letters, digits and dashes (e.g. my-brand)`);
  }
  return name;
}

/** The component a theme picks for each kind (an id, or null for none); `issues` when one does not resolve. */
function picks(reg: ComponentRegistry, t: LoadedTemplate): { components: Partial<Record<ComponentKind, string | null>>; issues: string[] } {
  try {
    const theme = reg.resolveTheme(t.template);
    const components: Partial<Record<ComponentKind, string | null>> = {};
    for (const kind of COMPONENT_KINDS) components[kind] = theme[kind]?.id ?? null;
    return { components, issues: [] };
  } catch (e) {
    return { components: {}, issues: [toEngineError(e).message] };
  }
}

/**
 * The first reason a listed theme cannot be used for work, or null (its components resolve, its files lie in its folder):
 * the timeline's theme switch shows it disabled with this. One line; the workspace's part of a path cut off.
 */
export async function themeUnusable(dir: string, reg: ComponentRegistry, ws: Pick<OpenedWorkspace, 'root' | 'reads' | 'policy'>): Promise<string | null> {
  const root = ws.root;
  let issue: string | undefined;
  try {
    const t = await ws.reads.loadTemplate(dir, undefined, { files: ws.reads.fileFacts(ws.policy) });
    issue = [...picks(reg, t).issues, ...themeAssetProblems(t)][0];
  } catch (e) {
    issue = toEngineError(e).message;
  }
  return issue === undefined
    ? null
    : issue
        .split(`${root}/`)
        .join('')
        .split(root)
        .join('.')
        .replace(/\s*\n\s*/g, ' ');
}

/**
 * Why a theme's files are refused for work submitted through MCP: its logo, wordmark and fonts must lie in its own
 * folder (symbolic links followed) — a theme cannot serve a file from elsewhere to a render or a preview.
 */
export function themeAssetProblems(t: LoadedTemplate): string[] {
  const files = [t.assets.logo, t.assets.wordmark, t.assets.display, ...t.assets.body].filter((f): f is string => typeof f === 'string');
  return files.filter((f) => !insideFolder(t.dir, f, nodeFileFacts)).map((f) => `theme ${t.name}: ${f} lies outside its folder ${t.dir}`);
}

export interface TemplateSummary {
  name: string;
  /**
   * project: the project's own (a folder of `<project>/templates/`, or the folder project.yaml's own `template:` names —
   * `by_path`); workspace: templates_dir; starter: shipped with Retake.
   */
  source: ThemeOrigin;
  /** A project theme hiding a theme of its name: the workspace's, else a starter. */
  shadows?: 'workspace' | 'starter';
  /** The folder project.yaml's `template:` names by its path (not a folder of `<project>/templates/`). */
  by_path?: true;
  dir: string;
  /** The project's theme (with `project`). */
  default?: true;
  brand?: { name?: string; url?: string };
  style_bias?: string;
  /** The component picked per kind (null: none). */
  components: Partial<Record<ComponentKind, string | null>>;
  /** Why it does not load, or a kind that does not resolve. */
  issues: string[];
}

export interface TemplateDetail extends TemplateSummary {
  /** template.yaml as written (truncated) and its sha256. */
  yaml: string;
  sha256: string;
  colors: Record<string, string>;
  fonts: { display: string; body: string[] };
  assets: LoadedTemplate['assets'];
  /** Each kind's pick with its params (defaults applied). */
  resolved: Partial<Record<ComponentKind, { id: string; params: Record<string, unknown> } | null>>;
}

export interface TemplateListView {
  templates_dir: string;
  /** With `project`: its own themes' folder (`<project>/templates`, found first). */
  project_templates_dir?: string;
  templates: TemplateSummary[];
  /** With `project`: its theme as project.yaml names it. */
  project_theme?: string;
  /** With `project`: each of its themes hiding a workspace theme or a starter of that name, said once. */
  notices?: string[];
}

function summaryOf(t: LoadedTemplate, source: TemplateSummary['source'], reg: ComponentRegistry, isDefault: boolean): TemplateSummary {
  const p = picks(reg, t);
  return {
    name: t.name,
    source,
    dir: t.dir,
    ...(isDefault ? { default: true as const } : {}),
    ...(t.template.brand ? { brand: t.template.brand } : {}),
    style_bias: t.template.style_bias,
    components: p.components,
    issues: [...p.issues, ...themeAssetProblems(t)],
  };
}

/** The notice of a project theme hiding another of its name (a list's `notices`, the Studio's badge words). */
export function shadowNotice(name: string, shadows: 'workspace' | 'starter'): string {
  return `the project's theme "${name}" is used instead of ${shadows === 'workspace' ? "the workspace's theme" : 'the starter theme'} of that name`;
}

/** A listed theme's summary (its load failure as an issue). */
async function listedSummary(ws: OpenedWorkspace, e: TemplateEntry, reg: ComponentRegistry, isDefault: boolean): Promise<TemplateSummary> {
  const extra = e.shadows ? { shadows: e.shadows } : {};
  try {
    return { ...summaryOf(await ws.reads.loadTemplate(e.dir, undefined, { files: ws.reads.fileFacts(ws.policy) }), e.source, reg, isDefault), ...extra };
  } catch (err) {
    return { name: e.name, source: e.source, ...extra, dir: e.dir, ...(isDefault ? { default: true as const } : {}), components: {}, issues: [toEngineError(err).message] };
  }
}

/**
 * Every theme of the workspace; with `project`, its own themes first (a project theme hides the workspace's or the
 * starter of its name: `shadows`, and a notice), which one is its default, and the folder project.yaml names by its
 * path — one entry with the named theme when that folder is one of `<project>/templates/`.
 */
export async function templateList(ws: OpenedWorkspace, projectSlug?: string): Promise<TemplateListView> {
  const project = projectSlug !== undefined ? await openProjectBySlug(ws, checkProjectSlug(projectSlug)) : undefined;
  // The project's registry: a theme's picks resolve as the project's renders resolve them (its own components first).
  const reg = await projectRegistry(ws, project);
  const own = project?.config.template;
  const listed = await ws.reads.listTemplates(ws.root, project ? { projectDir: project.dir } : undefined);
  // The folder project.yaml names by its path, when it is one of the listed folders (the project's templates/<n>).
  const pathFolder = project && own !== undefined && isTemplatePath(own) ? (await ws.reads.projectTemplateFolder(project, own)).dir : undefined;
  const isPathEntry = (e: TemplateEntry): boolean => pathFolder !== undefined && e.source === 'project' && samePlace(e.dir, pathFolder);
  const out: TemplateSummary[] = [];
  for (const e of listed) out.push(await listedSummary(ws, e, reg, own === e.name || isPathEntry(e)));
  if (project && own !== undefined && pathFolder !== undefined && !listed.some(isPathEntry)) {
    try {
      out.unshift({ ...summaryOf(await ws.reads.loadProjectTemplate(project, undefined, { files: ws.reads.fileFacts(ws.policy) }), 'project', reg, true), by_path: true });
    } catch (err) {
      out.unshift({ name: own, source: 'project', by_path: true, dir: join(project.dir, own), default: true, components: {}, issues: [toEngineError(err).message] });
    }
  }
  const notices = out.filter((t) => t.shadows !== undefined).map((t) => shadowNotice(t.name, t.shadows!));
  return {
    templates_dir: ws.templatesDir,
    ...(project ? { project_templates_dir: projectLibraryDir(project.dir, 'templates') } : {}),
    templates: out,
    ...(own !== undefined ? { project_theme: own } : {}),
    ...(project ? { notices } : {}),
  };
}

/**
 * The theme work submitted through MCP uses: a name (the project's own themes, the workspace templates, then the
 * starters), or — none given — the project's theme (a folder only when project.yaml names it). NotFound / invalid as
 * EngineErrors.
 */
export async function themeForWork(ws: Pick<OpenedWorkspace, 'reads' | 'policy'>, project: LoadedProject, name: string | undefined): Promise<LoadedTemplate> {
  if (name !== undefined) checkTemplateName(name);
  try {
    return await ws.reads.loadProjectTemplate(project, name, { files: ws.reads.fileFacts(ws.policy) });
  } catch (e) {
    throw toEngineError(e);
  }
}

/** One theme in detail (a name; with `project`, its default when `template` is omitted). */
export async function templateGet(ws: OpenedWorkspace, o: { template?: string; project?: string }): Promise<TemplateDetail> {
  if (o.template === undefined && o.project === undefined) throw new EngineError('invalid', 'name a theme (template), or a project for its own theme');
  let t: LoadedTemplate;
  let source: TemplateSummary['source'];
  let shadows: TemplateSummary['shadows'];
  let byPath = false;
  let isDefault = false;
  let project: LoadedProject | undefined;
  if (o.project !== undefined) {
    project = await openProjectBySlug(ws, checkProjectSlug(o.project));
    t = await themeForWork(ws, project, o.template);
    const own = project.config.template;
    isDefault = o.template === undefined || o.template === own;
    const listed = (await ws.reads.listTemplates(ws.root, { projectDir: project.dir })).find((e) => samePlace(e.dir, t.dir));
    if (o.template === undefined && isTemplatePath(own) && listed?.source !== 'project') {
      // project.yaml's path theme, as the list's row says it: the project's, by its path (whatever folder it reaches).
      source = 'project';
      byPath = true;
    } else {
      source = listed?.source ?? 'workspace';
      if (listed?.shadows) shadows = listed.shadows;
    }
  } else {
    checkTemplateName(o.template!);
    try {
      t = await ws.reads.loadTemplate(o.template!, ws.root, { files: ws.reads.fileFacts(ws.policy) });
    } catch (e) {
      throw toEngineError(e);
    }
    source = (await ws.reads.listTemplates(ws.root)).find((e) => e.name === t.name)?.source ?? 'workspace';
  }
  const reg = await projectRegistry(ws, project);
  const buf = await readFile(join(t.dir, TEMPLATE_FILE));
  const text = buf.toString('utf8');
  const resolved: TemplateDetail['resolved'] = {};
  try {
    const theme = reg.resolveTheme(t.template);
    for (const kind of COMPONENT_KINDS) resolved[kind] = theme[kind] ? { id: theme[kind]!.id, params: theme[kind]!.params } : null;
  } catch {
    /* listed in issues */
  }
  return {
    ...summaryOf(t, source, reg, isDefault),
    ...(shadows ? { shadows } : {}),
    ...(byPath ? { by_path: true as const } : {}),
    yaml: text.length > YAML_MAX ? `${text.slice(0, YAML_MAX)}… (${text.length - YAML_MAX} more characters)` : text,
    sha256: sha256Hex(buf),
    colors: { ...t.template.colors },
    fonts: t.template.fonts,
    assets: t.assets,
    resolved,
  };
}

/**
 * The serialisation key of a theme's writes: the folder the name resolves to — the project's own `templates/<name>`
 * when there, else the workspace's — so one folder has one key whichever screen writes it, and a project's theme and
 * the workspace's of that name are two.
 */
export function themeFolderKey(ws: Pick<OpenedWorkspace, 'projectsDir' | 'templatesDir'>, project: string | undefined, name: string): string {
  const own = project !== undefined ? projectLibraryDir(join(ws.projectsDir, project), 'templates', name) : undefined;
  const dir = own !== undefined && existsSync(own) ? own : join(ws.templatesDir, name);
  return `theme:${dir.toLowerCase()}`;
}
