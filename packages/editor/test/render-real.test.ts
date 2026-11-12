/**
 * Real renders with Remotion on a tiny synthetic run (≈ 2 s, half size): the bundle cache (miss, hit, miss after a
 * component change), renderVideo (record, version, duration, fps, size, an audio track, faststart, yuv420p) with
 * every rendered capture frame checked against the plan's source frame (the capture's frames are colour-coded),
 * cancellation through an AbortSignal (nothing left under the final names) and renderStill.
 * Needs ffmpeg/ffprobe and a Chromium headless shell (Playwright's or $RETAKE_CHROMIUM_HEADLESS_SHELL).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProjectTemplate, readJson, fileFacts } from '@retake/core/io';
import type { Timeline } from '@retake/core';
import { loadComponentRegistry, scaffoldDir } from '@retake/components';
import { RenderCancelledError, bundleComponentsFor, ensureBundle, listRenders, planEdit, renderStill, renderVideo } from '@retake/editor';
import type { BundleComponent, ClipSegment, EditPlan, RenderRecord } from '@retake/editor';
import { SHARED_CACHE, frameColour, frameOfColour, hasTool, pixelAt, renderWorkspace } from './render-helpers.js';
import type { RenderWorkspace } from './render-helpers.js';
import { PERSON_POLICY } from '@retake/core';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;

let ws: RenderWorkspace;
let record: RenderRecord;

beforeAll(async () => {
  if (canRender) ws = await renderWorkspace();
}, LONG);
afterAll(async () => {
  await ws?.cleanup();
});

/** Centre of the capture rect of a clip, in output px. */
function captureCentre(clip: ClipSegment): [number, number] {
  const c = clip.layout.capture;
  return [c.x + c.w / 2, c.y + c.h / 2];
}

/**
 * The source frame a rendered frame (`frame` of the plan, read from frame `at` of the file) shows at the centre of the
 * capture, and the one the plan expects (the topmost clip on screen at that frame).
 */
function shownSourceFrame(file: string, plan: EditPlan, frame: number, at = frame): { expected: number; shown: number; rgb: [number, number, number] } {
  const clip = plan.segments.filter((s): s is ClipSegment => s.kind === 'clip' && frame >= s.from && frame < s.from + s.durationInFrames).pop()!;
  const [x, y] = captureCentre(clip);
  const rgb = pixelAt(file, at, x, y);
  return { expected: clip.srcFrames[frame - clip.from], shown: frameOfColour(rgb), rgb };
}

describe.skipIf(!canRender)('bundle cache', () => {
  it(
    'bundles once, reuses the bundle while nothing changes and rebuilds when a component changes',
    async () => {
      const cacheDir = join(ws.root, 'bundle-cache');
      const dir = join(ws.root, 'components', 'acme', 'card');
      await mkdir(dirname(dir), { recursive: true });
      await cp(scaffoldDir('card'), dir, { recursive: true });
      const registry = await loadComponentRegistry({ root: ws.root });
      const scaffolds = (await bundleComponentsFor({ segments: [] } as unknown as EditPlan, registry)).filter((c) => c.scaffold);
      const own: BundleComponent = { id: 'acme/card', kind: 'card', dir, entry: join(dir, 'index.tsx'), defaults: { align: 'center' } };
      const progress: number[] = [];
      const first = await ensureBundle({ root: ws.root, cacheDir, components: [own, ...scaffolds], onProgress: (p) => progress.push(p) });
      expect(first.cached).toBe(false);
      expect(first.ms).toBeGreaterThan(0);
      expect(progress.length).toBeGreaterThan(0);
      expect(first.dir).toBe(join(cacheDir, `remotion-${first.hash}`));
      expect(existsSync(join(first.serveUrl, 'index.html'))).toBe(true);
      const registrySrc = await readFile(join(first.dir, 'src', 'registry.ts'), 'utf8');
      expect(registrySrc).toContain(JSON.stringify(join(dir, 'index.tsx')));
      expect(JSON.parse(await readFile(join(first.dir, 'bundle.json'), 'utf8'))).toMatchObject({ hash: first.hash, components: expect.arrayContaining(['acme/card', 'scaffolds/intro']) });

      const again = await ensureBundle({ root: ws.root, cacheDir, components: [...scaffolds, own] });
      expect(again).toMatchObject({ cached: true, hash: first.hash, ms: 0, serveUrl: first.serveUrl });

      await writeFile(join(dir, 'index.tsx'), `${await readFile(join(dir, 'index.tsx'), 'utf8')}\n// edited\n`);
      const changed = await ensureBundle({ root: ws.root, cacheDir, components: [own, ...scaffolds] });
      expect(changed.cached).toBe(false);
      expect(changed.hash).not.toBe(first.hash);
      const entries = (await readdir(cacheDir)).sort();
      expect(entries).toEqual([`remotion-${changed.hash}`, `remotion-${first.hash}`].sort());
    },
    LONG,
  );
});

