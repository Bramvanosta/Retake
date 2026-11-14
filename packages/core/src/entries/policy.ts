/**
 * @retake/core/policy — the rules for work an agent shapes: the paths it writes, navigation, shell grammar, the
 * programs and environment it may name; public addresses.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model, ids,
 * language, environment); the ratchet's `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name
 * is exported by the entry of the file that declares it; the root `@retake/core` is every entry at once, for tests and
 * scripts (the packages' sources import an entry: the `core-root` check).
 */
export * from '../agent-policy.js';
export * from '../ip-class.js';
