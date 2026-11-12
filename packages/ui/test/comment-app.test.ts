/**
 * L4.6 part D1 (T13): the Comments screen's pure rules (app/comment-words.ts) and routes —
 * - channel, status, entry and proposal words; ⚑ `studio` is said as a channel, never as a person;
 * - ⚑ regions (critique B11): a drag or the four % fields give a region the server accepts (core regionProblem) —
 *   rounded to 4 decimals, then clamped inside the frame (an edge drag never makes x + w = 1.0001), a click none; the
 *   pointer maths on the image's own box (a vertical render too); the fields round-trip;
 * - a typed time as a frame by the CLI's `--at` rule; the anchor chips from trusted fields ("unknown" stays unknown);
 * - the viewer's keys (never while typing, never doubling the slider) and the timeline's C;
 * - ⚑ the frame requests: one in flight, the newest wins (older answers dropped), a 429 backs off then asks the newest
 *   again, a 409 `cancelled` is ignored, another failure is said; the session id;
 * - the comments routes (ids inert strings, frames whole numbers).
 * L4.6 part D2 (T13, the proposal):
 * - ⚑ the diff's lines code-safe (critique B1): edge spaces `·`, tabs `→`, every character core calls hidden and every
 *   space but U+0020 as `[U+…]` (direction controls included) — an indentation-only or a trailing-space change gives two
 *   visibly different rows; markup and right-to-left text stay text; emoji sequences stay whole;
 * - the rows' signs, words and line numbers; the summary; ⚑ the rewrite note past core's 25 %;
 * - ⚑ the buttons from the server's offer only (a literal true each; `why` said when something is not offered);
 * - Undo apply's restore and the render after Apply on the apply's hash; the proposal route.
 * Fixes after the reviews: ⚑ a right-to-left line flagged and combining marks past the third shown (review A L6); ⚑ an
 * apply's problems and warnings said (review B M2); ⚑ a frame that keeps failing said (review B L3); minutes under 60
 * after the hours (review B N4).
 */
import { describe, expect, it } from 'vitest';
import { PROPOSAL_REWRITE_NOTE_PCT, firstHiddenChar, regionProblem } from '@retake/core';
import type { FrameCommentAnchor } from '@retake/core';
import {
  BACKOFF_MAX_MS,
  CHANNEL_NOTE,
  COMBINING_MARKS_SHOWN,
  FRAME_RETRIES,
  FrameRequests,
  appliedWords,
  hasRtl,
  REWRITE_NOTE_PCT,
  canUndo,
  diffRowsView,
  linePieces,
  lineShown,
  proposalButtons,
  proposalSummary,
  renderAfterApplyArgs,
  rewriteNote,
  undoEditArgs,
  REGION_MIN,
  anchorChips,
  channelWords,
  charactersLeft,
  charactersLeftAnnounced,
  clampRegion,
  commentKey,
  entryWords,
  fieldsOf,
  frameTime,
  newSessionId,
  parseTimecode,
  pointIn,
  proposalWords,
  regionOfDrag,
  regionOfFields,
  regionWords,
  renderWords,
  statusWords,
  timeExample,
  viewerKey,
  whereWords,
} from '../src/app/words/comment-words.js';
import type { FrameAsk, FrameOutcome } from '../src/app/words/comment-words.js';
import { hrefTo, parseRoute } from '../src/app/route.js';
import { dropProposalFocus, focusProposalOf, proposalFocusRouteChanged, takeProposalFocus } from '../src/app/review/proposal-focus.js';

