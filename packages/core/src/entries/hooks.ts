/**
 * @retake/core/hooks — hooks: their files, which write or destroy, named hooks, the vocabulary of a hook run, the hosts
 * a shell hook names.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model, ids,
 * language, environment, policy); the ratchet's `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS).
 * Each name is exported by the entry of the file that declares it; the root `@retake/core` is every entry at once, for
 * tests and scripts (the packages' sources import an entry: the `core-root` check).
 */
export * from '../hook-run.js';
export * from '../hook-writes.js';
export * from '../named-hooks.js';
export * from '../destructive.js';
export { HookFileSchema, parseHookFile } from '../hookfile.js';
export { shellHostRefs } from '../shell-hosts.js';
export { shellRuns } from '../shell-runs.js';
export type { ShellRun } from '../shell-runs.js';
export type { ShellHostOptions, ShellHostRef } from '../shell-hosts.js';
export { HOOK_COMMON_KEYS, HOOK_KINDS, HookStepSchema } from '../schemas/hooks.js';
