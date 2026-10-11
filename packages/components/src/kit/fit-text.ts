/**
 * Text fitting: the largest font size (≤ max) at which a text fits a box, wrapped on at most `maxLines` lines.
 * Text slots must never overflow: below `minFontSize` the text is cut with an ellipsis.
 *
 * In a browser (Remotion render, Studio preview) widths are measured with a canvas using the real font (the host
 * composition loads the theme fonts before rendering); in Node (tests, planning) a deterministic per-character
 * estimate is used.
 */
import { roundTo } from './motion.js';
import { cssFontFamily } from './style.js';

export interface TextFont {
  /** CSS font-family name (theme.fonts.display / theme.fonts.body) or a full font-family list. */
  family: string;
  weight?: number | string;
  style?: 'normal' | 'italic';
  /** px. */
  size: number;
  /** em (template letter_spacing). */
  letterSpacing?: number;
}

/** Width in px of a single line of text. */
export type TextMeasurer = (text: string, font: TextFont) => number;

/** Average advance widths (em) of a typical proportional font; deterministic. */
function charEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x2e80) return 1; // CJK & co: full width
  if (ch === ' ') return 0.27;
  if ("iljI|!.,:;'`".includes(ch)) return 0.27;
  if ('frt()[]{}"-'.includes(ch)) return 0.36;
  if ('mwMW@%'.includes(ch)) return 0.86;
  if (ch >= 'A' && ch <= 'Z') return 0.66;
  if (ch >= '0' && ch <= '9') return 0.56;
  if (ch >= 'a' && ch <= 'z') return 0.52;
  return 0.56;
}

/** Deterministic width estimate (Node fallback of `measureText`). */
export function estimateTextWidth(text: string, font: TextFont): number {
  const chars = [...text];
  const weight = typeof font.weight === 'string' ? Number.parseInt(font.weight, 10) || 400 : (font.weight ?? 400);
  const bold = weight >= 600 ? 1.05 : 1;
  const em = chars.reduce((sum, ch) => sum + charEm(ch), 0) * bold;
  const spacing = (font.letterSpacing ?? 0) * font.size * Math.max(0, chars.length - 1);
  return em * font.size + spacing;
}

type Ctx2D = { font: string; measureText(text: string): { width: number } };
let ctx: Ctx2D | null | undefined;

function canvasContext(): Ctx2D | null {
  if (ctx !== undefined) return ctx;
  ctx = null;
  try {
    const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => { getContext(id: '2d'): Ctx2D | null }; document?: { createElement(tag: 'canvas'): { getContext(id: '2d'): Ctx2D | null } } };
    if (g.OffscreenCanvas) ctx = new g.OffscreenCanvas(1, 1).getContext('2d');
    else if (g.document) ctx = g.document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Width in px of one line: canvas measurement in a browser, `estimateTextWidth` elsewhere. */
export const measureText: TextMeasurer = (text, font) => {
  const c = canvasContext();
  if (!c) return estimateTextWidth(text, font);
  c.font = `${font.style ?? 'normal'} ${font.weight ?? 400} ${font.size}px ${cssFontFamily(font.family)}`;
  const spacing = (font.letterSpacing ?? 0) * font.size * Math.max(0, [...text].length - 1);
  return c.measureText(text).width + spacing;
};

export interface FitTextOptions {
  text: string;
  /** Available width, px. */
  width: number;
  /** Available height, px (default: unbounded, only `maxLines` limits the height). */
  height?: number;
  fontFamily: string;
  fontWeight?: number | string;
  fontStyle?: 'normal' | 'italic';
  /** Largest size wanted, px. */
  maxFontSize: number;
  /** Smallest acceptable size, px (default max(8, maxFontSize / 4)). Below it the text is cut with "…". */
  minFontSize?: number;
  /** Line height as a multiple of the font size (default 1.15). */
  lineHeight?: number;
  /** Default 1. */
  maxLines?: number;
  /** em. */
  letterSpacing?: number;
  /** Measure (and return) the text upper-cased. */
  uppercase?: boolean;
  /** Size granularity in px (default 0.5). */
  step?: number;
  /** Even out the lines of a wrapped text (like CSS `text-wrap: balance`; default true). */
  balance?: boolean;
  measure?: TextMeasurer;
}

export interface FitTextResult {
  fontSize: number;
  /** The lines to draw (upper-cased when `uppercase`). */
  lines: string[];
  /** Widest line, px. */
  width: number;
  /** lines × fontSize × lineHeight, px. */
  height: number;
  /** False when even `minFontSize` did not fit and the text was cut. */
  fits: boolean;
  truncated: boolean;
}

/** Greedy word wrap at `width`. A word wider than the line stays alone on its line. */
export function wrapText(text: string, width: number, font: TextFont, measure: TextMeasurer = measureText): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (const w of words.slice(1)) {
      const candidate = `${line} ${w}`;
      if (measure(candidate, font) <= width) line = candidate;
      else {
        lines.push(line);
        line = w;
      }
    }
    lines.push(line);
  }
  return lines;
}

