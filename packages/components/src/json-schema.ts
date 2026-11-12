/**
 * The JSON Schema subset used for component params (`params:` in component.yaml).
 *
 * A component declares its params as a JSON Schema object with defaults; themes and scenarios pass partial params,
 * the registry merges the defaults under them and validates the result. Only a well-understood subset is accepted
 * (anything else is an error rather than being silently ignored), and — like every Retake format — objects are
 * CLOSED unless they set `additionalProperties`: an unknown param is a typo until proven otherwise.
 */
import { describeValue, didYouMean } from '@retake/core/base';
import type { LocatedIssue } from '@retake/core/base';

export type JsonSchemaNode = Record<string, unknown>;
type Path = Array<string | number>;

export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** Validation keywords understood by the params validator. */
export const SUPPORTED_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'default',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'anyOf',
  'oneOf',
] as const;

/** Annotations: accepted, never validated. */
export const ANNOTATION_KEYWORDS = ['$schema', '$id', '$comment', 'title', 'description', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'format'] as const;

/** Standard keywords deliberately not supported (keep params flat and explicit). */
const UNSUPPORTED_KEYWORDS = new Set([
  '$ref',
  '$defs',
  'definitions',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'propertyNames',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'unevaluatedProperties',
  'unevaluatedItems',
  'minProperties',
  'maxProperties',
  'contentMediaType',
  'contentEncoding',
]);

const KNOWN = [...SUPPORTED_KEYWORDS, ...ANNOTATION_KEYWORDS] as readonly string[];

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function err(path: Path, message: string, loc?: LocatedIssue['loc']): LocatedIssue {
  return loc ? { severity: 'error', path, message, loc } : { severity: 'error', path, message };
}

function isNonNegInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function typesOf(node: JsonSchemaNode): ParamType[] | undefined {
  const t = node.type;
  if (typeof t === 'string') return [t as ParamType];
  if (Array.isArray(t)) return t as ParamType[];
  return undefined;
}

/**
 * Check that `schema` is a usable params schema: an object schema built from the supported keywords, whose
 * `default` values match their own (sub)schema. Issues are located at `base` + the path inside the schema.
 */
export function checkParamsSchema(schema: unknown, base: Path = ['params']): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  if (!isPlainObject(schema)) {
    out.push(err(base, `expected a JSON Schema mapping (type: object, properties: …), got ${describeValue(schema)}`));
    return out;
  }
  if (schema.type !== 'object') {
    out.push(
      err(
        schema.type === undefined ? base : [...base, 'type'],
        schema.type === undefined
          ? 'params must be an object schema: add "type: object" (and its "properties")'
          : `params must be an object schema (type: object), got type ${describeValue(schema.type)}`,
      ),
    );
  }
  checkNode(schema, base, out);
  return out;
}

