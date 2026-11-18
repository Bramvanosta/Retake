/**
 * Component registry: every component a workspace can use, by id.
 *
 * Resolution order (SPEC §11): a project's own `components/` folder (`projects/<slug>/components/`, when the registry
 * is loaded for a project) → the workspace `components/` folder (retake.yaml `components_dir`) → the built-in library
 * (packages/components/library) → (V2) the marketplace cache. A component with the id of one further down the order
 * overrides it (with a warning notice): a project's over the workspace's or a built-in, a workspace's over a built-in.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage, errorsOf, formatPath, suggestion } from '@retake/core/base';
import { COMPONENT_ID_RE, COMPONENT_KINDS } from '@retake/core/model';
import { normalizeComponentRef, resolveThemeComponents } from '@retake/core/theme';
import { loadWorkspaceConfig } from '@retake/core/io';
import type { ComponentKind, ComponentRef } from '@retake/core/model';
import type { Template } from '@retake/core/theme';
import { ComponentError, formatComponentIssues } from './errors.js';
import { applyParamDefaults, validateParamValue } from './json-schema.js';
import type { JsonSchemaNode } from './json-schema.js';
import { MANIFEST_FILE, kitMajorOf, parseManifest } from './manifest.js';
import { KIT_API_VERSION, LIBRARY_DIR } from './paths.js';
import type { ComponentInfo, ComponentIssue, ComponentManifest, ComponentSource, ResolvedComponentRef } from './types.js';

/** Can a component be used as `kind`? Its own kind, or one of its `kinds`. */
export function usableAs(m: Pick<ComponentManifest, 'kind' | 'kinds'>, kind: ComponentKind): boolean {
  return m.kind === kind || (m.kinds ?? []).includes(kind);
}

export interface LoadComponentRegistryOptions {
  /** Workspace root (retake.yaml `components_dir`, default `<root>/components`). */
  root: string;
  /** Override the workspace components directory. */
  componentsDir?: string;
  /**
   * A project's own components folder (`<project>/components`), scanned first. Ignored when it is not there, or when it
   * is the workspace's components folder or the built-in library itself (then its components are those, never
   * shadowing themselves).
   */
  projectComponentsDir?: string;
  /** Override the built-in library directory; `null` = no built-ins. */
  builtinDir?: string | null;
}

/** Something the registry noticed while scanning (an override, an invalid or misplaced component). */
export interface RegistryNotice {
  severity: 'warning' | 'error';
  message: string;
  source: ComponentSource;
  /** Component directory (or the misplaced file's directory). */
  dir: string;
  /** "<namespace>/<name>" of the folder, when the notice is about a component folder. */
  id?: string;
  /** Validation issues of an invalid component (relative to `dir`). */
  issues?: ComponentIssue[];
}

export interface ComponentRegistry {
  /** Workspace components directory scanned. */
  readonly componentsDir: string;
  /** The project's own components directory scanned first (undefined: the registry of the workspace alone). */
  readonly projectComponentsDir?: string;
  /** Built-in library directory scanned (undefined when disabled). */
  readonly builtinDir?: string;
  /** Overrides, invalid and misplaced components found while scanning. */
  readonly notices: readonly RegistryNotice[];
  /** Usable components sorted by id, optionally of one kind. */
  list(kind?: ComponentKind): ComponentInfo[];
  has(id: string): boolean;
  /** The component with this id; throws ComponentError (not found with suggestions, or invalid with its issues). */
  get(id: string): ComponentInfo;
  /** Turn a ref (id or {id, params}) into a component of `kind` with its params defaults applied and validated. */
  resolve(ref: ComponentRef, kind: ComponentKind): ResolvedComponentRef;
  /**
   * The theme's component per kind (core `resolveThemeComponents`: components map → legacy fields → defaults),
   * resolved; `null` = none. Throws one ComponentError listing every kind that does not resolve.
   */
  resolveTheme(template: Template): Record<ComponentKind, ResolvedComponentRef | null>;
}

/**
 * Where a piece of work gets its registry: the registry itself, or what loads it for a workspace root — called at the
 * point the work reads it, so a broken components folder is said where it always was. Handed by the work's caller
 * (the engine's ComponentRegistries port); work that is handed neither refuses, it never loads one by itself.
 */
export type RegistrySource = ComponentRegistry | ((root: string, o?: RegistryScope) => Promise<ComponentRegistry>);

/** Whose registry a loader loads: the workspace's, or a project's (its own `components/` first). */
export interface RegistryScope {
  /** The project folder (`projects/<slug>`): its `components/<namespace>/<name>/` is found first. */
  projectDir?: string;
}

interface Found {
  info?: ComponentInfo;
  /** Set for an invalid component folder. */
  broken?: RegistryNotice;
}

const EMPTY_PARAMS: JsonSchemaNode = { type: 'object', properties: {} };

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw e;
  }
}

