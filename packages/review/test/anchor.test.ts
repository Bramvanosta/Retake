/**
 * The anchor of a frame comment (L3.6, review frameAnchor), without video: a synthetic timeline planned with the real
 * planner and editorial theme (intro, a step with an id, a card, a 2 ms marked `wait_for` with a callout — the fixture's
 * exact shape —, an interstitial, crossfades, outro), and the real fixture timelines of quote (the `proposal` marker)
 * and live-quote (a split: the acting page).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject, loadTemplate, parseScenario, stepFingerprint } from '@retake/core';
import type { Scene, Timeline } from '@retake/core';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { brandmarkRect, planEdit } from '@retake/editor';
import type { ClipSegment, EditOverrides, EditPlan } from '@retake/editor';
import { captionRegion, frameAnchor, segmentSpans, transitionSpans } from '../src/index.js';
import { REPO, synthTimeline } from './helpers.js';

const FIXTURES = join(REPO, 'packages/editor/test/fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
let registry: ComponentRegistry;

async function planOf(timeline: Timeline, overrides: EditOverrides = {}, theme = 'editorial'): Promise<EditPlan> {
  const project = await loadProject('northfield-fixture', REPO);
  const template = await loadTemplate(theme, REPO);
  return planEdit({ timeline, template, project, registry, captureFile: '/captures/capture.mp4', overrides });
}
const clipOf = (p: EditPlan, id: string) => p.segments.find((s) => s.id === id) as ClipSegment;
/** A region (0..1) centred on output point (x, y), 2 % of the frame each way. */
const regionAt = (p: EditPlan, x: number, y: number) => ({ x: x / p.width - 0.01, y: y / p.height - 0.01, w: 0.02, h: 0.02 });

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

/** s1: a click with an id; a card; s2: a click, a 2 ms marked wait_for with a callout, a hover, a hold; an interstitial; s3. */
function synthetic(): Timeline {
  const callout = { component: 'studio/overlay-callout', slots: { text: 'Total' }, params: {}, duration: 2, bbox: { x: 1200, y: 400, w: 200, h: 60 } };
  return synthTimeline({
    duration: 18,
    entries: [
      {
        id: 's1', t_start: 0, t_end: 6, open_end: 0.5, still: [0.5, 2], caption: { text: 'Scene one' },
        steps: [
          { action: 'click', id: 'go', t_start: 2.2, t_end: 3.2, t_click: 2.7, point: { x: 960, y: 540 }, target: { desc: 'button "Go"', bbox: { x: 900, y: 520, w: 120, h: 40 } } },
          { action: 'hold', t_start: 3.3, t_end: 5.95 },
        ],
      },
      { card: { id: 'chapter-two', slots: { title: 'Part two' } } },
      {
        id: 's2', t_start: 6, t_end: 13, open_end: 6.5, still: [6.5, 8], caption: { text: 'Scene two' },
        steps: [
          { action: 'click', t_start: 8.1, t_end: 9, t_click: 8.6, point: { x: 700, y: 500 }, target: { desc: 'button "Send"', bbox: { x: 650, y: 480, w: 100, h: 40 } } },
          // 9.11 s = capture frame 273.3: the wait lasts 2 ms and starts between two frames, as the fixture's.
          { action: 'wait_for', t_start: 9.11, t_end: 9.112, mark: 'ready', overlay: callout },
          { action: 'hover', t_start: 9.113, t_end: 10.2, point: { x: 1300, y: 430 }, target: { desc: 'button "Accept"', bbox: { x: 1250, y: 410, w: 100, h: 40 } } },
          { action: 'hold', t_start: 10.3, t_end: 12.95 },
        ],
      },
      { interstitial: { id: 'later', text: 'Later' } },
      { id: 's3', t_start: 13, t_end: 18, open_end: 13.5, still: [13.5, 15], caption: { text: 'Scene three' }, steps: [{ action: 'hold', t_start: 15.1, t_end: 17.95 }] },
    ],
  });
}

const SCENARIO = [
  'scenes:',
  '  - id: s1',
  '    steps:',
  '      - click: Go',
  '        id: go',
  '      - hold: 2.6',
  '  - card: {id: chapter-two, title: Part two}',
  '  - id: s2',
  '    steps:',
  '      - click: Send',
  '      - wait_for: Proposal ready',
  '        mark: ready',
  '        overlay: {component: studio/overlay-callout, slots: {text: Total}}',
  '      - hover: Accept',
  '      - hold: 2.6',
].join('\n');

