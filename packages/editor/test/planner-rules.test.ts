/**
 * planEdit rules on synthetic timelines (DESIGN-phase2 §2.1): joins and transitions, speeds and ramps, protected
 * spans, idle trims, camera, captions, overlays, component precedence, layouts, output sizes, vertical, music,
 * overrides and warnings — asserted with numbers.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAMERA_EASINGS, cubicBezier } from '@demo-studio/components';
import type { LoadedTemplate } from '@demo-studio/core';
import { PlanError, loadsBesideOtherPages, mapSourceRect, planEdit, planRunTiming, viewOf } from '@demo-studio/editor';
import type { CardSegment, ClipSegment, EditOverrides, EditPlan } from '@demo-studio/editor';
import { clip, clips, fixtureProject, plan, seg, studioWorkspace, synthTimeline, template } from './helpers.js';
import type { EntrySpec, PlanContext, Workspace } from './helpers.js';

const FPS = 30;
let ctx: PlanContext;
let alt: Workspace;

beforeAll(async () => {
  ctx = { ws: await studioWorkspace(), project: await fixtureProject(), editorial: await template('editorial') };
  alt = await studioWorkspace(
    {
    },
    {
      extra: [
        ['acme/card-scn', 'card'],
        ['acme/card-kind', 'card'],
        ['acme/card-seg', 'card'],
        ['acme/intro-alt', 'intro'],
        ['acme/layout-alt', 'layout'],
        ['acme/overlay-alt', 'overlay'],
      ],
    },
  );
});
afterAll(async () => {
  await ctx.ws.cleanup();
  await alt.cleanup();
});

function withWs(ws: Workspace, timeline: Parameters<typeof plan>[1], overrides?: EditOverrides, tpl?: LoadedTemplate): EditPlan {
  return planEdit({ timeline, template: tpl ?? ctx.editorial, project: ctx.project, registry: ws.registry, captureFile: '/c.mp4', overrides });
}

const diffs = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]);

/** Two scenes on the same page, the second continuing the first (no page load, 4 ms gap). */
function contiguous(extraA: Partial<EntrySpec> = {}): EntrySpec[] {
  return [
    {
      id: 'a',
      t_start: 0,
      t_end: 10,
      open_end: 1,
      still: [1.2, 2.8],
      caption: { kicker: 'A', text: 'Scene A' },
      steps: [
        { action: 'click', t_start: 2.8, t_end: 4 },
        { action: 'click', t_start: 4, t_end: 6, camera: { zoom: 1.2, bbox: { x: 900, y: 500, w: 120, h: 40 } } },
        { action: 'wait', t_start: 6, t_end: 10 },
      ],
      ...extraA,
    } as EntrySpec,
    {
      id: 'b',
      t_start: 10,
      t_end: 16,
      still: [10.004, 11.6],
      caption: { kicker: 'B', text: 'Scene B' },
      steps: [
        { action: 'click', t_start: 11.6, t_end: 13 },
        { action: 'hold', t_start: 13, t_end: 16 },
      ],
    },
  ];
}

