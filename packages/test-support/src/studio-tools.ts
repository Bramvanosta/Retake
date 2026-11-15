/** The Studio's ops built with stand-ins, for tests that read their definitions (names, schemas, annotations). */
import { studioTools } from '@retake/ui/testing';
import type { StudioToolDeps } from '@retake/ui/testing';

/** Building the ops reads nothing: each closes over its dependencies until it is called (never, here). */
export function stubTools(): ReturnType<typeof studioTools> {
  const none = {} as never;
  const deps: StudioToolDeps = {
    live: none,
    player: () => none,
    forbid: () => [],
    allow: none,
    registry: async () => none,
    leases: none,
    unsaved: none,
    desktop: none,
    setupState: none,
    updateState: none,
    setupContext: () => none,
    workspace: '/workspace',
  };
  return studioTools(deps);
}
