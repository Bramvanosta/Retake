/**
 * The engine's two adapter modules, as the composition package binds them (`@retake/compose`: its loaders, loaded on
 * first use): the editor's and the components package's, whose work the render folder and the registries folder hand
 * on under names of their own (render/editor-calls.ts, render/work.ts, registries/component-calls.ts). The engine never
 * loads an adapter package itself — this file names their roots as types only (the import-rules ratchet's
 * `engine-load`) — and each loader is used in its home only (`loader-use`): `editor` in render/, `components` in
 * registries/. Before a composition root binds them, a call is refused by name.
 */
import { EngineError } from './errors.js';

/** The editor's module (its root: the planner, the renderer, the previews, their errors). */
export type EditorModule = typeof import('@retake/editor');
/** The components package's module (its root: the registry, the catalogue's disk work, the pure helpers). */
export type ComponentsModule = typeof import('@retake/components');

/** What a composition root binds: each module's loader (the composition package's lazy imports). */
export interface AdapterModules {
  editor(): Promise<EditorModule>;
  components(): Promise<ComponentsModule>;
}

// The process's by nature, not an engine's (the import-rules ratchet's engine-state, ENGINE_STATE_PROCESS): which
// editor and components code this process loads. Two engines of one process share it.
let bound: AdapterModules | undefined;

/**
 * Bind the adapter modules (a composition root, once per process): binding the same modules again is a no-op, binding
 * others once some are bound is refused (they would change under the engines already made).
 */
export function bindAdapterModules(modules: AdapterModules): void {
  if (bound === modules) return;
  if (bound) throw new EngineError('internal', 'other adapter modules are bound in this process already: a process binds one product');
  bound = modules;
}

function modules(): AdapterModules {
  if (!bound) throw new EngineError('internal', 'no adapter modules are bound: a composition root builds the engine from @retake/compose (productPorts)');
  return bound;
}

/** The editor's module (Remotion's renderer and bundler come with it; its planner and render records too). */
export const editor = async (): Promise<EditorModule> => modules().editor();

/** The components package's module (esbuild comes with it: a component's compile check, the registry's readers). */
export const components = async (): Promise<ComponentsModule> => modules().components();
