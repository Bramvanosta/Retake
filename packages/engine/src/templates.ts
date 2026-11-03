/**
 * Themes (templates) as clients outside the CLI see them (L3.2, R-MCP-09): the workspace's templates_dir and the
 * starter templates shipped with Retake, with the component each one picks per kind; one theme in detail
 * (template.yaml, its colours, fonts, brand, assets and resolved components). Through MCP a theme is named, switched
 * per render or per scenario, and previewed (template_preview); a new one may be created from brand inputs
 * (brand/create.ts, L3.5) — an existing one is never edited (a human does).
 *
 * A theme is named, never given as a folder: the only theme folder used is the one project.yaml's own `template:`
 * names (a human wrote it), listed with source `project`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPONENT_KINDS, TEMPLATE_FILE, TEMPLATE_NAME_RE, insideFolder, isTemplatePath, listTemplates, loadProjectTemplate, loadTemplate } from '@retake/core';
import type { ComponentKind, LoadedProject, LoadedTemplate, WorkspaceConfig } from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import { workspaceRegistry } from './components.js';
import { EngineError, toEngineError } from './errors.js';
import { openProjectBySlug } from './projects.js';
import { checkProjectSlug } from './refs.js';
import { sha256Hex } from './storage.js';

/** Longest template.yaml text a detail returns. */
const YAML_MAX = 20_000;

export function checkTemplateName(name: string): string {
  if (typeof name !== 'string' || !TEMPLATE_NAME_RE.test(name) || name.length > 100) {
    throw new EngineError('invalid', `invalid theme "${String(name)}": a theme name (template_list names them), never a path`);
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
 * the timeline's theme switch shows it disabled with this (review B L4). One line; the workspace's part of a path cut off.
 */
export async function themeUnusable(dir: string, reg: ComponentRegistry, root: string): Promise<string | null> {
  let issue: string | undefined;
  try {
    const t = await loadTemplate(dir);
    issue = [...picks(reg, t).issues, ...themeAssetProblems(t)][0];
  } catch (e) {
    issue = toEngineError(e).message;
  }
  return issue === undefined ? null : issue.split(`${root}/`).join('').split(root).join('.').replace(/\s*\n\s*/g, ' ');
}

/**
 * Why a theme's files are refused for work submitted through MCP: its logo, wordmark and fonts must lie in its own
 * folder (symbolic links followed) — a theme cannot serve a file from elsewhere to a render or a preview.
 */
export function themeAssetProblems(t: LoadedTemplate): string[] {
  const files = [t.assets.logo, t.assets.wordmark, t.assets.display, ...t.assets.body].filter((f): f is string => typeof f === 'string');
  return files.filter((f) => !insideFolder(t.dir, f)).map((f) => `theme ${t.name}: ${f} lies outside its folder ${t.dir}`);
}

export interface TemplateSummary {
  name: string;
  /** workspace: templates_dir; starter: shipped with Retake; project: the folder project.yaml's own template: names. */
  source: 'workspace' | 'starter' | 'project';
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
  templates: TemplateSummary[];
  /** With `project`: its theme as project.yaml names it. */
  project_theme?: string;
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

/** Every theme of the workspace (and, with `project`, which one is its default — its own folder too). */
export async function templateList(ws: WorkspaceConfig, projectSlug?: string): Promise<TemplateListView> {
  const project = projectSlug !== undefined ? await openProjectBySlug(ws, checkProjectSlug(projectSlug)) : undefined;
  const reg = await workspaceRegistry(ws);
  const own = project?.config.template;
  const out: TemplateSummary[] = [];
  for (const e of await listTemplates(ws.root)) {
    try {
      out.push(summaryOf(await loadTemplate(e.dir), e.source, reg, own === e.name));
    } catch (err) {
      out.push({ name: e.name, source: e.source, dir: e.dir, ...(own === e.name ? { default: true as const } : {}), components: {}, issues: [toEngineError(err).message] });
    }
  }
  if (project && own !== undefined && isTemplatePath(own)) {
    try {
      out.unshift(summaryOf(await loadProjectTemplate(project), 'project', reg, true));
    } catch (err) {
      out.unshift({ name: own, source: 'project', dir: join(project.dir, own), default: true, components: {}, issues: [toEngineError(err).message] });
    }
  }
  return { templates_dir: ws.templatesDir, templates: out, ...(own !== undefined ? { project_theme: own } : {}) };
}

/**
 * The theme work submitted through MCP uses: a name (workspace templates, then the starters), or — none given — the
 * project's own theme (a folder only when project.yaml names it). NotFound / invalid as EngineErrors.
 */
export async function themeForWork(project: LoadedProject, name?: string): Promise<LoadedTemplate> {
  if (name !== undefined) checkTemplateName(name);
  try {
    return await loadProjectTemplate(project, name);
  } catch (e) {
    throw toEngineError(e);
  }
}

/** One theme in detail (a name; with `project`, its default when `template` is omitted). */
export async function templateGet(ws: WorkspaceConfig, o: { template?: string; project?: string }): Promise<TemplateDetail> {
  if (o.template === undefined && o.project === undefined) throw new EngineError('invalid', 'name a theme (template), or a project for its own theme');
  let t: LoadedTemplate;
  let source: TemplateSummary['source'];
  let isDefault = false;
  if (o.project !== undefined) {
    const project = await openProjectBySlug(ws, checkProjectSlug(o.project));
    t = await themeForWork(project, o.template);
    const own = project.config.template;
    isDefault = o.template === undefined || o.template === own;
    source = o.template === undefined && isTemplatePath(own) ? 'project' : (await listTemplates(ws.root)).find((e) => e.name === t.name)?.source ?? 'workspace';
  } else {
    checkTemplateName(o.template!);
    try {
      t = await loadTemplate(o.template!, ws.root);
    } catch (e) {
      throw toEngineError(e);
    }
    source = (await listTemplates(ws.root)).find((e) => e.name === t.name)?.source ?? 'workspace';
  }
  const reg = await workspaceRegistry(ws);
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
    yaml: text.length > YAML_MAX ? `${text.slice(0, YAML_MAX)}… (${text.length - YAML_MAX} more characters)` : text,
    sha256: sha256Hex(buf),
    colors: { ...t.template.colors },
    fonts: t.template.fonts,
    assets: t.assets,
    resolved,
  };
}
