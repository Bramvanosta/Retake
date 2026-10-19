/**
 * Contact sheets with sharp: a grid of thumbnails, each with its timecode, frame number and segment / step label
 * (one SVG per page drawn over the tiles), a header line, tiles outlined in red / orange where a finding points, and
 * pagination (`<name>.jpg`, `<name>_p2.jpg`, …).
 */
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { Severity, SheetLayout } from './types.js';

export interface Tile {
  frame: number;
  /** Raw RGB thumbnail. */
  data: Buffer;
  width: number;
  height: number;
  /** First label line (timecode · frame) and second (segment · step · marker). */
  label: string;
  sub: string;
  /** Outline colour: a finding points at this tile. */
  mark?: Severity;
}

const GAP = 8;
const LABEL_H = 40;
const HEADER_H = 58;
const BG = '#17171b';
const FONT = "DejaVu Sans, Inter, Helvetica, Arial, sans-serif";
const MARK_COLOURS: Record<Severity, string> = { error: '#ff3b30', warning: '#ff9f0a', info: '#64a8ff' };

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Cut a label to roughly `max` characters (labels are drawn at a fixed size). */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Thumbnail of a raw RGB frame (area-averaged), as raw RGB. */
export async function makeTile(img: { width: number; height: number; data: Buffer }, width: number): Promise<{ data: Buffer; width: number; height: number }> {
  const w = Math.max(16, Math.min(width, img.width));
  const h = Math.max(9, Math.round((img.height * w) / img.width));
  const data = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).resize(w, h, { kernel: 'lanczos3' }).raw().toBuffer();
  return { data, width: w, height: h };
}

/** The file of page `p` (1-based) of a sheet whose first page is `base` (".jpg"). */
export function pageFile(base: string, p: number): string {
  return p === 1 ? base : base.replace(/\.jpg$/, `_p${p}.jpg`);
}

/**
 * Write the pages of a sheet: at most `layout.columns × layout.rows` tiles per page, shared evenly between the pages
 * (tiles keep their size). Returns the files written (none for no tiles).
 */
