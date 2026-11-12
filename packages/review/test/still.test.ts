/**
 * The still of a frame comment (L3.6, review extractStill), on videos whose every frame differs: frame n is a flat grey
 * of video level 16 + (7·n) mod 220, so a still one frame off reads 8 RGB levels away. A 4K master is scaled to 1920 px; a region
 * is outlined (drawMarks' stroke colour on its edge, the inside untouched, no numbered badge), on the scaled still, its
 * stroke sized from the long side.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewError, extractStill } from '../src/index.js';
import { hasTool } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

const can = hasTool('ffmpeg') && hasTool('ffprobe');
let dir: string;

/** A CFR video of `frames` frames whose frame n is a flat grey of video level 16 + (7·n) mod 220 (lossless). */
function counterVideo(file: string, w: number, h: number, frames: number): void {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `nullsrc=s=${w}x${h}:r=30,geq=lum='16+mod(N*7\\,220)':cb=128:cr=128`,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-qp',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '15',
    file,
  ]);
}

/** Mean brightness of an image file, and its pixel at (x, y). */
async function look(file: string, x = 0, y = 0): Promise<{ mean: number; width: number; height: number; at: number[] }> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  const o = (y * info.width + x) * info.channels;
  return { mean: sum / (data.length / info.channels), width: info.width, height: info.height, at: [data[o], data[o + 1], data[o + 2]] };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retake-still-'));
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe.skipIf(!can)('extractStill', () => {
  it('is the exact frame: first, middle, last — each distinct from its neighbours', async () => {
    const video = join(dir, 'counter.mp4');
    counterVideo(video, 320, 180, 60);
    // Limited-range video: level 16 + L decodes to the RGB grey L·255/219.
    const expected = (n: number) => (((7 * n) % 220) * 255) / 219;
    for (const f of [0, 1, 17, 18, 31, 59]) {
      const out = join(dir, `still-${f}.jpg`);
      const r = await extractStill(video, f, out, { policy: PERSON_POLICY });
      expect(r).toMatchObject({ width: 320, height: 180 });
      expect(r.bytes).toBeGreaterThan(0);
      const { mean } = await look(out);
      expect(Math.abs(mean - expected(f)), `frame ${f}: mean ${mean.toFixed(1)}, expected ${expected(f).toFixed(1)}`).toBeLessThan(2.5);
    }
    // Past the end: refused.
    await expect(extractStill(video, 60, join(dir, 'past.jpg'), { policy: PERSON_POLICY })).rejects.toThrow(ReviewError);
    await expect(extractStill(video, -1, join(dir, 'neg.jpg'), { policy: PERSON_POLICY })).rejects.toThrow(/not a frame number/);
  });

  it('scales a 4K master to 1920 px on its long side', async () => {
    const video = join(dir, 'uhd.mp4');
    counterVideo(video, 3840, 2160, 3);
    const out = join(dir, 'uhd.jpg');
    expect(await extractStill(video, 2, out, { policy: PERSON_POLICY })).toMatchObject({ width: 1920, height: 1080 });
    const { width, height, mean } = await look(out);
    expect([width, height]).toEqual([1920, 1080]);
    expect(Math.abs(mean - (14 * 255) / 219)).toBeLessThan(2.5);
  });

  it('outlines the region: the stroke colour on its edge, the frame untouched inside and outside', async () => {
    const video = join(dir, 'region.mp4');
    counterVideo(video, 640, 360, 30);
    const out = join(dir, 'region.jpg');
    const region = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 };
    await extractStill(video, 20, out, { policy: PERSON_POLICY, region });
    // Left edge of the box, half-way down: the mark colour (#ff2d78), red well above green.
    const edge = (await look(out, 320 + 1, 180 + 45)).at;
    expect(edge[0] - edge[1], `edge ${edge}`).toBeGreaterThan(120);
    // Inside and outside the box: the frame's grey.
    // Inside and outside the box, and where a numbered badge would sit (above its top-left corner): the frame's grey.
    for (const [x, y] of [
      [400, 230],
      [100, 100],
      [330, 168],
      [326, 160],
    ]) {
      const [r, g, b] = (await look(out, x, y)).at;
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${x},${y}`).toBeLessThan(8);
    }
    await expect(extractStill(video, 1, join(dir, 'bad.jpg'), { policy: PERSON_POLICY, region: { x: 0.9, y: 0, w: 0.2, h: 0.1 } })).rejects.toThrow(/inside the frame/);
  });

  it('a region on a 4K master is drawn on the scaled still (1920 px), where it lies in the frame', async () => {
    const video = join(dir, 'uhd-region.mp4');
    counterVideo(video, 3840, 2160, 2);
    const out = join(dir, 'uhd-region.jpg');
    expect(await extractStill(video, 1, out, { policy: PERSON_POLICY, region: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 } })).toMatchObject({ width: 1920, height: 1080 });
    // The box's left edge on the still: x 960, y 540..810.
    const edge = (await look(out, 961, 675)).at;
    expect(edge[0] - edge[1], `edge ${edge}`).toBeGreaterThan(120);
    const inside = (await look(out, 1100, 675)).at;
    expect(Math.max(...inside) - Math.min(...inside)).toBeLessThan(8);
  });

  it("the stroke is sized from the long side: a vertical still gets the landscape still's stroke", async () => {
    const video = join(dir, 'vertical.mp4');
    counterVideo(video, 1080, 1920, 2);
    const out = join(dir, 'vertical.jpg');
    await extractStill(video, 1, out, { policy: PERSON_POLICY, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.25 } });
    // Long side 1920 → scale 1.5 → a 3 px stroke from x 270: columns 270..272 pink, 274 grey.
    for (const x of [270, 272]) {
      const at = (await look(out, x, 700)).at;
      expect(at[0] - at[1], `x ${x}: ${at}`).toBeGreaterThan(100);
    }
    const past = (await look(out, 275, 700)).at;
    expect(past[0] - past[1], `x 275: ${past}`).toBeLessThan(60);
  });
});
