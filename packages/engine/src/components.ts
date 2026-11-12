/**
 * Components as clients outside the CLI see them (L3.2, R-MCP-13/14/16): the registry of the workspace (its
 * components/ folder, then the built-in library) listed and read, a component validated (manifest, entry, esbuild
 * compile — nothing is executed), and a workspace component scaffolded from its kind's template.
 *
 * Inputs are ids ("namespace/name"), never folders. Nothing here writes component code: `componentCreate` writes the
 * tool's own scaffold, refuses the built-in namespace and any built-in id (a workspace component of that id would
 * replace the built-in in every render), and renders no preview (component_preview does, into .retake/previews/).
 * The components package (esbuild) is imported lazily.
 *
 * The shell forms (L7.24, the CLI's `retake components`): a person at a terminal names a component by id or by folder,
 * may scaffold over a built-in id (the CLI warns), renders previews into the component's own folder (preview.png +
 * preview.json + its README's block) — `componentListEntries`, `componentValidateShell`, `componentCreateShell`,
 * `componentPreviewTargets`, `componentPreviewTheme`, `componentReadmeWriter`: names of their own, so that no MCP or
 * Studio input reaches them by a type mistake.
 * Their refusals are the adapters' own errors, unchanged (the words the person reads); the forms above them are
 * untouched (the MCP and Studio data).
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPONENT_ID_RE, COMPONENT_KINDS } from '@retake/core';
import type { ComponentKind, LoadedTemplate, ValidationIssue } from '@retake/core';
import { fileFacts } from '@retake/core/io';
import type { ComponentInfo, ComponentManifest, ComponentRegistry, ComponentSource } from '@retake/components';
import type { PreviewComponentTarget, PreviewReadmeWriter } from '@retake/editor';
import { EngineError, toEngineError } from './errors.js';
import { editor } from './lazy.js';
import { fileWriter } from './store/project-store.js';
import type { StoreScope } from './store/store.js';
import type { OpenedWorkspace } from './workspace.js';

/** Lazy: @retake/components pulls in esbuild (compile checks). */
export const components = () => import('@retake/components');

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

/** The registry of a workspace (its components/ folder, then the built-in library). */
export async function workspaceRegistry(ws: OpenedWorkspace): Promise<ComponentRegistry> {
  const c = await components();
  return c.loadComponentRegistry({ root: ws.root });
}

export interface ComponentSummary {
  id: string;
  kind: ComponentKind;
  /** Other kinds it can be used as. */
  kinds?: ComponentKind[];
  version: string;
  name: string;
  description: string;
  source: 'workspace' | 'builtin';
  dir: string;
  slots: string[];
  /** Its committed preview.png (960×540), and whether it matches the sources (fresh) or not (stale, missing). */
  preview?: string;
  preview_status: 'fresh' | 'stale' | 'missing';
  tags?: string[];
}

export interface ComponentListView {
  components_dir: string;
  builtin_dir?: string;
  components: ComponentSummary[];
  /** Overrides of built-ins, invalid and misplaced components the registry found. */
  notices: Array<{ severity: 'warning' | 'error'; message: string; id?: string; dir: string; issues: number }>;
}

