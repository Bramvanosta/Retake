/**
 * Tool input schemas: zod (the single definition), published as JSON Schema in *input* mode — a field with a default is
 * optional for the caller — and parsed with messages that name the argument. Every name a tool takes is a slug or an
 * id, checked here before the engine (and core, which also accepts paths) sees it.
 */
import { z } from 'zod';

/** Problems named per argument: the operation contract's (invoke reports them). */
export { argumentProblems } from '@retake/engine/contract';

/** The schema pieces of the inputs: the engine's operations' (L7.13), the same zod objects. */
export { componentId, editOverrides, envName, ifMatch, projectSlug, renderId, runId, scenarioName, templateName } from '@retake/engine/contract';

/** JSON Schema of a tool's input (draft 2020-12, without $schema / $id): what tools/list publishes. */
export function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  delete json.$id;
  return json;
}
