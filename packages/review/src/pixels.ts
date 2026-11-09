/**
 * Pixel statistics of RGB frames (pure JS over raw rgb24 buffers): uniformity of a region (blank / loading frames),
 * ink in a text area, coarse luminance signatures to tell whether two frames differ — and a few image helpers for
 * tests (read a PNG/JPEG/video frame as RGB, bounding boxes, solid rectangles).
 */
import { execFileSync } from 'node:child_process';
import { ffmpegBin, ffprobeBin } from '@retake/core/io';
import type { WorkPolicy } from '@retake/core';

export interface RgbImage {
  width: number;
  height: number;
  /** rgb24, row-major. */
  data: Buffer;
}

export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionStats {
  /** Share of the sampled pixels within a few levels of the region's median colour. */
  share: number;
  /** Standard deviation of the luminance (0–255). */
  sd: number;
  /** Mean luminance. */
  mean: number;
  /** Median colour. */
  median: [number, number, number];
}

/** Integer pixel bounds of a rect clamped to the image (x0, y0 inclusive; x1, y1 exclusive). */
function bounds(img: Pick<RgbImage, 'width' | 'height'>, r: RegionRect): [number, number, number, number] {
  const x0 = Math.max(0, Math.min(img.width, Math.round(r.x)));
  const y0 = Math.max(0, Math.min(img.height, Math.round(r.y)));
  const x1 = Math.max(x0, Math.min(img.width, Math.round(r.x + r.w)));
  const y1 = Math.max(y0, Math.min(img.height, Math.round(r.y + r.h)));
  return [x0, y0, x1, y1];
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Uniformity of a region (sampled every `step` px): share of pixels near the median colour, luminance sd. */
export function regionStats(img: RgbImage, rect: RegionRect, opts: { step?: number; tolerance?: number } = {}): RegionStats {
  const step = Math.max(1, Math.round(opts.step ?? Math.max(1, Math.min(img.width, img.height) / 270)));
  const tol = opts.tolerance ?? 12;
  const [x0, y0, x1, y1] = bounds(img, rect);
  const hr = new Uint32Array(256);
  const hg = new Uint32Array(256);
  const hb = new Uint32Array(256);
  let n = 0;
  let s = 0;
  let s2 = 0;
  const d = img.data;
  for (let y = y0; y < y1; y += step) {
    let i = (y * img.width + x0) * 3;
    for (let x = x0; x < x1; x += step, i += 3 * step) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      hr[r]++;
      hg[g]++;
      hb[b]++;
      const l = lum(r, g, b);
      s += l;
      s2 += l * l;
      n++;
    }
  }
  if (n === 0) return { share: 1, sd: 0, mean: 0, median: [0, 0, 0] };
  const med = (h: Uint32Array) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc * 2 >= n) return v;
    }
    return 255;
  };
  const median: [number, number, number] = [med(hr), med(hg), med(hb)];
  let near = 0;
  for (let y = y0; y < y1; y += step) {
    let i = (y * img.width + x0) * 3;
    for (let x = x0; x < x1; x += step, i += 3 * step) {
      if (Math.abs(d[i] - median[0]) + Math.abs(d[i + 1] - median[1]) + Math.abs(d[i + 2] - median[2]) <= tol) near++;
    }
  }
  const mean = s / n;
  return { share: near / n, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)), mean, median };
}

/** A coarse luminance signature of a region: `cols × rows` block means (area average, sampled every `step` px). */
export function signature(img: RgbImage, rect: RegionRect, cols = 96, rows = 54): Float32Array {
  const [x0, y0, x1, y1] = bounds(img, rect);
  const out = new Float32Array(cols * rows);
  const cnt = new Uint32Array(cols * rows);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const step = Math.max(1, Math.floor(Math.min(w / cols, h / rows) / 3));
  const d = img.data;
  for (let y = y0; y < y1; y += step) {
    const row = Math.min(rows - 1, Math.floor(((y - y0) * rows) / h));
    for (let x = x0; x < x1; x += step) {
      const col = Math.min(cols - 1, Math.floor(((x - x0) * cols) / w));
      const i = (y * img.width + x) * 3;
      out[row * cols + col] += lum(d[i], d[i + 1], d[i + 2]);
      cnt[row * cols + col]++;
    }
  }
  for (let k = 0; k < out.length; k++) out[k] = cnt[k] ? out[k] / cnt[k] : 0;
  return out;
}

/** How much two signatures differ: mean absolute difference (levels) and the share of cells off by more than `tol`. */
export function compareSignatures(a: Float32Array, b: Float32Array, tol = 12): { mad: number; changed: number } {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { mad: 0, changed: 0 };
  let sum = 0;
  let changed = 0;
  for (let k = 0; k < n; k++) {
    const dlt = Math.abs(a[k] - b[k]);
    sum += dlt;
    if (dlt > tol) changed++;
  }
  return { mad: sum / n, changed: changed / n };
}

/** Is a region blank (uniform) or near-uniform (an empty page with a spinner, a loading page)? */
export function uniformity(stats: RegionStats, rules: { uniform_share: number; uniform_sd: number; near_uniform_share: number }): 'blank' | 'near-uniform' | undefined {
  if (stats.share >= rules.uniform_share || stats.sd < rules.uniform_sd) return 'blank';
  if (stats.share >= rules.near_uniform_share) return 'near-uniform';
  return undefined;
}

// ── Helpers for tests and tools ─────────────────────────────────────────────────

/** Any image or video file (its first frame) as RGB, through ffmpeg. */
export function readImage(file: string, policy: WorkPolicy, frame = 0): RgbImage {
  const probe = execFileSync(ffprobeBin(policy), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [width, height] = probe.split('\n')[0].split(',').map(Number);
  const args = ['-v', 'error', '-i', file];
  if (frame > 0) args.push('-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough');
  args.push('-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const data = execFileSync(ffmpegBin(policy), args, { maxBuffer: width * height * 3 + 1024 });
  return { width, height, data };
}

export type Rgb = [number, number, number];

export function pixel(img: RgbImage, x: number, y: number): Rgb {
  const i = (Math.round(y) * img.width + Math.round(x)) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

export const colourDistance = (a: Rgb, b: Rgb) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/** Bounding box (inclusive) of the pixels of a region matching `pred`, with their count. */
export function bbox(img: RgbImage, region: RegionRect, pred: (p: Rgb) => boolean): { x0: number; y0: number; x1: number; y1: number; count: number } | undefined {
  const [rx0, ry0, rx1, ry1] = bounds(img, region);
  let b: { x0: number; y0: number; x1: number; y1: number; count: number } | undefined;
  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      if (!pred(pixel(img, x, y))) continue;
      if (!b) b = { x0: x, y0: y, x1: x, y1: y, count: 0 };
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
      b.count++;
    }
  }
  return b;
}
