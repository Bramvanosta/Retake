import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PACING } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';
import {
  arcPath,
  computeIdle,
  cfrSchedule,
  motionCapture,
  encodeFrames,
  kitConfigFor,
  kitSource,
  mergeCapture,
  mergePacing,
  moveDuration,
  isNudge,
  projectBrowser,
  resolveAuth,
} from '../src/index.js';
import { imageSize } from '../src/recorder.js';
import { MAX_TICK_ADVANCE_MS, Pointer, TICK_MS } from '../src/pointer.js';
import type { PointerHost } from '../src/pointer.js';
import { execFileP, ffprobeDuration, frameAt, makeProject, tempDir } from './helpers.js';

let dir: string;
beforeAll(async () => {
  dir = await tempDir('rw-unit-');
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('motion', () => {
  it('durations grow with distance within the field-tested bounds', () => {
    expect(moveDuration(0, DEFAULT_PACING)).toBe(0);
    expect(moveDuration(30, DEFAULT_PACING)).toBeLessThanOrEqual(250);
    const short = moveDuration(120, DEFAULT_PACING);
    const long = moveDuration(900, DEFAULT_PACING);
    expect(short).toBeGreaterThanOrEqual(450);
    expect(long).toBeGreaterThan(short);
    expect(moveDuration(5000, DEFAULT_PACING)).toBe(1100);
  });

  it('follows the field notes: clamp(0.9·d, 450, 1100) ms; nudges 150–250 ms; zero-length moves 0 ms (R-CHO-03)', () => {
    const p = DEFAULT_PACING;
    expect([p.move_base_ms, p.move_ms_per_px, p.move_min_ms, p.move_max_ms]).toEqual([0, 0.9, 450, 1100]);
    expect(moveDuration(300, p)).toBe(450); // 270 → 450
    expect(moveDuration(600, p)).toBe(540);
    expect(moveDuration(1000, p)).toBe(900);
    expect(moveDuration(1300, p)).toBe(1100);
    // Repeated clicks on (almost) the same spot: short moves, never a 450 ms move to nowhere.
    expect(moveDuration(0.4, p)).toBe(0);
    expect(moveDuration(2, p)).toBe(150);
    expect(moveDuration(30, p)).toBe(150);
    expect(moveDuration(45, p)).toBe(188);
    expect(moveDuration(59, p)).toBe(246);
    expect(moveDuration(60, p)).toBe(450);
    for (let d = 1; d < p.nudge_px; d += 3) {
      expect(moveDuration(d, p)).toBeGreaterThanOrEqual(150);
      expect(moveDuration(d, p)).toBeLessThanOrEqual(250);
    }
    expect(isNudge(59, p)).toBe(true);
    expect(isNudge(60, p)).toBe(false);
    // The nudge fields are pacing settings.
    expect(moveDuration(40, { ...p, nudge_px: 30 })).toBe(450);
    expect(moveDuration(30, { ...p, nudge_ms: 200 })).toBe(120);
  });

  it('pacing defaults: navigation hold, popup fallback, scroll offset (R-CHO-07/09/17)', () => {
    expect(DEFAULT_PACING.after_navigation_ms).toBe(1500);
    expect(DEFAULT_PACING.popup_fallback_ms).toBeGreaterThanOrEqual(250);
    expect(DEFAULT_PACING.popup_fallback_ms).toBeLessThanOrEqual(350);
    expect(DEFAULT_PACING.popup_fallback_ms).toBeLessThan(DEFAULT_PACING.popup_timeout_ms);
    expect(DEFAULT_PACING.scroll_offset).toBe(-140);
    expect(mergePacing({ after_navigation_ms: 2000 }, { scroll_offset: -100 })).toMatchObject({ after_navigation_ms: 2000, scroll_offset: -100, popup_fallback_ms: 300 });
  });

  it('arcs slightly and lands exactly on the target', () => {
    const p = arcPath({ x: 0, y: 0 }, { x: 1000, y: 0 }, 1);
    expect(p(0)).toEqual({ x: 0, y: 0 });
    expect(p(1)).toEqual({ x: 1000, y: 0 });
    expect(Math.abs(p(0.5).y)).toBeCloseTo(60, 5); // min(60, 0.08·d)
    const q = arcPath({ x: 0, y: 0 }, { x: 100, y: 0 }, -1);
    expect(Math.abs(q(0.5).y)).toBeCloseTo(8, 5);
  });
});

/**
 * A Pointer on a fake page and a fake clock: `stall(tick)` = extra ms the runner loses at that tick (a late timer or a
 * slow CDP round trip on a loaded machine). Returns the dispatched positions with their (fake) times.
 */
async function glide(opts: { from: { x: number; y: number }; to: { x: number; y: number }; ms: number; stall?: (tick: number) => number; cdpMs?: number }) {
  let now = 0;
  let tick = 0;
  const moves: Array<{ t: number; x: number; y: number }> = [];
  const host = {
    page: () => ({ mouse: { move: async (x: number, y: number) => { now += opts.cdpMs ?? 1; moves.push({ t: now, x, y }); } } }),
    kit: () => ({ cursorSet: async () => undefined }),
    timeline: { sampleCursor: () => undefined },
    pacing: DEFAULT_PACING,
    signal: new AbortController().signal,
    scale: 1,
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms + (opts.stall?.(tick++) ?? 0);
      },
    },
  } as unknown as PointerHost;
  const p = new Pointer(host);
  await p.teleport(opts.from);
  moves.length = 0;
  const used = await p.moveTo(opts.to, { ms: opts.ms, arc: false });
  return { moves, used, end: now };
}