describe('joins and transitions', () => {
  it('joins contiguous same-page scenes without a transition: frames continue, caption changes, the camera continues', () => {
    const p = plan(ctx, synthTimeline({ entries: contiguous(), duration: 16 }));
    const a = clip(p, 'a');
    const b = clip(p, 'b');
    expect(a.srcFrames[0]).toBe(36);
    expect(a.durationInFrames).toBe(300 - 36);
    expect(a.heldFrames).toBe(0);
    expect(a.srcFrames[a.durationInFrames - 1]).toBe(299);
    expect(b.srcFrames[0]).toBe(300);
    expect(b.transition).toBeUndefined();
    expect(b.transitionIn).toBe('none');
    expect(b.fadeIn.frames).toBe(0);
    expect(b.from).toBe(a.from + a.durationInFrames);
    expect(p.notes.some((n) => n.includes('"b" continues "a" on the same page'))).toBe(true);
    // Captions: A until the join, B from the join.
    expect(p.captions.map((c) => [c.text, c.from, c.to])).toEqual([
      ['Scene A', a.from, b.from],
      ['Scene B', b.from, seg(p, 'outro').from],
    ]);
    // Camera: zoom in at the step (frame 120 − 36 = 84) over the step's 2 s, held to the end of "a", then eased out
    // in "b" — no reset at the join.
    const z = a.zooms[0];
    expect(z).toMatchObject({ from: 84, in_frames: 60, out_at: 264, out_frames: 60, zoom: 1.2, focus: { x: 960, y: 520 }, view: { x: 960, y: 520 } });
    expect(a.camera![83]).toEqual([1, 960, 540]);
    expect(a.camera![144]).toEqual([1.2, 960, 520]);
    expect(a.camera![a.durationInFrames - 1]).toEqual([1.2, 960, 520]);
    expect(b.camera![0]).toEqual([1.2, 960, 520]);
    const ease = cubicBezier(0.45, 0, 0.2, 1);
    expect(b.camera![30][0]).toBeCloseTo(1.2 - 0.2 * ease(0.5), 3);
    expect(b.camera![60]).toEqual([1, 960, 540]);
    expect(b.camera![b.durationInFrames - 1]).toEqual([1, 960, 540]);
  });

  it('uses the theme transition when the next scene opens a page, or after a gap, or on another page', () => {
    const opens = contiguous();
    (opens[1] as { open_end?: number }).open_end = 10.3;
    (opens[1] as { still: [number, number] }).still = [10.4, 11.6];
    const gap = contiguous();
    (gap[1] as { t_start: number }).t_start = 10.5;
    (gap[1] as { still: [number, number] }).still = [10.5, 11.6];
    const otherPage = contiguous();
    (otherPage[1] as { page?: string }).page = 'admin';
    for (const entries of [opens, gap]) {
      const p = plan(ctx, synthTimeline({ entries, duration: 16 }));
      const a = clip(p, 'a');
      const b = clip(p, 'b');
      expect(b.transition).toMatchObject({ kind: 'crossfade', frames: 11 });
      expect(a.heldFrames).toBe(11);
      expect(b.from).toBe(a.from + a.durationInFrames - 11);
      // The zoom of "a" ends with its clip (no ease-out shown): the held frames keep it.
      expect(a.camera![a.durationInFrames - 1]).toEqual([1.2, 960, 520]);
      expect(b.camera).toBeNull();
    }
    const tl = synthTimeline({ entries: otherPage, duration: 16 });
    tl.pages = [
      { id: 'app', t_start: 0, t_end: 10, url: 'http://app.test/a' },
      { id: 'admin', t_start: 10, t_end: 16, url: 'http://app.test/b' },
    ];
    expect(clip(plan(ctx, tl), 'b').transition?.kind).toBe('crossfade');
  });

  it('fade-black (overrides.transition) splits the transition into a fade out and a fade in, the clip holding its last frame', () => {
    const entries = contiguous();
    (entries[1] as { open_end?: number }).open_end = 10.3;
    const p = plan(ctx, synthTimeline({ entries, duration: 16 }), { transition: 'fade-black', transition_duration: 0.5 });
    const a = clip(p, 'a');
    const b = clip(p, 'b');
    expect(b.transition).toMatchObject({ kind: 'fade-black', frames: 15, component: { id: 'studio/transition-fade-black', source: 'override' } });
    expect(a.fadeOut).toEqual({ frames: 7, color: 'black' });
    expect(b.fadeIn).toEqual({ frames: 8, color: 'black' });
    expect(a.heldFrames).toBe(7);
    expect(b.from).toBe(a.from + a.durationInFrames);
    expect(seg(p, 'intro').fadeOut).toEqual({ frames: 7, color: 'black' });
  });

  it('cuts when the scene asks for it, and shortens a transition longer than half a segment', () => {
    const entries = contiguous();
    (entries[1] as { open_end?: number }).open_end = 10.3;
    (entries[1] as { transition?: string }).transition = 'cut';
    const p = plan(ctx, synthTimeline({ entries, duration: 16 }));
    const b = clip(p, 'b');
    expect(b.transition).toEqual({ kind: 'cut', frames: 0, component: null });
    expect(b.transitionIn).toBe('cut');
    expect(clip(p, 'a').heldFrames).toBe(0);
    expect(b.from).toBe(clip(p, 'a').from + clip(p, 'a').durationInFrames);
    const q = plan(ctx, synthTimeline({ entries: [{ card: { id: 'c1', slots: { title: 'T' }, duration: 1 } }, ...contiguous()], duration: 16 }), { transition_duration: 2 });
    expect(seg(q, 'c1').transition!.frames).toBe(15);
    expect(q.notes.some((n) => n.includes('shortened to 15 frames'))).toBe(true);
  });

  it('draws an interstitial over the last frame of the previous clip (none when it comes first)', () => {
    const entries: EntrySpec[] = [
      { interstitial: { id: 'wait-0', text: 'Earlier' } },
      { id: 'x', t_start: 0, t_end: 5, open_end: 0.5, still: [0.6, 2] },
      { interstitial: { id: 'wait-1', text: 'Later', duration: 2 } },
      { id: 'y', t_start: 5, t_end: 9, open_end: 5.5, still: [5.6, 7] },
    ];
    const p = plan(ctx, synthTimeline({ entries, duration: 9 }));
    const w0 = seg(p, 'wait-0') as CardSegment;
    const w1 = seg(p, 'wait-1') as CardSegment;
    expect(w0.backdropSrcFrame).toBeUndefined();
    expect(p.notes.some((n) => n.includes('interstitial "wait-0": no clip before it'))).toBe(true);
    expect(w1.backdropSrcFrame).toBe(149);
    expect(w1.durationInFrames).toBe(60);
    // Template interstitial duration (editorial: 2.6 s) when the scenario gives none.
    expect(w0.durationInFrames).toBe(78);
    expect(w1.component.slots).toEqual({ text: 'Later' });
    expect(w1.transition?.kind).toBe('crossfade');
    expect(clip(p, 'y').transition?.kind).toBe('crossfade');
  });

  it('a card or an interstitial without a duration stays long enough to read its text (R-FLD-03: 250 words a minute + 1.5 s, within the component bounds)', () => {
    const words = (n: number) => Array.from({ length: n }, (_v, i) => `word${i}`).join(' ');
    const entries: EntrySpec[] = [
      { card: { id: 'short', slots: { title: 'Chapter two' } } },
      { card: { id: 'long', slots: { kicker: 'Why', title: 'Quotes that follow', text: words(27) } } },
      { card: { id: 'set', slots: { title: 'Quotes that follow', text: words(27) }, duration: 2 } },
      { card: { id: 'huge', slots: { title: words(60), text: words(140) } } },
      { id: 'x', t_start: 0, t_end: 5, open_end: 0.5, still: [0.6, 2] },
      { interstitial: { id: 'later', text: words(20) } },
      { id: 'y', t_start: 5, t_end: 9, open_end: 5.5, still: [5.6, 7] },
    ];
    const p = plan(ctx, synthTimeline({ entries, duration: 9 }));
    const card = (id: string) => seg(p, id) as CardSegment;
    // Two words: the component's default (2.5 s) is already enough.
    expect(card('short').durationInFrames).toBe(75);
    expect(card('short').reading).toEqual({ words: 2, seconds: 2 });
    // 1 + 3 + 27 = 31 words → 31 / 250 × 60 + 1.5 = 8.94 → 8.9 s.
    expect(card('long').reading).toEqual({ words: 31, seconds: 8.9 });
    expect(card('long').durationInFrames).toBe(267);
    expect(p.notes).toContain('card "long": 8.9 s to read its 31 words (250 words a minute + 1.5 s)');
    // A duration of its own wins (the review then warns).
    expect(card('set').durationInFrames).toBe(60);
    // Bounded by the component's maximum (studio/card-title: 10 s).
    expect(card('huge').durationInFrames).toBe(300);
    // Interstitial: 20 words → 6.3 s instead of the theme's 2.6 s.
    expect(card('later').durationInFrames).toBe(189);
  });
});

/** One scene at 2× with a 4× typing step, a hold and a marked step. */
function speedScene(): EntrySpec[] {
  return [
    {
      id: 's',
      t_start: 0,
      t_end: 20,
      open_end: 0.5,
      still: [0.5, 2],
      speed: 2,
      steps: [
        { action: 'click', t_start: 2, t_end: 5 },
        { action: 'type', t_start: 5, t_end: 9, speed: 4 },
        { action: 'click', t_start: 9, t_end: 11, holdS: 1 },
        { action: 'hover', t_start: 12, t_end: 14, mark: 'm' },
        { action: 'click', t_start: 14.6, t_end: 20 },
      ],
    },
  ];
}

