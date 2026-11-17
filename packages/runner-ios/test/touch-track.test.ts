/**
 * A touch's touch-down read from the video (src/touch-track.ts): the first frame after t_act + 40 ms whose box differs
 * from the last frame before the touch, up to 100 ms past the call's return; a change elsewhere on a still screen bounds it; t_act + 130 ms when nothing
 * says it (no change, a box already changing, no frame before); a tap lifts 75 ms later; what the timeline gets (the
 * samples, the press, ripple and release, the event's t_click).
 */
import { describe, expect, it } from 'vitest';
import type { CursorEffect, CursorSample, TimelineEvent } from '@retake/core/run';
import type { CropFrame, TouchRecord } from '../src/touch-track.js';
import { TAP_HOLD_S, cropDiff, searchWindow, settleTouch, touchDownFrom, touchPoint, writeTouches } from '../src/touch-track.js';

const crop = (v: number, n = 100) => new Uint8Array(n).fill(v);
const f = (t: number, v: number): CropFrame => ({ t, pixels: crop(v) });

describe('the touch-down from the video', () => {
  it('the first frame after t_act + 40 ms whose box changed (mean |Δ| over 3/255)', () => {
    const frames = [f(8.0, 50), f(10.02, 51), f(10.03, 80), f(10.17, 90), f(10.2, 90)];
    // 10.03 is a change, but before t_act + 40 ms; 10.02 differs by 1 only.
    expect(touchDownFrom(frames, 10.0, 11)).toEqual({ t: 10.17, how: 'video' });
    expect(cropDiff(crop(50), crop(53))).toBe(3);
    expect(touchDownFrom([f(8, 50), f(10.1, 53)], 10.0, 11).how).not.toBe('video');
  });

  it('searched up to min(t_end + 100 ms, t_act + 600 ms): the screen may show the touch just after the call returned', () => {
    expect(touchDownFrom([f(8, 50), f(10.65, 90)], 10.0, 11)).toEqual({ t: 10.13, how: 'fallback', why: 'no change on screen there' });
    expect(touchDownFrom([f(8, 50), f(10.3, 90)], 10.0, 10.25)).toEqual({ t: 10.3, how: 'video' });
    expect(touchDownFrom([f(8, 50), f(10.36, 90)], 10.0, 10.25).how).toBe('fallback');
  });

  it('fallback t_act + 130 ms: no change, the box already changing before the touch, no frame before it', () => {
    expect(touchDownFrom([f(9.9, 50), f(9.95, 90), f(10.2, 10)], 10.0, 11)).toEqual({ t: 10.13, how: 'fallback', why: 'the screen there was already changing' });
    expect(touchDownFrom([f(10.2, 10)], 10.0, 11)).toEqual({ t: 10.13, how: 'fallback', why: 'no frame before the touch' });
  });

  it('a change elsewhere on a still screen bounds the touch-down (a stepper changes a label): its first new frame before the constant', () => {
    // The box (the frames' crops) stays the same; the screen made a frame at 10.08.
    expect(touchDownFrom([f(8, 50), f(10.08, 50), f(10.2, 50)], 10.0, 11)).toEqual({ t: 10.08, how: 'screen' });
    // A screen that was moving right before the touch says nothing of it.
    expect(touchDownFrom([f(9.85, 50), f(10.08, 50)], 10.0, 11).how).toBe('fallback');
    // Too early (before t_act + 40 ms) or past the constant: the constant.
    expect(touchDownFrom([f(8, 50), f(10.02, 50)], 10.0, 11).how).toBe('fallback');
    expect(touchDownFrom([f(8, 50), f(10.2, 50)], 10.0, 11).t).toBeCloseTo(10.13, 6);
  });

  it('the window a touch reads: from the frame before its reference (within 300 ms) to the search end', () => {
    expect(searchWindow([0, 5, 9.8, 9.9, 10.5], 10.0, 10.4)).toEqual({ from: 9.8, to: 10.5 });
    expect(searchWindow([0, 5, 10.5], 10.0, 12)).toEqual({ from: 5, to: 10.6 });
    expect(searchWindow([10.5], 10.0, 12)).toBeNull();
  });
});

