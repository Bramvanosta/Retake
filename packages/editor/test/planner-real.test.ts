/**
 * planEdit on the two REAL fixture timelines (captured from fixtures/wholesale, copied in test/fixtures/), with a
 * workspace whose studio/* components are scaffolded stand-ins and the real `editorial` theme.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cubicBezier } from '@demo-studio/components';
import type { Timeline, TimelineEvent } from '@demo-studio/core';
import { WAIT_KEEP_S, WAIT_SPEED, mapSourceRect, markDoneAt, resolvePlanAssets, summarizePlan, PLAN_ASSET_SCHEME } from '@demo-studio/editor';
import type { CardSegment, ClipSegment, EditPlan } from '@demo-studio/editor';
import { clip, clips, fixtureProject, plan, realTimeline, seg, studioWorkspace, template } from './helpers.js';
import type { PlanContext } from './helpers.js';

let ctx: PlanContext;
const FPS = 30;
const XFADE = Math.round(0.35 * FPS); // editorial: studio/transition-crossfade {duration: 0.35}

beforeAll(async () => {
  ctx = { ws: await studioWorkspace(), project: await fixtureProject(), editorial: await template('editorial') };
});
afterAll(async () => ctx.ws.cleanup());

function events(t: Timeline, scene: string): TimelineEvent[] {
  return t.events.filter((e) => e.scene === scene);
}

/** First source frame of a scene: the end of its page load (still start, else open end, else scene start). */
function expectedStart(t: Timeline, scene: string): number {
  const ev = events(t, scene);
  const still = ev.find((e) => e.action === 'scene_still');
  const open = ev.find((e) => e.action === 'scene_open');
  const s = t.scenes.find((x) => x.id === scene)!;
  return Math.ceil((still?.t_start ?? open?.t_end ?? s.t_start) * FPS - 1e-6);
}

function expectedEnd(t: Timeline, scene: string): number {
  const s = t.scenes.find((x) => x.id === scene)!;
  return Math.min(Math.round(t.capture.duration * FPS), Math.ceil(s.t_end * FPS - 1e-6));
}

