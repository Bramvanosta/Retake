import { describe, expect, it } from 'vitest';
import { formatIssues } from '@retake/core';
import { applyParamDefaults, checkParamsSchema, paramDefaults, validateParamValue } from '@retake/components';
import type { JsonSchemaNode } from '@retake/components';

const SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    width: { type: 'integer', minimum: 800, maximum: 1920, default: 1560 },
    radius: { type: 'number', minimum: 0, default: 18 },
    shadow: { type: 'string', enum: ['none', 'soft', 'strong'], default: 'soft' },
    label: { type: 'string', maxLength: 12, pattern: '^[a-z ]+$' },
    tone: {
      anyOf: [
        { type: 'string', enum: ['dark', 'paper'] },
        { type: 'number', minimum: 0, maximum: 1 },
      ],
      default: 'dark',
    },
    chrome: {
      type: 'object',
      properties: { show: { type: 'boolean', default: true }, height: { type: 'number', default: 44 } },
    },
    stops: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 2, uniqueItems: true },
    meta: { type: 'object', additionalProperties: true },
  },
};

const msgs = (value: unknown, schema = SCHEMA) => formatIssues(validateParamValue(schema, value));

describe('params JSON Schema subset', () => {
  it('the test schema itself is valid', () => {
    expect(checkParamsSchema(SCHEMA)).toEqual([]);
  });

  it('merges defaults under the given params, nested objects included, without mutating the input', () => {
    const given = { width: 1200, chrome: { height: 50 } };
    const merged = applyParamDefaults(SCHEMA, given);
    expect(merged).toEqual({ width: 1200, radius: 18, shadow: 'soft', tone: 'dark', chrome: { show: true, height: 50 } });
    expect(given).toEqual({ width: 1200, chrome: { height: 50 } });
    expect(paramDefaults(SCHEMA)).toEqual({ width: 1560, radius: 18, shadow: 'soft', tone: 'dark', chrome: { show: true, height: 44 } });
    expect(paramDefaults(undefined)).toEqual({});
    // Defaults are copies.
    const a = paramDefaults({ type: 'object', properties: { list: { type: 'array', default: [1] } } });
    (a.list as number[]).push(2);
    expect(paramDefaults({ type: 'object', properties: { list: { type: 'array', default: [1] } } })).toEqual({ list: [1] });
  });

  it('validates values with precise messages', () => {
    expect(msgs(paramDefaults(SCHEMA))).toBe('');
    expect(msgs({ width: 2400 })).toBe('error params.width: must be ≤ 1920, got 2400');
    expect(msgs({ width: 1000.5 })).toBe('error params.width: expected an integer, got 1000.5');
    expect(msgs({ radius: '18' })).toBe('error params.radius: expected a number, got "18"');
    expect(msgs({ shadow: 'sfot' })).toBe('error params.shadow: expected one of "none", "soft", "strong", got "sfot" (did you mean "soft"?)');
    expect(msgs({ label: 'Way Too Long Label' })).toContain('params.label: must be at most 12 characters long');
    expect(msgs({ label: 'Caps' })).toBe('error params.label: must match /^[a-z ]+$/, got "Caps"');
    expect(msgs({ shadwo: 'soft' })).toBe('error params: unknown key "shadwo" (did you mean "shadow"?)');
    expect(msgs({ colour: 'x' })).toBe('error params: unknown key "colour" (known: width, radius, shadow, label, tone, chrome, stops, meta)');
    expect(msgs({ x: 1 }, { type: 'object' })).toBe('error params: unknown key "x" (this component takes no params)');
    expect(msgs({ chrome: { show: 'yes' } })).toBe('error params.chrome.show: expected true or false, got "yes"');
    expect(msgs({ chrome: { hieght: 1 } })).toBe('error params.chrome: unknown key "hieght" (did you mean "height"?)');
    expect(msgs({ meta: { anything: [1, 2] } })).toBe('');
    expect(msgs({ stops: [0.5] })).toBe('error params.stops: must contain at least 2 items');
    expect(msgs({ stops: [0.5, 0.5] })).toBe('error params.stops: items must be unique');
    expect(msgs({ stops: [0, 2] })).toBe('error params.stops[1]: must be ≤ 1, got 2');
    expect(msgs({ tone: 0.5 })).toBe('');
    expect(msgs({ tone: 'paper' })).toBe('');
    expect(msgs({ tone: true })).toBe('error params.tone: expected a string or a number, got true');
    expect(msgs({ tone: 3 })).toBe('error params.tone: must be ≤ 1, got 3');
    expect(msgs({}, { type: 'object', required: ['title'], properties: { title: { type: 'string' } } })).toBe('error params: missing required key "title"');
    expect(msgs({ a: 4 }, { type: 'object', properties: { a: { type: 'number', multipleOf: 3, exclusiveMaximum: 4 } } })).toBe(
      'error params.a: must be < 4, got 4\nerror params.a: must be a multiple of 3, got 4',
    );
    expect(msgs({ a: 'x' }, { type: 'object', properties: { a: { const: 'y' } } })).toBe('error params.a: expected "y", got "x"');
    expect(msgs({ a: 1 }, { type: 'object', properties: { a: { oneOf: [{ type: 'number' }, { type: 'integer' }] } } })).toBe(
      'error params.a: matches 2 of the oneOf alternatives (exactly one expected)',
    );
  });

  it('checks the schema itself', () => {
    expect(formatIssues(checkParamsSchema('nope'))).toBe('error params: expected a JSON Schema mapping (type: object, properties: …), got "nope"');
    expect(formatIssues(checkParamsSchema({ type: 'object', properties: { a: 'number' } }))).toBe(
      'error params.properties.a: expected a schema mapping (e.g. {type: number, default: 1}), got "number"',
    );
    expect(formatIssues(checkParamsSchema({ type: 'object', properties: { a: { type: ['string', 'string'] } } }))).toBe('error params.properties.a.type: type lists a type twice');
    expect(formatIssues(checkParamsSchema({ type: 'object', properties: { a: { enum: [] } } }))).toBe('error params.properties.a.enum: enum must be a non-empty list of values');
    expect(formatIssues(checkParamsSchema({ type: 'object', properties: { a: { type: 'string', minLength: -1 } } }))).toBe(
      'error params.properties.a.minLength: minLength must be an integer ≥ 0, got -1',
    );
    expect(formatIssues(checkParamsSchema({ type: 'object', allOf: [] }))).toMatch(/"allOf" is not supported in component params/);
    expect(formatIssues(checkParamsSchema({ type: 'object', title: 'P', description: 'd', $comment: 'c', properties: { a: { type: 'number', examples: [1], format: 'x' } } }))).toBe('');
  });
});
