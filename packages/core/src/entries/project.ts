/**
 * @retake/core/project — the workspace and its projects: the workspace file, project.yaml read and checked, the folder
 * layout.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model, ids,
 * language, environment, policy, hooks); the ratchet's `core-context` check holds it (scripts/audit/lib.mjs
 * CORE_CONTEXTS). Each name is exported by the entry of the file that declares it; the root `@retake/core` is every
 * entry at once, for tests and scripts (the packages' sources import an entry: the `core-root` check).
 */
export * from '../workspace.js';
export * from '../project.js';
export * from '../layout.js';
export { RESERVED_PAGE_KEYS } from '../checks/project.js';
export { ProjectConfigSchema, ProjectFileSchema, WorkspaceFileSchema } from '../schemas/project.js';
