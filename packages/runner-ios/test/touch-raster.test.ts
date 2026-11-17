/**
 * The touch overlay's look and pictures (src/touch-look.ts, src/touch-raster.ts, src/overlay.ts, src/ffconcat.ts): the
 * disc shows 150 ms before the touch-down and is gone 180 ms after the lift, the ripple starts at the touch-down and
 * grows to 5.5 × 12 pt, the pixels drawn where the touch is (device pixels: points × scale), a picture only per change,
 * the ffconcat list holding each to the next change and the last one repeated.
 */
import { describe, expect, it } from 'vitest';
import { ffconcatText } from '../src/ffconcat.js';
import { overlayPlan } from '../src/overlay.js';
import { DEFAULT_RIPPLE, cubicBezier, marksKey, parseColor, touchMarks } from '../src/touch-look.js';
import { clearBox, drawMarks } from '../src/touch-raster.js';
import type { Touch } from '../src/touch-track.js';

const tap: Touch = { t_down: 1, t_up: 1.075, path: [{ t: 1, x: 100, y: 200 }], how: 'video' };

describe('the touch look', () => {
  it('the disc from t_down − 150 ms to t_up + 180 ms; the ripple from the touch-down, for .55 s', () => {
    expect(touchMarks([tap], 0.84)).toEqual([]);
    expect(touchMarks([tap], 0.86).map((m) => m.kind)).toEqual(['dot']);
    expect(touchMarks([tap], 0.999).some((m) => m.kind === 'ripple')).toBe(false);
    const at = touchMarks([tap], 1.0);
    expect(at.map((m) => m.kind)).toEqual(['ripple', 'dot']);
    expect(at[0]).toMatchObject({ kind: 'ripple', x: 100, y: 200 });
    expect(at[0].kind === 'ripple' && at[0].radius).toBeCloseTo(2.4, 6);
    const late = touchMarks([tap], 1.5);
    expect(late.map((m) => m.kind)).toEqual(['ripple']);
    expect(late[0].kind === 'ripple' && late[0].radius).toBeCloseTo(33, 0);
    expect(touchMarks([tap], 1.56)).toEqual([]);
    const pressed = touchMarks([tap], 1.07).find((m) => m.kind === 'dot');
    expect(pressed?.kind === 'dot' && pressed.scale).toBeLessThan(0.95);
  });

  it('timing functions and colours', () => {
    expect(cubicBezier(0.2, 0.7, 0.2, 1, 0)).toBe(0);
    expect(cubicBezier(0.2, 0.7, 0.2, 1, 1)).toBe(1);
    expect(cubicBezier(0.2, 0.7, 0.2, 1, 0.5)).toBeGreaterThan(0.85);
    expect(parseColor('rgba(138, 35, 50, 0.45)')).toEqual([138, 35, 50, 0.45]);
    expect(parseColor('#3355d1')).toEqual([51, 85, 209, 1]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('blue')).toBeNull();
  });
});

describe('the overlay pictures', () => {
  it('drawn at the touch, in device pixels; nothing elsewhere; cleared back', () => {
    const pic = { width: 402 * 3, height: 300 * 3, data: new Uint8Array(402 * 3 * 300 * 3 * 4) };
    const box = drawMarks(pic, touchMarks([tap], 1.0), 3, DEFAULT_RIPPLE);
    const alpha = (x: number, y: number) => pic.data[(y * pic.width + x) * 4 + 3];
    expect(alpha(300, 600)).toBeGreaterThan(60);
    expect(alpha(300 + 54, 600)).toBeGreaterThan(30); // the ring, just inside 19 pt × 3
    expect(alpha(300 + 80, 600)).toBe(0);
    expect(alpha(10, 10)).toBe(0);
    expect(box).toMatchObject({ x0: expect.any(Number) });
    expect(box!.x0).toBeLessThanOrEqual(300 - 57);
    expect(box!.x1).toBeGreaterThanOrEqual(300 + 57);
    clearBox(pic, box!);
    expect(pic.data.every((v) => v === 0)).toBe(true);
  });

  it('a picture per change of what is drawn; the same picture held while nothing changes', () => {
    const plan = overlayPlan([tap], 60, 30);
    expect(plan[0]).toEqual({ frame: 0, key: '' });
    expect(plan[1].frame).toBe(26); // 0.8667 s: the disc appears (t_down − 150 ms = 0.85)
    const last = plan[plan.length - 1];
    expect(last.key).toBe('');
    expect(last.frame).toBe(46); // 1.5333 s: the ripple has faded out (its end, 1.55, under 1/500 of opacity)
    expect(new Set(plan.map((p) => p.key)).size).toBe(plan.length - 1);
    expect(marksKey(touchMarks([tap], 1.2))).toMatch(/^r/);
  });

  it('ffconcat: each picture held to the next change (a quarter frame early), the last one repeated', () => {
    const text = ffconcatText(
      [
        { file: 'clear.png', frame: 0 },
        { file: 'touch-000030.png', frame: 30 },
        { file: 'clear.png', frame: 45 },
      ],
      90,
      30,
    );
    expect(text.split('\n')).toEqual([
      'ffconcat version 1.0',
      "file 'clear.png'",
      'duration 0.991667',
      "file 'touch-000030.png'",
      'duration 0.500000',
      "file 'clear.png'",
      'duration 1.508333',
      "file 'clear.png'",
      '',
    ]);
    expect(() => ffconcatText([{ file: 'a.png', frame: 3 }], 10, 30)).toThrow(/frame 0/);
  });
});
