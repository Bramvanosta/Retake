/**
 * The component implementations a bundle carries: the GENERATED registry module (see ../render/bundle.ts) exports a
 * `ComponentModules` value — every component entry the plan uses (built-in library and workspace components alike)
 * and the per-kind scaffolds used as stand-ins for uses the planner marked `missing`.
 */
import { createContext, useContext } from 'react';
import type { ComponentType } from 'react';
import type { ComponentKind } from '@retake/core/model';
import type { ComponentProps } from '@retake/components';
import type { ResolvedComponent } from '../plan-types.js';
import { standInParams } from './frames.js';

// Components declare their own params type: the composition hands them the resolved params as a plain record.
// biome-ignore lint/suspicious/noExplicitAny: each component's own params type is unknown here, any is the widest props type that admits them all
export type AnyComponent = ComponentType<ComponentProps<any>>;

export interface ComponentModule {
  component: AnyComponent;
  /** Params defaults of the manifest (stand-ins only need them: resolved uses carry their params). */
  defaults: Record<string, unknown>;
}

export interface ComponentModules {
  /** By component id. */
  components: Record<string, ComponentModule>;
  /** Scaffold of each kind (stand-in for a `missing` use or an id absent from the bundle). */
  scaffolds: Partial<Record<ComponentKind, ComponentModule>>;
}

export const ModulesContext = createContext<ComponentModules | null>(null);

export function useModules(): ComponentModules {
  const m = useContext(ModulesContext);
  if (!m) throw new Error('DemoVideo rendered without its component modules (createRoot(modules) provides them)');
  return m;
}

/** The implementation and params of one component use (the scaffold of its kind for a missing one). */
export function pickComponent(
  modules: ComponentModules,
  rc: ResolvedComponent,
  transitionKind?: 'crossfade' | 'fade-black',
): { Component: AnyComponent; params: Record<string, unknown>; standIn: boolean } {
  const own = rc.missing ? undefined : modules.components[rc.id];
  if (own) return { Component: own.component, params: rc.params, standIn: false };
  const scaffold = modules.scaffolds[rc.kind];
  if (!scaffold) throw new Error(`no implementation for component ${rc.id} (${rc.kind}) and no ${rc.kind} scaffold in the bundle`);
  const params: Record<string, unknown> = { ...scaffold.defaults };
  for (const [k, v] of Object.entries(rc.params)) if (k in scaffold.defaults) params[k] = v;
  Object.assign(params, standInParams(rc.kind, transitionKind));
  return { Component: scaffold.component, params, standIn: true };
}
