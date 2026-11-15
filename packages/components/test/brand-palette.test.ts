/**
 * Themes from brand inputs — the deterministic palette (src/brand/palette.ts) and the generated template.yaml
 * (src/brand/template-file.ts): goldens for four accents in both tones, every threshold met after `adjust`, given
 * colours lifted and reported (never the accent: a suggestion instead), `adjust: false` warnings, the tone from a given
 * paper, and every starter as a base producing a template.yaml the template schema accepts with no issue.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTemplateYaml, parseYaml } from '@retake/core';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import type { TemplateFile } from '@retake/core';
import { PALETTE_THRESHOLDS, derivePalette, generateThemeFile } from '../src/index.js';
import { backgroundSample, contrastRatio } from '../src/kit/style.js';

const GOLDENS: Array<[string, 'light' | 'dark', Record<string, unknown>]> = [
  [
    '#0e7c66',
    'light',
    { accent: '#0e7c66', text: '#0b181a', muted: '#5f696a', paper: '#f5faf9', dark: '#0c2121', background: { type: 'radial', from: '#f9fcfb', to: '#e9f4f2' }, ripple: 'rgba(14, 124, 102, 0.45)' },
  ],
  [
    '#ffd400',
    'light',
    { accent: '#ffd400', text: '#232110', muted: '#727062', paper: '#fffdf5', dark: '#37310f', background: { type: 'radial', from: '#fffef9', to: '#fffbe9' }, ripple: 'rgba(255, 212, 0, 0.45)' },
  ],
  [
    '#8a2332',
    'light',
    { accent: '#8a2332', text: '#180f15', muted: '#696266', paper: '#faf6f7', dark: '#221118', background: { type: 'radial', from: '#fcfafa', to: '#f4ebed' }, ripple: 'rgba(138, 35, 50, 0.45)' },
  ],
  [
    '#3352b8',
    'light',
    { accent: '#3352b8', text: '#0f1423', muted: '#636671', paper: '#f7f8fc', dark: '#121930', background: { type: 'radial', from: '#fafbfd', to: '#edf0f9' }, ripple: 'rgba(51, 82, 184, 0.45)' },
  ],
  [
    '#0e7c66',
    'dark',
    { accent: '#0e7c66', text: '#e9f1f2', muted: '#959fa0', paper: '#0b181a', dark: '#071011', background: { type: 'linear', from: '#070e10', to: '#1e2f2f' }, ripple: 'rgba(14, 124, 102, 0.45)' },
  ],
  [
    '#ffd400',
    'dark',
    { accent: '#ffd400', text: '#f7f6ec', muted: '#a6a598', paper: '#232110', dark: '#17150a', background: { type: 'linear', from: '#15140a', to: '#413d21' }, ripple: 'rgba(255, 212, 0, 0.45)' },
  ],
  [
    '#8a2332',
    'dark',
    { accent: '#8a2332', text: '#f0ebef', muted: '#9e979c', paper: '#180f15', dark: '#100a0e', background: { type: 'linear', from: '#0e090d', to: '#302229' }, ripple: 'rgba(138, 35, 50, 0.45)' },
  ],
  [
    '#3352b8',
    'dark',
    { accent: '#3352b8', text: '#ebeef7', muted: '#979ba6', paper: '#0f1423', dark: '#0a0d17', background: { type: 'linear', from: '#090c15', to: '#232a3d' }, ripple: 'rgba(51, 82, 184, 0.45)' },
  ],
];

const ratio = (a: string, b: string) => contrastRatio(a, b)!;

describe('derivePalette', () => {
  it.each(GOLDENS)('golden: accent %s, %s tone', (accent, tone, want) => {
    const p = derivePalette({ accent, tone });
    expect({ ...p.colors, background: p.background, ripple: p.ripple_color }).toEqual(want);
    expect(p.tone).toBe(tone);
    // Derived colours meet every threshold without any adjustment.
    expect(p.adjusted).toEqual([]);
    for (const c of p.checks.filter((x) => !x.check.startsWith('accent'))) expect(c.ok, c.check).toBe(true);
    // Deterministic: the same input gives the same bytes.
    expect(JSON.stringify(derivePalette({ accent, tone }))).toBe(JSON.stringify(p));
  });

  it('a given text that misses a threshold is lifted and reported; every threshold is met after adjust', () => {
    const p = derivePalette({ accent: '#0e7c66', paper: '#f4f1ea', text: '#7a7a7a', muted: '#c8c4bb', dark: '#555555' });
    const keys = p.adjusted.map((a) => `${a.key}:${a.check}`);
    expect(keys).toEqual(expect.arrayContaining(['text:text_on_paper', 'muted:muted_on_paper', 'dark:light_on_dark']));
    for (const a of p.adjusted) {
      expect(a.given).toBe(true);
      expect(a.ratio_after).toBeGreaterThanOrEqual(PALETTE_THRESHOLDS[a.check]);
      expect(a.ratio_before).toBeLessThan(PALETTE_THRESHOLDS[a.check]);
    }
    const { text, muted, paper, dark } = p.colors;
    expect(ratio(text, paper)).toBeGreaterThanOrEqual(7);
    expect(ratio(text, backgroundSample({ background: p.background, colors: { ...p.colors } }))).toBeGreaterThanOrEqual(7);
    expect(ratio(muted, paper)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(paper, dark)).toBeGreaterThanOrEqual(7);
    expect(p.warnings).toEqual([]);
    expect(p.given).toEqual(['accent', 'text', 'paper', 'muted', 'dark']);
  });

  it('the accent is never changed: a light accent gets a warning and a suggestion that passes', () => {
    const p = derivePalette({ accent: '#FD0', paper: '#ffffff' });
    expect(p.colors.accent).toBe('#ffdd00');
    expect(p.adjusted.map((a) => a.key)).not.toContain('accent');
    expect(p.checks.find((c) => c.check === 'accent_on_paper')).toMatchObject({ ok: false, min: 3 });
    expect(p.suggestions.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(ratio(p.suggestions.accent!, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(p.warnings.join('\n')).toMatch(/accent #ffdd00 reads at 1\.\d+:1 .*kept as given; #[0-9a-f]{6} would pass/);
  });

  it('adjust: false keeps every colour and warns instead', () => {
    const p = derivePalette({ accent: '#0e7c66', paper: '#f4f1ea', text: '#7a7a7a', adjust: false });
    expect(p.colors.text).toBe('#7a7a7a');
    expect(p.adjusted).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/the text #7a7a7a on the paper #f4f1ea reads at .* \(needs 7:1\) \(adjust is off\)/);
  });

  it('a dark paper makes a dark theme whatever the base tone; a background given is kept', () => {
    const p = derivePalette({ accent: '#ff5c38', paper: '#11131c', tone: 'light', background: { type: 'linear', from: '#0a0b11', to: '#1c2030' } });
    expect(p.tone).toBe('dark');
    expect(p.background).toEqual({ type: 'linear', from: '#0a0b11', to: '#1c2030' });
    expect(ratio(p.colors.text, p.colors.paper)).toBeGreaterThanOrEqual(7);
    expect(derivePalette({ accent: '#ff5c38', background: '#ABC' }).background).toEqual({ type: 'solid', color: '#aabbcc' });
  });
});

describe('generateThemeFile', () => {
  const starters = readdirSync(STARTER_TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);

  it('has the three starters to test against', () => {
    expect(starters.sort()).toEqual(['default', 'editorial', 'motion']);
  });

  it.each(['default', 'editorial', 'motion'])('over the %s starter: a template.yaml the schema accepts with no issue, the base kept, the brand put in', (baseName) => {
    const text = readFileSync(join(STARTER_TEMPLATES_DIR, baseName, 'template.yaml'), 'utf8');
    const base = parseYaml(text).value as TemplateFile;
    const palette = derivePalette({ accent: '#0e7c66', tone: baseName === 'motion' ? 'dark' : 'light' });
    const g = generateThemeFile({
      base,
      baseName,
      name: 'acme',
      palette,
      logo: 'logo.png',
      fonts: { display: 'fonts/display-Bold.ttf', body: ['fonts/body-Regular.ttf', 'fonts/body-SemiBold.ttf'] },
      brand: { name: 'Acme', url: 'acme.test' },
      date: '2026-10-19',
    });
    const parsed = parseTemplateYaml(g.yaml);
    expect(parsed.issues).toEqual([]);
    const t = parsed.template!;
    expect(t.name).toBe('acme');
    expect(t.colors).toEqual({ ...palette.colors });
    expect(t.fonts).toEqual({ display: 'fonts/display-Bold.ttf', body: ['fonts/body-Regular.ttf', 'fonts/body-SemiBold.ttf'] });
    expect(t.logo).toBe('logo.png');
    expect(t.wordmark).toBeUndefined();
    expect(t.brand).toEqual({ name: 'Acme', url: 'acme.test' });
    // The outro shows the brand's url: its own when the base writes one, else brand.url (the outro's fallback).
    expect(t.outro.url ?? t.brand?.url).toBe('acme.test');
    expect(t.cursor.ripple_color).toBe(palette.ripple_color);
    expect(t.background).toEqual(palette.background);
    // The base's components, frame, captions, motion and durations, untouched.
    for (const k of ['components', 'frame', 'captions', 'motion', 'intro', 'interstitial', 'transitions', 'style_bias'] as const) expect(t[k], k).toEqual(parseTemplateYaml(text).template![k]);
    expect(g.yaml.startsWith(`# Retake theme "acme", made from brand inputs on 2026-10-19 over the "${baseName}" theme`)).toBe(true);
    expect(g.yaml).not.toMatch(/Atelier|example\.com|Retake"? *#/);
  });

  it("no brand url: the base's placeholder outro url is dropped, never kept", () => {
    const base = parseYaml(readFileSync(join(STARTER_TEMPLATES_DIR, 'editorial', 'template.yaml'), 'utf8')).value as TemplateFile;
    const g = generateThemeFile({
      base,
      baseName: 'editorial',
      name: 'acme',
      palette: derivePalette({ accent: '#0e7c66' }),
      logo: 'logo.svg',
      wordmark: 'wordmark.svg',
      fonts: { display: 'a.ttf', body: ['b.ttf'] },
      date: '2026-10-19',
    });
    const t = parseTemplateYaml(g.yaml).template!;
    expect(t.outro.url).toBeUndefined();
    expect(t.brand).toBeUndefined();
    expect(t.wordmark).toBe('wordmark.svg');
  });

  const editorialBase = () => parseYaml(readFileSync(join(STARTER_TEMPLATES_DIR, 'editorial', 'template.yaml'), 'utf8')).value as TemplateFile;
  const gen = (o: Partial<Parameters<typeof generateThemeFile>[0]>, base: TemplateFile = editorialBase()) =>
    generateThemeFile({
      base,
      baseName: 'editorial',
      name: 'acme',
      palette: derivePalette({ accent: '#0e7c66' }),
      logo: 'logo.png',
      fonts: { display: 'a.ttf', body: ['b.ttf'] },
      date: '2026-11-15',
      ...o,
    });

  it("components: params merged over the base's entry (a shorthand id expanded), another id with only its own, a base without the kind's entry from its legacy fields", () => {
    const g = gen({ components: { outro: { params: { logo_size: 72 } }, layout: { params: { radius: 4 } }, transition: { id: 'studio/transition-fade-black' } } });
    const t = parseTemplateYaml(g.yaml).template!;
    expect(t.components?.outro).toEqual({ id: 'studio/outro-stack', params: { logo_size: 72 } });
    expect(t.components?.layout).toEqual({ id: 'studio/layout-card', params: { width: 1560, radius: 4, shadow: 'soft' } });
    expect(t.components?.transition).toBe('studio/transition-fade-black');
    // Each entry now differs from what its legacy fields map to: those fields go (as the Studio's set_component does).
    expect(g.removed_legacy).toEqual(['frame.style', 'frame.width', 'frame.radius', 'frame.shadow', 'outro.layout', 'transitions.between_scenes', 'transitions.duration']);
    expect(parseTemplateYaml(g.yaml).issues).toEqual([]);
    // No components entry for the kind in the base: its legacy field's component (here: outro.layout → outro-stack).
    const bare = editorialBase();
    delete (bare.components as Record<string, unknown>).outro;
    expect(parseTemplateYaml(gen({ components: { outro: { params: { stagger: 0.2 } } } }, bare).yaml).template?.components?.outro).toEqual({ id: 'studio/outro-stack', params: { stagger: 0.2 } });
    // A kind the base fills with a file (or none) needs an id.
    const file = editorialBase();
    (file.components as Record<string, unknown>).outro = { image: 'end.png' };
    expect(() => gen({ components: { outro: { params: { logo_size: 72 } } } }, file)).toThrow(/components\.outro: the base theme has no component for outro \(a file of its own\): give an id/);
    expect(parseTemplateYaml(gen({ components: { outro: { id: 'studio/outro-minimal' } } }, file).yaml).template?.components?.outro).toBe('studio/outro-minimal');
  });

  it('logo_kind is written right after logo; the cursor style and size go over the base cursor, the ripple follows the palette', () => {
    const g = gen({ logo_kind: 'wordmark', cursor: { style: 'arrow-light', size: 30 } });
    expect(g.yaml).toMatch(/^logo: logo\.png\nlogo_kind: wordmark\n/m);
    const t = parseTemplateYaml(g.yaml).template!;
    expect(t.logo_kind).toBe('wordmark');
    expect(t.cursor).toEqual({ style: 'arrow-light', size: 30, ripple_color: derivePalette({ accent: '#0e7c66' }).ripple_color });
    expect(gen({}).yaml).not.toContain('logo_kind');
    expect(parseTemplateYaml(gen({}).yaml).template?.cursor.style).toBe('arrow-dark');
  });
});