export async function writeSheet(tiles: Tile[], opts: { file: string; title: string; subtitle?: string; layout: SheetLayout; quality?: number }): Promise<string[]> {
  if (tiles.length === 0) return [];
  const { columns, rows } = opts.layout;
  // Pages share the tiles evenly (61 tiles on 60-tile pages: 31 + 30, not 60 + 1).
  const pages = Math.ceil(tiles.length / Math.max(1, columns * rows));
  const per = Math.ceil(tiles.length / pages);
  const tw = Math.max(...tiles.map((t) => t.width));
  const th = Math.max(...tiles.map((t) => t.height));
  const cols = Math.min(columns, tiles.length);
  const width = cols * tw + (cols + 1) * GAP;
  const maxChars = Math.max(12, Math.floor(tw / 7.6));
  const files: string[] = [];
  for (let p = 0; p < pages; p++) {
    const pageTiles = tiles.slice(p * per, (p + 1) * per);
    const nrows = Math.ceil(pageTiles.length / cols);
    const height = HEADER_H + nrows * (th + LABEL_H + GAP) + GAP;
    const composites: sharp.OverlayOptions[] = [];
    const svg: string[] = [];
    const title = `${opts.title}${pages > 1 ? `  ·  page ${p + 1}/${pages}` : ''}`;
    svg.push(`<text x="${GAP + 2}" y="26" font-family="${FONT}" font-size="20" font-weight="bold" fill="#f2f2f5">${escapeXml(clip(title, Math.floor(width / 11)))}</text>`);
    if (opts.subtitle) svg.push(`<text x="${GAP + 2}" y="48" font-family="${FONT}" font-size="14" fill="#a9a9b3">${escapeXml(clip(opts.subtitle, Math.floor(width / 7.4)))}</text>`);
    pageTiles.forEach((t, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = GAP + c * (tw + GAP);
      const y = HEADER_H + r * (th + LABEL_H + GAP);
      composites.push({ input: t.data, raw: { width: t.width, height: t.height, channels: 3 }, left: x, top: y });
      if (t.mark) {
        svg.push(`<rect x="${x + 2}" y="${y + 2}" width="${t.width - 4}" height="${t.height - 4}" fill="none" stroke="${MARK_COLOURS[t.mark]}" stroke-width="4"/>`);
      }
      svg.push(`<text x="${x + 2}" y="${y + th + 17}" font-family="${FONT}" font-size="14" font-weight="bold" fill="#f2f2f5">${escapeXml(clip(t.label, maxChars))}</text>`);
      svg.push(`<text x="${x + 2}" y="${y + th + 34}" font-family="${FONT}" font-size="13" fill="${t.mark ? MARK_COLOURS[t.mark] : '#b8b8c2'}">${escapeXml(clip(t.sub, maxChars + 2))}</text>`);
    });
    composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg.join('')}</svg>`), left: 0, top: 0 });
    const out = pageFile(opts.file, p + 1);
    const jpeg = await sharp({ create: { width, height, channels: 3, background: BG } })
      .composite(composites)
      .jpeg({ quality: opts.quality ?? 84, mozjpeg: true })
      .toBuffer();
    await writeFile(out, jpeg);
    files.push(out);
  }
  return files;
}

/** A JPEG ≤ `maxPx` on its long side (base64) of an image file. */
export async function thumbnailOf(file: string, maxPx: number): Promise<{ base64: string; width: number; height: number; bytes: number }> {
  const { data, info } = await sharp(file).resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { base64: data.toString('base64'), width: info.width, height: info.height, bytes: data.length };
}

/** A numbered box drawn by `drawMarks`, in the image's pixels. */
export interface MarkBox {
  mark: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const MARK_STROKE = '#ff2d78';

/**
 * A page inspection's marked screenshot (L3.3): each box outlined, its number on a filled badge at its top-left corner
 * (inside the image), written as a JPEG. `scale` is the image's device pixels per CSS px: badges and strokes keep their
 * CSS size (labels ≥ 20 CSS px, readable once the image is thumbnailed to 1280 px). Returns the size written. `png`: an
 * image file, or an encoded image in memory (a frame comment's still, L3.6). `badge: false`: the outlines only (a frame
 * comment's single region — a numbered badge would read as one of the video's own step badges and hide its pixels).
 */
export async function drawMarks(
  png: string | Buffer,
  boxes: readonly MarkBox[],
  out: string,
  opts: { scale?: number; quality?: number; badge?: boolean } = {},
): Promise<{ width: number; height: number; marks: number }> {
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const s = Math.max(0.5, opts.scale ?? 1);
  const font = Math.round(20 * s);
  const stroke = Math.max(2, Math.round(2 * s));
  const svg: string[] = [];
  let marks = 0;
  for (const b of boxes) {
    const x = Math.max(0, Math.min(width - 1, Math.round(b.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(b.y)));
    const w = Math.min(width - x, Math.round(b.w + (b.x < 0 ? b.x : 0)));
    const h = Math.min(height - y, Math.round(b.h + (b.y < 0 ? b.y : 0)));
    if (w < 2 || h < 2) continue;
    marks++;
    svg.push(`<rect x="${x + stroke / 2}" y="${y + stroke / 2}" width="${Math.max(1, w - stroke)}" height="${Math.max(1, h - stroke)}" fill="none" stroke="${MARK_STROKE}" stroke-width="${stroke}"/>`);
    if (opts.badge === false) continue;
    const label = String(b.mark);
    const bw = Math.round(font * (0.62 * label.length + 0.5));
    const bh = Math.round(font * 1.25);
    const bx = Math.min(x, width - bw);
    const by = y >= bh ? y - bh : Math.min(y, height - bh);
    svg.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${Math.round(font * 0.2)}" fill="${MARK_STROKE}"/>`);
    svg.push(`<text x="${bx + bw / 2}" y="${by + bh * 0.78}" text-anchor="middle" font-family="${FONT}" font-size="${font}" font-weight="bold" fill="#ffffff">${label}</text>`);
  }
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg.join('')}</svg>`);
  const jpeg = await sharp(png)
    .flatten({ background: '#ffffff' })
    .composite([{ input: overlay, left: 0, top: 0 }])
    .jpeg({ quality: opts.quality ?? 82, mozjpeg: true })
    .toBuffer();
  await writeFile(out, jpeg);
  return { width, height, marks };
}
