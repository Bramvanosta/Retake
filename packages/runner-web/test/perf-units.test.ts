/**
 * L5.7 (capture performance and disk), the pure parts and the encoder: the CFR schedule computed as frames arrive
 * (stream.ts) against the after-the-fact one (encode.ts cfrSchedule), the encoder fed during the take with its grey
 * thumbnails, what the screen did after each click (activity.ts), the CPU sampler (perf.ts), Chromium's GPU report, the
 * measured cause of choppy motion, the pages `capture.prewarm` visits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { CursorSample, SceneEntry, TimelineEvent } from '@retake/core';
import {
  ActivityRecorder,
  CaptureClock,
  KICK_GAP_MS,
  ScreencastRecorder,
  STREAM_LAG_S,
  CELLS_X,
  CfrStream,
  DISK_FREE_MIN_GB,
  DISK_FREE_MIN_SHARE,
  PerfSampler,
  StreamEncoder,
  THUMB_H,
  THUMB_W,
  analyzeActivity,
  cellMask,
  cfrSchedule,
  choppyCause,
  chromiumGroup,
  diskCheck,
  encoderLabel,
  gpuInfoOf,
  localPorts,
  parseCpuTime,
  prewarmTargets,
  resolveEncoder,
  slowTransitions,
  streamArgs,
} from '../src/index.js';
import { execFileP } from '@retake/test-support/capture';
import { tempDir } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

let dir: string;
beforeAll(async () => {
  dir = await tempDir('ds-perf-');
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A deterministic pseudo-random generator (tests repeat). */
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