function checkNode(node: unknown, path: Path, out: LocatedIssue[]): void {
  if (!isPlainObject(node)) {
    out.push(err(path, `expected a schema mapping (e.g. {type: number, default: 1}), got ${describeValue(node)}`));
    return;
  }
  const before = out.length;
  for (const key of Object.keys(node)) {
    if (KNOWN.includes(key)) continue;
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      out.push(err(path, `"${key}" is not supported in component params (keep params flat; supported: ${SUPPORTED_KEYWORDS.join(', ')})`, { path: [...path, key], key: true }));
      continue;
    }
    const s = didYouMean(key, KNOWN);
    out.push(err(path, `unknown schema keyword "${key}"${s ? ` (did you mean "${s}"?)` : ''}`, { path: [...path, key], key: true }));
  }

  if (node.type !== undefined) {
    const list = Array.isArray(node.type) ? node.type : [node.type];
    if (list.length === 0) out.push(err([...path, 'type'], 'type must not be an empty list'));
    for (const t of list) {
      if (typeof t !== 'string' || !(PARAM_TYPES as readonly string[]).includes(t)) {
        const s = typeof t === 'string' ? didYouMean(t, PARAM_TYPES) : undefined;
        out.push(err([...path, 'type'], `unknown type ${describeValue(t)}${s ? ` (did you mean "${s}"?)` : ''}; use one of ${PARAM_TYPES.join(', ')}`));
      }
    }
    if (new Set(list).size !== list.length) out.push(err([...path, 'type'], 'type lists a type twice'));
  }

  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      out.push(err([...path, 'properties'], `expected a mapping of param name → schema, got ${describeValue(node.properties)}`));
    } else {
      for (const [name, sub] of Object.entries(node.properties)) checkNode(sub, [...path, 'properties', name], out);
    }
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== 'string')) {
      out.push(err([...path, 'required'], 'required must be a list of property names'));
    } else {
      const props = isPlainObject(node.properties) ? Object.keys(node.properties) : [];
      node.required.forEach((r: string, i: number) => {
        if (!props.includes(r)) {
          const s = didYouMean(r, props);
          out.push(err([...path, 'required', i], `required property "${r}" is not declared in properties${s ? ` (did you mean "${s}"?)` : ''}`));
        }
      });
    }
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
    checkNode(node.additionalProperties, [...path, 'additionalProperties'], out);
  }
  if (node.items !== undefined) checkNode(node.items, [...path, 'items'], out);
  for (const k of ['anyOf', 'oneOf'] as const) {
    if (node[k] === undefined) continue;
    const list = node[k];
    if (!Array.isArray(list) || list.length === 0) out.push(err([...path, k], `${k} must be a non-empty list of schemas`));
    else list.forEach((sub, i) => checkNode(sub, [...path, k, i], out));
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    out.push(err([...path, 'enum'], 'enum must be a non-empty list of values'));
  }
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (node[k] !== undefined && (typeof node[k] !== 'number' || !Number.isFinite(node[k]))) {
      out.push(err([...path, k], `${k} must be a number, got ${describeValue(node[k])}`));
    }
  }
  if (node.multipleOf !== undefined && !(typeof node.multipleOf === 'number' && node.multipleOf > 0)) {
    out.push(err([...path, 'multipleOf'], `multipleOf must be a number > 0, got ${describeValue(node.multipleOf)}`));
  }
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (node[k] !== undefined && !isNonNegInt(node[k])) out.push(err([...path, k], `${k} must be an integer ≥ 0, got ${describeValue(node[k])}`));
  }
  if (node.uniqueItems !== undefined && typeof node.uniqueItems !== 'boolean') {
    out.push(err([...path, 'uniqueItems'], 'uniqueItems must be true or false'));
  }
  if (node.pattern !== undefined) {
    if (typeof node.pattern !== 'string') out.push(err([...path, 'pattern'], 'pattern must be a regular expression string'));
    else {
      try {
        new RegExp(node.pattern, 'u');
      } catch (e) {
        out.push(err([...path, 'pattern'], `invalid regular expression: ${(e as Error).message}`));
      }
    }
  }
  if (typeof node.minimum === 'number' && typeof node.maximum === 'number' && node.minimum > node.maximum) {
    out.push(err([...path, 'minimum'], `minimum (${node.minimum}) is greater than maximum (${node.maximum})`));
  }
  // A default must satisfy its own schema (only when the schema itself is sound).
  if (out.length === before && node.default !== undefined) {
    for (const i of validateParamValue(node, node.default, [...path, 'default'])) {
      out.push({ ...i, message: `default does not match its schema: ${i.message}` });
    }
  }
}

function typeLabel(t: string): string {
  switch (t) {
    case 'object':
      return 'a mapping';
    case 'array':
      return 'a list';
    case 'integer':
      return 'an integer';
    case 'boolean':
      return 'true or false';
    case 'null':
      return 'null';
    default:
      return `a ${t}`;
  }
}

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return false;
  }
}

/** JSON with plain objects' keys in locale order (`localeCompare`): what const / enum / uniqueItems compare, and the text a message quotes. */
function localeSortedJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (isPlainObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
}

function fmt(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : localeSortedJson(v);
}

/**
 * Validate a value against a (checked) params schema. Issue paths start at `path`; "missing"/"unknown key" issues
 * point at the object, with the key in the message (and a did-you-mean for typos).
 */
export function validateParamValue(schema: JsonSchemaNode, value: unknown, path: Path = ['params']): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  validateInto(schema, value, path, out);
  return out;
}

