/**
 * The ComponentRegistries port: where the engine gets a workspace's component registry (its components/ folder, then
 * the built-in library) — the one way it loads one. The engine hands what it loads, or the port's `load` itself, to the
 * work that reads components (a plan, a render, a review, the catalogue, a theme's picks), so the editor and the
 * review load none by themselves — and the catalogue's disk work (a component validated, scaffolded, its preview's status
 * and its source files). It names no adapter, types included (the import-rules ratchet's `port-types`): the
 * registry's type is the components' domain entry's. Adapters: the components package (`packageRegistries`,
 * the composition package's package-registries.ts) and an in-memory one for tests (`MemoryRegistries`, memory-registries.ts); one contract
 * (engine/test/registries-contract.ts).
 */
import type { ComponentRegistry, ComponentValidation, CreateComponentOptions, CreatedComponent, PreviewStatus, RegistryScope } from '@retake/components/geometry';
import { EngineError } from '../errors.js';

/**
 * The component catalogue's work on the disk: what reads a component's folder, compiles its code (esbuild: nothing is
 * run) or writes a scaffold. The package's functions behind it, unchanged (their answers and refusals are its own).
 */
export interface ComponentCatalogue {
  /** A component folder validated: its manifest, its positioned issues (component.yaml first, then its code compiled). */
  validate(dir: string): Promise<ComponentValidation>;
  /** A workspace component scaffolded from its kind's template, each file written through `opts.write`. */
  create(root: string, opts: CreateComponentOptions): Promise<CreatedComponent>;
  /** Whether a component folder's committed preview matches its sources (and, given, the theme). */
  previewStatus(dir: string, opts?: { theme?: string }): Promise<PreviewStatus>;
  /** A component's source files, relative to its folder, as the preview hash counts them. */
  sourceFiles(dir: string, manifest?: { entry?: string }): Promise<string[]>;
}

export interface ComponentRegistries {
  /**
   * The registry of the workspace at `root`, read now (a call reads the folders again: holding one is the caller's);
   * with `o.projectDir`, a project's: its own `components/` first, then the workspace's, then the built-in library.
   * Rejects with the reader's own error when the workspace's settings cannot be read.
   */
  load(root: string, o?: RegistryScope): Promise<ComponentRegistry>;
  /** The catalogue's disk work (validate, scaffold, preview status, source files). */
  readonly catalogue: ComponentCatalogue;
}

/**
 * The loader a plan or a review is handed (components RegistrySource): the port's `load`, called by that work with the
 * root it works in and the project it works for, at the point it reads the registry — so a broken components folder is
 * said where it always was, and a project's own components come first.
 */
export function registryLoader(registries: ComponentRegistries): (root: string, o?: RegistryScope) => Promise<ComponentRegistry> {
  // A caller outside the type checker that handed no port is refused here, before any work: never a load of the work's own.
  if (typeof (registries as Partial<ComponentRegistries> | undefined)?.load !== 'function') throw new EngineError('internal', 'no component registries were handed to the engine');
  return (root, o) => (o?.projectDir === undefined ? registries.load(root) : registries.load(root, { projectDir: o.projectDir }));
}
