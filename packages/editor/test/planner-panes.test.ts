/**
 * L2.11 planner: multi-page clips. Two real fixture timelines (projects/northfield-fixture): live-quote (two laptop
 * pages side by side, studio/layout-split) and phone-and-desktop (a desktop page and a phone, studio/layout-pip). Each
 * page of a scene plays from the same source time on its own track, in its own pane; the acting page follows the steps
 * (`on:`); tutorial overlays sit on the pane of their event's page; the picture-in-picture inset never covers what the
 * main page acts on now or next; single-pane layouts and multi-page layouts fall back sensibly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import {
  ACTING_EASE_S,
  actingWeights,
  captionBandOver,
  drawnOverlayBox,
  drawsUrl,
  focusBox,
  insetCornerRects,
  insetHole,
  insetRectAt,
  layoutPaneRectsAt,
  mapPaneRect,
  paneIndexOf,
  paneSource,
  planEdit,
  planInsetTrack,
  stepBoxes,
} from '@retake/editor';
import type { ClipSegment, EditOverrides, EditPlan } from '@retake/editor';
import type { Timeline, TimelineEvent } from '@retake/core';
import { FIXTURES, fixtureProject, template } from '@retake/test-support/timeline';
import { REPO } from '@retake/test-support/repo';

const RUN = '/virtual/runs/r';
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
let registry: ComponentRegistry;

async function plan(timeline: Timeline, overrides: EditOverrides = {}, theme: 'editorial' | 'motion' = 'editorial'): Promise<EditPlan> {
  return planEdit({ timeline, template: await template(theme), project: await fixtureProject(), registry, captureFile: `${RUN}/capture.mp4`, overrides });
}
const clips = (p: EditPlan) => p.segments.filter((s): s is ClipSegment => s.kind === 'clip');
const clipOf = (p: EditPlan, id: string) => clips(p).find((s) => s.id === id)!;
/** The clip frame showing capture time `t` (s). */
const frameAt = (p: EditPlan, c: ClipSegment, t: number) => {
  const i = c.srcFrames.findIndex((s) => s >= Math.round(t * p.fps));
  return i < 0 ? c.srcFrames.length - 1 : i;
};
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

