/**
 * Components as clients outside the CLI see them (R-MCP-13/14/16): the registry of the workspace (its
 * components/ folder, then the built-in library) listed and read, a component validated (manifest, entry, esbuild
 * compile — nothing is executed), and a workspace component scaffolded from its kind's template.
 *
 * Inputs are ids ("namespace/name"), never folders. Nothing here writes component code: `componentCreate` writes the
 * tool's own scaffold, refuses the built-in namespace and any built-in id (a workspace component of that id would
 * replace the built-in in every render), and renders no preview (component_preview does, into .retake/previews/).
 * The registry comes from the workspace's ComponentRegistries port; the components package's other work (esbuild)
 * from its calls (registries/component-calls.ts), loaded on the first call.
 *
 * The shell forms (the CLI's `retake components`): a person at a terminal names a component by id or by folder,
 * may scaffold over a built-in id (the CLI warns), renders previews into the component's own folder (preview.png +
 * preview.json + its README's block) — `componentListEntries`, `componentValidateShell`, `componentCreateShell`,
 * `componentPreviewTargets`, `componentPreviewTheme`, `componentReadmeWriter`: names of their own, so that no MCP or
 * Studio input reaches them by a type mistake.
 * Their refusals are the adapters' own errors, unchanged (the words the person reads); the forms above them are
 * untouched (the MCP and Studio data).
 */
import { existsSync, lstatSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPONENT_ID_RE, COMPONENT_KINDS } from '@retake/core/model';
import type { ComponentKind } from '@retake/core/model';
import type { LoadedTemplate } from '@retake/core/theme';
import type { ValidationIssue } from '@retake/core/base';
import { componentOverride, isOwnComponent } from '@retake/components/geometry';
import type { ComponentInfo, ComponentManifest, ComponentRegistry, ComponentSource } from '@retake/components/geometry';
import { projectLibraryDir } from '@retake/core/project';
import type { LoadedProject } from '@retake/core/project';
import { insideFolder } from '@retake/core/scenario';
import { nodeFileFacts } from '@retake/core/io';
import { realPathOf } from '@retake/core/policy';
import type { PreviewComponentTarget, PreviewReadmeWriter } from '@retake/editor/plan';
import { EngineError, toEngineError } from './errors.js';
import { previewThemeOf } from './render/editor-calls.js';
import { componentCalls } from './registries/component-calls.js';
import { registryLoader } from './registries/registries.js';
import type { ComponentCatalogue } from './registries/registries.js';
import { openProjectBySlug } from './projects.js';
import { checkProjectSlug } from './refs.js';
import { fileWriter } from './store/project-store.js';
import type { ProjectStore, StoreScope } from './store/store.js';
import type { OpenedWorkspace } from './workspace.js';

/** Longest README text component_get returns. */
const README_MAX = 8000;

export function checkComponentId(id: string): string {
  if (typeof id !== 'string' || !COMPONENT_ID_RE.test(id) || id.length > 120) {
    throw new EngineError('invalid', `invalid component id "${String(id)}": "namespace/name" with lower-case letters, digits and "-" (component_list names them), never a path`);
  }
  return id;
}

export function checkComponentKind(kind: string): ComponentKind {
  if (!(COMPONENT_KINDS as readonly string[]).includes(kind)) throw new EngineError('invalid', `unknown component kind "${String(kind)}" (kinds: ${COMPONENT_KINDS.join(', ')})`);
  return kind as ComponentKind;
}

/** The registry of a workspace (its components/ folder, then the built-in library), loaded by its ComponentRegistries port. */
export async function workspaceRegistry(ws: Pick<OpenedWorkspace, 'root' | 'registries'>): Promise<ComponentRegistry> {
  return projectRegistry(ws);
}

/**
 * The registry a project renders with: its own components (`<project>/components/`) first, then the workspace's, then
 * the built-in library — the workspace's alone when no project is given.
 */
export async function projectRegistry(ws: Pick<OpenedWorkspace, 'root' | 'registries'>, project?: Pick<LoadedProject, 'dir'>): Promise<ComponentRegistry> {
  return registryLoader(ws.registries)(ws.root, project ? { projectDir: project.dir } : undefined);
}

