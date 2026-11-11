/**
 * `@retake/hooks/describe` — a hook as words, without running it: what a hook does in one line, its rollback, every
 * field it declares as a person reads it before approving it, and a journaled rollback in full. No file, no process,
 * no network, no secret: every module reachable from here imports `@retake/core` only (test/describe-entry.test.ts
 * walks the imports). A domain entry (scripts/audit/lib.mjs DOMAIN_ENTRIES): the engine may use its values, a shell its
 * types. The names are the package root's, value for value.
 */
export { declaredHookLines, describeHook, describeRollback, hookKindOf } from './describe.js';
export { actionLines, fieldLines, rollbackActionLines, visible } from './shown.js';
export type { ShownAction } from './shown.js';
