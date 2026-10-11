/**
 * CSS helpers from theme tokens (pure). Components read every colour and font from `props.theme` through these.
 */
import type { ThemeTextStyle, ThemeTokens } from '../types.js';

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded']);

/** A CSS font-family value for a theme family name: quoted, with a generic fallback (lists are passed through). */
export function cssFontFamily(family: string, fallback = 'sans-serif'): string {
  const f = family.trim();
  if (f.includes(',') || f.startsWith('"') || f.startsWith("'") || GENERIC.has(f)) return f;
  return `"${f.replace(/"/g, '\\"')}", ${fallback}`;
}

/** CSS `background` of the theme background (solid colour, radial or linear gradient). */
export function backgroundCss(theme: Pick<ThemeTokens, 'background' | 'colors'>): string {
  const b = theme.background;
  const from = b.from ?? b.color ?? theme.colors.paper;
  const to = b.to ?? from;
  switch (b.type) {
    case 'radial':
      // The reference "paper" (look.md): lightest at the top centre, reaching `to` along the bottom edge, a wide
      // ellipse so the sides barely darken; the 60 % hint keeps the upper half light (measured on the reference).
      return `radial-gradient(ellipse 150% 100% at 50% 0%, ${from} 0%, 60%, ${to} 100%)`;
    case 'linear':
      return `linear-gradient(180deg, ${from} 0%, ${to} 100%)`;
    default:
      return b.color ?? b.from ?? theme.colors.paper;
  }
}

/** A colour with opacity `alpha` (0..1): hex colours become rgba(), others use color-mix(). */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
    const base = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
    return `rgba(${r}, ${g}, ${b}, ${round(a * base)})`;
  }
  return `color-mix(in srgb, ${color} ${round(a * 100)}%, transparent)`;
}

/** Relative luminance (0 black … 1 white) of a hex colour; undefined for other notations. */
export function luminance(color: string): number | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return undefined;
  let h = hex[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [0, 2, 4].map((i) => lin(Number.parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Style object of a theme text style (caption kicker/line…) at a given unit. */
export function textStyleCss(style: ThemeTextStyle, unit = 1): Record<string, string | number> {
  const out: Record<string, string | number> = {
    fontFamily: cssFontFamily(style.font),
    fontSize: style.size * unit,
    color: style.color,
    lineHeight: 1.2,
  };
  if (style.weight !== undefined) out.fontWeight = style.weight;
  if (style.uppercase) out.textTransform = 'uppercase';
  if (style.letter_spacing !== undefined) out.letterSpacing = `${style.letter_spacing}em`;
  return out;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Title-safe area of a frame: `inset` is a fraction of each dimension (default 0.05 = the broadcast title-safe
 * margin; 0.035 ≈ action-safe).
 */
export function safeAreaRect(width: number, height: number, inset = 0.05): Rect {
  const x = Math.round(width * inset);
  const y = Math.round(height * inset);
  return { x, y, w: width - 2 * x, h: height - 2 * y };
}

/** Scale a design-space rect (1920×1080 or 1080×1920) to output px. */
export function scaleRect(r: Rect, unit: number): Rect {
  return { x: r.x * unit, y: r.y * unit, w: r.w * unit, h: r.h * unit };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** WCAG contrast ratio (1…21) of two hex colours; undefined when either is not hex. */
export function contrastRatio(a: string, b: string): number | undefined {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === undefined || lb === undefined) return undefined;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** `preferred` when it reads on `background` (contrast ≥ `min`, default 3), else `fallback`. Unknown notations keep `preferred`. */
export function readableOn(background: string, preferred: string, fallback: string, min = 3): string {
  const r = contrastRatio(background, preferred);
  return r === undefined || r >= min ? preferred : fallback;
}

/**
 * The theme's dark and light colours: `colors.text` and `colors.paper` ordered by luminance (a dark theme has light
 * text on a dark paper). Use them for veils and type that must contrast whatever the theme.
 */
export function darkLight(theme: Pick<ThemeTokens, 'colors'>): { dark: string; light: string } {
  const { text, paper } = theme.colors;
  const lt = luminance(text);
  const lp = luminance(paper);
  if (lt !== undefined && lp !== undefined && lt > lp) return { dark: paper, light: text };
  return { dark: text, light: paper };
}

function parseHex(color: string): [number, number, number] | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return undefined;
  let h = hex[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * `a` mixed with `t` (0..1) of `b`: a hex colour when both are hex (deterministic, sRGB), else CSS color-mix().
 * Used to derive quiet tones from the theme (e.g. a ring between the dark tone and the paper).
 */
export function mixColors(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return `color-mix(in srgb, ${a} ${round((1 - k) * 100)}%, ${b})`;
  const ch = (i: number) => Math.round(ca[i] + (cb[i] - ca[i]) * k).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

/**
 * The theme's night tone for dark cards and veils: `colors.dark` when the theme defines it, else the darker of
 * text / paper (the text colour of a light theme, the paper of a dark one).
 */
export function nightTone(theme: Pick<ThemeTokens, 'colors'>): string {
  return theme.colors.dark ?? darkLight(theme).dark;
}

/** True when the theme background reads as dark (light text on it). */
export function isDarkBackground(theme: Pick<ThemeTokens, 'background' | 'colors'>): boolean {
  const l = luminance(backgroundSample(theme));
  if (l !== undefined) return l < 0.18;
  const lp = luminance(theme.colors.paper);
  return lp !== undefined && lp < 0.18;
}

/** A representative colour of the theme background (solid colour, or the middle of the gradient) for contrast checks. */
export function backgroundSample(theme: Pick<ThemeTokens, 'background' | 'colors'>): string {
  const b = theme.background;
  if (b.type === 'solid') return b.color ?? b.from ?? theme.colors.paper;
  const from = b.from ?? b.color ?? theme.colors.paper;
  return mixColors(from, b.to ?? from, 0.5);
}

/**
 * `color` mixed towards `toward` (in steps of 15 %) until it reads on `background` (contrast ≥ `min`, default 3): a
 * theme colour that keeps its hue on a surface where it would not read as is (e.g. a dark accent on the night tone →
 * a lighter tint of the accent). Falls back to `toward` itself; unknown notations keep `color`.
 */
export function liftToContrast(background: string, color: string, toward: string, min = 3): string {
  if (contrastRatio(background, color) === undefined) return color;
  for (let t = 0; t <= 0.9 + 1e-9; t += 0.15) {
    const c = t === 0 ? color : mixColors(color, toward, t);
    if ((contrastRatio(background, c) ?? 0) >= min) return c;
  }
  return toward;
}
