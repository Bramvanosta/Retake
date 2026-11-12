/**
 * L5.10b: the storyboard's keys (board-keys.ts) — pure index arithmetic on the scenes' step counts and the grid's
 * columns: ← / → across scenes, ↑ / ↓ by column into the scene before's last row or the next scene's first row (the
 * column clamped; an empty scene skipped), Home / End, Page Up / Page Down three rows; and a scene's intrinsic height
 * (rows × the row height: critique L1).
 */
import { describe, expect, it } from 'vitest';
import { FRAME_ROW_PX, frameTitle, gridMove, sceneIntrinsicPx, sceneLengthWords } from '../src/app/script/board-keys.js';
import { fieldLabel } from '../src/app/script/forms.js';

const at = (scene: number, index: number) => ({ scene, index });

describe('the storyboard keys (L5.10b, plan §4.2, critique L3)', () => {
  // Scenes of 5, 0 (empty), 7 and 1 steps, three columns.
  const counts = [5, 0, 7, 1];
  it('← / → walk the steps across scenes (the empty one skipped), clamped at both ends', () => {
    expect(gridMove(counts, at(0, 4), 'ArrowRight', 3)).toEqual(at(2, 0));
    expect(gridMove(counts, at(2, 0), 'ArrowLeft', 3)).toEqual(at(0, 4));
    expect(gridMove(counts, at(0, 0), 'ArrowLeft', 3)).toEqual(at(0, 0));
    expect(gridMove(counts, at(3, 0), 'ArrowRight', 3)).toEqual(at(3, 0));
  });
  it('↓ / ↑ keep the column: inside a scene, into a partial last row (clamped), into the next / previous scene', () => {
    expect(gridMove(counts, at(0, 1), 'ArrowDown', 3)).toEqual(at(0, 4));
    expect(gridMove(counts, at(0, 2), 'ArrowDown', 3)).toEqual(at(0, 4)); // the row below has two frames: the last one
    expect(gridMove(counts, at(0, 4), 'ArrowDown', 3)).toEqual(at(2, 1)); // column 1 → the next scene's first row, column 1
    expect(gridMove(counts, at(0, 3), 'ArrowDown', 3)).toEqual(at(2, 0));
    expect(gridMove(counts, at(2, 0), 'ArrowUp', 3)).toEqual(at(0, 3)); // into the scene before's last row, same column
    expect(gridMove(counts, at(2, 2), 'ArrowUp', 3)).toEqual(at(0, 4)); // column 2 clamped to the row's last frame
    expect(gridMove(counts, at(2, 6), 'ArrowDown', 3)).toEqual(at(3, 0)); // a scene of one: its only frame
    expect(gridMove(counts, at(3, 0), 'ArrowDown', 3)).toEqual(at(3, 0)); // the last row of all: stays
    expect(gridMove(counts, at(0, 1), 'ArrowUp', 3)).toEqual(at(0, 1)); // the first row of all: stays
    expect(gridMove(counts, at(2, 4), 'ArrowUp', 3)).toEqual(at(2, 1));
  });
  it('Home / End, Page Up / Page Down (three rows), other columns, unknown keys and no step at all', () => {
    expect(gridMove(counts, at(2, 3), 'Home', 3)).toEqual(at(0, 0));
    expect(gridMove(counts, at(0, 3), 'End', 3)).toEqual(at(3, 0));
    expect(gridMove(counts, at(0, 0), 'PageDown', 3)).toEqual(at(2, 3)); // row 0 → row 1 → scene 2 row 0 → row 1
    expect(gridMove(counts, at(2, 3), 'PageUp', 3)).toEqual(at(0, 0));
    expect(gridMove(counts, at(0, 1), 'ArrowDown', 2)).toEqual(at(0, 3));
    expect(gridMove(counts, at(0, 1), 'ArrowDown', 1)).toEqual(at(0, 2));
    expect(gridMove(counts, at(0, 1), 'Enter', 3)).toBeNull();
    expect(gridMove([0, 0], at(0, 0), 'ArrowDown', 3)).toBeNull();
  });
  it("a scene's intrinsic height grows with its rows (a 100-step scene is not laid out at a fixed 600 px)", () => {
    expect(sceneIntrinsicPx(3)).toBe(120 + FRAME_ROW_PX);
    expect(sceneIntrinsicPx(4)).toBe(120 + 2 * FRAME_ROW_PX);
    expect(sceneIntrinsicPx(100)).toBe(120 + 34 * FRAME_ROW_PX);
    expect(sceneIntrinsicPx(0)).toBe(120 + FRAME_ROW_PX);
  });
});

describe('L5.10b fixes: the board\'s and the inspector\'s words', () => {
  it("A-L4: a skipped scene's height uses the board's measured columns and row height (two columns at 1100, one at 900)", () => {
    expect(sceneIntrinsicPx(100, 2, 200)).toBe(120 + 50 * 200);
    expect(sceneIntrinsicPx(100, 1, 300)).toBe(120 + 100 * 300);
    expect(sceneIntrinsicPx(7, 3, 250)).toBe(120 + 3 * 250);
    expect(sceneIntrinsicPx(5, 0, 0)).toBe(120 + 5 * 1);
  });
  it('B-L7: a frame\'s title — "Wait for", never "Wait wait for"; the summary in the title when there is no target ("Wait 1.6 s"); the note only beside a target', () => {
    expect(frameTitle({ category: 'wait', label: 'wait for', target: 'button “Send”', summary: 'visible' })).toEqual({ verb: 'Wait for', rest: 'button “Send”', note: 'visible' });
    expect(frameTitle({ category: 'wait', label: 'wait for', summary: 'text “Done”' })).toEqual({ verb: 'Wait for', rest: 'text “Done”' });
    expect(frameTitle({ category: 'wait', label: 'wait', summary: '1.6 s' })).toEqual({ verb: 'Wait', rest: '1.6 s' });
    expect(frameTitle({ category: 'click', label: 'click', target: 'Save' })).toEqual({ verb: 'Click', rest: 'Save' });
    expect(frameTitle({ category: 'hold', label: 'hold' })).toEqual({ verb: 'Hold' });
    expect(frameTitle({ category: 'unknown', label: 'no action' })).toEqual({ verb: 'Unknown', rest: 'no action' });
  });
  it('A-L5: a scene\'s length words — a capture\'s seconds; a dry run\'s pictures are "no capture yet", never "not shot yet"', () => {
    expect(sceneLengthWords(9.25, 'capture')).toBe('9.3 s');
    expect(sceneLengthWords(undefined, 'dry')).toBe('no capture yet');
    expect(sceneLengthWords(undefined, 'capture')).toBe('not captured');
    expect(sceneLengthWords(undefined, undefined)).toBe('not shot yet');
  });
  it('B-L4: a form field\'s label is words, not the schema\'s key', () => {
    expect(fieldLabel('text')).toBe('Text');
    expect(fieldLabel('ms')).toBe('Milliseconds');
    expect(fieldLabel('move ms')).toBe('Move time (ms)');
    expect(fieldLabel('cps')).toBe('Typing speed (characters a second)');
    expect(fieldLabel('testid')).toBe('Test id');
    expect(fieldLabel('wait until')).toBe('Wait until');
  });
});
