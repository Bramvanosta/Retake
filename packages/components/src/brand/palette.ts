/**
 * The palette of a theme made from brand inputs (L3.5, R-MCP-10): deterministic (hex in, hex out; no model call), built
 * only on the kit's colour helpers (kit/style.ts). From the accent — and any colour the brand gives — it derives the
 * text, muted, paper and night tones, a background and the cursor ripple, then checks WCAG contrasts:
 *
 * - text on paper and on the background sample ≥ 7 (captions, titles), muted on paper ≥ 4.5 (taglines, url);
 * - the light tone on the night tone ≥ 7 (dark cards and interstitials);
 * - the accent on paper ≥ 3 (kicker, rules) — and on the night tone ≥ 3 (the clock hand), reported only: the
 *   reference look (editorial) itself draws a deep accent hand on its ink.
 *
 * With `adjust` (default) a colour that misses its threshold — derived or given — is lifted towards the extreme of its
 * side (black on a light theme, white on a dark one; muted towards the text) in the kit's 15 % steps, and every change
 * is reported. The accent itself is never changed: a failing accent gives a warning and a suggested value, the caller
 * decides (brand accents are often light).
 */
import { normalizeHex } from '@demo-studio/core';
import type { BrandBackground } from '@demo-studio/core';
import { backgroundSample, contrastRatio, liftToContrast, luminance, mixColors, withAlpha } from '../kit/style.js';

export type PaletteTone = 'light' | 'dark';

/** Contrast thresholds (WCAG ratios) the palette checks. */
export const PALETTE_THRESHOLDS = {
  text_on_paper: 7,
  text_on_background: 7,
  muted_on_paper: 4.5,
  light_on_dark: 7,
  accent_on_paper: 3,
  accent_on_dark: 3,
} as const;

/** Below this relative luminance a paper makes a dark theme (the kit's isDarkBackground threshold). */
export const DARK_PAPER_LUMINANCE = 0.18;

export interface PaletteInput {
  accent: string;
  text?: string;
  paper?: string;
  muted?: string;
  dark?: string;
  background?: BrandBackground;
  /** Default true. */
  adjust?: boolean;
  /** The tone when no paper is given (the base theme's); a given paper decides it otherwise. */
  tone?: PaletteTone;
}

export interface PaletteColors {
  accent: string;
  text: string;
  muted: string;
  paper: string;
  dark: string;
}

export interface PaletteBackground {
  type: 'solid' | 'radial' | 'linear';
  color?: string;
  from?: string;
  to?: string;
}

export interface PaletteCheck {
  /** text_on_paper, muted_on_paper… (PALETTE_THRESHOLDS). */
  check: keyof typeof PALETTE_THRESHOLDS;
  ratio: number;
  min: number;
  ok: boolean;
}

export interface PaletteAdjustment {
  key: 'text' | 'muted' | 'dark';
  /** The brand gave this colour (else it was derived). */
  given: boolean;
  from: string;
  to: string;
  check: keyof typeof PALETTE_THRESHOLDS;
  ratio_before: number;
  ratio_after: number;
}

export interface Palette {
  tone: PaletteTone;
  colors: PaletteColors;
  background: PaletteBackground;
  /** The cursor ripple: the accent at 0.45 alpha. */
  ripple_color: string;
  /** Colours the brand gave (the others were derived). */
  given: Array<keyof PaletteColors | 'background'>;
  checks: PaletteCheck[];
  adjusted: PaletteAdjustment[];
  warnings: string[];
  /** A lifted accent that would pass, when the accent fails on the paper (never applied). */
  suggestions: { accent?: string };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: string, b: string) => contrastRatio(a, b) ?? 1;

export function paletteTone(paper: string): PaletteTone {
  return (luminance(paper) ?? 1) < DARK_PAPER_LUMINANCE ? 'dark' : 'light';
}