describe('multi-page clips: split screen (live-quote)', () => {
  it('each page in its pane, on its own track, both from the same source time (R-MPC-01, R-MPC-02)', async () => {
    const t = load('live-quote');
    const p = await plan(t);
    expect(Object.keys(p.tracks ?? {}).sort()).toEqual(['buyer', 'supplier']);
    expect(p.tracks!.buyer).toMatchObject({ file: `${RUN}/capture-buyer.mp4`, cssWidth: 1440, cssHeight: 900 });
    expect(p.tracks!.supplier.file).toBe(`${RUN}/capture-supplier.mp4`);
    // Every track on the capture's frame grid.
    for (const tr of Object.values(p.tracks!)) expect(tr.frames).toBe(p.source.frames);
    const multi = clips(p).filter((c) => c.panes);
    expect(multi.map((c) => c.id)).toEqual(['request', 'delivery', 'arrives', 'proposal']);
    for (const c of multi) {
      expect(c.component.id).toBe('studio/layout-split');
      expect(c.panes!.map((x) => [x.page, x.track, x.label])).toEqual([
        ['buyer', 'buyer', 'Café · shop'],
        ['supplier', 'supplier', 'Roaster · console'],
      ]);
      // One time map for the clip: both panes show the same capture instant.
      expect(c.srcFrames.length).toBe(c.durationInFrames);
      const [a, b] = c.panes!.map((x) => x.layout.capture);
      expect(overlaps(a, b)).toBe(false);
      expect(a.y).toBe(b.y);
      expect(a.w / a.h).toBeCloseTo(1440 / 900, 1);
      expect(paneSource(p, c.panes![1]).file).toBe(`${RUN}/capture-supplier.mp4`);
      // The layout receives both panes per frame, labels and URLs included.
      const rects = layoutPaneRectsAt(p, c, 0);
      expect(rects.map((r) => r.page)).toEqual(['buyer', 'supplier']);
      // A run without display URLs (L1.7): the pane's URL is kept (marked hidden), never handed to the layout.
      expect(c.panes![1].urls[0]).toMatchObject({ url: expect.stringMatching(/^http:\/\/localhost:4401\/quotes/), hidden: true });
      expect(rects[1].url).toBeUndefined();
    }
    // Editorial frames the panes as cards (no browser bar): nothing warns about the hidden URLs.
    expect(p.warnings.filter((w) => /display URL/.test(w))).toEqual([]);
    // With the run's display table each pane's bar gets its display URL.
    const shown = await plan({
      ...load('live-quote'),
      environment: {
        name: 'local',
        access: 'read-write',
        display: [
          { page: 'console', url: 'http://localhost:4401', display: 'https://console.northfield.example' },
          { page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' },
        ],
      },
    });
    for (const c of clips(shown).filter((x) => x.panes)) {
      const rects = layoutPaneRectsAt(shown, c, 0);
      expect(rects[0].url).toMatch(/^https:\/\/shop\.northfield\.example\//);
      expect(rects[1].url).toMatch(/^https:\/\/console\.northfield\.example\/quotes/);
    }
    // The caption sits under the pair, the brand mark at its right.
    const c0 = multi[0];
    expect(c0.layout.caption!.y).toBeGreaterThan(c0.panes![0].layout.capture.y + c0.panes![0].layout.capture.h);
  });

  it('the acting page follows the steps; overlays belong to their page’s pane (R-MPC-05, R-MPC-07)', async () => {
    const p = await plan(load('live-quote'));
    const acting = (id: string) => clipOf(p, id).acting!.map((a) => a.pane);
    expect(acting('request')[0]).toBe(0);
    expect(acting('arrives')).toContain(1);
    // Joined to "delivery" (the buyer acted last), the supplier — the page of its opening still and first step —
    // takes over from the clip's start (the emphasis eases from the buyer), not at its first step after the still.
    const arrives0 = clipOf(p, 'arrives');
    expect(arrives0.acting).toEqual([
      { frame: 0, pane: 0 },
      { frame: 1, pane: 1 },
    ]);
    expect(actingWeights(arrives0, Math.round(ACTING_EASE_S * p.fps) + 1, p.fps)).toEqual([0, 1]);
    expect(clipOf(p, 'proposal').acting).toEqual([
      { frame: 0, pane: 1 },
      { frame: 1, pane: 0 },
    ]);
    expect(acting('proposal')).toContain(0);
    // Step badges (tutorial: steps) on the pane of the page clicked, inside it.
    for (const c of clips(p).filter((x) => x.panes)) {
      for (const o of c.overlays.filter((x) => x.tutorial === 'steps')) {
        expect(o.pane, `${c.id} step ${o.step}`).toBeDefined();
        const box = mapPaneRect(p, c, o.pane!, o.from - c.from, o.anchor!.bbox!);
        expect(inside(box, c.panes![o.pane!].layout.capture), `${c.id} step ${o.step} ${JSON.stringify(box)}`).toBe(true);
      }
    }
    const arrives = clipOf(p, 'arrives');
    expect(arrives.overlays.filter((o) => o.tutorial === 'steps').every((o) => o.pane === 1)).toBe(true);
    expect(
      clipOf(p, 'request')
        .overlays.filter((o) => o.tutorial === 'steps')
        .every((o) => o.pane === 0),
    ).toBe(true);
    // Numbering per scene across both pages.
    expect(
      clipOf(p, 'proposal')
        .overlays.filter((o) => o.tutorial === 'steps')
        .map((o) => o.component.slots.number),
    ).toEqual(['1', '2']);
  });

  it('badges are numbered in time order when a scene’s steps go back and forth between its pages (per scene and per video)', async () => {
    const t = load('live-quote');
    // The café's second step acts on the roaster's page instead: the scene goes buyer → supplier → buyer → buyer.
    for (const e of t.events) if (e.scene === 'request' && e.step === 1) e.page = 'supplier';
    const badges = (p: EditPlan) =>
      clips(p)
        .flatMap((c) => c.overlays.filter((o) => o.tutorial === 'steps').map((o) => ({ at: c.from + o.from, clip: c.id, step: o.step, pane: o.pane, number: o.component.slots.number })))
        .sort((a, b) => a.at - b.at);
    const scene = badges(await plan(t)).filter((b) => b.clip === 'request');
    expect(scene.map((b) => [b.step, b.pane, b.number])).toEqual([
      [0, 0, '1'],
      [1, 1, '2'],
      [2, 0, '3'],
      [3, 0, '4'],
    ]);
    const video = badges(await plan(t, { tutorial: { steps: { params: { numbering: 'video' } } } }));
    expect(video.map((b) => b.number)).toEqual(video.map((_, i) => String(i + 1)));
  });
});

describe('multi-page clips: picture in picture (phone-and-desktop)', () => {
  it('the landscape page is the main one, the phone the inset (mobile, with its own track)', async () => {
    const p = await plan(load('phone-and-desktop'));
    const c = clipOf(p, 'phone');
    expect(c.component.id).toBe('studio/layout-pip');
    expect(c.panes!.map((x) => x.page)).toEqual(['desk', 'phone']);
    expect(c.inset!.pane).toBe(1);
    expect(p.tracks!.phone).toMatchObject({ cssWidth: 390, cssHeight: 844, mobile: true });
    const rects = layoutPaneRectsAt(p, c, 0);
    expect(rects[1]).toMatchObject({ page: 'phone', inset: true, mobile: true });
    expect(inside(rects[1].screen, c.panes![0].layout.capture)).toBe(true);
    expect(rects[1].screen.w / rects[1].screen.h).toBeCloseTo(390 / 844, 2);
  });

  it('the inset never covers the main page’s current or next target (R-MPC-03)', async () => {
    for (const theme of ['editorial', 'motion'] as const) {
      const p = await plan(load('phone-and-desktop'), {}, theme);
      for (const c of clips(p).filter((x) => x.inset)) {
        const main = c.panes!.findIndex((_, i) => i !== c.inset!.pane);
        const mainPage = c.panes![main].page;
        const steps = load('phone-and-desktop').events.filter((e) => e.scene === c.id && e.step >= 0 && e.status !== 'skipped');
        const check = (e: TimelineEvent, at: number) => {
          for (const b of stepBoxes(e)) {
            const f = frameAt(p, c, at);
            const target = mapPaneRect(p, c, main, f, focusBox(b, e.point));
            const inset = insetRectAt(c, f, p.fps)!;
            expect(overlaps(inset, target), `${theme} ${c.id} step ${e.step} at ${at.toFixed(2)} s: inset ${JSON.stringify(inset)} over ${JSON.stringify(target)}`).toBe(false);
          }
        };
        for (let i = 0; i < steps.length; i++) {
          const e = steps[i];
          if (paneIndexOf(c, e.page) !== main && !(e.page === undefined && mainPage === c.panes![0].page)) continue;
          check(e, e.t_start);
          check(e, (e.t_click ?? e.t_end) as number);
        }
      }
    }
  });

  it('a caption band over the screen goes below a split (it would straddle both pages); a pip keeps it over its main page', async () => {
    const lq = await plan(load('live-quote'), {}, 'motion');
    const c = clipOf(lq, 'request');
    expect(c.caption?.id).toBe('studio/caption-overlay');
    expect(c.caption?.params.position).toBe('area');
    expect(lq.notes.join('\n')).toMatch(/the caption band goes below the pages/);
    const pd = await plan(load('phone-and-desktop'), {}, 'motion');
    expect(clipOf(pd, 'desk').caption?.params.position).toBe('over');
  });

  it('browser bars on the panes (motion themes) never draw a local URL: hidden, one plan warning per page (L1.7)', async () => {
    const lq = await plan(load('live-quote'), {}, 'motion');
    const c = clipOf(lq, 'request');
    expect(c.component.params.chrome).toBe(true);
    expect(layoutPaneRectsAt(lq, c, 0).map((r) => r.url)).toEqual([undefined, undefined]);
    expect(lq.warnings.filter((w) => /display URL/.test(w)).sort()).toEqual([
      expect.stringMatching(/^a local URL outside the pages of environment \(unknown\) has no display URL \(http:\/\/localhost:4401\)/),
      expect.stringMatching(/^a local URL outside the pages of environment \(unknown\) has no display URL \(http:\/\/localhost:4402\)/),
    ]);
    // A picture in picture draws the bar of its main page only (the inset is a phone).
    const pd = await plan(load('phone-and-desktop'), {}, 'motion');
    const desk = clipOf(pd, 'desk');
    expect(drawsUrl(desk, desk.inset!.pane)).toBe(false);
    expect(drawsUrl(desk, 1 - desk.inset!.pane)).toBe(true);
    expect(drawsUrl(desk)).toBe(false);
  });

  it('overlays of the main page are drawn around the inset (clip-path with the inset as a hole), not over it', async () => {
    const p = await plan(load('phone-and-desktop'));
    const c = clipOf(p, 'desk');
    const r = insetRectAt(c, 40, p.fps)!;
    const hole = insetHole(p, c, { pane: 0 }, 40)!;
    expect(hole).toMatch(/^path\(evenodd, 'M0 0H1920V1080H0Z M[\d.]+ [\d.]+h[\d.]+v[\d.]+h-[\d.]+Z'\)$/);
    const [x, y] = hole
      .match(/Z M([\d.]+) ([\d.]+)h/)!
      .slice(1)
      .map(Number);
    expect(x).toBeLessThan(r.x);
    expect(y).toBeLessThan(r.y);
    expect(insetHole(p, c, { pane: 1 }, 40)).toBeUndefined(); // the inset's own overlays
    expect(insetHole(p, clipOf(await plan(load('live-quote')), 'request'), { pane: 0 }, 40)).toBeUndefined(); // a split
  });

  it('motion themes grow the inset while its page acts, never into a caption band over the screen; editorial keeps its size', async () => {
    const ed = clipOf(await plan(load('phone-and-desktop')), 'phone');
    expect(ed.inset!.grow).toBe(1);
    // Motion, landscape: the band over the screen leaves the top-right phone no room to grow (it would cross the band).
    const mo = await plan(load('phone-and-desktop'), {}, 'motion');
    for (const c of clips(mo).filter((x) => x.inset)) {
      const band = captionBandOver(mo, c)!;
      expect(band).toBeDefined();
      for (let f = 0; f < c.durationInFrames; f += 3) expect(overlaps(insetRectAt(c, f, mo.fps)!, band), `${c.id} frame ${f}`).toBe(false);
    }
    expect(mo.notes.join('\n')).toMatch(/the inset does not grow while its page acts: it keeps clear of the caption band/);
    // Without captions (no band), and in vertical (the band goes below the card), it grows ×1.18.
    const bare = load('phone-and-desktop');
    for (const sc of bare.scenes) delete sc.caption;
    expect(clipOf(await plan(bare, {}, 'motion'), 'phone').inset!.grow).toBeCloseTo(1.18);
    expect(clipOf(await plan(load('phone-and-desktop'), { variant: 'vertical' }, 'motion'), 'phone').inset!.grow).toBeCloseTo(1.18);
  });

  it('the phone’s step badges stay inside the phone; its key caps keep clear of the main page’s next target (R-MPC-07, R-TUT-06)', async () => {
    const p = await plan(load('phone-and-desktop'));
    for (const c of clips(p).filter((x) => x.inset)) {
      for (const o of c.overlays.filter((x) => x.tutorial === 'steps' && x.pane === c.inset!.pane)) {
        for (let local = 0; local < o.durationInFrames; local += 4) {
          const box = drawnOverlayBox(p, c, o, local)!;
          expect(inside(box, insetRectAt(c, o.from + local, p.fps)!), `${c.id} step ${o.step} badge ${JSON.stringify(box)}`).toBe(true);
        }
      }
    }
    // The phone presses Enter (key caps, drawn over the desk: the phone is too small for them) right before the
    // desk clicks a row at the bottom of its page: the caps take the other row.
    const t = load('phone-and-desktop');
    for (const e of t.events) {
      if (e.scene !== 'desk') continue;
      if (e.step === 1) {
        Object.assign(e, { page: 'phone', action: 'press', t_click: 23.5, data: { key: 'Enter' }, tutorial: { shortcuts: true } });
        delete e.target;
        delete e.point;
      }
      if (e.step === 2) {
        e.target = { desc: 'row', bbox: { x: 760, y: 990, w: 300, h: 50 } };
        e.point = { x: 900, y: 1015 };
      }
    }
    const q = await plan(t);
    const c = clipOf(q, 'desk');
    const caps = c.overlays.find((o) => o.tutorial === 'shortcuts')!;
    expect(caps.pane).toBe(c.inset!.pane);
    expect(caps.clear?.some((k) => k.pane === 0)).toBe(true);
    const click = t.events.find((e) => e.scene === 'desk' && e.step === 2)!;
    for (let local = 0; local < caps.durationInFrames; local += 3) {
      const plate = drawnOverlayBox(q, c, caps, local)!;
      const target = mapPaneRect(q, c, 0, caps.from + local, focusBox(click.target!.bbox!, click.point));
      expect(overlaps(plate, target), `frame ${local}: ${JSON.stringify(plate)} over ${JSON.stringify(target)}`).toBe(false);
    }
  });

  it('the inset glides away for the main page’s next step only once its own page’s step is over (R-MPC-03)', () => {
    const main = { x: 180, y: 40.25, w: 1560, h: 877.5 };
    const corners = insetCornerRects(main, { x: 1420, y: 267, w: 284, h: 615 });
    const fps = 30;
    const ev = (step: number, page: string, t0: number, t1: number, tc: number, bbox: { x: number; y: number; w: number; h: number }): TimelineEvent =>
      ({ scene: 's', scene_index: 0, step, action: 'click', t_start: t0, t_end: t1, t_click: tc, page, status: 'ok', target: { desc: 'x', bbox } }) as TimelineEvent;
    const steps = [
      ev(0, 'phone', 0, 2, 1.5, { x: 100, y: 300, w: 120, h: 40 }),
      ev(1, 'phone', 2, 4, 3.5, { x: 100, y: 500, w: 120, h: 40 }),
      ev(2, 'desk', 4.5, 6, 5.5, { x: 1600, y: 600, w: 120, h: 40 }),
    ];
    const mapMain = (_f: number, b: { x: number; y: number; w: number; h: number }) => ({
      x: main.x + (b.x * main.w) / 1920,
      y: main.y + (b.y * main.h) / 1080,
      w: (b.w * main.w) / 1920,
      h: (b.h * main.h) / 1080,
    });
    const out = planInsetTrack({ steps, mainPage: 'desk', insetPage: 'phone', rel: (t) => Math.round(t * fps), n: 200, fps, mapMain, corners, preferred: 'bottom-right', grow: 1, clearance: 14 });
    expect(out.track.map((k) => [k.at, k.corner])).toEqual([
      [0, 'bottom-right'],
      [4 * fps, 'bottom-left'],
    ]);
  });
});

describe('multi-page clips: layout choice and variants', () => {
  it('a single-pane frame for a multi-page scene picks split or pip from the pages’ aspects; split/pip on single-page scenes falls back', async () => {
    const lq = await plan(load('live-quote'), { frame: 'card' });
    expect(clipOf(lq, 'request').component.id).toBe('studio/layout-split');
    expect(lq.notes.join('\n')).toMatch(/films 2 pages: studio\/layout-split \(studio\/layout-card shows one page\)/);
    const pd = await plan(load('phone-and-desktop'), { frame: 'card' });
    expect(clipOf(pd, 'phone').component.id).toBe('studio/layout-pip');
    // Same pages, swapped: a split of a desktop page and a phone works too.
    const pdSplit = await plan(load('phone-and-desktop'), { frame: 'split' });
    expect(clipOf(pdSplit, 'phone').component.id).toBe('studio/layout-split');
    expect(clipOf(pdSplit, 'phone').inset).toBeUndefined();
    // A multi-page layout asked for single-page scenes: the theme's own layout.
    const single = await plan(load('signup'), { frame: 'split' });
    for (const c of clips(single)) {
      expect(c.panes).toBeUndefined();
      expect(c.component.id).not.toMatch(/layout-(split|pip)/);
    }
  });

  it('vertical: split stacks the pages (each reframed in its pane); pip keeps the phone inside the main page', async () => {
    const lq = await plan(load('live-quote'), { variant: 'vertical' });
    const c = clipOf(lq, 'request');
    const [a, b] = c.panes!.map((x) => x.layout.capture);
    expect(a.y + a.h).toBeLessThan(b.y);
    expect(c.panes![0].layout.crop).toBeDefined();
    expect(c.panes![0].reframe?.length).toBe(c.durationInFrames);
    const pd = await plan(load('phone-and-desktop'), { variant: 'vertical' });
    const d = clipOf(pd, 'desk');
    for (let f = 0; f < d.durationInFrames; f += 15) expect(inside(insetRectAt(d, f, pd.fps)!, d.panes![0].layout.capture)).toBe(true);
    const sq = await plan(load('live-quote'), { variant: 'square' });
    const s = clipOf(sq, 'arrives');
    const [sa, sb] = s.panes!.map((x) => x.layout.capture);
    expect(overlaps(sa, sb)).toBe(false);
    expect(sa.x).toBeLessThan(sb.x);
  });
});

describe('multi-page clips: held page loads (R-ISS-08)', () => {
  it('a multi-page run cuts the loads its own tracks held, not the main capture’s', async () => {
    const t = load('live-quote');
    // A load held on the buyer's track during the "request" scene's steps, and one on the main capture at another time.
    const buyer = t.tracks!.find((tr) => tr.id === 'buyer')!;
    buyer.loading = [{ t_start: 5.3, t_end: 6.1, page: 'buyer', until: 'paint', held_frames: 40 }];
    t.loading = [{ t_start: 8, t_end: 9, page: 'buyer', until: 'paint', held_frames: 50 }];
    const p = await plan(t);
    const request = clipOf(p, 'request');
    expect(request.trims.map((x) => [x.src_from_s, x.src_to_s])).toEqual([[5.3, 6.1]]);
    expect(p.notes).toContain('"request": page load 5.30 s–6.10 s of the capture cut (the capture held the previous frame until the new page painted)');
    // Without loads: no trim there.
    expect(clipOf(await plan(load('live-quote')), 'request').trims).toEqual([]);
  });

  it('a load held on one page is not cut where another page acts: the buyer’s steps play on, the supplier keeps its frame', async () => {
    const t = load('live-quote');
    // The supplier's page loads during the buyer's clicks (steps 0 and 1, 3.47–6.86 s): nothing of it is cut.
    t.tracks!.find((tr) => tr.id === 'supplier')!.loading = [{ t_start: 5, t_end: 5.4, page: 'supplier', until: 'paint', held_frames: 20 }];
    const p = await plan(t);
    expect(clipOf(p, 'request').trims).toEqual([]);
    expect(p.notes.some((n) => n.includes('page load 5.00 s'))).toBe(false);
  });
});
