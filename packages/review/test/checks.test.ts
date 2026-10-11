/**
 * The review's plan-level pieces without video: spans and transitions of the real fixture plans (catalogue, quote),
 * clicks placed on the output, the checks that need no pixels (the fixture plans pass them: captions fit, cursor in
 * view, no transition over a click, one zoom), caption widths with the theme's real font (measured against a
 * rendered frame), sampling helpers and the plan diff.
 */
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject, loadTemplate } from '@demo-studio/core';
import type { Timeline } from '@demo-studio/core';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { planEdit } from '@demo-studio/editor';
import type { ClipSegment, EditPlan, RenderRecord } from '@demo-studio/editor';
import {
  DEFAULT_RULES,
  buildOutputTimeline,
  checkCamera,
  checkCaptions,
  checkCursor,
  checkDurations,
  checkLongScenes,
  checkTextSlots,
  checkTransitionsOnClicks,
  diffRecords,
  fitCaption,
  fontFileMeasurer,
  keyframePlan,
  loadFontFace,
  outputClicks,
  outputFrameOf,
  planFontFiles,
  safeName,
  sampleFrames,
  segmentDurations,
  segmentSpans,
  timecode,
  transitionSpans,
} from '../src/index.js';
import type { CheckContext } from '../src/index.js';
import { realTimeline } from '../../editor/test/helpers.js';
import { REPO } from './helpers.js';

let registry: ComponentRegistry;
const plans: Record<string, { plan: EditPlan; timeline: Timeline; record: RenderRecord }> = {};

function ctxOf(name: 'catalogue' | 'quote'): CheckContext {
  const { plan, timeline, record } = plans[name];
  const spans = segmentSpans(plan);
  return {
    record,
    plan,
    timeline,
    rules: { ...DEFAULT_RULES },
    spans,
    transitions: transitionSpans(plan),
    clicks: outputClicks(plan, timeline),
    registry,
    measure: fontFileMeasurer(planFontFiles(plan)),
  };
}

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
  const project = await loadProject('northfield-fixture', REPO);
  const editorial = await loadTemplate('editorial', REPO);
  for (const name of ['catalogue', 'quote'] as const) {
    const timeline = realTimeline(name);
    const plan = planEdit({ timeline, template: editorial, project, registry, captureFile: '/captures/capture.mp4' });
    const record = { version: 1, id: `${name}-v1`, scenario: name, run_id: timeline.run_id, template: 'editorial', status: 'succeeded', overrides: {}, variant: 'landscape', plan } as unknown as RenderRecord;
    plans[name] = { plan, timeline, record };
  }
});

