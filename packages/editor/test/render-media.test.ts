/**
 * Your own files rendered for real (L2.12, R-OWN-01/02): a video intro and a video outro with their own sound — the
 * intro leaves and the outro enters by the theme's crossfade, and their sound keeps its level through the transition
 * windows (no replayed start ramp, the end ramp where the part ends) —, and alpha overlay videos — VP9 with alpha
 * (.webm) and ProRes 4444 (.mov) — composited over a colour-coded synthetic capture. Pixel checks: the
 * opaque half of the overlay shows its colour, the transparent half shows the capture through it (the capture frame the
 * plan expects), and across the edge no darker fringe (halo) appears. Media are generated here with ffmpeg (lavfi).
 * Needs ffmpeg/ffprobe (libvpx-vp9, prores_ks) and a Chromium headless shell.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Timeline } from '@retake/core';
import { overlayBoxAt, renderVideo } from '@retake/editor';
import type { ClipSegment, RenderRecord } from '@retake/editor';
import { SHARED_CACHE, frameColour, pixelAt, renderWorkspace, syntheticTimeline } from '@retake/test-support/render';
import { hasTool } from '@retake/test-support/repo';
import type { RenderWorkspace } from '@retake/test-support/render';
import { PERSON_POLICY } from '@retake/core';

const can = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const GREEN: [number, number, number] = [0, 255, 0];
const MAGENTA: [number, number, number] = [255, 0, 255];

let ws: RenderWorkspace;
let record: RenderRecord;

/** Overlay over the page rect {600, 240, 600 × 600} (CSS px of the 1920 × 1080 page) at the end of a step. */
function withOverlay(t: Timeline, scene: string, step: { t_start: number; t_end: number }, file: string): void {
  const sc = t.scenes.find((s) => s.id === scene)!;
  t.events.push({
    scene,
    scene_index: sc.index,
    step: 0,
    action: 'hover',
    t_start: step.t_start,
    t_end: step.t_end,
    status: 'ok',
    overlay: { component: 'studio/media', slots: { file }, params: { fit: 'contain', background: 'none' }, box: { rect: { x: 600, y: 240, w: 600, h: 600 } } },
  });
}

beforeAll(async () => {
  if (!can) return;
  ws = await renderWorkspace();
  const assets = join(ws.project.dir, 'assets');
  await mkdir(assets, { recursive: true });
  // The intro: 2 s of magenta with a steady 1 kHz tone; the outro: 2 s of magenta with a 500 Hz tone. The overlays:
  // 64 × 64, the left half opaque green, the right half fully transparent, 1 s — as VP9 + alpha (WebM) and ProRes 4444.
  for (const [name, hz] of [
    ['intro', 1000],
    ['outro', 500],
  ] as const) {
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=0xff00ff:s=160x90:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      `sine=f=${hz}:d=2:sample_rate=48000`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      join(assets, `${name}.mp4`),
    ]);
  }
  const half = 'color=c=black@0:s=64x64:r=30:d=1,format=rgba,geq=r=0:g=255:b=0:a=if(lt(X\\,32)\\,255\\,0)';
  ffmpeg(['-f', 'lavfi', '-i', half, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '20', join(assets, 'half.webm')]);
  ffmpeg(['-f', 'lavfi', '-i', half, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', join(assets, 'half.mov')]);
  const t = syntheticTimeline();
  t.video = { ...t.video, intro: { video: 'assets/intro.mp4' }, outro: { video: 'assets/outro.mp4' } };
  withOverlay(t, 'a', { t_start: 1.1, t_end: 1.2 }, 'assets/half.webm');
  withOverlay(t, 'b', { t_start: 3.2, t_end: 3.3 }, 'assets/half.mov');
  await writeFile(join(ws.runDir, 'timeline.json'), JSON.stringify(t, null, 2));
  record = await renderVideo({
    workPolicy: PERSON_POLICY,
    project: ws.project,
    root: ws.root,
    run: 'latest',
    scenario: 'synthetic',
    overrides: { scale: 0.5 },
    concurrency: 2,
    cacheDir: SHARED_CACHE,
  });
}, LONG);
afterAll(async () => {
  await ws?.cleanup();
});

