/**
 * The review's plan-level pieces without video: spans and transitions of the real fixture plans (catalogue, quote),
 * clicks placed on the output, the checks that need no pixels (the fixture plans pass them: captions fit, cursor in
 * view, no transition over a click, one zoom), caption widths with the theme's real font (measured against a
 * rendered frame), sampling helpers and the plan diff.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject, loadTemplate } from '@demo-studio/core';
import type { LoadedProject, LoadedTemplate, Timeline, TimelineEnvironment } from '@demo-studio/core';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { planEdit } from '@demo-studio/editor';
import type { CardSegment, ClipSegment, EditOverrides, EditPlan, RenderRecord } from '@demo-studio/editor';
import {
  DEFAULT_RULES,
  buildOutputTimeline,
  captionRegion,
  checkArtefactOrder,
  checkCamera,
  checkCaptions,
  checkCursor,
  checkDurations,
  checkEnvironment,
  checkRender,
  checkSlowTransitions,
  checkLongScenes,
  checkTextSlots,
  checkTransitionsOnClicks,
  diffRecords,
  environmentLine,
  fitCaption,
  fontFileMeasurer,
  keyframePlan,
  loadFontFace,
  outputClicks,
  outputFrameOf,
  planFontFiles,
  reviewEnvironment,
  reviewRules,
  safeName,
  sampleFrames,
  segmentDurations,
  segmentSpans,
  timecode,
  transitionSpans,
} from '../src/index.js';
import type { CheckContext } from '../src/index.js';
import { FIXTURES, realTimeline, synthTimeline } from '../../editor/test/helpers.js';
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

let project: LoadedProject;
let editorial: LoadedTemplate;

/** A check context of a timeline planned now (editorial, the fixture project), with overrides. */
function ctxPlanned(timeline: Timeline, overrides: EditOverrides = {}): CheckContext {
  const plan = planEdit({ timeline, template: editorial, project, registry, captureFile: '/captures/capture.mp4', overrides });
  const record = { version: 1, id: 'x-v1', scenario: 'x', run_id: timeline.run_id, template: 'editorial', status: 'succeeded', overrides, variant: 'landscape', plan } as unknown as RenderRecord;
  const spans = segmentSpans(plan);
  return { record, plan, timeline, rules: { ...DEFAULT_RULES }, spans, transitions: transitionSpans(plan), clicks: outputClicks(plan, timeline), registry, measure: fontFileMeasurer(planFontFiles(plan)) };
}

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
  project = await loadProject('northfield-fixture', REPO);
  editorial = await loadTemplate('editorial', REPO);
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
    expect([...new Set(clicks.map((c) => `${c.scene}:${c.step}`))]).toEqual([
      'import:0', 'import:1', 'import:2', 'import:3',
      'availability:1', 'availability:2', 'availability:3', 'availability:4', 'availability:5', 'availability:6',
      'add-product:0', 'add-product:1', 'add-product:2',
    ]);
    // Widgets (selects, date picks) are placed click by click, each with the box it clicked.
    const widget = clicks.filter((c) => c.click !== undefined);
    expect(widget.length).toBeGreaterThan(0);
    expect(widget.filter((c) => c.bbox && c.bbox.w > 0).length).toBeGreaterThan(widget.length / 2);
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
    expect(tl.markers).toEqual([{ name: 'proposal', frame: 1372, time: 45.733, scene: 'proposal', done_frame: 1379, done_time: 45.967 }]);
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

  it('a caption band over the capture (studio/caption-overlay, position over) is measured in its band, clear of the brand mark', async () => {
    const project = await loadProject('northfield-fixture', REPO);
    const editorial = await loadTemplate('editorial', REPO);
    const timeline = realTimeline('catalogue');
    const plan = planEdit({ timeline, template: editorial, project, registry, captureFile: '/captures/capture.mp4', overrides: { components: { caption: 'studio/caption-overlay' } } });
    const clip = plan.segments.find((x): x is ClipSegment => x.id === 'add-product')!;
    expect(clip.caption!.params.position).toBe('over');
    const region = captionRegion(plan, clip)!;
    expect(region.over).toBe(true);
    // The band: 1400 wide, centred on the capture, 40 px above its bottom.
    expect(region.rect.w).toBe(1400);
    expect(region.rect.x + region.rect.w / 2).toBeCloseTo(clip.layout.capture.x + clip.layout.capture.w / 2, 1);
    expect(region.rect.y + region.rect.h).toBeCloseTo(clip.layout.capture.y + clip.layout.capture.h - 40, 1);
    const ctx = { ...ctxOf('catalogue'), plan, record: { ...plans.catalogue.record, plan } };
    // Two lines allowed in the band: the 87-character caption fits at full size.
    const fit = fitCaption(ctx, clip, clip.cues[0].text)!;
    expect(fit.scale).toBe(1);
    expect(fit.lines).toBeLessThanOrEqual(2);
    expect(checkCaptions(ctx).filter((f) => f.code === 'caption-overlaps-brandmark')).toEqual([]);
    // In the caption area (position area) the band is the layout's caption rect.
    const asArea = structuredClone(clip);
    asArea.caption!.params.position = 'area';
    expect(captionRegion(plan, asArea)!.rect).toEqual(clip.layout.caption);
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

describe('environment (L1.7): the report line, stopped writes, hidden and local URLs', () => {
  const SHOP = { page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' };
  const withEnv = (env: TimelineEnvironment): Timeline => ({ ...realTimeline('quote'), environment: env });

  it('a run before L1.7 (no environment block): no line, nothing to say on a card frame', () => {
    expect(reviewEnvironment(plans.quote.timeline)).toBeUndefined();
    expect(checkEnvironment(ctxOf('quote'))).toEqual([]);
  });

  it('a read-only run: the line counts its writes; each stopped write is a warning at its output frame, named by its display URL', () => {
    const tl = withEnv({
      name: 'production',
      production: true,
      access: 'read-only',
      display: [SHOP],
      clock: { at: '2026-11-02T10:24:00', epoch_ms: Date.UTC(2026, 10, 2, 9, 24) },
      writes: [
        { t: 30.8, method: 'POST', url: 'http://localhost:4402/api/quotes', outcome: 'mocked', rule: 'POST shop:/api/quotes', status: 201, via: 'page' },
        { t: 20.2, method: 'POST', url: 'http://localhost:4402/api/track?session=1', outcome: 'blocked', via: 'page' },
        { t: 22.4, method: 'POST', url: 'http://localhost:4402/api/track?session=2', outcome: 'blocked', via: 'page' },
        { method: 'PATCH', url: 'http://localhost:4402/api/profile', outcome: 'blocked', via: 'page' },
        { method: 'POST', url: 'http://localhost:4402/sign-in', outcome: 'exempt', via: 'sign-in' },
        { method: 'PUT', url: 'http://localhost:4402/api/last-seen', outcome: 'blocked', via: 'sign-in' },
        { t: 3, method: 'POST', url: 'https://metrics.example.com/collect', outcome: 'passed', via: 'page' },
      ],
    });
    const env = reviewEnvironment(tl)!;
    expect(env).toEqual({
      name: 'production',
      production: true,
      access: 'read-only',
      clock: { at: '2026-11-02T10:24:00' },
      display: ['https://shop.northfield.example'],
      writes: { blocked: 4, mocked: 1, allowed: 0, passed: 1 },
    });
    expect(environmentLine(env)).toBe('production · production · read-only · 1 write mocked, 4 stopped, 1 to unguarded hosts · clock 2026-11-02T10:24:00');
    expect(environmentLine({ name: 'local', access: 'read-write', writes: { blocked: 0, mocked: 0, allowed: 0, passed: 0 } })).toBe('local · read-write');
    // A read-write run whose guard stopped writes to the hosts of a read-only environment says so.
    expect(environmentLine({ name: 'local', access: 'read-write', writes: { blocked: 2, mocked: 0, allowed: 0, passed: 0 } })).toBe('local · read-write · 2 stopped (hosts of read-only environments)');
    expect(environmentLine({ name: 'live', production: true, access: 'read-write', allow_writes: true, writes: { blocked: 0, mocked: 0, allowed: 0, passed: 0 } })).toBe('live · production · read-write (--allow-writes)');
    const ctx = ctxPlanned(tl);
    const f = checkEnvironment(ctx);
    expect(f.map((x) => x.code)).toEqual(['write-blocked', 'write-blocked', 'write-blocked']);
    // One per method and path (two /api/track POSTs), at the output frame of the first: inside the request scene.
    expect(f[0]).toMatchObject({ severity: 'warning', at: { segment: 'request', scene: 'request' } });
    expect(f[0].message).toBe('a write was stopped: POST https://shop.northfield.example/api/track ×2 — the app saw a network error and may show it; add a mock (README: Environments)');
    const clip = ctx.plan.segments.find((x): x is ClipSegment => x.id === 'request')!;
    expect(clip.srcFrames[f[0].at!.frame! - clip.from] / ctx.plan.source.fps).toBeCloseTo(20.2, 0);
    expect(f[1].message).toMatch(/^a write was stopped before the capture started: PATCH https:\/\/shop\.northfield\.example\/api\/profile/);
    expect(f[1].at).toBeUndefined();
    // What the automated sign-in sent from the page it landed on is guarded and reported (its own sign-in POST is not).
    expect(f[2].message).toMatch(/^a write was stopped before the capture started: PUT https:\/\/shop\.northfield\.example\/api\/last-seen from the automated sign-in — /);
    expect(JSON.stringify(f)).not.toMatch(/localhost/);
    // A write a read-write run stopped because it went to another environment's host names that environment.
    const rw = checkEnvironment(
      ctxPlanned(withEnv({ name: 'local', access: 'read-write', writes: [{ t: 20.2, method: 'POST', url: 'https://api.example.com/reset', outcome: 'blocked', via: 'page', protected_by: 'production' }] })),
    );
    expect(rw.map((x) => x.message)).toEqual(['a write was stopped: POST https://api.example.com/reset — a host of read-only environment production: the app saw a network error and may show it (README: Environments)']);
  });

  it('url-hidden: only where the layout draws the URL, at the first local address, never naming the local host', () => {
    // An environment the project does not declare (no display URLs to merge): every address is local.
    const local = withEnv({ name: 'qa', access: 'read-write' });
    expect(checkEnvironment(ctxPlanned(local))).toEqual([]); // a card draws no URL
    const browser = checkEnvironment(ctxPlanned(local, { frame: 'browser' }));
    expect(browser.map((x) => [x.code, x.at?.segment])).toEqual([
      ['url-hidden', 'discover'],
      ['url-hidden', 'request'],
      ['url-hidden', 'proposal'],
    ]);
    expect(browser[0].message).toBe('discover: the browser bar shows no address while the page is at / (a local page) — a local URL without a display URL: add display: to its page in project.yaml environments and render again (README: Environments)');
    expect(JSON.stringify(browser)).not.toMatch(/localhost/);
    // The plan's warning about it reaches the report masked (V4).
    const planned = ctxPlanned(local, { frame: 'browser' });
    expect(planned.plan.warnings.join('\n')).toMatch(/localhost:4402/);
    const notes = checkRender(planned).filter((x) => x.code === 'plan-warning');
    expect(notes.map((x) => x.message)).toEqual([
      'a local URL outside the pages of environment qa has no display URL (a local page): the browser bar shows no address for it — declare it as a page with a display: in project.yaml and render again (README: Environments)',
    ]);
    // The run's environment declared in project.yaml with display URLs: they apply at edit time (V2) — nothing to say,
    // and the review names URLs through the table the edit used.
    const merged = ctxPlanned(withEnv({ name: 'local', access: 'read-write' }), { frame: 'browser' });
    expect(merged.plan.display?.map((r) => r.display)).toEqual(['https://console.northfield.example', 'https://shop.northfield.example']);
    expect(checkEnvironment(merged)).toEqual([]);
    expect(reviewEnvironment(merged.timeline, merged.plan)?.display).toEqual(['https://console.northfield.example', 'https://shop.northfield.example']);
    expect(checkEnvironment(ctxPlanned(local, { frame: 'browser', components: { layout: { id: 'studio/layout-browser', params: { show_url: false } } } }))).toEqual([]);
    // With the display table: the bar shows the display URL, nothing to say.
    expect(checkEnvironment(ctxPlanned(withEnv({ name: 'local', access: 'read-write', display: [SHOP] }), { frame: 'browser' }))).toEqual([]);
    // A sandbox run (L1.8): its pages are declared in its sandbox.yaml — the advice says so (I9).
    const sandbox = ctxPlanned(withEnv({ name: 'sandbox', access: 'read-write', sandbox: { name: 'sandbox', provider: 'process', strategy: 'reseed' } }), { frame: 'browser' });
    const hidden = checkEnvironment(sandbox).filter((x) => x.code === 'url-hidden');
    expect(hidden[0].message).toBe(
      'discover: the browser bar shows no address while the page is at / (a local page) — a local URL without a display URL: add display: to its page in the sandbox.yaml of sandbox sandbox (services.<service>.pages) and render again (README: Sandbox mode)',
    );
    expect(sandbox.plan.warnings).toEqual([
      expect.stringMatching(/^a local URL outside the pages of environment sandbox has no display URL \(http:\/\/localhost:4402\): the browser bar shows no address for it — declare it as a page with a display: in sandbox\/sandbox\.yaml \(services\.<service>\.pages\) and render again \(README: Sandbox mode\)$/),
    ]);
  });

  it('local-url-text: a caption, a card slot or a page label naming a local URL', () => {
    const ctx = ctxPlanned(withEnv({ name: 'local', access: 'read-write' }));
    const discover = ctx.plan.segments.find((x): x is ClipSegment => x.id === 'discover')!;
    discover.cues[0] = { ...discover.cues[0], text: 'Order at localhost:4402/coffees today' };
    const card = ctx.plan.segments.find((x): x is CardSegment => x.id === 'chapter-request')!;
    card.component.slots = { ...card.component.slots, title: 'See http://127.0.0.1:4402/quotes.' };
    const f = checkEnvironment(ctx);
    expect(f.map((x) => [x.code, x.at?.segment])).toEqual([
      ['local-url-text', 'discover'],
      ['local-url-text', 'chapter-request'],
    ]);
    expect(f[0].message).toBe('caption of discover shows a local URL (/coffees): it is burnt into the video — write {{page}} and give that page a display URL in project.yaml, or write the public address');
    expect(f[1].message).toMatch(/^card chapter-request \("title"\) shows a local URL \(\/quotes\)/);
    expect(JSON.stringify(f)).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});

describe('variants (vertical, square) and the theme zoom', () => {
  async function variantCtx(name: 'catalogue' | 'quote', variant: 'vertical' | 'square'): Promise<CheckContext> {
    const project = await loadProject('northfield-fixture', REPO);
    const editorial = await loadTemplate('editorial', REPO);
    const timeline = realTimeline(name);
    const plan = planEdit({ timeline, template: editorial, project, registry, captureFile: '/captures/capture.mp4', overrides: { variant } });
    const record = { ...plans[name].record, id: `${name}-v1-${variant}`, variant, plan } as RenderRecord;
    return { ...ctxOf(name), record, plan, spans: segmentSpans(plan), transitions: transitionSpans(plan), clicks: outputClicks(plan, timeline) };
  }

  it('the reframed fixture plans pass: every clicked target and the cursor in view, a smooth reframe, captions fit', async () => {
    for (const name of ['catalogue', 'quote'] as const) {
      for (const variant of ['vertical', 'square'] as const) {
        const ctx = await variantCtx(name, variant);
        const f = [...checkCursor(ctx), ...checkCamera(ctx), ...checkCaptions(ctx)].filter((x) => x.severity !== 'info');
        expect(f.map((x) => `${x.code}: ${x.message}`), `${name} ${variant}`).toEqual([]);
        // Widget clicks are checked one by one (a select clicks its trigger, then its option).
        expect(ctx.clicks.filter((c) => c.click !== undefined).length).toBeGreaterThan(0);
        expect(ctx.clicks.filter((c) => c.bbox !== undefined).length).toBeGreaterThan(ctx.clicks.length / 2);
      }
    }
  });

  it('flags a reframe that cuts the clicked target, jumps, or loses the cursor', async () => {
    const ctx = await variantCtx('quote', 'vertical');
    const plan = structuredClone(ctx.plan);
    const req = plan.segments.find((x): x is ClipSegment => x.id === 'request')!;
    const click = ctx.clicks.find((c) => c.segment === 'request' && c.step === 10)!; // "Send request" (1124–1271)
    const k = click.frame - req.from;
    // Move the crop so its right edge cuts the target (the cursor, at its centre, stays in), for the whole clip.
    const crop = req.layout.crop!;
    const cx = click.bbox!.x + click.bbox!.w * 0.8 - crop.w / 2;
    req.reframe = req.reframe!.map(() => [cx, 540] as [number, number]);
    const c2 = { ...ctx, plan, clicks: outputClicks(plan, ctx.timeline) };
    const f = checkCursor(c2);
    expect(f.find((x) => x.code === 'target-cut' && x.at?.step === 10)).toMatchObject({ severity: 'error' });
    expect(f.every((x) => x.code !== 'target-cut' || x.message.includes('vertical reframe'))).toBe(true);
    // A jump of the crop in one frame, and a crop that leaves the cursor.
    req.reframe![k] = [req.reframe![k][0] + 200, 540];
    const cam = checkCamera(c2);
    expect(cam.find((x) => x.code === 'reframe-jump')).toMatchObject({ severity: 'warning', at: { segment: 'request' } });
    req.reframe = req.reframe!.map(() => [crop.w / 2, 540] as [number, number]);
    expect(checkCamera(c2).find((x) => x.code === 'cursor-outside-reframe')).toMatchObject({ severity: 'warning' });
  });

  it('theme zooms: not counted against the per-video budget, at most one per scene, back to 1× before the cut', () => {
    const ctx = ctxOf('catalogue');
    const plan = structuredClone(ctx.plan);
    plan.brand.style_bias = 'motion';
    const [a, b] = plan.segments.filter((x): x is ClipSegment => x.kind === 'clip');
    const n = a.durationInFrames - a.heldFrames;
    const theme = { scene: a.scene, step: 1, from: 30, in_frames: 100, out_at: n - 36, out_frames: 36, zoom: 1.12, focus: { x: 900, y: 500 }, view: { x: 900, y: 500 }, source: 'theme' as const };
    a.zooms = [theme];
    a.camera = a.srcFrames.map((_, f) => [f < 30 ? 1 : f >= n ? 1 : 1.12, 900, 500] as [number, number, number]);
    // Smooth enough for the camera-jump check: ease the camera in and out linearly.
    a.camera = a.camera.map((c, f) => [f < 30 ? 1 : f < 130 ? 1 + (0.12 * (f - 30)) / 100 : f < n - 36 ? 1.12 : f < n ? 1.12 - (0.12 * (f - (n - 36) + 1)) / 36 : 1, 900, 500] as [number, number, number]);
    const c2 = { ...ctx, plan, spans: segmentSpans(plan), transitions: transitionSpans(plan) };
    let f = checkCamera(c2);
    expect(f.filter((x) => x.code === 'zoom-count')).toEqual([]); // 1 hint + 1 theme zoom
    expect(f.filter((x) => x.code.startsWith('theme-zoom')).map((x) => x.message)).toEqual([]);
    // Two in one scene, and one still zoomed when its scene ends.
    a.zooms = [theme, { ...theme, step: 2 }];
    b.zooms.push({ ...theme, scene: b.scene, out_at: b.durationInFrames + 10 });
    b.camera = b.srcFrames.map(() => [1.12, 900, 500] as [number, number, number]);
    f = checkCamera(c2);
    expect(f.find((x) => x.code === 'theme-zoom-count')).toMatchObject({ severity: 'warning', at: { scene: a.scene } });
    expect(f.find((x) => x.code === 'theme-zoom-cut')).toMatchObject({ severity: 'warning', at: { scene: b.scene } });
    // With style_bias real, a theme zoom is a contradiction.
    plan.brand.style_bias = 'real';
    expect(checkCamera(c2).find((x) => x.code === 'theme-zoom-real')).toMatchObject({ severity: 'warning' });
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
    // A marker's key frame is the screen once the marked step is done (its `done` frame).
    expect(k.get('proposal')).toBe(plans.quote.plan.markers[0].done);
    expect(keyframePlan(spans, [{ name: 'm', frame: 400 }], plans.quote.plan.durationInFrames).get('m')).toBe(400);
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

describe('L5.5 review rules: target length, cards too short for their text, a mail or document before its step', () => {
  it('the scenario\'s target_length replaces the reference 60–120 s unless the caller set the rule (R-FLD-05)', () => {
    expect(reviewRules({})).toEqual({ ...DEFAULT_RULES });
    expect(reviewRules({ target_length: { min_s: 30, max_s: 45 } })).toMatchObject({ video_min_s: 30, video_max_s: 45, video_target: 'scenario' });
    expect(reviewRules({ target_length: { min_s: 30, max_s: 45 } }, { video_max_s: 200 })).toMatchObject({ video_min_s: 60, video_max_s: 200 });
    const ctx = ctxOf('quote');
    const length = (rules: CheckContext['rules']) => checkDurations({ ...ctx, rules }, segmentDurations(ctx)).filter((f) => f.code === 'video-length');
    expect(length(reviewRules({ target_length: { min_s: 40, max_s: 70 } }))).toEqual([]);
    const far = length(reviewRules({ target_length: { min_s: 20, max_s: 30 } }));
    expect(far).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringMatching(/longer than the 20–30 s target of the scenario \(target_length\)$/) })]);
    expect(length(reviewRules({}))[0].message).toContain('target of the reference look');
  });

  it('warns when a card is shorter than its text needs (R-FLD-03)', () => {
    const words = Array.from({ length: 27 }, (_v, i) => `word${i}`).join(' ');
    const entries = (duration?: number) => [
      { card: { id: 'why', slots: { title: 'Quotes that follow', text: words }, ...(duration ? { duration } : {}) } },
      { id: 'x', t_start: 0, t_end: 5, open_end: 0.5, still: [0.6, 2] as [number, number] },
    ];
    const short = ctxPlanned(synthTimeline({ entries: entries(2), duration: 5 }));
    const found = checkDurations(short, segmentDurations(short)).filter((f) => f.code === 'card-too-short');
    expect(found).toEqual([
      expect.objectContaining({ severity: 'warning', message: 'card "why" is on screen 2.0 s: its 30 words need about 8.7 s (250 words a minute + 1.5 s) — remove its `duration` (the default follows the text) or make it longer, or shorten the text' }),
    ]);
    const auto = ctxPlanned(synthTimeline({ entries: entries(), duration: 5 }));
    expect(checkDurations(auto, segmentDurations(auto)).filter((f) => f.code === 'card-too-short')).toEqual([]);
  });

  it('warns when a mail card shows before the scene whose step captures the mail (R-FLD-06)', () => {
    const signup = JSON.parse(readFileSync(join(FIXTURES, 'signup.timeline.json'), 'utf8')) as Timeline;
    expect(checkArtefactOrder(ctxPlanned(signup))).toEqual([]);
    // The inbox card moved before the signup scene that receives the mail.
    const moved = structuredClone(signup);
    const inbox = moved.scenes.splice(1, 1)[0];
    moved.scenes.unshift(inbox);
    moved.scenes.forEach((x, i) => (x.index = i));
    const found = checkArtefactOrder(ctxPlanned(moved));
    expect(found).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'artefact-before-step',
        message: 'card "inbox" shows the mail "welcome" before scene "signup" (step signup.5) captures it: the viewer sees it before the action that sends it — move the card after that scene',
        at: expect.objectContaining({ segment: 'inbox' }),
      }),
    ]);
  });

  it('lists the slow transitions of the take from run.json, at the output frame of the click (R-FLD-23)', () => {
    const ctx = ctxOf('quote');
    expect(checkSlowTransitions(ctx)).toEqual([]);
    const click = ctx.clicks[2];
    const run = {
      perf: {
        transitions: {
          measured: 15,
          slow: [
            { t: 12.5, ms: 1875, scene: click.scene, step: click.step, target: 'link "October 2026"' },
            { t: 999, ms: 900, scene: 'gone', step: 0 },
          ],
        },
      },
    } as unknown as CheckContext['run'];
    const found = checkSlowTransitions({ ...ctx, run });
    expect(found).toEqual([
      expect.objectContaining({ severity: 'info', code: 'slow-transition', at: expect.objectContaining({ frame: click.frame }) }),
      expect.objectContaining({ severity: 'info', code: 'slow-transition', message: expect.stringContaining('gone.0: the screen settled 0.9 s after the click (not in the video)') }),
    ]);
    expect(found[0].message).toMatch(new RegExp(`^${click.scene}\\.${click.step}: the screen settled 1\\.9 s after the click on link "October 2026" — the product is slow there`));
  });
});