describe('cursor glide under load (motion clock)', () => {
  const from = { x: 100, y: 100 };
  const to = { x: 700, y: 400 };
  const d = Math.hypot(600, 300);
  const maxStep = (moves: Array<{ x: number; y: number }>) => {
    let prev = from;
    let m = 0;
    for (const q of moves) {
      m = Math.max(m, Math.hypot(q.x - prev.x, q.y - prev.y));
      prev = q;
    }
    return m;
  };
  /** Largest step the eased path can make in one tick: max slope of easeInOutCubic (3) × the motion advance cap. */
  const bound = (ms: number) => 3 * (MAX_TICK_ADVANCE_MS / ms) * d + 1;

  it('on time: ~60 Hz small eased steps, the planned duration, lands exactly', async () => {
    const r = await glide({ from, to, ms: 600 });
    expect(r.moves.at(-1)).toMatchObject(to);
    // (a tick whose eased position rounds to the same pixel dispatches nothing: the very start and end of the ease)
    expect(r.moves.length).toBeGreaterThanOrEqual(Math.floor((0.8 * 600) / TICK_MS));
    expect(r.end).toBeGreaterThanOrEqual(600);
    expect(r.end).toBeLessThan(600 + 3 * TICK_MS);
    expect(maxStep(r.moves)).toBeLessThan(3 * (TICK_MS / 600) * d + 1);
  });

  it('a stalled runner pauses the glide and resumes it: never a jump, whatever the stall (R-ISS-04)', async () => {
    // A 400 ms stall in the middle of a 450 ms glide: the old wall-clock loop jumped ≈ 0.9 d in one step.
    for (const stall of [(t: number) => (t === 10 ? 400 : 0), (t: number) => (t % 3 === 0 ? 120 : 0), () => 45]) {
      const r = await glide({ from, to, ms: 450, stall });
      expect(r.moves.at(-1)).toMatchObject(to);
      expect(maxStep(r.moves)).toBeLessThan(bound(450));
      expect(maxStep(r.moves)).toBeLessThan(0.25 * d);
      // Monotonic along the straight path: progress never goes back.
      const prog = r.moves.map((q) => ((q.x - from.x) * 600 + (q.y - from.y) * 300) / (d * d));
      for (let i = 1; i < prog.length; i++) expect(prog[i]).toBeGreaterThanOrEqual(prog[i - 1] - 1e-9);
      // Enough intermediate positions to read as a glide: at least ms / (2 ticks).
      expect(r.moves.length).toBeGreaterThanOrEqual(Math.floor(450 / MAX_TICK_ADVANCE_MS));
    }
  });

  it('slow CDP round trips (every move takes 40 ms) slow the glide down instead of skipping', async () => {
    const r = await glide({ from, to, ms: 450, cdpMs: 40 });
    expect(r.moves.at(-1)).toMatchObject(to);
    expect(maxStep(r.moves)).toBeLessThan(bound(450));
    expect(r.end).toBeGreaterThan(450);
  });
});