/** Load one component folder `<base>/<ns>/<name>` (manifest, id = folder path, entry present). */
export async function loadComponentDir(dir: string, source: ComponentSource, folderId: string): Promise<Found> {
  const file = join(dir, MANIFEST_FILE);
  const text = await readFile(file, 'utf8');
  const { manifest, issues } = parseManifest(text, MANIFEST_FILE, { folderId });
  const errors = errorsOf(issues) as ComponentIssue[];
  if (!manifest || errors.length > 0) {
    return {
      broken: {
        severity: 'error',
        message: `invalid component ${folderId}: ${errors.length} error${errors.length === 1 ? '' : 's'} in ${MANIFEST_FILE} (retake components validate ${folderId})`,
        source,
        dir,
        id: folderId,
        issues,
      },
    };
  }
  const entry = resolve(dir, manifest.entry ?? 'index.tsx');
  if (!existsSync(entry)) {
    const issue: ComponentIssue = { severity: 'error', path: ['entry'], message: `entry file "${manifest.entry}" not found`, file: MANIFEST_FILE };
    return {
      broken: { severity: 'error', message: `invalid component ${folderId}: entry file ${manifest.entry} not found`, source, dir, id: folderId, issues: [issue] },
    };
  }
  // The guard-rail: a component written for another kit API is not loaded — its uses fall back (a warning), or
  // render as `missing` when nothing else resolves.
  const kit = kitMajorOf(manifest);
  if (kit !== KIT_API_VERSION) {
    const issue: ComponentIssue = { severity: 'error', path: ['engines', 'kit'], message: `needs kit API ${kit}: this Retake provides kit API ${KIT_API_VERSION}`, file: MANIFEST_FILE };
    return {
      broken: {
        severity: 'error',
        message: `component ${folderId} needs kit API ${kit} (engines.kit "${manifest.engines?.kit}"): this Retake provides kit API ${KIT_API_VERSION} — use a version of the component written for it`,
        source,
        dir,
        id: folderId,
        issues: [issue],
      },
    };
  }
  return { info: { manifest, dir, entry, source } };
}

async function scan(base: string, source: ComponentSource, notices: RegistryNotice[]): Promise<Map<string, Found>> {
  const out = new Map<string, Found>();
  for (const ns of await subdirs(base)) {
    const nsDir = join(base, ns);
    if (existsSync(join(nsDir, MANIFEST_FILE))) {
      notices.push({
        severity: 'warning',
        message: `${MANIFEST_FILE} in ${ns}/ is ignored: a component lives in <namespace>/<name>/ (e.g. ${ns}/my-component/)`,
        source,
        dir: nsDir,
      });
    }
    for (const name of await subdirs(nsDir)) {
      const dir = join(nsDir, name);
      if (!existsSync(join(dir, MANIFEST_FILE))) continue;
      const folderId = `${ns}/${name}`;
      if (!COMPONENT_ID_RE.test(folderId)) {
        notices.push({
          severity: 'error',
          message: `component folder "${folderId}" is not a valid id: use lower-case letters, digits and "-" (e.g. acme/intro-split)`,
          source,
          dir,
          id: folderId,
        });
        continue;
      }
      const found = await loadComponentDir(dir, source, folderId);
      if (found.broken) notices.push(found.broken);
      out.set(folderId, found);
    }
  }
  return out;
}

class Registry implements ComponentRegistry {
  constructor(
    readonly componentsDir: string,
    readonly builtinDir: string | undefined,
    private readonly found: Map<string, Found>,
    readonly notices: RegistryNotice[],
    readonly projectComponentsDir?: string,
  ) {}

