/**
 * @retake/core/schema — the JSON Schemas of the file formats (written to packages/core/schema/ by gen:schema; the zod
 * schemas themselves are exported by their contexts' entries — the barrel schema.ts did both until L7.35).
 *
 * A context of core (L7.35, audit 2026-11-10 D1): its files may import the contexts before it (base, model, ids,
 * language, environment, policy, hooks, project, sandbox, scenario, comments, run, render, theme); the ratchet's
 * `core-context` check holds it (scripts/audit/lib.mjs CORE_CONTEXTS). Each name is exported by the entry of the file
 * that declares it; the root `@retake/core` is every entry at once, for tests and scripts (the packages' sources import
 * an entry: the `core-root` check).
 */
export { JSON_SCHEMAS, projectJsonSchema, sandboxJsonSchema, scenarioJsonSchema, templateJsonSchema, timelineJsonSchema, toJsonSchema } from '../schemas/json.js';
export type { JsonSchema, JsonSchemaName } from '../schemas/json.js';
