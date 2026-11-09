/**
 * L2.10 review awareness, without video: what the planner could not show (`tutorial-skipped`), tutorial targets cut by
 * the framing (`tutorial-target-cut`), story-card media that could not be resolved (`media-missing`), and the opening
 * still of a scene compared on its capture frames while an overlay comes in (the spotlight of the first step dims the
 * whole screen) — on the real fixture timelines of `signup` (tutorial on) and `highlights` (every story card).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject, loadTemplate } from '@retake/core';
import type { Timeline } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { planEdit } from '@retake/editor/plan';
import type { ClipSegment, EditOverrides, EditPlan, PlanInputFile, RenderRecord } from '@retake/editor/plan';
import { DEFAULT_RULES, captionOverDuring, checkOverlayCover, checkTutorial, fontFileMeasurer, outputClicks, overlayDuring, planFontFiles, segmentSpans, stillFromSource, stillGlideEnd, stillPair, stillSourceFrames, transitionSpans, viewMoves } from '../src/index.js';
import type { CheckContext } from '../src/index.js';
import { REPO, synthTimeline } from './helpers.js';

const FIXTURES = join(REPO, 'packages/editor/test/fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
const CSV: Record<string, PlanInputFile> = { 'data/quotes-per-month.csv': { file: '/p/data/quotes-per-month.csv', text: 'month,quote requests\nJun,42\nJul,51\n' } };
let registry: ComponentRegistry;

async function ctxOf(timeline: Timeline, overrides: EditOverrides = {}, files?: Record<string, PlanInputFile>, theme = 'editorial'): Promise<CheckContext> {
  const project = await loadProject('northfield-fixture', REPO);
  const template = await loadTemplate(theme, REPO);
  const plan: EditPlan = planEdit({ timeline, template, project, registry, captureFile: '/captures/capture.mp4', overrides, ...(files ? { files } : {}) });
  const record = { version: 1, id: `${timeline.scenario}-v1`, scenario: timeline.scenario, run_id: timeline.run_id, template: theme, status: 'succeeded', overrides, variant: plan.variant, plan } as unknown as RenderRecord;
  return {
    record,
    plan,
    timeline,
    rules: { ...DEFAULT_RULES },
    spans: segmentSpans(plan),
    transitions: transitionSpans(plan),
    clicks: outputClicks(plan, timeline),
    registry,
    measure: fontFileMeasurer(planFontFiles(plan)),
  };
}

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

describe('tutorial overlays in the review', () => {
  it('the fixture signup passes: every target in view, landscape and vertical', async () => {
    for (const variant of ['landscape', 'vertical'] as const) {
      const ctx = await ctxOf(load('signup-tutorial'), { variant });
      expect(ctx.plan.tutorial?.uses).toMatchObject({ spotlight: 3, steps: 3, loupe: 2, shortcuts: 4, progress: 1 });
      expect(checkTutorial(ctx)).toEqual([]);
    }
  });

  it('what the planner could not show is a warning, placed on the step', async () => {
    const t = load('signup-tutorial');
    delete t.events.find((e) => e.scene === 'signup' && e.step === 5)!.target;
    const ctx = await ctxOf(t);
    const f = checkTutorial(ctx).filter((x) => x.code === 'tutorial-skipped');
    expect(f.map((x) => x.message)).toContain('signup step 5: no steps overlay — no clicked target box was recorded');
    expect(f.every((x) => x.severity === 'warning' && x.at?.scene === 'signup')).toBe(true);
  });

  it('a spotlight or a badge that stays on its target after the page navigated away is reported', async () => {
    const ctx = await ctxOf(load('signup-tutorial'));
    const clip = ctx.plan.segments.find((s) => s.kind === 'clip' && s.overlays.some((o) => o.tutorial === 'steps' && s.urls.some((u) => u.frame > o.from && u.frame < o.from + o.durationInFrames))) as ClipSegment | undefined;
    expect(clip, 'a badge whose click navigates').toBeDefined();
    const badge = clip!.overlays.find((o) => o.tutorial === 'steps' && clip!.urls.some((u) => u.frame > o.from && u.frame < o.from + o.durationInFrames))!;
    // The planner ends it with the page (≈ 0.45 s after the click): clean. Kept 2 s longer, it rings a spot that is gone.
    expect(checkTutorial(ctx).filter((x) => x.code === 'tutorial-stale-target')).toEqual([]);
    badge.durationInFrames += 2 * ctx.plan.fps;
    const f = checkTutorial(ctx).filter((x) => x.code === 'tutorial-stale-target');
    expect(f).toHaveLength(1);
    // A local URL without a display URL is named by its path, never its host (L1.7: report.md shows no localhost).
    expect(f[0].message).toMatch(new RegExp(`^${clip!.id} step ${badge.step}: the step badge stays \\d\\.\\d s on its target after the page went to /[^ ]* \\(a local page\\)$`));
    // With the run's display URLs the check still sees the navigation, and names the display URL.
    const t = load('signup-tutorial');
    t.environment = { name: 'local', access: 'read-write', display: [{ page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' }] };
    const shown = await ctxOf(t);
    const c2 = shown.plan.segments.find((s) => s.id === clip!.id) as ClipSegment;
    c2.overlays.find((o) => o.tutorial === 'steps' && o.step === badge.step)!.durationInFrames += 2 * shown.plan.fps;
    const f2 = checkTutorial(shown).filter((x) => x.code === 'tutorial-stale-target');
    expect(f2).toHaveLength(1);
    expect(f2[0].message).toMatch(/after the page went to https:\/\/shop\.northfield\.example\//);
  });

  it('a target pushed out of the frame is reported', async () => {
    const t = load('signup-tutorial');
    // The Email field moved far below the page: its spotlight / loupe box leaves the visible capture.
    const ev = t.events.find((e) => e.scene === 'signup' && e.action === 'type' && e.step === 2)!;
    ev.target!.bbox = { ...ev.target!.bbox!, y: 5000 };
    const ctx = await ctxOf(t);
    expect(checkTutorial(ctx).some((x) => x.code === 'tutorial-target-cut' && /signup step/.test(x.message))).toBe(true);
  });

  it('the opening still is compared on the capture frames while the first spotlight comes in', async () => {
    const ctx = await ctxOf(load('signup-tutorial'));
    const span = ctx.spans.find((s) => s.segment.id === 'signup')!;
    const clip = span.segment as ClipSegment;
    const pair = stillPair(span, ctx.plan.fps)!;
    expect(pair).toBeDefined();
    expect(viewMoves(ctx.plan, clip, pair[0], pair[1])).toBe(false);
    expect(overlayDuring(clip, pair[0], pair[1])).toBe(true);
    expect(stillFromSource(ctx.plan, clip, pair[0], pair[1])).toBe(true);
    expect(stillSourceFrames(ctx.plan, ctx.spans, ctx.plan.fps)).toEqual(expect.arrayContaining([`main:${clip.srcFrames[pair[0] - clip.from]}`, `main:${clip.srcFrames[pair[1] - clip.from]}`]));
    // Without tutorial overlays the rendered frames are compared, as before.
    const off = await ctxOf(load('signup-tutorial'), { tutorial: false });
    const offSpan = off.spans.find((s) => s.segment.id === 'signup')!;
    const offPair = stillPair(offSpan, off.plan.fps)!;
    expect(stillFromSource(off.plan, offSpan.segment as ClipSegment, offPair[0], offPair[1])).toBe(false);
  });

  it('a scene-start glide: the opening still is compared from its end on (L5.1)', async () => {
    const t = load('signup-tutorial');
    const still = t.events.find((e) => e.scene === 'signup' && e.action === 'scene_still')!;
    const base = await ctxOf(t);
    const span0 = base.spans.find((s) => s.segment.id === 'signup')!;
    const pair0 = stillPair(span0, base.plan.fps, t)!;
    expect(stillGlideEnd(t, 'signup')).toBeUndefined(); // that run placed the cursor while the page loaded
    still.data = { cursor: { mode: 'auto', how: 'glide', from: { x: 100, y: 100 }, to: { x: 400, y: 300 }, move_ms: 450, t_settled: still.t_start + 0.5 } };
    expect(stillGlideEnd(t, 'signup')).toBeCloseTo(still.t_start + 0.8, 6);
    const ctx = await ctxOf(t);
    const span = ctx.spans.find((s) => s.segment.id === 'signup')!;
    const clip = span.segment as ClipSegment;
    const pair = stillPair(span, ctx.plan.fps, t)!;
    expect(pair[0]).toBeGreaterThan(pair0[0]);
    expect(clip.srcFrames[pair[0] - clip.from]).toBeGreaterThanOrEqual(Math.round((still.t_start + 0.8) * t.capture.fps));
    expect(pair[1]).toBe(pair0[1]);
    // The capture frames extracted for the comparison follow the shifted pair (this still is compared on them).
    expect(stillSourceFrames(ctx.plan, ctx.spans, ctx.plan.fps, t)).toContain(`main:${clip.srcFrames[pair[0] - clip.from]}`);
    // Runs before L5.1 have no t_settled: the end is estimated from the glide's lead and length; one cursor per page.
    still.data = { cursor: { desk: { how: 'keep' }, phone: { how: 'glide', move_ms: 450 } } };
    const lead = Math.min(0.3, 0.2 * (still.t_end - still.t_start));
    expect(stillGlideEnd(t, 'signup')).toBeCloseTo(still.t_start + lead + 0.45 + 0.3, 6);
  });

  it('so is the opening still under a caption drawn over the screen (motion theme)', async () => {
    const ctx = await ctxOf(load('highlights'), {}, CSV, 'motion');
    const span = ctx.spans.find((s) => s.segment.id === 'coffees')!;
    const clip = span.segment as ClipSegment;
    const pair = stillPair(span, ctx.plan.fps)!;
    expect(clip.caption?.params?.position).toBe('over');
    expect(overlayDuring(clip, pair[0], pair[1])).toBe(false);
    expect(captionOverDuring(clip, pair[0], pair[1])).toBe(true);
    expect(stillFromSource(ctx.plan, clip, pair[0], pair[1])).toBe(true);
  });
});

describe('story cards in the review', () => {
  it('the fixture highlights passes when its files are read', async () => {
    const ctx = await ctxOf(load('highlights'), {}, CSV);
    expect(checkTutorial(ctx)).toEqual([]);
  });

  it('a data file that could not be read is reported on its card', async () => {
    const ctx = await ctxOf(load('highlights'), {}, { 'data/quotes-per-month.csv': { file: '/p/data/quotes-per-month.csv', missing: true } });
    const f = checkTutorial(ctx).filter((x) => x.code === 'media-missing');
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/card chart: studio\/card-chart slot "data" \(data "data\/quotes-per-month\.csv"\) could not be resolved/);
    expect(f[0].at?.scene).toBe('chart');
  });

  it('your own file (L2.12) that could not be read is an error: nothing is shown', async () => {
    const t = load('highlights');
    t.scenes.find((s) => s.id === 'figure')!.card = { video: 'assets/gone.mp4' };
    const ctx = await ctxOf(t, {}, { ...CSV, 'assets/gone.mp4': { file: '/p/assets/gone.mp4', missing: true } });
    expect(ctx.plan.warnings).toContain('card "figure": file assets/gone.mp4 not found: nothing is shown');
    const f = checkTutorial(ctx).filter((x) => x.code === 'media-missing');
    expect(f).toEqual([expect.objectContaining({ severity: 'error', message: 'card figure: your file "assets/gone.mp4" could not be read — nothing is shown', at: expect.objectContaining({ scene: 'figure' }) })]);
  });

  it('an unknown capture and an unknown mark are reported too', async () => {
    const t = load('highlights');
    t.scenes.find((s) => s.id === 'figure')!.card!.slots!.capture = 'nope';
    t.scenes.find((s) => s.id === 'before-after')!.card!.slots!.after = 'mark:nope';
    const ctx = await ctxOf(t, {}, CSV);
    const f = checkTutorial(ctx).filter((x) => x.code === 'media-missing');
    expect(f.map((x) => x.at?.scene).sort()).toEqual(['before-after', 'figure']);
  });
});

describe('your own overlay files in the review (L2.12)', () => {
  const CHECK: Record<string, PlanInputFile> = {
    'assets/check.json': { file: '/p/assets/check.json', width: 240, height: 240, lottie: { version: '5.7.4', width: 240, height: 240, fps: 30, frames: 60, duration_s: 2, external_images: 0 } },
  };
  // A wide row near the top of the page, hovered on its right part, then clicked; a check badge asked at the top-right.
  const row = { desc: 'row', bbox: { x: 700, y: 120, w: 700, h: 60 } };
  const badgeTimeline = () =>
    synthTimeline({
      duration: 12,
      cursor: [[0, 960, 540], [2, 1250, 150]],
      entries: [
        {
          id: 's',
          t_start: 0,
          t_end: 12,
          open_end: 0.5,
          still: [0.5, 2],
          steps: [
            { action: 'hover', t_start: 2, t_end: 3, holdS: 2, point: { x: 1250, y: 150 }, target: row, overlay: { component: 'studio/lottie', slots: { file: 'assets/check.json' }, params: { fit: 'contain', background: 'none' }, box: { anchor: 'top-right', scale: 1.4 } } },
            { action: 'click', t_start: 6, t_end: 7, t_click: 6.5, point: { x: 1250, y: 150 }, target: row },
          ],
        },
      ],
    });

  it('a file placed at a corner over the hovered target is a warning; the planner’s corner choice keeps it clear', async () => {
    const clean = await ctxOf(badgeTimeline(), { variant: 'vertical' }, CHECK);
    expect(checkOverlayCover(clean)).toEqual([]);
    // Pinned back at the top-right of the vertical crop (what the planner moved it from): over the hovered row.
    const bad = await ctxOf(badgeTimeline(), { variant: 'vertical' }, CHECK);
    const o = (bad.plan.segments.find((s) => s.id === 's') as ClipSegment).overlays[0];
    expect(o.box?.anchor).not.toBe('top-right');
    o.box!.anchor = 'top-right';
    const f = checkOverlayCover(bad);
    expect(f).toEqual([expect.objectContaining({ severity: 'warning', code: 'overlay-covers-target', at: expect.objectContaining({ scene: 's', step: 0 }) })]);
    expect(f[0].message).toMatch(/^s: your Lottie overlay assets\/check\.json \(top-right\) of step 0 covers the hover target of step 0 \(row\) at /);
    // In landscape the top-right corner is clear of the row: no finding, nothing moved.
    const land = await ctxOf(badgeTimeline(), {}, CHECK);
    expect((land.plan.segments.find((s) => s.id === 's') as ClipSegment).overlays[0].box?.anchor).toBe('top-right');
    expect(checkOverlayCover(land)).toEqual([]);
  });
});
