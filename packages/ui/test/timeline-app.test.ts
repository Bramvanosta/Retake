/**
 * L4.5 part C: the timeline screen's pure rules (app/timeline-words.ts) — what a key does and where it leaves a control
 * its own keys (⚑ never while typing or in a radio group; the scrubber's arrows are its own, no double step; Space on
 * a button activates it), the frame a key moves to, timecodes, the scrubber's value text, and the codec check that
 * decides between the preview and the "cannot play" message.
 */
import { describe, expect, it } from 'vitest';
import { canPlay, cannotPlayWords, codecType, codecWords, cutWords, frameWords, keyAction, landingOf, skippedWords, targetFrame, timecode, whereAt, zoomFactor } from '../src/app/timeline-words.js';

const model = {
  fps: 30,
  frames: 300,
  segments: [
    { index: 0, id: 'intro', kind: 'intro' as const, from: 0, to: 60 },
    { index: 1, id: 'request', kind: 'clip' as const, from: 45, to: 200 },
    { index: 2, id: 'c1', kind: 'card' as const, from: 200, to: 300 },
  ],
  steps: [
    { from: 60, to: 120, scene: 'request', step: 0, action: 'click', key: 'request.0' },
    { from: 120, to: 200, scene: 'request', step: 1, action: 'type', key: 'request.1' },
  ],
} as unknown as Parameters<typeof targetFrame>[2] & Parameters<typeof frameWords>[1];

describe('the timeline keys (plan D11, critique "smaller points")', () => {
  it('⚑ never while typing or in a radio group; the scrubber keeps its arrows, Home and End; Space on a button is the button\'s', () => {
    const body = { tag: 'BODY' };
    expect(keyAction({ key: ' ' }, body)).toEqual({ kind: 'toggle' });
    expect(keyAction({ key: 'ArrowRight' }, body)).toEqual({ kind: 'step', frames: 1 });
    expect(keyAction({ key: 'ArrowLeft', shiftKey: true }, body)).toEqual({ kind: 'seconds', seconds: -1 });
    expect(keyAction({ key: 'Home' }, body)).toEqual({ kind: 'home' });
    expect(keyAction({ key: 'End' }, body)).toEqual({ kind: 'end' });
    expect(keyAction({ key: ']' }, body)).toEqual({ kind: 'segment', dir: 1 });
    expect(keyAction({ key: '[' }, body)).toEqual({ kind: 'segment', dir: -1 });
    // Typing: nothing is the screen's.
    for (const t of [{ tag: 'INPUT', type: 'text' }, { tag: 'INPUT', type: 'number' }, { tag: 'TEXTAREA' }, { tag: 'SELECT' }, { tag: 'DIV', editable: true }, { tag: 'BUTTON', inRadioGroup: true }, { tag: 'INPUT', type: 'radio', inRadioGroup: true }]) {
      for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End', '[', ']']) expect(keyAction({ key }, t), `${JSON.stringify(t)} ${key}`).toBeNull();
    }
    // The scrubber: its own arrows / Home / End (one frame per press, not two); Space plays.
    const range = { tag: 'INPUT', type: 'range' };
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) expect(keyAction({ key }, range), key).toBeNull();
    expect(keyAction({ key: ' ' }, range)).toEqual({ kind: 'toggle' });
    // A button or a link: Space activates it; the arrows are the screen's.
    for (const tag of ['BUTTON', 'A', 'SUMMARY']) {
      expect(keyAction({ key: ' ' }, { tag })).toBeNull();
      expect(keyAction({ key: 'ArrowRight' }, { tag })).toEqual({ kind: 'step', frames: 1 });
    }
    // With a modifier (a browser or system shortcut): never.
    for (const mod of ['altKey', 'ctrlKey', 'metaKey'] as const) expect(keyAction({ key: 'ArrowRight', [mod]: true }, body)).toBeNull();
    expect(keyAction({ key: 'a' }, body)).toBeNull();
  });

  it('the frame each key moves to, inside the video', () => {
    expect(targetFrame({ kind: 'step', frames: 1 }, 10, model)).toBe(11);
    expect(targetFrame({ kind: 'step', frames: -1 }, 0, model)).toBe(0);
    expect(targetFrame({ kind: 'seconds', seconds: 1 }, 10, model)).toBe(40);
    expect(targetFrame({ kind: 'seconds', seconds: 1 }, 290, model)).toBe(299);
    expect(targetFrame({ kind: 'home' }, 120, model)).toBe(0);
    expect(targetFrame({ kind: 'end' }, 0, model)).toBe(299);
    expect(targetFrame({ kind: 'segment', dir: 1 }, 0, model)).toBe(45);
    expect(targetFrame({ kind: 'segment', dir: 1 }, 45, model)).toBe(200);
    expect(targetFrame({ kind: 'segment', dir: 1 }, 250, model)).toBe(299);
    expect(targetFrame({ kind: 'segment', dir: -1 }, 250, model)).toBe(200);
    expect(targetFrame({ kind: 'segment', dir: -1 }, 200, model)).toBe(45);
    expect(targetFrame({ kind: 'segment', dir: -1 }, 30, model)).toBe(0);
  });
});