/** The palette of a brand: derived colours, background, ripple, contrast checks, adjustments and warnings. Pure. */
export function derivePalette(input: PaletteInput): Palette {
  const adjust = input.adjust !== false;
  const hex = (c: string | undefined) => (c === undefined ? undefined : normalizeHex(c));
  const accent = hex(input.accent)!;
  const given: Palette['given'] = ['accent'];
  for (const k of ['text', 'paper', 'muted', 'dark'] as const) if (input[k] !== undefined) given.push(k);
  if (input.background !== undefined) given.push('background');
  const gPaper = hex(input.paper);
  const tone: PaletteTone = gPaper ? paletteTone(gPaper) : input.tone ?? 'light';
  const light = tone === 'light';
  const extreme = light ? '#000000' : '#ffffff';

  const paper = gPaper ?? (light ? mixColors('#ffffff', accent, 0.04) : mixColors('#0b0d12', accent, 0.1));
  let background: PaletteBackground;
  const b = input.background;
  if (typeof b === 'string') background = { type: 'solid', color: normalizeHex(b) };
  else if (b) background = { type: b.type, from: normalizeHex(b.from), to: normalizeHex(b.to) };
  else if (light) background = { type: 'radial', from: mixColors(paper, '#ffffff', 0.4), to: mixColors(paper, accent, 0.05) };
  else background = { type: 'linear', from: mixColors(paper, '#000000', 0.4), to: mixColors(mixColors(paper, '#ffffff', 0.08), accent, 0.06) };
  const bgSample = backgroundSample({ background, colors: { accent, text: paper, muted: paper, paper } });

  const adjusted: PaletteAdjustment[] = [];
  const warnings: string[] = [];
  const isGiven = (k: PaletteAdjustment['key']) => input[k] !== undefined;
  /** Lift `color` (key) towards `toward` until it reads on `on` (check), recording the change. */
  const lift = (key: PaletteAdjustment['key'], color: string, on: string, toward: string, check: keyof typeof PALETTE_THRESHOLDS): string => {
    const min = PALETTE_THRESHOLDS[check];
    const before = ratio(color, on);
    if (before >= min || !adjust) return color;
    const to = liftToContrast(on, color, toward, min);
    if (to !== color) adjusted.push({ key, given: isGiven(key), from: color, to, check, ratio_before: round2(before), ratio_after: round2(ratio(to, on)) });
    return to;
  };

  let text = hex(input.text) ?? (light ? mixColors('#0b0d12', accent, 0.1) : mixColors('#f7f8fb', accent, 0.06));
  text = lift('text', text, paper, extreme, 'text_on_paper');
  text = lift('text', text, bgSample, extreme, 'text_on_background');
  let muted = hex(input.muted) ?? mixColors(text, paper, light ? 0.36 : 0.38);
  muted = lift('muted', muted, paper, text, 'muted_on_paper');
  const lightTone = light ? paper : text;
  let dark = hex(input.dark) ?? (light ? mixColors('#0b0d12', accent, 0.18) : mixColors(paper, '#000000', 0.35));
  dark = lift('dark', dark, lightTone, '#000000', 'light_on_dark');

  const checks: PaletteCheck[] = (
    [
      ['text_on_paper', text, paper],
      ['text_on_background', text, bgSample],
      ['muted_on_paper', muted, paper],
      ['light_on_dark', lightTone, dark],
      ['accent_on_paper', accent, paper],
      ['accent_on_dark', accent, dark],
    ] as Array<[keyof typeof PALETTE_THRESHOLDS, string, string]>
  ).map(([check, a, on]) => {
    const r = round2(ratio(a, on));
    return { check, ratio: r, min: PALETTE_THRESHOLDS[check], ok: ratio(a, on) >= PALETTE_THRESHOLDS[check] };
  });

  const suggestions: Palette['suggestions'] = {};
  for (const c of checks) {
    if (c.ok) continue;
    if (c.check === 'accent_on_paper') {
      const s = liftToContrast(paper, accent, text, c.min);
      if (s !== accent && ratio(s, paper) >= c.min) suggestions.accent = s;
      warnings.push(
        `the accent ${accent} reads at ${c.ratio}:1 on the paper ${paper} (kicker, rules need ${c.min}:1): it is kept as given${suggestions.accent ? `; ${suggestions.accent} would pass (pass it as colors.accent to use it)` : ''}`,
      );
    } else if (c.check === 'accent_on_dark') {
      // Reported, not warned: the reference look itself draws a deep accent hand on the ink (a 4.5 px stroke).
      continue;
    } else {
      const what = { text_on_paper: `the text ${text} on the paper ${paper}`, text_on_background: `the text ${text} on the background (${bgSample})`, muted_on_paper: `the muted ${muted} on the paper ${paper}`, light_on_dark: `${lightTone} on the night tone ${dark}` }[c.check];
      warnings.push(`${what} reads at ${c.ratio}:1 (needs ${c.min}:1)${adjust ? ' even lifted as far as it goes' : ' (adjust is off)'}`);
    }
  }
  return {
    tone,
    colors: { accent, text, muted, paper, dark },
    background,
    ripple_color: withAlpha(accent, 0.45),
    given,
    checks,
    adjusted,
    warnings,
    suggestions,
  };
}
