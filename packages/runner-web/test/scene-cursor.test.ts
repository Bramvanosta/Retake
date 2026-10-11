import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import type { BBox, CursorSample, PointSpec, Scenario, Timeline, TimelineEvent } from '@demo-studio/core';
import { runScenario } from '../src/index.js';
import { cursorCovers, firstPointerStep } from '../src/scene-cursor.js';
import type { SceneCursorRecord } from '../src/scene-cursor.js';
import { normalizeStep } from '@demo-studio/core';
import { CURSOR_PAGE } from './pages.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/cursor.html': CURSOR_PAGE });
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
        // f: auto on a continuing scene already clear of its target → keeps the position.
        { id: 'f', steps: [{ click: { text: 'Far away' } }] },
        // g: re-opens the page; no pointer step → neutral right-centre rest point, placed while loading.
        { id: 'g', open: '/cursor.html', steps: [{ wait: 0.1 }] },
      ],
    };
    const rec = await runScenario({ project, scenario: makeScenario('cursor', scenario), mode: 'dry', runId: `cursor-${Date.now()}` });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    const st = stills(tl);
    expect(st.map((e) => e.scene)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
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
    expect(rec_.f).toMatchObject({ mode: 'auto', how: 'keep' });
    expect(rec_.g).toMatchObject({ mode: 'auto', how: 'teleport', side: 'fallback' });

    // No visible jump. Teleports and kept positions: no motion at all inside the still (the teleport happened before
    // it, while the page loaded). Glides: many small eased steps — a jump would cover the whole distance in one step
    // (the 60 Hz loop is wall-clock driven, so a loaded machine may merge a few ticks: compare with the distance).
    for (const e of st) {
      const c = cursorOf(e);
      const step = maxStep(tl.cursor, e.t_start, e.t_end);
      if (c.how === 'glide') {
        const d = dist(c.from!, c.to);
        const samples = tl.cursor.filter((x) => x.t >= e.t_start && x.t <= e.t_end).length;
        expect(samples, `glide of ${e.scene}`).toBeGreaterThanOrEqual(8);
        expect(step, `glide of ${e.scene} (${d.toFixed(0)} px)`).toBeLessThan(0.4 * d);
      } else {
        expect(step, `still of ${e.scene}`).toBe(0);
      }
    }
  });

  it('finds the first pointer step, skipping non-pointer steps and stopping at page changes', () => {
    const steps = (list: unknown[]) => list.map((s, i) => normalizeStep(s as never, i));
    expect(firstPointerStep(steps([{ wait: 1 }, { scroll: 300 }, { click: 'Save' }]))).toMatchObject({ step: { action: 'click' }, scrolls: [{ to: 300 }] });
    expect(firstPointerStep(steps([{ type: { text: 'x' } }, { hover: 'Menu' }]))?.step.action).toBe('hover');
    expect(firstPointerStep(steps([{ open: '/x' }, { click: 'Save' }]))).toBeNull();
    expect(firstPointerStep(steps([{ cursor: 'hide' }, { click: 'Save' }]))).toBeNull();
    expect(firstPointerStep(steps([{ wait: 1 }]))).toBeNull();
  });
});