/** The project a component call names (by slug), or undefined. */
async function namedProject(ws: OpenedWorkspace, slug: string | undefined): Promise<LoadedProject | undefined> {
  return slug === undefined ? undefined : openProjectBySlug(ws, checkProjectSlug(slug));
}

/** The catalogue's disk work of a workspace (its ComponentRegistries port): validate, scaffold, preview status, source files. */
function catalogueOf(ws: Pick<OpenedWorkspace, 'registries'>): ComponentCatalogue {
  registryLoader(ws.registries);
  return ws.registries.catalogue;
}

export interface ComponentSummary {
  id: string;
  kind: ComponentKind;
  /** Other kinds it can be used as. */
  kinds?: ComponentKind[];
  version: string;
  name: string;
  description: string;
  source: ComponentSource;
  /** A project's component that hides a workspace or a built-in one of its id (the registry's notice says it too). */
  overrides?: 'workspace' | 'builtin';
  dir: string;
  slots: string[];
  /** Its committed preview.png (960×540), and whether it matches the sources (fresh) or not (stale, missing). */
  preview?: string;
  preview_status: 'fresh' | 'stale' | 'missing';
  tags?: string[];
}

export interface ComponentListView {
  components_dir: string;
  /** The project's own components folder, when the list is a project's. */
  project_components_dir?: string;
  builtin_dir?: string;
  components: ComponentSummary[];
  /** Overrides of built-ins, invalid and misplaced components the registry found. */
  /** `project: true` marks a notice about a project's own component (absent otherwise). */
  notices: Array<{ severity: 'warning' | 'error'; message: string; id?: string; dir: string; issues: number; project?: true }>;
}

/**
 * What a project's component hides, from the registry's override notices ("project component X overrides the
 * workspace one / the built-in one"): the first place further down the order holding its id.
 */
export function overriddenBy(reg: ComponentRegistry, c: Pick<ComponentInfo, 'source' | 'manifest'>): 'workspace' | 'builtin' | undefined {
  // Only a project's component says it here: a workspace override of a built-in keeps its `overrides_builtin`.
  return c.source === 'project' ? componentOverride(reg.notices, { source: c.source, id: c.manifest.id }) : undefined;
}

async function summary(catalogue: ComponentCatalogue, c: ComponentInfo, reg: ComponentRegistry): Promise<ComponentSummary> {
  const lib = await componentCalls();
  const m = c.manifest;
  const preview = join(c.dir, lib.PREVIEW_FILE);
  const overrides = overriddenBy(reg, c);
  return {
    id: m.id,
    kind: m.kind,
    ...(m.kinds?.length ? { kinds: m.kinds } : {}),
    version: m.version,
    name: m.name,
    description: m.description,
    source: c.source,
    ...(overrides ? { overrides } : {}),
    dir: c.dir,
    slots: Object.keys(m.slots),
    ...(existsSync(preview) ? { preview } : {}),
    preview_status: (await catalogue.previewStatus(c.dir)).state,
    ...(m.tags?.length ? { tags: m.tags } : {}),
  };
}

/** A validation issue of a component, its file relative to the component's folder. */
export type ComponentFileIssue = ValidationIssue & { file: string };

/** A notice of the registry, whole: an override of a built-in, an invalid or a misplaced component. */
export interface RegistryNoticeView {
  severity: 'warning' | 'error';
  message: string;
  source: ComponentSource;
  /** The component's folder (or the misplaced file's). */
  dir: string;
  /** "<namespace>/<name>" of the folder, when the notice is about a component folder. */
  id?: string;
  issues?: ComponentFileIssue[];
}

/** One usable component as a shell lists it: its manifest as loaded, its entry, its param defaults, its committed preview. */
export interface ComponentEntry {
  id: string;
  kind: ComponentKind;
  version: string;
  name: string;
  description: string;
  source: ComponentSource;
  dir: string;
  entry: string;
  slots: string[];
  manifest: ComponentManifest;
  param_defaults: Record<string, unknown>;
  /** Its committed preview.png, when there is one. */
  preview?: string;
}

/** The registry as a shell lists it (componentList's `entries` form). */
export interface ComponentCatalogView {
  components_dir: string;
  /** The project's own components folder, when the list is a project's. */
  project_components_dir?: string;
  builtin_dir?: string;
  components: ComponentEntry[];
  notices: RegistryNoticeView[];
}

