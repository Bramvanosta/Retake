/**
 * core brand-tokens.ts (R-FLD-47): a design-token file read — the list format and DTCG (nested groups, inherited
 * $type, aliases with a hop cap and cycles refused, srgb objects, translucent colours skipped) — font families, the
 * caps, and the proposed role of each theme colour: by name first, then by colour.
 */
import { describe, expect, it } from 'vitest';
import { ALIAS_MAX_HOPS, TOKENS_MAX, TOKENS_MAX_DEPTH, TokenFileError, contrast, nameRole, nearestNames, parseTokenFile, proposeRoles } from '@retake/core';
import type { TokenColour } from '@retake/core';

const j = (v: unknown) => JSON.stringify(v);
const colours = (list: Array<[string, string]>): TokenColour[] => list.map(([name, hex], index) => ({ index, name, hex }));

describe('parseTokenFile', () => {
  it('list format: colours by name, groups and top-level tokens, font families by name', () => {
    const t = parseTokenFile(
      j({
        tokens: [{ name: 'brand', value: '#0E7C66' }],
        neutral: { tokens: [{ name: 'paper', value: '#fff' }, { name: 'ink', value: '#111111' }, { name: 'font-family-body', value: 'Test Sans' }, { name: 'radius', value: '4px' }] },
      }),
    );
    expect(t.format).toBe('list');
    expect(t.colours).toEqual([
      { index: 0, name: 'brand', hex: '#0e7c66' },
      { index: 1, name: 'neutral.paper', hex: '#ffffff' },
      { index: 2, name: 'neutral.ink', hex: '#111111' },
    ]);
    expect(t.families).toEqual([{ index: 0, name: 'neutral.font-family-body', family: 'Test Sans' }]);
    expect(t.skipped.unsupported).toBe(1);
  });

  it('DTCG: nested groups, inherited $type, aliases resolved, srgb objects and #rrggbbaa', () => {
    const t = parseTokenFile(
      j({
        color: {
          $type: 'color',
          base: { green: { $value: '#0e7c66' }, white: { $value: { colorSpace: 'srgb', components: [1, 1, 1] } }, veil: { $value: '#00000080' }, solid: { $value: '#123456FF' } },
          brand: { primary: { $value: '{color.base.green}' } },
          text: { default: { $value: 'rgb(0, 0, 0)' } },
          missing: { $value: '{color.nowhere}' },
        },
        size: { $type: 'dimension', small: { $value: '4px' } },
        font: { body: { $type: 'fontFamily', $value: ['Test Sans', 'sans-serif'] }, heading: { $type: 'typography', $value: { fontFamily: 'Test Serif', fontSize: '32px' } } },
      }),
    );
    expect(t.format).toBe('dtcg');
    expect(t.colours.map((c) => [c.name, c.hex])).toEqual([
      ['color.base.green', '#0e7c66'],
      ['color.base.white', '#ffffff'],
      ['color.base.solid', '#123456'],
      ['color.brand.primary', '#0e7c66'],
    ]);
    expect(t.skipped).toEqual({ alpha: 1, unsupported: 1, unresolved: 1 });
    expect(t.families.map((f) => [f.name, f.family])).toEqual([
      ['font.body', 'Test Sans'],
      ['font.heading', 'Test Serif'],
    ]);
  });

  it('a cycle and a chain longer than the hop cap are refused (by index, never by name)', () => {
    expect(() => parseTokenFile(j({ a: { $value: '{b}' }, b: { $value: '{a}' } }))).toThrow(/token #0: an alias cycle/);
    const chain: Record<string, unknown> = { t0: { $value: '#ffffff' } };
    for (let i = 1; i <= ALIAS_MAX_HOPS + 1; i++) chain[`t${i}`] = { $value: `{t${i - 1}}` };
    expect(() => parseTokenFile(j(chain))).toThrow(/longer than 16 hops/);
    const ok: Record<string, unknown> = { t0: { $value: '#ffffff' } };
    for (let i = 1; i <= ALIAS_MAX_HOPS; i++) ok[`t${i}`] = { $value: `{t${i - 1}}` };
    expect(parseTokenFile(j(ok)).colours).toHaveLength(ALIAS_MAX_HOPS + 1);
  });

  it('a prototype key (__proto__) is a plain token name', () => {
    const t = parseTokenFile('{"__proto__": {"$value": "#ff0000"}, "constructor": {"prototype": {"$value": "#00ff00"}}}');
    expect(t.colours.map((c) => c.name)).toEqual(['__proto__', 'constructor.prototype']);
    expect(({} as Record<string, unknown>).$value).toBeUndefined();
  });

  it('caps: 1 MB, depth 64, 5 000 tokens; not JSON, not an object', () => {
    expect(() => parseTokenFile(' '.repeat(1024 * 1024 + 1))).toThrow(TokenFileError);
    let deep: unknown = { $value: '#ffffff' };
    for (let i = 0; i < TOKENS_MAX_DEPTH + 1; i++) deep = { g: deep };
    expect(() => parseTokenFile(j(deep))).toThrow(/nested more than 64/);
    // A list token's value nested deep: the file's own depth check, not the DTCG walk's.
    expect(() => parseTokenFile(j({ tokens: [{ name: 'a', value: deep }] }))).toThrow(/nested more than 64 levels/);
    const many = Object.fromEntries(Array.from({ length: TOKENS_MAX + 1 }, (_, i) => [`t${i}`, { $value: '#ffffff' }]));
    expect(() => parseTokenFile(j(many))).toThrow(/more than 5000 tokens/);
    expect(() => parseTokenFile(j({ tokens: Array.from({ length: TOKENS_MAX + 1 }, (_, i) => ({ name: `t${i}`, value: '#fff' })) }))).toThrow(/more than 5000/);
    expect(() => parseTokenFile('{')).toThrow(/not JSON/);
    expect(() => parseTokenFile('[]')).toThrow(/not a JSON object/);
  });
});

describe('proposeRoles', () => {
  it('names first: accent/primary/brand, background/surface, text/foreground, muted/secondary, dark/inverse', () => {
    const r = proposeRoles(
      colours([
        ['color.background.default', '#fafafa'],
        ['color.text.primary', '#1a1a1a'],
        ['color.text.secondary', '#5a5a5a'],
        ['color.brand.primary', '#0e7c66'],
        ['color.surface.inverse', '#101418'],
        ['color.background.subtle', '#eeeeee'],
      ]),
    );
    expect(r).toEqual({
      accent: { index: 3, hex: '#0e7c66', why: 'name' },
      paper: { index: 0, hex: '#fafafa', why: 'name' },
      text: { index: 1, hex: '#1a1a1a', why: 'name' },
      muted: { index: 2, hex: '#5a5a5a', why: 'name' },
      dark: { index: 4, hex: '#101418', why: 'colour' },
    });
    expect(nameRole('textSecondary')).toEqual({ role: 'muted', main: false });
    expect(nameRole('bg')).toEqual({ role: 'paper', main: true });
    expect(nameRole('foreground')).toEqual({ role: 'text', main: true });
    expect(nameRole('brand-background')).toEqual({ role: 'accent', main: false });
    expect(nameRole('night')).toEqual({ role: 'dark', main: true });
    expect(nameRole('color.inverse')).toEqual({ role: 'dark', main: true });
    expect(nameRole('spacing.large')).toBeNull();
  });

  it('a main token wins over the first of a role; the accent is taken before the paper (one token, one role)', () => {
    const r = proposeRoles(colours([['primary.light', '#9ad1c3'], ['primary', '#0e7c66'], ['paper', '#ffffff'], ['ink', '#000000']]));
    expect(r.accent).toMatchObject({ index: 1, why: 'name' });
    const both = proposeRoles(colours([['brand-background', '#0e7c66'], ['ink', '#111111']]));
    expect(both.accent).toMatchObject({ index: 0, why: 'name' });
    expect(both.paper?.index).not.toBe(0);
  });

  it('by colour when names say nothing: extreme neutral paper, highest-contrast text, saturated accent ≥ 3:1, darkest neutral', () => {
    const r = proposeRoles(
      colours([
        ['c1', '#f6f4ef'],
        ['c2', '#ffd400'],
        ['c3', '#0e7c66'],
        ['c4', '#222222'],
        ['c5', '#e8e6e1'],
        ['c6', '#0a0a0a'],
      ]),
    );
    expect(r.paper).toEqual({ index: 0, hex: '#f6f4ef', why: 'colour' });
    expect(r.text).toEqual({ index: 5, hex: '#0a0a0a', why: 'colour' });
    // #ffd400 is the most saturated colour but fails 3:1 on the paper: the accent is #0e7c66.
    expect(contrast('#ffd400', '#f6f4ef')).toBeLessThan(3);
    expect(r.accent).toEqual({ index: 2, hex: '#0e7c66', why: 'colour' });
    expect(r.dark).toEqual({ index: 3, hex: '#222222', why: 'colour' });
    expect(r.muted).toBeUndefined();
    const dark = proposeRoles(colours([['a', '#111418'], ['b', '#222831'], ['c', '#f0c419']]));
    expect(dark.paper?.hex).toBe('#111418');
    expect(dark.dark).toBeUndefined();
  });

  it('the nearest names share words first, then by edit distance', () => {
    expect(nearestNames('color.brand.primry', ['color.brand.primary', 'color.text.primary', 'spacing.s'], 2)).toEqual(['color.brand.primary', 'color.text.primary']);
  });

  it('a ramp: the step of the named role that reaches its contrast on the paper, not the first step', () => {
    const steps: Array<[string, string]> = [
      ['color.primary.50', '#eef6f3'],
      ['color.primary.100', '#d3ebe3'],
      ['color.primary.300', '#7cc4ad'],
      ['color.primary.500', '#0e7c66'],
      ['color.primary.900', '#063a30'],
      ['color.background', '#ffffff'],
    ];
    const r = proposeRoles(colours(steps));
    expect(r.paper).toMatchObject({ hex: '#ffffff', why: 'name' });
    expect(r.accent).toMatchObject({ hex: '#0e7c66', why: 'name' });
    expect(contrast(r.accent!.hex, '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('on-<role> names what is drawn on that role: on-primary is no accent, on-background (even first) is text, not the paper', () => {
    const r = proposeRoles(colours([['on-background', '#1b1b1b'], ['on-primary', '#ffffff'], ['background', '#fcfcfa'], ['primary', '#2b5fd9']]));
    expect(r.paper).toMatchObject({ index: 2, why: 'name' });
    expect(r.accent).toMatchObject({ index: 3, why: 'name' });
    expect(r.text).toMatchObject({ index: 0, why: 'name' });
    expect(nameRole('on-primary')).toBeNull();
    expect(nameRole('color.on-surface')).toEqual({ role: 'text', main: true });
  });

  it('a named accent below 3:1 on the paper gives way to the accent by colour, said in a note', () => {
    const notes: string[] = [];
    const r = proposeRoles(colours([['brand', '#f2e9a0'], ['paper', '#ffffff'], ['c3', '#b0306a']]), notes);
    expect(r.accent).toEqual({ index: 2, hex: '#b0306a', why: 'colour' });
    expect(notes.join('\n')).toMatch(/the accent the file names \(token #0\) is below 3:1 on the paper: token #2 is proposed by its colour instead/);
    const none: string[] = [];
    const only = proposeRoles(colours([['brand', '#f2e9a0'], ['paper', '#ffffff']]), none);
    expect(only.accent).toMatchObject({ index: 0, why: 'name' });
    expect(none.join('\n')).toMatch(/no other colour reaches it/);
  });
});