describe('catalogue (real timeline)', () => {
  let tl: Timeline;
  let p: EditPlan;
  beforeAll(() => {
    tl = realTimeline('catalogue');
    p = plan(ctx, tl);
  });

  it('orders intro → scenes → outro with the theme components and their slots', () => {
    expect(p.segments.map((s) => `${s.kind}:${s.id}`)).toEqual(['intro:intro', 'clip:import', 'clip:availability', 'clip:add-product', 'outro:outro']);
    expect(seg(p, 'intro').component).toMatchObject({ id: 'studio/intro-stack', source: 'theme', slots: { title: 'Manage your catalogue', kicker: 'For suppliers' } });
    expect(seg(p, 'outro').component).toMatchObject({ id: 'studio/outro-stack', source: 'theme', slots: { tagline: 'Your catalogue, under control.', url: 'example.com' } });
    expect(seg(p, 'outro').component.slots.logo).toBe(`${PLAN_ASSET_SCHEME}logo.svg`);
    for (const c of clips(p)) {
      expect(c.component).toMatchObject({ id: 'studio/layout-card', source: 'theme', params: { width: 1560, radius: 18, shadow: 'soft' } });
      expect(c.caption).toMatchObject({ id: 'studio/caption-below', source: 'theme' });
    }
    expect(p.warnings).toEqual([]);
    expect(p.width).toBe(1920);
    expect(p.height).toBe(1080);
    expect(p.fps).toBe(30);
    expect(p.unit).toBe(1);
  });

  it('shows each scene from the end of its page load to its end: page loads are never shown', () => {
    for (const c of clips(p)) {
      const A = expectedStart(tl, c.scene);
      const B = expectedEnd(tl, c.scene);
      expect(c.srcFrames[0]).toBe(A);
      const content = c.srcFrames.slice(0, c.durationInFrames - c.heldFrames);
      expect(content[content.length - 1]).toBe(B - 1);
      const open = events(tl, c.scene).find((e) => e.action === 'scene_open')!;
      // No frame of the page load [open.t_start, still.t_start) is used.
      expect(c.srcFrames.every((f) => f >= A || f < Math.floor(open.t_start * FPS))).toBe(true);
      expect(Math.min(...c.srcFrames)).toBe(A);
    }
    expect(p.notes.filter((n) => n.includes('page load')).length).toBe(3);
  });

  it('plays 1× scenes frame by frame (exact source indices) except their loading waits, then holds the last frame under the crossfade', () => {
    const imp = clip(p, 'import');
    const A = expectedStart(tl, 'import');
    const n = imp.durationInFrames - imp.heldFrames;
    // L2.12: the import wait (`wait_for: 921 offers created`, 2.0 s, marked) plays faster after its first 0.5 s, up to
    // the mark window before what it waited for (0.6 s before its end): exact 1× before and after.
    const wait = events(tl, 'import').find((e) => e.action === 'wait_for' && e.mark)!;
    const a = Math.ceil((wait.t_start + WAIT_KEEP_S) * FPS - 1e-6) - A;
    expect(imp.srcFrames.slice(0, a)).toEqual(Array.from({ length: a }, (_, k) => A + k));
    const fast = imp.speeds.filter((x) => x.speed > 1 || x.to_speed > 1);
    expect(fast.length).toBeGreaterThan(0);
    expect(Math.max(...fast.map((x) => Math.max(x.speed, x.to_speed)))).toBeLessThanOrEqual(WAIT_SPEED);
    const markFrom = Math.ceil((wait.t_end - 0.6) * FPS - 1e-6);
    const k = imp.srcFrames.findIndex((f) => f >= markFrom);
    expect(imp.srcFrames.slice(k, n)).toEqual(Array.from({ length: n - k }, (_, j) => markFrom + j));
    // Shorter than the source by what the faster wait saved.
    expect(n).toBeLessThan(expectedEnd(tl, 'import') - A - 5);
    expect(imp.heldFrames).toBe(XFADE);
    expect(imp.srcFrames.slice(n)).toEqual(Array(XFADE).fill(imp.srcFrames[n - 1]));
    expect(p.notes.some((x) => /"import": waiting .* played at up to 4×/.test(x))).toBe(true);
  });

  it('plays the loading of the new product page faster (L2.12: the root cause of the `long-wait`), the reveal at 1×', () => {
    const ap = clip(p, 'add-product');
    const evs = events(tl, 'add-product');
    const click = evs.find((e) => e.step === 2)!;
    const reveal = evs.find((e) => e.mark === 'reveal')!;
    // From the URL change after the click (+ 0.5 s) to 0.6 s before the reveal: up to 4×.
    const change = tl.pages.find((pg) => pg.t_start >= click.t_click! && pg.t_start < click.t_end)!.t_start;
    const src = (t: number) => Math.ceil(t * FPS - 1e-6);
    const out = (t: number) => ap.srcFrames.findIndex((f) => f >= src(t));
    const loading = (out(reveal.t_end) - out(change)) / FPS;
    expect(reveal.t_end - change).toBeGreaterThan(4);
    expect(loading).toBeLessThan(2.5);
    // The reveal (from 0.6 s before it) and its hold at 1×.
    const k = out(reveal.t_end - 0.6);
    const h = out(reveal.hold!.t_end) - 1;
    expect(ap.srcFrames.slice(k, h)).toEqual(Array.from({ length: h - k }, (_, j) => ap.srcFrames[k] + j));
  });

  it('crossfades at every non-contiguous join (each scene opens a page): overlap = transition frames', () => {
    for (let i = 1; i < p.segments.length; i++) {
      const prev = p.segments[i - 1];
      const s = p.segments[i];
      expect(s.transitionIn).toBe('crossfade');
      expect(s.transition).toMatchObject({ kind: 'crossfade', frames: XFADE, component: { id: 'studio/transition-crossfade', source: 'theme' } });
      expect(s.fadeIn).toEqual({ frames: XFADE, color: 'none' });
      expect(s.from).toBe(prev.from + prev.durationInFrames - XFADE);
    }
    const last = p.segments[p.segments.length - 1];
    expect(p.durationInFrames).toBe(last.from + last.durationInFrames);
    const seconds = p.durationInFrames / FPS;
    expect(seconds).toBeGreaterThan(50);
    expect(seconds).toBeLessThan(90);
  });

  it('plays availability at 1.6× except its still and final hold (1×), with ~0.3 s ramps', () => {
    const av = clip(p, 'availability');
    const ev = events(tl, 'availability');
    const still = ev.find((e) => e.action === 'scene_still')!;
    const hold = ev.find((e) => e.action === 'hold')!;
    const n = av.durationInFrames - av.heldFrames;
    const content = av.srcFrames.slice(0, n);
    const steps = content.slice(1).map((f, k) => f - content[k]);
    // Still: source advances exactly 1 frame per output frame.
    const stillFrames = Math.floor((still.t_end - still.t_start) * FPS) - 1;
    expect(steps.slice(0, stillFrames).every((d) => d === 1)).toBe(true);
    // Hold at the end: 1× too.
    const holdFrames = Math.floor((hold.t_end - hold.t_start) * FPS) - 1;
    expect(steps.slice(steps.length - holdFrames).every((d) => d === 1)).toBe(true);
    // Middle: 1.6× on average (steps of 1 and 2).
    const mid = steps.slice(stillFrames + 20, steps.length - holdFrames - 20);
    const avg = mid.reduce((a, b) => a + b, 0) / mid.length;
    expect(avg).toBeGreaterThan(1.55);
    expect(avg).toBeLessThan(1.65);
    expect(mid.every((d) => d === 1 || d === 2)).toBe(true);
    // Speed spans: two ramps of 9 output frames (0.3 s) between 1× and 1.6×, protected spans at 1×.
    const ramps = av.speeds.filter((s) => s.speed !== s.to_speed && s.speed > 0);
    expect(ramps.map((r) => [r.speed, r.to_speed])).toEqual([[1, 1.6], [1.6, 1]]);
    for (const r of ramps) expect(r.to - r.from).toBeCloseTo(9, 3);
    expect(av.speeds.filter((s) => s.protected).every((s) => s.speed === 1 && s.to_speed === 1)).toBe(true);
    // Output length = still + hold at 1× + the rest at 1.6× (+ the ramps' share).
    const total = (av.src.to_s - av.src.from_s) * FPS;
    const prot = (still.t_end - still.t_start + hold.t_end - hold.t_start) * FPS;
    expect(n).toBeGreaterThan(prot + (total - prot) / 1.6 - 2);
    expect(n).toBeLessThan(prot + (total - prot) / 1.6 + 10);
  });

  it('zooms on the "Awards" step from its camera hint: theme ease, view clamped, held to the end', () => {
    const ap = clip(p, 'add-product');
    const ev = events(tl, 'add-product').find((e) => e.camera)!;
    expect(ev.camera).toMatchObject({ zoom: 1.3, ease: 'slow' });
    expect(ap.zooms).toHaveLength(1);
    const z = ap.zooms[0];
    const bbox = ev.camera!.bbox!;
    expect(z.zoom).toBe(1.3);
    expect(z.requested_zoom).toBeUndefined();
    expect(z.focus).toEqual({ x: Math.round((bbox.x + bbox.w / 2) * 100) / 100, y: Math.round((bbox.y + bbox.h / 2) * 100) / 100 });
    // The focus (x ≈ 409) is too close to the left edge at 1.3×: the view centre is clamped to 1920 / 2.6.
    expect(z.view.x).toBeCloseTo(1920 / 2.6, 2);
    expect(z.view.y).toBeCloseTo(z.focus.y, 2);
    // The output frame of the step's start (the loading before it plays faster since L2.12).
    // (srcFrames are whole frames: the plan's source position of that output frame is within one frame of it.)
    const approx = ap.srcFrames.findIndex((f) => f >= Math.ceil(ev.t_start * FPS - 1e-6));
    expect(Math.abs(z.from - approx)).toBeLessThanOrEqual(1);
    const start = z.from;
    // Duration: the step's own output duration (≥ 0.8 s).
    const stepFrames = Math.ceil(ev.t_end * FPS - 1e-6) - Math.ceil(ev.t_start * FPS - 1e-6);
    expect(z.in_frames).toBe(stepFrames);
    const cam = ap.camera!;
    expect(cam[start - 1]).toEqual([1, 960, 540]);
    expect(cam[start][0]).toBe(1);
    const ease = cubicBezier(0.45, 0, 0.2, 1);
    const mid = start + Math.round(z.in_frames / 2);
    expect(cam[mid][0]).toBeCloseTo(1 + 0.3 * ease((mid - start) / z.in_frames), 3);
    const done = start + Math.ceil(z.in_frames);
    expect(cam[done]).toEqual([1.3, 738.46, z.focus.y]);
    // Held through the end of the clip (scene_end, last clip before the outro) and its held frames.
    expect(cam[cam.length - 1]).toEqual([1.3, 738.46, z.focus.y]);
    expect(cam).toHaveLength(ap.durationInFrames);
    // Every frame keeps the view inside the capture.
    for (const [zoom, cx, cy] of cam) {
      expect(cx).toBeGreaterThanOrEqual(1920 / (2 * zoom) - 0.01);
      expect(cy).toBeGreaterThanOrEqual(1080 / (2 * zoom) - 0.01);
      expect(cx).toBeLessThanOrEqual(1920 - 1920 / (2 * zoom) + 0.01);
    }
    // No camera on the other clips.
    expect(clip(p, 'import').camera).toBeNull();
    expect(clip(p, 'availability').camera).toBeNull();
  });

  it('keeps the marked steps and their markers in output frames', () => {
    expect(p.markers.map((m) => m.name)).toEqual(['import-done', 'reveal']);
    const imp = clip(p, 'import');
    const mk = tl.markers.find((m) => m.name === 'import-done')!;
    expect(p.markers[0].frame).toBe(imp.from + imp.srcFrames.findIndex((f) => f >= Math.ceil(mk.t * FPS - 1e-6)));
  });

  it('places each marker\'s `done` frame on the screen once its step is done (a marked wait: its awaited state)', () => {
    for (const m of p.markers) {
      const mk = tl.markers.find((x) => x.name === m.name)!;
      const ev = tl.events.find((e) => e.scene === mk.scene && e.step === mk.step)!;
      const c = clip(p, mk.scene);
      // After the marker, inside its clip, on a source frame at or after the end of the marked step (the wait ended).
      expect(m.done).toBeGreaterThan(m.frame);
      expect(m.done).toBeLessThan(c.from + c.durationInFrames);
      expect(c.srcFrames[m.done! - c.from] / FPS).toBeGreaterThanOrEqual(ev.t_end - 1 / FPS);
      expect(markDoneAt(tl, mk)).toBeGreaterThan(ev.t_end);
    }
  });
});

