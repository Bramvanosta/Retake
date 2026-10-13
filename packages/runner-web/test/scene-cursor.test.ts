import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import type { BBox, CursorSample, PointSpec, Scenario, Timeline, TimelineEvent } from '@demo-studio/core';
import { runScenario } from '../src/index.js';
import { KEEP_NEAR_PX, cursorCovers, firstPointerStep } from '../src/scene-cursor.js';
import type { SceneCursorRecord } from '../src/scene-cursor.js';
import { normalizeStep } from '@demo-studio/core';
import { CURSOR_DIALOG_PAGE, CURSOR_PAGE, CURSOR_TALL_PAGE } from './pages.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/cursor.html': CURSOR_PAGE, '/cursor-dialog.html': CURSOR_DIALOG_PAGE, '/cursor-tall.html': CURSOR_TALL_PAGE });
  dir = await tempDir('rw-cursor-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Field-tested motion (smooth glides), fast everything else. */
const PACING = { ...FAST, move_base_ms: 0, move_ms_per_px: 0.9, move_min_ms: 450, move_max_ms: 1100, scene_start_still: 1.2 };

const stills = (tl: Timeline) => tl.events.filter((e) => e.action === 'scene_still');
const cursorOf = (e: TimelineEvent) => (e.data as { cursor: SceneCursorRecord }).cursor;
const firstClick = (tl: Timeline, scene: string) => tl.events.find((e) => e.scene === scene && e.step >= 0 && e.t_click !== undefined)!;

/** Largest distance between consecutive cursor samples in [t0, t1], including the last sample before t0. */
function maxStep(samples: CursorSample[], t0: number, t1: number): number {
  let prev: CursorSample | undefined;
  let max = 0;
  for (const s of samples) {
    if (s.t < t0) {
      prev = s;
      continue;
    }
    if (s.t > t1) break;
    if (prev) max = Math.max(max, Math.hypot(s.x - prev.x, s.y - prev.y));
    prev = s;
  }
  return max;
}

const dist = (a: PointSpec, b: PointSpec) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = (b: BBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * No visible jump, measured on the recorded samples (positions, not wall-clock timings). Teleports and kept
 * positions: no motion at all inside the still (the teleport happened before it, while the page loaded). Glides:
 * many small eased steps that only move forward along the way — a teleport covers the whole distance in one step.
 * The glide runs on a motion clock that a loaded machine can pause but never make skip ahead (Pointer.moveTo,
 * MAX_TICK_ADVANCE_MS), so these bounds hold whatever the load: ≥ duration / 2 ticks samples, each step ≤ the
 * eased path over two ticks (≈ 0.22 d for a 450 ms glide; the fake-clock stall tests are in unit.test.ts).
 */
function expectNoJump(tl: Timeline, st: TimelineEvent[]): void {
  for (const e of st) {
    const c = cursorOf(e);
    const step = maxStep(tl.cursor, e.t_start, e.t_end);
    if (c.how === 'glide') {
      const d = dist(c.from!, c.to);
      const inside = tl.cursor.filter((x) => x.t >= e.t_start && x.t <= e.t_end);
      expect(inside.length, `glide of ${e.scene}`).toBeGreaterThanOrEqual(8);
      expect(step, `glide of ${e.scene} (${d.toFixed(0)} px)`).toBeLessThan(0.3 * d);
      // Forward only: the remaining distance to the rest point never grows by more than the arc's bulge.
      const left = inside.map((x) => dist(x, c.to));
      for (let i = 1; i < left.length; i++) expect(left[i], `glide of ${e.scene}, sample ${i}`).toBeLessThanOrEqual(left[i - 1] + 2);
      expect(left.at(-1), `glide of ${e.scene} ends on its rest point`).toBeLessThan(1);
    } else {
      expect(step, `still of ${e.scene}`).toBe(0);
    }
  }
}

describe('scene-start cursor (R-ISS-04)', () => {
  it('auto rests near the first target without covering it; point / keep / target; continuing scenes glide, never jump', async () => {
    const project = makeProject(dir, { app: server.url }, { width: 1000, height: 640 });
    const scenario: Omit<Scenario, 'video'> = {
      pacing: PACING,
      scenes: [
        // a: opens the page → placed while loading, next to "Start" (top-left), not on it.
        { id: 'a', open: '/cursor.html', steps: [{ click: { text: 'Start' } }] },
        // b: continues → glides during the still to an explicit point.
        { id: 'b', cursor: { x: 520, y: 420 }, steps: [{ hover: { text: 'Far away', ms: 100 } }] },
        // c: keep → no move at all.
        { id: 'c', cursor: 'keep', steps: [{ wait: 0.1 }] },
        // d: a target → glides onto it (the cursor now covers "Far away").
        { id: 'd', cursor: { text: 'Start' }, steps: [{ wait: 0.1 }] },
        // e: auto on a continuing scene whose first target is under the cursor → glides away from it.
        { id: 'e', steps: [{ click: { text: 'Start' } }] },
        // f: auto on a continuing scene clear of its target but far from it → glides next to it (R-MAC-07).
        { id: 'f', steps: [{ click: { text: 'Far away' } }] },
        // h: an explicit point just below-right of "Far away" (the click left the cursor on it).
        { id: 'h', cursor: { x: 790, y: 380 }, steps: [{ wait: 0.1 }] },
        // i: auto on a continuing scene clear of its target and close to it → keeps the position.
        { id: 'i', steps: [{ click: { text: 'Far away' } }] },
        // g: re-opens the page; no pointer step → neutral right-centre rest point, placed while loading.
        { id: 'g', open: '/cursor.html', steps: [{ wait: 0.1 }] },
      ],
    };
    const rec = await runScenario({ project, scenario: makeScenario('cursor', scenario), mode: 'dry', runId: `cursor-${Date.now()}` });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    const st = stills(tl);
    expect(st.map((e) => e.scene)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'h', 'i', 'g']);
    const rec_ = Object.fromEntries(st.map((e) => [e.scene, cursorOf(e)])) as Record<string, SceneCursorRecord>;

    // a: teleported while loading, near Start, never covering it, inside the viewport.
    const startBox = firstClick(tl, 'a').target!.bbox!;
    expect(rec_.a).toMatchObject({ mode: 'auto', how: 'teleport' });
    expect(rec_.a.anchor).toContain('Start');
    expect(cursorCovers(rec_.a.to, startBox)).toBe(false);
    expect(dist(rec_.a.to, centre(startBox))).toBeLessThan(260);
    expect(rec_.a.to.x).toBeGreaterThan(0);
    expect(rec_.a.to.y).toBeGreaterThan(0);
    expect(rec_.a.to.x).toBeLessThan(1000);
    expect(rec_.a.to.y).toBeLessThan(640);
    // The still shows the cursor at that point from its first frame.
    expect(st[0].point).toEqual(rec_.a.to);

    expect(rec_.b).toMatchObject({ mode: 'point', how: 'glide', to: { x: 520, y: 420 } });
    expect(rec_.b.move_ms).toBeGreaterThanOrEqual(450);
    expect(st[1].point).toEqual({ x: 520, y: 420 });
    expect(rec_.c).toMatchObject({ mode: 'keep', how: 'keep' });
    expect(st[2].point).toEqual(rec_.c.from);
    expect(rec_.d).toMatchObject({ mode: 'target', how: 'glide' });
    expect(cursorCovers(rec_.d.to, startBox, 26, 0)).toBe(true);
    expect(rec_.e).toMatchObject({ mode: 'auto', how: 'glide' });
    expect(cursorCovers(rec_.e.to, startBox)).toBe(false);
    const farBox = firstClick(tl, 'f').target!.bbox!;
    expect(dist(rec_.f.from!, centre(farBox))).toBeGreaterThan(KEEP_NEAR_PX);
    expect(rec_.f).toMatchObject({ mode: 'auto', how: 'glide' });
    expect(cursorCovers(rec_.f.to, farBox)).toBe(false);
    expect(dist(rec_.f.to, centre(farBox))).toBeLessThan(260);
    expect(rec_.h).toMatchObject({ mode: 'point', how: 'glide', to: { x: 790, y: 380 } });
    expect(rec_.i).toMatchObject({ mode: 'auto', how: 'keep', to: { x: 790, y: 380 } });
    expect(rec_.g).toMatchObject({ mode: 'auto', how: 'teleport', side: 'fallback' });

    expectNoJump(tl, st);
  });

  it('a continuing scene glides next to a far first target, inside the dialog that holds it (R-MAC-06, R-MAC-07)', async () => {
    const project = makeProject(dir, { app: server.url }, { width: 1000, height: 640 });
    const scenario: Omit<Scenario, 'video'> = {
      pacing: PACING,
      scenes: [
        // p: opens the page; the click on "Outside" leaves the cursor top-left, far from the dialog's field.
        { id: 'p', open: '/cursor-dialog.html', steps: [{ click: { text: 'Outside' } }] },
        // q: continues → glides next to where the 480 px field will be clicked, inside the dialog.
        { id: 'q', steps: [{ click: { text: 'Pick dates' } }] },
        // r: the cursor is on the field after its click → glides off it, a short way, still inside the dialog.
        { id: 'r', steps: [{ click: { text: 'Pick dates' } }] },
      ],
    };
    const rec = await runScenario({ project, scenario: makeScenario('cursor-dialog', scenario), mode: 'dry', runId: `cursor-dialog-${Date.now()}` });
    expect(rec.error?.message).toBeUndefined();
    const tl = await readTimeline(rec.timeline!);
    const st = stills(tl);
    const rec_ = Object.fromEntries(st.map((e) => [e.scene, cursorOf(e)])) as Record<string, SceneCursorRecord>;
    // The dialog of CURSOR_DIALOG_PAGE: left 200, top 150, 520 × 340 (+ its border); the drawn arrow extends right/down.
    const inDialog = (p: PointSpec) => p.x > 200 && p.y > 150 && p.x + 26 < 722 && p.y + 32 < 492;
    for (const id of ['q', 'r']) {
      const click = firstClick(tl, id);
      expect(rec_[id], id).toMatchObject({ mode: 'auto', how: 'glide' });
      expect(inDialog(rec_[id].to), `${id} rests inside the dialog: ${JSON.stringify(rec_[id].to)}`).toBe(true);
      expect(cursorCovers(rec_[id].to, click.target!.bbox!)).toBe(false);
      expect(dist(rec_[id].to, click.point!), `${id} rests next to the click point`).toBeLessThan(160);
    }
    expect(dist(rec_.r.from!, rec_.r.to)).toBeLessThan(200);
    expectNoJump(tl, st);
  });

  it('keeps a clear cursor when no spot next to a huge first target exists; aims at the click point after a predicted scroll', async () => {
    const project = makeProject(dir, { app: server.url }, { width: 1000, height: 640 });
    const scenario: Omit<Scenario, 'video'> = {
      pacing: PACING,
      scenes: [
        { id: 'a', open: '/cursor-tall.html', steps: [{ click: { text: 'Corner' } }] },
        // b: the textarea fills the viewport: the only spot left (the right-centre fallback) is on it → keep.
        { id: 'b', steps: [{ type: { text: 'hi', into: '#big' } }] },
        // b2: rest ≈ 130 px from where "Deep button" will be once scene c has scrolled.
        { id: 'b2', cursor: { x: 230, y: 380 }, steps: [{ wait: 0.1 }] },
        // c: a scroll comes first; its button is below the fold now. Judged where the scroll brings it (≈ 130 px):
        // kept (an out-of-view point clipped to the viewport put it ≈ 470 px away and made it glide).
        { id: 'c', steps: [{ scroll: 1200 }, { click: { text: 'Deep button' } }] },
      ],
    };
    const rec = await runScenario({ project, scenario: makeScenario('cursor-tall', scenario), mode: 'dry', runId: `cursor-tall-${Date.now()}` });
    expect(rec.error?.message).toBeUndefined();
    const tl = await readTimeline(rec.timeline!);
    const st = stills(tl);
    const rec_ = Object.fromEntries(st.map((e) => [e.scene, cursorOf(e)])) as Record<string, SceneCursorRecord>;
    const bigBox = tl.events.find((e) => e.scene === 'b' && e.action === 'type')!.target!.bbox!;
    expect(rec_.b).toMatchObject({ mode: 'auto', how: 'keep' });
    expect(cursorCovers(rec_.b.to, bigBox)).toBe(false);
    const deep = firstClick(tl, 'c');
    expect(dist({ x: 230, y: 380 }, deep.point!)).toBeLessThan(KEEP_NEAR_PX);
    expect(rec_.c).toMatchObject({ mode: 'auto', how: 'keep', to: { x: 230, y: 380 } });
    expectNoJump(tl, st);
  });

  it('finds the first pointer step, skipping non-pointer steps and stopping at page changes', () => {
    const steps = (list: unknown[]) => list.map((s, i) => normalizeStep(s as never, i));
    expect(firstPointerStep(steps([{ wait: 1 }, { scroll: 300 }, { click: 'Save' }]))).toMatchObject({ step: { action: 'click' }, scrolls: [{ to: 300 }] });
    expect(firstPointerStep(steps([{ type: { text: 'x' } }, { hover: 'Menu' }]))?.step.action).toBe('hover');
    expect(firstPointerStep(steps([{ open: '/x' }, { click: 'Save' }]))).toBeNull();
    expect(firstPointerStep(steps([{ cursor: 'hide' }, { click: 'Save' }]))).toBeNull();
    expect(firstPointerStep(steps([{ wait: 1 }]))).toBeNull();
    // A date without a field clicks the days on screen: not known before it runs, so no later target stands in for it.
    expect(firstPointerStep(steps([{ date: '3 March 2027' }, { click: 'Save' }]))).toBeNull();
    expect(firstPointerStep(steps([{ date: { field: 'Delivery', day: '3 March 2027' } }]))?.step.action).toBe('date');
  });
});
