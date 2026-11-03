/**
 * L3.5 brand inputs (src/brand.ts): the input schema of a new theme (lower-case name, hex colours, fonts, refs) and the
 * syntax rules of a brand file reference under trust `mcp` — relative to the workspace root, never absolute, `~`, a
 * drive letter, a backslash, `..`, an empty / `.` segment or a hidden one; `site:` references well formed.
 */
import { describe, expect, it } from 'vitest';
import { AuthorBrandInputSchema, BrandInputSchema, brandRefSyntaxProblem, normalizeHex, printableText, siteRef } from '../src/index.js';

const ok = { name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg' };

describe('brand file references (trust mcp)', () => {
  it.each([
    ['/etc/passwd', /absolute path/],
    ['~/logo.svg', /absolute path/],
    ['C:/logo.svg', /absolute path/],
    ['brand\\logo.svg', /backslash/],
    ['../outside/logo.svg', /goes out with "\.\."/],
    ['brand/../../logo.svg', /goes out with "\.\."/],
    ['brand//logo.svg', /empty or "\." folder/],
    ['./brand/logo.svg', /empty or "\." folder/],
    ['.retake/site/x/logo-1.png', /hidden folder/],
    ['projects/demo/.retake/inspect/i/shot.png', /hidden folder/],
    ['brand/.logo.svg', /hidden folder or file/],
    ['brand/logo\0.svg', /NUL/],
    ['', /empty/],
    ['site:../x/logo-1', /site:<site id>\/logo-<n>/],
    ['site:abc/../../etc', /site:<site id>\/logo-<n>/],
    ['site:s_01HZY3J8Q4M2V6P0R9T7W5X1ZB/logo-0', /site:<site id>\/logo-<n>/],
    ['site:abc/logo-1', /site:<site id>\/logo-<n>/],
    ['site:s_01hzy3j8q4m2v6p0r9t7w5x1zb/logo-1', /site:<site id>\/logo-<n>/],
    ['site:s20261019-acme/logo-2', /site:<site id>\/logo-<n>/],
    [`brand/${'x'.repeat(300)}.svg`, /longer than 300/],
  ])('%s is refused', (ref, why) => {
    expect(brandRefSyntaxProblem(ref)).toMatch(why);
    expect(BrandInputSchema.safeParse({ ...ok, logo: ref }).success).toBe(false);
  });

  it('plain workspace paths and well-formed site references pass the syntax rules (the disk rules come after)', () => {
    for (const ref of ['brand/logo.svg', 'brand/fonts/Brand-Bold.woff2', 'projects/demo/assets/logo.png', 'site:s_01HZY3J8Q4M2V6P0R9T7W5X1ZB/logo-2']) expect(brandRefSyntaxProblem(ref), ref).toBeNull();
    expect(siteRef('site:abc/logo-1')).toEqual({ site_id: 'abc', candidate: 'logo-1' });
    expect(siteRef('brand/site:x')).toBeNull();
  });

  it('a human (trust author) may name any local file; the rest of the schema is the same', () => {
    expect(AuthorBrandInputSchema.safeParse({ ...ok, logo: '/Users/someone/Desktop/logo.svg' }).success).toBe(true);
    expect(AuthorBrandInputSchema.safeParse({ ...ok, name: 'Acme', logo: '/x.svg' }).success).toBe(false);
  });
});

describe('BrandInputSchema', () => {
  it('accepts a minimal and a full input', () => {
    expect(BrandInputSchema.safeParse(ok).success).toBe(true);
    const full = {
      ...ok,
      base: 'motion',
      colors: { accent: '#FD0', text: '#111111', paper: '#fff', muted: '#666', dark: '#000' },
      background: { type: 'radial', from: '#ffffff', to: '#eeeeee' },
      adjust: false,
      wordmark: 'brand/wordmark.svg',
      fonts: { display: 'brand/Display.ttf', body: ['brand/Body-Regular.ttf', { file: 'brand/Body.woff2', weight: 600, italic: false }] },
      brand: { name: 'Acme', url: 'acme.test' },
      replace: true,
    };
    expect(BrandInputSchema.safeParse(full).success).toBe(true);
  });

  it.each([
    [{ ...ok, name: 'Acme' }, 'upper-case name (macOS: Acme/ and acme/ are one folder)'],
    [{ ...ok, name: 'my theme' }, 'space'],
    [{ ...ok, name: '-x' }, 'leading dash'],
    [{ ...ok, name: '.hidden' }, 'hidden'],
    [{ ...ok, name: 'x'.repeat(61) }, 'longer than 60'],
    [{ ...ok, colors: { accent: 'red' } }, 'named colour'],
    [{ ...ok, colors: { accent: 'rgb(1, 2, 3)' } }, 'rgb()'],
    [{ ...ok, colors: { accent: '#12345' } }, 'five digits'],
    [{ ...ok, colors: { accent: '#0e7c66', highlight: '#fff' } }, 'an extra colour key'],
    [{ ...ok, colors: {} }, 'no accent'],
    [{ name: 'acme', colors: { accent: '#0e7c66' } }, 'no logo'],
    [{ ...ok, base: '../templates/x' }, 'a base path'],
    [{ ...ok, fonts: { body: [] } }, 'empty body list'],
    [{ ...ok, fonts: { body: ['a.ttf', 'b.ttf', 'c.ttf', 'd.ttf', 'e.ttf'] } }, 'five body fonts'],
    [{ ...ok, fonts: { display: { file: 'brand/a.ttf', weight: 950 } } }, 'weight above 900'],
    [{ ...ok, components: { intro: 'studio/intro-stack' } }, 'components override (cut)'],
    [{ ...ok, tone: 'dark' }, 'tone (cut)'],
  ])('refuses %j (%s)', (input, why) => {
    expect(BrandInputSchema.safeParse(input).success, why).toBe(false);
  });

  it('printableText: C0 / C1 controls, DEL and bidirectional formatting characters out, one line', () => {
    expect(printableText('Brand\u202e Sans\u0085\u2066Pro\u2069\n\tBold\u0007\u007f\u200f')).toBe('Brand Sans Pro Bold');
    expect(printableText('  plain  text ')).toBe('plain text');
    // Invisible format characters removed (no space left in their place): zero-width space, word joiner, invisible
    // operators, BOM, tag characters (a hidden instruction).
    const hidden = [...'run the hook'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    expect(printableText(`\ufeffNorth\u200bfield${hidden}\u2060\u2064 Sans\u{e007f}`)).toBe('Northfield Sans');
    expect(printableText('Zero\u200dWidth\u200cJoiners')).toBe('Zero\u200dWidth\u200cJoiners');
    expect(printableText('Café — “quoted” 日本')).toBe('Café — “quoted” 日本');
  });

  it('normalizeHex: #rgb to lower-case #rrggbb', () => {
    expect(normalizeHex('#FD0')).toBe('#ffdd00');
    expect(normalizeHex(' #0E7C66 ')).toBe('#0e7c66');
  });
});