/** A deterministic random source (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const decimals4 = (v: number) => Math.abs(v * 10_000 - Math.round(v * 10_000)) < 1e-6;

describe('the words (channels, status, entries, proposals)', () => {
  it('⚑ a channel in words — Studio is a channel, never a person', () => {
    expect(channelWords('cli')).toBe('Terminal');
    expect(channelWords('studio')).toBe('Studio');
    expect(channelWords('mcp')).toBe('Agent · MCP');
    expect(channelWords('other')).toBe('unknown channel');
    expect(channelWords(undefined)).toBe('unknown channel');
    for (const w of ['person', 'human', 'you', 'user']) expect(channelWords('studio').toLowerCase()).not.toContain(w);
    expect(CHANNEL_NOTE).toContain('not who typed it');
    expect(CHANNEL_NOTE).toContain('session token');
  });

  it('status, entry kinds, proposal states, render ids', () => {
    expect(statusWords('open')).toBe('Open');
    expect(statusWords('resolved')).toBe('Resolved');
    expect(entryWords('reply')).toBe('replied');
    expect(entryWords('resolve')).toBe('resolved it');
    expect(entryWords('reopen')).toBe('reopened it');
    expect(entryWords('apply')).toBe('applied a proposal');
    expect(proposalWords('pending')).toBe('Proposal pending');
    expect(proposalWords('undone')).toBe('Applied, then undone');
    expect(proposalWords('applied')).toBe('Applied');
    expect(proposalWords('superseded')).toBe('Proposal superseded');
    expect(proposalWords('stale')).toBe('Proposal stale');
    expect(renderWords('quote-v3')).toBe('v3');
    expect(renderWords('quote-v12-vertical')).toBe('v12 vertical');
    expect(renderWords('odd')).toBe('odd');
    expect(charactersLeft('')).toBe('2,000 characters left');
    expect(charactersLeft('x'.repeat(1999))).toBe('1 character left');
    // L5.12b fixes (review B-L5): the polite line speaks only as a threshold is crossed — the same words between two.
    expect(charactersLeftAnnounced('')).toBe('');
    expect(charactersLeftAnnounced('x'.repeat(1799))).toBe('');
    expect(charactersLeftAnnounced('x'.repeat(1800))).toBe('At most 200 characters left');
    expect(charactersLeftAnnounced('x'.repeat(1850))).toBe('At most 200 characters left');
    expect(charactersLeftAnnounced('x'.repeat(1900))).toBe('At most 100 characters left');
    expect(charactersLeftAnnounced('x'.repeat(1960))).toBe('At most 50 characters left');
    expect(charactersLeftAnnounced('x'.repeat(1995))).toBe('At most 10 characters left');
    expect(charactersLeftAnnounced('x'.repeat(2000))).toBe('No characters left');
    const said = new Set(Array.from({ length: 2001 }, (_x, n) => charactersLeftAnnounced('x'.repeat(n))));
    expect([...said]).toEqual(['', 'At most 200 characters left', 'At most 100 characters left', 'At most 50 characters left', 'At most 10 characters left', 'No characters left']);
  });
});

describe('regions (critique B11)', () => {
  it('⚑ rounded to 4 decimals, then clamped inside the frame: an edge never gives x + w > 1', () => {
    // x rounds up, w rounds up: 0.33336 + 0.66666 → 0.3334 + 0.6667 = 1.0001 without the clamp.
    const r = clampRegion({ x: 0.33336, y: 0.5, w: 0.66666, h: 0.5 })!;
    expect(r).toEqual({ x: 0.3334, y: 0.5, w: 0.6666, h: 0.5 });
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(regionProblem(r)).toBeNull();
    const s = clampRegion({ x: 0.5, y: 0.12345, w: 0.5, h: 0.87655 })!;
    expect(s.y + s.h).toBeLessThanOrEqual(1 + 1e-9);
    expect(regionProblem(s)).toBeNull();
    // Nothing left, or not numbers: no region.
    expect(clampRegion({ x: 1, y: 0, w: 0.2, h: 0.2 })).toBeNull();
    expect(clampRegion({ x: 0.2, y: 0.2, w: 0, h: 0.2 })).toBeNull();
    expect(clampRegion({ x: 0.2, y: 0.2, w: 0.00004, h: 0.2 })).toBeNull();
    expect(clampRegion({ x: NaN, y: 0, w: 0.2, h: 0.2 })).toBeNull();
    expect(clampRegion({ x: 0, y: 0, w: Infinity, h: 0.2 })).toBeNull();
    // Out of range values are brought inside.
    expect(clampRegion({ x: -0.5, y: 1.5, w: 2, h: 0.2 })).toBeNull();
    expect(clampRegion({ x: -0.5, y: 0.5, w: 2, h: 0.7 })).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it('⚑ any drag (inside, past the edges, any direction) is no region or one the server accepts', () => {
    const r = rng(46);
    let made = 0;
    for (let i = 0; i < 20_000; i++) {
      const a = { x: r() * 1.4 - 0.2, y: r() * 1.4 - 0.2 };
      const b = { x: r() * 1.4 - 0.2, y: r() * 1.4 - 0.2 };
      const g = regionOfDrag(a, b);
      if (!g) continue;
      made++;
      expect(regionProblem(g), JSON.stringify([a, b, g])).toBeNull();
      for (const v of [g.x, g.y, g.w, g.h]) expect(decimals4(v), JSON.stringify(g)).toBe(true);
    }
    expect(made).toBeGreaterThan(15_000);
    // Edge drags that round past 1 without the clamp.
    for (const [a, b] of [
      [{ x: 0.33335, y: 0.1 }, { x: 1.2, y: 0.5 }],
      [{ x: 0.99994, y: 0.1 }, { x: 0.1, y: 0.99996 }],
      [{ x: 0.00005, y: 0.00005 }, { x: 0.99995, y: 0.99995 }],
    ] as const) {
      const g = regionOfDrag(a, b);
      expect(g).not.toBeNull();
      expect(regionProblem(g!), JSON.stringify(g)).toBeNull();
    }
    // A drag to the far corner past the frame: clamped to its edges exactly.
    expect(regionOfDrag({ x: 0.5, y: 0.6 }, { x: 1.3, y: 1.4 })).toEqual({ x: 0.5, y: 0.6, w: 0.5, h: 0.4 });
    expect(regionOfDrag({ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.25 })).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.25 });
  });

  it('a click, or a drag under REGION_MIN on a side, makes no region', () => {
    expect(regionOfDrag({ x: 0.4, y: 0.4 }, { x: 0.4, y: 0.4 })).toBeNull();
    expect(regionOfDrag({ x: 0.4, y: 0.4 }, { x: 0.4 + REGION_MIN / 2, y: 0.8 })).toBeNull();
    expect(regionOfDrag({ x: 0.4, y: 0.4 }, { x: 0.8, y: 0.4 + REGION_MIN / 2 })).toBeNull();
    expect(regionOfDrag({ x: 0.4, y: 0.4 }, { x: 0.4 + REGION_MIN * 2, y: 0.4 + REGION_MIN * 2 })).not.toBeNull();
  });

  it('⚑ the pointer maths use the image\'s own box (a vertical render: no letterbox), clamped to it', () => {
    // A 9:16 picture 270 px wide at (100, 50).
    const box = { left: 100, top: 50, width: 270, height: 480 };
    expect(pointIn(box, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(pointIn(box, 370, 530)).toEqual({ x: 1, y: 1 });
    expect(pointIn(box, 100 + 270 * 0.25, 50 + 480 * 0.5)).toEqual({ x: 0.25, y: 0.5 });
    expect(pointIn(box, 0, 1000)).toEqual({ x: 0, y: 1 });
    expect(pointIn({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toEqual({ x: 0, y: 0 });
    const g = regionOfDrag(pointIn(box, 100 + 270 * 0.25, 50 + 480 * 0.25), pointIn(box, 100 + 270 * 0.75, 50 + 480 * 0.5));
    expect(g).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.25 });
  });

  it('the four % fields: round trip with a region, clamped, empty or not a number is no region', () => {
    const r = rng(7);
    for (let i = 0; i < 5000; i++) {
      const g = regionOfDrag({ x: r(), y: r() }, { x: r(), y: r() });
      if (!g) continue;
      expect(regionOfFields(fieldsOf(g))).toEqual(g);
    }
    expect(fieldsOf({ x: 0.125, y: 0.3, w: 0.4, h: 0.2 })).toEqual({ x: '12.5', y: '30', w: '40', h: '20' });
    expect(fieldsOf(null)).toEqual({ x: '', y: '', w: '', h: '' });
    expect(regionOfFields({ x: '12.5', y: '30', w: '40', h: '20' })).toEqual({ x: 0.125, y: 0.3, w: 0.4, h: 0.2 });
    expect(regionOfFields({ x: '50', y: '50', w: '80', h: '80' })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    for (const bad of [{ x: '', y: '1', w: '1', h: '1' }, { x: 'a', y: '1', w: '1', h: '1' }, { x: '1', y: '1', w: '0', h: '1' }, { x: '100', y: '1', w: '5', h: '1' }]) expect(regionOfFields(bad)).toBeNull();
    expect(regionWords({ x: 0.12, y: 0.3, w: 0.4, h: 0.2 })).toBe('from 12 % left, 30 % top, 40 % × 20 % of the frame');
    expect(regionWords(null)).toBe('the whole frame');
  });
});

describe('time, chips, keys', () => {
  it('a typed time is the frame on screen then (the CLI\'s --at rule); the end of the video is its last frame', () => {
    expect(parseTimecode('12.4', 30, 900)).toEqual({ frame: 372 });
    expect(parseTimecode('0:12.40', 30, 900)).toEqual({ frame: 372 });
    expect(parseTimecode('00:12.40', 30, 900)).toEqual({ frame: 372 });
    expect(parseTimecode(' .5 ', 30, 900)).toEqual({ frame: 15 });
    expect(parseTimecode('0.0333', 30, 900)).toEqual({ frame: 0 });
    expect(parseTimecode('0.0334', 30, 900)).toEqual({ frame: 1 });
    expect(parseTimecode('1:02:03.5', 30, 200_000)).toEqual({ frame: (3600 + 120 + 3.5) * 30 });
    expect(parseTimecode('30', 30, 900)).toEqual({ frame: 899 });
    expect(parseTimecode('00:30.00', 30, 900)).toEqual({ frame: 899 });
    expect('error' in parseTimecode('30.1', 30, 900)).toBe(true);
    for (const bad of ['', 'abc', '1:75', '-1', '1::2', '12,4', '1e3']) expect('error' in parseTimecode(bad, 30, 900), bad).toBe(true);
    // Minutes past the hours are under 60 too (review B N4).
    expect(parseTimecode('1:75:00', 30, 1_000_000)).toEqual({ error: 'minutes under 60 after the hours' });
    expect(parseTimecode('1:59:00', 30, 1_000_000)).toEqual({ frame: (3600 + 59 * 60) * 30 });
    expect(frameTime(372, 30)).toBe('00:12.40');
    expect(frameTime(30 * 65 + 12, 30)).toBe('01:05.40');
    expect(frameTime(0, 0)).toBe('00:00.00');
  });

  it("the time field's example is a time inside the render shown (a 6 s render never shows 00:12.40)", () => {
    expect(timeExample(180, 30)).toBe('00:03.90');
    expect(timeExample(2396, 30)).toBe('00:53.20');
    expect(timeExample(1, 30)).toBe('00:00.00');
    expect(timeExample(0, 0)).toBe('00:00.00');
    for (const [frames, fps] of [[180, 30], [12, 24], [2396, 30], [90_000, 25], [7, 60], [1, 30]] as const) {
      const r = parseTimecode(timeExample(frames, fps), fps, frames);
      expect(r, `${frames} @ ${fps}`).toHaveProperty('frame');
      expect((r as { frame: number }).frame).toBeLessThan(frames);
    }
  });

  it('the chips: trusted fields only, where the step is today, "unknown" shown as such', () => {
    const anchor: FrameCommentAnchor = {
      segment: 'quote-form',
      kind: 'clip',
      component: 'studio/caption-below',
      area: 'caption',
      scene: 'quote-form',
      step: 3,
      step_ref: 'quote-form.3',
      action: 'click',
      page: 'console',
      marker: 'total',
      transition: { kind: 'crossfade', from: 'intro', to: 'quote-form' },
      overlays: ['studio/callout', 'unknown'],
    };
    const chips = anchorChips({ frame: 412, timecode: '00:13.73', anchor, step_now: 'quote-form.4' });
    expect(chips.map((c) => [c.kind, c.label, c.words, c.note])).toEqual([
      ['frame', 'Frame', '412 · 00:13.73', undefined],
      ['segment', 'Segment', 'clip quote-form', undefined],
      ['step', 'Step', 'quote-form.3 · click', 'now quote-form.4'],
      ['component', 'Component', 'area caption · studio/caption-below', undefined],
      ['marker', 'Marker', 'total', undefined],
      ['page', 'Page', 'console', undefined],
      ['transition', 'Transition', 'crossfade intro → quote-form', undefined],
      ['overlays', 'Overlays', 'studio/callout, unknown', undefined],
    ]);
    expect(anchorChips({ frame: 1, timecode: 'x', anchor, step_now: null }).find((c) => c.kind === 'step')?.note).toBe("not in today's file");
    expect(anchorChips({ frame: 1, timecode: 'x', anchor, step_now: 'quote-form.3' }).find((c) => c.kind === 'step')?.note).toBeUndefined();
    // A card: no step chip; an unknown id stays "unknown".
    const card = anchorChips({ frame: 0, timecode: '00:00.00', anchor: { segment: 'unknown', kind: 'card' } });
    expect(card.map((c) => c.words)).toEqual(['0 · 00:00.00', 'card unknown']);
    expect(whereWords(anchor)).toBe('step quote-form.3');
    expect(whereWords({ segment: 'intro', kind: 'intro' })).toBe('intro intro');
  });

  it('the viewer\'s keys: ← / → one frame, Shift one second — never while typing, never on the slider; the timeline\'s C', () => {
    const body = { tag: 'BODY' };
    expect(viewerKey({ key: 'ArrowRight' }, body, 30)).toBe(1);
    expect(viewerKey({ key: 'ArrowLeft' }, body, 30)).toBe(-1);
    expect(viewerKey({ key: 'ArrowRight', shiftKey: true }, body, 30)).toBe(30);
    expect(viewerKey({ key: 'ArrowLeft', shiftKey: true }, body, 24)).toBe(-24);
    expect(viewerKey({ key: 'ArrowUp' }, body, 30)).toBeNull();
    expect(viewerKey({ key: 'ArrowRight', metaKey: true }, body, 30)).toBeNull();
    for (const t of [{ tag: 'INPUT', type: 'text' }, { tag: 'INPUT', type: 'number' }, { tag: 'INPUT', type: 'range' }, { tag: 'TEXTAREA' }, { tag: 'SELECT' }, { tag: 'DIV', editable: true }, { tag: 'INPUT', type: 'radio', inRadioGroup: true }]) {
      expect(viewerKey({ key: 'ArrowRight' }, t, 30), JSON.stringify(t)).toBeNull();
    }
    expect(viewerKey({ key: 'ArrowRight' }, { tag: 'BUTTON' }, 30)).toBe(1);
    expect(commentKey({ key: 'c' }, body)).toBe(true);
    expect(commentKey({ key: 'C' }, { tag: 'BUTTON' })).toBe(true);
    expect(commentKey({ key: 'c' }, { tag: 'INPUT', type: 'range' })).toBe(true);
    for (const t of [{ tag: 'INPUT', type: 'text' }, { tag: 'TEXTAREA' }, { tag: 'SELECT' }, { tag: 'DIV', editable: true }, { tag: 'BUTTON', inRadioGroup: true }]) expect(commentKey({ key: 'c' }, t), JSON.stringify(t)).toBe(false);
    expect(commentKey({ key: 'c', metaKey: true }, body)).toBe(false);
    expect(commentKey({ key: 'x' }, body)).toBe(false);
  });
});

/** A fake render_frame: each call waits for the test to answer it. */
function fakeFrames() {
  const calls: Array<{ ask: FrameAsk; signal: AbortSignal; resolve: (v: string) => void; reject: (e: unknown) => void }> = [];
  const results: Array<FrameOutcome<string>> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const r = new FrameRequests<string>({
    fetch: (ask, signal) => new Promise<string>((resolve, reject) => calls.push({ ask, signal, resolve, reject })),
    onResult: (x) => results.push(x),
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
  });
  return { r, calls, results, timers };
}
const ask = (frame: number): FrameAsk => ({ render_id: 'quote-v1', created_at: '2026-01-01T13:00:00.000Z', frame });
const tick = () => new Promise((res) => setTimeout(res, 0));
const fail = (status: number, code: string) => Object.assign(new Error(code), { status, error: { code, message: `${code} message` } });

