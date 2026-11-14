import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toJsonSchema } from '@retake/core/schema';
import type { JsonSchema } from '@retake/core/schema';
import { paramSchemaJsonSchema } from './json-schema.js';
import { ComponentManifestFileSchema } from './manifest.js';

let cached: JsonSchema | undefined;

/**
 * JSON Schema (draft 2020-12) of component.yaml, for editor autocompletion
 * (`# yaml-language-server: $schema=…/component.schema.json`). `params` is described by the supported
 * JSON Schema subset (ParamSchema).
 */
export function componentJsonSchema(): JsonSchema {
  if (!cached) {
    const out = toJsonSchema(ComponentManifestFileSchema, 'component');
    const props = out.properties as Record<string, JsonSchema>;
    const description = props.params?.description;
    props.params = { $ref: '#/$defs/ParamSchema', ...(description ? { description } : {}) };
    const defs = { ...((out.$defs as Record<string, JsonSchema> | undefined) ?? {}), ParamSchema: paramSchemaJsonSchema() };
    delete out.$defs;
    out.$defs = defs;
    cached = out;
  }
  return structuredClone(cached);
}

/** Write `<dir>/component.schema.json`; returns its path. */
export async function writeComponentJsonSchema(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'component.schema.json');
  await writeFile(file, JSON.stringify(componentJsonSchema(), null, 2) + '\n', 'utf8');
  return file;
}
