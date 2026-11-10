/**
 * Tool input schemas: zod (the single definition), published as JSON Schema in *input* mode — a field with a default is
 * optional for the caller — and parsed with messages that name the argument. Every name a tool takes is a slug or an
 * id, checked here before the engine (and core, which also accepts paths) sees it.
 */
import { z } from 'zod';
import { COMPONENT_ID_RE, EditOverridesInputSchema, PROJECT_SLUG_RE, SLUG_RE, zRenderId, zRunId, zThemeName } from '@retake/core';

/** Problems named per argument: the operation contract's (callTool reports them). */
export { argumentProblems } from '@retake/engine/contract';

export const projectSlug = z
  .string()
  .max(100)
  .regex(PROJECT_SLUG_RE, 'a project slug: lower-case letters, digits and "-" (project_list names them), never a path')
  .describe('Project slug (from project_list).');

export const scenarioName = z
  .string()
  .max(100)
  .regex(SLUG_RE, 'a scenario name: letters, digits, "-" or "_" (scenarios/<name>.yaml), never a path')
  .describe('Scenario name: the file scenarios/<name>.yaml of the project.');

export const runId = zRunId('a run id such as 20261017-142233-quote (run_list names them), never a path')
  .describe('Run id (a folder of runs/, from run_list).');

export const renderId = zRenderId('a render id such as quote-v3 or quote-v3-vertical (render returns it), never a path')
  .describe('Render id (renders/<id>.mp4): what render returned.');

export const templateName = zThemeName('a theme name such as editorial (a folder of templates/), never a path')
  .describe("Theme (template) name for this render instead of the run's, e.g. editorial or motion.");

export const componentId = z
  .string()
  .max(120)
  .regex(COMPONENT_ID_RE, 'a component id "namespace/name" such as studio/intro-stack (component_list names them), never a path')
  .describe('Component id "namespace/name" (from component_list).');

export const editOverrides = EditOverridesInputSchema.describe(
  'Edit choices for this render, without touching the scenario: frame (card, browser, laptop, phone, tablet, raw or a layout component id), variant (landscape, vertical, square), fps, scale (0.5–2), intro / outro / captions / camera / trim_idle switches, idle_threshold, speeds per scene id, transition and transition_duration, components (by kind or segment id: a component id or {id, params}), music (a project file, or false), tutorial switches.',
);

export const envName = z.string().min(1).max(100).describe('Environment name of project.yaml (project_get lists them).');

export const ifMatch = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'the sha256 (64 hex characters) the read returned')
  .nullable()
  .optional();

/** JSON Schema of a tool's input (draft 2020-12, without $schema / $id): what tools/list publishes. */
export function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  delete json.$id;
  return json;
}
