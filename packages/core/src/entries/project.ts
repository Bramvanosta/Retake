/**
 * @retake/core/project — the workspace and its projects (types/project.ts): the workspace file, project.yaml read and
 * checked, the capture, pacing, browser and raw export settings and their schemas, the folder layout.
 *
 * A context of core: its files may import the contexts before it (base, model, ids,
 * language, environment, policy, hooks); the ratchet's `core-context` check holds it (scripts/audit/lib.mjs
 * CORE_CONTEXTS). Each name is exported by the entry of the file that declares it; the root `@retake/core` is every
 * entry at once, for tests and scripts (the packages' sources import an entry: the `core-root` check).
 */
export * from '../types/project.js';
export * from '../workspace.js';
export * from '../project.js';
export * from '../layout.js';
export { RESERVED_PAGE_KEYS } from '../checks/project.js';
export { ProjectConfigSchema, ProjectFileSchema, WorkspaceFileSchema } from '../schemas/project.js';
export { AuthConfigSchema, BrowserConfigSchema, CapturePartialSchema, CaptureSettingsSchema, PacingPartialSchema, PacingSchema } from '../schemas/settings.js';
