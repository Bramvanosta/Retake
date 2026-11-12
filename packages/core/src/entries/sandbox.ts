/**
 * @retake/core/sandbox — sandboxes: sandbox.yaml read and checked, its errors.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model, ids,
 * language, environment, policy, hooks, project); the ratchet's `core-context` check holds it (scripts/audit/lib.mjs
 * CORE_CONTEXTS). Each name is exported by the entry of the file that declares it; the root `@retake/core` is every
 * entry at once, for tests and scripts (the packages' sources import an entry: the `core-root` check).
 */
export * from '../sandbox.js';
export { SandboxError } from '../sandbox-error.js';
export type { SandboxErrorCode } from '../sandbox-error.js';
export { DEFAULT_COMPOSE_FILES, SNAPSHOT_DATABASE_MAX, checkSandbox, unmaskedPasswordReason, weakPasswordReason } from '../checks/sandbox.js';
export type { SandboxCheckOptions } from '../checks/sandbox.js';
export { SEED_KINDS, SandboxFileSchema, SeedStepSchema } from '../schemas/sandbox.js';