describe('spans of the fixture plans', () => {
  it('cover the video once, crossfades counted with the incoming segment', () => {
    const { plan } = plans.quote;
    const spans = segmentSpans(plan);
    expect(spans.map((s) => s.segment.id)).toEqual(['intro', 'discover', 'chapter-request', 'request', 'interstitial-3', 'proposal', 'outro']);
    expect(spans[0].from).toBe(0);
    for (let i = 1; i < spans.length; i++) expect(spans[i].from).toBe(spans[i - 1].to);
    expect(spans[spans.length - 1].to).toBe(plan.durationInFrames);
    // Every join is an 11-frame crossfade: a segment is fully visible 11 frames after it starts.
    for (const s of spans.slice(1)) expect(s.clearFrom).toBe(s.from + 11);
    const t = transitionSpans(plan);
    expect(t).toHaveLength(6);
    expect(t.every((x) => x.kind === 'crossfade' && x.to - x.from === 11)).toBe(true);
    const d = segmentDurations({ plan, spans });
    expect(d.reduce((a, x) => a + x.duration_s, 0)).toBeCloseTo(plan.durationInFrames / plan.fps, 2);
    expect(d.find((x) => x.id === 'request')).toMatchObject({ kind: 'clip', scene: 'request', speed: 1 });
  });

  it('places the clicks of the capture on the output, inside their clip and the capture rect', () => {
    const { plan, timeline } = plans.catalogue;
    const clicks = outputClicks(plan, timeline);
    expect(clicks.map((c) => `${c.scene}:${c.step}`)).toEqual([
      'import:0', 'import:1', 'import:2', 'import:3',
      'availability:1', 'availability:2', 'availability:3', 'availability:4', 'availability:5', 'availability:6',
      'add-product:0', 'add-product:1', 'add-product:2',
    ]);
    const spans = segmentSpans(plan);
    for (const c of clicks) {
      const s = spans.find((x) => x.segment.id === c.segment)!;
      expect(c.frame).toBeGreaterThanOrEqual(s.clearFrom);
      expect(c.frame).toBeLessThan(s.clearTo);
      const cap = plan.layout.capture;
      expect(c.screen!.x).toBeGreaterThan(cap.x);
      expect(c.screen!.x).toBeLessThan(cap.x + cap.w);
      expect(c.screen!.y).toBeGreaterThan(cap.y);
      expect(c.screen!.y).toBeLessThan(cap.y + cap.h);
    }
    // The first click of "import" (capture 3.25 s, the clip shows the capture from 1.033 s at 1×).
    const clip = plan.segments.find((x): x is ClipSegment => x.id === 'import')!;
    expect(outputFrameOf(clip, Math.round(3.25 * 30))).toBe(clicks[0].frame - clip.from);
    expect(clicks[0].frame).toBe(clip.from + 67);
  });

  it('builds the output-time timeline: segments, step spans, captions, markers, clicks', () => {
    const tl = buildOutputTimeline(plans.quote.record, plans.quote.timeline);
    expect(tl.segments.map((s) => s.kind)).toEqual(['intro', 'clip', 'card', 'clip', 'interstitial', 'clip', 'outro']);
    expect(tl.segments.find((s) => s.id === 'proposal')?.overlays).toEqual([
      expect.objectContaining({ component: expect.objectContaining({ id: 'studio/overlay-callout' }), scene: 'proposal', step: 3 }),
    ]);
    expect(tl.markers).toEqual([{ name: 'proposal', frame: 1372, time: 45.733, scene: 'proposal' }]);
    expect(tl.steps.every((s) => s.to > s.from && s.from_s === Math.round((s.from / 30) * 1000) / 1000)).toBe(true);
    expect(tl.captions).toHaveLength(3);
    expect(tl.duration_s).toBeCloseTo(56.267, 3);
  });
});

describe('plan checks on the fixture plans', () => {
  it('pass: captions fit at the theme size, cursor in view, no transition over a click, no overflowing slot', () => {
    for (const name of ['catalogue', 'quote'] as const) {
      const ctx = ctxOf(name);
      expect(checkCaptions(ctx), name).toEqual([]);
      expect(checkCursor(ctx), name).toEqual([]);
      expect(checkTransitionsOnClicks(ctx), name).toEqual([]);
      expect(checkTextSlots(ctx), name).toEqual([]);
      const durations = segmentDurations(ctx);
      expect(checkLongScenes(ctx, durations), name).toEqual([]);
      // 59.0 s and 56.3 s: a little under the 1–2 min target → info, not a warning.
      const length = checkDurations(ctx, durations).filter((f) => f.code === 'video-length');
      expect(length).toHaveLength(1);
      expect(length[0].severity).toBe('info');
    }
    const cam = checkCamera(ctxOf('catalogue'));
    expect(cam.map((f) => [f.severity, f.code])).toEqual([['info', 'zoom-not-slow']]);
    expect(cam[0].at).toMatchObject({ segment: 'add-product', scene: 'add-product', step: 5 });
    expect(checkCamera(ctxOf('quote'))).toEqual([]);
  });

  it('measures captions with the theme font: the longest catalogue caption is ≈ 1072 px at 38 px (as rendered)', () => {
    const ctx = ctxOf('catalogue');
    const clip = ctx.plan.segments.find((x): x is ClipSegment => x.id === 'add-product')!;
    const fit = fitCaption(ctx, clip, clip.cues[0].text)!;
    expect(clip.cues[0].text).toHaveLength(87);
    expect(fit.scale).toBe(1);
    // Ink width measured on frame 1500 of the catalogue render: 1072 px (advances include side bearings).
    expect(fit.width).toBeGreaterThan(1060);
    expect(fit.width).toBeLessThan(1095);
    const long = fitCaption(ctx, clip, `${clip.cues[0].text} ${clip.cues[0].text}`)!;
    expect(long.truncated).toBe(true);
    const shrunk = fitCaption(ctx, clip, `${clip.cues[0].text} Twelve more.`)!;
    expect(shrunk.scale).toBeLessThan(1);
    expect(shrunk.scale).toBeGreaterThan(0.85);
  });

  it('flags a caption overlapping another in time, and on the wrong scene', () => {
    const ctx = ctxOf('quote');
    const plan = structuredClone(ctx.plan);
    const req = plan.segments.find((x): x is ClipSegment => x.id === 'request')!;
    req.cues.push({ from: 100, to: 200, text: 'An extra line.', scene: 'request' });
    plan.captions[0] = { ...plan.captions[0], to: plan.captions[1].from + 40 };
    const findings = checkCaptions({ ...ctx, plan, spans: segmentSpans(plan), transitions: transitionSpans(plan) });
    expect(findings.filter((f) => f.code === 'caption-overlap').map((f) => f.at?.segment)).toEqual(['request', 'request']);
    expect(findings.some((f) => f.code === 'caption-scene-mismatch' && f.message.includes('stays'))).toBe(true);
  });

  it('flags a zoom reset at a same-page join', () => {
    const ctx = ctxOf('catalogue');
    const plan = structuredClone(ctx.plan);
    const [a, b] = plan.segments.filter((x): x is ClipSegment => x.kind === 'clip');
    // Pretend the two first clips are a same-page join whose camera jumps from 1.3× to 1×.
    delete b.transition;
    a.camera = a.srcFrames.map(() => [1.3, 900, 500]);
    const f = checkCamera({ ...ctx, plan, spans: segmentSpans(plan), transitions: transitionSpans(plan) });
    expect(f.find((x) => x.code === 'zoom-reset')).toMatchObject({ severity: 'warning', at: { segment: b.id } });
  });
});

