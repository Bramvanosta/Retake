/**
 * Font metrics and cap-aligned text layout (pure, deterministic).
 *
 * Reference positions of text (docs/reference/look.md: "title at y ≈ 612") are CAP CENTRES: the middle of the band
 * between the cap top and the baseline. CSS places text by its line box, whose content depends on the font's ascent
 * and descent, so a text placed by its box lands at a different height with every font. `capTextLayout` fits a text
 * (fitText) and says where its line box goes so that its first cap top lands exactly where the caller wants it,
 * whatever the font; `CapText` (./elements.tsx) draws it.
 *
 * In a browser the metrics come from a canvas with the real (loaded) font: `actualBoundingBoxAscent` of "H" (cap
 * height) and `fontBoundingBoxAscent/Descent` (the ascent/descent CSS uses for the line box). In Node (tests,
 * planning) a deterministic estimate is used.
 */
import { fitText } from './fit-text.js';
import type { FitTextOptions, FitTextResult, TextFont } from './fit-text.js';
import { cssFontFamily } from './style.js';

export interface FontMetrics {
  /** px above the baseline the line box reserves (CSS content-area ascent). */
  ascent: number;
  /** px below the baseline. */
  descent: number;
  /** Height of a capital letter (H), px. */
  capHeight: number;
}

/** Ratios of the Node estimate (typical sans/serif text faces). */
export const ESTIMATED_METRICS = { ascent: 0.92, descent: 0.24, capHeight: 0.7 } as const;

type MetricsCtx = {
  font: string;
  measureText(text: string): { actualBoundingBoxAscent?: number; fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number };
};
let ctx: MetricsCtx | null | undefined;

function context(): MetricsCtx | null {
  if (ctx !== undefined) return ctx;
  ctx = null;
  try {
    const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => { getContext(id: '2d'): MetricsCtx | null }; document?: { createElement(tag: 'canvas'): { getContext(id: '2d'): MetricsCtx | null } } };
    // A document canvas first: it resolves the fonts registered on the document (FontFace API); OffscreenCanvas only
    // where there is no document (workers).
    if (g.document) ctx = g.document.createElement('canvas').getContext('2d');
    else if (g.OffscreenCanvas) ctx = new g.OffscreenCanvas(1, 1).getContext('2d');
  } catch {
    ctx = null;
  }
  return ctx;
}

const cache = new Map<string, FontMetrics>();

/** Metrics of a font at `font.size` px: canvas measurement in a browser, ESTIMATED_METRICS elsewhere. */
export function fontMetrics(font: Pick<TextFont, 'family' | 'weight' | 'style' | 'size'>): FontMetrics {
  const key = `${font.family}|${font.weight ?? 400}|${font.style ?? 'normal'}|${font.size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const estimate: FontMetrics = {
    ascent: ESTIMATED_METRICS.ascent * font.size,
    descent: ESTIMATED_METRICS.descent * font.size,
    capHeight: ESTIMATED_METRICS.capHeight * font.size,
  };
  const c = context();
  if (!c) return estimate;
  c.font = `${font.style ?? 'normal'} ${font.weight ?? 400} ${font.size}px ${cssFontFamily(font.family)}`;
  const m = c.measureText('H');
  const out: FontMetrics = {
    ascent: typeof m.fontBoundingBoxAscent === 'number' ? m.fontBoundingBoxAscent : estimate.ascent,
    descent: typeof m.fontBoundingBoxDescent === 'number' ? m.fontBoundingBoxDescent : estimate.descent,
    capHeight: typeof m.actualBoundingBoxAscent === 'number' && m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : estimate.capHeight,
  };
  cache.set(key, out);
  return out;
}

/**
 * Distance from the top of a line box `lineHeight` px tall to the cap top of its text (CSS: half-leading + ascent −
 * cap height). Negative when the line box is shorter than the font's content area.
 */
export function capOffset(m: FontMetrics, lineHeight: number): number {
  return (lineHeight - (m.ascent + m.descent)) / 2 + m.ascent - m.capHeight;
}

export interface CapTextLayout extends FitTextResult {
  /** Line height in px. */
  lineHeightPx: number;
  capHeight: number;
  /** Where the first line box starts relative to the first cap top (add it to the wanted cap top to get `top`). */
  boxOffset: number;
  /** Height of the visual band: first cap top → last baseline (px). */
  band: number;
  /** The fitted font (family, weight, size…) for drawing. */
  font: TextFont;
}

/**
 * Fit `text` (fitText: largest size ≤ maxFontSize on at most maxLines lines, never overflowing) and compute how to
 * place it by its cap band.
 */
export function capTextLayout(opts: FitTextOptions): CapTextLayout {
  const lineHeight = opts.lineHeight ?? 1.15;
  const r = fitText({ ...opts, lineHeight });
  const font: TextFont = { family: opts.fontFamily, weight: opts.fontWeight, style: opts.fontStyle, size: r.fontSize, letterSpacing: opts.letterSpacing };
  const m = fontMetrics(font);
  const lineHeightPx = r.fontSize * lineHeight;
  return {
    ...r,
    lineHeightPx,
    capHeight: m.capHeight,
    boxOffset: -capOffset(m, lineHeightPx),
    band: (r.lines.length - 1) * lineHeightPx + m.capHeight,
    font,
  };
}