describe('frameAnchor on a synthetic plan', () => {
  let p: EditPlan;
  let tl: Timeline;
  beforeAll(async () => {
    tl = synthetic();
    p = await planOf(tl);
  });

  it('plans the expected segments with crossfades (the test basis)', () => {
    expect(p.segments.map((s) => `${s.kind}:${s.id}`)).toEqual(['intro:intro', 'clip:s1', 'card:chapter-two', 'clip:s2', 'interstitial:later', 'clip:s3', 'outro:outro']);
    expect(p.markers).toEqual([expect.objectContaining({ name: 'ready', scene: 's2', step: 1, action: 'wait_for' })]);
  });

  it('intro, card, interstitial, outro and the last frame: segment id, kind, component, nothing of a scene', () => {
    const at = (id: string) => segmentSpans(p).find((s) => s.segment.id === id)!;
    const mid = (id: string) => Math.floor((at(id).clearFrom + at(id).clearTo) / 2);
    expect(frameAnchor(p, 0)).toEqual({ segment: 'intro', kind: 'intro', component: 'studio/intro-stack' });
    expect(frameAnchor(p, mid('chapter-two'))).toEqual({ segment: 'chapter-two', kind: 'card', component: 'studio/card-title' });
    expect(frameAnchor(p, mid('later'))).toEqual({ segment: 'later', kind: 'interstitial', component: 'studio/interstitial-clock' });
    expect(frameAnchor(p, p.durationInFrames - 1)).toEqual({ segment: 'outro', kind: 'outro', component: 'studio/outro-stack' });
    expect(frameAnchor(p, mid('later'), { region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }).area).toBe('card');
  });

  it('the first frames of a clip: the opening still, no step; inside the crossfade: the incoming clip + the transition', () => {
    const s1 = clipOf(p, 's1');
    const t = transitionSpans(p).find((x) => x.after === 's1')!;
    expect(t.from).toBe(s1.from);
    const a = frameAnchor(p, s1.from);
    expect(a).toMatchObject({ segment: 's1', kind: 'clip', component: 'studio/layout-card', scene: 's1', action: 'scene_still', transition: { kind: 'crossfade', from: 'intro', to: 's1' } });
    expect(a).not.toHaveProperty('step');
    expect(a.src_time_s).toBeCloseTo(s1.srcFrames[0] / 30, 3);
    // Past the crossfade: no transition.
    expect(frameAnchor(p, t.to + 1)).not.toHaveProperty('transition');
  });

  it('a step with an id: index, id, ref, fingerprint from the snapshot; its held frames still belong to it', () => {
    const s1 = clipOf(p, 's1');
    const click = s1.steps.find((x) => x.step === 0)!;
    const a = frameAnchor(p, s1.from + click.from + 2, { scenarioText: SCENARIO });
    expect(a).toMatchObject({ scene: 's1', step: 0, step_id: 'go', step_ref: 's1.go', action: 'click', step_fp: stepFingerprint({ click: 'Go' }), step_fp_n: 0 });
    // The hold step after it, to the clip's last visible frame (its held frames, the crossfade into the card): the hold.
    const span = segmentSpans(p).find((x) => x.segment.id === 's1')!;
    expect(s1.from + s1.durationInFrames).toBeGreaterThan(span.to);
    const last = frameAnchor(p, span.to - 1, { scenarioText: SCENARIO });
    expect(last).toMatchObject({ scene: 's1', step: 1, step_ref: 's1.1', action: 'hold', step_fp: stepFingerprint({ hold: 2.6 }) });
    expect(last).not.toHaveProperty('step_id');
    // Without a snapshot: no fingerprint.
    expect(frameAnchor(p, s1.from + click.from + 2)).not.toHaveProperty('step_fp');
  });

  it('a 2 ms marked wait owns no frame; its marker window names it, with the marker and the callout on screen', () => {
    const s2 = clipOf(p, 's2');
    const mk = p.markers[0];
    expect(s2.steps.some((x) => x.step === 1)).toBe(false);
    for (const f of [mk.frame, Math.floor((mk.frame + mk.done!) / 2), mk.done!]) {
      const a = frameAnchor(p, f, { scenarioText: SCENARIO });
      expect(a, `frame ${f}`).toMatchObject({ scene: 's2', step: 1, step_ref: 's2.1', action: 'wait_for', marker: 'ready', step_fp: stepFingerprint({ wait_for: 'Proposal ready' }) });
    }
    // The callout shows from the end of the step: on screen at `done`.
    expect(frameAnchor(p, mk.done!).overlays).toEqual(['studio/overlay-callout']);
    // After the window: the step that plays there (the hover), no marker.
    const after = frameAnchor(p, mk.done! + 1);
    expect(after).toMatchObject({ step: 2, action: 'hover' });
    expect(after).not.toHaveProperty('marker');
    // Before it: the click.
    expect(frameAnchor(p, mk.frame - 1)).toMatchObject({ step: 0, action: 'click' });
  });

  it('a plan made before L3.6 (markers without a step): the marked step comes from the run timeline', () => {
    const old: EditPlan = { ...p, markers: p.markers.map(({ step: _s, step_id: _i, action: _a, ...m }) => m) };
    const mk = old.markers[0];
    expect(frameAnchor(old, mk.done!, { timeline: tl })).toMatchObject({ step: 1, action: 'wait_for', marker: 'ready' });
    // Without the timeline: the marker is named, the step is the one playing (the hover after the wait).
    expect(frameAnchor(old, mk.done!)).toMatchObject({ step: 2, action: 'hover', marker: 'ready' });
  });

  it('a region on the caption while a cue shows names the caption component; on the brand mark: area brandmark; else screen', () => {
    const s2 = clipOf(p, 's2');
    const f = s2.from + Math.floor(s2.durationInFrames / 2);
    const cap = s2.layout.caption!;
    const onCap = frameAnchor(p, f, { region: regionAt(p, cap.x + cap.w / 2, cap.y + cap.h / 2) });
    expect(onCap).toMatchObject({ area: 'caption', component: s2.caption!.id });
    expect(onCap.component).toMatch(/^studio\/caption-/);
    const bm = brandmarkRect(p, s2.layout.brandmark, p.brand.brandmark?.position)?.rect;
    expect(bm).toBeDefined();
    expect(frameAnchor(p, f, { region: regionAt(p, bm!.x + bm!.w / 2, bm!.y + bm!.h / 2) })).toMatchObject({ area: 'brandmark', component: 'studio/layout-card' });
    const c = s2.layout.capture;
    expect(frameAnchor(p, f, { region: regionAt(p, c.x + c.w / 2, c.y + c.h / 2) })).toMatchObject({ area: 'screen', component: 'studio/layout-card' });
    // No cue on screen (the caption draws nothing): the same region is the screen.
    const noCue = structuredClone(p);
    clipOf(noCue, 's2').cues = [];
    expect(frameAnchor(noCue, f, { region: regionAt(p, cap.x + cap.w / 2, cap.y + cap.h / 2) })).toMatchObject({ area: 'screen', component: 'studio/layout-card' });
  });

  it('an overlay is on screen from its first frame to the one before its end (the end is exclusive)', () => {
    const s2 = clipOf(p, 's2');
    const o = s2.overlays.find((x) => x.component.id === 'studio/overlay-callout')!;
    const end = s2.from + o.from + o.durationInFrames;
    const span = segmentSpans(p).find((x) => x.segment.id === 's2')!;
    expect(end).toBeLessThan(span.to);
    expect(frameAnchor(p, end - 1).overlays).toEqual(['studio/overlay-callout']);
    expect(frameAnchor(p, end)).not.toHaveProperty('overlays');
    expect(frameAnchor(p, s2.from + o.from).overlays).toEqual(['studio/overlay-callout']);
    expect(frameAnchor(p, s2.from + o.from - 1)).not.toHaveProperty('overlays');
  });

  it('refuses a frame that is not one of the render', () => {
    expect(() => frameAnchor(p, p.durationInFrames)).toThrow(RangeError);
    expect(() => frameAnchor(p, -1)).toThrow(/not a frame of the render/);
    expect(() => frameAnchor(p, 1.5)).toThrow(RangeError);
  });
});