function validateInto(node: JsonSchemaNode, v: unknown, path: Path, out: LocatedIssue[]): void {
  const types = typesOf(node);
  if (types && !types.some((t) => matchesType(t, v))) {
    out.push(err(path, `expected ${types.map(typeLabel).join(' or ')}, got ${describeValue(v)}`));
    return;
  }
  if (node.const !== undefined && localeSortedJson(node.const) !== localeSortedJson(v)) {
    out.push(err(path, `expected ${fmt(node.const)}, got ${describeValue(v)}`));
    return;
  }
  if (Array.isArray(node.enum) && !node.enum.some((e) => localeSortedJson(e) === localeSortedJson(v))) {
    const strings = node.enum.filter((e): e is string => typeof e === 'string');
    const s = typeof v === 'string' ? didYouMean(v, strings) : undefined;
    const expected = node.enum.length === 1 ? fmt(node.enum[0]) : `one of ${node.enum.map(fmt).join(', ')}`;
    out.push(err(path, `expected ${expected}, got ${describeValue(v)}${s ? ` (did you mean "${s}"?)` : ''}`));
    return;
  }
  if (typeof v === 'number') {
    if (typeof node.minimum === 'number' && v < node.minimum) out.push(err(path, `must be ≥ ${node.minimum}, got ${v}`));
    if (typeof node.maximum === 'number' && v > node.maximum) out.push(err(path, `must be ≤ ${node.maximum}, got ${v}`));
    if (typeof node.exclusiveMinimum === 'number' && v <= node.exclusiveMinimum) out.push(err(path, `must be > ${node.exclusiveMinimum}, got ${v}`));
    if (typeof node.exclusiveMaximum === 'number' && v >= node.exclusiveMaximum) out.push(err(path, `must be < ${node.exclusiveMaximum}, got ${v}`));
    if (typeof node.multipleOf === 'number' && node.multipleOf > 0) {
      const q = v / node.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) out.push(err(path, `must be a multiple of ${node.multipleOf}, got ${v}`));
    }
  }
  if (typeof v === 'string') {
    const len = [...v].length;
    if (typeof node.minLength === 'number' && len < node.minLength) {
      out.push(err(path, node.minLength === 1 ? 'must not be empty' : `must be at least ${node.minLength} characters long`));
    }
    if (typeof node.maxLength === 'number' && len > node.maxLength) out.push(err(path, `must be at most ${node.maxLength} characters long`));
    if (typeof node.pattern === 'string') {
      let re: RegExp | undefined;
      try {
        re = new RegExp(node.pattern, 'u');
      } catch {
        re = undefined;
      }
      if (re && !re.test(v)) out.push(err(path, `must match /${node.pattern}/, got ${describeValue(v)}`));
    }
  }
  if (Array.isArray(v)) {
    if (typeof node.minItems === 'number' && v.length < node.minItems) {
      out.push(err(path, `must contain at least ${node.minItems} item${node.minItems === 1 ? '' : 's'}`));
    }
    if (typeof node.maxItems === 'number' && v.length > node.maxItems) {
      out.push(err(path, `must contain at most ${node.maxItems} item${node.maxItems === 1 ? '' : 's'}`));
    }
    if (node.uniqueItems === true && new Set(v.map(localeSortedJson)).size !== v.length) out.push(err(path, 'items must be unique'));
    if (isPlainObject(node.items)) v.forEach((item, i) => validateInto(node.items as JsonSchemaNode, item, [...path, i], out));
  }
  if (isPlainObject(v) && (types?.includes('object') || node.properties !== undefined)) {
    const props = isPlainObject(node.properties) ? (node.properties as Record<string, JsonSchemaNode>) : {};
    const required = Array.isArray(node.required) ? (node.required as string[]) : [];
    for (const r of required) {
      if (v[r] === undefined) out.push(err(path, `missing required key "${r}"`));
    }
    for (const [k, item] of Object.entries(v)) {
      if (item === undefined) continue;
      const sub = props[k];
      if (sub) {
        validateInto(sub, item, [...path, k], out);
      } else if (isPlainObject(node.additionalProperties)) {
        validateInto(node.additionalProperties as JsonSchemaNode, item, [...path, k], out);
      } else if (node.additionalProperties !== true) {
        // Every declared key is a candidate: defaults may already fill the one the typo meant.
        const known = Object.keys(props);
        const s = didYouMean(k, known);
        const hint = s ? ` (did you mean "${s}"?)` : known.length ? ` (known: ${known.join(', ')})` : ' (this component takes no params)';
        out.push(err(path, `unknown key "${k}"${hint}`, { path: [...path, k], key: true }));
      }
    }
  }
  for (const k of ['anyOf', 'oneOf'] as const) {
    const branches = node[k];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const results = branches.map((b) => (isPlainObject(b) ? validateParamValue(b, v, path) : [err(path, 'invalid schema')]));
    const ok = results.filter((r) => r.length === 0).length;
    if (k === 'anyOf' && ok === 0) out.push(...bestBranch(results, path, v));
    if (k === 'oneOf' && ok === 0) out.push(...bestBranch(results, path, v));
    if (k === 'oneOf' && ok > 1) out.push(err(path, `matches ${ok} of the oneOf alternatives (exactly one expected)`));
  }
}