describe('CFR schedule as frames arrive (stream.ts)', () => {
  it('emits exactly what cfrSchedule computes after the fact, whatever the arrival order within the lag', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const fps = seed % 2 ? 30 : 60;
      const frames: Array<{ file: string; t: number }> = [];
      let t = r() * 0.3;
      for (let i = 0; i < 120; i++) {
        frames.push({ file: `f${i}`, t: Math.round(t * 1000) / 1000 });
        // VFR: bursts at ≈ 60 Hz, still periods, an occasional exact tick time.
        t += r() < 0.15 ? 0.2 + r() * 0.8 : r() < 0.1 ? 1 / fps : 0.008 + r() * 0.03;
      }
      const endT = frames[frames.length - 1].t + r() * 0.5;
      const want = cfrSchedule(frames, endT, fps);
      const got: string[] = [];
      const s = new CfrStream<{ file: string; t: number }>(fps, (n, f) => {
        expect(n).toBe(got.length);
        got.push(f.file);
      });
      // Arrival: each frame comes up to 0.1 s after its paint time, the horizon trails the clock by 0.5 s.
      const arrivals = frames.map((f) => ({ f, at: f.t + r() * 0.1 })).sort((a, b) => a.at - b.at);
      for (const a of arrivals) {
        s.advance(a.at - 0.5);
        s.push(a.f);
      }
      expect(s.finish(endT)).toBe(want.length);
      expect(got, `seed ${seed}`).toEqual(want);
      expect(s.late).toBe(0);
    }
  });

  it('the first frame covers the time before it; ticks wait for it; frames after the end are left out', () => {
    const got: string[] = [];
    const s = new CfrStream<{ file: string; t: number }>(10, (_n, f) => got.push(f.file));
    s.advance(0.45);
    expect(got).toEqual([]);
    s.push({ file: 'a', t: 0.25 });
    s.advance(0.45);
    expect(got).toEqual(['a', 'a', 'a', 'a', 'a']);
    s.push({ file: 'b', t: 0.6 });
    s.push({ file: 'late', t: 0.9 });
    expect(s.finish(0.7)).toBe(7);
    expect(got).toEqual(['a', 'a', 'a', 'a', 'a', 'a', 'b']);
  });

  it('a frame whose tick is gone shows from the next tick (counted late); an empty take throws', () => {
    const got: string[] = [];
    const s = new CfrStream<{ file: string; t: number }>(10, (_n, f) => got.push(f.file));
    s.push({ file: 'a', t: 0 });
    s.advance(0.3);
    s.push({ file: 'b', t: 0.15 });
    s.finish(0.5);
    expect(got).toEqual(['a', 'a', 'a', 'a', 'b']);
    expect(s.late).toBe(1);
    expect(() => new CfrStream(30, () => undefined).finish(1)).toThrow(/no frames/);
  });

  it('ffmpeg arguments: VideoToolbox or libx264, JPEG range conversion, the grey thumbnails on stdout', () => {
    const vt = streamArgs({ out: '/o.mp4', fps: 30, width: 1921, height: 1080, format: 'jpeg', encoder: 'videotoolbox', crf: 16, policy: PERSON_POLICY, thumbs: true });
    expect(vt).toEqual(expect.arrayContaining(['-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0', 'h264_videotoolbox', '-q:v', 'pipe:1', 'rawvideo', 'gray']));
    expect(vt.join(' ')).toContain('scale=1922:1080:flags=lanczos:in_range=full:in_color_matrix=bt601');
    expect(vt.join(' ')).toContain(`scale=${THUMB_W}:${THUMB_H}`);
    const x = streamArgs({ out: '/o.mp4', fps: 30, width: 800, height: 600, format: 'png', encoder: 'libx264', crf: 18, policy: PERSON_POLICY, thumbs: false });
    expect(x).toEqual(expect.arrayContaining(['-c:v', 'png', 'libx264', 'veryfast', '-crf', '18']));
    expect(x).not.toContain('pipe:1');
    expect(x.join(' ')).not.toContain('in_range=full');
    expect(encoderLabel({ encoder: 'videotoolbox', crf: 16 }).codec).toBe('h264_videotoolbox');
    expect(encoderLabel({ encoder: 'libx264', crf: 16 })).toEqual({ codec: 'libx264 veryfast', quality: 'crf 16' });
  });

  it('encodes during the take: the CFR video has round(endT · fps) frames, one grey thumbnail each; abort removes the file', async () => {
    // Three JPEG frames (red, green, blue) of 320×180.
    const jpegs: Buffer[] = [];
    for (const c of ['red', 'green', 'blue']) {
      const file = join(dir, `${c}.jpg`);
      await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=320x180`, '-frames:v', '1', file]);
      jpegs.push(await readFile(file));
    }
    for (const encoder of [await resolveEncoder('auto', undefined, PERSON_POLICY), 'libx264' as const]) {
      const out = join(dir, `stream-${encoder}.mp4`);
      const thumbs: number[] = [];
      let clock = 0;
      const enc = new StreamEncoder({ policy: PERSON_POLICY, out, fps: 10, width: 320, height: 180, format: 'jpeg', encoder, crf: 20, horizon: () => clock, onThumb: (n) => thumbs.push(n) });
      enc.start();
      enc.push({ t: 0, data: jpegs[0] });
      enc.push({ t: 0.42, data: jpegs[1] });
      clock = 0.3;
      enc.push({ t: 0.81, data: jpegs[2] });
      enc.endAt(1.2);
      const { frames } = await enc.finish(1.2);
      expect(frames).toBe(12);
      const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height,codec_name', '-of', 'json', out]);
      const st = JSON.parse(stdout).streams[0];
      expect(Number(st.nb_read_frames)).toBe(12);
      expect([st.width, st.height]).toEqual([320, 180]);
      expect(st.codec_name).toBe('h264');
      expect(thumbs).toEqual([...Array(12).keys()]);
      // Frame 4 (0.4 s) still shows red, frame 5 (0.5 s) green, frame 9 blue.
      const px = async (n: number) => {
        const { stdout: raw } = await execFileP(
          'ffmpeg',
          ['-hide_banner', '-loglevel', 'error', '-i', out, '-vf', `select=eq(n\\,${n}),scale=1:1`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
          { encoding: 'buffer' } as never,
        );
        return [...(raw as unknown as Buffer)];
      };
      const [r4, r5, r9] = [await px(4), await px(5), await px(9)];
      expect(r4[0]).toBeGreaterThan(150);
      expect(r5[1]).toBeGreaterThan(80);
      expect(r5[0]).toBeLessThan(80);
      expect(r9[2]).toBeGreaterThan(150);
    }
    const out = join(dir, 'aborted.mp4');
    const enc = new StreamEncoder({ policy: PERSON_POLICY, out, fps: 10, width: 320, height: 180, format: 'jpeg', encoder: 'libx264', crf: 20, horizon: () => 1 });
    enc.start();
    enc.push({ t: 0, data: jpegs[0] });
    await enc.abort();
    expect(existsSync(out)).toBe(false);
  });
});

/** A grey thumbnail, with these cells (index = y · 16 + x) painted `v`. */
function thumb(cells: number[] = [], v = 200): Uint8Array {
  const g = new Uint8Array(THUMB_W * THUMB_H).fill(40);
  for (const c of cells) {
    const cx = c % CELLS_X;
    const cy = Math.floor(c / CELLS_X);
    for (let y = cy * 6; y < cy * 6 + 6; y++) for (let x = cx * 6; x < cx * 6 + 6; x++) g[y * THUMB_W + x] = v;
  }
  return g;
}

/** Masks from a list of "which cells changed" per frame (frame 0: none). */
function masksOf(changes: number[][]): Uint8Array[] {
  const rec = new ActivityRecorder();
  let cur = thumb();
  rec.add(0, cur);
  changes.forEach((cells, i) => {
    const next = new Uint8Array(cur);
    for (const c of cells) {
      const cx = c % CELLS_X;
      const cy = Math.floor(c / CELLS_X);
      for (let y = cy * 6; y < cy * 6 + 6; y++) for (let x = cx * 6; x < cx * 6 + 6; x++) next[y * THUMB_W + x] = next[y * THUMB_W + x] > 100 ? 40 : 200;
    }
    rec.add(i + 1, next);
    cur = next;
  });
  return rec.masks;
}

const click = (t: number, step: number, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  scene: 's',
  scene_index: 0,
  step,
  action: 'click',
  t_start: t - 0.5,
  t_end: t + 0.3,
  t_click: t,
  status: 'ok',
  target: { desc: `button ${step}` },
  ...extra,
});

describe('what the screen did after each click (activity.ts)', () => {
  it('cell masks: a cell changes when at least two of its pixels move by more than 12 grey levels', () => {
    const a = thumb();
    const b = thumb([0, 17]);
    const m = cellMask(a, b);
    expect([...m].reduce((n, x) => n + x.toString(2).replace(/0/g, '').length, 0)).toBe(2);
    const noise = new Uint8Array(a);
    noise[0] += 10;
    noise[THUMB_W + 1] += 30;
    expect(cellMask(a, noise).every((x) => x === 0)).toBe(true);
  });

  it('a dialog with a skeleton: the slow transition and its wait; the cursor and a ripple are not changes; a toast leaving during a hold is not the click', () => {
    const fps = 10;
    const changes: number[][] = Array.from({ length: 80 }, () => []);
    // t = 1.0: click; 1.1: a dialog opens (big); 1.2 – 2.4: a spinner (1 cell); 2.5: the content (big); then still.
    changes[10] = [5];
    changes[11] = [20, 21, 22, 36, 37, 38];
    for (let k = 12; k < 25; k++) changes[k] = [70];
    changes[25] = [52, 53, 54, 68, 69, 70, 84];
    // t = 5.0: a second click, a toast at 5.2, leaving at 7.2 (a hold from 5.5).
    changes[52] = [100, 101, 102];
    changes[72] = [100, 101, 102];
    const masks = masksOf(changes.slice(1));
    // The cursor sits on cell 5 (x 600–720, y 0–120 of 1920×1080) at t 1.0, where the press feedback changed.
    const cursor: CursorSample[] = [
      { t: 0.5, x: 650, y: 40, visible: true },
      { t: 3.5, x: 652, y: 40, visible: true },
      { t: 3.6, x: 900, y: 600, visible: true },
    ];
    const events = [click(1.0, 0), click(5.0, 1, { hold: { t_start: 5.5, t_end: 7.5 } })];
    const r = analyzeActivity({ masks, fps, width: 1920, height: 1080, cursor, effects: [{ t: 1.0, type: 'ripple', x: 650, y: 40 }], events });
    expect(r.transitions.map((x) => [x.step, x.ms])).toEqual([
      [0, 1500],
      [1, 200],
    ]);
    expect(r.busy).toEqual([{ t_start: 1.2, t_end: 2.5, click: 1 }]);
    expect(slowTransitions(r.transitions).map((x) => x.step)).toEqual([0]);
  });

  it('a page load the recorder held is part of the transition, not a wait to shorten; animated content is ignored', () => {
    const fps = 10;
    const changes: number[][] = Array.from({ length: 50 }, (_, k) => (k % 2 ? [143] : []));
    changes[29] = [16, 17, 18, 32, 33, 34];
    const masks = masksOf(changes.slice(1));
    const r = analyzeActivity({ masks, fps, width: 1920, height: 1080, cursor: [], events: [click(1.0, 0)], loading: [{ t_start: 1.1, t_end: 2.9, until: 'paint', held_frames: 40 }] });
    expect(r.transitions[0].ms).toBe(1900);
    expect(r.busy).toEqual([]);
  });
});

describe('fresh frames while a click ripple plays (R-FLD-20, recorder.ts)', () => {
  /** A recorder attached to a fake CDP session that records what it is sent. */
  function recorder(): { rec: ScreencastRecorder; sent: string[]; arrive: () => void } {
    const clock = new CaptureClock(Date.now());
    const rec = new ScreencastRecorder({ framesDir: dir, indexFile: join(dir, 'x.jsonl'), format: 'jpeg', quality: 90, width: 800, height: 600, scale: 1, clock, keepFrames: false });
    const sent: string[] = [];
    const session = { send: async (m: string) => void sent.push(m) };
    Object.assign(rec as unknown as Record<string, unknown>, { session, page: {}, lastArrival: Date.now() });
    return { rec, sent, arrive: () => Object.assign(rec as unknown as Record<string, unknown>, { lastArrival: Date.now() }) };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('no frame for KICK_GAP_MS after a press: the screencast is restarted (a fresh frame), at most every KICK_GAP_MS, for KICK_WINDOW_MS', async () => {
    const { rec, sent } = recorder();
    rec.pressed();
    await wait(KICK_GAP_MS + 60);
    expect(rec.kicked).toBe(1);
    expect(sent.slice(0, 2)).toEqual(['Page.stopScreencast', 'Page.startScreencast']);
    await wait(800);
    expect(rec.kicked).toBeGreaterThanOrEqual(3);
    expect(rec.kicked).toBeLessThanOrEqual(8);
    const after = rec.kicked;
    await wait(200);
    expect(rec.kicked).toBe(after);
    expect(rec.stats().kicked).toBe(after);
  });

  it('frames flowing: nothing is asked for; the encoder horizon trails the clock, and stops at a held load', async () => {
    const { rec, sent, arrive } = recorder();
    rec.pressed();
    for (let i = 0; i < 10; i++) {
      arrive();
      await wait(30);
    }
    expect(rec.kicked).toBe(0);
    expect(sent).toEqual([]);
    const clock = (rec as unknown as { opts: { clock: CaptureClock } }).opts.clock;
    expect(rec.horizon()).toBeCloseTo(clock.now() - STREAM_LAG_S, 1);
    const hold = (rec as unknown as { hold: { begin: (l: string, k: string, p?: string, web?: boolean) => void } }).hold;
    const since = Date.now();
    hold.begin('loader-1', 'navigation', 'app', true);
    await wait(700);
    expect(rec.horizon()).toBeCloseTo(clock.at(since), 1);
  });
});

describe('the CPU sampler (perf.ts)', () => {
  it('parses ps times, groups Chromium processes, finds local ports', () => {
    expect(parseCpuTime('0:01.25')).toBeCloseTo(1.25);
    expect(parseCpuTime('1:02:03.50')).toBeCloseTo(3723.5);
    expect(parseCpuTime('2-01:00:00')).toBe(2 * 86400 + 3600);
    expect(Number.isNaN(parseCpuTime('x'))).toBe(true);
    expect(['browser', 'GPU', 'renderer', 'network.mojom.NetworkService'].map(chromiumGroup)).toEqual(['browser', 'gpu', 'renderer', 'chromium_other']);
    expect(localPorts(['http://localhost:4401', 'http://127.0.0.1:8080/x', 'https://app.localhost', 'https://example.com:4402', 'nope'])).toEqual([4401, 8080, 443]);
  });

  it('sums the take per group and per browser: processes there at the first sample count from then, later ones from their start', async () => {
    const reports = [
      [
        { realm: 'buyer', type: 'browser', pid: 1, cpu: 10 },
        { realm: 'buyer', type: 'GPU', pid: 2, cpu: 5 },
        { realm: 'supplier', type: 'browser', pid: 3, cpu: 4 },
      ],
      [
        { realm: 'buyer', type: 'browser', pid: 1, cpu: 14 },
        { realm: 'buyer', type: 'GPU', pid: 2, cpu: 6 },
        { realm: 'buyer', type: 'renderer', pid: 4, cpu: 2 },
        { realm: 'supplier', type: 'browser', pid: 3, cpu: 4.5 },
      ],
    ];
    let i = 0;
    // The buyer's page is filmed; the supplier's is not (R-FLD-25: what its browser costs then).
    const s = new PerfSampler({ chromium: async () => reports[Math.min(i++, reports.length - 1)], filmed: () => new Set(['buyer']), intervalMs: 60_000 });
    s.start();
    await new Promise((r) => setTimeout(r, 120));
    const cpu = await s.stop();
    expect(cpu).toMatchObject({ browser: 4.5, gpu: 1, renderer: 2, chromium_other: 0, encoder: 0 });
    expect(cpu!.browsers).toEqual([
      { persona: 'buyer', cpu: 7 },
      { persona: 'supplier', cpu: 0.5, unfilmed: { cpu: 0.5, seconds: expect.any(Number) } },
    ]);
    expect(cpu!.browsers![1].unfilmed!.seconds).toBeGreaterThan(0.05);
    expect(cpu!.total).toBeCloseTo(7.5 + cpu!.retake, 1);
    expect(s.machine().cpus).toBeGreaterThan(0);
    // No Chromium report at all: no CPU figures.
    const none = new PerfSampler({ chromium: async () => [], intervalMs: 60_000 });
    none.start();
    expect(await none.stop()).toBeUndefined();
  });
});

describe('GPU, choppy motion, disk (R-FLD-24, R-FLD-28)', () => {
  it('reads the GPU report of Chromium: hardware compositing and rasterization, SwiftShader is software', () => {
    const metal = gpuInfoOf({
      gpu: {
        featureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled', webgl: 'enabled', video_decode: 'enabled' },
        auxAttributes: { glRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4)' },
      },
    });
    expect(metal).toEqual({ accelerated: true, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4)' });
    const shell = gpuInfoOf({
      gpu: {
        featureStatus: { gpu_compositing: 'disabled_software', rasterization: 'disabled_software', '2d_canvas': 'unavailable_software', opengl: 'disabled_off' },
        devices: [{ deviceString: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))' }],
      },
    });
    expect(shell).toEqual({ accelerated: false, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))', software: ['2d_canvas', 'gpu_compositing', 'rasterization'] });
    expect(gpuInfoOf({ gpu: { featureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled' }, auxAttributes: { glRenderer: 'SwiftShader' } } })?.accelerated).toBe(false);
    expect(gpuInfoOf({})).toBeUndefined();
  });

  it('the choppy-motion warning names the measured cause, then its figures', () => {
    const machine = { cpus: 10, load_mean: 2, load_max: 3 };
    const cpu = { browser: 20, gpu: 4, renderer: 3, chromium_other: 1, retake: 6, encoder: 5, total: 39, cores: 0.8 };
    const gpu = { accelerated: true, renderer: 'ANGLE Metal' };
    expect(choppyCause({ gpu: { accelerated: false, renderer: 'SwiftShader' }, cpu, machine, seconds: 50, frameRateLimit: true })).toMatch(
      /^measured: the browser renders in software.*no GPU acceleration \(SwiftShader\)/,
    );
    expect(choppyCause({ gpu, cpu, machine: { ...machine, load_max: 24 }, seconds: 50, frameRateLimit: true })).toMatch(/^measured: the machine was busy.*machine load up to 24\.0 on 10 cores/);
    expect(choppyCause({ gpu, cpu: { ...cpu, renderer: 45 }, machine, seconds: 50, frameRateLimit: true })).toMatch(/page's own rendering is heavy.*renderer 0\.90/);
    expect(choppyCause({ gpu, cpu, machine, seconds: 50, frameRateLimit: false })).toMatch(/frame_rate_limit: false/);
    expect(choppyCause({ gpu, cpu, machine, seconds: 50, frameRateLimit: true })).toMatch(/^measured: no load measured.*GPU hardware accelerated \(ANGLE Metal\)/);
    // L5.14b: another take filming beside it is said before a busy machine; heavy work slowed during it is a figure.
    expect(choppyCause({ gpu, cpu, machine: { ...machine, load_max: 24, takes_beside: 1, heavy_slowed: true }, seconds: 50, frameRateLimit: true })).toMatch(
      /^measured: another take filmed at the same time on this Mac: film one take at a time \(.*machine load up to 24\.0 on 10 cores, another take filming beside it, heavy work \(a render, review or export\) slowed during the take/,
    );
    expect(choppyCause({ gpu, cpu, machine: { ...machine, takes_beside: 0 }, seconds: 50, frameRateLimit: true })).toMatch(/^measured: no load measured/);
  });

  it('the disk check reads the free space of the run folder', async () => {
    const d = await diskCheck(dir, 'demo');
    expect(d.free_gb).toBeGreaterThan(0);
    if (d.warning) expect(d.warning).toContain('retake prune demo');
    // Without the switch the warning follows the thresholds; RETAKE_DISK_WARN=off (set for the suite) drops it only.
    const f = await statfs(dir);
    const low = (f.bavail * f.bsize) / 1e9 < DISK_FREE_MIN_GB || f.bavail / f.blocks < DISK_FREE_MIN_SHARE;
    expect(Boolean((await diskCheck(dir, 'demo', {})).warning)).toBe(low);
    const off = await diskCheck(dir, 'demo', { RETAKE_DISK_WARN: 'off' });
    expect(off.warning).toBeUndefined();
    expect(off.free_gb).toBeGreaterThan(0);
  });
});

describe('capture.prewarm: the pages a scenario opens (R-FLD-27)', () => {
  it('scene opens, multi-page opens and open steps, resolved on their environment page, once each, up to --until', () => {
    const envPages = { shop: 'http://localhost:4402', console: 'http://localhost:4401/app/' };
    const scenario = {
      scenes: [
        { id: 'a', page: 'shop', open: '/', steps: [{ open: '/products/{{vars.slug}}' }, { click: 'x' }] },
        { card: { slots: { title: 'x' } } },
        { id: 'b', page: 'console', open: 'quotes', steps: [{ open: { url: 'shop:/cart', page: 'shop' } }] },
        { id: 'c', pages: { left: { open: 'shop:/', viewport: 'laptop' }, right: { page: 'console', open: '/reports' } } },
        { id: 'd', page: 'shop', open: 'https://elsewhere.example/x', skip: true },
        { id: 'e', page: 'shop', open: '/after-until' },
      ],
    } as never;
    const template = (e: SceneEntry): SceneEntry => JSON.parse(JSON.stringify(e).replace('{{vars.slug}}', 'selowa-ridge'));
    expect(prewarmTargets(scenario, { envPages, capture: { width: 1920, height: 1080 }, template, lastScene: 4 })).toEqual([
      { page: 'shop', url: 'http://localhost:4402/' },
      { page: 'shop', url: 'http://localhost:4402/products/selowa-ridge' },
      { page: 'console', url: 'http://localhost:4401/app/quotes' },
      { page: 'shop', url: 'http://localhost:4402/cart' },
      { page: 'left', url: 'http://localhost:4402/' },
      { page: 'right', url: 'http://localhost:4401/app/reports' },
    ]);
    // A scene that cannot be templated yet is skipped.
    expect(prewarmTargets(scenario, { envPages, capture: { width: 1920, height: 1080 }, template: () => null })).toEqual([]);
  });
});