function layout(o: Required<Pick<FitTextOptions, 'width' | 'lineHeight' | 'maxLines'>> & FitTextOptions, text: string, size: number, measure: TextMeasurer) {
  const font: TextFont = { family: o.fontFamily, weight: o.fontWeight, style: o.fontStyle, size, letterSpacing: o.letterSpacing };
  const lines = wrapText(text, o.width, font, measure);
  const widest = Math.max(0, ...lines.map((l) => measure(l, font)));
  const height = lines.length * size * o.lineHeight;
  const fits = lines.length <= o.maxLines && widest <= o.width + 0.01 && (o.height === undefined || height <= o.height + 0.01);
  return { lines, widest, height, fits, font };
}

/** Cut `lines` to `maxLines`, ending the last one with "…" so that it fits `width`. */
function truncate(lines: string[], maxLines: number, width: number, font: TextFont, measure: TextMeasurer): string[] {
  const kept = lines.slice(0, maxLines);
  const cut = lines.length > maxLines;
  let last = kept[kept.length - 1] ?? '';
  if (!cut && measure(last, font) <= width) return kept;
  const chars = [...(cut ? `${last} ${lines.slice(maxLines).join(' ')}` : last)];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${chars.slice(0, mid).join('').trimEnd()}…`, font) <= width) lo = mid;
    else hi = mid - 1;
  }
  last = `${chars.slice(0, lo).join('').trimEnd()}…`;
  kept[kept.length - 1] = last;
  return kept;
}

/** The greedy wrap at the narrowest width that still gives `count` lines (balanced lines, same line count). */
export function balanceLines(text: string, width: number, count: number, font: TextFont, measure: TextMeasurer = measureText): string[] {
  let lo = 0;
  let hi = width;
  for (let i = 0; i < 24 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    const lines = wrapText(text, mid, font, measure);
    const fits = lines.length <= count && lines.every((l) => measure(l, font) <= mid + 0.01);
    if (fits) hi = mid;
    else lo = mid;
  }
  return wrapText(text, hi, font, measure);
}

/**
 * The largest font size ≤ maxFontSize (on a `step` grid) at which `text` fits `width` × `height` on at most
 * `maxLines` lines. Deterministic for a given measurer.
 */
export function fitText(opts: FitTextOptions): FitTextResult {
  const o = { lineHeight: 1.15, maxLines: 1, ...opts };
  const measure = o.measure ?? measureText;
  const step = o.step ?? 0.5;
  const max = Math.max(step, o.maxFontSize);
  const min = Math.min(max, Math.max(step, o.minFontSize ?? Math.max(8, max / 4)));
  const text = o.uppercase ? o.text.toUpperCase() : o.text;
  const at = (size: number) => layout(o, text, size, measure);

  let best = at(max);
  let size = max;
  if (!best.fits) {
    // Binary search on the step grid between min and max (fitting is monotonic in the size).
    let lo = Math.ceil(min / step);
    let hi = Math.floor(max / step) - 1;
    let found: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (at(mid * step).fits) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found !== undefined) {
      size = found * step;
      best = at(size);
    } else {
      size = min;
      const l = at(min);
      const byHeight = o.height === undefined ? o.maxLines : Math.floor((o.height + 0.01) / (min * o.lineHeight));
      const lines = truncate(l.lines, Math.max(1, Math.min(o.maxLines, byHeight)), o.width, l.font, measure);
      const widest = Math.max(0, ...lines.map((x) => measure(x, l.font)));
      return { fontSize: size, lines, width: roundTo(widest, 3), height: roundTo(lines.length * size * o.lineHeight, 3), fits: false, truncated: true };
    }
  }
  let lines = best.lines;
  let widest = best.widest;
  if (o.balance !== false && lines.length > 1 && !text.includes('\n')) {
    lines = balanceLines(text, o.width, lines.length, best.font, measure);
    widest = Math.max(0, ...lines.map((l) => measure(l, best.font)));
  }
  return { fontSize: size, lines, width: roundTo(widest, 3), height: roundTo(best.height, 3), fits: true, truncated: false };
}
