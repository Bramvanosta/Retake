/**
 * L4.5 part A, the Studio timeline's model (editor timeline.ts `timelineOf`, `placePins`): the tracks of real fixture
 * plans (quote, live-quote: same-page joins and multi-page clips, catalogue: a camera zoom) checked against the plan
 * they come from — absolute frames, every step, speed span, zoom and caption, text only under `untrusted`; the cuts and
 * their reasons on a synthetic take (a hook step, an idle gap, a freeze, a busy wait, a page load: the planner's own
 * notes agree); comment pins on the shown take and on today's edit; the scenario's `caption_component` honoured by the
 * planner between a render override and the theme; a 4-minute plan's model built within budget.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { placePins, planEdit, reasonOf, timelineOf } from '@retake/editor';
import type { ClipSegment, EditOverrides, EditPlan } from '@retake/editor';
import type { Timeline } from '@retake/core';
import { FIXTURES, REPO, fixtureProject, synthTimeline, template } from './helpers.js';

let registry: ComponentRegistry;
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
async function plan(timeline: Timeline, overrides: EditOverrides = {}): Promise<EditPlan> {
  return planEdit({ timeline, template: await template('editorial'), project: await fixtureProject(), registry, captureFile: '/virtual/runs/r/capture.mp4', overrides });
}
const clips = (p: EditPlan) => p.segments.filter((s): s is ClipSegment => s.kind === 'clip');

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

describe('timelineOf on real fixture plans', () => {
  it('quote: segments, steps, speeds and captions at the plan\'s absolute frames', async () => {
    const t = load('quote');
    const p = await plan(t);
    const m = timelineOf(p, { timeline: t, labels: { 'request.0': 'click Request a quote' } });
    expect(m).toMatchObject({ fps: p.fps, frames: p.durationInFrames, width: p.width, height: p.height, variant: 'landscape' });
    expect(m.segments.map((s) => [s.id, s.kind, s.from, s.to, s.component.id])).toEqual(p.segments.map((s) => [s.id, s.kind, s.from, s.from + s.durationInFrames, s.component.id]));
    for (const s of m.segments) expect(s.transition?.kind, s.id).toBe(p.segments[s.index].transition?.kind);
    for (const c of clips(p)) {
      const seg = m.segments.find((s) => s.id === c.id)!;
      expect(seg.caption).toEqual(c.caption ? { id: c.caption.id, kind: 'caption', source: c.caption.source } : null);
      for (const st of c.steps) expect(m.steps).toContainEqual(expect.objectContaining({ scene: st.scene, step: st.step, from: c.from + st.from, to: c.from + st.to, key: `${st.scene}.${st.step}` }));
      for (const sp of c.speeds) expect(m.speed).toContainEqual(expect.objectContaining({ from: c.from + sp.from, to: c.from + sp.to, speed: sp.speed, scene: c.scene }));
    }
    expect(m.steps).toHaveLength(clips(p).reduce((n, c) => n + c.steps.length, 0));
    expect(m.speed).toHaveLength(clips(p).reduce((n, c) => n + c.speeds.length, 0));
    expect(m.captions.map((c) => [c.from, c.to, c.scene])).toEqual(p.captions.map((c) => [c.from, c.to, c.scene]));
    expect(m.untrusted.captions.map((c) => c.text)).toEqual(p.captions.map((c) => c.text));
    expect(m.markers.map((x) => [x.frame, x.scene, m.untrusted.markers[x.i]])).toEqual(p.markers.map((x) => [x.frame, x.scene, x.name]));
    expect(m.untrusted.steps).toEqual({ 'request.0': 'click Request a quote' });
    const card = m.segments.find((s) => s.kind === 'card')!;
    expect(card.reading).toEqual((p.segments.find((s) => s.id === card.id) as { reading?: unknown }).reading);
    // Text the scenario or the product wrote is only under untrusted; no per-frame array reaches the model.
    const { untrusted: _u, ...shape } = m;
    const json = JSON.stringify(shape);
    for (const c of p.captions) expect(json).not.toContain(c.text);
    // (A marker named like a scene id reads as that id.)
    for (const x of p.markers) if (!p.segments.some((g) => g.id === x.name)) expect(json).not.toContain(`"${x.name}"`);
    expect(json).not.toContain('srcFrames');
    expect(JSON.stringify(m).length).toBeLessThan(20_000);
  });

  it('live-quote: same-page scenes joined (no transition), multi-page clips name their pages', async () => {
    const p = await plan(load('live-quote'));
    const m = timelineOf(p);
    const joined = m.segments.filter((s) => s.joined).map((s) => s.id);
    expect(joined).toEqual(clips(p).filter((c, i) => i > 0 && !c.transition).map((c) => c.id));
    expect(joined.length).toBeGreaterThan(0);
    for (const s of m.segments.filter((x) => x.joined)) expect(s.transition).toBeUndefined();
    const multi = clips(p).filter((c) => c.panes?.length);
    expect(multi.length).toBeGreaterThan(0);
    for (const c of multi) {
      expect(m.segments.find((s) => s.id === c.id)!.pages).toEqual(c.panes!.map((x) => x.page));
      for (const pane of c.panes!) if (pane.label) expect(m.untrusted.pages[`${c.scene}.${pane.page}`]).toBe(pane.label);
    }
  });

  it('catalogue: a camera zoom at absolute frames, eased in and out inside its clip', async () => {
    const p = await plan(load('catalogue'));
    const m = timelineOf(p);
    const zooms = clips(p).flatMap((c) => c.zooms.map((z) => ({ c, z })));
    expect(m.camera).toHaveLength(zooms.length);
    expect(zooms.length).toBeGreaterThan(0);
    for (const { c, z } of zooms) {
      const end = c.from + c.durationInFrames;
      expect(m.camera).toContainEqual(expect.objectContaining({ from: c.from + z.from, in_to: Math.min(end, c.from + z.from + z.in_frames), out_from: Math.min(end, c.from + z.out_at), zoom: z.zoom, key: `${z.scene}.${z.step}` }));
    }
  });
});

describe('cuts and their reasons (a synthetic take)', () => {
  it('a hook step, an idle gap, a freeze, a busy wait and a page load: each cut at its frame with the reason the run recorded', async () => {
    const t = synthTimeline({
      duration: 26,
      entries: [
        {
          id: 'i',
          t_start: 0,
          t_end: 26,
          open_end: 0.5,
          still: [0.5, 2],
          steps: [
            { action: 'click', t_start: 2, t_end: 3 },
            { action: 'hook', t_start: 3, t_end: 6 },
            { action: 'click', t_start: 6, t_end: 7 },
            { action: 'wait', t_start: 7, t_end: 12 },
            { action: 'click', t_start: 12, t_end: 13 },
            { action: 'click', t_start: 16, t_end: 16.2 },
            { action: 'click', t_start: 20, t_end: 21 },
            { action: 'click', t_start: 24, t_end: 25 },
          ],
        },
      ],
      idle: [[7.2, 11.9]],
      cursor: [[0, 100, 100], [14, 100, 100], [15, 900, 600], [26, 900, 600]],
    });
    t.stalls = [{ t_start: 14, t_end: 15, during: 'move' }];
    t.busy = [{ t_start: 16.3, t_end: 19.5, click: 16.2 }];
    t.loading = [{ t_start: 21.1, t_end: 22.6, until: 'paint', held_frames: 45 }];
    const p = await plan(t);
    const m = timelineOf(p, { timeline: t });
    const c = clips(p)[0];
    expect(m.cuts.map((x) => [x.at, x.src_from_s, x.src_to_s])).toEqual(c.trims.map((x) => [c.from + x.at, x.src_from_s, x.src_to_s]));
    expect(m.cuts.map((x) => x.reason)).toEqual(['hook', 'idle', 'frozen', 'busy', 'loading']);
    // The planner's notes name the same cuts.
    expect(p.notes.filter((n) => /cut|shortened/.test(n))).toHaveLength(5);
    // L4.5 fixes (review B M4): the planner records why it cut on each trim — the model needs no run timeline for it.
    expect(c.trims.map((x) => x.reason)).toEqual(['hook', 'idle', 'frozen', 'busy', 'loading']);
    expect(timelineOf(p).cuts.map((x) => x.reason)).toEqual(['hook', 'idle', 'frozen', 'busy', 'loading']);
    // A plan made before (no reason on its trims) without the run's timeline: the reason cannot be told.
    const old = structuredClone(p);
    for (const seg of clips(old)) for (const tr of seg.trims) delete tr.reason;
    expect(timelineOf(old).cuts.map((x) => x.reason)).toEqual(['gap', 'gap', 'gap', 'gap', 'gap']);
  });

  it('review B M4: a page load the idle time overlaps is a page load, never idle (a jump the planner gave no reason)', () => {
    const t = { idle: [{ t_start: 0, t_end: 10 }], loading: [{ t_start: 4, t_end: 5 }], stalls: [], busy: [], events: [] } as unknown as Parameters<typeof reasonOf>[2];
    // The idle span covers more of the skipped time than the load: the load still names it.
    expect(reasonOf(3, 6, t)).toBe('loading');
    expect(reasonOf(6, 9, t)).toBe('idle');
    expect(reasonOf(11, 12, t)).toBe('gap');
    expect(reasonOf(3, 6, { ...t!, loading: [], stalls: [{ t_start: 4, t_end: 4.5, during: 'move' }] } as typeof t)).toBe('frozen');
    expect(reasonOf(3, 6, undefined)).toBe('gap');
  });
});

describe('comment pins (read-only, plan D8)', () => {
  it('on the shown take: the anchored step, else its marker, else its segment; on today\'s edit: today\'s step; else beside the track', async () => {
    const p = await plan(load('quote'));
    const m = timelineOf(p);
    const run = 'r1';
    const step = m.steps.find((s) => s.scene === 'request' && s.step === 2)!;
    const marker = m.markers[0];
    const r = placePins(
      m,
      [
        { id: 'a', status: 'open', run_id: run, anchor: { segment: 'request', scene: 'request', step: 2 } },
        { id: 'b', status: 'open', run_id: run, anchor: { segment: 'request', scene: 'request', step: 99 }, marker: m.untrusted.markers[marker.i] },
        { id: 'c', status: 'resolved', run_id: run, anchor: { segment: 'outro' } },
        { id: 'd', status: 'open', run_id: 'other', anchor: { segment: 'request' }, step_now: 'request.2' },
        { id: 'e', status: 'open', run_id: 'other', anchor: { segment: 'request' }, step_now: null },
        { id: 'f', status: 'open', run_id: run, anchor: { segment: 'gone' } },
      ],
      { run_id: run, edit: 'scenario' },
    );
    const first = Math.min(...m.steps.filter((s) => s.key === step.key).map((s) => s.from));
    expect(r.placed).toEqual(
      [
        { id: 'a', status: 'open', frame: first, by: 'step' },
        { id: 'b', status: 'open', frame: marker.frame, by: 'marker' },
        { id: 'c', status: 'resolved', frame: m.segments.find((s) => s.id === 'outro')!.from, by: 'segment' },
        { id: 'd', status: 'open', frame: first, by: 'step_now' },
      ].sort((x, y) => x.frame - y.frame),
    );
    expect(r.elsewhere).toEqual(['e', 'f']);
    // The take as captured (a filmed change pending): another take's thread is never placed on today's step.
    expect(placePins(m, [{ id: 'd', status: 'open', run_id: 'other', anchor: { segment: 'request' }, step_now: 'request.2' }], { run_id: run, edit: 'run' })).toEqual({ placed: [], elsewhere: ['d'] });
  });

  it('review B M5: a thread whose render shows this version is pinned at its own frame, not its step\'s first frame', async () => {
    const p = await plan(load('quote'));
    const m = timelineOf(p);
    const step = m.steps.find((s) => s.scene === 'request' && s.step === 2)!;
    const inside = step.from + Math.max(1, Math.floor((step.to - step.from) / 2));
    const anchor = { segment: 'request', scene: 'request', step: 2 };
    // The caller gives `frame` only for a render of this version: at that frame.
    expect(placePins(m, [{ id: 'a', status: 'open', run_id: 'r1', anchor, frame: inside }], { run_id: 'r1', edit: 'scenario' }).placed).toEqual([{ id: 'a', status: 'open', frame: inside, by: 'frame' }]);
    // Without it (another version of the edit): the step's first frame, as before.
    const first = Math.min(...m.steps.filter((s) => s.key === step.key).map((s) => s.from));
    expect(placePins(m, [{ id: 'a', status: 'open', run_id: 'r1', anchor }], { run_id: 'r1', edit: 'scenario' }).placed).toEqual([{ id: 'a', status: 'open', frame: first, by: 'step' }]);
    // A frame outside this plan, or of another take: never used.
    expect(placePins(m, [{ id: 'a', status: 'open', run_id: 'r1', anchor, frame: m.frames + 5 }], { run_id: 'r1', edit: 'scenario' }).placed[0].by).toBe('step');
    expect(placePins(m, [{ id: 'a', status: 'open', run_id: 'other', anchor, frame: inside }], { run_id: 'r1', edit: 'run' })).toEqual({ placed: [], elsewhere: ['a'] });
  });
});

describe('caption_component in the planner (L4.5)', () => {
  it('the scenario\'s caption component wins over the theme, a render override over it; an unknown one falls back with a warning', async () => {
    const t = load('quote');
    const themeId = clips(await plan(t))[0].caption!.id;
    expect(themeId).not.toBe('studio/caption-overlay');
    t.video = { ...t.video, caption_component: 'studio/caption-overlay' };
    const own = clips(await plan(t));
    for (const c of own) expect(c.caption, c.id).toMatchObject({ id: 'studio/caption-overlay', source: 'scenario' });
    const over = clips(await plan(t, { components: { caption: themeId } }));
    for (const c of over) expect(c.caption, c.id).toMatchObject({ id: themeId, source: 'override' });
    t.video = { ...t.video, caption_component: 'acme/no-such-caption' };
    const missing = await plan(t);
    for (const c of clips(missing)) expect(c.caption?.id, c.id).toBe(themeId);
    expect(missing.warnings.join('\n')).toMatch(/acme\/no-such-caption/);
    // A caption component off (captions: false) stays off whatever the scenario says.
    t.video = { ...t.video, caption_component: 'studio/caption-overlay' };
    for (const c of clips(await plan(t, { captions: false }))) expect(c.caption).toBeNull();
  });
});

describe('a 4-minute plan (critique B13: measured)', () => {
  it('its model is built in a few milliseconds and stays small', async () => {
    const entries = Array.from({ length: 8 }, (_, k) => ({
      id: `s${k}`,
      t_start: k * 30,
      t_end: k * 30 + 30,
      open_end: k * 30 + 0.5,
      still: [k * 30 + 0.5, k * 30 + 2] as [number, number],
      caption: { text: `Scene ${k}` },
      steps: Array.from({ length: 12 }, (_, i) => ({ action: 'click' as const, t_start: k * 30 + 2 + i * 2.2, t_end: k * 30 + 3 + i * 2.2, ...(i === 5 ? { mark: `m${k}` } : {}) })),
    }));
    const t = synthTimeline({ entries, duration: 240 });
    const p = await plan(t);
    expect(p.durationInFrames).toBeGreaterThan(200 * 30);
    const t0 = performance.now();
    const m = timelineOf(p, { timeline: t });
    const ms = performance.now() - t0;
    const size = JSON.stringify(m).length;
    console.log(`4-minute plan: ${p.durationInFrames} frames, plan ${JSON.stringify(p).length} B, model ${size} B, timelineOf ${ms.toFixed(1)} ms`);
    expect(m.steps).toHaveLength(clips(p).reduce((n, c) => n + c.steps.length, 0));
    expect(m.steps.filter((x) => x.step >= 0)).toHaveLength(96);
    expect(ms).toBeLessThan(50);
    expect(size).toBeLessThan(60_000);
  });
});