  list(kind?: ComponentKind): ComponentInfo[] {
    return [...this.found.values()]
      .map((f) => f.info)
      .filter((i): i is ComponentInfo => i !== undefined && (kind === undefined || usableAs(i.manifest, kind)))
      .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  has(id: string): boolean {
    return this.found.get(id)?.info !== undefined;
  }

  private where(): string {
    const places = [...(this.projectComponentsDir ? [this.projectComponentsDir] : []), this.componentsDir, ...(this.builtinDir ? ['the built-in library'] : [])];
    return places.length === 1 ? places[0] : `${places.slice(0, -1).join(', ')} or ${places[places.length - 1]}`;
  }

  private notFound(id: string, kind?: ComponentKind): ComponentError {
    const pool = kind ? this.list(kind) : this.list();
    const candidates = [...new Set([...pool.map((i) => i.manifest.id), ...this.found.keys()])];
    const available = kind ? `; ${kind} components: ${pool.map((i) => i.manifest.id).join(', ') || 'none'}` : '';
    const idHint = COMPONENT_ID_RE.test(id) ? '' : ' (ids are "namespace/name", e.g. studio/intro-stack)';
    return new ComponentError(`component "${id}" not found in ${this.where()}${suggestion(id, candidates)}${idHint}${available}`);
  }

  private lookup(id: string, kind?: ComponentKind): ComponentInfo {
    const found = this.found.get(id);
    if (!found) throw this.notFound(id, kind);
    if (found.broken) {
      const b = found.broken;
      const details = b.issues?.length ? `\n${formatComponentIssues(b.issues, b.dir)}` : '';
      throw new ComponentError(`${b.message}${details}`, b.issues ?? [], b.dir);
    }
    return found.info!;
  }

  get(id: string): ComponentInfo {
    return this.lookup(id);
  }

  resolve(ref: ComponentRef, kind: ComponentKind): ResolvedComponentRef {
    const { id, params } = normalizeComponentRef(ref);
    const info = this.lookup(id, kind);
    const m = info.manifest;
    if (!usableAs(m, kind)) {
      const same = this.list(kind).map((i) => i.manifest.id);
      throw new ComponentError(`component "${id}" is ${article(m.kind)} ${m.kind} component, not ${article(kind)} ${kind} (${kind} components: ${same.join(', ') || 'none'})`);
    }
    const schema = (m.params as JsonSchemaNode | undefined) ?? EMPTY_PARAMS;
    const merged = applyParamDefaults(schema, params);
    const issues = validateParamValue(schema, merged, ['params']);
    if (issues.length > 0) {
      const lines = issues.map((i) => `  ${formatPath(i.path)}: ${i.message}`);
      throw new ComponentError(
        `invalid params for component "${id}":\n${lines.join('\n')}`,
        // Not file-bound: the params come from a theme or a scenario.
        issues.map(({ loc: _loc, ...i }) => ({ ...i, file: '' })),
      );
    }
    return { id, version: m.version, kind, params: merged, manifest: m, dir: info.dir, entry: info.entry, source: info.source };
  }

  resolveTheme(template: Template): Record<ComponentKind, ResolvedComponentRef | null> {
    const chosen = resolveThemeComponents(template);
    const out = {} as Record<ComponentKind, ResolvedComponentRef | null>;
    const failures: string[] = [];
    for (const kind of COMPONENT_KINDS) {
      const c = chosen[kind];
      if (c === null) {
        out[kind] = null;
        continue;
      }
      try {
        out[kind] = this.resolve({ id: c.id, params: c.params }, kind);
      } catch (e) {
        out[kind] = null;
        const from = c.source === 'theme' ? `components.${kind}` : c.source === 'legacy' ? 'a legacy template field' : 'the built-in default';
        failures.push(`${kind} (${from}): ${errorMessage(e).replace(/\n/g, '\n    ')}`);
      }
    }
    if (failures.length > 0) {
      const name = template.name ? `theme "${template.name}"` : 'theme';
      throw new ComponentError(`${name}: ${failures.length} component${failures.length === 1 ? '' : 's'} cannot be resolved:\n  ${failures.join('\n  ')}`);
    }
    return out;
  }
}

/** Whether a path is a folder (a link to one counts). */
function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether two folders are the same one (real paths when both exist, else the resolved paths). */
function sameFolder(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** What a component of `source` overriding one of `under` is called in a notice. */
const OVERRIDDEN: Record<Exclude<ComponentSource, 'project'>, string> = { workspace: 'the workspace one', builtin: 'the built-in one' };

/**
 * Scan `<projectComponentsDir>/<namespace>/<name>/component.yaml` (a project's, when given), then the workspace's
 * (`<componentsDir>/…`), then the built-in library. Invalid component folders are kept out of `list()` and reported in
 * `notices` (and by `get`/`resolve` with their issues); an id found earlier in that order wins with a warning notice
 * (an invalid folder too: it shadows with its error, as the person's own folder).
 */
export async function loadComponentRegistry(opts: LoadComponentRegistryOptions): Promise<ComponentRegistry> {
  const componentsDir = opts.componentsDir ? resolve(opts.componentsDir) : (await loadWorkspaceConfig(opts.root)).componentsDir;
  const builtinDir = opts.builtinDir === null ? undefined : resolve(opts.builtinDir ?? LIBRARY_DIR);
  const projectDir = opts.projectComponentsDir === undefined ? undefined : resolve(opts.projectComponentsDir);
  // Only a folder that is there: a project without its own components/ answers as the workspace does, word for word.
  const projectComponentsDir =
    projectDir !== undefined && isFolder(projectDir) && !sameFolder(projectDir, componentsDir) && !(builtinDir && sameFolder(projectDir, builtinDir)) ? projectDir : undefined;
  const notices: RegistryNotice[] = [];
  const layers: Array<{ source: ComponentSource; dir: string }> = [
    ...(projectComponentsDir ? [{ source: 'project' as const, dir: projectComponentsDir }] : []),
    { source: 'workspace', dir: componentsDir },
    ...(builtinDir ? [{ source: 'builtin' as const, dir: builtinDir }] : []),
  ];
  const found = new Map<string, Found & { source: ComponentSource; base: string }>();
  for (const layer of layers) {
    for (const [id, f] of await scan(layer.dir, layer.source, notices)) {
      const own = found.get(id);
      if (own) {
        notices.push({
          severity: 'warning',
          message: `${own.source} component ${id} overrides ${OVERRIDDEN[layer.source as Exclude<ComponentSource, 'project'>]}`,
          source: own.source,
          dir: own.info?.dir ?? own.broken?.dir ?? join(own.base, id),
          id,
        });
        continue;
      }
      found.set(id, { ...f, source: layer.source, base: layer.dir });
    }
  }
  return new Registry(componentsDir, builtinDir, found, notices, projectComponentsDir);
}
