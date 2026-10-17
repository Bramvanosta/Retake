/**
 * Tool input schemas: zod (the single definition), published as JSON Schema in *input* mode — a field with a default is
 * optional for the caller — and parsed with messages that name the argument. Every name a tool takes is a slug or an
 * id, checked here before the engine (and core, which also accepts paths) sees it.
 */
import { z } from 'zod';
import { PROJECT_SLUG_RE, SLUG_RE } from '@demo-studio/core';
import { RUN_ID_RE } from '@demo-studio/engine';

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

export const runId = z
  .string()
  .max(200)
  .regex(RUN_ID_RE, 'a run id such as 20261017-142233-quote (run_list names them), never a path')
  .describe('Run id (a folder of runs/, from run_list).');

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

/** One line per problem, naming the argument: "project: a project slug…". */
export function argumentProblems(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const where = i.path.length ? i.path.map(String).join('.') : '(arguments)';
    const keys = (i as { keys?: string[] }).keys;
    return i.code === 'unrecognized_keys' && keys ? `${where}: unknown argument${keys.length > 1 ? 's' : ''} ${keys.join(', ')}` : `${where}: ${i.message}`;
  });
}