const close = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe.skipIf(!can)('your own files rendered (Remotion)', () => {
  it(
    'the intro and the outro are your videos (cover), with their own sound; the clips between them are silent',
    () => {
      const plan = record.plan;
      expect(plan.segments.map((s) => `${s.kind}:${s.component.id}`)).toEqual(['intro:studio/media', 'clip:studio/layout-card', 'clip:studio/layout-card', 'outro:studio/media']);
      expect(plan.segments[0].durationInFrames).toBe(60);
      expect(record.encoding.audio).toBe('files');
      expect(close(pixelAt(record.file, 10, 480, 270), MAGENTA, 24)).toBe(true);
      expect(close(pixelAt(record.file, 10, 20, 20), MAGENTA, 24)).toBe(true);
      const rms = (from: number, d: number) => {
        const out = spawnSync(
          'ffmpeg',
          ['-hide_banner', '-ss', String(from), '-t', String(d), '-i', record.file, '-af', 'astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-'],
          { encoding: 'utf8' },
        ).stderr;
        const v = /RMS level dB: (-?[\d.]+|-inf)/.exec(out)?.[1];
        return v === '-inf' || v === undefined ? -Infinity : Number(v);
      };
      expect(rms(0.15, 1.2)).toBeGreaterThan(-30);
      const b = plan.segments[2];
      expect(rms((b.from + 6) / 30, 0.4)).toBeLessThan(-70);
    },
    LONG,
  );

  it(
    "a file's sound keeps its level through the transitions around it: no replayed start ramp, the end ramp at its end",
    () => {
      const plan = record.plan;
      // The decoded sound, one RMS (dB) per output frame (48 kHz: 1600 samples a frame).
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', record.file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 64 * 1024 * 1024 });
      const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
      const db = (frame: number) => {
        let sum = 0;
        for (let i = frame * 1600; i < (frame + 1) * 1600; i++) sum += samples[i] ** 2;
        return 10 * Math.log10(sum / 1600 + 1e-12);
      };
      for (const index of [0, 3]) {
        const seg = plan.segments[index];
        const n = seg.durationInFrames;
        // The intro leaves by a crossfade (the exiting window starts inside it); the outro enters by one.
        const window = index === 0 ? plan.segments[1].transition : seg.transition;
        expect(window, `${seg.kind}: transition`).toMatchObject({ kind: 'crossfade' });
        expect(window!.frames).toBeGreaterThan(4);
        const level = Array.from({ length: n }, (_, f) => db(seg.from + f));
        const plateau = [...level.slice(6, n - 6)].sort((x, y) => x - y)[Math.floor((n - 12) / 2)];
        expect(plateau, `${seg.kind}: level`).toBeGreaterThan(-30);
        // Steady from the end of its start ramp to the start of its end ramp — across the transition window's start
        // (intro) and end (outro).
        for (let f = 5; f < n - 5; f++) expect(Math.abs(level[f] - plateau), `${seg.kind} frame ${f}: ${level[f].toFixed(2)} dB vs ${plateau.toFixed(2)}`).toBeLessThan(1);
        // The 4-frame ramps: 0.25 (−12 dB) on the first and the last frame, 0.5 (−6 dB) on the second and the one before last.
        expect(level[0] - plateau, `${seg.kind}: first frame`).toBeLessThan(-6);
        expect(level[n - 1] - plateau, `${seg.kind}: last frame`).toBeLessThan(-6);
        expect(level[n - 2] - plateau, `${seg.kind}: frame before last`).toBeLessThan(-3);
      }
    },
    LONG,
  );

  for (const [scene, format] of [
    ['a', 'VP9 with alpha (.webm)'],
    ['b', 'ProRes 4444 (.mov)'],
  ] as const) {
    it(
      `an alpha overlay video — ${format}: opaque pixels show it, transparent pixels the capture, no halo at the edge`,
      () => {
        const plan = record.plan;
        const clip = plan.segments.find((s): s is ClipSegment => s.kind === 'clip' && s.id === scene)!;
        const use = clip.overlays[0];
        expect(use.component).toMatchObject({ id: 'studio/media', media: { file: { kind: 'video', alpha: true } } });
        const local = use.from + 3;
        const f = clip.from + local;
        const box = overlayBoxAt(plan, clip, use, local)!;
        // The 64 × 64 file contained in the 600 × 600 page rect → a square of 243.75 output px (half size: 780 / 1920).
        expect(box.w).toBeCloseTo(600 * (780 / 1920), 1);
        const y = Math.round(box.y + box.h / 2);
        const capture = frameColour(clip.srcFrames[local]);
        // Outside the box: the capture; the left (opaque) half: green; the right (transparent) half: the capture.
        expect(close(pixelAt(record.file, f, box.x - 20, y), capture, 14), 'beside the box').toBe(true);
        expect(close(pixelAt(record.file, f, box.x + box.w * 0.25, y), GREEN, 30), 'opaque half').toBe(true);
        const through = pixelAt(record.file, f, box.x + box.w * 0.75, y);
        expect(close(through, capture, 14), `transparent half ${through} vs capture ${capture}`).toBe(true);
        // Across the edge (x = the middle of the box): each pixel is between green and the capture, never darker (halo).
        const mid = box.x + box.w / 2;
        for (let dx = -6; dx <= 6; dx++) {
          const [r, g, b] = pixelAt(record.file, f, mid + dx, y);
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const lo = Math.min(0.7152 * 255, 0.2126 * capture[0] + 0.7152 * capture[1] + 0.0722 * capture[2]);
          expect(lum, `edge dx ${dx}: rgb ${r},${g},${b}`).toBeGreaterThanOrEqual(lo - 12);
        }
      },
      LONG,
    );
  }
});