describe('speeds', () => {
  it('applies scene and step speeds, keeps the still, holds and ±0.6 s around a mark at 1×, ramps over 0.3 s', () => {
    const p = plan(ctx, synthTimeline({ entries: speedScene(), duration: 20 }));
    const s = clip(p, 's');
    expect(s.speeds.map((x) => [x.from, x.to, x.speed, x.to_speed, x.protected ?? false])).toEqual([
      [0, 45, 1, 1, true], // still 0.5–2 s
      [45, 54, 1, 2, false], // ramp 1 → 2 inside the 2× part
      [54, 92.25, 2, 2, false],
      [92.25, 101.25, 2, 4, false], // ramp inside the faster (4×) step
      [101.25, 117.75, 4, 4, false],
      [117.75, 126.75, 4, 2, false],
      [126.75, 150, 2, 2, false],
      [150, 159, 2, 1, false], // ramp before the protected hold
      [159, 267, 1, 1, true], // hold 11–12 s + mark window 11.4–14.6 s
      [267, 276, 1, 2, false],
      [276, 350.25, 2, 2, false],
      [351, 362, 0, 0, false], // held frames under the outro crossfade
    ]);
    const content = s.srcFrames.slice(0, s.durationInFrames - s.heldFrames);
    expect(content).toHaveLength(351);
    const d = diffs(content);
    // Still: exactly frame by frame.
    expect(content.slice(0, 45)).toEqual(Array.from({ length: 45 }, (_, k) => 15 + k));
    // Steady 2×, 4×, protected 1×.
    expect(d.slice(56, 90).every((x) => x === 2)).toBe(true);
    expect(d.slice(103, 116).every((x) => x === 4)).toBe(true);
    const prot = content.map((f, k) => [f, k] as const).filter(([f]) => f >= 331 && f < 437);
    expect(diffs(prot.map(([f]) => f)).every((x) => x === 1)).toBe(true);
    expect(prot.length).toBe(106);
    // The 1× → 2× ramp: speed linear over 9 output frames, source position p = 60 + j + j²/18 (exact frames = floor).
    expect(content.slice(45, 55)).toEqual(Array.from({ length: 10 }, (_, j) => Math.floor(60 + j + (j * j) / 18 + 1e-6)));
  });

  it('lets overrides.speeds replace the scene speed (step speeds still apply)', () => {
    const p = plan(ctx, synthTimeline({ entries: speedScene(), duration: 20 }), { speeds: { s: 1 } });
    const speeds = [...new Set(clip(p, 's').speeds.map((x) => x.speed))];
    expect(speeds.sort()).toEqual([0, 1, 4]);
    expect(p.notes).toContain('scene "s": speed 1× (overrides.speeds)');
  });

  it('plays the quick month runs of a date step at up to 3× (R-CHO-24); a step speed or a mark wins; off with trim_idle', () => {
    const quickScene = (extra: Record<string, unknown> = {}): EntrySpec[] => [
      {
        id: 'q',
        t_start: 0,
        t_end: 12,
        open_end: 0.5,
        still: [0.5, 1.5],
        steps: [
          { action: 'click', t_start: 1.5, t_end: 2 },
          { action: 'date', t_start: 2, t_end: 8, data: { days: ['2027-06-14'], quick_runs: [{ t_start: 3, t_end: 5.2, clicks: 21 }] }, ...extra },
          { action: 'click', t_start: 8, t_end: 12 },
        ],
      },
    ];
    const fast = (p: ReturnType<typeof plan>) => clip(p, 'q').speeds.filter((x) => x.speed === 3 && x.to_speed === 3);
    const p = plan(ctx, synthTimeline({ entries: quickScene(), duration: 12 }));
    // Padded 0.1 s before the first press and 0.35 s after the last: [2.9, 5.55] s, ramped in and out.
    const f = fast(p);
    expect(f.length).toBe(1);
    expect(p.notes.some((n) => n.includes('"q": month run 2.9') && n.includes('up to 3×'))).toBe(true);
    const all = clip(p, 'q').speeds;
    expect(all.find((x) => x.speed === 1 && x.to_speed === 3)).toBeDefined();
    expect(all.find((x) => x.speed === 3 && x.to_speed === 1)).toBeDefined();
    expect(fast(plan(ctx, synthTimeline({ entries: quickScene({ speed: 1.5 }), duration: 12 })))).toEqual([]);
    const markedRun = plan(ctx, synthTimeline({ entries: quickScene({ mark: 'pick' }), duration: 12 }));
    expect(fast(markedRun)).toEqual([]);
    // Nothing sped up: no note says it is.
    expect(markedRun.notes.some((n) => n.includes('month run'))).toBe(false);
    const off = plan(ctx, synthTimeline({ entries: quickScene(), duration: 12 }), { trim_idle: false });
    expect(fast(off)).toEqual([]);
    expect(off.notes.some((n) => n.includes('month run'))).toBe(false);
  });

  it('maps output frames to exact source frames at other output rates (60 fps: each frame twice)', () => {
    const p = plan(ctx, synthTimeline({ entries: contiguous(), duration: 16 }), { fps: 60 });
    const a = clip(p, 'a');
    expect(p.fps).toBe(60);
    expect(a.srcFrames.slice(0, 8)).toEqual([36, 36, 37, 37, 38, 38, 39, 39]);
    expect(a.durationInFrames).toBe((300 - 36) * 2);
    expect(seg(p, 'intro').durationInFrames).toBe(Math.round(3.2 * 60));
  });
});

/** Idle gaps: one long free gap, one under a hold, one short, one around a mark. */
function idleScene(): EntrySpec[] {
  return [
    {
      id: 'i',
      t_start: 0,
      t_end: 20,
      open_end: 0.5,
      still: [0.5, 2],
      steps: [
        { action: 'click', t_start: 2, t_end: 3 },
        { action: 'wait', t_start: 3, t_end: 9 },
        { action: 'click', t_start: 9, t_end: 10, holdS: 3 },
        { action: 'wait', t_start: 13.5, t_end: 16 },
        { action: 'click', t_start: 16, t_end: 17, mark: 'done' },
        { action: 'wait', t_start: 17, t_end: 20 },
      ],
    },
  ];
}
const IDLE: Array<[number, number]> = [
  [3.2, 8.9],
  [10.1, 13.5],
  [13.6, 14.5],
  [15, 19.9],
];

describe('idle trims', () => {
  it('shortens idle gaps longer than 1.2 s to 0.4 s, never inside a hold or a mark window', () => {
    const p = plan(ctx, synthTimeline({ entries: idleScene(), duration: 20, idle: IDLE }));
    const c = clip(p, 'i');
    expect(c.trims).toEqual([
      { at: 87, src_from_s: 3.4, src_to_s: 8.7 },
      { at: 87 + (534 - 261), src_from_s: 17.8, src_to_s: 19.7 },
    ]);
    const content = c.srcFrames.slice(0, c.durationInFrames - c.heldFrames);
    expect(content.length).toBe(585 - (261 - 102) - (591 - 534));
    expect(content.slice(85, 89)).toEqual([100, 101, 261, 262]);
    // No frame of a cut is shown; the hold (10–13 s) and the mark window (15.4–17.6 s) are complete.
    expect(content.some((f) => f >= 102 && f < 261)).toBe(false);
    for (let f = 300; f < 390; f++) expect(content).toContain(f);
    for (let f = 462; f < 528; f++) expect(content).toContain(f);
    expect(p.notes.filter((n) => n.includes('shortened to 0.40 s'))).toHaveLength(2);
  });

  it('honours trim_idle = false and idle_threshold', () => {
    const tl = synthTimeline({ entries: idleScene(), duration: 20, idle: IDLE });
    const off = clip(plan(ctx, tl, { trim_idle: false }), 'i');
    expect(off.trims).toEqual([]);
    expect(off.durationInFrames - off.heldFrames).toBe(585);
    expect(clip(plan(ctx, tl, { idle_threshold: 6 }), 'i').trims).toEqual([]);
    expect(clip(plan(ctx, tl, { idle_threshold: 3 }), 'i').trims.map((t) => t.src_from_s)).toEqual([3.4]);
    expect(clip(plan(ctx, tl, { idle_threshold: 2 }), 'i').trims.map((t) => t.src_from_s)).toEqual([3.4, 17.8]);
  });

  it('plans a run on its own (planRunTiming): cut pieces take no output time', () => {
    const run = planRunTiming({
      clips: [{ scene: 'i', A: 0, B: 300, baseSpeed: 1, events: [] }],
      srcFps: 30,
      outFps: 30,
      idle: [{ t_start: 2, t_end: 6 }],
      trimIdle: true,
      idleThresholdS: 1.2,
    });
    expect(run.cuts).toHaveLength(1);
    expect(run.length).toBeCloseTo(300 - (174 - 66), 6);
    expect(run.pieces.filter((m) => m.cut).every((m) => m.q0 === m.q1)).toBe(true);
  });
});

