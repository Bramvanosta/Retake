/**
 * core fontsource-ref.ts and its place in the brand inputs (R-FLD-45): the grammar of `fontsource:` references, and the
 * font slots that take them — a plain string only (the `{file, weight}` form names a file), never a path.
 */
import { describe, expect, it } from 'vitest';
import { AuthorBrandInputSchema, BrandInputSchema, BrandPatchSchema, brandRefSyntaxProblem, formatFontsourceRef, fontsourceRefProblem, isFontsourceRef, newerVersion, parseFontsourceRef } from '@retake/core';

describe('fontsource references', () => {
  it('fontsource refs: id, optional pinned version, weight and italic', () => {
    expect(parseFontsourceRef('fontsource:inter')).toEqual({ id: 'inter', weight: 400, italic: false });
    expect(parseFontsourceRef('fontsource:instrument-serif@5.2.1')).toEqual({ id: 'instrument-serif', version: '5.2.1', weight: 400, italic: false });
    expect(parseFontsourceRef('fontsource:test-sans@0.10.0:600italic')).toEqual({ id: 'test-sans', version: '0.10.0', weight: 600, italic: true });
    expect(parseFontsourceRef('fontsource:test-sans:900')).toEqual({ id: 'test-sans', weight: 900, italic: false });
    expect(formatFontsourceRef({ id: 'test-sans', weight: 400, italic: false })).toBe('fontsource:test-sans:400');
    expect(formatFontsourceRef({ id: 'test-sans', version: '5.2.1', weight: 700, italic: true })).toBe('fontsource:test-sans@5.2.1:700italic');
    expect(isFontsourceRef('fontsource:anything')).toBe(true);
    expect(isFontsourceRef('brand/fontsource:x.ttf')).toBe(false);
  });

  it('ranges, tags, paths, upper case, odd weights and long refs are refused', () => {
    for (const bad of [
      'fontsource:',
      'fontsource:Inter',
      'fontsource:-inter',
      'fontsource:inter@^5.2.1',
      'fontsource:inter@latest',
      'fontsource:inter@5.2',
      'fontsource:inter@5.2.1-beta.1',
      'fontsource:inter@05.2.1',
      'fontsource:inter:450',
      'fontsource:inter:1000',
      'fontsource:inter:italic',
      'fontsource:inter:400bold',
      'fontsource:../x',
      'fontsource:inter/x',
      'fontsource:inter@5.2.1:400:400',
      `fontsource:${'a'.repeat(65)}`,
      `fontsource:inter@1.2.3:400${' '.repeat(120)}`,
    ]) {
      expect(parseFontsourceRef(bad), bad).toBeNull();
      expect(fontsourceRefProblem(bad), bad).toMatch(/fontsource/);
    }
    expect(fontsourceRefProblem('fontsource:inter@5.2.1:600italic')).toBeNull();
  });

  it('a brand file reference starting with fontsource: is held to that grammar, never read as a path', () => {
    expect(brandRefSyntaxProblem('fontsource:test-sans@5.2.1:400')).toBeNull();
    expect(brandRefSyntaxProblem('fontsource:../../etc/passwd')).toMatch(/fontsource id/);
    expect(brandRefSyntaxProblem('fontsource:test-sans@latest')).toMatch(/exact version/);
  });

  it('font slots take a plain ref (create, update, the author form); the {file, weight} form refuses one', () => {
    const base = { name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg' };
    expect(BrandInputSchema.safeParse({ ...base, fonts: { display: 'fontsource:test-sans@5.2.1:700', body: ['fontsource:test-sans:400', 'brand/Body.ttf'] } }).success).toBe(true);
    expect(BrandPatchSchema.safeParse({ name: 'acme', fonts: { body: ['fontsource:test-sans:400italic'] } }).success).toBe(true);
    expect(BrandInputSchema.safeParse({ ...base, fonts: { display: 'fontsource:Test-Sans' } }).success).toBe(false);
    for (const schema of [BrandInputSchema, AuthorBrandInputSchema]) {
      const r = schema.safeParse({ ...base, fonts: { body: [{ file: 'fontsource:test-sans@5.2.1:400', weight: 400 }] } });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toMatch(/plain string/);
    }
  });

  it('versions compare by number, part by part', () => {
    expect(newerVersion('5.10.0', '5.9.9')).toBe(true);
    expect(newerVersion('5.2.1', '5.2.1')).toBe(false);
    expect(newerVersion('4.99.99', '5.0.0')).toBe(false);
  });
});