describe('helpers', () => {
  it('fonts: real advances, the estimate for unknown families, null for unreadable files', async () => {
    const files = planFontFiles(plans.catalogue.plan);
    expect(files.map((f) => f.weight).sort()).toEqual([400, 400, 600, 700]);
    const m = fontFileMeasurer(files);
    const body = files.find((f) => f.weight === 600)!.family;
    expect(m.measured({ family: body, size: 15, weight: 600 })).toBe(true);
    expect(m.measured({ family: 'Nope', size: 15 })).toBe(false);
    const w = m('CATALOGUE IMPORT', { family: body, size: 15, weight: 600, letterSpacing: 0.14 });
    expect(w).toBeGreaterThan(150);
    expect(w).toBeLessThan(220);
    const bad = join(tmpdir(), `not-a-font-${process.pid}.ttf`);
    await writeFile(bad, 'nope');
    expect(loadFontFace(bad)).toBeNull();
  });

  it('samples, key frames, names and timecodes', () => {
    expect(sampleFrames(0, 90, 30, 1)).toEqual([15, 45, 75]);
    expect(sampleFrames(100, 160, 30, 2)).toEqual([107, 122, 137, 152]);
    expect(sampleFrames(10, 12, 30, 1)).toEqual([10]);
    const spans = segmentSpans(plans.quote.plan);
    const k = keyframePlan(spans, plans.quote.plan.markers, plans.quote.plan.durationInFrames);
    expect([...k.keys()]).toEqual([
      'proposal', 'intro-hold', 'discover-first', 'discover-last', 'chapter-request-first', 'chapter-request-last',
      'request-first', 'request-last', 'interstitial-3-first', 'interstitial-3-last', 'proposal-first', 'proposal-last', 'outro-hold',
    ]);
    expect(k.get('discover-first')).toBe(85 + 11);
    expect(k.get('discover-last')).toBe(319);
    expect(safeName('Total: €720 / VAT')).toBe('Total-720-VAT');
    expect(timecode(65.25)).toBe('01:05.3');
    expect(timecode(5)).toBe('00:05.0');
  });

  it('diffs two plans by segment', () => {
    const a = plans.quote.record;
    const b = structuredClone(a);
    b.id = 'quote-v2';
    const s = b.plan.segments.find((x): x is ClipSegment => x.id === 'discover')!;
    s.caption = { ...s.caption!, id: 'studio/caption-overlay' };
    b.plan.segments.find((x) => x.id === 'outro')!.component.params = { logo_size: 120 };
    const d = diffRecords(a, b);
    expect(d.previous).toBe('quote-v1');
    expect(d.duration_s.delta).toBe(0);
    expect(d.segments.filter((x) => x.status === 'changed').map((x) => [x.id, x.changes])).toEqual([
      ['discover', ['caption: studio/caption-below → studio/caption-overlay']],
      ['outro', ['component params of studio/outro-stack']],
    ]);
  });
});
