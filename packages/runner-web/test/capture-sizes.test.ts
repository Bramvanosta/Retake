import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRecord, Timeline } from '@retake/core';
import { runScenario } from '../src/index.js';
import { SIZES_PAGE } from './pages.js';
import { FAST, debugTemplate, execFileP, frameAt, magentaCentroid, makeScenario, startServer } from '@retake/test-support/capture';
import { jpegSize, makeProject, readTimeline, tempDir } from './helpers.js';
import type { TestServer } from '@retake/test-support/capture';
import { PERSON_POLICY } from '@retake/core';

// Calibrated on the Mac Retake is made for (frame rates, freezes, paint and wait timings): skipped on a shared CI
// runner, where ci.yml sets RETAKE_TEST_SHARED_RUNNER=1 (fewer cores, no GPU).
const MAC_TIMING = process.env.RETAKE_TEST_SHARED_RUNNER !== '1';

/**
 * R-GOAL-01 / R-REC-06 (L1.4): real captures at the virtual sizes the tool promises — 2560×1440, 4K (1920×1080 at
 * scale 2) and a phone (390×844 at scale 2) — each one short scene: the page reports the size it laid out at, one
 * click with the debug cursor, a hold. The video has width·scale × height·scale pixels at 30 fps, the page laid out
 * at the virtual width (a phone gets the narrow layout), and the drawn hotspot lands on the click point at that
 * scale. 4K keeps no frames (`keep_frames: false`); the others keep them, each JPEG at the device-pixel size.
 */
let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/sizes.html': SIZES_PAGE });
  dir = await tempDir('rw-sizes-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface Case {
  name: string;
  width: number;
  height: number;
  scale: 1 | 2;
  button: string;
  keepFrames?: false;
}

const CASES: Case[] = [
  { name: '2560x1440', width: 2560, height: 1440, scale: 1, button: 'Continue' },
  { name: '4k', width: 1920, height: 1080, scale: 2, button: 'Continue', keepFrames: false },
  { name: 'mobile', width: 390, height: 844, scale: 2, button: 'Menu' },
];

async function capture(c: Case): Promise<{ rec: RunRecord; tl: Timeline }> {
  const project = makeProject(dir, { app: server.url }, { width: c.width, height: c.height });
  const rec = await runScenario({
    policy: PERSON_POLICY,
    project,
    template: debugTemplate(),
    mode: 'capture',
    runId: `sizes-${c.name}`,
    scenario: makeScenario(`sizes-${c.name}`, {
      pacing: FAST,
      capture: { scale: c.scale, ...(c.keepFrames === false ? { keep_frames: false } : {}) },
      scenes: [
        {
          id: 'size',
          open: '/sizes.html',
          steps: [
            // The page laid out at the virtual size, at the device scale (innerWidth / devicePixelRatio).
            { assert: { text: `viewport ${c.width}x${c.height} @${c.scale}` }, timeout: 0 },
            // A longer approach than FAST pacing gives: enough frames to measure the frame interval during a move.
            { click: { text: c.button, move_ms: 600 } },
            { hold: 0.3 },
          ],
        },
      ],
    }),
  });
  expect(rec.error?.message).toBeUndefined();
  expect(rec.status).toBe('succeeded');
  return { rec, tl: await readTimeline(rec.timeline!) };
}

describe('capture at 2560×1440, 4K (scale 2) and a phone (390×844 at scale 2): R-GOAL-01, R-REC-06', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.width}×${c.height} at scale ${c.scale} gives a ${c.width * c.scale}×${c.height * c.scale} video, the hotspot on the click point`, async () => {
      const { rec, tl } = await capture(c);
      const W = c.width * c.scale;
      const H = c.height * c.scale;
      expect(tl.capture).toMatchObject({ file: 'capture.mp4', width: c.width, height: c.height, scale: c.scale, fps: 30 });
      expect(tl.warnings.filter((w) => /screencast frames stay/.test(w))).toEqual([]);
      const probe = JSON.parse((await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,avg_frame_rate', '-of', 'json', rec.capture!])).stdout) as {
        streams: Array<{ width: number; height: number; avg_frame_rate: string }>;
      };
      expect(probe.streams[0]).toMatchObject({ width: W, height: H, avg_frame_rate: '30/1' });

      // R-REC-06: keep_frames: false removes frames/ once capture.mp4 is encoded; the default keeps every frame, each
      // one at the device-pixel size (the browser rendered at that scale: its screencast is never upscaled).
      const framesDir = join(rec.dir, 'frames');
      if (c.keepFrames === false) {
        expect(existsSync(framesDir)).toBe(false);
        expect(existsSync(rec.capture!)).toBe(true);
      } else {
        const files = (await readdir(framesDir)).filter((f) => f.endsWith('.jpg'));
        expect(files.length).toBe(tl.capture.frames);
        for (const f of files) expect(jpegSize(await readFile(join(framesDir, f))), f).toEqual([W, H]);
      }

      // The drawn hotspot (the 6×6 CSS px debug square) at the click: on the point at device scale, 6·scale px wide.
      const click = tl.events.find((e) => e.action === 'click')!;
      expect(click.target?.desc).toContain(c.button);
      const b = click.target!.bbox!;
      expect(click.point!.x).toBeGreaterThan(b.x);
      expect(click.point!.x).toBeLessThan(b.x + b.w);
      const rgb = await frameAt(rec.capture!, click.t_click!, W, H);
      const m = magentaCentroid(rgb, W, H);
      expect(m, `no hotspot at ${click.t_click}`).not.toBeNull();
      // On the point: the frame at the click is painted at that instant on the Mac; a shared runner paints it late,
      // the cursor still on its way.
      if (MAC_TIMING) expect(Math.hypot(m!.x - click.point!.x * c.scale, m!.y - click.point!.y * c.scale)).toBeLessThanOrEqual(3 * c.scale);
      expect(Math.abs(m!.box.w - 6 * c.scale)).toBeLessThanOrEqual(1);
      expect(Math.abs(m!.box.h - 6 * c.scale)).toBeLessThanOrEqual(1);

      // Frame interval while the cursor approaches the button: printed (HANDOFF numbers), bounded loosely only.
      const times = (await readFile(join(rec.dir, 'frames.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { t: number }).t)
        .filter((t) => t >= click.t_start && t <= click.t_click!)
        .sort((x, y) => x - y);
      const gaps = times
        .slice(1)
        .map((t, i) => t - times[i])
        .sort((x, y) => x - y);
      const median = gaps[Math.floor(gaps.length / 2)] * 1000;
      if (process.platform === 'darwin') {
        console.log(`capture ${W}×${H}: ${times.length} frames during the approach, median interval ${median.toFixed(1)} ms, worst ${(gaps[gaps.length - 1] * 1000).toFixed(0)} ms`);
        expect(median).toBeLessThan(100);
      }
    });
  }
});
