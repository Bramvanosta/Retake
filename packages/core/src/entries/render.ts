/**
 * @retake/core/render — renders: the render record, ffprobe's answers, the GPU status, the export formats.
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model, ids,
 * language, environment, policy, hooks, project, sandbox, scenario, comments, run); the ratchet's `core-context` check
 * holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported by the entry of the file that declares it; the
 * root `@retake/core` is every entry at once, for tests and scripts (the packages' sources import an entry: the
 * `core-root` check).
 */
export * from '../render-record.js';
export * from '../ffprobe.js';
export * from '../gpu.js';
export * from '../export-formats.js';