describe('held page loads (R-ISS-08)', () => {
  const marked = [{ scene: 'n', scene_index: 0, step: 0, action: 'click', t_start: 4, t_end: 5, mark: 'm', status: 'ok' as const }];
  const run = (loading: Array<{ t_start: number; t_end: number }>, more: { idle?: Array<{ t_start: number; t_end: number }>; trimIdle?: boolean } = {}) =>
    planRunTiming({
      clips: [{ scene: 'n', A: 0, B: 300, baseSpeed: 1, events: marked }],
      srcFps: 30,
      outFps: 30,
      idle: more.idle ?? [],
      trimIdle: more.trimIdle ?? true,
      idleThresholdS: 1.2,
      loading,
    });

  it('cuts a held load of 0.15 s or more whole — inside a mark window too — up to the first frame of the painted page', () => {
    const r = run([{ t_start: 4.2, t_end: 5.01 }]);
    expect(r.cuts).toEqual([expect.objectContaining({ a: 126, b: 151, reason: 'loading', clip: 0 })]);
    // The mark window (3.4–5.6 s) stays at 1× around the cut; nothing of the frozen frame is shown.
    expect(r.src.some((f) => f >= 126 && f < 151)).toBe(false);
    expect(r.src).toContain(125);
    expect(r.src).toContain(151);
    expect(r.length).toBeCloseTo(300 - 25, 6);
  });

  it('a multi-page run: a load held on one page is cut only where no other page acts (a step, a mark window, the still)', () => {
    const events = [
      { scene: 'n', scene_index: 0, step: -1, action: 'scene_still', t_start: 0, t_end: 1, page: 'a', status: 'ok' as const },
      { scene: 'n', scene_index: 0, step: 0, action: 'press', t_start: 4.6, t_end: 4.8, page: 'a', status: 'ok' as const },
      { scene: 'n', scene_index: 0, step: 1, action: 'click', t_start: 5, t_end: 5.6, t_click: 5.4, page: 'b', mark: 'click-b', status: 'ok' as const },
      { scene: 'n', scene_index: 0, step: 2, action: 'click', t_start: 8, t_end: 8.5, page: 'b', status: 'ok' as const },
    ];
    const loads = [
      { t_start: 4.8, t_end: 6.5, page: 'a' },
      { t_start: 7, t_end: 9, page: 'a' },
      { t_start: 0.5, t_end: 1.5, page: 'b' },
    ];
    // Page a's first load keeps only what follows b's marked click and its mark window (5.6 + 0.6 s).
    expect(loadsBesideOtherPages(loads, events).map((l) => [Math.round(l.t_start * 1000) / 1000, l.t_end, l.page])).toEqual([
      [6.2, 6.5, 'a'],
      [7, 8, 'a'],
      [8.5, 9, 'a'],
      [1, 1.5, 'b'],
    ]);
    // The other page's marked click (5.0–5.6 s, page a held 4.8–6.0 s) is shown whole.
    const r = planRunTiming({ clips: [{ scene: 'n', A: 0, B: 300, baseSpeed: 1, events }], srcFps: 30, outFps: 30, idle: [], trimIdle: true, idleThresholdS: 1.2, loading: loadsBesideOtherPages([{ t_start: 4.8, t_end: 6, page: 'a' }], events) });
    expect(r.cuts).toEqual([]);
    expect(r.src.filter((f) => f >= 150 && f < 168).length).toBe(18);
  });

  it('a shorter freeze is not cut, nor anything with trim_idle off', () => {
    expect(run([{ t_start: 4.2, t_end: 4.33 }]).cuts).toEqual([]);
    expect(run([{ t_start: 4.2, t_end: 5 }], { trimIdle: false }).cuts).toEqual([]);
  });

  it('an idle gap around a held load is shortened outside it: no overlapping cuts', () => {
    const r = run([{ t_start: 6, t_end: 7 }], { idle: [{ t_start: 5.8, t_end: 9.5 }] });
    expect(r.cuts.map((c) => [c.reason, c.a, c.b])).toEqual([
      ['loading', 180, 210],
      ['idle', 216, 279],
    ]);
  });

  it('planEdit cuts it and says so; a page change inside it starts the visible loading at its end', () => {
    const entries: EntrySpec[] = [
      {
        id: 'nav',
        t_start: 0,
        t_end: 12,
        open_end: 0.5,
        still: [0.5, 2],
        steps: [
          { action: 'click', t_start: 2, t_end: 5, t_click: 2.6 },
          { action: 'wait_for', t_start: 5, t_end: 8 },
          { action: 'hold', t_start: 8, t_end: 12 },
        ],
      },
    ];
    const tl = synthTimeline({ entries, duration: 12 });
    tl.pages.push({ id: 'app', t_start: 2.9, t_end: 12, url: 'http://app.test/next' });
    tl.pages[0].t_end = 2.9;
    tl.loading = [{ t_start: 2.9, t_end: 4.1, page: 'app', until: 'paint', held_frames: 70 }];
    const p = plan(ctx, tl);
    const c = clip(p, 'nav');
    expect(c.trims).toEqual([{ at: expect.any(Number), src_from_s: 2.9, src_to_s: 4.1 }]);
    expect(p.notes).toContain('"nav": page load 2.90 s–4.10 s of the capture cut (the capture held the previous frame until the new page painted)');
    // The waiting after the click (page change at 2.9, painted at 4.1) is played faster from 4.1 + WAIT_KEEP_S, not
    // from inside the cut.
    expect(p.notes.find((n) => n.includes('waiting'))).toMatch(/waiting 4\.60 s–8\.00 s/);
    // The page change comes from the page's own event, the load from the recorder's: 1 ms apart either way (H4).
    const early = structuredClone(tl);
    early.pages[1].t_start = 2.899;
    early.pages[0].t_end = 2.899;
    expect(plan(ctx, early).notes.find((n) => n.includes('waiting'))).toMatch(/waiting 4\.60 s–8\.00 s/);
    // Older timelines (no `loading`) plan as before.
    const old = plan(ctx, { ...tl, loading: undefined });
    expect(clip(old, 'nav').trims).toEqual([]);
    expect(plan(ctx, tl, { trim_idle: false }).notes.some((n) => n.includes('page load 2.90 s'))).toBe(false);
  });
});

