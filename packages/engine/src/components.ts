/**
 * Components as clients outside the CLI see them (L3.2, R-MCP-13/14/16): the registry of the workspace (its
 * components/ folder, then the built-in library) listed and read, a component validated (manifest, entry, esbuild
 * compile — nothing is executed), and a workspace component scaffolded from its kind's template.
 *
 * Inputs are ids ("namespace/name"), never folders. Nothing here writes component code: `componentCreate` writes the
 * tool's own scaffold, refuses the built-in namespace and any built-in id (a workspace component of that id would
 * replace the built-in in every render), and renders no preview (component_preview does, into .retake/previews/).
 * The components package (esbuild) is imported lazily.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPONENT_ID_RE, COMPONENT_KINDS } from '@retake/core';
import type { ComponentKind, ValidationIssue, WorkspaceConfig } from '@retake/core';
import type { ComponentInfo, ComponentManifest, ComponentRegistry } from '@retake/components';
import { EngineError, toEngineError } from './errors.js';
import { ProjectStore } from './store/project-store.js';
import type { StoreScope } from './store/project-store.js';

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
export async function workspaceRegistry(ws: WorkspaceConfig): Promise<ComponentRegistry> {
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

/** Every usable component (of `kind`), workspace first then built-in, with the registry's notices. */
export async function componentList(ws: WorkspaceConfig, kind?: string): Promise<ComponentListView> {
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
export async function componentGet(ws: WorkspaceConfig, id: string): Promise<ComponentView> {
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

/** Validate one component of the registry — a valid one, or one the registry found invalid — by id. */
export async function componentValidate(ws: WorkspaceConfig, id: string): Promise<ComponentValidationView> {
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

/**
 * Scaffold a workspace component (the tool's scaffold only: the description and name go into component.yaml through
 * the YAML library and into README.md as text, never into code). Refuses the built-in namespace and built-in ids.
 */
export async function componentCreate(ws: WorkspaceConfig, req: ComponentCreateRequest, scope: StoreScope): Promise<ComponentCreated> {
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
export function componentWriter(ws: Pick<WorkspaceConfig, 'componentsDir'>, scope: StoreScope): (file: string, text: string) => Promise<void> {
  const store = new ProjectStore(ws.componentsDir, scope, undefined, '<components_dir>');
  return async (file, text) => {
    await store.writeFileAt(file, text, { ifMatch: null, what: 'component' });
  };
}
