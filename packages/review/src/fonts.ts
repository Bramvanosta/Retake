/**
 * Text widths with the theme's real fonts, in Node: a minimal reader of TrueType / OpenType (and WOFF 1) files —
 * `cmap` (formats 4 and 12), `hmtx`, `hhea` and `head` — that gives the advance width of a line of text. The review
 * uses it with the kit's `fitText` to tell whether a caption fits its area at the theme size (the components measure
 * with a canvas in the browser; the kit's Node fallback is only a per-character estimate). Kerning and shaping are
 * ignored: widths are a little larger than the browser's for kerned faces (a conservative error for "too long").
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { TextFont, TextMeasurer } from '@demo-studio/components';
import { estimateTextWidth } from '@demo-studio/components';

/** Advance widths of one font face. */
export interface FontFace {
  file: string;
  unitsPerEm: number;
  /** Advance width (font units) of a code point; the .notdef advance for unmapped characters. */
  advance(codePoint: number): number;
}

interface Table {
  offset: number;
  length: number;
}

function tables(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'wOFF') {
    const n = buf.readUInt16BE(12);
    for (let i = 0; i < n; i++) {
      const p = 44 + i * 20;
      const t = buf.toString('latin1', p, p + 4);
      const offset = buf.readUInt32BE(p + 4);
      const comp = buf.readUInt32BE(p + 8);
      const orig = buf.readUInt32BE(p + 12);
      const raw = buf.subarray(offset, offset + comp);
      out.set(t, comp < orig ? inflateSync(raw) : raw);
    }
    return out;
  }
  let base = 0;
  if (tag === 'ttcf') base = buf.readUInt32BE(12);
  const version = buf.readUInt32BE(base);
  if (version !== 0x00010000 && buf.toString('latin1', base, base + 4) !== 'OTTO' && buf.toString('latin1', base, base + 4) !== 'true') {
    throw new Error('not a TrueType/OpenType/WOFF font');
  }
  const n = buf.readUInt16BE(base + 4);
  const recs: Array<[string, Table]> = [];
  for (let i = 0; i < n; i++) {
    const p = base + 12 + i * 16;
    recs.push([buf.toString('latin1', p, p + 4), { offset: buf.readUInt32BE(p + 8), length: buf.readUInt32BE(p + 12) }]);
  }
  for (const [t, r] of recs) out.set(t, buf.subarray(r.offset, r.offset + r.length));
  return out;
}

/** code point → glyph id, from the best Unicode cmap subtable (format 12, else format 4). */
function cmapLookup(cmap: Buffer): (cp: number) => number {
  const n = cmap.readUInt16BE(2);
  const subs: Array<{ platform: number; encoding: number; offset: number; format: number }> = [];
  for (let i = 0; i < n; i++) {
    const p = 4 + i * 8;
    const offset = cmap.readUInt32BE(p + 4);
    subs.push({ platform: cmap.readUInt16BE(p), encoding: cmap.readUInt16BE(p + 2), offset, format: cmap.readUInt16BE(offset) });
  }
  const unicode = (s: (typeof subs)[number]) => s.platform === 0 || (s.platform === 3 && (s.encoding === 1 || s.encoding === 10));
  const f12 = subs.find((s) => unicode(s) && s.format === 12);
  if (f12) {
    const o = f12.offset;
    const groups = cmap.readUInt32BE(o + 12);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const p = o + 16 + mid * 12;
        const start = cmap.readUInt32BE(p);
        const end = cmap.readUInt32BE(p + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return cmap.readUInt32BE(p + 8) + (cp - start);
      }
      return 0;
    };
  }
  const f4 = subs.find((s) => unicode(s) && s.format === 4);
  if (!f4) return () => 0;
  const o = f4.offset;
  const segX2 = cmap.readUInt16BE(o + 6);
  const ends = o + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = cmap.readUInt16BE(ends + i * 2);
      if (cp > end) continue;
      const start = cmap.readUInt16BE(starts + i * 2);
      if (cp < start) return 0;
      const delta = cmap.readInt16BE(deltas + i * 2);
      const range = cmap.readUInt16BE(ranges + i * 2);
      if (range === 0) return (cp + delta) & 0xffff;
      const p = ranges + i * 2 + range + (cp - start) * 2;
      const g = cmap.readUInt16BE(p);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
}

const faces = new Map<string, FontFace | null>();

/** The advance widths of a font file (cached); null when the file cannot be read or parsed. */
export function loadFontFace(file: string): FontFace | null {
  if (faces.has(file)) return faces.get(file) ?? null;
  let face: FontFace | null = null;
  try {
    const t = tables(readFileSync(file));
    const head = t.get('head');
    const hhea = t.get('hhea');
    const hmtx = t.get('hmtx');
    const cmap = t.get('cmap');
    if (!head || !hhea || !hmtx || !cmap) throw new Error('missing tables');
    const unitsPerEm = head.readUInt16BE(18);
    const metrics = hhea.readUInt16BE(34);
    const glyph = cmapLookup(cmap);
    const adv = (g: number) => hmtx.readUInt16BE(Math.min(g, metrics - 1) * 4);
    const cache = new Map<number, number>();
    face = {
      file,
      unitsPerEm,
      advance(cp) {
        let a = cache.get(cp);
        if (a === undefined) {
          a = adv(glyph(cp));
          cache.set(cp, a);
        }
        return a;
      },
    };
  } catch {
    face = null;
  }
  faces.set(file, face);
  return face;
}

/** A font face a measurer can use: CSS family + weight + style → file. */
export interface FaceFile {
  family: string;
  weight: number;
  style?: 'normal' | 'italic';
  file: string;
}

/**
 * A TextMeasurer over font files: the face of the requested family with the closest weight (and the same style when
 * there is one); the kit's estimate for families without a readable file.
 */
export function fontFileMeasurer(files: FaceFile[]): TextMeasurer & { measured: (font: TextFont) => boolean } {
  const pick = (font: TextFont): FontFace | null => {
    const weight = typeof font.weight === 'string' ? Number.parseInt(font.weight, 10) || 400 : (font.weight ?? 400);
    const family = font.family.replace(/^["']|["']$/g, '');
    const cands = files.filter((f) => f.family === family);
    const styled = cands.filter((f) => (f.style ?? 'normal') === (font.style ?? 'normal'));
    const pool = styled.length ? styled : cands;
    const best = [...pool].sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0];
    return best ? loadFontFace(best.file) : null;
  };
  const measure = ((text: string, font: TextFont) => {
    const face = pick(font);
    if (!face) return estimateTextWidth(text, font);
    const chars = [...text];
    let units = 0;
    for (const ch of chars) units += face.advance(ch.codePointAt(0) ?? 0);
    return (units / face.unitsPerEm) * font.size + (font.letterSpacing ?? 0) * font.size * Math.max(0, chars.length - 1);
  }) as TextMeasurer & { measured: (font: TextFont) => boolean };
  measure.measured = (font) => pick(font) !== null;
  return measure;
}