describe('frameAnchor with the motion theme: the caption is a band over the screen, no brand mark', () => {
  let p: EditPlan;
  beforeAll(async () => {
    p = await planOf(synthetic(), {}, 'motion');
  });

  it('a region on the band (while a cue shows) is the caption overlay; on the layout\'s caption area, the screen', () => {
    const s2 = clipOf(p, 's2');
    expect(s2.caption).toMatchObject({ id: 'studio/caption-overlay', params: { position: 'over' } });
    const span = segmentSpans(p).find((x) => x.segment.id === 's2')!;
    const cue = s2.cues[0];
    const f = Math.max(s2.from + cue.from, span.clearFrom) + 2;
    expect(f - s2.from).toBeLessThan(cue.to);
    const band = captionRegion(p, s2)!;
    expect(band.over).toBe(true);
    const b = band.rect;
    expect(frameAnchor(p, f, { region: regionAt(p, b.x + b.w / 2, b.y + b.h / 2) })).toMatchObject({ area: 'caption', component: 'studio/caption-overlay' });
    // The layout's caption area lies off the band: nothing of the caption is drawn there.
    const cap = s2.layout.caption!;
    const cx = cap.x + cap.w / 2;
    const cy = cap.y + cap.h / 2;
    expect(cx >= b.x && cx < b.x + b.w && cy >= b.y && cy < b.y + b.h).toBe(false);
    expect(frameAnchor(p, f, { region: regionAt(p, cx, cy) }).area).toBe('screen');
  });

  it('brand mark position none: its layout rect is not a brand mark', () => {
    const s2 = clipOf(p, 's2');
    expect(p.brand.brandmark?.position).toBe('none');
    expect(brandmarkRect(p, s2.layout.brandmark, p.brand.brandmark?.position)).toBeUndefined();
    const r = s2.layout.brandmark!;
    const f = s2.from + Math.floor(s2.durationInFrames / 2);
    expect(frameAnchor(p, f, { region: regionAt(p, r.x + r.w / 2, r.y + r.h / 2) }).area).not.toBe('brandmark');
  });
});

