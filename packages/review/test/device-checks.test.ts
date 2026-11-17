/**
 * A device's take (an iOS simulator's timeline: 402×874 pt at 3, one page segment of the environment without a URL,
 * touches that appear and leave where they land, ripples) through the planner and every check that needs no pixels:
 * nothing a browser alone would cause is found (an address, a cursor that glides, a page load).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import type { LoadedProject, LoadedTemplate, Timeline } from '@retake/core';
import { planEdit } from '@retake/editor/plan';
import type { RenderRecord } from '@retake/editor/plan';
import {
  checkArtefactOrder,
  checkButtonContrast,
  checkCamera,
  checkCaptionContradictions,
  checkCaptions,
  checkCursor,
  checkDurations,
  checkEnvironment,
  checkLoadingFilmed,
  checkLongScenes,
  checkOverlayCover,
  checkOverlaysKept,
  checkRender,
  checkSlowTransitions,
  checkTextSlots,
  checkTransitionsOnClicks,
  checkTutorial,
  checkZoomScroll,
  planFontFiles,
  segmentDurations,
} from '../src/checks.js';
import type { CheckContext } from '../src/checks.js';
import { DEFAULT_RULES } from '../src/types.js';
import { outputClicks } from '../src/timeline.js';
import { segmentSpans, transitionSpans } from '../src/spans.js';
import { fontFileMeasurer } from '../src/fonts.js';
import { REPO } from '@retake/test-support/repo';
import { deviceTimeline, fixtureProject, template } from '@retake/test-support/timeline';

let registry: ComponentRegistry;
let project: LoadedProject;
let editorial: LoadedTemplate;

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
  project = await fixtureProject();
  editorial = await template('editorial');
});

function context(timeline: Timeline): CheckContext {
  const plan = planEdit({ timeline, template: editorial, project, registry, captureFile: '/captures/capture.mp4' });
  const record = {
    version: 1,
    id: 'buyer-v1',
    scenario: 'buyer',
    run_id: timeline.run_id,
    template: 'editorial',
    status: 'succeeded',
    overrides: {},
    variant: 'landscape',
    plan,
  } as unknown as RenderRecord;
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

describe("a device's take through the plan and the pure checks", () => {
  it('plans with no warning and finds nothing but its length', () => {
    const ctx = context(deviceTimeline());
    expect(ctx.plan.warnings).toEqual([]);
    // The two taps are clicks of the output, inside the clip.
    expect(ctx.clicks).toHaveLength(2);
    const durations = segmentDurations(ctx);
    const findings = [
      ...checkRender(ctx),
      ...checkDurations(ctx, durations),
      ...checkLongScenes(ctx, durations),
      ...checkCaptions(ctx),
      ...checkTextSlots(ctx),
      ...checkLoadingFilmed(ctx),
      ...checkZoomScroll(ctx),
      ...checkCaptionContradictions(ctx),
      ...checkOverlaysKept(ctx),
      ...checkButtonContrast(ctx),
      ...checkCursor(ctx),
      ...checkCamera(ctx),
      ...checkTransitionsOnClicks(ctx),
      ...checkTutorial(ctx),
      ...checkOverlayCover(ctx),
      ...checkEnvironment(ctx),
      ...checkArtefactOrder(ctx),
      ...checkSlowTransitions(ctx),
    ];
    // A short take is short (the reference look's length rule, the same for any capture); nothing else.
    expect(findings.filter((f) => f.code !== 'video-length').map((f) => `${f.severity} ${f.code}: ${f.message}`)).toEqual([]);
    expect(findings.map((f) => f.code)).toEqual(['video-length']);
  });
});
