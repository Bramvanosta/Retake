/**
 * @retake/core/ids — the ids of the domain: one grammar each (run, render, job, ULID ids, theme names) and their
 * generators.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model); the
 * ratchet's `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported by the entry of
 * the file that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the packages'
 * sources import an entry: the `core-root` check).
 */
export * from '../id-grammar.js';
export * from '../ids.js';