describe('frameAnchor on the real fixture timelines', () => {
  it('quote: the proposal marker names the marked wait_for (not the hover after it), with the callout on screen', async () => {
    const tl = load('quote');
    const p = await planOf(tl);
    const text = readFileSync(join(REPO, 'projects/northfield-fixture/scenarios/quote.yaml'), 'utf8');
    const mk = p.markers.find((m) => m.name === 'proposal')!;
    for (const f of [mk.frame, mk.done!]) {
      const a = frameAnchor(p, f, { scenarioText: text, region: { x: 0.67, y: 0.42, w: 0.12, h: 0.08 } });
      expect(a, `frame ${f}`).toMatchObject({ segment: 'proposal', kind: 'clip', component: 'studio/layout-card', area: 'screen', scene: 'proposal', step: 3, step_ref: 'proposal.3', action: 'wait_for', marker: 'proposal' });
      expect(a.step_fp).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(frameAnchor(p, mk.done!).overlays).toEqual(['studio/overlay-callout']);
    // The fingerprint is the snapshot's marked step's.
    const sc = parseScenario(text).scenario!;
    const step = (sc.scenes.find((s) => 'id' in s && s.id === 'proposal') as Scene).steps![3];
    expect(step).toMatchObject({ wait_for: expect.anything(), mark: 'proposal' });
    expect(frameAnchor(p, mk.done!, { scenarioText: text }).step_fp).toBe(stepFingerprint(step));
  });

  it('live-quote (a split): the acting page at the frame', async () => {
    const p = await planOf(load('live-quote'));
    // arrives: the buyer's page acts on its first frame, then the supplier's; proposal: the other way round.
    const arrives = clipOf(p, 'arrives');
    const proposal = clipOf(p, 'proposal');
    expect(arrives.panes!.map((x) => x.page)).toEqual(['buyer', 'supplier']);
    expect(frameAnchor(p, arrives.from).page).toBe('buyer');
    expect(frameAnchor(p, arrives.from + 20).page).toBe('supplier');
    expect(frameAnchor(p, proposal.from).page).toBe('supplier');
    expect(frameAnchor(p, proposal.from + 20)).toMatchObject({ scene: 'proposal', page: 'buyer' });
    // A single-page clip names no page.
    const single = await planOf(load('quote'));
    expect(frameAnchor(single, clipOf(single, 'proposal').from + 20)).not.toHaveProperty('page');
  });

});