/** Camera hints: a clamped zoom on a point until the step ends, then a cursor-focused zoom held 2 s with `fast`. */
function cameraScene(): EntrySpec[] {
  return [
    {
      id: 'c',
      t_start: 0,
      t_end: 20,
      still: [0.5, 2],
      steps: [
        { action: 'click', t_start: 2, t_end: 3, camera: { zoom: 2, until: 'step_end', point: { x: 100, y: 100 } } },
        { action: 'wait', t_start: 3, t_end: 8 },
        { action: 'click', t_start: 8, t_end: 9, camera: { zoom: 1.25, until: 2, ease: 'fast' } },
        { action: 'wait', t_start: 9, t_end: 20 },
      ],
    },
  ];
}

describe('camera', () => {
  it('clamps the zoom to max_zoom, focuses point → cursor, eases in output time and clamps the view', () => {
    const tl = synthTimeline({ entries: cameraScene(), duration: 20, cursor: [[0, 960, 540], [8.5, 1500, 300], [9.5, 1500, 300]] });
    const p = plan(ctx, tl);
    const c = clip(p, 'c');
    const cam = c.camera!;
    expect(c.zooms).toHaveLength(2);
    expect(c.zooms[0]).toMatchObject({ from: 45, in_frames: 30, out_at: 75, zoom: 1.4, requested_zoom: 2, focus: { x: 100, y: 100 }, view: { x: 685.71, y: 385.71 } });
    expect(p.notes).toContain('"c" step 0: zoom 2 clamped to the theme max_zoom 1.4');
    expect(cam[44]).toEqual([1, 960, 540]);
    expect(cam[45]).toEqual([1, 960, 540]);
    const theme = cubicBezier(0.45, 0, 0.2, 1);
    const e = theme(15 / 30);
    expect(cam[60][0]).toBeCloseTo(1 + 0.4 * e, 4);
    expect(cam[60][1]).toBeCloseTo(960 + (685.714 - 960) * e, 1);
    expect(cam[75]).toEqual([1.4, 685.71, 385.71]);
    expect(cam[90][0]).toBeCloseTo(1 + 0.4 * (1 - theme(0.5)), 4);
    expect(cam[105]).toEqual([1, 960, 540]);
    // Cursor focus (1500, 300) clamped at 1.25×; preset `fast`; held 2 s after the ease-in.
    expect(c.zooms[1]).toMatchObject({ from: 225, in_frames: 30, out_at: 315, zoom: 1.25, focus: { x: 1500, y: 300 }, view: { x: 1152, y: 432 } });
    const fast = cubicBezier(...CAMERA_EASINGS.fast);
    expect(cam[235][0]).toBeCloseTo(1 + 0.25 * fast(10 / 30), 4);
    expect(cam[255]).toEqual([1.25, 1152, 432]);
    expect(cam[314]).toEqual([1.25, 1152, 432]);
    expect(cam[345]).toEqual([1, 960, 540]);
    for (const [z, x, y] of cam) {
      expect(x - 1920 / (2 * z)).toBeGreaterThanOrEqual(-0.01);
      expect(y - 1080 / (2 * z)).toBeGreaterThanOrEqual(-0.01);
    }
    // The overlay/anchor mapping follows the camera: at full zoom the view is 1371×771 px around (685.71, 385.71).
    const r = mapSourceRect(p, c, 75, { x: 685.71, y: 385.71 });
    const cap = c.layout.capture;
    expect(r.x).toBeCloseTo(cap.x + cap.w / 2, 1);
    expect(r.y).toBeCloseTo(cap.y + cap.h / 2, 1);
  });

  it('takes a longer camera duration and keeps the 0.8 s minimum', () => {
    const entries = cameraScene();
    const steps = (entries[0] as { steps: Array<{ camera?: object; t_end: number; t_start: number }> }).steps;
    steps[0].camera = { zoom: 1.2, duration: 3, point: { x: 960, y: 540 } };
    steps[2].t_end = 8.2;
    steps[2].camera = { zoom: 1.2, point: { x: 960, y: 540 }, until: 'step_end' };
    const c = clip(plan(ctx, synthTimeline({ entries, duration: 20 })), 'c');
    expect(c.zooms[0].in_frames).toBe(90);
    expect(c.zooms[1].in_frames).toBe(24); // max(0.8 s, 0.2 s step)
    // The second zoom starts from where the first one is (held until scene end, interrupted).
    expect(c.camera![c.zooms[1].from]).toEqual([1.2, 960, 540]);
  });

  it('stays static without hints and when overrides.camera = false', () => {
    const p = plan(ctx, synthTimeline({ entries: cameraScene(), duration: 20 }), { camera: false });
    expect(clip(p, 'c').camera).toBeNull();
    expect(clip(p, 'c').zooms).toEqual([]);
    expect(p.notes).toContain('camera disabled (overrides.camera = false): 2 zoom hints ignored');
    expect(clip(plan(ctx, synthTimeline({ entries: idleScene(), duration: 20 })), 'i').camera).toBeNull();
  });
});

describe('captions', () => {
  const entries: EntrySpec[] = [
    {
      id: 'k',
      t_start: 0,
      t_end: 10,
      still: [0, 2],
      caption: { kicker: 'K', text: 'Scene' },
      steps: [
        { action: 'click', t_start: 2, t_end: 4 },
        { action: 'click', t_start: 4, t_end: 6, caption: { text: 'Step one' } },
        { action: 'click', t_start: 6, t_end: 8 },
        { action: 'click', t_start: 8, t_end: 10, caption: { kicker: 'Two', text: 'Step two' } },
      ],
    },
  ];

  it('replaces the scene caption by step captions from their output start; cues never overlap', () => {
    const p = plan(ctx, synthTimeline({ entries, duration: 10 }));
    const k = clip(p, 'k');
    const F = k.from;
    expect(p.captions).toEqual([
      { from: F, to: F + 120, kicker: 'K', text: 'Scene', scene: 'k' },
      { from: F + 120, to: F + 240, text: 'Step one', scene: 'k' },
      { from: F + 240, to: seg(p, 'outro').from, kicker: 'Two', text: 'Step two', scene: 'k' },
    ]);
    expect(k.cues.map((c) => [c.from, c.to])).toEqual([
      [0, 120],
      [120, 240],
      [240, k.durationInFrames],
    ]);
  });

  it('drops the scene caption when the first step has its own; no captions when disabled or when the theme has none', () => {
    const first: EntrySpec[] = [
      { id: 'f', t_start: 0, t_end: 5, caption: { text: 'Scene' }, steps: [{ action: 'click', t_start: 0, t_end: 2, caption: { text: 'First' } }, { action: 'wait', t_start: 2, t_end: 5 }] },
    ];
    expect(plan(ctx, synthTimeline({ entries: first, duration: 5 })).captions.map((c) => c.text)).toEqual(['First']);
    const off = plan(ctx, synthTimeline({ entries, duration: 10 }), { captions: false });
    expect(off.captions).toEqual([]);
    expect(clip(off, 'k').caption).toBeNull();
    const none = structuredClone(ctx.editorial);
    none.template.components = { ...none.template.components, caption: null };
    const q = plan(ctx, synthTimeline({ entries, duration: 10 }), undefined, none);
    expect(q.captions).toEqual([]);
    expect(clip(q, 'k').caption).toBeNull();
  });

  it('warns when the text the video shows still holds {{tokens}} (a run captured before scenario templating, L1.2)', () => {
    const literal = (p: EditPlan) => p.warnings.filter((w) => w.includes('{{…}} tokens'));
    expect(literal(plan(ctx, synthTimeline({ entries, duration: 10 })))).toEqual([]);
    const old: EntrySpec[] = [{ ...entries[0], caption: { text: 'Hello {{vars.customer}}' } }];
    const p = plan(ctx, synthTimeline({ entries: old, duration: 10 }));
    expect(p.captions[0].text).toBe('Hello {{vars.customer}}');
    expect(literal(p)).toEqual(['scene k still shows {{…}} tokens as written: a run captured before scenario templating (L1.2), or a token inside a `vars` value (inserted as written) — fix it and capture again']);
  });
});

