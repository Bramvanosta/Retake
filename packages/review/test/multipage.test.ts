/**
 * L2.11 review awareness, without video: clicks of a multi-page clip land on their page's pane (each page with its own
 * cursor), the cursor / tutorial checks run per pane, and `overlay-covers-target` warns when key caps, a step badge, a
 * loupe or the picture-in-picture inset covers a click target of the current or next step — on the real fixture
 * timelines of live-quote (split), phone-and-desktop (pip) and signup (tutorial overlays).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject, loadTemplate, fileFacts } from '@retake/core/io';
import type { Timeline } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { insetRectAt, mapPaneRect, planEdit } from '@retake/editor/plan';
import type { ClipSegment, EditOverrides, EditPlan, RenderRecord } from '@retake/editor/plan';
import { DEFAULT_RULES, checkCursor, checkOverlayCover, checkTutorial, fontFileMeasurer, outputClicks, planFontFiles, segmentSpans, transitionSpans } from '../src/index.js';
import type { CheckContext } from '../src/index.js';
import { REPO } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

const FIXTURES = join(REPO, 'packages/editor/test/fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
let registry: ComponentRegistry;

async function ctxOf(timeline: Timeline, overrides: EditOverrides = {}, theme = 'editorial', edit?: (plan: EditPlan) => void): Promise<CheckContext> {
  const project = await loadProject('northfield-fixture', REPO);
  const template = await loadTemplate(theme, REPO, { files: fileFacts(PERSON_POLICY) });
  const plan: EditPlan = planEdit({ timeline, template, project, registry, captureFile: '/captures/capture.mp4', overrides });
  edit?.(plan);
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
const clipOf = (p: EditPlan, id: string) => p.segments.find((s) => s.id === id) as ClipSegment;
const inside = (pt: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) => pt.x >= r.x && pt.y >= r.y && pt.x <= r.x + r.w && pt.y <= r.y + r.h;

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

describe('multi-page clips in the review (L2.11)', () => {
  it('each click lands on its page’s pane; the fixture split and pip pass the cursor, tutorial and cover checks', async () => {
    for (const [name, variant, theme] of [
      ['live-quote', 'landscape', 'editorial'],
      ['live-quote', 'landscape', 'motion'],
      ['live-quote', 'vertical', 'editorial'],
      ['phone-and-desktop', 'landscape', 'editorial'],
      ['phone-and-desktop', 'landscape', 'motion'],
      ['phone-and-desktop', 'vertical', 'motion'],
    ] as const) {
      const ctx = await ctxOf(load(name), { variant }, theme);
      const where = `${name} ${variant} ${theme}`;
      const multi = ctx.clicks.filter((c) => c.pane !== undefined);
      expect(multi.length, where).toBeGreaterThan(5);
      for (const c of multi) {
        const clip = clipOf(ctx.plan, c.segment);
        const rel = c.frame - clip.from;
        const cap = clip.inset?.pane === c.pane ? insetRectAt(clip, rel, ctx.plan.fps)! : clip.panes![c.pane!].layout.capture;
        expect(clip.panes![c.pane!].page, where).toBe(c.page);
        expect(c.screen && inside(c.screen, { x: cap.x - 1, y: cap.y - 1, w: cap.w + 2, h: cap.h + 2 }), `${where} ${c.segment} step ${c.step} on ${c.page}: ${JSON.stringify(c.screen)} outside ${JSON.stringify(cap)}`).toBe(true);
      }
      expect(checkOverlayCover(ctx), where).toEqual([]);
      expect(checkTutorial(ctx).filter((f) => f.severity !== 'info'), where).toEqual([]);
      // A whole table row (1342 px) cannot fit a 4:5 reframe of the desk: the reframe shows its leading part (the
      // request's id, its "New" pill, the coffee) with the click — an info, not a warning.
      const cursor = checkCursor(ctx);
      expect(cursor.filter((f) => f.severity !== 'info'), where).toEqual([]);
      if (name === 'phone-and-desktop' && variant === 'vertical') {
        expect(cursor.some((f) => f.code === 'target-outside-view' && /desk/.test(f.message) && /its leading part and the click are shown/.test(f.message)), where).toBe(true);
      }
    }
    // The supplier's clicks are on the right-hand pane of the split.
    const lq = await ctxOf(load('live-quote'));
    const supplier = lq.clicks.filter((c) => c.page === 'supplier');
    expect(supplier.length).toBeGreaterThan(0);
    expect(supplier.every((c) => c.pane === 1 && c.screen!.x > 960)).toBe(true);
  });

  it('a picture-in-picture inset over a click target of the main page is a warning', async () => {
    const t = load('phone-and-desktop');
    const ctx = await ctxOf(t, {}, 'editorial', (plan) => {
      // Pin the inset over the row the desk clicks.
      const clip = clipOf(plan, 'desk');
      const ev = t.events.find((e) => e.scene === 'desk' && e.action === 'click')!;
      const f = clip.srcFrames.findIndex((s) => s >= Math.round(ev.t_click! * plan.fps));
      const at = mapPaneRect(plan, clip, 0, f, ev.point!);
      const r = clip.inset!.track[0].rect;
      clip.inset!.track = [{ at: 0, corner: 'top-left', rect: { x: at.x - r.w / 2, y: at.y - r.h / 2, w: r.w, h: r.h } }];
    });
    const f = checkOverlayCover(ctx);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]).toMatchObject({ severity: 'warning', code: 'overlay-covers-target' });
    expect(f[0].message).toMatch(/^desk: the picture-in-picture inset \(page phone\) covers the click of step \d+ on page desk/);
    expect(f[0].at?.scene).toBe('desk');
  });

  it('key caps over the next click target are a warning; the planner’s slot choice keeps them clear (signup, motion)', async () => {
    const clean = await ctxOf(load('signup-tutorial'), {}, 'motion');
    expect(checkOverlayCover(clean)).toEqual([]);
    // Without the targets to clear, the second Tab's caps stay in their bottom row, over the submit button.
    const bad = await ctxOf(load('signup-tutorial'), {}, 'motion', (plan) => {
      for (const o of clipOf(plan, 'signup').overlays) if (o.tutorial === 'shortcuts') delete o.clear;
    });
    const f = checkOverlayCover(bad);
    expect(f.length).toBeGreaterThan(0);
    expect(f.some((x) => /signup: the key caps of step \d+ covers the click of step \d+/.test(x.message))).toBe(true);
  });
});
