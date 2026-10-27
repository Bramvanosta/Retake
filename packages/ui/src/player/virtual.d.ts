/**
 * The preview bundle's generated modules (bundle-player.ts writes them; frame-main.tsx imports them). Types only: they
 * exist inside the esbuild build, never on disk.
 */
declare module 'ds:composition' {
  import type { ComponentType, Context } from 'react';
  /** DemoVideo, the composition of every render (packages/editor src/remotion). */
  export const DemoVideo: ComponentType<Record<string, unknown>>;
  /** ComponentPreview, the composition of component previews (L4.7: the theme editor's live previews). */
  export const ComponentPreview: ComponentType<Record<string, unknown>>;
  export const ModulesContext: Context<unknown>;
  export const PreviewContext: Context<{ warn(message: string): void } | null>;
  export function usedComponentIds(plan: unknown): string[];
}

declare module 'ds:modules' {
  /** The bundle's hash (16 hex). */
  export const bundle: string;
  /** Each component of the workspace, by id: its module, evaluated only when the preview first needs it. */
  export const loaders: Record<string, () => Promise<{ default?: unknown }>>;
  /** Each component's params defaults (the manifest's), by id. */
  export const defaults: Record<string, Record<string, unknown>>;
  /** Workspace components left out until the person allows them in this Studio session (ids; review A H1 c). */
  export const held: string[];
  /** The scaffold of each kind (a stand-in for a missing use), loaded the same way. */
  export const scaffolds: Record<string, { load: () => Promise<{ default?: unknown }>; defaults: Record<string, unknown> }>;
}
