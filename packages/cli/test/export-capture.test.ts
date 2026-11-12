/**
 * `retake export-capture` (L2.13) on the synthetic run of the render tests: a colour-coded capture whose frame n has
 * its own colour and no kept screencast frames (the video fallback), so each clip frame tells which capture frame it
 * shows — at 60 fps every capture frame twice (repeated, not interpolated), the page load of scene b left out. Also
 * the summary, `--json` and the usage errors of `export-capture` and `run --raw`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo } from '../src/index.js';
import { frameOfColour, hasTool, pixelAt, renderWorkspace, RUN_ID } from '../../editor/test/render-helpers.js';
import type { RenderWorkspace } from '../../editor/test/render-helpers.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 300_000;
let ws: RenderWorkspace;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws.root, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  if (canRun) ws = await renderWorkspace();
}, LONG);
afterAll(async () => {
  await ws?.cleanup();
});

describe.skipIf(!canRun)('retake export-capture', () => {
  it(
    '--fps 60 --json: a clip per scene, each capture frame shown twice, the page load out, from the CFR video',
    async () => {
      const r = await retake('export-capture', 'demo', 'latest', '--scenario', 'synthetic', '--fps', '60', '--json');
      expect(r.code, r.err).toBe(EXIT.ok);
      const m = JSON.parse(r.out) as {
        settings: { fps: number; frames_from: string; cursor: string };
        clips: Array<{ file: string; frames: number; timecode: string; seq_start_frame: number }>;
        sequence: { frames: number };
        notes: string[];
        markers: { count: Record<string, number> };
      };
      expect(m.settings).toMatchObject({ fps: 60, frames_from: 'capture video', cursor: 'baked' });
      expect(m.clips.map((c) => [c.file, c.frames, c.timecode])).toEqual([
        ['clips/01-a.mp4', 60, '00:00:00:00'],
        ['clips/02-b.mp4', 54, '00:00:01:00'],
      ]);
      expect(m.sequence.frames).toBe(114);
      expect(m.notes.some((n) => /did not keep its screencast frames/.test(n) && /repeated for 60 fps \(not interpolated\)/.test(n))).toBe(true);
      expect(m.markers.count).toMatchObject({ scene: 2, caption: 1 });
      const dir = join(ws.project.dir, 'exports', `${RUN_ID}-raw-mp460-baked`);
      // Scene a: capture 1.0–2.0 s → capture frames 30…59, each twice.
      const a = join(dir, 'clips', '01-a.mp4');
      expect([0, 1, 2, 3, 58, 59].map((k) => frameOfColour(pixelAt(a, k, 960, 540)))).toEqual([30, 30, 31, 31, 59, 59]);
      // Scene b opens a page until 3.1 s: its clip starts at capture frame 93.
      const b = join(dir, 'clips', '02-b.mp4');
      expect([0, 1, 53].map((k) => frameOfColour(pixelAt(b, k, 960, 540)))).toEqual([93, 93, 119]);
      for (const f of ['README.md', 'markers/synthetic.fcpxml', 'markers/synthetic.edl', 'markers/synthetic.otio', 'cursor/cursor.csv']) expect(existsSync(join(dir, f)), f).toBe(true);
    },
    LONG,
  );

  it(
    'prints a summary per clip with the markers and the manifest',
    async () => {
      const r = await retake('export-capture', 'demo', RUN_ID, '--out', join(ws.root, 'raw-30'));
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toMatch(new RegExp(`raw export of ${RUN_ID} → .*raw-30`));
      expect(r.err).toMatch(/✓ clips\/01-a\.mp4 +1920×1080 30 frames 1\.00 s @ 00:00:00:00/);
      expect(r.err).toMatch(/✓ clips\/02-b\.mp4 +1920×1080 27 frames 0\.90 s @ 00:00:01:00/);
      expect(r.err).toMatch(/markers 2 scene, 1 caption: markers\/synthetic\.fcpxml, markers\/synthetic\.edl, markers\/synthetic\.otio/);
      expect(existsSync(join(ws.root, 'raw-30', 'manifest.json'))).toBe(true);
    },
    LONG,
  );

  it(
    'reports bad options, a cursor the run cannot give, and raw flags without --raw',
    async () => {
      const fps = await retake('export-capture', 'demo', 'latest', '--fps', '25');
      expect(fps.code).toBe(EXIT.usage);
      const none = await retake('export-capture', 'demo', 'latest', '--cursor', 'none');
      expect(none.code).toBe(EXIT.failure);
      expect(none.err).toContain('--cursor none needs a run captured without it');
      const missing = await retake('export-capture', 'demo', 'nope');
      expect(missing.code).toBe(EXIT.failure);
      expect(missing.err).toContain('run "nope" not found');
      const stray = await retake('run', 'demo', 'synthetic', '--cursor', 'none');
      expect(stray.code).toBe(EXIT.usage);
      expect(stray.err).toContain('--cursor shapes the raw export: add --raw');
      const dry = await retake('run', 'demo', 'synthetic', '--raw', '--dry');
      expect(dry.code).toBe(EXIT.usage);
      expect(dry.err).toContain('--raw exports a capture');
    },
    LONG,
  );
});