describe('timeline helpers', () => {
  it('idle = gaps of at least 0.5 s between frames, including the start and the end', () => {
    expect(computeIdle([0.1, 0.2, 1.0, 1.1], 2.0)).toEqual([
      { t_start: 0.2, t_end: 1.0 },
      { t_start: 1.1, t_end: 2.0 },
    ]);
    expect(computeIdle([0.6, 0.7], 0.8)).toEqual([{ t_start: 0, t_end: 0.6 }]);
  });

  it('CFR schedule: each output frame shows the latest captured frame at its time; first extended back, last held', () => {
    const schedule = cfrSchedule(
      [
        { file: '000002.jpg', t: 0.5 },
        { file: '000001.jpg', t: 0.2 },
        { file: '000003.jpg', t: 1.1 },
        { file: '000004.jpg', t: 2.5 }, // after the end: ignored
      ],
      2,
      10,
    );
    expect(schedule).toEqual([
      '000001.jpg', '000001.jpg', '000001.jpg', '000001.jpg', '000001.jpg', // 0.0–0.4 (before the first frame too)
      '000002.jpg', '000002.jpg', '000002.jpg', '000002.jpg', '000002.jpg', '000002.jpg', // 0.5–1.0
      '000003.jpg', '000003.jpg', '000003.jpg', '000003.jpg', '000003.jpg', '000003.jpg', '000003.jpg', '000003.jpg', '000003.jpg', // 1.1–1.9
    ]);
    // Millisecond timestamps are honoured exactly (no 1/25 s quantisation): a frame stamped 1 ms after a tick waits.
    expect(cfrSchedule([{ file: 'a', t: 0 }, { file: 'b', t: 0.034 }], 0.1, 30)).toEqual(['a', 'a', 'b']);
    expect(cfrSchedule([{ file: 'a', t: 0 }, { file: 'b', t: 0.0333 }], 0.1, 30)).toEqual(['a', 'b', 'b']);
    expect(() => cfrSchedule([{ file: 'a', t: 3 }], 2, 30)).toThrow(/no frames/);
  });

  it('measures the frame rate captured during cursor moves', () => {
    const move = (t0: number, secs: number) =>
      Array.from({ length: Math.round(secs * 60) + 1 }, (_, i) => ({ t: t0 + i / 60, x: i, y: 0, visible: true }));
    const cursor = [...move(1, 0.5), ...move(3, 0.5), ...move(5, 0.1)];
    const frames = [
      ...Array.from({ length: 30 }, (_, i) => 1 + i / 60), // 60 fps during the first move
      ...Array.from({ length: 3 }, (_, i) => 3 + i / 6), // 6 fps during the second
    ];
    const m = motionCapture(frames, cursor, 18);
    expect(m.moves).toBe(2); // the 0.1 s move is too short to judge
    expect(m.slow).toBe(1);
    expect(m.worst?.t).toBe(3);
    expect(m.worst?.fps).toBeCloseTo(6, 0);
    expect(motionCapture([], [], 18)).toEqual({ moves: 0, slow: 0 });
    // A slow page also slows the dispatch of mouse moves down: 10 positions per second is choppy even at 60 fps.
    const sparse = Array.from({ length: 6 }, (_, i) => ({ t: 1 + i / 10, x: i * 40, y: 0, visible: true }));
    const dense = Array.from({ length: 31 }, (_, i) => 1 + i / 60);
    expect(motionCapture(dense, sparse, 18)).toMatchObject({ moves: 1, slow: 1 });
  });

  it('reads the pixel size of JPEG and PNG frames', async () => {
    const jpg = join(dir, 'size.jpg');
    const png = join(dir, 'size.png');
    await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x94', '-frames:v', '1', jpg]);
    await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', png]);
    expect(imageSize(await readFile(jpg))).toEqual({ width: 320, height: 94 });
    expect(imageSize(await readFile(png))).toEqual({ width: 64, height: 48 });
    expect(imageSize(Buffer.from('not an image'))).toBeNull();
  });
});

