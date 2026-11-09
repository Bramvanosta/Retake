import { z } from 'zod';
import { ProjectFileSchema } from './project.js';
import { SandboxFileSchema } from './sandbox.js';
import { ScenarioSchema } from './scenario.js';
import { TemplateFileSchema } from './template.js';
import { TimelineSchema } from './timeline.js';

export type JsonSchema = Record<string, unknown>;

const SAFE_INT = Number.MAX_SAFE_INTEGER;

/** Zod emits ±MAX_SAFE_INTEGER bounds for every .int(); they are noise for editors. */
function stripSafeIntBounds(node: Record<string, unknown>): void {
  if (node.minimum === -SAFE_INT) delete node.minimum;
  if (node.maximum === SAFE_INT) delete node.maximum;
}

/** Replace refs to $defs entries that are only `{ $ref }` aliases (from z.lazy) by their target. */
function inlineAliasDefs(schema: JsonSchema): void {
  const defs = schema.$defs as Record<string, JsonSchema> | undefined;
  if (!defs) return;
  const alias = new Map<string, string>();
  for (const [name, def] of Object.entries(defs)) {
    if (Object.keys(def).length === 1 && typeof def.$ref === 'string') alias.set(`#/$defs/${name}`, def.$ref);
  }
  if (alias.size === 0) return;
  const resolve = (ref: string): string => {
    const seen = new Set<string>();
    while (alias.has(ref) && !seen.has(ref)) {
      seen.add(ref);
      ref = alias.get(ref)!;
    }
    return ref;
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.$ref === 'string') o.$ref = resolve(o.$ref);
      Object.values(o).forEach(walk);
    }
  };
  walk(schema);
  for (const name of Object.keys(defs)) if (alias.has(`#/$defs/${name}`)) delete defs[name];
}

/**
 * JSON Schema (draft 2020-12) of a zod schema, cleaned up for editors: no ±MAX_SAFE_INTEGER bounds, alias defs
 * inlined, root object at the top level, `$id: <id>.schema.json`. Used for every generated *.schema.json.
 */
export function toJsonSchema(schema: z.ZodType, id: string): JsonSchema {
  return generate(schema, id);
}

function generate(schema: z.ZodType, id: string): JsonSchema {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    override: (ctx) => stripSafeIntBounds(ctx.jsonSchema as Record<string, unknown>),
  }) as JsonSchema;
  inlineAliasDefs(out);
  inlineRootDef(out);
  return { $schema: out.$schema, $id: `${id}.schema.json`, ...out };
}

/** A root schema with an id comes out as `{ $ref: '#/$defs/X' }`; editors prefer the object at the root. */
function inlineRootDef(schema: JsonSchema): void {
  const defs = schema.$defs as Record<string, JsonSchema> | undefined;
  const ref = schema.$ref;
  if (!defs || typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return;
  const name = ref.slice('#/$defs/'.length);
  const def = defs[name];
  if (!def) return;
  delete schema.$ref;
  delete defs[name];
  Object.assign(schema, def);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.$ref === ref) o.$ref = '#';
      Object.values(o).forEach(walk);
    }
  };
  walk(schema);
  // keep $defs last for readability
  if (Object.keys(defs).length === 0) delete schema.$defs;
  else {
    delete schema.$defs;
    schema.$defs = defs;
  }
}

const cache = new Map<string, JsonSchema>();

function cached(id: string, schema: z.ZodType): JsonSchema {
  let s = cache.get(id);
  if (!s) {
    s = generate(schema, id);
    cache.set(id, s);
  }
  return structuredClone(s);
}

/** JSON Schema (draft 2020-12) of scenario YAML files — one `anyOf` branch per step action. */
export function scenarioJsonSchema(): JsonSchema {
  return cached('scenario', ScenarioSchema);
}

/** JSON Schema of project.yaml (as written; defaults are applied by loadProject). */
export function projectJsonSchema(): JsonSchema {
  return cached('project', ProjectFileSchema);
}

/** JSON Schema of templates/<name>/template.yaml (every section optional). */
export function templateJsonSchema(): JsonSchema {
  return cached('template', TemplateFileSchema);
}

/** JSON Schema of runs/<id>/timeline.json. */
export function timelineJsonSchema(): JsonSchema {
  return cached('timeline', TimelineSchema);
}

/** JSON Schema of a sandbox.yaml (version 1, L1.8). */
export function sandboxJsonSchema(): JsonSchema {
  return cached('sandbox', SandboxFileSchema);
}

export const JSON_SCHEMAS = {
  scenario: scenarioJsonSchema,
  project: projectJsonSchema,
  template: templateJsonSchema,
  timeline: timelineJsonSchema,
  sandbox: sandboxJsonSchema,
} as const;

export type JsonSchemaName = keyof typeof JSON_SCHEMAS;
