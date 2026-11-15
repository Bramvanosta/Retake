/**
 * The declared size of a logo-like image, read from its bytes (pure, browser-safe: Uint8Array only): a PNG, JPEG or
 * WebP from its header, an SVG from its root element's width / height, else its viewBox. A size parse only — the
 * security scan of an SVG a theme copies is the engine's (`scanSvg`). Never throws: a file it cannot read has no size.
 * The loader records a theme's logo aspect with it (LoadedTemplate.assets.logo_aspect); the rule a logo kind follows
 * when template.yaml names none is the theme tokens' (`@retake/components` resolveLogoKind: 3:1 and wider is a
 * wordmark).
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'svg';

export interface ImageSize {
  format: ImageFormat;
  width: number;
  height: number;
}

/** The logo kinds of a theme: a mark (a pictogram, drawn beside the brand name) or a wordmark (the name itself). */
export const LOGO_KINDS = ['mark', 'wordmark'] as const;
export type LogoKind = (typeof LOGO_KINDS)[number];

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + ((b[i + 3] << 24) >>> 0);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** Size of a PNG, JPEG or WebP from its header; undefined when the bytes are none of them (or end too early). */
export function rasterSize(b: Uint8Array): ImageSize | undefined {
  if (b.length >= 24 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a && ascii(b, 12, 16) === 'IHDR') {
    return { format: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = u16be(b, i + 2);
      if (len < 2) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7) };
      }
      i += 2 + len;
    }
    return undefined;
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    const chunk = ascii(b, 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = u32le(b, 21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { format: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return undefined;
}

/**
 * The size an SVG declares on its root `<svg>` (XML comments skipped, an unclosed one to the end of the text: a
 * fake root inside a comment is never read): its width and height (plain numbers or px) when both are given; with one
 * of them, or none, and a valid viewBox, the viewBox's proportions (the missing side derived from the given one, both
 * the viewBox's when neither is given) — a width or a height alone is in other units than the viewBox. Undefined when
 * nothing gives a positive size.
 */
export function svgSize(text: string): { width: number; height: number } | undefined {
  const plain = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, '');
  const root = /<\s*(?:[a-z_][\w.-]*:)?svg\b([^>]*)>/i.exec(plain);
  if (!root) return undefined;
  const attr = (name: string) => new RegExp(`[\\s"']${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root[1])?.[1];
  const num = (v: string | undefined) => {
    const n = v !== undefined && /^\s*[\d.]+\s*(?:px)?\s*$/.test(v) ? Number.parseFloat(v) : undefined;
    return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const width = num(attr('width'));
  const height = num(attr('height'));
  if (width !== undefined && height !== undefined) return { width, height };
  const vb = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb?.length !== 4 || !vb.every(Number.isFinite) || !(vb[2] > 0) || !(vb[3] > 0)) return undefined;
  if (width !== undefined) return { width, height: (width * vb[3]) / vb[2] };
  if (height !== undefined) return { width: (height * vb[2]) / vb[3], height };
  return { width: vb[2], height: vb[3] };
}

/** The widest and narrowest logo aspect read as one (beyond: a degenerate size, read as none). */
export const ASPECT_MIN = 1e-3;
export const ASPECT_MAX = 1e3;

/** width / height to 4 decimals, or undefined when it is not finite or lies outside ASPECT_MIN…ASPECT_MAX. */
export function aspectOf(width: number | undefined, height: number | undefined): number | undefined {
  if (width === undefined || height === undefined) return undefined;
  const a = width / height;
  if (!Number.isFinite(a) || a < ASPECT_MIN || a > ASPECT_MAX) return undefined;
  return Math.round(a * 1e4) / 1e4;
}

/** Width / height of an image file's bytes by its extension (.svg read as UTF-8 text), to 4 decimals; undefined when it gives no sane size. */
export function imageAspect(bytes: Uint8Array, ext: string): number | undefined {
  let size: { width: number; height: number } | undefined;
  if (ext.toLowerCase() === '.svg') {
    try {
      size = svgSize(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    } catch {
      size = undefined;
    }
  } else size = rasterSize(bytes);
  if (!size || !(size.width > 0) || !(size.height > 0)) return undefined;
  return aspectOf(size.width, size.height);
}

/** How many first bytes of an image `imageAspect` needs at most: the SVG root or the JPEG frame header lies within. */
export const IMAGE_SIZE_HEAD_BYTES = 256 * 1024;
