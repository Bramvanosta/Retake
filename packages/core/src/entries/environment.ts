/**
 * @retake/core/environment — a project's environments: their pages and display URLs, the host allow-list, access
 * (read-only, writes), the product clock, sessions and personas.
 *
 * A context of core: its files may import the contexts before it (base, model, ids,
 * language); the ratchet's `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported
 * by the entry of the file that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the
 * packages' sources import an entry: the `core-root` check).
 */
export * from '../types/environment.js';
export * from '../env.js';
export * from '../hosts.js';
export * from '../access.js';
export * from '../display.js';
export * from '../clock.js';
export * from '../writes.js';
export * from '../auth.js';
