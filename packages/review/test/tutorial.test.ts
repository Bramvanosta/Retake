/**
 * L2.10 review awareness, without video: what the planner could not show (`tutorial-skipped`), tutorial targets cut by
 * the framing (`tutorial-target-cut`), story-card media that could not be resolved (`media-missing`), and the opening
 * still of a scene compared on its capture frames while an overlay comes in (the spotlight of the first step dims the
 * whole screen) — on the real fixture timelines of `signup` (tutorial on) and `highlights` (every story card).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject, loadTemplate } from '@demo-studio/core';
import type { Timeline } from '@demo-studio/core';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { planEdit } from '@demo-studio/editor';
import type { ClipSegment, EditOverrides, EditPlan, PlanInputFile, RenderRecord } from '@demo-studio/editor';
import { DEFAULT_RULES, captionOverDuring, checkTutorial, fontFileMeasurer, outputClicks, overlayDuring, planFontFiles, segmentSpans, stillFromSource, stillPair, stillSourceFrames, transitionSpans, viewMoves } from '../src/index.js';
import type { CheckContext } from '../src/index.js';
import { REPO } from './helpers.js';

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
      expect(ctx.plan.tutorial?.uses).toMatchObject({ spotlight: 2, steps: 3, loupe: 2, shortcuts: 4, progress: 1 });
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
    expect(stillSourceFrames(ctx.plan, ctx.spans, ctx.plan.fps)).toEqual(expect.arrayContaining([clip.srcFrames[pair[0] - clip.from], clip.srcFrames[pair[1] - clip.from]]));
    // Without tutorial overlays the rendered frames are compared, as before.
    const off = await ctxOf(load('signup-tutorial'), { tutorial: false });
    const offSpan = off.spans.find((s) => s.segment.id === 'signup')!;
    const offPair = stillPair(offSpan, off.plan.fps)!;
    expect(stillFromSource(off.plan, offSpan.segment as ClipSegment, offPair[0], offPair[1])).toBe(false);
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

  it('an unknown capture and an unknown mark are reported too', async () => {
    const t = load('highlights');
    t.scenes.find((s) => s.id === 'figure')!.card!.slots!.capture = 'nope';
    t.scenes.find((s) => s.id === 'before-after')!.card!.slots!.after = 'mark:nope';
    const ctx = await ctxOf(t, {}, CSV);
    const f = checkTutorial(ctx).filter((x) => x.code === 'media-missing');
    expect(f.map((x) => x.at?.scene).sort()).toEqual(['before-after', 'figure']);
  });
});