function noticeView(n: ComponentRegistry['notices'][number]): RegistryNoticeView {
  return { severity: n.severity, message: n.message, source: n.source, dir: n.dir, ...(n.id !== undefined ? { id: n.id } : {}), ...(n.issues ? { issues: n.issues } : {}) };
}

/** Every usable component (of `kind`) — a project's own first when one is named — with the registry's notices. */
export async function componentList(ws: OpenedWorkspace, kind?: string, projectSlug?: string): Promise<ComponentListView> {
  const k = kind === undefined ? undefined : checkComponentKind(kind);
  const project = await namedProject(ws, projectSlug);
  const reg = await projectRegistry(ws, project);
  const list = reg.list(k);
  return {
    components_dir: reg.componentsDir,
    ...(project ? { project_components_dir: projectLibraryDir(project.dir, 'components') } : {}),
    ...(reg.builtinDir ? { builtin_dir: reg.builtinDir } : {}),
    components: await Promise.all(list.map((c) => summary(catalogueOf(ws), c, reg))),
    notices: reg.notices.map((n) => ({
      severity: n.severity,
      message: n.message,
      ...(n.id ? { id: n.id } : {}),
      dir: n.dir,
      issues: n.issues?.length ?? 0,
      ...(n.source === 'project' ? { project: true as const } : {}),
    })),
  };
}

/**
 * The shell form of componentList (a person's list): each usable component with its entry, manifest, param defaults
 * and committed preview — no preview status (nothing hashed) — and the registry's notices whole.
 */
export async function componentListEntries(ws: OpenedWorkspace, kind?: ComponentKind, projectSlug?: string): Promise<ComponentCatalogView> {
  const k = kind === undefined ? undefined : checkComponentKind(kind);
  const project = await namedProject(ws, projectSlug);
  const reg = await projectRegistry(ws, project);
  const list = reg.list(k);
  const lib = await componentCalls();
  return {
    components_dir: reg.componentsDir,
    ...(project ? { project_components_dir: projectLibraryDir(project.dir, 'components') } : {}),
    ...(reg.builtinDir ? { builtin_dir: reg.builtinDir } : {}),
    components: list.map((c) => {
      const m = c.manifest;
      const preview = join(c.dir, lib.PREVIEW_FILE);
      return {
        id: m.id,
        kind: m.kind,
        version: m.version,
        name: m.name,
        description: m.description,
        source: c.source,
        dir: c.dir,
        entry: c.entry,
        slots: Object.keys(m.slots),
        manifest: m,
        param_defaults: lib.paramDefaults(m.params as Parameters<typeof lib.paramDefaults>[0]),
        ...(existsSync(preview) ? { preview } : {}),
      };
    }),
    notices: reg.notices.map(noticeView),
  };
}

export interface ComponentView extends ComponentSummary {
  entry: string;
  /** The manifest as loaded: slots (type, required, default_from, max_chars), params (JSON Schema), duration, geometry, preview samples. */
  manifest: ComponentManifest;
  /** Param values with every default applied. */
  param_defaults: Record<string, unknown>;
  /** Its source files (relative to dir), as the preview hash counts them. */
  files: string[];
  /** README.md (truncated). */
  readme?: string;
  /** A workspace component that replaces a built-in of the same id. */
  overrides_builtin?: true;
}

/** One component — a project's own first when one is named: its manifest, files and README. */
export async function componentGet(ws: OpenedWorkspace, id: string, projectSlug?: string): Promise<ComponentView> {
  checkComponentId(id);
  const lib = await componentCalls();
  const reg = await projectRegistry(ws, await namedProject(ws, projectSlug));
  let info: ComponentInfo;
  try {
    info = reg.get(id);
  } catch (e) {
    throw toEngineError(e);
  }
  const m = info.manifest;
  let readme: string | undefined;
  try {
    const text = await readFile(join(info.dir, 'README.md'), 'utf8');
    readme = text.length > README_MAX ? `${text.slice(0, README_MAX)}… (${text.length - README_MAX} more characters)` : text;
  } catch {
    readme = undefined;
  }
  return {
    ...(await summary(catalogueOf(ws), info, reg)),
    entry: info.entry,
    manifest: m,
    param_defaults: lib.paramDefaults(m.params as Parameters<typeof lib.paramDefaults>[0]),
    files: await catalogueOf(ws).sourceFiles(info.dir, m),
    ...(readme !== undefined ? { readme } : {}),
    ...(info.source === 'workspace' && reg.notices.some((n) => n.id === id && n.severity === 'warning' && /overrides/.test(n.message)) ? { overrides_builtin: true as const } : {}),
  };
}

