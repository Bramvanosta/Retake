import { afterEach, describe, expect, it } from 'vitest';
import {
  TemplateError,
  interpolate,
  interpolateDeep,
  listTemplateTokens,
  redact,
  resolveEnvironment,
  resolvePageUrl,
} from '@demo-studio/core';
import type { TemplateContext } from '@demo-studio/core';
import { fakeProject } from './helpers.js';

const ctx: TemplateContext = {
  pages: { console: 'https://console.staging.example.com', shop: 'https://shop.staging.example.com' },
  vars: { product: 'finca-lirandel-geisha', nested: { id: 42 } },
  hooks: { quote: { status: 201, json: { id: 'q-7' } } },
  run: { id: '20261011-142233-catalogue' },
};

describe('interpolate', () => {
  afterEach(() => {
    delete process.env.DEMO_STUDIO_TEST_TOKEN;
  });

  it('pages, vars (prefixed and bare), hooks and run', () => {
    expect(interpolate('{{console}}/api/products/{{vars.product}}', ctx)).toBe(
      'https://console.staging.example.com/api/products/finca-lirandel-geisha',
    );
    expect(interpolate('{{ product }}', ctx)).toBe('finca-lirandel-geisha');
    expect(interpolate('{{vars.nested.id}}', ctx)).toBe('42');
    expect(interpolate('{{hooks.quote.json.id}} {{run.id}}', ctx)).toBe('q-7 20261011-142233-catalogue');
    expect(interpolate('{{vars.nested}}', ctx)).toBe('{"id":42}');
  });

  it('env: references', () => {
    process.env.DEMO_STUDIO_TEST_TOKEN = 's3cret';
    const used = new Set<string>();
    expect(interpolate('Bearer {{env:DEMO_STUDIO_TEST_TOKEN}}', { ...ctx, usedSecrets: used })).toBe('Bearer s3cret');
    expect([...used]).toEqual(['s3cret']);
    expect(redact('token=s3cret', used)).toBe('token=***');
    expect(() => interpolate('{{env:DEMO_STUDIO_UNSET_VAR}}', ctx)).toThrow(/DEMO_STUDIO_UNSET_VAR is not set/);
  });

  it('unknown keys throw a TemplateError listing the available keys', () => {
    expect(() => interpolate('{{consle}}/x', ctx)).toThrow(TemplateError);
    expect(() => interpolate('{{consle}}/x', ctx)).toThrow(
      'unknown template key {{consle}}; available: console, shop, vars.product, vars.nested, hooks.quote, run.id, env:VAR, keychain:service/account',
    );
    expect(() => interpolate('{{toString}}', ctx)).toThrow(TemplateError);
    expect(() => interpolate('{{vars.constructor}}', ctx)).toThrow(TemplateError);
  });

  it('interpolateDeep walks objects and arrays', () => {
    expect(interpolateDeep({ url: '{{shop}}/q', headers: ['{{vars.product}}'], n: 3 }, ctx)).toEqual({
      url: 'https://shop.staging.example.com/q',
      headers: ['finca-lirandel-geisha'],
      n: 3,
    });
  });

  it('listTemplateTokens', () => {
    expect(listTemplateTokens('{{ console }}/x/{{vars.id}}{{env:A}}')).toEqual(['console', 'vars.id', 'env:A']);
  });
});

describe('environments & URLs', () => {
  it('resolveEnvironment picks explicit → default_env → first', () => {
    const p = fakeProject();
    expect(resolveEnvironment(p).name).toBe('staging');
    expect(resolveEnvironment(p, 'staging').pages.shop).toBe('https://shop.staging.example.com');
    expect(() => resolveEnvironment(p, 'prod')).toThrow('unknown environment "prod" (available: staging)');
    expect(() => resolveEnvironment(p, 'constructor')).toThrow(/unknown environment/);
  });

  it('resolvePageUrl keeps base path prefixes and absolute URLs', () => {
    expect(resolvePageUrl('https://x.example.com/app', '/imports')).toBe('https://x.example.com/app/imports');
    expect(resolvePageUrl('https://x.example.com/', 'imports?a=1')).toBe('https://x.example.com/imports?a=1');
    expect(resolvePageUrl('https://x.example.com', 'https://y.example.com/z')).toBe('https://y.example.com/z');
  });
});