function bestBranch(results: LocatedIssue[][], path: Path, v: unknown): LocatedIssue[] {
  // Branches failing only on the value's type are summarised; otherwise report the closest branch.
  const deep = results.filter((r) => !(r.length === 1 && r[0].message.startsWith('expected ') && r[0].path.length === path.length));
  if (deep.length === 0) {
    const expected = results.map((r) => r[0].message.replace(/^expected (.*), got .*$/, '$1'));
    return [err(path, `expected ${[...new Set(expected)].join(' or ')}, got ${describeValue(v)}`)];
  }
  return deep.reduce((a, b) => (b.length < a.length ? b : a));
}

/**
 * Defaults merged UNDER the given params (pure; the input is not modified): a property absent from `value` takes
 * its schema `default`; nested object properties are filled the same way (an absent object property without its own
 * default is created when its properties have defaults).
 */
export function applyParamDefaults(schema: JsonSchemaNode | undefined, value: Record<string, unknown> = {}): Record<string, unknown> {
  const out = fill(schema, value);
  return isPlainObject(out) ? out : {};
}

function fill(node: JsonSchemaNode | undefined, value: unknown): unknown {
  if (!node || !isPlainObject(node.properties)) return value === undefined ? undefined : structuredClone(value);
  if (value !== undefined && !isPlainObject(value)) return structuredClone(value);
  const out: Record<string, unknown> = value === undefined ? {} : structuredClone(value);
  let filled = false;
  for (const [k, sub] of Object.entries(node.properties as Record<string, JsonSchemaNode>)) {
    if (!isPlainObject(sub)) continue;
    if (out[k] === undefined) {
      if (sub.default !== undefined) {
        out[k] = structuredClone(sub.default);
        filled = true;
      } else if (isPlainObject(sub.properties)) {
        const nested = fill(sub, undefined) as Record<string, unknown> | undefined;
        if (nested && Object.keys(nested).length > 0) {
          out[k] = nested;
          filled = true;
        }
      }
    } else if (isPlainObject(out[k]) && isPlainObject(sub.properties)) {
      out[k] = fill(sub, out[k]);
    }
  }
  if (value === undefined && !filled) return undefined;
  return out;
}

/** The defaults of a params schema alone (what a component gets when nobody passes params). */
export function paramDefaults(schema: JsonSchemaNode | undefined): Record<string, unknown> {
  return applyParamDefaults(schema, {});
}

/** JSON Schema (draft 2020-12) describing the supported params-schema subset, for editor autocompletion. */
export function paramSchemaJsonSchema(ref = '#/$defs/ParamSchema'): JsonSchemaNode {
  const typeName = { type: 'string', enum: [...PARAM_TYPES] };
  const nonNegInt = { type: 'integer', minimum: 0 };
  return {
    type: 'object',
    description: 'A JSON Schema (supported subset) of a param or of a nested value.',
    properties: {
      type: { anyOf: [typeName, { type: 'array', items: typeName, minItems: 1 }] },
      properties: { type: 'object', additionalProperties: { $ref: ref } },
      required: { type: 'array', items: { type: 'string' } },
      additionalProperties: { anyOf: [{ type: 'boolean' }, { $ref: ref }], description: 'Objects are closed unless this is set.' },
      default: { description: 'Value used when the param is not given (must match this schema).' },
      enum: { type: 'array', minItems: 1 },
      const: {},
      minimum: { type: 'number' },
      maximum: { type: 'number' },
      exclusiveMinimum: { type: 'number' },
      exclusiveMaximum: { type: 'number' },
      multipleOf: { type: 'number', exclusiveMinimum: 0 },
      minLength: nonNegInt,
      maxLength: nonNegInt,
      pattern: { type: 'string', format: 'regex' },
      items: { $ref: ref },
      minItems: nonNegInt,
      maxItems: nonNegInt,
      uniqueItems: { type: 'boolean' },
      anyOf: { type: 'array', items: { $ref: ref }, minItems: 1 },
      oneOf: { type: 'array', items: { $ref: ref }, minItems: 1 },
      $schema: { type: 'string' },
      $id: { type: 'string' },
      $comment: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      examples: { type: 'array' },
      deprecated: { type: 'boolean' },
      readOnly: { type: 'boolean' },
      writeOnly: { type: 'boolean' },
      format: { type: 'string' },
    },
    additionalProperties: false,
  };
}