describe('review B (low): landing on a segment, the words of a short cut', () => {
  it('a picked segment lands after the crossfade into it (a click, [ / ]); a cut under 0.1 s never reads "0.0 s"', () => {
    const faded = {
      ...model,
      segments: [
        { index: 0, id: 'intro', kind: 'intro' as const, from: 0, to: 60 },
        { index: 1, id: 'request', kind: 'clip' as const, from: 45, to: 200, transition: { kind: 'crossfade', frames: 15, component: null } },
        { index: 2, id: 'c1', kind: 'card' as const, from: 190, to: 300, transition: { kind: 'crossfade', frames: 10, component: null } },
      ],
    } as unknown as typeof model;
    expect(landingOf(faded.segments[1])).toBe(60);
    expect(landingOf(faded.segments[2])).toBe(200);
    expect(landingOf({ from: 10, to: 12, transition: { frames: 30 } })).toBe(11);
    expect(landingOf(faded.segments[0])).toBe(0);
    expect(targetFrame({ kind: 'segment', dir: 1 }, 0, faded)).toBe(60);
    expect(targetFrame({ kind: 'segment', dir: 1 }, 60, faded)).toBe(200);
    expect(targetFrame({ kind: 'segment', dir: -1 }, 200, faded)).toBe(60);
    expect(skippedWords(0.002)).toBe('under 0.1 s');
    expect(skippedWords(1.44)).toBe('1.4 s');
    expect(cutWords({ reason: 'loading', at: 96, src_from_s: 3, src_to_s: 3.002 }, 30)).toBe('a page load cut at 0:03.20: under 0.1 s of the capture skipped');
  });
});

describe('the words of a frame', () => {
  it('timecodes, the segment and step on screen, the scrubber\'s value text (1-based steps, labels as given)', () => {
    expect(timecode(0, 30)).toBe('0:00.00');
    expect(timecode(372, 30)).toBe('0:12.40');
    expect(timecode(1799, 30)).toBe('0:59.97');
    expect(timecode(30 * 3725, 30)).toBe('1:02:05.00');
    expect(whereAt(50, model).segment?.id).toBe('request');
    expect(whereAt(10, model).step).toBeUndefined();
    expect(frameWords(372 / 3, model, { 'request.1': 'type "Arabica" into Origin' })).toBe('0:04.13 · scene request · step 2 type "Arabica" into Origin');
    expect(frameWords(70, model, {})).toBe('0:02.33 · scene request · step 1 click');
    expect(frameWords(250, model, {})).toBe('0:08.33 · card c1');
    expect(frameWords(10, model, {})).toBe('0:00.33 · intro');
    expect(zoomFactor(300, 30)).toBe(2);
    expect(zoomFactor(7200, 30)).toBe(24);
    expect(zoomFactor(10 ** 7, 30)).toBe(50);
  });
});

describe('the codec check (plan D3, critique B14)', () => {
  it('asks the browser about the capture\'s codec; an unknown codec or no way to ask is playable; the message names it', async () => {
    const size = { width: 1920, height: 1080, fps: 30 };
    const asked: string[] = [];
    const noH264 = { isTypeSupported: (t: string) => (asked.push(t), !t.includes('avc1')) };
    expect(await canPlay('h264', noH264, size)).toBe(false);
    expect(await canPlay('vp9', noH264, size)).toBe(true);
    expect(asked).toEqual([codecType('h264'), codecType('vp9')]);
    expect(await canPlay(undefined, noH264, size)).toBe(true);
    expect(await canPlay('prores', noH264, size)).toBe(true);
    expect(await canPlay('h264', {}, size)).toBe(true);
    expect(await canPlay('h264', { decodingInfo: async (c) => ({ supported: !c.video.contentType.includes('avc1') }) }, size)).toBe(false);
    expect(await canPlay('h264', { decodingInfo: async () => Promise.reject(new Error('no')) }, size)).toBe(true);
    expect(codecWords('h264')).toBe('H.264');
    expect(cannotPlayWords('h264')).toBe("This browser cannot play the take's H.264 video: open the Studio in Chrome, Safari or Firefox. The tracks still work.");
  });
});
