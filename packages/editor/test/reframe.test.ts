/**
 * Reframing of the vertical and square variants (camera.ts `reframeTrack`, `dampedSmooth`, `corridorSmooth`;
 * plan.ts `reframeTargets`): no jitter (dead zone), look-ahead, critically damped smoothing without overshoot, the
 * cursor and the clicked target never cut, the capture's edges eased into — on synthetic tracks and on the real
 * fixture timelines planned in both variants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Timeline } from '@retake/core';
import { REFRAME, corridorSmooth, dampedSmooth, leadingPart, planEdit, reframeTargets, reframeTrack, viewOf } from '@retake/editor';
import type { CameraFrame, ClipSegment, EditPlan, ReframeTarget } from '@retake/editor';
import { clips, studioWorkspace } from './helpers.js';
import { fixtureProject, realTimeline, template } from '@retake/test-support/timeline';
import type { Workspace } from './helpers.js';

const FPS = 30;
const CSS = { w: 1920, h: 1080 };
const CROP = { w: 864, h: 1080 };
const still: CameraFrame = [1, 960, 540];

function track(cursor: Array<[number, number, number]>, seconds: number, targets: ReframeTarget[] = [], crop = CROP): Array<[number, number]> {
  const times = Array.from({ length: Math.round(seconds * FPS) }, (_, k) => k / FPS);
  return reframeTrack({
    times,
    camera: times.map(() => still),
    cursor: cursor.map(([t, x, y]) => ({ t, x, y, visible: true })),
    crop,
    css: CSS,
    outFps: FPS,
    targets,
  });
}

const steps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]);
const maxAbs = (xs: number[]) => Math.max(0, ...xs.map(Math.abs));

describe('smoothing', () => {
  it('dampedSmooth: a step becomes a smooth S without lag (it starts before and ends after) and never overshoots', () => {
    const v = Array.from({ length: 120 }, (_, k) => (k < 60 ? 0 : 100));
    const s = dampedSmooth(v, FPS, 0.2);
    expect(Math.min(...s)).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.max(...s)).toBeLessThanOrEqual(100 + 1e-9);
    expect(s[50]).toBeGreaterThan(1); // anticipates
    expect(s[70]).toBeLessThan(99); // and settles after
    expect(Math.abs(s[59] + s[60] - 100)).toBeLessThan(2); // zero phase: symmetric around the step
    expect(steps(s).every((d) => d >= -1e-9)).toBe(true); // monotonic
    expect(maxAbs(steps(steps(s)))).toBeLessThan(2);
  });

  it('corridorSmooth: returns a path already inside as is; bends a violating one smoothly into the corridor', () => {
    const free = Array.from({ length: 100 }, (_, k) => 500 + k);
    expect(
      corridorSmooth(
        free,
        free.map(() => 0),
        free.map(() => 2000),
        9,
      ),
    ).toEqual(free);
    const lo = free.map((_, k) => (k >= 40 && k < 50 ? 700 : 0));
    const x = corridorSmooth(
      free,
      lo,
      free.map(() => 2000),
      9,
    );
    for (let k = 0; k < 100; k++) expect(x[k]).toBeGreaterThanOrEqual(lo[k] - 1e-6);
    expect(maxAbs(steps(steps(x)))).toBeLessThan(3);
    // Critically damped: the repair is one bump, never the wrong way (no ringing), fading far from the constraint.
    for (let k = 0; k < 100; k++) expect(x[k]).toBeGreaterThanOrEqual(free[k] - 1e-6);
    expect(x[0] - free[0]).toBeLessThan(0.1 * 200);
    expect(x[99] - free[99]).toBeLessThan(0.1 * 200);
  });
});

describe('reframeTrack (synthetic)', () => {
  it('holds still while the cursor moves inside the dead zone (no jitter)', () => {
    const cursor: Array<[number, number, number]> = [];
    for (let i = 0; i <= 60; i++) cursor.push([i * 0.1, 900 + (i % 2 ? 40 : -40), 500 + (i % 3) * 20]);
    const rf = track(cursor, 6);
    const xs = rf.map((r) => r[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.5);
  });

  it('looks ahead: the view starts moving towards the next step target before the step starts', () => {
    const cursor: Array<[number, number, number]> = [
      [0, 400, 500],
      [3, 400, 500],
      [3.6, 1500, 500],
      [6, 1500, 500],
    ];
    const target: ReframeTarget = { t0: 3, t1: 5, box: { x: 1450, y: 480, w: 120, h: 40 } };
    const rf = track(cursor, 6, [target]);
    const at = (t: number) => rf[Math.round(t * FPS)][0];
    expect(at(2.8)).toBeGreaterThan(at(0.5) + 20); // moving before the step (3 s) and before the cursor (3 s)
    // At the step end the target and the cursor are in view.
    const v = { cx: at(4), w: CROP.w };
    expect(1450 >= v.cx - v.w / 2 && 1570 <= v.cx + v.w / 2).toBe(true);
  });

  it('never cuts the cursor nor a hard (clicked) target, even on a fast glide across the page', () => {
    const cursor: Array<[number, number, number]> = [
      [0, 200, 300],
      [1, 200, 300],
    ];
    for (let i = 1; i <= 8; i++) cursor.push([1 + i * 0.1, 200 + (1500 * i) / 8, 300 + 50 * i]); // 1500 px in 0.8 s
    cursor.push([4, 1700, 700]);
    const click: ReframeTarget = { t0: 2, t1: 2.8, box: { x: 1600, y: 680, w: 200, h: 44 }, hard: true };
    const rf = track(cursor, 4, [click]);
    for (let k = 0; k < rf.length; k++) {
      const t = k / FPS;
      const next = cursor.findIndex((c) => c[0] > t);
      const i = next < 0 ? cursor.length - 1 : Math.max(0, next - 1);
      const [a, b] = [cursor[i], cursor[Math.min(i + 1, cursor.length - 1)]];
      const p = b[0] > a[0] ? Math.min(1, (t - a[0]) / (b[0] - a[0])) : 0;
      const x = a[1] + (b[1] - a[1]) * p;
      expect(Math.abs(x - rf[k][0]), `frame ${k}`).toBeLessThanOrEqual(CROP.w / 2);
      if (t >= click.t0 && t < click.t1) expect(rf[k][0] - CROP.w / 2 <= 1600 && rf[k][0] + CROP.w / 2 >= 1800, `click frame ${k}`).toBe(true);
    }
    // Still smooth: no jump, no jolt (the cursor itself moves 62 px per frame here).
    const xs = rf.map((r) => r[0]);
    expect(maxAbs(steps(xs))).toBeLessThan(0.08 * CROP.w);
    expect(maxAbs(steps(steps(xs)))).toBeLessThan(0.015 * CROP.w);
  });

  it('stays inside the capture and eases into its edge (the cursor at the very edge)', () => {
    const cursor: Array<[number, number, number]> = [
      [0, 900, 500],
      [2, 900, 500],
      [2.5, 1915, 500],
      [5, 1915, 500],
    ];
    const rf = track(cursor, 5);
    const xs = rf.map((r) => r[0]);
    expect(Math.max(...xs)).toBeLessThanOrEqual(CSS.w - CROP.w / 2 + 1e-6);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(CROP.w / 2 - 1e-6);
    expect(xs[xs.length - 1]).toBeCloseTo(CSS.w - CROP.w / 2, 0);
    expect(maxAbs(steps(steps(xs)))).toBeLessThan(0.015 * CROP.w);
  });

  it('a square crop (both axes) keeps a target that fits in view; the zoomed view follows the camera focus', () => {
    const crop = { w: 1111, h: 833 };
    const cursor: Array<[number, number, number]> = [
      [0, 300, 200],
      [2, 300, 200],
      [2.6, 1500, 900],
      [5, 1500, 900],
    ];
    const target: ReframeTarget = { t0: 2, t1: 5, box: { x: 1400, y: 880, w: 200, h: 60 }, hard: true };
    const rf = track(cursor, 5, [target], crop);
    const end = rf[rf.length - 1];
    expect(end[0] - crop.w / 2 <= 1400 && end[0] + crop.w / 2 >= 1600).toBe(true);
    expect(end[1] - crop.h / 2 <= 880 && end[1] + crop.h / 2 >= 940).toBe(true);
    expect(end[1]).toBeLessThanOrEqual(CSS.h - crop.h / 2 + 1e-6);
    // Zoomed 1.3× on a focus: the (smaller) view keeps the focus.
    const times = Array.from({ length: 90 }, (_, k) => k / FPS);
    const cam = times.map((_, k): CameraFrame => (k < 30 ? [1, 960, 540] : [1.3, 1600, 300]));
    const z = reframeTrack({ times, camera: cam, cursor: [{ t: 0, x: 1600, y: 300, visible: true }], crop: CROP, css: CSS, outFps: FPS });
    const v = { cx: z[80][0], w: CROP.w / 1.3 };
    expect(Math.abs(1600 - v.cx)).toBeLessThanOrEqual(v.w / 2);
  });

  it('a target wider than the view counts by its leading part: a table row clicked in its middle shows its id and label', () => {
    // A 1342 px row clicked at its centre (960): the 864 px crop cannot show it whole; it shows where the row starts
    // (x 289: its id, a "New" pill, the coffee's name) along with the cursor.
    const cursor: Array<[number, number, number]> = [
      [0, 960, 600],
      [1, 960, 600],
      [1.6, 960, 243],
      [5, 960, 243],
    ];
    const row = { x: 289, y: 194, w: 1342, h: 97 };
    const rf = track(cursor, 5, [
      { t0: 1, t1: 4, box: row },
      { t0: 2.65, t1: 3.5, box: row, hard: true },
    ]);
    for (const t of [3, 3.4]) {
      const x0 = rf[Math.round(t * FPS)][0] - CROP.w / 2;
      expect(x0, `${t} s`).toBeLessThanOrEqual(289);
      expect(x0 + CROP.w, `${t} s`).toBeGreaterThanOrEqual(960 + REFRAME.cursor_box.right);
    }
    // Once the row's step is over, the cursor resting alone at the edge of the dead zone is only brought back inside:
    // the view does not pan half its width across the page that just opened.
    const held = rf.slice(Math.round(3.4 * FPS)).map((r) => r[0]);
    expect(Math.max(...held) - Math.min(...held)).toBeLessThan(20);
    expect(leadingPart(row, CROP, null, REFRAME.margin)).toEqual({ x: 289, y: 194, w: 840, h: 97 });
    expect(leadingPart({ x: 10, y: 10, w: 100, h: 50 }, CROP, null, REFRAME.margin)).toEqual({ x: 10, y: 10, w: 100, h: 50 });
  });

  it('starts framed toward the page’s leading edge (its heading in view)', () => {
    // The first step's region (a button with the resting cursor) fits the view anywhere between the page's left edge
    // and its own left: the view starts as far left (and up) as it allows — the page's heading in view.
    const cursor: Array<[number, number, number]> = [
      [0, 700, 300],
      [6, 700, 300],
    ];
    const square = { w: 1111, h: 833 };
    const rf = track(cursor, 3, [{ t0: 0.5, t1: 2, box: { x: 600, y: 260, w: 140, h: 44 } }], square);
    expect(rf[0][0]).toBeCloseTo(square.w / 2, 0);
    expect(rf[0][1]).toBeCloseTo(square.h / 2, 0);
  });

  it('settles toward the leading edge where the page only rests (an idle pane of a multi-page scene)', () => {
    // The page clicks a button at the right, then rests (the other page acts from 3 s): its view leaves the button
    // and settles on the page's content around the resting cursor.
    const cursor: Array<[number, number, number]> = [
      [0, 1500, 500],
      [6, 1500, 500],
    ];
    const click: ReframeTarget = { t0: 0.5, t1: 2, box: { x: 1450, y: 480, w: 140, h: 40 }, hard: true };
    const times = Array.from({ length: 6 * FPS }, (_, k) => k / FPS);
    const run = (settle?: number[]) =>
      reframeTrack({
        times,
        camera: times.map(() => still),
        cursor: cursor.map(([t, x, y]) => ({ t, x, y, visible: true })),
        crop: CROP,
        css: CSS,
        outFps: FPS,
        targets: [click],
        ...(settle ? { settle } : {}),
      });
    const held = run();
    const settled = run([3]);
    expect(held[5 * FPS][0]).toBeCloseTo(held[2 * FPS][0], 0);
    // As far left as the resting cursor allows inside the dead zone (its arrow box at the inset's right edge).
    const c = settled[5 * FPS][0];
    expect(c).toBeCloseTo(1500 + REFRAME.cursor_box.right + CROP.w * REFRAME.dead_zone - CROP.w / 2, 0);
    expect(c).toBeLessThan(held[5 * FPS][0] - 20);
    expect(settled[2 * FPS][0]).toBeCloseTo(held[2 * FPS][0], 0);
  });

  it('tunables are documented values', () => {
    expect(REFRAME.dead_zone).toBeGreaterThan(0);
    expect(REFRAME.look_ahead_s).toBeGreaterThan(0);
    expect(REFRAME.tau_s).toBeGreaterThan(0);
  });
});

describe('reframeTargets', () => {
  it('step targets (soft), each widget click (hard, around the click) and overlay anchors (hard, while shown)', () => {
    const events = [
      { scene: 's', scene_index: 0, step: -1, action: 'scene_still', t_start: 0, t_end: 1, status: 'ok' },
      { scene: 's', scene_index: 0, step: 0, action: 'click', t_start: 1, t_end: 2, t_click: 1.5, status: 'ok', target: { desc: 'b', bbox: { x: 10, y: 10, w: 50, h: 20 } } },
      {
        scene: 's',
        scene_index: 0,
        step: 1,
        action: 'select',
        t_start: 2,
        t_end: 4,
        t_click: 2.5,
        status: 'ok',
        target: { desc: 'combo', bbox: { x: 100, y: 100, w: 200, h: 40 } },
        data: {
          clicks: [
            { t_click: 2.5, bbox: { x: 100, y: 100, w: 200, h: 40 } },
            { t_click: 3.5, bbox: { x: 100, y: 180, w: 200, h: 30 } },
          ],
        },
      },
      {
        scene: 's',
        scene_index: 0,
        step: 2,
        action: 'wait_for',
        t_start: 4,
        t_end: 4.1,
        status: 'ok',
        overlay: { component: 'studio/overlay-callout', slots: {}, params: {}, duration: 2, bbox: { x: 500, y: 500, w: 80, h: 30 } },
      },
    ] as Timeline['events'];
    const t = reframeTargets(events);
    expect(t.filter((x) => x.hard).map((x) => [x.t0, x.t1, x.box.y])).toEqual([
      [1.15, 2, 10],
      [2.15, 3, 100],
      [3.15, 4, 180],
      [4.1, 6.1, 500],
    ]);
    expect(t.filter((x) => !x.hard).map((x) => [x.t0, x.t1])).toEqual([
      [1, 2],
      [2, 4],
      [2, 3],
      [2.5, 4],
    ]);
  });
});

describe('real fixture timelines, vertical and square', () => {
  let ws: Workspace;
  let plans: Array<{ name: string; plan: EditPlan; timeline: Timeline }>;

  beforeAll(async () => {
    ws = await studioWorkspace();
    const project = await fixtureProject();
    const editorial = await template('editorial');
    plans = [];
    for (const name of ['catalogue', 'quote'] as const) {
      const timeline = realTimeline(name);
      for (const variant of ['vertical', 'square'] as const) {
        plans.push({ name: `${name} ${variant}`, timeline, plan: planEdit({ timeline, template: editorial, project, registry: ws.registry, captureFile: '/c.mp4', overrides: { variant } }) });
      }
    }
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  const cursorAt = (tl: Timeline, t: number) => {
    const c = tl.cursor;
    const next = c.findIndex((s) => s.t > t);
    const i = next < 0 ? c.length - 1 : Math.max(0, next - 1);
    const [a, b] = [c[i], c[Math.min(i + 1, c.length - 1)]];
    const p = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, visible: a.visible };
  };

  it('every click: the clicked target and the cursor are in view; the cursor never leaves the view', () => {
    for (const { name, plan, timeline } of plans) {
      for (const clip of clips(plan)) {
        expect(clip.reframe, `${name} ${clip.scene}`).toHaveLength(clip.durationInFrames);
        const n = clip.durationInFrames - clip.heldFrames;
        for (let k = 0; k < n; k++) {
          const t = clip.srcFrames[k] / plan.source.fps;
          const c = cursorAt(timeline, t);
          if (!c.visible) continue;
          const v = viewOf(plan, clip, k);
          expect(Math.abs(c.x - v.cx) <= v.w / 2 && Math.abs(c.y - v.cy) <= v.h / 2, `${name} ${clip.scene} frame ${k}`).toBe(true);
        }
        for (const ev of timeline.events.filter((e) => e.scene === clip.scene && e.t_click !== undefined)) {
          const list = (ev.data as { clicks?: Array<{ t_click: number; bbox?: { x: number; y: number; w: number; h: number } }> } | undefined)?.clicks ?? [
            { t_click: ev.t_click!, bbox: ev.target?.bbox },
          ];
          for (const c of list) {
            const k = clip.srcFrames.findIndex((f) => f >= Math.round(c.t_click * plan.source.fps));
            if (k < 0 || k >= n || !c.bbox) continue;
            const v = viewOf(plan, clip, k);
            const b = c.bbox;
            const inView = b.x >= v.cx - v.w / 2 - 0.5 && b.x + b.w <= v.cx + v.w / 2 + 0.5 && b.y >= v.cy - v.h / 2 - 0.5 && b.y + b.h <= v.cy + v.h / 2 + 0.5;
            expect(inView, `${name} ${clip.scene} step ${ev.step} click at ${c.t_click}`).toBe(true);
          }
        }
      }
    }
  });

  it('smooth framing: no jump (≤ 3.5 % of the crop per frame) and no jolt (≤ 1.2 % per frame², the worst at a release from the capture edge)', () => {
    for (const { name, plan } of plans) {
      for (const clip of clips(plan) as ClipSegment[]) {
        const crop = clip.layout.crop!;
        const xs = clip.reframe!.map((r) => r[0]);
        const ys = clip.reframe!.map((r) => r[1]);
        const step = Math.max(maxAbs(steps(xs)), maxAbs(steps(ys)));
        const accel = Math.max(maxAbs(steps(steps(xs))), maxAbs(steps(steps(ys))));
        expect(step, `${name} ${clip.scene}`).toBeLessThan(0.035 * crop.w);
        expect(accel, `${name} ${clip.scene}`).toBeLessThan(0.012 * crop.w);
      }
    }
  });

  it('is deterministic', async () => {
    const project = await fixtureProject();
    const editorial = await template('editorial');
    const timeline = realTimeline('quote');
    const a = planEdit({ timeline, template: editorial, project, registry: ws.registry, captureFile: '/c.mp4', overrides: { variant: 'square' } });
    const b = planEdit({ timeline, template: editorial, project, registry: ws.registry, captureFile: '/c.mp4', overrides: { variant: 'square' } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