export interface ComponentValidationView {
  id: string;
  dir: string;
  ok: boolean;
  /** Positioned issues (file relative to dir, line / col). */
  issues: ValidationIssue[];
  errors: number;
  warnings: number;
}

/**
 * A component a person names: an id of the registry (valid, or one it found invalid), else a folder — `dir`, the
 * argument as the shell resolved it against its own folder.
 */
export interface ComponentRef {
  ref: string;
  dir: string;
}

/** Every component a shell validated (componentValidate's shell forms): the id is its manifest's when it has one. */
export interface ComponentValidationsView {
  components_dir: string;
  components: Array<{ id: string; dir: string; ok: boolean; issues: ComponentFileIssue[] }>;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The folder of a component a person names (ComponentRef), or the registry's own not-found refusal. */
function folderOf(reg: ComponentRegistry, r: ComponentRef): { id: string; dir: string } {
  if (COMPONENT_ID_RE.test(r.ref)) {
    if (reg.has(r.ref)) return { id: r.ref, dir: reg.get(r.ref).dir };
    const broken = reg.notices.find((n) => n.id === r.ref && n.severity === 'error');
    if (broken) return { id: r.ref, dir: broken.dir };
  }
  if (isDir(r.dir)) return { id: r.ref, dir: r.dir };
  // Neither: the registry explains (not found, did you mean…).
  reg.get(r.ref);
  throw new EngineError('not_found', `component "${r.ref}" not found`);
}

/**
 * The person's own components a shell validates when it names none (the workspace's; a project's too when its registry
 * is a project's): the valid and the broken ones, by id.
 */
function workspaceFolders(reg: ComponentRegistry): Array<{ id: string; dir: string }> {
  const valid = reg
    .list()
    .filter((i) => isOwnComponent(i.source))
    .map((i) => ({ id: i.manifest.id, dir: i.dir }));
  const broken = reg.notices.filter((n) => n.severity === 'error' && isOwnComponent(n.source) && n.id !== undefined).map((n) => ({ id: n.id!, dir: n.dir }));
  return [...valid, ...broken].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The shell form of componentValidate: one component a person names (ComponentRef: an id, else a folder), or every
 * workspace component (`workspace`); the registry's own refusals.
 */
export async function componentValidateShell(ws: OpenedWorkspace, target: ComponentRef | { workspace: true }, projectSlug?: string): Promise<ComponentValidationsView> {
  const reg = await projectRegistry(ws, await namedProject(ws, projectSlug));
  const folders = 'workspace' in target ? workspaceFolders(reg) : [folderOf(reg, target)];
  const out: ComponentValidationsView['components'] = [];
  for (const t of folders) {
    const v = await catalogueOf(ws).validate(t.dir);
    out.push({ id: v.manifest?.id ?? t.id, dir: v.dir, ok: v.ok, issues: v.issues });
  }
  return { components_dir: reg.componentsDir, components: out };
}

/** Validate one component of the registry (a project's when one is named) — a valid one, or one the registry found invalid — by id. */
export async function componentValidate(ws: OpenedWorkspace, id: string, projectSlug?: string): Promise<ComponentValidationView> {
  checkComponentId(id);
  const reg = await projectRegistry(ws, await namedProject(ws, projectSlug));
  let dir: string;
  if (reg.has(id)) dir = reg.get(id).dir;
  else {
    const broken = reg.notices.find((n) => n.id === id && n.severity === 'error');
    if (!broken) {
      try {
        reg.get(id);
      } catch (e) {
        throw toEngineError(e);
      }
      throw new EngineError('not_found', `component "${id}" not found`);
    }
    dir = broken.dir;
  }
  const v = await catalogueOf(ws).validate(dir);
  return {
    id,
    dir: v.dir,
    ok: v.ok,
    issues: v.issues as ValidationIssue[],
    errors: v.issues.filter((i) => i.severity === 'error').length,
    warnings: v.issues.filter((i) => i.severity === 'warning').length,
  };
}

export interface ComponentCreateRequest {
  id: string;
  kind: string;
  description?: string;
  name?: string;
  /** A project's slug: the component is made in its own components folder (`<project>/components/`). */
  project?: string;
}

export interface ComponentCreated {
  id: string;
  kind: ComponentKind;
  dir: string;
  entry: string;
  /** Files written (component.yaml, index.tsx, README.md, …). */
  files: string[];
  issues: ValidationIssue[];
}

/** A component a shell scaffolded: its manifest too, and the built-in folder it overrides when it does. */
export interface ComponentCreatedByShell extends Omit<ComponentCreated, 'issues'> {
  /** Positioned issues (warnings only: an error aborts the scaffold), their file relative to dir. */
  issues: ComponentFileIssue[];
  manifest: ComponentManifest;
  /** The built-in folder it overrides. */
  overrides?: string;
  /** A project's component: the workspace component's folder it hides in the project's renders. */
  hides?: string;
}

/**
 * The shell form of componentCreate (a person's scaffold): a built-in id may be overridden (`overrides` names it), the
 * scaffold checks the id and kind itself, and its refusals are its own.
 */
export async function componentCreateShell(ws: OpenedWorkspace, req: ComponentCreateRequest & { kind: ComponentKind }, scope: StoreScope): Promise<ComponentCreatedByShell> {
  const target = await componentTarget(ws, req.project);
  // A project's component of a workspace component's id hides it in the project's renders: the shell warns (overrides).
  const hidden = target.project && COMPONENT_ID_RE.test(req.id) ? workspaceFolderOf(await workspaceRegistry(ws), req.id) : undefined;
  const created = await catalogueOf(ws).create(ws.root, {
    id: req.id,
    kind: req.kind,
    description: req.description,
    name: req.name,
    ...target.createOptions,
    write: componentWriter(target, scope),
  });
  return {
    id: created.manifest.id,
    kind: created.manifest.kind,
    dir: created.dir,
    entry: created.entry,
    files: created.files,
    issues: created.issues,
    manifest: created.manifest,
    ...(created.overrides ? { overrides: created.overrides } : {}),
    ...(hidden ? { hides: hidden } : {}),
  };
}

/**
 * Scaffold a workspace component (the tool's scaffold only: the description and name go into component.yaml through
 * the YAML library and into README.md as text, never into code). Refuses the built-in namespace and built-in ids.
 */
export async function componentCreate(ws: OpenedWorkspace, req: ComponentCreateRequest, scope: StoreScope): Promise<ComponentCreated> {
  checkComponentId(req.id);
  const kind = checkComponentKind(req.kind);
  const target = await componentTarget(ws, req.project);
  // Into a project, never an id of the workspace's: it would hide the workspace's component in every render of the
  // project (a person adopts the workspace's into the project: project_adopt copies it).
  if (target.project) {
    const hidden = workspaceFolderOf(await workspaceRegistry(ws), req.id);
    if (hidden) {
      throw new EngineError(
        'refused',
        `component id "${req.id}" is a workspace component's: a component of that id in project ${target.project.slug} would replace it in every render of the project — pick another id, or copy the workspace's into the project (project_adopt {components})`,
      );
    }
  }
  try {
    const created = await catalogueOf(ws).create(ws.root, {
      id: req.id,
      kind,
      ...(req.description !== undefined ? { description: req.description } : {}),
      ...(req.name !== undefined ? { name: req.name } : {}),
      noOverride: true,
      ...target.createOptions,
      write: componentWriter(target, scope),
    });
    return { id: created.manifest.id, kind, dir: created.dir, entry: created.entry, files: created.files, issues: created.issues as ValidationIssue[] };
  } catch (e) {
    const err = toEngineError(e);
    if (/namespace belongs to the built-in library|is a built-in component's/.test(err.message)) throw new EngineError('refused', err.message);
    throw err;
  }
}

/** The workspace component folder of `id` (valid or broken), when the workspace holds one. */
function workspaceFolderOf(reg: ComponentRegistry, id: string): string | undefined {
  if (reg.has(id)) {
    const info = reg.get(id);
    return info.source === 'workspace' ? info.dir : undefined;
  }
  return reg.notices.find((n) => n.id === id && n.severity === 'error' && n.source === 'workspace')?.dir;
}

/** Where a component writer writes: the workspace's components folder, or a project's own (`<project>/components`). */
export interface ComponentTarget {
  dir: string;
  project?: LoadedProject;
  /** The scaffold's options for this folder (its components folder, whose it is). */
  createOptions: { componentsDir: string; source: 'project' } | Record<string, never>;
  store(scope: StoreScope): ProjectStore;
}

/** Whether a path is a symbolic link (lstat; a missing path is not). */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The workspace's components folder as a writer's target (its store, labelled `<components_dir>`). */
export function workspaceComponentTarget(ws: Pick<OpenedWorkspace, 'componentsDir'>): ComponentTarget {
  return { dir: ws.componentsDir, createOptions: {}, store: (scope) => scope.stores.at(ws.componentsDir, scope, { label: '<components_dir>' }) };
}

/**
 * A project's own components folder as a writer's target, through the project's store (journaled with its slug):
 * refused when it is a link or leads out of the project, and when it is the workspace's components_dir (then its
 * components are the workspace's — name no project).
 */
export function projectComponentTarget(ws: Pick<OpenedWorkspace, 'componentsDir'>, project: LoadedProject, what = 'a new component'): ComponentTarget {
  const dir = projectLibraryDir(project.dir, 'components');
  if (isSymlink(dir)) {
    throw new EngineError('refused', `project ${project.slug}'s components/ is a symbolic link: ${what} is written only into the project's own folder — replace the link with a folder`);
  }
  const real = realPathOf(dir, nodeFileFacts);
  if (!insideFolder(realPathOf(project.dir, nodeFileFacts), real, nodeFileFacts)) {
    throw new EngineError('refused', `project ${project.slug}'s components/ leads out of the project folder: ${what} is written only into the project's own folder`);
  }
  if (real === realPathOf(ws.componentsDir, nodeFileFacts)) {
    throw new EngineError('refused', `project ${project.slug}'s components/ is the workspace's components_dir: its components are the workspace's — make ${what} without naming the project`);
  }
  return { dir, project, createOptions: { componentsDir: dir, source: 'project' }, store: (scope) => scope.stores.of(project, scope) };
}

/** The target of a component writer: the named project's components folder, else the workspace's. */
export async function componentTarget(ws: OpenedWorkspace, projectSlug: string | undefined, what?: string): Promise<ComponentTarget> {
  const project = await namedProject(ws, projectSlug);
  return project ? projectComponentTarget(ws, project, what) : workspaceComponentTarget(ws);
}

/**
 * The writer of a component scaffold (components createComponent `write`): each file created through the store of its
 * target — the workspace's components folder, or a project's (`if_match` null: never over a file), journaled as the
 * caller's.
 */
export function componentWriter(target: Pick<ComponentTarget, 'store'>, scope: StoreScope): (file: string, text: string) => Promise<void> {
  const store = target.store(scope);
  return async (file, text) => {
    await store.writeFileAt(file, text, { ifMatch: null, what: 'component' });
  };
}

/**
 * The READMEs of the person's own components (a preview's block): the workspace's through the store of its components
 * folder, a project's through the project's store (journaled as the caller's, on the version read — or created when
 * there was none); the built-in library's and the scaffolds' are written directly by the editor.
 */
export function componentReadmeWriter(ws: Pick<OpenedWorkspace, 'componentsDir'>, scope: StoreScope): PreviewReadmeWriter {
  return readmeWriterOf(workspaceComponentTarget(ws), scope);
}

/** The README writer of a component target's folder (componentReadmeWriter's, or a project's own). */
function readmeWriterOf(target: Pick<ComponentTarget, 'dir' | 'store'>, scope: StoreScope): PreviewReadmeWriter {
  return { root: target.dir, write: fileWriter(target.store(scope), 'component') };
}

/**
 * The README writers of a shell's previews: the workspace's components folder, and the named project's own first
 * (each README through the store of the folder it lies in).
 */
export async function componentReadmeWriters(ws: OpenedWorkspace, projectSlug: string | undefined, scope: StoreScope): Promise<PreviewReadmeWriter[]> {
  const workspace = componentReadmeWriter(ws, scope);
  const project = await namedProject(ws, projectSlug);
  return project ? [readmeWriterOf({ dir: projectLibraryDir(project.dir, 'components'), store: (sc) => sc.stores.of(project, sc) }, scope), workspace] : [workspace];
}

/** What a shell renders previews of: one component it names, or every one (`all`). */
export type PreviewSelection = { ref: ComponentRef } | { all: true; workspaceOnly: boolean };

/** The components to render, with the registry and the theme they are judged against — or the one named, invalid. */
export type PreviewTargetsView = { theme: string; registry: ComponentRegistry; targets: PreviewComponentTarget[] } | { invalid: { id: string; dir: string; issues: ComponentFileIssue[] } };

/** A component folder validated, as a preview target when it has a manifest (`ok`: whether it validates). */
async function targetOfDir(catalogue: ComponentCatalogue, dir: string): Promise<{ target?: PreviewComponentTarget; ok: boolean; issues: ComponentFileIssue[]; dir: string }> {
  const v = await catalogue.validate(dir);
  const target = v.manifest ? { id: v.manifest.id, dir: v.dir, entry: join(v.dir, v.manifest.entry ?? 'index.tsx'), manifest: v.manifest } : undefined;
  return { ...(target ? { target } : {}), ok: v.ok, issues: v.issues, dir: v.dir };
}

/**
 * The components a shell's `components preview` renders: one it names (an id or folder — ComponentRef — or a kind's
 * scaffold, "scaffolds/<kind>"; one that does not validate comes back `invalid`, with its issues), or every one:
 * the registry's (only the workspace's with `workspaceOnly`) and, else, the per-kind scaffolds. With `stale`, only
 * those whose preview is missing or out of date for the theme (`theme`, default the previews' own).
 */
export async function componentPreviewTargets(ws: OpenedWorkspace, sel: PreviewSelection, opts: { theme?: string; stale?: boolean; project?: string } = {}): Promise<PreviewTargetsView> {
  const lib = await componentCalls();
  const reg = await projectRegistry(ws, await namedProject(ws, opts.project));
  let targets: PreviewComponentTarget[];
  if ('ref' in sel) {
    const scaffold = /^scaffolds\/([a-z]+)$/.exec(sel.ref.ref);
    const t = scaffold && (COMPONENT_KINDS as readonly string[]).includes(scaffold[1]) ? { id: sel.ref.ref, dir: lib.scaffoldDir(scaffold[1] as ComponentKind) } : folderOf(reg, sel.ref);
    const v = await targetOfDir(catalogueOf(ws), t.dir);
    if (!v.ok || !v.target) return { invalid: { id: t.id, dir: v.dir, issues: v.issues } };
    targets = [v.target];
  } else {
    targets = reg
      .list()
      .filter((i) => !sel.workspaceOnly || isOwnComponent(i.source))
      .map((i) => ({ id: i.manifest.id, dir: i.dir, entry: i.entry, manifest: i.manifest }));
    if (!sel.workspaceOnly) {
      for (const kind of COMPONENT_KINDS) {
        // A scaffold is rendered when it has a manifest (its own validation is the scaffolds' test).
        const v = await targetOfDir(catalogueOf(ws), lib.scaffoldDir(kind));
        if (v.target) targets.push(v.target);
      }
    }
  }
  const theme = opts.theme ?? lib.PREVIEW_THEME;
  if (opts.stale) {
    const catalogue = catalogueOf(ws);
    const states = await Promise.all(targets.map(async (t) => (await catalogue.previewStatus(t.dir, { theme })).state));
    targets = targets.filter((_, i) => states[i] !== 'fresh');
  }
  return { theme, registry: reg, targets };
}

/**
 * The theme a shell's previews are rendered with (a name or a folder; default the previews' own) — a project's own
 * theme of that name first when one is named — read with the workspace's file facts.
 */
export async function componentPreviewTheme(ws: OpenedWorkspace, name?: string, projectSlug?: string): Promise<{ theme: string; template: LoadedTemplate }> {
  const theme = name ?? (await componentCalls()).PREVIEW_THEME;
  const project = await namedProject(ws, projectSlug);
  return { theme, template: await previewThemeOf(theme, ws.root, ws.reads.fileFacts(ws.policy), project?.dir) };
}
