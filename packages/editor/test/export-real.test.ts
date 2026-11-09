/**
 * L2.8 on real renders of the tiny synthetic run (colour-coded capture): the square composition (DemoSquare) shows the
 * plan's source frame, a music bed made procedurally (generateTestTrack) loops and is ducked under footage, and
 * exportRender derives 1080p / WebM / GIF from the master and re-renders the square variant, with a manifest.
 * Needs ffmpeg/ffprobe (libvpx-vp9, libopus) and a Chromium headless shell.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProjectTemplate, readJson, fileFacts } from '@retake/core/io';
import type { Timeline } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import { exportRender, generateTestTrack, gifWindow, planEdit, renderStill, renderVideo } from '@retake/editor';
import type { ClipSegment, ExportResult, RenderRecord } from '@retake/editor';
import { SHARED_CACHE, frameOfColour, hasTool, pixelAt, renderWorkspace } from './render-helpers.js';
import type { RenderWorkspace } from './render-helpers.js';
import { PERSON_POLICY } from '@retake/core';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 600_000;

let ws: RenderWorkspace;
beforeAll(async () => {
  if (canRender) ws = await renderWorkspace();
}, LONG);
afterAll(async () => {
  await ws?.cleanup();
});

function probe(file: string): { streams: Array<Record<string, string | number>>; format: { duration?: string } } {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
}

/** Mean volume (dB) of the audio of `file` over [from, from + d) seconds. */
function meanVolume(file: string, from: number, d: number): number {
  const out = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', String(d), '-i', file, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(out)?.[1]);
}

describe.skipIf(!canRender)('square, music bed and export on real renders', () => {
  let record: RenderRecord;
  let exported: ExportResult;

  it('DemoSquare renders the square variant (the plan\'s source frame in the reframed capture)', async () => {
    const timeline = await readJson<Timeline>(join(ws.runDir, 'timeline.json'));
    const registry = await loadComponentRegistry({ root: ws.root });
    const plan = planEdit({ timeline, template: await loadProjectTemplate(ws.project, 'editorial', { files: fileFacts(PERSON_POLICY) }), project: ws.project, registry, captureFile: join(ws.runDir, 'capture.mp4'), overrides: { variant: 'square', scale: 0.5 } });
    expect([plan.variant, plan.width, plan.height]).toEqual(['square', 540, 540]);
    const out = join(ws.root, 'stills', 'square-45.png');
    await renderStill({ workPolicy: PERSON_POLICY, plan, frame: 45, out, root: ws.root, registry, cacheDir: SHARED_CACHE });
    expect(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim()).toBe('540,540');
    const clip = plan.segments.filter((s): s is ClipSegment => s.kind === 'clip' && 45 >= s.from && 45 < s.from + s.durationInFrames).pop()!;
    const c = clip.layout.capture;
    expect(frameOfColour(pixelAt(out, 0, c.x + c.w / 2, c.y + c.h / 2))).toBe(clip.srcFrames[45 - clip.from]);
  }, LONG);

  it('a procedural test track loops under the video and is ducked under footage (louder on the intro)', async () => {
    const track = await generateTestTrack(join(ws.project.dir, 'assets', 'bed.m4a'), { work: PERSON_POLICY, seconds: 1.5 });
    expect(Number(probe(track).format.duration)).toBeCloseTo(1.5, 1);
    record = await renderVideo({ workPolicy: PERSON_POLICY,
      project: ws.project,
      root: ws.root,
      run: 'latest',
      scenario: 'synthetic',
      overrides: { scale: 0.25, music: 'assets/bed.m4a', intro: true },
      concurrency: 2,
      cacheDir: SHARED_CACHE,
    });
    const m = record.plan.music!;
    expect(m.duration_s).toBeCloseTo(1.5, 1);
    expect(m.plays!.length).toBeGreaterThanOrEqual(3);
    expect(record.encoding.audio).toBe('music');
    const fps = record.plan.fps;
    const intro = record.plan.segments.find((s) => s.kind === 'intro')!;
    const first = record.plan.segments.find((s) => s.kind === 'clip')!;
    const introLevel = meanVolume(record.file, 1.2, (intro.durationInFrames - 1.6 * fps) / fps);
    const clipLevel = meanVolume(record.file, (first.from + 0.6 * fps) / fps, 0.5);
    // Base volume on the intro, × 0.5 (−6 dB) under footage.
    expect(introLevel - clipLevel).toBeGreaterThan(3);
    // Never silent between loops (the seams overlap).
    for (let t = 1; t < record.duration_s - 2.5; t += 0.5) expect(meanVolume(record.file, t, 0.5), `at ${t} s`).toBeGreaterThan(-45);
  }, LONG);

  it('exportRender: 1080p and WebM transcoded, a GIF preview, the square variant re-rendered; manifest.json', async () => {
    exported = await exportRender({ workPolicy: PERSON_POLICY, project: ws.project, root: ws.root, render: record.id, formats: ['mp4_1080p', 'webm', 'gif_preview', 'square_1x1'], concurrency: 2 });
    expect(exported.failures).toEqual([]);
    expect(exported.dir).toBe(join(ws.project.dir, 'exports', record.id));
    const by = Object.fromEntries(exported.outputs.map((o) => [o.format, o]));
    expect(by.mp4_1080p).toMatchObject({ method: 'transcode', width: 1920, height: 1080, video_codec: 'h264', audio_codec: 'aac' });
    expect(by.webm).toMatchObject({ method: 'transcode', width: 1920, height: 1080, video_codec: 'vp9', audio_codec: 'opus' });
    expect(by.gif_preview).toMatchObject({ method: 'transcode', width: 480, video_codec: 'gif', audio_streams: 0 });
    expect(by.gif_preview.window).toEqual(gifWindow(record));
    expect(by.square_1x1).toMatchObject({ method: 'render', width: 1080, height: 1080, video_codec: 'h264', audio_codec: 'aac' });
    expect(existsSync(by.square_1x1.record!)).toBe(true);
    for (const o of exported.outputs) {
      expect(existsSync(o.file)).toBe(true);
      if (o.format !== 'gif_preview') expect(Math.abs(o.duration_s - record.duration_s)).toBeLessThan(0.15);
    }
    const manifest = JSON.parse(await readFile(exported.manifest, 'utf8')) as ExportResult;
    expect(manifest.outputs.map((o) => o.format)).toEqual(['mp4_1080p', 'webm', 'square_1x1', 'gif_preview']);
    expect(manifest.master).toMatchObject({ width: 480, height: 270, variant: 'landscape' });
    // A second export adds to the manifest (other formats are kept).
    const again = await exportRender({ workPolicy: PERSON_POLICY, project: ws.project, root: ws.root, render: 'latest', formats: ['gif_preview'], gif: { start_s: 0.5, duration_s: 1 } });
    expect(again.outputs.map((o) => o.format)).toEqual(['mp4_1080p', 'webm', 'square_1x1', 'gif_preview']);
    expect(again.outputs.find((o) => o.format === 'gif_preview')!.window).toEqual({ start_s: 0.5, duration_s: 1, reason: 'asked' });
    await expect(exportRender({ workPolicy: PERSON_POLICY, project: ws.project, root: ws.root, render: 'nope' })).rejects.toThrow(/not found/);
  }, LONG);
});
