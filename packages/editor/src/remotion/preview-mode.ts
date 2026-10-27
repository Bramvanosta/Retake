/**
 * Preview mode (L4.5, DESIGN §4g): the Studio's live preview plays DemoVideo in a Remotion Player inside a sandboxed
 * frame. Only that frame (packages/ui `frame-main.tsx`) provides a `PreviewMode`; renders never do, so a render is
 * unchanged by it. In preview mode a theme font that does not load falls back to the system font with a warning (a
 * render stops instead: cancelRender), because the Player holds nothing for delayRender and a thrown cancelRender would
 * leave the preview blank with no message (critique B8).
 */
import { createContext, useContext } from 'react';
import type { EditPlan, ResolvedComponent } from '../plan-types.js';

export interface PreviewMode {
  /** A problem the preview worked around (shown to the person as untrusted text; at most a line). */
  warn(message: string): void;
}

export const PreviewContext = createContext<PreviewMode | null>(null);

/** The preview mode, or null in a render. */
export function usePreviewMode(): PreviewMode | null {
  return useContext(PreviewContext);
}

/** The ids of the components a plan uses (missing uses excluded: they draw with the scaffold of their kind). Pure. */
export function usedComponentIds(plan: Pick<EditPlan, 'segments' | 'tutorial'>): string[] {
  const ids = new Set<string>();
  const add = (rc: ResolvedComponent | null | undefined) => {
    if (rc && !rc.missing) ids.add(rc.id);
  };
  for (const s of plan.segments) {
    add(s.component);
    add(s.transition?.component);
    if (s.kind === 'clip') {
      add(s.caption);
      for (const o of s.overlays) add(o.component);
    }
  }
  add(plan.tutorial?.progress?.component);
  return [...ids].sort();
}