describe('overlays', () => {
  it('shows step overlays from the step output end for their duration (component default), clamped to the clip', () => {
    const entries: EntrySpec[] = [
      {
        id: 'o',
        t_start: 0,
        t_end: 6,
        still: [0, 1],
        steps: [
          { action: 'click', t_start: 1, t_end: 2, overlay: { component: 'studio/overlay-callout', slots: { text: 'Hi' }, params: {}, point: { x: 10, y: 20 } } },
          { action: 'click', t_start: 2, t_end: 5, overlay: { component: 'studio/overlay-callout', slots: { text: 'Late', bogus: 'x' }, params: {}, duration: 30, bbox: { x: 100, y: 100, w: 50, h: 20 } } },
          { action: 'click', t_start: 5, t_end: 5.5, overlay: { component: 'acme/nope', slots: { text: 'Fallback' }, params: {} } },
          { action: 'wait', t_start: 5.5, t_end: 6 },
        ],
      },
    ];
    const p = plan(ctx, synthTimeline({ entries, duration: 6 }));
    const o = clip(p, 'o');
    expect(o.overlays.map((x) => [x.step, x.from, x.durationInFrames, x.component.id, x.component.source])).toEqual([
      [0, 60, 75, 'studio/overlay-callout', 'scenario'],
      [1, 150, o.durationInFrames - 150, 'studio/overlay-callout', 'scenario'],
      [2, 165, o.durationInFrames - 165, 'studio/overlay-callout', 'theme'],
    ]);
    expect(o.overlays[0].anchor).toEqual({ point: { x: 10, y: 20 } });
    expect(o.overlays[1].anchor).toEqual({ bbox: { x: 100, y: 100, w: 50, h: 20 } });
    expect(p.warnings.some((w) => w.includes('has no slot "bogus"'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('acme/nope') && w.includes('using studio/overlay-callout'))).toBe(true);
    expect(p.notes.some((n) => n.includes('step 1 overlay: shortened'))).toBe(true);
  });
});

describe('component precedence', () => {
  const entries = (component?: string): EntrySpec[] => [
    { card: { id: 'chapter', slots: { title: 'Chapter' }, ...(component ? { component } : {}) } },
    { id: 'x', t_start: 0, t_end: 5, open_end: 0.5, still: [0.6, 2] },
  ];
  const card = (p: EditPlan) => seg(p, 'chapter').component;

  it('segment id override → kind override → scenario → theme', () => {
    const tl = synthTimeline({ entries: entries('acme/card-scn'), duration: 5 });
    expect(card(withWs(alt, tl))).toMatchObject({ id: 'acme/card-scn', source: 'scenario', slots: { title: 'Chapter' } });
    expect(card(withWs(alt, tl, { components: { card: 'acme/card-kind' } }))).toMatchObject({ id: 'acme/card-kind', source: 'override' });
    expect(card(withWs(alt, tl, { components: { card: 'acme/card-kind', chapter: 'acme/card-seg' } }))).toMatchObject({ id: 'acme/card-seg', source: 'override' });
    expect(card(withWs(alt, synthTimeline({ entries: entries(), duration: 5 })))).toMatchObject({ id: 'studio/card-title', source: 'theme' });
    // Params given with an override are validated with the component's defaults.
    const p = withWs(alt, tl, { components: { card: { id: 'acme/card-kind', params: { align: 'left' } } } });
    expect(card(p).params).toEqual({ align: 'left' });
  });

  it('falls back when a component is not found or has the wrong kind, and reports it', () => {
    const p = withWs(alt, synthTimeline({ entries: entries('acme/nope'), duration: 5 }));
    expect(card(p)).toMatchObject({ id: 'studio/card-title', source: 'theme' });
    expect(p.warnings.some((w) => w.startsWith('card "chapter": card component from the scenario card not usable') && w.includes('acme/nope'))).toBe(true);
    const q = withWs(alt, synthTimeline({ entries: entries('acme/intro-alt'), duration: 5 }));
    expect(card(q).id).toBe('studio/card-title');
    expect(q.warnings.some((w) => w.includes('is an intro component, not a card'))).toBe(true);
  });

  it('uses the built-in default when the theme component is missing, and marks a use missing when nothing resolves', async () => {
    const ws = await studioWorkspace({}, { omit: ['studio/intro-minimal', 'studio/card-title', 'studio/transition-fade-black'] });
    try {
      const motion = await template('motion');
      const p = withWs(ws, synthTimeline({ entries: entries(), duration: 5 }), undefined, motion);
      expect(seg(p, 'intro').component).toMatchObject({ id: 'studio/intro-stack', source: 'builtin-default' });
      expect(p.warnings.some((w) => w.startsWith('intro: intro component from the theme not usable') && w.includes('studio/intro-minimal'))).toBe(true);
      expect(card(p)).toMatchObject({ id: 'studio/card-title', missing: true, version: '0.0.0', slots: { title: 'Chapter' } });
      expect(p.warnings.some((w) => w.startsWith('card "chapter": no card component could be resolved'))).toBe(true);
      // The motion theme's fade-black transition is missing: the built-in default (crossfade) is used.
      expect(clip(p, 'x').transition).toMatchObject({ kind: 'crossfade', component: { id: 'studio/transition-crossfade', source: 'builtin-default' } });
    } finally {
      await ws.cleanup();
    }
  });

  it('honours the scenario intro/outro (component, duration, false) and overrides.intro / outro', () => {
    const base = synthTimeline({ entries: entries(), duration: 5 });
    const withIntro = { ...base, video: { ...base.video, intro: { component: 'acme/intro-alt', duration: 2 } } };
    const p = withWs(alt, withIntro);
    expect(seg(p, 'intro').component).toMatchObject({ id: 'acme/intro-alt', source: 'scenario', slots: { title: 'Synthetic video', kicker: 'Kicker' } });
    expect(seg(p, 'intro').durationInFrames).toBe(60);
    expect(seg(withWs(alt, withIntro, { components: { intro: 'studio/intro-stack' } }), 'intro').component).toMatchObject({ id: 'studio/intro-stack', source: 'override' });
    const off = { ...base, video: { ...base.video, intro: false as const, outro: false as const } };
    expect(withWs(alt, off).segments.map((s) => s.kind)).toEqual(['card', 'clip']);
    expect(withWs(alt, off, { intro: true }).segments.map((s) => s.kind)).toEqual(['intro', 'card', 'clip']);
    expect(withWs(alt, base, { outro: false, intro: false }).segments.map((s) => s.kind)).toEqual(['card', 'clip']);
    expect(withWs(alt, base).segments[0].transition).toBeUndefined();
  });
});

describe('layouts and output size', () => {
  const entries: EntrySpec[] = [
    { id: 'x', t_start: 0, t_end: 5, open_end: 0.5, still: [0.6, 2] },
    { id: 'y', t_start: 5, t_end: 9, open_end: 5.5, still: [5.6, 7], frame: 'acme/layout-alt' },
  ];

  it('takes the layout from overrides → scene frame → scenario/project frame → theme, with the manifest geometry', () => {
    const tl = synthTimeline({ entries, duration: 9 });
    const p = withWs(alt, tl);
    expect(clip(p, 'x').component).toMatchObject({ id: 'studio/layout-card', source: 'theme' });
    expect(clip(p, 'y').component).toMatchObject({ id: 'acme/layout-alt', source: 'scenario' });
    const g = alt.registry.get('studio/layout-card').manifest.geometry!;
    expect(p.layout.capture).toEqual({ x: g.screen.x, y: 54.25, w: 1560, h: 877.5 });
    expect(p.layout.caption).toEqual(g.caption);
    expect(p.layout.radius).toBe(18);
    const raw = withWs(alt, { ...tl, video: { ...tl.video, frame: 'raw' } });
    expect(clip(raw, 'x').component).toMatchObject({ id: 'studio/layout-raw', source: 'scenario' });
    const ov = withWs(alt, tl, { frame: 'browser' });
    expect(clips(ov).map((c) => c.component.id)).toEqual(['studio/layout-browser', 'studio/layout-browser']);
    const kind = withWs(alt, tl, { frame: 'browser', components: { layout: 'acme/layout-alt', x: 'studio/layout-raw' } });
    expect(clips(kind).map((c) => c.component.id)).toEqual(['studio/layout-raw', 'acme/layout-alt']);
  });

  it('fits a 4:3 capture inside the screen rect and scales everything by the output scale', () => {
    const tl = synthTimeline({ entries, duration: 9 });
    tl.capture.width = 1440;
    const p = withWs(alt, tl);
    expect(p.layout.capture).toEqual({ x: 374.667, y: 54, w: 1170.667, h: 878 });
    expect(p.layout.card).toEqual(p.layout.capture);
    const big = withWs(alt, synthTimeline({ entries, duration: 9 }), { scale: 2 });
    expect([big.width, big.height, big.unit]).toEqual([3840, 2160, 2]);
    expect(big.layout.capture).toEqual({ x: 360, y: 108.5, w: 3120, h: 1755 });
    expect(big.layout.radius).toBe(36);
    // Capture scale 2 ⇒ 4K by default.
    const tl2 = synthTimeline({ entries, duration: 9 });
    tl2.capture.scale = 2;
    expect([withWs(alt, tl2).width, withWs(alt, tl2).source.width]).toEqual([3840, 3840]);
  });

  it('plans the vertical variant: 1080×1920, geometry_vertical (a 4:5 card), a crop that follows the cursor smoothly', () => {
    const glide: Array<[number, number, number]> = [[0, 300, 500], [4.9, 300, 500]];
    for (let i = 1; i <= 10; i++) glide.push([4.9 + i * 0.07, 300 + (1300 * i) / 10, 500]);
    glide.push([10, 1600, 500]);
    const tl = synthTimeline({
      entries: [{ id: 'v', t_start: 0, t_end: 10, still: [0, 1], steps: [{ action: 'click', t_start: 1, t_end: 10 }] }],
      duration: 10,
      cursor: glide,
    });
    const p = withWs(ctx.ws, tl, { variant: 'vertical' });
    expect([p.width, p.height, p.unit, p.variant]).toEqual([1080, 1920, 1, 'vertical']);
    // The (scaffolded) card's vertical screen is 1000 × 1240: a 16:9 capture is reframed, the crop has the full height.
    expect(p.layout.capture).toEqual({ x: 40, y: 224, w: 1000, h: 1240 });
    expect(p.layout.crop).toEqual({ w: 870.968, h: 1080 });
    const v = clip(p, 'v');
    const v0 = v;
    const rf = v.reframe!;
    expect(rf).toHaveLength(v.durationInFrames);
    // At the start the cursor (300, 500) is near the left edge: the crop rests against it; at the end it shows the
    // cursor at 1600 (its arrow box and the margin inside the view).
    expect(rf[0][0]).toBeCloseTo(870.968 / 2, 1);
    expect(rf[rf.length - 1][0]).toBeGreaterThan(1600 + 56 + 12 - 870.968 / 2);
    expect(rf[rf.length - 1][0]).toBeLessThanOrEqual(1920 - 870.968 / 2 + 0.01);
    expect(rf.every((r) => r[1] === 540)).toBe(true);
    // One smooth pan to the right: no back-and-forth beyond a gentle settle (< 2 % of the travel), no jump, no jolt.
    const xs = rf.map((r) => r[0]);
    const dx = diffs(xs);
    const travel = xs[xs.length - 1] - xs[0];
    let peak = xs[0];
    let back = 0;
    for (const x of xs) {
      peak = Math.max(peak, x);
      back = Math.max(back, peak - x);
    }
    expect(back).toBeLessThan(0.02 * travel);
    expect(Math.max(...dx)).toBeLessThan(40);
    expect(Math.max(...diffs(dx).map(Math.abs))).toBeLessThan(4);
    // The cursor never leaves the view.
    for (let k = 0; k < rf.length; k++) {
      const v = viewOf(p, v0, k);
      const t = v0.srcFrames[k] / 30;
      const next = tl.cursor.findIndex((s) => s.t > t);
      const i = next < 0 ? tl.cursor.length - 1 : Math.max(0, next - 1);
      const [a, b] = [tl.cursor[i], tl.cursor[Math.min(i + 1, tl.cursor.length - 1)]];
      const x = b.t > a.t ? a.x + (b.x - a.x) * Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : a.x;
      expect(x >= v.cx - v.w / 2 && x <= v.cx + v.w / 2, `frame ${k}: cursor ${x}, view ${v.cx - v.w / 2}–${v.cx + v.w / 2}`).toBe(true);
    }
    // Mid-move the crop is between the two positions; the view is the crop.
    const mid = rf[Math.round(5.25 * FPS)];
    expect(mid[0]).toBeGreaterThan(rf[0][0] + 50);
    expect(mid[0]).toBeLessThan(rf[rf.length - 1][0] - 50);
    const r = mapSourceRect(p, v, 0, { x: rf[0][0] - 870.968 / 2, y: 0, w: 870.968, h: 1080 });
    expect(r).toEqual({ x: 40, y: 224, w: 1000, h: 1240 });
  });

  it('plans the square variant: 1080×1080, geometry_square, a crop narrowed for readability', () => {
    const tl = synthTimeline({ entries: [{ id: 'v', t_start: 0, t_end: 6, still: [0, 1], steps: [{ action: 'click', t_start: 1, t_end: 6 }] }], duration: 6 });
    const p = withWs(ctx.ws, tl, { variant: 'square' });
    expect([p.width, p.height, p.unit, p.variant]).toEqual([1080, 1080, 1, 'square']);
    expect(p.layout.capture).toEqual({ x: 40, y: 40, w: 1000, h: 750 });
    expect(p.layout.caption).toEqual({ x: 40, y: 802, w: 1000, h: 160 });
    expect(p.layout.brandmark).toEqual({ x: 960, y: 1010, w: 80, h: 40 });
    // The largest 4:3 region (1440 × 1080) would show the page at 0.69×: narrowed to 0.9× (REFRAME_MIN_SCALE).
    expect(p.layout.crop!.w).toBeCloseTo(1000 / 0.9, 2);
    expect(p.layout.crop!.h).toBeCloseTo(750 / 0.9, 2);
    expect(clip(p, 'v').reframe).toHaveLength(clip(p, 'v').durationInFrames);
    // 4K square from a scale-1 capture: everything doubles, with an upscaling warning.
    const big = withWs(ctx.ws, tl, { variant: 'square', scale: 2 });
    expect([big.width, big.height, big.unit]).toEqual([2160, 2160, 2]);
    expect(big.warnings.some((w) => /upscaled/.test(w))).toBe(true);
    expect(p.warnings.some((w) => /upscaled/.test(w))).toBe(false);
  });

  it('uses a default geometry (with a warning) when the layout has none for the variant', async () => {
    const ws = await studioWorkspace({
      'studio/layout-card': (y) => y.replace(/geometry_vertical:\n(  .*\n)+/, '').replace(/variants: \[ ?landscape, vertical, square ?\]/, 'variants: [landscape, square]'),
    });
    try {
      const p = withWs(ws, synthTimeline({ entries, duration: 9 }), { variant: 'vertical' });
      expect(p.layout.fallback).toBe(true);
      expect(p.layout.capture).toEqual({ x: 40, y: 560, w: 1000, h: 563 });
      expect(p.warnings.some((w) => w.includes('declares no geometry_vertical'))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('music, overrides, errors', () => {
  const entries: EntrySpec[] = [{ id: 'x', t_start: 0, t_end: 5, open_end: 0.5, still: [0.6, 2] }];

  it('takes the music bed from the video block, overrides.music replaces or removes it', () => {
    const tl = synthTimeline({ entries, duration: 5 });
    tl.video = { ...tl.video, music: { file: 'assets/bed.mp3', volume: 0.4 } };
    const p = plan(ctx, tl);
    expect(p.music).toEqual({ url: 'ds-asset:music.mp3', file: join(ctx.project.dir, 'assets/bed.mp3'), volume: 0.4, duck: 0.5, duck_ramp_s: 0.5, fadeIn_s: 1, fadeOut_s: 2, loop: true, crossfade_s: 1 });
    expect(p.assets['ds-asset:music.mp3']).toBe(p.music!.file);
    expect(plan(ctx, tl, { music: false }).music).toBeUndefined();
    expect(plan(ctx, tl, { music: '/abs/other.wav' }).music).toMatchObject({ file: '/abs/other.wav', volume: 0.4 });
    expect(plan(ctx, synthTimeline({ entries, duration: 5 })).music).toBeUndefined();
  });

  it('warns about overrides that match nothing and refuses dry runs', () => {
    const tl = synthTimeline({ entries, duration: 5 });
    const p = plan(ctx, tl, { components: { nope: 'studio/card-title' }, speeds: { ghost: 2 }, theme: 'motion', fps: 0 });
    expect(p.warnings).toEqual(
      expect.arrayContaining([
        'overrides.components["nope"]: neither a component kind nor a segment id of this video',
        'overrides.speeds["ghost"]: no captured scene "ghost" in this run',
        'overrides.theme is "motion" but the theme passed to the planner is "editorial": the caller loads the override theme',
        "overrides.fps 0 ignored: use 1–120 (keeping the capture's 30 fps)",
      ]),
    );
    expect(() => plan(ctx, { ...tl, mode: 'dry' })).toThrow(PlanError);
  });

  it('falls back to the scenario for timelines without a video block', () => {
    const tl = synthTimeline({ entries, duration: 5 });
    delete tl.video;
    const p = planEdit({
      timeline: tl,
      template: ctx.editorial,
      project: ctx.project,
      registry: ctx.ws.registry,
      captureFile: '/c.mp4',
      scenario: { video: 'old', title: { text: 'From the scenario' }, outro: false, scenes: [] },
    });
    expect(seg(p, 'intro').component.slots.title).toBe('From the scenario');
    expect(p.segments.map((s) => s.kind)).toEqual(['intro', 'clip']);
    expect(p.notes[0]).toContain('no "video" block');
  });

  it('is deterministic on synthetic timelines too, with provenance tiling every clip', () => {
    const tl = synthTimeline({ entries: idleScene(), duration: 20, idle: IDLE });
    const a = JSON.stringify(plan(ctx, tl, { speeds: { i: 1.5 } }));
    const b = JSON.stringify(plan(ctx, tl, { speeds: { i: 1.5 } }));
    expect(a).toBe(b);
    const c = clip(JSON.parse(a) as EditPlan, 'i');
    expect(c.steps[0].from).toBe(0);
    expect(c.steps[c.steps.length - 1].to).toBe(c.durationInFrames);
    for (let i = 1; i < c.steps.length; i++) expect(c.steps[i].from).toBe(c.steps[i - 1].to);
    expect(c.steps.map((s) => s.step)).toEqual([-1, 0, 1, 2, 3, 4, 5]);
  });
});

describe('raw captures (L2.13)', () => {
  it('a run captured without its cursor (run --raw --cursor none|layer) plans with a warning: the video shows no cursor', () => {
    const tl = synthTimeline({ entries: [{ id: 'a', t_start: 0, t_end: 4 }], duration: 4 });
    expect(plan(ctx, tl).warnings.some((w) => w.includes('without its in-page cursor'))).toBe(false);
    tl.capture.cursor = 'hidden';
    expect(plan(ctx, tl).warnings.some((w) => w.includes('captured without its in-page cursor') && w.includes('shows no cursor'))).toBe(true);
  });
});

/** Narrowing helper kept for type-checking ClipSegment imports. */
export type _Clip = ClipSegment;