describe('quote (real timeline)', () => {
  let tl: Timeline;
  let p: EditPlan;
  beforeAll(() => {
    tl = realTimeline('quote');
    p = plan(ctx, tl);
  });

  it('places the chapter card and the interstitial in scenario order, with crossfades around them', () => {
    expect(p.segments.map((s) => `${s.kind}:${s.id}`)).toEqual([
      'intro:intro',
      'clip:discover',
      'card:chapter-request',
      'clip:request',
      'interstitial:interstitial-3',
      'clip:proposal',
      'outro:outro',
    ]);
    const card = seg(p, 'chapter-request');
    expect(card.component).toMatchObject({ id: 'studio/card-title', source: 'theme', slots: { title: 'Ask the roaster for a quote', kicker: 'Step two' } });
    expect(card.durationInFrames).toBe(Math.round(2.2 * FPS));
    const inter = seg(p, 'interstitial-3') as CardSegment;
    expect(inter.component).toMatchObject({ id: 'studio/interstitial-clock', slots: { text: 'A few hours later' } });
    expect(inter.durationInFrames).toBe(Math.round(2.6 * FPS));
    // Backdrop = the last frame of the previous clip (request).
    const req = clip(p, 'request');
    expect(inter.backdropSrcFrame).toBe(req.srcFrames[req.srcFrames.length - 1]);
    expect(inter.backdropSrcFrame).toBe(expectedEnd(tl, 'request') - 1);
    // discover and request are contiguous in the capture but the card sits between them: transitions, not a join.
    for (const s of p.segments.slice(1)) expect(s.transitionIn).toBe('crossfade');
    expect(p.warnings).toEqual([]);
    const seconds = p.durationInFrames / FPS;
    expect(seconds).toBeGreaterThan(50);
    expect(seconds).toBeLessThan(90);
  });

  it('puts the callout overlay on the €720.00 total from the end of its step, anchored in source px', () => {
    const pr = clip(p, 'proposal');
    expect(pr.overlays).toHaveLength(1);
    const o = pr.overlays[0];
    const ev = events(tl, 'proposal').find((e) => e.overlay)!;
    expect(o.component).toMatchObject({ id: 'studio/overlay-callout', source: 'scenario', slots: { text: 'Total incl. VAT, ready to accept' } });
    expect(o.step).toBe(ev.step);
    expect(o.from).toBe(Math.ceil(ev.t_end * FPS - 1e-6) - expectedStart(tl, 'proposal'));
    expect(o.durationInFrames).toBe(Math.round(2.5 * FPS));
    expect(o.anchor).toEqual({ bbox: ev.overlay!.bbox });
    // Mapped through the layout (static camera): capture rect scale.
    const cap = pr.layout.capture;
    const r = mapSourceRect(p, pr, o.from, o.anchor!.bbox!);
    const k = cap.w / 1920;
    expect(r.x).toBeCloseTo(cap.x + o.anchor!.bbox!.x * k, 1);
    expect(r.y).toBeCloseTo(cap.y + o.anchor!.bbox!.y * k, 1);
    expect(r.w).toBeCloseTo(o.anchor!.bbox!.w * k, 1);
    // The marked step plays at 1× within ±0.6 s.
    const mk = p.markers.find((m) => m.name === 'proposal')!;
    const at = mk.frame - pr.from;
    const d = pr.srcFrames.slice(at - 18, at + 18);
    expect(d.slice(1).every((f, i) => f - d[i] === 1)).toBe(true);
  });

  it('names the marked step on its marker, though the satisfied wait owns no frame of the clip (L3.6)', () => {
    const mk = p.markers.find((m) => m.name === 'proposal')!;
    const tm = tl.markers.find((m) => m.name === 'proposal')!;
    const ev = events(tl, 'proposal').find((e) => e.step === tm.step)!;
    expect(ev.action).toBe('wait_for');
    expect(ev.t_end - ev.t_start).toBeLessThan(1 / FPS);
    expect(mk).toMatchObject({ scene: 'proposal', step: tm.step, action: 'wait_for' });
    expect(mk).not.toHaveProperty('step_id'); // the fixture's steps have no id
    expect(clip(p, 'proposal').steps.some((s) => s.step === tm.step)).toBe(false);
  });

  it('shows each scene caption over its clip, from the first visible frame to the next segment, never overlapping', () => {
    expect(p.captions.map((c) => c.scene)).toEqual(['discover', 'request', 'proposal']);
    for (const c of p.captions) {
      const s = clip(p, c.scene);
      const i = p.segments.indexOf(s);
      expect(c.from).toBe(s.from);
      expect(c.to).toBe(p.segments[i + 1].from);
      expect(s.cues).toHaveLength(1);
      expect(s.cues[0]).toMatchObject({ from: 0, to: s.durationInFrames, text: c.text, kicker: c.kicker });
    }
    for (let i = 1; i < p.captions.length; i++) expect(p.captions[i].from).toBeGreaterThanOrEqual(p.captions[i - 1].to);
  });

  it('records provenance: every output frame of a clip belongs to exactly one step span', () => {
    for (const c of clips(p)) {
      let next = 0;
      for (const sp of c.steps) {
        expect(sp.from).toBe(next);
        expect(sp.to).toBeGreaterThan(sp.from);
        expect(sp.scene).toBe(c.scene);
        next = sp.to;
      }
      expect(next).toBe(c.durationInFrames);
      // Spot-check: the frame at a step's start belongs to that step.
      const ev = events(tl, c.scene).filter((e) => e.step >= 0 && (e.t_end - e.t_start) * FPS > 2);
      for (const e of ev) {
        const k = c.srcFrames.indexOf(Math.ceil(e.t_start * FPS - 1e-6) + 1);
        const span = c.steps.find((s) => s.from <= k && k < s.to)!;
        expect(span.step).toBe(e.step);
        expect(span.action).toBe(e.action);
      }
    }
    // The opening still is step -1.
    expect(clip(p, 'discover').steps[0]).toMatchObject({ step: -1, action: 'scene_still', from: 0 });
  });

  it('keeps a time map covering every clip frame and URLs for browser chrome', () => {
    for (const c of clips(p)) {
      const entries = p.timemap.filter((e) => e.scene === c.scene);
      expect(entries[0].out_from).toBe(c.from);
      expect(entries[entries.length - 1].out_to).toBe(c.from + c.durationInFrames);
      for (let i = 1; i < entries.length; i++) expect(entries[i].out_from).toBeCloseTo(entries[i - 1].out_to, 3);
    }
    expect(clip(p, 'proposal').urls.map((u) => u.url)).toEqual([
      'http://localhost:4402/',
      'http://localhost:4402/quotes/1043',
      'http://localhost:4402/quotes/1043/pdf',
    ]);
  });

  it('is deterministic and does not modify its input', () => {
    const before = JSON.stringify(tl);
    const a = JSON.stringify(plan(ctx, tl));
    const b = JSON.stringify(plan(ctx, realTimeline('quote')));
    expect(a).toBe(b);
    expect(JSON.stringify(tl)).toBe(before);
  });

  it('refers to assets through ds-asset: URLs that resolvePlanAssets swaps for served URLs', () => {
    const json = JSON.stringify(p);
    const urls = [...new Set(json.match(/ds-asset:[a-z0-9.-]+/g) ?? [])];
    expect(urls.length).toBeGreaterThan(4);
    for (const u of urls) expect(p.assets[u]).toBeTruthy();
    expect(p.assets[p.source.url]).toBe('/captures/capture.mp4');
    const served = resolvePlanAssets(p, (url) => url.replace(PLAN_ASSET_SCHEME, 'http://127.0.0.1:9000/'));
    // Every URL is swapped; the assets map keeps its keys (url → file) for the renderer.
    expect(JSON.stringify({ ...served, assets: {} }).includes('"ds-asset:')).toBe(false);
    expect(Object.keys(served.assets)).toEqual(Object.keys(p.assets));
    expect(served.source.url).toBe('http://127.0.0.1:9000/capture.mp4');
    expect(JSON.stringify(p)).toBe(json);
  });

  it('summarises the plan for humans', () => {
    const text = summarizePlan(p).join('\n');
    expect(text).toContain('chapter-request');
    expect(text).toContain('overlay studio/overlay-callout');
    expect(text).toContain('Warnings (0)');
  });
});