describe('the frame requests (FrameRequests)', () => {
  it('⚑ one in flight; while it runs only the newest frame waits; an older answer is dropped', async () => {
    const f = fakeFrames();
    f.r.want(ask(1));
    f.r.want(ask(2));
    f.r.want(ask(3));
    expect(f.calls.map((c) => c.ask.frame)).toEqual([1]);
    expect(f.r.busy).toBe(1);
    f.calls[0].resolve('one');
    await tick();
    // Frame 1 is no longer wanted: dropped; frame 3 sent (2 never was).
    expect(f.results).toEqual([]);
    expect(f.calls.map((c) => c.ask.frame)).toEqual([1, 3]);
    f.calls[1].resolve('three');
    await tick();
    expect(f.results).toEqual([{ ask: ask(3), ok: true, data: 'three' }]);
    expect(f.r.busy).toBe(0);
    // The same frame again is asked again (nothing is pending).
    f.r.want(ask(3));
    expect(f.calls).toHaveLength(3);
  });

  it('⚑ a 429 waits (1 s, then longer) and asks the newest frame again; nothing is said meanwhile', async () => {
    const f = fakeFrames();
    f.r.want(ask(5));
    f.calls[0].reject(fail(429, 'busy'));
    await tick();
    expect(f.results).toEqual([]);
    expect(f.timers.map((t) => t.ms)).toEqual([1000]);
    // The slider moved meanwhile: the newest frame goes when the wait ends, not before.
    f.r.want(ask(6));
    expect(f.calls).toHaveLength(1);
    f.timers[0].fn();
    expect(f.calls.map((c) => c.ask.frame)).toEqual([5, 6]);
    f.calls[1].reject(fail(429, 'busy'));
    await tick();
    expect(f.timers.map((t) => t.ms)).toEqual([1000, 2000]);
    f.timers[1].fn();
    f.calls[2].resolve('six');
    await tick();
    expect(f.results).toEqual([{ ask: ask(6), ok: true, data: 'six' }]);
    // The wait is capped; a success resets it.
    for (let i = 0; i < 6; i++) {
      f.r.want(ask(7));
      f.calls.at(-1)!.reject(fail(429, 'busy'));
      await tick();
      f.timers.at(-1)!.fn();
    }
    expect(Math.max(...f.timers.map((t) => t.ms))).toBe(BACKOFF_MAX_MS);
  });

  it('⚑ a 409 cancelled (superseded by this tab\'s own newer request) is ignored; another failure is said', async () => {
    const f = fakeFrames();
    f.r.want(ask(8));
    f.calls[0].reject(fail(409, 'cancelled'));
    await tick();
    expect(f.results).toEqual([]);
    f.r.want(ask(9));
    f.calls[1].reject(fail(409, 'conflict'));
    await tick();
    expect(f.results).toHaveLength(1);
    expect(f.results[0]).toMatchObject({ ask: ask(9), ok: false, error: { status: 409, code: 'conflict', message: 'conflict message' } });
    f.r.want(ask(10));
    f.calls[2].reject(new Error('network'));
    await tick();
    expect(f.results[1]).toMatchObject({ ok: false, error: { status: 0, code: 'failed', message: 'network' } });
  });

  it('⚑ a frame that keeps failing is said (review B L3): a 429 after FRAME_RETRIES.busy waits, a 503 timeout after one', async () => {
    expect(FRAME_RETRIES).toEqual({ busy: 4, timeout: 1 });
    const f = fakeFrames();
    f.r.want(ask(11));
    for (let i = 0; i < FRAME_RETRIES.busy; i++) {
      f.calls.at(-1)!.reject(fail(429, 'busy'));
      await tick();
      expect(f.results).toEqual([]);
      f.timers.at(-1)!.fn();
    }
    expect(f.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000]);
    f.calls.at(-1)!.reject(fail(429, 'busy'));
    await tick();
    expect(f.timers).toHaveLength(FRAME_RETRIES.busy);
    expect(f.results).toEqual([{ ask: ask(11), ok: false, error: { status: 429, code: 'busy', message: 'busy message' } }]);
    // Asked again (the slider moved): the waits start over.
    f.r.want(ask(12));
    f.calls.at(-1)!.reject(fail(503, 'unavailable'));
    await tick();
    expect(f.timers.at(-1)!.ms).toBe(1000);
    expect(f.results).toHaveLength(1);
    f.timers.at(-1)!.fn();
    f.calls.at(-1)!.reject(fail(503, 'unavailable'));
    await tick();
    expect(f.results[1]).toMatchObject({ ask: ask(12), ok: false, error: { status: 503, code: 'unavailable' } });
    // A success between failures resets the count.
    f.r.want(ask(13));
    f.calls.at(-1)!.reject(fail(503, 'unavailable'));
    await tick();
    f.timers.at(-1)!.fn();
    f.calls.at(-1)!.resolve('thirteen');
    await tick();
    expect(f.results[2]).toEqual({ ask: ask(13), ok: true, data: 'thirteen' });
    f.r.want(ask(14));
    f.calls.at(-1)!.reject(fail(503, 'unavailable'));
    await tick();
    expect(f.results).toHaveLength(3);
  });

  it('close: the call in flight is aborted, the wait cancelled, nothing more sent or said', async () => {
    const f = fakeFrames();
    f.r.want(ask(1));
    f.r.close();
    expect(f.calls[0].signal.aborted).toBe(true);
    f.calls[0].resolve('late');
    await tick();
    f.r.want(ask(2));
    expect(f.calls).toHaveLength(1);
    expect(f.results).toEqual([]);
    const g = fakeFrames();
    g.r.want(ask(1));
    g.calls[0].reject(fail(429, 'busy'));
    await tick();
    g.r.close();
    expect(g.timers[0].cancelled).toBe(true);
  });

  it('the session id: 22 base64url characters, one per tab (random)', () => {
    const a = newSessionId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newSessionId()).not.toBe(a);
    expect(newSessionId(() => new Uint8Array(16).fill(255))).toBe('_____________________w');
  });
});

