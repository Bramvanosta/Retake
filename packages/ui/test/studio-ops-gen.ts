/**
 * L6.12: the generator of the app's typed operation client — src/app/data/studio-ops.gen.ts, the arguments of every op
 * the Studio serves (UI_OPS, in order) as TypeScript types, written from each op's input as `/v1/call/<op>` parses it
 * (the zod schema of the Studio's op table — the MCP tool with the Studio's pinned arguments, or the Studio's own op —
 * as JSON Schema, `io: 'input'`: the shape a page sends). The server's tables erase their schemas' types (each op is a
 * `ToolDef`), so the client is generated, not inferred; studio-ops.test.ts holds the committed file to this text.
 * After an intended change of an op's input: RETAKE_WRITE_SNAPSHOTS=1 on studio-ops.test.ts, then review the diff.
 */
import { z } from 'zod';
import { UI_OPS } from '../src/server/studio.js';
import { stubTools } from './studio-tools.js';

type Json = Record<string, unknown>;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const lit = (v: unknown) => JSON.stringify(v);
const union = (parts: string[]) => {
  const uniq = [...new Set(parts)];
  return uniq.length === 1 ? uniq[0] : uniq.map((p) => (p.includes('=>') ? `(${p})` : p)).join(' | ');
};
const pad = (depth: number) => '  '.repeat(depth);

/** One JSON Schema (the subset zod writes for the Studio's inputs) as a TypeScript type; anything else fails loudly. */
export function typeOf(s: Json, depth = 1): string {
  const known = new Set(['type', 'properties', 'required', 'additionalProperties', 'propertyNames', 'items', 'anyOf', 'oneOf', 'enum', 'const', 'description', 'default', 'pattern', 'maxLength', 'minLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'format']);
  for (const k of Object.keys(s)) if (!known.has(k)) throw new Error(`studio-ops-gen: JSON Schema keyword ${k} is not handled`);
  if ('const' in s) return lit(s.const);
  if (Array.isArray(s.enum)) return union(s.enum.map(lit));
  const alts = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (alts) return union(alts.map((a) => typeOf(a, depth)));
  switch (s.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const item = typeOf((s.items ?? {}) as Json, depth);
      return `readonly ${/[|&]/.test(item) ? `(${item})` : item}[]`;
    }
    case 'object': {
      const props = Object.entries((s.properties ?? {}) as Record<string, Json>);
      const required = new Set((s.required ?? []) as string[]);
      const extra = s.additionalProperties;
      if (!props.length) {
        if (extra && typeof extra === 'object') return `{ [key: string]: ${typeOf(extra as Json, depth)} }`;
        // An empty strict object: no argument at all (an object literal with a key is an error).
        return 'Record<string, never>';
      }
      const lines = props.map(([k, v]) => `${pad(depth)}${key(k)}${required.has(k) ? '' : '?'}: ${typeOf(v, depth + 1)};`);
      if (extra && typeof extra === 'object') lines.push(`${pad(depth)}[key: string]: ${typeOf(extra as Json, depth + 1)};`);
      return `{\n${lines.join('\n')}\n${pad(depth - 1)}}`;
    }
    case undefined:
      // No constraint (z.unknown()).
      return 'unknown';
    default:
      throw new Error(`studio-ops-gen: JSON Schema type ${JSON.stringify(s.type)} is not handled`);
  }
}

/** The text of src/app/data/studio-ops.gen.ts. */
export function studioOpsSource(): string {
  const tools = stubTools();
  const entries = UI_OPS.map((op) => {
    const t = tools.get(op)!;
    const json = z.toJSONSchema(t.input, { io: 'input' }) as Json;
    delete json.$schema;
    delete json.$id;
    return `  /** ${t.title.replace(/\*\//g, '*\\/')} */\n  ${key(op)}: ${typeOf(json, 2)};`;
  });
  return [
    '/**',
    " * GENERATED — do not edit. The arguments of every op the Studio serves (UI_OPS, in catalogue order), as `/v1/call/<op>`",
    " * parses them: written by packages/ui/test/studio-ops-gen.ts from the Studio's op table (each op's zod input, the",
    ' * Studio\'s pinned arguments included); packages/ui/test/studio-ops.test.ts holds this file to it (RETAKE_WRITE_SNAPSHOTS=1',
    ' * on that test after an intended change of an input). The results are the app\'s own types: data/ops.ts.',
    ' */',
    '',
    '/** Each op\'s arguments: the JSON a page sends. */',
    'export interface StudioOpArgs {',
    ...entries,
    '}',
    '',
    '/** An op the Studio serves (`POST /v1/call/<op>`). */',
    'export type StudioOp = keyof StudioOpArgs;',
    '',
  ].join('\n');
}