async function summary(c: ComponentInfo): Promise<ComponentSummary> {
  const lib = await components();
  const m = c.manifest;
  const preview = join(c.dir, lib.PREVIEW_FILE);
  return {
    id: m.id,
    kind: m.kind,
    ...(m.kinds?.length ? { kinds: m.kinds } : {}),
    version: m.version,
    name: m.name,
    description: m.description,
    source: c.source === 'workspace' ? 'workspace' : 'builtin',
    dir: c.dir,
    slots: Object.keys(m.slots),
    ...(existsSync(preview) ? { preview } : {}),
    preview_status: lib.previewStatus(c.dir).state,
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
  builtin_dir?: string;
  components: ComponentEntry[];
  notices: RegistryNoticeView[];
}

function noticeView(n: ComponentRegistry['notices'][number]): RegistryNoticeView {
  return { severity: n.severity, message: n.message, source: n.source, dir: n.dir, ...(n.id !== undefined ? { id: n.id } : {}), ...(n.issues ? { issues: n.issues } : {}) };
}

/** Every usable component (of `kind`), workspace first then built-in, with the registry's notices. */
export async function componentList(ws: OpenedWorkspace, kind?: string): Promise<ComponentListView> {
  const k = kind === undefined ? undefined : checkComponentKind(kind);
  const reg = await workspaceRegistry(ws);
  const list = reg.list(k);
  return {
    components_dir: reg.componentsDir,
    ...(reg.builtinDir ? { builtin_dir: reg.builtinDir } : {}),
    components: await Promise.all(list.map(summary)),
    notices: reg.notices.map((n) => ({ severity: n.severity, message: n.message, ...(n.id ? { id: n.id } : {}), dir: n.dir, issues: n.issues?.length ?? 0 })),
  };
}

/**
 * The shell form of componentList (a person's list): each usable component with its entry, manifest, param defaults
 * and committed preview — no preview status (nothing hashed) — and the registry's notices whole.
 */
export async function componentListEntries(ws: OpenedWorkspace, kind?: ComponentKind): Promise<ComponentCatalogView> {
  const k = kind === undefined ? undefined : checkComponentKind(kind);
  const reg = await workspaceRegistry(ws);
  const list = reg.list(k);
  const lib = await components();
  return {
    components_dir: reg.componentsDir,
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

/** One component: its manifest, files and README. */
export async function componentGet(ws: OpenedWorkspace, id: string): Promise<ComponentView> {
  checkComponentId(id);
  const lib = await components();
  const reg = await workspaceRegistry(ws);
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
    ...(await summary(info)),
    entry: info.entry,
    manifest: m,
    param_defaults: lib.paramDefaults(m.params as Parameters<typeof lib.paramDefaults>[0]),
    files: lib.componentSourceFiles(info.dir, m),
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

/** The workspace's components a shell validates when it names none: the valid and the broken ones, by id. */
function workspaceFolders(reg: ComponentRegistry): Array<{ id: string; dir: string }> {
  const valid = reg.list().filter((i) => i.source === 'workspace').map((i) => ({ id: i.manifest.id, dir: i.dir }));
  const broken = reg.notices.filter((n) => n.severity === 'error' && n.source === 'workspace' && n.id !== undefined).map((n) => ({ id: n.id!, dir: n.dir }));
  return [...valid, ...broken].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The shell form of componentValidate: one component a person names (ComponentRef: an id, else a folder), or every
 * workspace component (`workspace`); the registry's own refusals.
 */
export async function componentValidateShell(ws: OpenedWorkspace, target: ComponentRef | { workspace: true }): Promise<ComponentValidationsView> {
  const lib = await components();
  const reg = await workspaceRegistry(ws);
  const folders = 'workspace' in target ? workspaceFolders(reg) : [folderOf(reg, target)];
  const out: ComponentValidationsView['components'] = [];
  for (const t of folders) {
    const v = await lib.validateComponentDir(t.dir);
    out.push({ id: v.manifest?.id ?? t.id, dir: v.dir, ok: v.ok, issues: v.issues });
  }
  return { components_dir: reg.componentsDir, components: out };
}

/** Validate one component of the registry — a valid one, or one the registry found invalid — by id. */
export async function componentValidate(ws: OpenedWorkspace, id: string): Promise<ComponentValidationView> {
  checkComponentId(id);
  const lib = await components();
  const reg = await workspaceRegistry(ws);
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
  const v = await lib.validateComponentDir(dir);
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
  overrides?: string;
}

/**
 * The shell form of componentCreate (a person's scaffold): a built-in id may be overridden (`overrides` names it), the
 * scaffold checks the id and kind itself, and its refusals are its own.
 */
export async function componentCreateShell(ws: OpenedWorkspace, req: ComponentCreateRequest & { kind: ComponentKind }, scope: StoreScope): Promise<ComponentCreatedByShell> {
  const lib = await components();
  const created = await lib.createComponent(ws.root, {
    id: req.id,
    kind: req.kind,
    description: req.description,
    name: req.name,
    write: componentWriter(ws, scope),
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
  };
}

/**
 * Scaffold a workspace component (the tool's scaffold only: the description and name go into component.yaml through
 * the YAML library and into README.md as text, never into code). Refuses the built-in namespace and built-in ids.
 */
export async function componentCreate(ws: OpenedWorkspace, req: ComponentCreateRequest, scope: StoreScope): Promise<ComponentCreated> {
  checkComponentId(req.id);
  const kind = checkComponentKind(req.kind);
  const lib = await components();
  try {
    const created = await lib.createComponent(ws.root, {
      id: req.id,
      kind,
      ...(req.description !== undefined ? { description: req.description } : {}),
      ...(req.name !== undefined ? { name: req.name } : {}),
      noOverride: true,
      write: componentWriter(ws, scope),
    });
    return { id: created.manifest.id, kind, dir: created.dir, entry: created.entry, files: created.files, issues: created.issues as ValidationIssue[] };
  } catch (e) {
    const err = toEngineError(e);
    if (/namespace belongs to the built-in library|is a built-in component's/.test(err.message)) throw new EngineError('refused', err.message);
    throw err;
  }
}

/**
 * The writer of a component scaffold (components createComponent `write`): each file created through the project store
 * rooted at the workspace's components folder (`if_match` null: never over a file), journaled as the caller's.
 */
export function componentWriter(ws: Pick<OpenedWorkspace, 'componentsDir'>, scope: StoreScope): (file: string, text: string) => Promise<void> {
  const store = scope.stores.at(ws.componentsDir, scope, { label: '<components_dir>' });
  return async (file, text) => {
    await store.writeFileAt(file, text, { ifMatch: null, what: 'component' });
  };
}

/**
 * The READMEs of the workspace's components (a preview's block), written through the project store of its components
 * folder (journaled as the caller's, on the version read — or created when there was none); the built-in library's and
 * the scaffolds' are written directly by the editor.
 */
export function componentReadmeWriter(ws: Pick<OpenedWorkspace, 'componentsDir'>, scope: StoreScope): PreviewReadmeWriter {
  return { root: ws.componentsDir, write: fileWriter(scope.stores.at(ws.componentsDir, scope, { label: '<components_dir>' }), 'component') };
}

/** What a shell renders previews of: one component it names, or every one (`all`). */
export type PreviewSelection = { ref: ComponentRef } | { all: true; workspaceOnly: boolean };

/** The components to render, with the registry and the theme they are judged against — or the one named, invalid. */
export type PreviewTargetsView =
  | { theme: string; registry: ComponentRegistry; targets: PreviewComponentTarget[] }
  | { invalid: { id: string; dir: string; issues: ComponentFileIssue[] } };

/** A component folder validated, as a preview target when it has a manifest (`ok`: whether it validates). */
async function targetOfDir(lib: Awaited<ReturnType<typeof components>>, dir: string): Promise<{ target?: PreviewComponentTarget; ok: boolean; issues: ComponentFileIssue[]; dir: string }> {
  const v = await lib.validateComponentDir(dir);
  const target = v.manifest ? { id: v.manifest.id, dir: v.dir, entry: join(v.dir, v.manifest.entry ?? 'index.tsx'), manifest: v.manifest } : undefined;
  return { ...(target ? { target } : {}), ok: v.ok, issues: v.issues, dir: v.dir };
}

/**
 * The components a shell's `components preview` renders: one it names (an id or folder — ComponentRef — or a kind's
 * scaffold, "scaffolds/<kind>"; one that does not validate comes back `invalid`, with its issues), or every one:
 * the registry's (only the workspace's with `workspaceOnly`) and, else, the per-kind scaffolds. With `stale`, only
 * those whose preview is missing or out of date for the theme (`theme`, default the previews' own).
 */
export async function componentPreviewTargets(ws: OpenedWorkspace, sel: PreviewSelection, opts: { theme?: string; stale?: boolean } = {}): Promise<PreviewTargetsView> {
  const lib = await components();
  const reg = await workspaceRegistry(ws);
  let targets: PreviewComponentTarget[];
  if ('ref' in sel) {
    const scaffold = /^scaffolds\/([a-z]+)$/.exec(sel.ref.ref);
    const t = scaffold && (COMPONENT_KINDS as readonly string[]).includes(scaffold[1]) ? { id: sel.ref.ref, dir: lib.scaffoldDir(scaffold[1] as ComponentKind) } : folderOf(reg, sel.ref);
    const v = await targetOfDir(lib, t.dir);
    if (!v.ok || !v.target) return { invalid: { id: t.id, dir: v.dir, issues: v.issues } };
    targets = [v.target];
  } else {
    targets = reg
      .list()
      .filter((i) => !sel.workspaceOnly || i.source === 'workspace')
      .map((i) => ({ id: i.manifest.id, dir: i.dir, entry: i.entry, manifest: i.manifest }));
    if (!sel.workspaceOnly) {
      for (const kind of COMPONENT_KINDS) {
        // A scaffold is rendered when it has a manifest (as before L7.24: its own validation is the scaffolds' test).
        const v = await targetOfDir(lib, lib.scaffoldDir(kind));
        if (v.target) targets.push(v.target);
      }
    }
  }
  const theme = opts.theme ?? lib.PREVIEW_THEME;
  if (opts.stale) targets = targets.filter((t) => lib.previewStatus(t.dir, { theme }).state !== 'fresh');
  return { theme, registry: reg, targets };
}

/** The theme a shell's previews are rendered with (a name or a folder; default the previews' own), read with the workspace's file facts. */
export async function componentPreviewTheme(ws: OpenedWorkspace, name?: string): Promise<{ theme: string; template: LoadedTemplate }> {
  const theme = name ?? (await components()).PREVIEW_THEME;
  return { theme, template: await (await editor()).loadPreviewTheme(theme, ws.root, fileFacts(ws.policy)) };
}