describe('the comments routes', () => {
  it('the list, a thread, a render\'s frame; ids are inert strings, frames whole numbers within range', () => {
    expect(parseRoute('#/p/demo/s/quote/comments')).toEqual({ name: 'comments', slug: 'demo', scenario: 'quote' });
    expect(parseRoute('#/p/demo/s/quote/comments/c_01JAAAAAAAAAAAAAAAAAAAAAAA')).toEqual({ name: 'comments', slug: 'demo', scenario: 'quote', thread: 'c_01JAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(parseRoute('#/p/demo/s/quote/comments/at/quote-v2-vertical/412')).toEqual({ name: 'comments', slug: 'demo', scenario: 'quote', at: { render: 'quote-v2-vertical', frame: 412 } });
    expect(parseRoute('#/p/demo/s/quote/comments/%3Cimg%20src%3Dx%3E')).toEqual({ name: 'comments', slug: 'demo', scenario: 'quote', thread: '<img src=x>' });
    for (const bad of ['#/p/d/s/q/comments/at', '#/p/d/s/q/comments/at/r', '#/p/d/s/q/comments/at/r/-1', '#/p/d/s/q/comments/at/r/1.5', '#/p/d/s/q/comments/at/r/99999999', '#/p/d/s/q/comments/a/b', '#/p/d/s/q/comments/at/r/1/x', '#/p/d/s/q/comments/%E0%A4%A']) {
      expect(parseRoute(bad), bad).toMatchObject({ name: 'not-found' });
    }
    for (const r of [
      { name: 'comments' as const, slug: 'p/q', scenario: '<b>' },
      { name: 'comments' as const, slug: 'demo', scenario: 'quote', thread: '../x' },
      { name: 'comments' as const, slug: 'demo', scenario: 'quote', at: { render: 'a/b', frame: 0 } },
      { name: 'comments' as const, slug: 'demo', scenario: 'quote', at: { render: 'quote-v1', frame: 10_000_000 } },
    ]) {
      const href = hrefTo(r);
      expect(href.startsWith('#/p/')).toBe(true);
      expect(parseRoute(href)).toEqual(r);
    }
    // A frame that is not a whole number in range never reaches an address.
    expect(hrefTo({ name: 'comments', slug: 'd', scenario: 'q', at: { render: 'r', frame: 1.5 } })).toBe('#/p/d/s/q/comments');
    expect(hrefTo({ name: 'comments', slug: 'd', scenario: 'q', at: { render: 'r', frame: -1 } })).toBe('#/p/d/s/q/comments');
  });
});


describe('the proposal (L4.6 part D2, T13)', () => {
  it('⚑ a line is drawn code-safe: edge spaces ·, tabs →, the spaces inside kept — indentation and trailing spaces are visible', () => {
    // An indentation-only change (a key moved into a mapping) and a trailing-space change: two different rows.
    expect(lineShown('  speed: 2')).toBe('··speed: 2');
    expect(lineShown('    speed: 2')).toBe('····speed: 2');
    expect(lineShown('caption: Done')).toBe('caption: Done');
    expect(lineShown('caption: Done ')).toBe('caption: Done·');
    expect(lineShown('a  b')).toBe('a  b');
    expect(lineShown('\tkey: v')).toBe('→key: v');
    expect(lineShown('key:\tv')).toBe('key:→v');
    expect(lineShown('   ')).toBe('···');
    expect(lineShown('')).toBe('');
    expect(linePieces('  a  b ')).toEqual([{ kind: 'space', count: 2 }, { kind: 'text', text: 'a  b' }, { kind: 'space', count: 1 }]);
  });

  it('⚑ every unseen character is a visible [U+…] mark: direction controls, zero-width, BOM, controls, other spaces — markup and RTL text stay text', () => {
    expect(lineShown('caption: ‮gnp.exe')).toBe('caption: [U+202E]gnp.exe');
    expect(lineShown('a⁦b⁩c‏d؜e')).toBe('a[U+2066]b[U+2069]c[U+200F]d[U+061C]e');
    expect(lineShown('﻿video: x')).toBe('[U+FEFF]video: x');
    expect(lineShown('a​b⁠c­d')).toBe('a[U+200B]b[U+2060]c[U+00AD]d');
    expect(lineShown('a\u0007b\rc\u007Fd\u0085e')).toBe('a[U+0007]b[U+000D]c[U+007F]d[U+0085]e');
    expect(lineShown('a b c　d e')).toBe('a[U+00A0]b[U+2003]c[U+3000]d[U+202F]e');
    expect(lineShown('a bㅤc⠀d')).toBe('a[U+2028]b[U+3164]c[U+2800]d');
    expect(lineShown('x\u{E0041}y')).toBe('x[U+E0041]y');
    // Markup is text; right-to-left letters are text (the cell is isolated left-to-right, nothing reorders around it).
    expect(linePieces('caption: <img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: 'caption: <img src=x onerror=alert(1)>' }]);
    expect(lineShown('# עברית: שלום')).toBe('# עברית: שלום');
    expect(lineShown('Café — 東京')).toBe('Café — 東京');
    // Emoji sequences stay whole (core's write rules allow them); a lone joiner or selector does not.
    expect(lineShown('👩‍💻 ❤️ 1️⃣')).toBe('👩‍💻 ❤️ 1️⃣');
    expect(lineShown('a‍b')).toBe('a[U+200D]b');
    expect(lineShown('a️')).toBe('a[U+FE0F]');
    // Every character core calls hidden (tab aside) is marked here: the screen never hides what the write rules call hidden.
    let checked = 0;
    for (let cp = 0; cp <= 0xe0fff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (cp === 0x40000) cp = 0xe0000;
      const c = String.fromCodePoint(cp);
      if (c === '\t' || c === '\n' || firstHiddenChar(`a${c}b`) !== c) continue;
      checked++;
      expect(lineShown(`a${c}b`), `U+${cp.toString(16)}`).toBe(`a[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]b`);
    }
    expect(checked).toBeGreaterThan(4000);
  });

  it('the rows: sign, word, line numbers; a gap says how many lines it leaves out; a missing text is an empty line', () => {
    const v = diffRowsView(
      [{ kind: 'gap', count: 4 }, { kind: 'context', base: 5, line: 5 }, { kind: 'del', base: 6 }, { kind: 'add', line: 6 }, { kind: 'add', line: 7 }, { kind: 'gap', count: 1 }],
      ['', 'scenes:', '  - id: a', '  - id: <b>a</b>'],
    );
    expect(v.map((r) => [r.kind, r.sign, r.word, r.base, r.line])).toEqual([
      ['gap', '…', '4 unchanged lines not shown', null, null],
      ['context', '', 'unchanged', 5, 5],
      ['del', '−', 'removed', 6, null],
      ['add', '+', 'added', null, 6],
      ['add', '+', 'added', null, 7],
      ['gap', '…', '1 unchanged line not shown', null, null],
    ]);
    expect(v[3].pieces).toEqual([{ kind: 'space', count: 2 }, { kind: 'text', text: '- id: <b>a</b>' }]);
    expect(v[4].pieces).toEqual([]);
    expect(diffRowsView([{ kind: 'context', base: -1, line: 1.5 }], [42 as unknown as string])[0]).toMatchObject({ base: null, line: null, pieces: [] });
    expect(proposalSummary({ added: 1, removed: 1, hunks: 1 })).toBe('1 line added, 1 removed, in 1 place');
    expect(proposalSummary({ added: 3, removed: 0, hunks: 2 })).toBe('3 lines added, 0 removed, in 2 places');
    expect(v.every((r) => r.rtl === false)).toBe(true);
  });

  it('⚑ a line drawn as its bytes say (review A L6): right-to-left text marked, combining marks past the third shown as [U+…]', () => {
    // A line holding right-to-left letters is flagged: the cell draws it in byte order and says so.
    expect(hasRtl('caption: "ע 10 20"')).toBe(true);
    expect(hasRtl('caption: مرحبا')).toBe(true);
    expect(hasRtl('caption: 𐤀')).toBe(true);
    for (const ltr of ['caption: Café — 東京', 'caption: 10 20', '👩‍💻 ❤️', 'Ελληνικά, кириллица']) expect(hasRtl(ltr), ltr).toBe(false);
    const rows = diffRowsView([{ kind: 'add', line: 1 }, { kind: 'del', base: 1 }, { kind: 'context', base: 2, line: 2 }], ['a: "ע 10 20"', 'a: "10 20"', '# שלום']);
    expect(rows.map((r) => r.rtl)).toEqual([true, false, true]);
    // Combining marks: up to COMBINING_MARKS_SHOWN on one character are drawn; every one past it is a visible mark.
    expect(COMBINING_MARKS_SHOWN).toBe(3);
    expect(lineShown('e\u0301')).toBe('e\u0301');
    expect(lineShown('a\u0300\u0301\u0302b')).toBe('a\u0300\u0301\u0302b');
    expect(lineShown('a\u0300\u0301\u0302\u0303\u0304b')).toBe('a\u0300\u0301\u0302[U+0303][U+0304]b');
    // 240 marks on one "a" (they drew as one letter): every one past the third is said.
    const zalgo = linePieces(`x a${'\u0336'.repeat(240)} y`);
    expect(zalgo.filter((p) => p.kind === 'char')).toHaveLength(237);
    expect(lineShown(`a${'\u0336'.repeat(5)}b${'\u0336'.repeat(2)}`)).toBe('a\u0336\u0336\u0336[U+0336][U+0336]b\u0336\u0336');
    // An emoji's variation selector is one mark: emoji sequences stay whole.
    expect(lineShown('👩‍💻 ❤️ 1️⃣')).toBe('👩‍💻 ❤️ 1️⃣');
  });

  it('⚑ what an apply says beside its write: its problems and the scenario\'s warnings (review B M2)', () => {
    expect(appliedWords({ warnings: [], problems: [] })).toBeNull();
    expect(appliedWords({})).toBeNull();
    expect(appliedWords({ warnings: [], problems: ['the apply was written to scenarios/q.yaml but not recorded in the thread'] })).toEqual({
      tone: 'warning',
      words: 'Applied, but: the apply was written to scenarios/q.yaml but not recorded in the thread',
    });
    expect(appliedWords({ warnings: [{ message: 'caption is long' }], problems: [] })).toEqual({ tone: 'warning', words: 'Applied. The scenario has 1 warning: caption is long' });
    const w = appliedWords({ warnings: [{ message: 'a' }, { message: 'b' }, { message: 'c' }, { message: 'd' }, 7], problems: ['p'] });
    expect(w?.words).toBe('Applied, but: p\nThe scenario has 5 warnings: a · b · c …');
  });

  it('⚑ the rewrite note past 25 % of the file (core\'s number)', () => {
    expect(REWRITE_NOTE_PCT).toBe(PROPOSAL_REWRITE_NOTE_PCT);
    expect(rewriteNote(undefined)).toBeNull();
    expect(rewriteNote(REWRITE_NOTE_PCT)).toBeNull();
    expect(rewriteNote(REWRITE_NOTE_PCT + 1)).toContain(`rewrites ${REWRITE_NOTE_PCT + 1} % of the file`);
    expect(rewriteNote(100)).toContain('rewrites 100 %');
  });

  it('⚑ the buttons come from the offer only: a literal true each; why is said when something is not offered', () => {
    expect(proposalButtons({ apply: true, preview: true, apply_render: true })).toEqual({ buttons: ['apply', 'preview', 'apply_render'], why: null });
    expect(proposalButtons({ apply: true, preview: true, apply_render: false, why: 'The comment is on a vertical render' })).toEqual({ buttons: ['apply', 'preview'], why: 'The comment is on a vertical render' });
    expect(proposalButtons({ apply: true, preview: false, apply_render: false, why: 'It does not render on the commented take' })).toEqual({ buttons: ['apply'], why: 'It does not render on the commented take' });
    expect(proposalButtons({ apply: false, preview: false, apply_render: false, why: 'Applied: the scenario holds it' })).toEqual({ buttons: [], why: 'Applied: the scenario holds it' });
    expect(proposalButtons({ apply: false, preview: false, apply_render: false })).toEqual({ buttons: [], why: 'Nothing can be done with this proposal now' });
    // Not a literal true: no button (whatever else the page might think of the state).
    expect(proposalButtons({ apply: 'yes', preview: 1, apply_render: {} } as never).buttons).toEqual([]);
    expect(proposalButtons(undefined)).toEqual({ buttons: [], why: 'Nothing can be done with this proposal now' });
    expect(proposalButtons(null).buttons).toEqual([]);
  });

  it("Undo apply restores the answer's previous text on the hash the apply wrote; the render after Apply expects that hash", () => {
    const a = { scenario: { name: 'bits', hash: 'b'.repeat(64), previous: { text: 'video: x\n', hash: 'a'.repeat(64) } } };
    expect(undoEditArgs('demo', a)).toEqual({ project: 'demo', name: 'bits', hash: 'b'.repeat(64), edit: { kind: 'restore', text: 'video: x\n', text_hash: 'a'.repeat(64) } });
    expect(renderAfterApplyArgs('demo', a, '20260101-120000-bits')).toEqual({ project: 'demo', name: 'bits', run: '20260101-120000-bits', expect_edit_sha256: 'b'.repeat(64) });
    expect(canUndo(a, 'b'.repeat(64))).toBe(true);
    expect(canUndo(a, 'a'.repeat(64))).toBe(false);
    expect(canUndo(a, null)).toBe(false);
    expect(canUndo(undefined, 'b'.repeat(64))).toBe(false);
  });

  it('the proposal route: inert ids, round trip', () => {
    expect(parseRoute('#/p/demo/s/bits/proposal/c_01JAAAAAAAAAAAAAAAAAAAAAAA/r_01JBBBBBBBBBBBBBBBBBBBBBBB')).toEqual({
      name: 'proposal',
      slug: 'demo',
      scenario: 'bits',
      thread: 'c_01JAAAAAAAAAAAAAAAAAAAAAAA',
      entry: 'r_01JBBBBBBBBBBBBBBBBBBBBBBB',
    });
    for (const bad of ['#/p/d/s/q/proposal', '#/p/d/s/q/proposal/c', '#/p/d/s/q/proposal/c/r/x', '#/p/d/s/q/proposal/%E0%A4%A/r']) expect(parseRoute(bad), bad).toMatchObject({ name: 'not-found' });
    for (const r of [
      { name: 'proposal' as const, slug: 'demo', scenario: 'bits', thread: 'c_1', entry: 'r_1' },
      { name: 'proposal' as const, slug: 'p/q', scenario: '<b>', thread: '../x', entry: '<img src=x>' },
    ]) {
      const href = hrefTo(r);
      expect(href.startsWith('#/p/')).toBe(true);
      expect(parseRoute(href)).toEqual(r);
    }
  });
});

describe('the proposal focus hand-off (L5.12b)', () => {
  it('⚑ Back to the comment: taken once by that thread; dropped by a route anywhere else or a thread that cannot be read', () => {
    const at = (slug: string, scenario: string, thread?: string) => hrefTo({ name: 'comments', slug, scenario, ...(thread ? { thread } : {}) });
    focusProposalOf('demo', 'c_1');
    // On the way: the thread's own route keeps it; another thread does not take it.
    proposalFocusRouteChanged(at('demo', 'bits', 'c_1'));
    expect(takeProposalFocus('demo', 'c_2')).toBe(false);
    expect(takeProposalFocus('other', 'c_1')).toBe(false);
    expect(takeProposalFocus('demo', 'c_1')).toBe(true);
    expect(takeProposalFocus('demo', 'c_1')).toBe(false);
    // A route elsewhere (the list, another thread, Edit, another project) drops it.
    for (const hash of [at('demo', 'bits'), at('demo', 'bits', 'c_2'), hrefTo({ name: 'timeline', slug: 'demo', scenario: 'bits' }), at('other', 'bits', 'c_1')]) {
      focusProposalOf('demo', 'c_1');
      proposalFocusRouteChanged(hash);
      expect(takeProposalFocus('demo', 'c_1'), hash).toBe(false);
    }
    // A thread that cannot be read drops it.
    focusProposalOf('demo', 'c_1');
    dropProposalFocus();
    expect(takeProposalFocus('demo', 'c_1')).toBe(false);
  });
});
