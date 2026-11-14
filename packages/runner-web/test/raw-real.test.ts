/**
 * L2.13 raw export, for real: a tiny product (a button, a link to a page that shows a yellow loading screen for 1.2 s
 * before a green "Loaded" one) captured twice with the debug cursor (a magenta dot at its point) — once with the
 * cursor in the pictures, once without it (`hideCursor`, R-RAW-02) — then exported: clips with the load cut (no
 * yellow frame anywhere — the capture itself holds the start page until "Loaded" paints, R-ISS-08 —, the first frame
 * after the cut green), ffprobe'd; no cursor pixel in the cursorless clips; the
 * cursor effects the kit reported (icon, press, ripple); the transparent cursor layer drawn at the cursor's place,
 * on the baked cursor; interchange files written.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TimelineSchema, PERSON_POLICY } from '@retake/core';
import type { RunRecord, Timeline } from '@retake/core';
import { exportCapture, probeVideo, runScenario } from '../src/index.js';
import type { RawExportResult } from '../src/index.js';
import { FAST, debugTemplate, makeScenario, startServer } from '@retake/test-support/capture';
import { makeProject, readTimeline, tempDir } from './helpers.js';
import type { TestServer } from '@retake/test-support/capture';

const HOME = `<!doctype html><html><body style="margin:0;background:#dde3ea;font-family:sans-serif">
<button id="go" style="position:absolute;left:100px;top:100px;width:200px;height:80px;font-size:24px;cursor:pointer" onclick="this.textContent='Done'">Go</button>
<a id="next" href="/next" style="position:absolute;left:450px;top:100px;font-size:28px;padding:20px;background:#fff">Next page</a>
</body></html>`;
const NEXT = `<!doctype html><html><head><style>@keyframes s{to{transform:rotate(360deg)}}</style></head><body style="margin:0;background:#fff;font-family:sans-serif">
<div id="box" style="position:absolute;left:0;top:0;width:800px;height:600px;background:#f5d000">
<div style="width:60px;height:60px;margin:200px auto;border:8px solid #333;border-top-color:transparent;border-radius:50%;animation:s .6s linear infinite"></div></div>
<script>setTimeout(() => { const b = document.getElementById('box'); b.style.background = '#1fae4b'; b.innerHTML = '<h1 style="margin:0;padding:40px;color:#fff">Loaded</h1>'; }, 1200);</script>
</body></html>`;

let server: TestServer;
let dir: string;
const runs: Record<'hidden' | 'baked', { rec: RunRecord; tl: Timeline }> = {} as never;
const project = () => makeProject(dir, { app: server.url });
const scenario = () =>
  makeScenario('raw', {
    pacing: FAST,
    scenes: [
      {
        id: 'start',
        open: '/',
        steps: [{ click: { css: '#go' } }, { hold: 0.4 }, { click: { css: '#next' } }, { wait_for: { text: 'Loaded' } }, { hold: 0.6 }],
      },
    ],
  });

beforeAll(async () => {
  server = await startServer({ '/': HOME, '/next': NEXT });
  dir = await tempDir('rw-raw-');
  for (const mode of ['hidden', 'baked'] as const) {
    const rec = await runScenario({
      policy: PERSON_POLICY,
      project: project(),
      scenario: scenario(),
      template: debugTemplate(),
      mode: 'capture',
      runId: `raw-${mode}-${Date.now()}`,
      ...(mode === 'hidden' ? { hideCursor: true } : {}),
    });
    expect(rec.error?.message).toBeUndefined();
    runs[mode] = { rec, tl: await readTimeline(rec.timeline!) };
  }
}, 240_000);

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Every frame of a video as RGB24. */
function decode(file: string, w: number, h: number): Buffer[] {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 * 1024 * 1024 });
  const n = w * h * 3;
  return Array.from({ length: Math.floor(out.length / n) }, (_, i) => out.subarray(i * n, (i + 1) * n));
}
/** Every frame of a video as RGBA (straight alpha). */
function decodeRgba(file: string, w: number, h: number): Buffer[] {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=in_color_matrix=bt709:in_range=tv', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2 * 1024 * 1024 * 1024 });
  const n = w * h * 4;
  return Array.from({ length: Math.floor(out.length / n) }, (_, i) => out.subarray(i * n, (i + 1) * n));
}
const px = (f: Buffer, w: number, x: number, y: number, c = 3) => [...f.subarray((y * w + x) * c, (y * w + x) * c + c)];
/** Centroid of the magenta pixels (the debug cursor's dot), or null. */
function magenta(f: Buffer, w: number, h: number, c = 3): { x: number; y: number; n: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c;
      if (f[i] > 190 && f[i + 1] < 90 && f[i + 2] > 190 && (c === 3 || f[i + 3] > 200)) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n >= 6 ? { x: sx / n, y: sy / n, n } : null;
}
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const YELLOW = [245, 208, 0];
const GREEN = [31, 174, 75];
const GREY = [221, 227, 234];

