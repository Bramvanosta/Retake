/**
 * Colour roles of a site extraction (L3.5): deterministic, from the samples the isolated world took (page-script.ts).
 * Colours are bucketed by quantising each channel (8 levels of 32), each bucket represented by its most weighted
 * exact colour; roles: `paper` the largest painted background, `text` the colour of most characters, `accent` the most
 * saturated colour of links and buttons (else of the page), `dark` the darkest large background. The model chooses
 * from the swatches; nothing here decides the theme.
 */
import type { SampledColors } from './page-script.js';

export interface Swatch {
  hex: string;
  /** Share of the painted background points (0–1). */
  background: number;
  /** Share of the characters of text in view (0–1). */
  text: number;
  /** Share of the weight of links and buttons (0–1). */
  interactive: number;
  /** WCAG contrast ratio against the paper and the text roles. */
  contrast: { paper: number; text: number };
}

export interface SiteRoles {
  paper: string;
  text: string;
  accent: string | null;
  dark: string | null;
}

export interface SitePalette {
  swatches: Swatch[];
  roles: SiteRoles;
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

/** 0 (grey) … 1 (pure hue). */
export function chroma(hex: string): number {
  const c = rgb(hex);
  return (Math.max(...c) - Math.min(...c)) / 255;
}

const bucketOf = (hex: string) => rgb(hex).map((c) => c >> 5).join('.');

interface Bucket {
  key: string;
  hex: string;
  weight: number;
  exact: Map<string, number>;
}

function buckets(rec: Record<string, number>): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (const [hex, w] of Object.entries(rec)) {
    if (!/^#[0-9a-f]{6}$/.test(hex) || !(w > 0)) continue;
    const key = bucketOf(hex);
    const b = out.get(key) ?? { key, hex, weight: 0, exact: new Map() };
    b.weight += w;
    b.exact.set(hex, (b.exact.get(hex) ?? 0) + w);
    out.set(key, b);
  }
  for (const b of out.values()) b.hex = [...b.exact].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
  return out;
}

const total = (m: Map<string, Bucket>) => [...m.values()].reduce((s, b) => s + b.weight, 0) || 1;
const ranked = (m: Map<string, Bucket>) => [...m.values()].sort((a, b) => b.weight - a.weight || (a.hex < b.hex ? -1 : 1));

/** Merge the samples of several scroll positions. */
export function mergeSamples(samples: readonly SampledColors[]): SampledColors {
  const out: SampledColors = { background: {}, text: {}, interactive: {}, sections: {}, media_points: 0, points: 0 };
  for (const s of samples) {
    for (const k of ['background', 'text', 'interactive', 'sections'] as const) for (const [h, w] of Object.entries(s[k])) out[k][h] = (out[k][h] ?? 0) + w;
    out.media_points += s.media_points;
    out.points += s.points;
  }
  return out;
}

/** Swatches (≤ 8) and roles from merged samples. */
export function sitePalette(s: SampledColors, max = 8): SitePalette {
  const bg = buckets(s.background);
  const tx = buckets(s.text);
  const ia = buckets(s.interactive);
  const sec = buckets(s.sections);
  const paper = ranked(bg)[0]?.hex ?? '#ffffff';
  const paperKey = bucketOf(paper);
  const textB = ranked(tx).find((b) => b.key !== paperKey) ?? null;
  const text = textB?.hex ?? (luminance(paper) > 0.4 ? '#111111' : '#f5f5f5');
  const textKey = bucketOf(text);
  const pick = (m: Map<string, Bucket>) =>
    ranked(m)
      .filter((b) => b.key !== paperKey && b.key !== textKey && chroma(b.hex) >= 0.2)
      .sort((a, b) => b.weight * chroma(b.hex) - a.weight * chroma(a.hex) || (a.hex < b.hex ? -1 : 1))[0]?.hex ?? null;
  const accent = pick(ia) ?? pick(bg) ?? pick(tx);
  const bgTotal = total(bg);
  const darkCands = [...ranked(sec), ...ranked(bg).filter((b) => b.weight / bgTotal >= 0.01)].filter((b) => luminance(b.hex) < 0.05);
  const dark = darkCands.sort((a, b) => luminance(a.hex) - luminance(b.hex) || (a.hex < b.hex ? -1 : 1))[0]?.hex ?? (luminance(paper) < 0.05 ? paper : null);
  // Swatches: every bucket seen, by its largest share in any of the three samples.
  const all = new Map<string, { hex: string; background: number; text: number; interactive: number }>();
  const tt = total(tx);
  const it = total(ia);
  for (const [m, k, t] of [
    [bg, 'background', bgTotal],
    [tx, 'text', tt],
    [ia, 'interactive', it],
  ] as const) {
    for (const b of m.values()) {
      const e = all.get(b.key) ?? { hex: b.hex, background: 0, text: 0, interactive: 0 };
      e[k] = Math.round((b.weight / t) * 1000) / 1000;
      if (k === 'background' || (k === 'text' && e.background === 0)) e.hex = b.hex;
      all.set(b.key, e);
    }
  }
  // A role colour its bucket represents by another colour (a dark section next to near-black text): its own swatch.
  const roleHexes = [paper, text, accent, dark].filter((h): h is string => h !== null);
  const share = (m: Map<string, Bucket>, t: number, hex: string) => Math.round(((m.get(bucketOf(hex))?.exact.get(hex) ?? 0) / t) * 1000) / 1000;
  for (const h of roleHexes) {
    const k = bucketOf(h);
    const e = all.get(k);
    if (e && e.hex === h) continue;
    if (e && ![paper, text, accent, dark].includes(e.hex)) e.hex = h;
    else {
      if (e) Object.assign(e, { background: share(bg, bgTotal, e.hex), text: share(tx, tt, e.hex), interactive: share(ia, it, e.hex) });
      all.set(`${k}:${h}`, { hex: h, background: share(bg, bgTotal, h), text: share(tx, tt, h), interactive: share(ia, it, h) });
    }
  }
  const score = (e: { background: number; text: number; interactive: number }) => Math.max(e.background, e.text, e.interactive);
  const list = [...all.entries()]
    .sort((a, b) => Number(roleHexes.includes(b[1].hex)) - Number(roleHexes.includes(a[1].hex)) || score(b[1]) - score(a[1]) || (a[1].hex < b[1].hex ? -1 : 1))
    .slice(0, max)
    .map(([, e]) => ({ ...e, contrast: { paper: contrast(e.hex, paper), text: contrast(e.hex, text) } }));
  return { swatches: list, roles: { paper, text, accent, dark } };
}