describe('touches on the timeline', () => {
  const tap: TouchRecord = { kind: 'tap', t_act: 2, t_end: 2.3, x: 100, y: 200 };

  it('a tap lifts 75 ms after its touch-down; a swipe follows its path from the touch-down', () => {
    const t = settleTouch(tap, { t: 2.15, how: 'video' });
    expect(t).toEqual({ t_down: 2.15, t_up: 2.225, path: [{ t: 2.15, x: 100, y: 200 }], how: 'video' });
    expect(TAP_HOLD_S).toBe(0.075);
    const s = settleTouch({ kind: 'swipe', t_act: 5, t_end: 6, x: 200, y: 600, to: { x: 200, y: 300 }, press_s: 0.05, drag_s: 0.5, hold_s: 0.1 }, { t: 5.13, how: 'fallback' });
    expect(s.t_up).toBeCloseTo(5.78, 6);
    expect(touchPoint(s, 5.13)).toEqual({ x: 200, y: 600 });
    expect(touchPoint(s, 5.43).y).toBeCloseTo(450, 0);
    expect(touchPoint(s, 9)).toEqual({ x: 200, y: 300 });
  });

  it('samples (shown 150 ms before, down, up, hidden 180 ms after), press + ripple at the touch-down, release at the lift, the t_click', () => {
    const cursor: CursorSample[] = [];
    const effects: CursorEffect[] = [];
    const event = { t_click: undefined } as unknown as TimelineEvent;
    const tl = { sampleCursor: (s: CursorSample) => void cursor.push(s as CursorSample), cursorEffect: (e: CursorEffect) => void effects.push(e) };
    writeTouches(tl as never, [{ touch: settleTouch(tap, { t: 2.15, how: 'video' }), record: { ...tap, event } }]);
    expect(cursor).toEqual([
      { t: 0, x: 100, y: 200, visible: false },
      { t: 2, x: 100, y: 200, visible: true },
      { t: 2.15, x: 100, y: 200, visible: true, down: true },
      { t: 2.225, x: 100, y: 200, visible: true },
      { t: 2.405, x: 100, y: 200, visible: false },
    ]);
    expect(effects).toEqual([
      { t: 2.15, type: 'press' },
      { t: 2.15, type: 'ripple', x: 100, y: 200 },
      { t: 2.225, type: 'release' },
    ]);
    expect(event.t_click).toBe(2.15);
  });

  it('hidden from 0; two close touches and one at the very start: every sample and effect in time order, none before 0', () => {
    const cursor: CursorSample[] = [];
    const effects: CursorEffect[] = [];
    const tl = { sampleCursor: (s: CursorSample) => void cursor.push(s), cursorEffect: (e: CursorEffect) => void effects.push(e) };
    const at = (t: number, x: number) => ({ touch: settleTouch({ ...tap, x }, { t, how: 'video' as const }), record: { ...tap, x } });
    // The touch at 2.2 lands before the one at 2.15 lifts (2.225): its press comes before that release.
    writeTouches(tl as never, [at(2.2, 300), at(2.15, 100), at(0.05, 50)]);
    expect(cursor[0]).toEqual({ t: 0, x: 50, y: 200, visible: false });
    expect(cursor[1]).toEqual({ t: 0, x: 50, y: 200, visible: true });
    for (let i = 1; i < cursor.length; i++) expect(cursor[i].t, `sample ${i}`).toBeGreaterThanOrEqual(cursor[i - 1].t);
    for (let i = 1; i < effects.length; i++) expect(effects[i].t, `effect ${i}`).toBeGreaterThanOrEqual(effects[i - 1].t);
    expect(cursor.filter((c) => c.down).map((c) => c.x)).toEqual([50, 100, 300]);
    // The first touch's lift fade (2.405) comes after the second one shows (2.05): the samples interleave in time.
    expect(cursor.findIndex((c) => c.x === 300 && c.visible && !c.down)).toBeLessThan(cursor.findIndex((c) => c.x === 100 && !c.visible));
    expect(effects.map((e) => `${e.type}@${e.t}`).slice(-6)).toEqual(['press@2.15', 'ripple@2.15', 'press@2.2', 'ripple@2.2', 'release@2.225', 'release@2.275']);
  });
});