describe('capture without the cursor (R-RAW-02)', () => {
  it('records the cursor track and what the kit drew — icon, press, ripple — but draws nothing', async () => {
    const { rec, tl } = runs.hidden;
    expect(rec.options.cursor).toBe('hidden');
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
    expect(tl.capture.cursor).toBe('hidden');
    expect(tl.cursor.length).toBeGreaterThan(5);
    const fx = tl.cursor_effects ?? [];
    expect(fx.some((e) => e.type === 'icon' && e.icon === 'hand')).toBe(true);
    const click = tl.events.find((e) => e.step === 0)!;
    const press = fx.find((e) => e.type === 'press' && Math.abs(e.t - click.t_click!) < 0.15);
    expect(press, JSON.stringify(fx)).toBeDefined();
    const ripple = fx.find((e) => e.type === 'ripple' && Math.abs(e.t - click.t_click!) < 0.15)!;
    expect(Math.abs(ripple.x! - click.point!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(ripple.y! - click.point!.y)).toBeLessThanOrEqual(1);
    expect(fx.some((e) => e.type === 'release' && e.t > press!.t)).toBe(true);
    // The same run with the cursor in the pictures records the same kinds of effects.
    expect((runs.baked.tl.cursor_effects ?? []).some((e) => e.type === 'ripple')).toBe(true);
    expect(runs.baked.tl.capture.cursor).toBeUndefined();
    // No "choppy motion" warning: without a drawn cursor, moves change nothing on screen.
    expect(rec.warnings.some((w) => /cursor moves were captured below/.test(w))).toBe(false);
  });
});

describe('raw export (R-RAW-01…04)', () => {
  let none: RawExportResult;
  let layer: RawExportResult;
  let bakedLayer: RawExportResult;

  beforeAll(async () => {
    none = await exportCapture({ policy: PERSON_POLICY, project: project(), runDir: runs.hidden.rec.dir, template: debugTemplate(), out: join(dir, 'pkg-none'), selects: true });
    layer = await exportCapture({
      policy: PERSON_POLICY,
      project: project(),
      runDir: runs.hidden.rec.dir,
      template: debugTemplate(),
      cursor: 'layer',
      format: 'prores',
      fps: 60,
      out: join(dir, 'pkg-layer'),
    });
    bakedLayer = await exportCapture({ policy: PERSON_POLICY, project: project(), runDir: runs.baked.rec.dir, template: debugTemplate(), cursor: 'layer', out: join(dir, 'pkg-baked-layer') });
  }, 240_000);

  it('one clip per scene from its still, the load cut, MP4 H.264 high yuv420p with its timecode', async () => {
    const m = none.manifest;
    expect(m.settings).toMatchObject({ format: 'mp4', fps: 30, cursor: 'none', cuts: true, frames_from: 'screencast frames' });
    expect(m.clips.map((c) => c.file)).toEqual(['clips/01-start.mp4']);
    const c = m.clips[0];
    expect(c.cuts).toHaveLength(1);
    // The capture held the load (R-ISS-08: the yellow page paints no content), so the click step waited for it and
    // `wait_for` found "Loaded" at once: the cut is the held load, ended by the paint, not by a wait step.
    expect(c.cuts[0]).toMatchObject({ reason: 'navigation', after_step: 2 });
    expect(c.cuts[0].wait_step).toBeUndefined();
    expect(runs.hidden.tl.loading?.some((l) => l.until === 'paint' && l.t_end - l.t_start > 1)).toBe(true);
    const p = await probeVideo(join(none.dir, c.file), { count: true, policy: PERSON_POLICY });
    expect(p).toMatchObject({ codec: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 800, height: 600, fps: 30, frames: c.frames, timecode: '00:00:00:00' });
    // The selects file is the sequence (one clip here).
    expect((await probeVideo(join(none.dir, m.selects!.file), { count: true, policy: PERSON_POLICY })).frames).toBe(m.sequence.frames);
    const frames = decode(join(none.dir, c.file), 800, 600);
    expect(frames.length).toBe(c.frames);
    const colours = frames.map((f) => px(f, 800, 700, 500));
    // The loading page never shows; the first frame after the cut shows the loaded page, the one before the start page.
    expect(colours.filter((k) => near(k, YELLOW)).length).toBe(0);
    expect(near(colours[c.cuts[0].at_frame], GREEN), String(colours[c.cuts[0].at_frame])).toBe(true);
    expect(near(colours[c.cuts[0].at_frame - 1], GREY), String(colours[c.cuts[0].at_frame - 1])).toBe(true);
    expect(near(colours[0], GREY)).toBe(true);
    // Not a single cursor pixel in the cursorless clip.
    expect(frames.every((f) => magenta(f, 800, 600) === null)).toBe(true);
  }, 120_000);

  it('the baked clip has the cursor; its layer draws it at the same place (composited, it covers the captured one)', async () => {
    const m = bakedLayer.manifest;
    const c = m.clips[0];
    const clip = decode(join(bakedLayer.dir, c.file), 800, 600);
    const lay = decodeRgba(join(bakedLayer.dir, c.layer!.file), 800, 600);
    expect(lay.length).toBe(c.frames);
    // Frames where the cursor rests (its samples did not move for 0.3 s before — but for the 1 px probes after a
    // scroll, L1.3): the dots coincide.
    const cursor = JSON.parse(await readFile(join(bakedLayer.dir, 'cursor', 'cursor.json'), 'utf8')) as { clips: Array<{ samples: Array<{ f: number; x: number; y: number; visible: boolean }> }> };
    const samples = cursor.clips[0].samples;
    let compared = 0;
    for (let k = 10; k < c.frames; k++) {
      const still = samples.slice(Math.max(0, k - 9), k + 1).every((s) => Math.abs(s.x - samples[k].x) <= 1 && Math.abs(s.y - samples[k].y) <= 1 && s.visible);
      if (!still) continue;
      const a = magenta(clip[k], 800, 600);
      const b = magenta(lay[k], 800, 600, 4);
      if (!a) continue;
      expect(b, `layer frame ${k}`).not.toBeNull();
      expect(Math.abs(a.x - b!.x), `frame ${k} x`).toBeLessThanOrEqual(1.5);
      expect(Math.abs(a.y - b!.y), `frame ${k} y`).toBeLessThanOrEqual(1.5);
      compared++;
    }
    expect(compared).toBeGreaterThan(3);
    expect(m.notes.some((n) => /the layer duplicates it/.test(n))).toBe(true);
  }, 120_000);

  it('cursorless clip + ProRes 4444 layer at 60 fps: frame-aligned, transparent except the cursor and its ripple', async () => {
    const m = layer.manifest;
    expect(m.settings).toMatchObject({ format: 'prores', fps: 60, cursor: 'layer', layer: 'prores' });
    const c = m.clips[0];
    const p = await probeVideo(join(layer.dir, c.file), { count: true, policy: PERSON_POLICY });
    expect(p).toMatchObject({ codec: 'prores', profile: 'HQ', pix_fmt: 'yuv422p10le', fps: 60, frames: c.frames });
    const lp = await probeVideo(join(layer.dir, c.layer!.file), { count: true, policy: PERSON_POLICY });
    expect(lp).toMatchObject({ codec: 'prores', profile: '4444', fps: 60, frames: c.frames, timecode: c.timecode });
    expect(lp.pix_fmt).toMatch(/^yuva444p/);
    // The manifest gives the pixel format ffprobe reads back, and its codec label names none to contradict it.
    expect(c.layer!.pix_fmt).toBe(lp.pix_fmt);
    expect(layer.manifest.settings.layer_codec).not.toMatch(/yuv/);
    // 60 fps from the screencast's own timing: about twice the 30 fps clip, never interpolated (each of the two kept
    // pieces around the cut rounds by ±1 at either rate, and the resume snaps to a painted frame on each rate's grid).
    expect(Math.abs(c.frames - 2 * none.manifest.clips[0].frames)).toBeLessThanOrEqual(3);
    const lay = decodeRgba(join(layer.dir, c.layer!.file), 800, 600);
    const cursor = JSON.parse(await readFile(join(layer.dir, 'cursor', 'cursor.json'), 'utf8')) as {
      clips: Array<{ samples: Array<{ f: number; x: number; y: number; visible: boolean; ripples?: unknown[] }>; clicks: Array<{ f: number; x: number; y: number }> }>;
    };
    const { samples, clicks } = cursor.clips[0];
    let checked = 0;
    for (let k = 0; k < c.frames; k += 7) {
      const s = samples[k];
      const dot = magenta(lay[k], 800, 600, 4);
      if (!s.visible) continue;
      expect(dot, `frame ${k}`).not.toBeNull();
      expect(Math.abs(dot!.x - s.x)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(dot!.y - s.y)).toBeLessThanOrEqual(1.5);
      // Far from the cursor (and from any ripple) the layer is fully transparent.
      const fx = s.x > 400 ? 50 : 750;
      expect(lay[k][(560 * 800 + fx) * 4 + 3]).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
    // A ripple around the first click: semi-transparent pixels on a ring 15–25 px from it a few frames later.
    const k0 = clicks[0].f + 9;
    const ring = [0, 90, 180, 270].map((deg) => {
      const r = 20;
      const x = Math.round(clicks[0].x + r * Math.cos((deg * Math.PI) / 180));
      const y = Math.round(clicks[0].y + r * Math.sin((deg * Math.PI) / 180));
      return lay[k0][(y * 800 + x) * 4 + 3];
    });
    expect(ring.filter((a) => a > 20).length, String(ring)).toBeGreaterThanOrEqual(3);
  }, 180_000);

  it('a VP9-alpha WebM layer: the same frames, alpha kept (decoded with libvpx), the dot on the cursor', async () => {
    const webm = await exportCapture({ policy: PERSON_POLICY, project: project(), runDir: runs.hidden.rec.dir, template: debugTemplate(), cursor: 'layer', layer: 'webm', out: join(dir, 'pkg-webm') });
    const c = webm.manifest.clips[0];
    expect(c.layer).toMatchObject({ file: 'cursor/01-start-cursor.webm', codec: 'vp9', alpha: true, frames: c.frames });
    expect(webm.manifest.warnings).toEqual([]);
    const out = execFileSync('ffmpeg', ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', join(webm.dir, c.layer!.file), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1024 * 1024 * 1024 });
    const n = 800 * 600 * 4;
    expect(out.length / n).toBe(c.frames);
    const cursor = JSON.parse(await readFile(join(webm.dir, 'cursor', 'cursor.json'), 'utf8')) as { clips: Array<{ samples: Array<{ x: number; y: number; visible: boolean }> }> };
    const k = cursor.clips[0].samples.findIndex((s, i) => i > 5 && s.visible);
    const dot = magenta(out.subarray(k * n, (k + 1) * n), 800, 600, 4);
    expect(dot).not.toBeNull();
    expect(Math.abs(dot!.x - cursor.clips[0].samples[k].x)).toBeLessThanOrEqual(2);
    expect(Math.abs(dot!.y - cursor.clips[0].samples[k].y)).toBeLessThanOrEqual(2);
    // Transparent away from the cursor.
    expect(out[k * n + (590 * 800 + (cursor.clips[0].samples[k].x > 400 ? 10 : 790)) * 4 + 3]).toBe(0);
    // No timecode in WebM: out of the FCPXML (Final Cut Pro cannot read it), from media time 0 in the OTIO; the README says so.
    const probe = await probeVideo(join(webm.dir, c.layer!.file), { policy: PERSON_POLICY });
    expect(probe.timecode).toBeUndefined();
    expect(await readFile(join(webm.dir, webm.manifest.markers.fcpxml), 'utf8')).not.toContain('-cursor');
    const otio = JSON.parse(await readFile(join(webm.dir, webm.manifest.markers.otio), 'utf8')) as {
      tracks: {
        children: Array<{
          name: string;
          children: Array<{ source_range: { start_time: { value: number } }; media_references: { DEFAULT_MEDIA: { target_url: string; available_range: { start_time: { value: number } } } } }>;
        }>;
      };
    };
    const layerClip = otio.tracks.children.find((t) => t.name === 'Cursor')!.children[0];
    expect(layerClip.media_references.DEFAULT_MEDIA.available_range.start_time.value).toBe(0);
    expect(layerClip.media_references.DEFAULT_MEDIA.target_url).toBe(`file://${encodeURI(join(webm.dir, c.layer!.file))}`);
    const readme = await readFile(join(webm.dir, 'README.md'), 'utf8');
    expect(readme).toMatch(/WebM has \*\*no timecode\*\*/);
    expect(readme).toMatch(/Final Cut Pro and Premiere Pro do not read it/);
    expect(readme).not.toMatch(/length and timecode as its clip/);
    expect(webm.manifest.notes.some((x) => /VP9 WebM: no timecode/.test(x))).toBe(true);
  }, 120_000);

  it('cursor data, markers, manifest and README in every mode', async () => {
    for (const r of [none, layer, bakedLayer]) {
      for (const f of [
        'manifest.json',
        'README.md',
        'cursor/cursor.json',
        'cursor/cursor.csv',
        'cursor/clicks.csv',
        r.manifest.markers.fcpxml,
        r.manifest.markers.edl,
        r.manifest.markers.otio,
        r.manifest.markers.csv,
        r.manifest.markers.json,
      ]) {
        expect(existsSync(join(r.dir, f)), f).toBe(true);
      }
      expect(r.manifest.cursor.icons).toBe('recorded');
      const clicks = (await readFile(join(r.dir, 'cursor', 'clicks.csv'), 'utf8')).trim().split('\n');
      expect(clicks.length - 1).toBe(2);
      expect(clicks[1]).toMatch(/clips\/01-start\.(mp4|mov),\d+,[\d.]+,[\d.]+,[\d.]+,\d+(\.\d+)?,\d+(\.\d+)?,start,0,,click,"button ""Go""",100,100,200,80,app/);
      const readme = await readFile(join(r.dir, 'README.md'), 'utf8');
      expect(readme).toContain('Final Cut Pro');
      expect(readme).toContain('Premiere Pro');
      expect(readme).toContain('DaVinci Resolve');
      const fcp = await readFile(join(r.dir, r.manifest.markers.fcpxml), 'utf8');
      expect(fcp).toContain(`src="file://${encodeURI(join(r.dir, r.manifest.clips[0].file))}"`);
      const otio = JSON.parse(await readFile(join(r.dir, r.manifest.markers.otio), 'utf8')) as { tracks: { children: Array<{ name: string }> } };
      expect(otio.tracks.children[0].name).toBe('V1');
      expect(r.manifest.markers.count.cut).toBe(1);
    }
    expect(layer.manifest.cursor.layers).toEqual(['cursor/01-start-cursor.mov']);
  });

  it('refuses what a run cannot give: no cursor removed from pictures, no cursor baked into a cursorless run', async () => {
    await expect(exportCapture({ policy: PERSON_POLICY, project: project(), runDir: runs.baked.rec.dir, cursor: 'none', out: join(dir, 'x') })).rejects.toThrow(
      /--cursor none needs a run captured without it/,
    );
    await expect(exportCapture({ policy: PERSON_POLICY, project: project(), runDir: runs.hidden.rec.dir, cursor: 'baked', out: join(dir, 'y') })).rejects.toThrow(/captured without its cursor/);
    expect(existsSync(join(dir, 'x'))).toBe(false);
    // A folder that is not a raw package is never replaced.
    await expect(exportCapture({ policy: PERSON_POLICY, project: project(), runDir: runs.baked.rec.dir, out: runs.baked.rec.dir })).rejects.toThrow(/not a raw package/);
    expect(existsSync(join(runs.baked.rec.dir, 'timeline.json'))).toBe(true);
    // An earlier package is.
    const again = await exportCapture({ policy: PERSON_POLICY, project: project(), runDir: runs.hidden.rec.dir, out: none.dir, cuts: false });
    expect(again.manifest.settings.cuts).toBe(false);
    expect(again.manifest.clips[0].cuts).toEqual([]);
  }, 120_000);
});