describe('theme switch (R-THM-05)', () => {
  it('re-plans the same timeline with the motion theme: other components, fade-black transitions, scenario untouched', async () => {
    const tl = realTimeline('quote');
    const before = JSON.stringify(tl);
    const motion = await template('motion');
    const p = plan(ctx, tl, { theme: 'motion' }, motion);
    expect(seg(p, 'intro').component.id).toBe('studio/intro-minimal');
    expect(seg(p, 'interstitial-3').component).toMatchObject({ id: 'studio/interstitial-plain', params: { tone: 'paper' } });
    for (const c of clips(p)) {
      // The project pins frame "card" (not the motion theme's browser style): the card layout with the theme's frame values.
      expect(c.component).toMatchObject({ id: 'studio/layout-card', source: 'scenario', params: { width: 1600, radius: 14, shadow: 'strong' } });
      expect(c.caption?.id).toBe('studio/caption-overlay');
    }
    const t = seg(p, 'discover').transition!;
    expect(t.kind).toBe('fade-black');
    expect(t.frames).toBe(Math.round(0.4 * FPS));
    expect(seg(p, 'discover').fadeIn).toEqual({ frames: 6, color: 'black' });
    expect(seg(p, 'intro').fadeOut).toEqual({ frames: 6, color: 'black' });
    expect(p.brand.tokens.name).toBe('motion');
    expect(p.meta.theme).toBe('motion');
    expect(JSON.stringify(tl)).toBe(before);
    // With frame "browser" the motion theme's own layout is used.
    const b = plan(ctx, tl, { frame: 'browser' }, motion);
    expect(clips(b)[0].component).toMatchObject({ id: 'studio/layout-browser', source: 'override' });
  });
});
