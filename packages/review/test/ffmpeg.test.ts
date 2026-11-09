/**
 * Frame extraction in one ffmpeg pass: hundreds of frames at once (ffmpeg 9 refuses `select` expressions nested more
 * than 100 deep, which a flat `eq(n,a)+eq(n,b)+…` reached past 100 frames), each delivered frame being the one asked.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFrames, selectExpr } from '../src/ffmpeg.js';
import { PERSON_POLICY } from '@retake/core';

let dir: string;
let ramp: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retake-ffmpeg-'));
  ramp = join(dir, 'ramp.mkv');
  // Lossless 64×36 video, 750 frames at 30 fps: every pixel of frame n is grey n mod 256.
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', "nullsrc=s=64x36:r=30:d=25,format=gbrp,geq=r='mod(N\\,256)':g='mod(N\\,256)':b='mod(N\\,256)'",
    '-c:v', 'ffv1', '-pix_fmt', 'gbrp', ramp,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractFrames', () => {
  it('builds a balanced select expression (log2 depth)', () => {
    expect(selectExpr([])).toBe('0');
    expect(selectExpr([4])).toBe('eq(n\\,4)');
    expect(selectExpr([1, 2, 3])).toBe('(eq(n\\,1)+(eq(n\\,2)+eq(n\\,3)))');
    const depth = (s: string) => [...s].reduce((acc, c) => {
      const d = acc.d + (c === '(' ? 1 : c === ')' ? -1 : 0);
      return { d, max: Math.max(acc.max, d) };
    }, { d: 0, max: 0 }).max;
    expect(depth(selectExpr(Array.from({ length: 1000 }, (_, i) => i)))).toBeLessThanOrEqual(11); // 10 levels + eq()
  });

  it('delivers 250 frames of one video in one pass, each the frame asked for', async () => {
    const wanted = Array.from({ length: 250 }, (_, i) => i * 3 + 1);
    const got: Array<[number, number]> = [];
    const delivered = await extractFrames(ramp, [...wanted, 900], { policy: PERSON_POLICY, width: 64, height: 36, videoWidth: 64, videoHeight: 36 }, (frame, img) => {
      got.push([frame, img.data[0]]);
    });
    expect(delivered).toEqual(wanted); // frame 900 lies past the end
    for (const [frame, grey] of got) expect(grey).toBe(frame % 256);
  });
});