describe.skipIf(!canRender)('renderVideo on a synthetic run', () => {
  it(
    'writes renders/<scenario>-v1.mp4 + .json: the plan duration, fps and size, h264 yuv420p faststart with an audio track',
    async () => {
      const stages = new Set<string>();
      record = await renderVideo({
        workPolicy: PERSON_POLICY,
        project: ws.project,
        root: ws.root,
        run: 'latest',
        scenario: 'synthetic',
        overrides: { scale: 0.5 },
        concurrency: 2,
        cacheDir: SHARED_CACHE,
        onProgress: (p) => stages.add(p.stage),
      });
      const renders = join(ws.project.dir, 'renders');
      expect(record.id).toBe('synthetic-v1');
      expect(record.render_version).toBe(1);
      expect(record.file).toBe(join(renders, 'synthetic-v1.mp4'));
      expect(record.record).toBe(join(renders, 'synthetic-v1.json'));
      expect(record).toMatchObject({
        status: 'succeeded',
        scenario: 'synthetic',
        project: 'demo',
        template: 'editorial',
        variant: 'landscape',
        fps: 30,
        width: 960,
        height: 540,
        overrides: { scale: 0.5 },
      });
      expect(record.encoding).toEqual({ codec: 'h264', encoder: 'libx264', crf: 16, pixel_format: 'yuv420p', faststart: true, audio: 'silent' });
      // The suite's software path (vitest.setup.ts, L5.15): today's renderer and encoder, said in the record.
      expect(record.policy).toEqual({
        gl: { asked: 'software', source: 'env', resolved: 'software', used: 'software' },
        encoder: { asked: 'libx264', source: 'env', used: 'libx264' },
        // L7.3: the frame encode's ffmpeg, pinned to the library's by the suite (RETAKE_RENDER_FFMPEG).
        ffmpeg: { asked: 'library', source: 'env', used: 'library' },
        concurrency_source: 'option',
      });
      expect(record.frames).toBe(record.plan.durationInFrames);
      expect(record.frames).toBe(57);
      expect([...stages]).toEqual(expect.arrayContaining(['planning', 'bundling', 'rendering', 'encoding', 'done']));
      expect(JSON.parse(readFileSync(record.record, 'utf8'))).toMatchObject({ id: 'synthetic-v1', status: 'succeeded', plan: { durationInFrames: 57 } });
      expect(record.size_bytes).toBe((await readFile(record.file)).length);

      const probe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', record.file], {
          encoding: 'utf8',
        }),
      ) as { streams: Array<Record<string, string | number>>; format: { duration: string } };
      const video = probe.streams.find((s) => s.codec_type === 'video')!;
      const audio = probe.streams.filter((s) => s.codec_type === 'audio');
      expect(video).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', width: 960, height: 540, r_frame_rate: '30/1' });
      expect(Number(video.nb_frames)).toBe(57);
      expect(Math.abs(Number(probe.format.duration) - 57 / 30)).toBeLessThanOrEqual(1 / 30 + 0.02);
      expect(audio).toHaveLength(1);
      expect(audio[0].codec_name).toBe('aac');
      // Silent: the loudest sample is digital silence.
      const vol = spawnSync('ffmpeg', ['-v', 'info', '-i', record.file, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      const max = /max_volume: (-?[\d.]+|-inf) dB/.exec(vol)?.[1];
      expect(max === '-inf' || Number(max) <= -80, `max_volume ${max}`).toBe(true);
      // Faststart: the moov atom comes before mdat.
      const head = (await readFile(record.file)).subarray(0, 64 * 1024).toString('latin1');
      expect(head.indexOf('moov')).toBeGreaterThan(0);
      expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat'));
      expect(record.probe).toMatchObject({ width: 960, height: 540, audio_streams: 1 });
    },
    LONG,
  );

  it(
    "every rendered capture frame is the plan's source frame (incl. source frames past the end of the video)",
    () => {
      const plan = record.plan;
      const [a, b] = plan.segments as ClipSegment[];
      expect([a.id, b.id, b.from]).toEqual(['a', 'b', 30]);
      expect(Math.max(...b.srcFrames)).toBeGreaterThan(plan.durationInFrames);
      const frames = [0, 7, 15, 29, 41, 45, 50, 56];
      for (const f of frames) {
        const r = shownSourceFrame(record.file, plan, f);
        expect(r.shown, `output frame ${f}: rgb ${r.rgb} (expected ${frameColour(r.expected)})`).toBe(r.expected);
      }
      // Scene "b" opens a page at 3.0 s: the load (source frames 90–92) is never shown.
      expect(b.srcFrames[0]).toBe(93);
    },
    LONG,
  );

  it(
    'a cancelled render leaves nothing under the final names',
    async () => {
      const controller = new AbortController();
      let rendered = 0;
      const p = renderVideo({
        workPolicy: PERSON_POLICY,
        project: ws.project,
        root: ws.root,
        run: 'latest',
        scenario: 'synthetic',
        overrides: { scale: 0.5 },
        concurrency: 1,
        cacheDir: SHARED_CACHE,
        signal: controller.signal,
        onProgress: (e) => {
          if (e.stage === 'rendering' && (e.renderedFrames ?? 0) >= 3) {
            rendered = e.renderedFrames ?? 0;
            controller.abort();
          }
        },
      });
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RenderCancelledError);
      expect((err as RenderCancelledError).record).toMatchObject({ id: 'synthetic-v2', status: 'cancelled' });
      expect(rendered).toBeGreaterThanOrEqual(3);
      const files = (await readdir(join(ws.project.dir, 'renders'))).sort();
      expect(files).toEqual(['synthetic-v1.json', 'synthetic-v1.mp4']);
      expect((await listRenders(ws.project)).map((r) => r.id)).toEqual(['synthetic-v1']);
    },
    LONG,
  );

  it(
    'renderStill writes one frame as a PNG',
    async () => {
      const out = join(ws.root, 'stills', 'frame-48.png');
      expect(await renderStill({ workPolicy: PERSON_POLICY, plan: record.plan, frame: 48, out, root: ws.root, cacheDir: SHARED_CACHE })).toBe(out);
      const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
      expect(size).toBe('png,960,540');
      const r = shownSourceFrame(out, record.plan, 48, 0);
      expect(r.shown).toBe(r.expected);
      expect(r.expected).toBe((record.plan.segments[1] as ClipSegment).srcFrames[48 - 30]);
      await expect(renderStill({ workPolicy: PERSON_POLICY, plan: record.plan, frame: 57, out, root: ws.root })).rejects.toThrow(/outside the video/);
    },
    LONG,
  );

  it(
    'DemoVertical renders the vertical variant (9:16 crop of the capture)',
    async () => {
      const timeline = await readJson<Timeline>(join(ws.runDir, 'timeline.json'));
      const registry = await loadComponentRegistry({ root: ws.root });
      const plan = planEdit({
        timeline,
        template: await loadProjectTemplate(ws.project, 'editorial', { files: fileFacts(PERSON_POLICY) }),
        project: ws.project,
        registry,
        captureFile: join(ws.runDir, 'capture.mp4'),
        overrides: { variant: 'vertical', scale: 0.5 },
      });
      expect([plan.variant, plan.width, plan.height]).toEqual(['vertical', 540, 960]);
      const out = join(ws.root, 'stills', 'vertical-45.png');
      await renderStill({ workPolicy: PERSON_POLICY, plan, frame: 45, out, root: ws.root, registry, cacheDir: SHARED_CACHE });
      expect(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim()).toBe('540,960');
      const r = shownSourceFrame(out, plan, 45, 0);
      expect(r.shown, `rgb ${r.rgb}`).toBe(r.expected);
    },
    LONG,
  );

  it(
    'a music bed gives an audible track (scenario music or overrides.music)',
    async () => {
      const music = join(ws.project.dir, 'assets', 'bed.wav');
      await mkdir(dirname(music), { recursive: true });
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', music]);
      const rec = await renderVideo({
        workPolicy: PERSON_POLICY,
        project: ws.project,
        root: ws.root,
        run: 'latest',
        scenario: 'synthetic',
        overrides: { scale: 0.25, music: 'assets/bed.wav' },
        concurrency: 2,
        cacheDir: SHARED_CACHE,
      });
      expect(rec.encoding.audio).toBe('music');
      expect(rec.plan.music?.file).toBe(music);
      const vol = spawnSync('ffmpeg', ['-v', 'info', '-i', rec.file, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      const max = Number(/max_volume: (-?[\d.]+) dB/.exec(vol)?.[1]);
      // A −18 dBFS tone × base volume 0.6 × fade in (1 s) / fade out (2 s) × ducking 0.5 over a 1.9 s video of clips:
      // quiet, but far from the digital silence (≈ −91 dB) of a render without music.
      expect(max).toBeGreaterThan(-60);
    },
    LONG,
  );
});
