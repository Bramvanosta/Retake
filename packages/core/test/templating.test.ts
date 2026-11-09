import { afterEach, describe, expect, it } from 'vitest';
import { TemplateError, collectSecretRefs, interpolate, interpolateAt, interpolateDeep, listTemplateTokens, redact, secretForms, resolveEnvironment, resolvePageUrl } from '@retake/core';
import { resolveSecretRef } from '@retake/core/io';
import type { TemplateContext } from '@retake/core';
import { fakeProject } from './helpers.js';

const ctx: TemplateContext = {
  pages: { console: 'https://console.staging.example.com', shop: 'https://shop.staging.example.com' },
  vars: { product: 'finca-lirandel-geisha', nested: { id: 42 } },
  hooks: { quote: { status: 201, json: { id: 'q-7' } } },
  run: { id: '20261011-142233-catalogue' },
};

describe('interpolate', () => {
  afterEach(() => {
    delete process.env.RETAKE_TEST_TOKEN;
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
    process.env.RETAKE_TEST_TOKEN = 's3cret';
    const used = new Set<string>();
    expect(interpolate('Bearer {{env:RETAKE_TEST_TOKEN}}', { ...ctx, usedSecrets: used })).toBe('Bearer s3cret');
    expect([...used]).toEqual(['s3cret']);
    expect(redact('token=s3cret', used)).toBe('token=***');
    expect(() => interpolate('{{env:RETAKE_UNSET_VAR}}', ctx)).toThrow(/RETAKE_UNSET_VAR is not set/);
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

  it('interpolateAt names the string a TemplateError comes from and leaves skipped nodes as written', () => {
    const value = { steps: [{ type: { text: '{{vars.nope}}' } }] };
    expect(() => interpolateAt(value, ctx, ['scenes', 1])).toThrow(/^scenes\[1\]\.steps\[0\]\.type\.text: unknown template key \{\{vars\.nope\}\}; available: /);
    const skipped = interpolateAt({ a: '{{vars.product}}', note: '{{nope}}' }, ctx, [], (path) => path[path.length - 1] === 'note');
    expect(skipped).toEqual({ a: 'finca-lirandel-geisha', note: '{{nope}}' });
  });

  it('collectSecretRefs skips notes (never templated)', () => {
    const refs = collectSecretRefs({ steps: [{ type: '{{env:A}}', note: 'uses {{env:B}}' }], open: '/?k={{secret:keychain:s/a}}' });
    expect([...refs]).toEqual(['env:A', 'keychain:s/a']);
  });

  it('secretForms: as is, URL-encoded (component, + for spaces, URI), JSON- and HTML-escaped; none under 3 chars (R-RUN-17)', () => {
    expect(secretForms('p@ss wörd"/<x>&')).toEqual([
      'p@ss wörd"/<x>&',
      'p@ss wörd\\"/<x>&',
      'p%40ss%20w%C3%B6rd%22%2F%3Cx%3E%26',
      'p%40ss+w%C3%B6rd%22%2F%3Cx%3E%26',
      'p@ss%20w%C3%B6rd%22/%3Cx%3E&',
      'p@ss wörd"/&lt;x&gt;&amp;',
      'p@ss wörd&quot;/&lt;x&gt;&amp;',
    ]);
    expect(secretForms('S3cret-pw-42')).toEqual(['S3cret-pw-42']);
    expect(secretForms('ab')).toEqual([]);
  });

  it('secretForms: as Chrome writes a URL path and query, and as a GET form submits it (L1.2 review: S6)', () => {
    // Measured in Chromium: the path encodes `^ | { } \`` and spaces, keeps `'`; the query encodes `'` and spaces, keeps
    // `{ | ^ \``; a GET form encodes everything but `*-._` and writes spaces as `+`.
    const forms = secretForms("it's x|y^`{ ü!~");
    expect(forms).toContain("it's%20x%7Cy%5E%60%7B%20%C3%BC!~"); // path (Chrome)
    expect(forms).toContain('it%27s%20x|y^`{%20%C3%BC!~'); // query
    expect(forms).toContain('it%27s+x%7Cy%5E%60%7B+%C3%BC%21%7E'); // GET form
    expect(redact("GET /q?k=it%27s+x%7Cy%5E%60%7B+%C3%BC%21%7E&p=it's%20x%7Cy%5E%60%7B%20%C3%BC!~", forms)).toBe('GET /q?k=***&p=***');
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

describe('resolveSecretRef', () => {
  it('a keychain item that cannot be read fails with one line naming the item and the reason', async () => {
    // Reads only (an item that does not exist): macOS `security`, Linux `secret-tool` (or its absence).
    const err = await resolveSecretRef('keychain:retake-test-missing/none').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(TemplateError);
    expect(err!.message).toMatch(/^keychain item retake-test-missing\/none not found \([^()\n]+\)$/);
    if (process.platform === 'darwin') expect(err!.message).toContain('could not be found in the keychain');
  });
});
