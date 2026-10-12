/**
 * L2.10 planner: tutorial overlays fed by the timeline (R-TUT-01…05) and the media of story cards (R-STO-01…06) — on
 * the real timelines of the fixture's `signup` (tutorial switches on: run 20261012-034207-signup) and `highlights`
 * (capture_text, frames by mark / scene, a CSV: run 20261012-034247-highlights) scenarios, with the built-in library.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry, PictureMedia, TableMedia, TextMedia } from '@demo-studio/components';
import {
  PLAN_ASSET_SCHEME,
  TUTORIAL_TIMING,
  captionBandOver,
  loupePlacement,
  overlayAvoid,
  shortcutRow,
  loupeRegion,
  mapSourceRect,
  planComponentIds,
  planEdit,
  planFileRefs,
  planInputFiles,
  trackBoxAt,
  imageFileSize,
} from '@demo-studio/editor';
import type { CardSegment, ClipSegment, EditOverrides, EditPlan, OverlayUse, PlanInputFile } from '@demo-studio/editor';
import type { Timeline } from '@demo-studio/core';
import { FIXTURES, REPO, fixtureProject, template } from './helpers.js';

const RUN = '/virtual/runs/r';
const csv = 'month,quote requests,accepted\nJun,42,19\nJul,51,24\n';
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
let registry: ComponentRegistry;

async function plan(timeline: Timeline, overrides: EditOverrides = {}, files?: Record<string, PlanInputFile>): Promise<EditPlan> {
  return planEdit({ timeline, template: await template('editorial'), project: await fixtureProject(), registry, captureFile: `${RUN}/capture.mp4`, overrides, ...(files ? { files } : {}) });
}
const clipOf = (p: EditPlan, id: string) => p.segments.find((s) => s.id === id) as ClipSegment;
const cardOf = (p: EditPlan, id: string) => p.segments.find((s) => s.id === id) as CardSegment;
const uses = (c: ClipSegment, t: OverlayUse['tutorial']) => c.overlays.filter((o) => o.tutorial === t);

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

describe('tutorial overlays from the timeline (signup)', () => {
  it('nothing without switches (the L2.9 signup timeline)', async () => {
    const p = await plan(load('signup'));
    expect(p.tutorial).toBeUndefined();
    expect(p.segments.flatMap((s) => (s.kind === 'clip' ? s.overlays : [])).every((o) => !o.tutorial)).toBe(true);
  });

  it('key caps on every key press, timed on the real press (R-TUT-01)', async () => {
    const t = load('signup-tutorial');
    const p = await plan(t);
    const signup = clipOf(p, 'signup');
    const welcome = clipOf(p, 'welcome');
    const caps = [...uses(signup, 'shortcuts'), ...uses(welcome, 'shortcuts')];
    expect(caps.map((o) => o.component.slots.keys)).toEqual(['Tab', 'Tab', 'Meta+K', 'Enter']);
    expect(caps.every((o) => o.component.id === 'studio/overlay-shortcut')).toBe(true);
    // The press frame (`moment`) is the output frame of the event's t_click (the Enter: data.t_enter).
    const presses = t.events.filter((e) => e.action === 'press');
    expect(presses).toHaveLength(3);
    const lead = Math.round(TUTORIAL_TIMING.shortcut_lead_s * p.fps);
    for (const o of caps) expect(o.moment).toBe(lead);
    // Tab after Tab: the first caps leave as the next ones come (no two on screen at once).
    const [a, b] = uses(signup, 'shortcuts');
    expect(a.from + a.durationInFrames).toBeLessThanOrEqual(b.from + Math.round(0.15 * p.fps));
  });

  it('a spotlight per run of steps, gliding from target to target, drawn under everything (R-TUT-02)', async () => {
    const p = await plan(load('signup-tutorial'));
    const s = uses(clipOf(p, 'signup'), 'spotlight');
    expect(s).toHaveLength(1);
    expect(s[0].layer).toBe('screen');
    expect(clipOf(p, 'signup').overlays[0]).toBe(s[0]);
    // The three fields and the button, in order.
    expect(s[0].track?.map((k) => Math.round(k.bbox.y))).toEqual([471, 553, 636, 698]);
    expect(s[0].track?.[0].at).toBe(0);
    // Between two keys the box glides (smoothstep), then holds.
    const k1 = s[0].track![1];
    const mid = trackBoxAt(s[0], k1.at + Math.round(0.2 * p.fps), p.fps)!;
    expect(mid.y).toBeGreaterThan(471);
    expect(mid.y).toBeLessThan(553);
    expect(trackBoxAt(s[0], k1.at + p.fps, p.fps)!.y).toBeCloseTo(553.13, 1);
    // A click ends the spotlight soon after it (the page changes): before the click step's end.
    const clip = clipOf(p, 'signup');
    const clickSpan = clip.steps.find((st) => st.step === 5)!;
    expect(s[0].from + s[0].durationInFrames).toBeLessThanOrEqual(clickSpan.to);
    expect(s[0].from + s[0].durationInFrames).toBeGreaterThan(clickSpan.from);
  });

  it('numbered badges on the clicked steps, per scene (R-TUT-03)', async () => {
    const p = await plan(load('signup-tutorial'));
    expect(uses(clipOf(p, 'signup'), 'steps').map((o) => [o.step, o.component.slots.number])).toEqual([
      [0, '1'],
      [5, '2'],
    ]);
    expect(uses(clipOf(p, 'welcome'), 'steps').map((o) => [o.step, o.component.slots.number])).toEqual([[5, '1']]);
    for (const o of uses(clipOf(p, 'signup'), 'steps')) {
      expect(o.anchor?.bbox?.w).toBeGreaterThan(0);
      expect(o.moment).toBeGreaterThan(0);
      expect(o.durationInFrames - o.moment!).toBe(Math.round(TUTORIAL_TIMING.badge_after_s * p.fps));
    }
    // numbering: video
    const v = await plan(load('signup-tutorial'), { tutorial: { steps: { params: { numbering: 'video' } } } });
    expect(uses(clipOf(v, 'welcome'), 'steps')[0].component.slots.number).toBe('3');
  });

  it('one loupe over the three fields, its region gliding from field to field (R-TUT-04)', async () => {
    const t = load('signup-tutorial');
    const p = await plan(t);
    const l = uses(clipOf(p, 'signup'), 'loupe');
    expect(l).toHaveLength(1);
    expect(l[0].region).toEqual(loupeRegion(t.events.find((e) => e.scene === 'signup' && e.step === 0)!.target!.bbox!, { w: 1920, h: 1080 }));
    expect(l[0].track).toHaveLength(3);
    expect(l[0].region!.h).toBeLessThan(60);
    // The search field of the welcome scene (typed after ⌘K, no `into`: the runner measured the focused field).
    const w = uses(clipOf(p, 'welcome'), 'loupe');
    expect(w).toHaveLength(1);
    expect(w[0].anchor?.bbox?.y).toBeLessThan(40);
    // In vertical, the reframe keeps the loupe's field in view.
    const vert = await plan(t, { variant: 'vertical' });
    for (const id of ['signup', 'welcome']) {
      const c = clipOf(vert, id);
      for (const o of uses(c, 'loupe')) {
        for (const k of [0, Math.floor(o.durationInFrames / 2), o.durationInFrames - 1]) {
          const box = trackBoxAt(o, k, vert.fps)!;
          const r = mapSourceRect(vert, c, o.from + k, box);
          const cap = c.layout.capture;
          expect(r.x + r.w / 2, `${id} loupe frame ${k}`).toBeGreaterThanOrEqual(cap.x);
          expect(r.x + r.w / 2).toBeLessThanOrEqual(cap.x + cap.w);
        }
      }
    }
  });

  it('a chapter progress bar between the intro and the outro (R-TUT-05)', async () => {
    const p = await plan(load('signup-tutorial'));
    const pr = p.tutorial?.progress;
    expect(pr?.component.id).toBe('studio/overlay-progress');
    expect(pr?.mode).toBe('scenes');
    const intro = p.segments.find((s) => s.kind === 'intro')!;
    expect(pr!.from).toBe(p.segments[1].from);
    expect(pr!.from).toBeLessThan(intro.from + intro.durationInFrames);
    expect(pr!.chapters.map((c) => c.id)).toEqual(['signup', 'inbox', 'lockscreen', 'badge', 'welcome']);
    expect(pr!.chapters.map((c) => c.label)).toEqual(['Sign up', 'inbox', 'On the go', 'Notifications', 'Confirmed']);
    for (let i = 1; i < pr!.chapters.length; i++) expect(pr!.chapters[i].from).toBe(pr!.chapters[i - 1].to);
    expect(planComponentIds(p)).toContain('studio/overlay-progress');
    // chapters = cards
    const cards = await plan(load('signup-tutorial'), { tutorial: { progress: 'cards' } });
    expect(cards.tutorial?.progress?.chapters.map((c) => c.id)).toEqual(['signup', 'inbox', 'lockscreen', 'badge']);
    expect(p.tutorial?.uses).toEqual({ spotlight: 2, steps: 3, loupe: 2, shortcuts: 4, progress: 1 });
  });

  it('switches: render override, scene and step levels, component swaps', async () => {
    const off = await plan(load('signup-tutorial'), { tutorial: false });
    expect(off.tutorial).toBeUndefined();
    expect(off.notes.join('\n')).toMatch(/tutorial overlays disabled/);

    const t = load('signup-tutorial');
    t.scenes.find((s) => s.id === 'welcome')!.tutorial = false;
    t.events.find((e) => e.scene === 'signup' && e.step === 0)!.tutorial = { spotlight: false, steps: false };
    const p = await plan(t);
    expect(clipOf(p, 'welcome').overlays.filter((o) => o.tutorial)).toEqual([]);
    expect(uses(clipOf(p, 'signup'), 'steps').map((o) => o.component.slots.number)).toEqual(['1']);
    expect(uses(clipOf(p, 'signup'), 'spotlight')[0].track?.[0].bbox.y).toBeCloseTo(553.13, 1);

    const swapped = await plan(load('signup-tutorial'), { components: { 'tutorial-shortcuts': { id: 'studio/overlay-shortcut', params: { platform: 'windows' } } } });
    expect(uses(clipOf(swapped, 'signup'), 'shortcuts')[0].component).toMatchObject({ source: 'override', params: { platform: 'windows' } });
    expect(swapped.warnings.join('\n')).not.toMatch(/tutorial-shortcuts/);

    // Spotlight on clicks only: one window per click.
    const clicks = await plan(load('signup-tutorial'), { tutorial: { spotlight: 'clicks' } });
    expect(uses(clipOf(clicks, 'signup'), 'spotlight').map((o) => Math.round(o.anchor!.bbox!.y))).toEqual([471, 698]);
  });

  it('key caps and the loupe keep clear of a caption over the screen (motion theme)', async () => {
    const t = load('signup-tutorial');
    const motion = planEdit({ timeline: t, template: await template('motion'), project: await fixtureProject(), registry, captureFile: `${RUN}/capture.mp4` });
    const signup = clipOf(motion, 'signup');
    expect(signup.caption?.params?.position).toBe('over');
    const band = captionBandOver(motion, signup)!;
    expect(band).toBeDefined();
    // Inside the capture, at its bottom.
    expect(band.y + band.h).toBeLessThanOrEqual(signup.layout.capture.y + signup.layout.capture.h);
    for (const o of uses(signup, 'shortcuts')) expect(overlayAvoid(motion, signup, o)).toEqual([band]);
    // The loupe also keeps clear of the key caps' row (above the band) and, its fields running down to that row, keeps
    // one side — above — for its whole glide.
    const [loupe] = uses(signup, 'loupe');
    const row = shortcutRow(motion, signup, uses(signup, 'shortcuts')[0])!;
    expect(row.y + row.h).toBeLessThanOrEqual(band.y);
    const avoid = overlayAvoid(motion, signup, loupe);
    expect(avoid).toEqual([band, row]);
    expect(loupePlacement(motion, signup, loupe, avoid)).toBe('above');
    // The editorial caption sits under the card: the caps stay at the bottom of the capture, the loupe below the fields.
    const editorial = await plan(t);
    const eSignup = clipOf(editorial, 'signup');
    expect(captionBandOver(editorial, eSignup)).toBeUndefined();
    expect(overlayAvoid(editorial, eSignup, uses(eSignup, 'shortcuts')[0])).toEqual([]);
    const eAvoid = overlayAvoid(editorial, eSignup, uses(eSignup, 'loupe')[0]);
    expect(eAvoid).toHaveLength(1);
    expect(eAvoid[0].y + eAvoid[0].h).toBeGreaterThan(eSignup.layout.capture.y + eSignup.layout.capture.h - 40);
    expect(loupePlacement(editorial, eSignup, uses(eSignup, 'loupe')[0], eAvoid)).toBeUndefined();
  });

  it('what cannot be shown is reported (review aware)', async () => {
    const t = load('signup-tutorial');
    const ev = t.events.find((e) => e.scene === 'signup' && e.step === 5)!;
    delete ev.target;
    t.events.find((e) => e.scene === 'signup' && e.step === 6)!.tutorial = { spotlight: true };
    const p = await plan(t);
    expect(p.tutorial?.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: 'steps', scene: 'signup', step: 5, reason: 'no clicked target box was recorded' }),
        expect.objectContaining({ feature: 'spotlight', scene: 'signup', step: 6, reason: 'a wait_for step has no target to spotlight' }),
      ]),
    );
    expect(p.tutorial!.skipped.every((s) => s.frame !== undefined)).toBe(true);
    expect(p.warnings.join('\n')).toMatch(/scene "signup" step 5: no steps — no clicked target box was recorded/);
  });
});

describe('story cards (highlights)', () => {
  const files = (): Record<string, PlanInputFile> => ({ 'data/quotes-per-month.csv': { file: '/p/data/quotes-per-month.csv', text: csv } });

  it('a figure from capture_text, frames by mark and scene start, a CSV table (R-STO-01/03/06)', async () => {
    const t = load('highlights');
    const p = await plan(t, {}, files());
    expect(cardOf(p, 'figure').component.media?.capture as TextMedia).toEqual({ kind: 'text', name: 'total', value: '€465.00', text: '€465.00incl. VAT' });
    const ba = cardOf(p, 'before-after').component.media!;
    const before = ba.before as PictureMedia;
    const after = ba.after as PictureMedia;
    expect(before).toMatchObject({ kind: 'picture', url: `${PLAN_ASSET_SCHEME}capture.mp4`, width: 1920, height: 1080, label: 'start of scene quotes' });
    expect(after.label).toBe('mark proposal-open');
    const mk = t.markers.find((m) => m.name === 'proposal-open')!;
    expect(after.video!.time_s).toBeGreaterThan(mk.t);
    expect(before.video!.time_s).toBeLessThan(mk.t);
    // Frame-exact times (k / fps).
    expect(Math.abs(after.video!.time_s * 30 - Math.round(after.video!.time_s * 30))).toBeLessThan(0.01);
    const table = cardOf(p, 'chart').component.media?.data as TableMedia;
    expect(table).toEqual({ kind: 'table', name: 'data/quotes-per-month.csv', columns: ['month', 'quote requests', 'accepted'], rows: [['Jun', '42', '19'], ['Jul', '51', '24']] });
    expect(p.warnings).toEqual([]);
    for (const id of ['features', 'testimonial', 'cta']) expect(cardOf(p, id).component.missing).toBeUndefined();
  });

  it('warns when data was not read or a capture / mark is missing', async () => {
    const t = load('highlights');
    const noFiles = await plan(t);
    expect(noFiles.warnings.join('\n')).toMatch(/data file data\/quotes-per-month\.csv was not read/);
    const t2 = load('highlights');
    t2.artefacts = [];
    t2.markers = [];
    const p = await plan(t2, {}, files());
    expect(p.warnings.join('\n')).toMatch(/capture "total" was not captured by run/);
    expect(p.warnings.join('\n')).toMatch(/mark "proposal-open" is not in run/);
  });

  it('image slots naming project files become plan assets; frames can be image files', async () => {
    const t = load('highlights');
    const quote = t.scenes.find((s) => s.id === 'testimonial')!;
    quote.card!.slots = { ...quote.card!.slots, logo: 'assets/partner.svg' };
    const ba = t.scenes.find((s) => s.id === 'before-after')!;
    ba.card!.slots = { ...ba.card!.slots, before: 'assets/old-screen.png' };
    const f = { ...files(), 'assets/partner.svg': { file: '/p/assets/partner.svg', width: 120, height: 40 }, 'assets/old-screen.png': { file: '/p/assets/old-screen.png', width: 1600, height: 1000 } };
    const p = await plan(t, {}, f);
    const logo = cardOf(p, 'testimonial').component.slots.logo!;
    expect(logo).toBe(`${PLAN_ASSET_SCHEME}image-assets-partner-svg.svg`);
    expect(p.assets[logo]).toBe('/p/assets/partner.svg');
    expect(cardOf(p, 'before-after').component.media?.before).toEqual({ kind: 'picture', name: 'before', url: `${PLAN_ASSET_SCHEME}image-assets-old-screen-png.png`, width: 1600, height: 1000, label: 'assets/old-screen.png' });
  });
});

describe('plan inputs (project files read before planning)', () => {
  it('lists the data and image files of cards and overlays and reads them', async () => {
    const t = load('highlights');
    t.scenes.find((s) => s.id === 'testimonial')!.card!.slots!.logo = 'assets/logo.png';
    expect(planFileRefs(t)).toEqual(['assets/logo.png', 'data/quotes-per-month.csv']);
    const dir = mkdtempSync(join(tmpdir(), 'ds-plan-inputs-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'quotes-per-month.csv'), csv);
    const read = await planInputFiles(t, { dir });
    expect(read['data/quotes-per-month.csv'].text).toBe(csv);
    expect(read['assets/logo.png'].missing).toBe(true);
  });

  it('measures PNG, JPEG, GIF and SVG sizes', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(360, 20);
    expect(imageFileSize(png)).toEqual({ width: 640, height: 360 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03]);
    expect(imageFileSize(jpeg)).toEqual({ width: 600, height: 300 });
    expect(imageFileSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect/></svg>'))).toEqual({ width: 120, height: 40 });
    expect(imageFileSize(Buffer.from('<svg width="64" height="32"></svg>'))).toEqual({ width: 64, height: 32 });
  });
});
