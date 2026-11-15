/**
 * The registry a plan or a render reads, from what its caller handed (components RegistrySource): the registry itself,
 * or its loader, called here with the workspace root. This package loads no registry by itself: work handed neither —
 * a caller outside the type checker — is refused with NO_REGISTRY, never served by a silent load of its own.
 */
import { NO_REGISTRY_HANDED } from '@retake/components/geometry';
import type { ComponentRegistry, RegistrySource } from '@retake/components/geometry';
import { RenderError } from './types.js';

/** Why work handed no registry is refused (after the name of the work): the components' one sentence. */
export const NO_REGISTRY = NO_REGISTRY_HANDED;

/** Whether `v` looks like a loaded registry (what a caller outside the type checker may hand instead). */
function isRegistry(v: unknown): v is ComponentRegistry {
  const r = v as Partial<ComponentRegistry> | null;
  return typeof r === 'object' && r !== null && typeof r.get === 'function' && typeof r.list === 'function';
}

/** The registry of `source` for `root` (a loader is called once, here); RenderError when none was handed. */
export async function registryFrom(source: RegistrySource | undefined, root: string, work: string): Promise<ComponentRegistry> {
  if (typeof source === 'function') return source(root);
  return handedRegistry(source, work);
}

/** The registry handed to `work`, already loaded; RenderError when none was. */
export function handedRegistry(source: unknown, work: string): ComponentRegistry {
  if (isRegistry(source)) return source;
  throw new RenderError(`${work}: ${NO_REGISTRY}`);
}
