/**
 * @retake/core/environment — a project's environments: their pages and display URLs, the host allow-list, access
 * (read-only, writes), the product clock, sessions and personas.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model, ids,
 * language); the ratchet's `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported
 * by the entry of the file that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the
 * packages' sources import an entry: the `core-root` check).
 */
export * from '../env.js';
export * from '../hosts.js';
export * from '../access.js';
export * from '../display.js';
export * from '../clock.js';
export * from '../writes.js';
export * from '../auth.js';