describe('encodeFrames', () => {
  it('turns VFR frames into a CFR mp4 of exactly the capture duration', async () => {
    const colors = ['red', 'lime', 'blue'];
    for (const [i, c] of colors.entries()) {
      await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=64x48`, '-frames:v', '1', '-q:v', '2', join(dir, `00000${i + 1}.jpg`)]);
    }
    const out = join(dir, 'out.mp4');
    await encodeFrames(
      dir,
      [
        { file: '000001.jpg', t: 0.2 },
        { file: '000002.jpg', t: 0.5 },
        { file: '000003.jpg', t: 1.1 },
      ],
      out,
      { fps: 30, crf: 18, endT: 2, width: 64, height: 48, preset: 'ultrafast' },
    );
    expect(Math.abs((await ffprobeDuration(out)) - 2)).toBeLessThanOrEqual(0.05);
    const px = async (t: number) => {
      const f = await frameAt(out, t, 64, 48);
      const i = (24 * 64 + 32) * 3;
      return [f[i], f[i + 1], f[i + 2]];
    };
    const [r0, g0] = await px(0.05);
    expect(r0).toBeGreaterThan(200);
    expect(g0).toBeLessThan(60);
    const [, g1] = await px(0.8);
    expect(g1).toBeGreaterThan(200);
    const [r2, , b2] = await px(1.9);
    expect(b2).toBeGreaterThan(200);
    expect(r2).toBeLessThan(60);
  });
});

describe('configuration', () => {
  it('merges pacing and capture layers over the defaults', () => {
    const p = mergePacing({ hover_ms: 250 }, { type_cps: 20, hover_ms: undefined });
    expect(p).toEqual({ ...DEFAULT_PACING, hover_ms: 250, type_cps: 20 });
    expect(mergeCapture({ width: 2560, height: 1440 }, { scale: 2 })).toMatchObject({ width: 2560, height: 1440, scale: 2, fps: 30, quality: 100 });
  });

  it('resolves auth globally or per environment, relative to the project', () => {
    const base = makeProject('/work/projects/northfield', { app: 'http://localhost' });
    const global: LoadedProject = { ...base, config: { ...base.config, auth: { profile: 'profiles/main' } } };
    expect(resolveAuth(global, 'test')).toEqual({ profileDir: '/work/projects/northfield/profiles/main', storageState: undefined });
    const perEnv: LoadedProject = { ...base, config: { ...base.config, auth: { test: { storage_state: '/abs/state.json' } } } };
    expect(resolveAuth(perEnv, 'test')).toEqual({ profileDir: undefined, storageState: '/abs/state.json' });
    expect(resolveAuth(perEnv, 'staging')).toEqual({});
  });

  it('the project locale is the browser locale unless browser.locale is set (R-PROJ-08)', () => {
    const base = makeProject('/work/projects/northfield', { app: 'http://localhost' });
    expect(projectBrowser(base).locale).toBeUndefined();
    const withLocale: LoadedProject = { ...base, config: { ...base.config, locale: 'sv-SE', browser: { timezone: 'Europe/Stockholm' } } };
    expect(projectBrowser(withLocale)).toEqual({ timezone: 'Europe/Stockholm', locale: 'sv-SE' });
    const explicit: LoadedProject = { ...withLocale, config: { ...withLocale.config, browser: { locale: 'en-GB' } } };
    expect(projectBrowser(explicit).locale).toBe('en-GB');
    expect(projectBrowser(withLocale, { locale: 'fr-FR' }).locale).toBe('fr-FR');
  });

  it('the kit source is a self-contained script', () => {
    const src = kitSource(kitConfigFor(undefined, { style: 'arrow-light', ripple_color: 'rgba(1,2,3,.4)' }));
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('"arrow-light"');
    expect(src).toContain('rgba(1,2,3,.4)');
    expect(kitConfigFor().cursor).toEqual({ style: 'arrow-dark', size: 26, ripple_color: 'rgba(0,0,0,.25)' });
  });
});
