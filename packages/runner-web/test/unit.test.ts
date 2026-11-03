import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CAPTURE, DEFAULT_PACING, TimelineSchema, isoDay, parseDay } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import {
  arcPath,
  computeIdle,
  cfrSchedule,
  motionCapture,
  motionWarnings,
  frameRateArgs,
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
import { LONG_TEXT_MAX_CPS, SEARCH_MAX_CPS, typingRate } from '../src/actions/keyboard.js';
import { matchDay, monthDirection } from '../src/actions/calendar.js';
import type { CalendarDay } from '../src/kit/types.js';
import { parkPlan } from '../src/park.js';
import { normalizeStep } from '@retake/core';
import { CaptureClock, TimelineBuilder, TrackBuilder } from '../src/timeline.js';
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
    expect(motionCapture([], [], 18)).toEqual({ moves: 0, slow: 0, stalls: [] });
    // A slow page also slows the dispatch of mouse moves down: 10 positions per second is choppy even at 60 fps.
    const sparse = Array.from({ length: 6 }, (_, i) => ({ t: 1 + i / 10, x: i * 40, y: 0, visible: true }));
    const dense = Array.from({ length: 31 }, (_, i) => 1 + i / 60);
    expect(motionCapture(dense, sparse, 18)).toMatchObject({ moves: 1, slow: 1 });
  });

  it('reports stalls: frame gaps ≥ 150 ms (STALL_MIN_S) while the cursor moves or a click ripple plays, not while it rests (L1.3)', () => {
    // A 0.6 s move sampled at 60 Hz, then a rest, then a press / release at the same point and its ripple at 3.0 s.
    const move = Array.from({ length: 37 }, (_, i) => ({ t: 1 + i / 60, x: 100 + i * 10, y: 100, visible: true }));
    // A click right after the move (same group: < 0.25 s apart), then a second click at 3.0 s.
    const click1 = [{ t: 1.75, x: 460, y: 100, visible: true, down: true }, { t: 1.84, x: 460, y: 100, visible: true }];
    const press = [{ t: 3, x: 460, y: 100, visible: true, down: true }, { t: 3.09, x: 460, y: 100, visible: true }];
    const cursor = [...move, ...click1, ...press];
    const effects = [{ t: 3, type: 'press' as const }, { t: 3, type: 'ripple' as const }];
    // Frames every 1/60 s during the move except a 265 ms hole at 1.2 s; none while resting (1.6–3.0 s: nothing
    // changes); every 1/60 s during the ripple except a 260 ms hole at 3.2 s.
    const frames = [
      ...Array.from({ length: 13 }, (_, i) => 1 + i / 60),
      ...Array.from({ length: 20 }, (_, i) => 1.465 + i / 60),
      ...Array.from({ length: 12 }, (_, i) => 3 + i / 60),
      ...Array.from({ length: 10 }, (_, i) => 3.46 + i / 60),
    ];
    const m = motionCapture(frames, cursor, 18, effects);
    expect(m.stalls).toEqual([
      { t: 1.2, t_end: 1.465, ms: 265, during: 'move' },
      { t: 3.183, t_end: 3.46, ms: 277, during: 'ripple' },
    ]);
    // The motion is judged on its own (1.0–1.6 s: 22 frames), not with the rest and the click after it (to 1.84 s).
    expect(m.moves).toBe(1);
    expect(m.worst!.fps).toBeCloseTo(22 / 0.6, 0);
    // Without the ripple effect, the second hole is idle time: nothing changes on screen then.
    expect(motionCapture(frames, cursor, 18).stalls.map((s) => s.during)).toEqual(['move']);
    // The run warnings say where.
    const w = motionWarnings(m, 18, '');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^the capture froze 2 times while the cursor moved or a click ripple played \(longest 277 ms\): 1\.2 s \(265 ms, cursor moving\), 3\.2 s \(277 ms, click ripple\)/);
    expect(w[0]).toContain('the edit cuts the frozen part');
    expect(motionWarnings(motionCapture(frames, cursor, 18), 18, '')[0]).not.toContain('the edit cuts');
    expect(motionWarnings(null, 18, '')).toEqual([]);
    // A gap while the page changes (navigation, new route) is the product's loading, not a stall.
    expect(motionCapture(frames, cursor, 18, effects, [1.3]).stalls.map((s) => s.during)).toEqual(['ripple']);
    // Nor a page load the recorder held (R-ISS-08): no frame until the new page painted.
    expect(motionCapture(frames, cursor, 18, effects, [], [{ t_start: 3.1, t_end: 3.46 }]).stalls.map((s) => s.during)).toEqual(['move']);
    expect(motionCapture(frames, cursor, 18, effects, [], [{ t_start: 5, t_end: 6 }]).stalls).toHaveLength(2);
    // Shorter gaps (a hover hitch of 120 ms) are not reported.
    const hitch = [...Array.from({ length: 13 }, (_, i) => 1 + i / 60), ...Array.from({ length: 20 }, (_, i) => 1.32 + i / 60)];
    expect(motionCapture(hitch, move, 18).stalls).toEqual([]);
  });

  it('a 1 px nudge of the resting cursor is no motion (it waits for a fresh frame after a scroll)', () => {
    // At rest at 100 since 0.5 s; nudged at 2.0 s (probing the capture), back at 2.06 s; the glide starts at 2.4 s.
    const glide = Array.from({ length: 31 }, (_, i) => ({ t: 2.4 + i / 60, x: 100 + i * 10, y: 100, visible: true }));
    const cursor = [
      { t: 0.5, x: 100, y: 100, visible: true },
      { t: 2.0, x: 101, y: 100, visible: true },
      { t: 2.06, x: 100, y: 100, visible: true },
      ...glide.slice(1),
    ];
    // No frame from 2.0 to 2.4 s (the stall the cursor waited out), then 60 fps.
    const frames = [2.0, ...Array.from({ length: 31 }, (_, i) => 2.4 + i / 60)];
    const m = motionCapture(frames, cursor, 18);
    expect(m.stalls).toEqual([]);
    expect(m.moves).toBe(1);
    expect(m.worst!.t).toBeCloseTo(2.4 + 1 / 60, 3); // the move starts with the glide, not with the nudges
    // The probing can end on a nudge that goes straight home (< 30 ms later), the glide starting a while after.
    const quickBack = [
      { t: 0.5, x: 100, y: 100, visible: true },
      { t: 2.0, x: 101, y: 100, visible: true },
      { t: 2.014, x: 100, y: 100, visible: true },
      ...glide.slice(1),
    ];
    expect(motionCapture(frames, quickBack, 18).stalls).toEqual([]);
  });

  it('timeline and tracks list the page loads the capture held only when there are some (R-ISS-08)', () => {
    const clock = new CaptureClock(0);
    const meta = { run_id: 'r', project: 'p', scenario: 's', mode: 'capture' as const, capture: { ...DEFAULT_CAPTURE, width: 800, height: 600 } };
    const capture = { file: 'capture.mp4', duration: 5, frames: 1, frameTimes: [0.1] };
    const tb = new TimelineBuilder(meta, clock);
    const track = new TrackBuilder({ id: 'app', file: 'capture-app.mp4', frames_file: 'frames-app.jsonl', width: 800, height: 600, scale: 1, fps: 30 }, clock);
    tb.tracks.push(track);
    let tl = tb.build(capture);
    expect(tl).not.toHaveProperty('loading');
    expect(tl.tracks![0]).not.toHaveProperty('loading');
    tb.loading = [{ t_start: 1, t_end: 1.8, page: 'main', until: 'paint', held_frames: 40 }];
    track.loading = [{ t_start: 2, t_end: 2.3, page: 'app', until: 'load', held_frames: 3 }];
    tl = tb.build(capture);
    expect(tl.loading).toEqual(tb.loading);
    expect(tl.tracks![0].loading).toEqual(track.loading);
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
  });

  it('keeps Chromium\'s frame rate limiter unless the project turns it off (L1.3)', () => {
    expect(frameRateArgs()).toEqual([]);
    expect(frameRateArgs({ frame_rate_limit: true })).toEqual([]);
    expect(frameRateArgs({ frame_rate_limit: false })).toEqual(['--disable-frame-rate-limit']);
    expect(frameRateArgs({ frame_rate_limit: false, args: ['--disable-frame-rate-limit'] })).toEqual([]);
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
    expect(mergeCapture({ width: 2560, height: 1440 }, { scale: 2 })).toMatchObject({ width: 2560, height: 1440, scale: 2, fps: 30, quality: 90, keep_frames: false });
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

describe('choreography helpers (pure)', () => {
  it('adapts the typing rate to the field: search ≤ 10, default, long free text up to 24 (R-CHO-14)', () => {
    expect(SEARCH_MAX_CPS).toBe(10);
    expect(LONG_TEXT_MAX_CPS).toBe(24);
    expect(typingRate('search', 12, 14)).toEqual({ cps: 10, rate: 'search' });
    expect(typingRate('search', 200, 8)).toEqual({ cps: 8, rate: 'search' });
    expect(typingRate('search', 12, 60)).toEqual({ cps: 10, rate: 'search' });
    expect([30, 40, 80, 120, 200].map((n) => typingRate('text', n, 14).cps)).toEqual([14, 14, 19, 24, 24]);
    expect(typingRate('multiline', 80, 14)).toEqual({ cps: 19, rate: 'long' });
    expect(typingRate(null, 30, 14)).toEqual({ cps: 14, rate: 'default' });
    expect(typingRate('text', 200, 60)).toEqual({ cps: 60, rate: 'default' });
  });

  it('reads days in ISO and English long forms, anywhere in a label (R-CHO-24)', () => {
    const d = parseDay('2027-01-10');
    expect(d).not.toBeNull();
    for (const s of ['10 January 2027', 'Sunday, 10 January 2027', 'January 10th, 2027', 'Jan 10, 2027', 'Choose Sunday, January 10, 2027', '10th of January 2027', 'Today, 10\u00a0Jan 2027']) {
      expect(parseDay(s), s).toBe(d);
    }
    expect(isoDay(d!)).toBe('2027-01-10');
    expect(parseDay('10 janvier 2027')).toBeNull();
    expect(parseDay('31 February 2027')).toBeNull();
    expect(parseDay('January 2027')).toBeNull();
  });

  it('matches a day as a date, never a longer number; pages towards it (R-CHO-24)', () => {
    const cell = (label: string, extra: Partial<CalendarDay> = {}): CalendarDay => ({ ref: label, label, iso: null, disabled: false, outside: false, ...extra });
    const days = [
      cell('Friday, 1 January 2027'),
      cell('Monday, 11 January 2027'),
      cell('Thursday, 21 January 2027'),
      cell('Sunday, 31 January 2027'),
      cell('Monday, 1 February 2027', { outside: true }),
    ];
    expect(matchDay(days, '1 January 2027')?.label).toBe('Friday, 1 January 2027');
    expect(matchDay(days, '2027-01-11')?.label).toBe('Monday, 11 January 2027');
    expect(matchDay(days, 'January 31st, 2027')?.label).toBe('Sunday, 31 January 2027');
    expect(matchDay(days, '1 March 2027')).toBeNull();
    // Date attributes win over labels; a label query matches whole words.
    expect(matchDay([cell('7', { iso: '2027-03-07' })], '7 March 2027')?.iso).toBe('2027-03-07');
    expect(matchDay([cell('Lundi 1 janvier'), cell('Lundi 11 janvier')], '1 janvier')?.label).toBe('Lundi 1 janvier');
    // An outside-month copy only when nothing else matches.
    expect(matchDay([cell('Monday, 1 February 2027', { outside: true }), cell('Monday, 1 February 2027', { ref: 'in' })], '1 February 2027')?.ref).toBe('in');
    // A day shown only as a disabled copy from the next month is not shown: the calendar pages to it (review fix K5).
    expect(matchDay([...days, cell('Wednesday, 3 February 2027', { outside: true, disabled: true })], '3 February 2027')).toBeNull();
    expect(monthDirection([...days, cell('Wednesday, 3 February 2027', { outside: true, disabled: true })], '3 February 2027')).toBe('next');
    expect(matchDay([cell('Monday, 1 February 2027', { disabled: true })], '1 February 2027')?.disabled).toBe(true);
    expect(monthDirection(days, '2026-12-24')).toBe('previous');
    expect(monthDirection(days, '2027-03-02')).toBe('next');
    expect(monthDirection(days, '2027-01-15')).toBe('inside');
    expect(monthDirection(days, 'someday')).toBe('next');
  });

  it('parks only when a step asks: next to a scroll target, else away from the result; holds (R-CHO-18/21)', () => {
    const plan = (step: Record<string, unknown>) => parkPlan(normalizeStep(step as never, 0), DEFAULT_PACING);
    expect(plan({ click: 'Save' })).toBeNull();
    expect(plan({ click: 'Save', park: false })).toBeNull();
    expect(plan({ click: 'Save', park: true })).toEqual({ kind: 'result', when: 'after', hold_s: 2 });
    expect(plan({ click: 'Save', park: true, hold: 1.2 })).toEqual({ kind: 'result', when: 'after', hold_s: 1.2 });
    expect(plan({ click: 'Save', park: 2.5, hold: 1 })).toEqual({ kind: 'result', when: 'after', hold_s: 2.5 });
    expect(plan({ scroll: 'Awards', park: true })).toEqual({ kind: 'scroll', when: 'after', hold_s: 3.2 });
    expect(plan({ scroll: { to: '#awards' }, park: true })).toEqual({ kind: 'scroll', when: 'after', hold_s: 3.2 });
    expect(plan({ scroll: { by: 400 }, park: true })).toEqual({ kind: 'result', when: 'after', hold_s: 2 });
    expect(plan({ wait_for: 'Saved', park: 0 })).toEqual({ kind: 'result', when: 'after', hold_s: 0 });
    expect(plan({ hold: 2, park: true })).toEqual({ kind: 'result', when: 'before', hold_s: 0 });
  });
});
