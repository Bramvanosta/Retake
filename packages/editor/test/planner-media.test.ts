/**
 * Your own files in the edit (L2.12, R-OWN-01/02/03): segments that are a video, an image or a Lottie file (scenario
 * and theme), box-filling overlays (anchor / rect / scale, `at`), the music bed ducking under a file's own sound, and
 * the waits that play faster (the root cause of the catalogue's `long-wait`). The real built-in library (studio/media,
 * studio/lottie) and the editorial theme; files described as planInputFiles reads them (no ffmpeg needed).
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry, VideoMedia } from '@demo-studio/components';
import { loadTemplate } from '@demo-studio/core';
import type { LoadedProject, LoadedTemplate, Timeline, TimelineEvent } from '@demo-studio/core';
import { MARK_WINDOW_S, OVERLAY_BOX_MARGIN, WAIT_KEEP_S, duckSpans, mapSourceRect, musicVolumeAt, overlayBoxAt, planEdit, planFileRefs, protectedSpans, stepBoxes, themeFileRefs, waitingSpans } from '@demo-studio/editor';
import type { ClipSegment, EditOverrides, EditPlan, PlanInputFile } from '@demo-studio/editor';
import { REPO, fixtureProject, seg, synthTimeline } from './helpers.js';

let registry: ComponentRegistry;
let project: LoadedProject;
let editorial: LoadedTemplate;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'demo-studio-media-plan-'));
  registry = await loadComponentRegistry({ root });
  project = await fixtureProject();
  editorial = await loadTemplate('editorial', REPO);
});
afterAll(async () => rm(root, { recursive: true, force: true }));

const video = (w: number, h: number, duration_s: number, extra: Partial<PlanInputFile['video']> = {}): PlanInputFile => ({
  file: '/media/x',
  width: w,
  height: h,
  video: { container: 'mov,mp4', codec: 'h264', width: w, height: h, duration_s, fps: 30, audio: true, alpha: false, ...extra },
});
const FILES: Record<string, PlanInputFile> = {
  'assets/intro.mp4': { ...video(1920, 1080, 4), file: '/media/intro.mp4' },
  'assets/burst.webm': { ...video(480, 480, 1.2, { codec: 'vp9', audio: false, alpha: true }), file: '/media/burst.webm' },
  'assets/end.png': { file: '/media/end.png', width: 1920, height: 1080 },
  'assets/cup.json': { file: '/media/cup.json', width: 600, height: 500, lottie: { version: '5.7.4', width: 600, height: 500, fps: 30, frames: 96, duration_s: 3.2, external_images: 0 } },
  'assets/check.json': { file: '/media/check.json', width: 240, height: 240, lottie: { version: '5.7.4', width: 240, height: 240, fps: 30, frames: 60, duration_s: 2, external_images: 0 } },
};

function plan(timeline: Timeline, opts: { template?: LoadedTemplate; files?: Record<string, PlanInputFile>; music?: number; overrides?: EditOverrides } = {}): EditPlan {
  return planEdit({ timeline, template: opts.template ?? editorial, project, registry, captureFile: '/captures/capture.mp4', files: opts.files ?? FILES, ...(opts.music ? { musicDuration_s: opts.music } : {}), ...(opts.overrides ? { overrides: opts.overrides } : {}) });
}

const overlay = (o: NonNullable<TimelineEvent['overlay']>) => o;
const SCENE = { id: 's', t_start: 0, t_end: 12, open_end: 0.5, still: [0.5, 2] as [number, number], caption: { text: 'A scene' } };

describe('segments that are your own files (R-OWN-01)', () => {
  const tl = () =>
    synthTimeline({
      duration: 12,
      video: { title: { text: 'Own' }, intro: { video: 'assets/intro.mp4', volume: 0.8 }, outro: { image: 'assets/end.png', duration: 3 }, frame: 'card', template: 'editorial', music: { file: 'assets/bed.m4a' } },
      entries: [{ ...SCENE, steps: [{ action: 'click', t_start: 2, t_end: 4 }] }, { card: { id: 'cup' } }, { interstitial: { id: 'later', text: 'Later' } }],
    });

  it('plans studio/media / studio/lottie uses with the file as media, their own length, the theme transitions around them', () => {
    const t = tl();
    t.scenes[1].card = { lottie: 'assets/cup.json', params: { colors: { '#ff5a1f': 'accent' } } };
    t.scenes[2].interstitial = { video: 'assets/intro.mp4', from: 1, to: 3.5 };
    const p = plan(t);
    expect(p.segments.map((s) => `${s.kind}:${s.id}:${s.component.id}`)).toEqual(['intro:intro:studio/media', 'clip:s:studio/layout-card', 'card:cup:studio/lottie', 'interstitial:later:studio/media', 'outro:outro:studio/media']);
    const intro = seg(p, 'intro');
    expect(intro.component).toMatchObject({ kind: 'intro', source: 'scenario', params: { volume: 0.8, fit: 'auto', background: 'theme', from: 0, loop: false }, slots: { file: 'assets/intro.mp4' } });
    const m = intro.component.media!.file as VideoMedia;
    expect(m).toMatchObject({ kind: 'video', name: 'assets/intro.mp4', width: 1920, height: 1080, duration_s: 4, audio: true, alpha: false, codec: 'h264' });
    expect(p.assets[m.url]).toBe('/media/intro.mp4');
    // Its own length (4 s); the interstitial's part 1–3.5 s (2.5 s); the Lottie's 3.2 s; the image's 3 s.
    expect(intro.durationInFrames).toBe(120);
    expect(seg(p, 'later').durationInFrames).toBe(75);
    expect(seg(p, 'cup').durationInFrames).toBe(96);
    expect(seg(p, 'cup').component).toMatchObject({ kind: 'card', params: { colors: { '#ff5a1f': 'accent' }, fit: 'contain', size: 1 }, media: { file: { kind: 'lottie', width: 600, frames: 96 } } });
    expect(seg(p, 'outro').durationInFrames).toBe(90);
    expect(seg(p, 'outro').component.media?.file).toMatchObject({ kind: 'picture', name: 'assets/end.png', width: 1920 });
    // The theme's transitions apply around them (editorial: crossfade 0.35 s).
    for (const id of ['s', 'cup', 'later', 'outro']) expect(seg(p, id).transition?.kind, id).toBe('crossfade');
    expect(p.notes.filter((n) => n.includes(': your file'))).toEqual([
      'intro: your file assets/intro.mp4 (video 4.00 s, with sound) for 4.00 s',
      'card "cup": your file assets/cup.json (Lottie 3.20 s) for 3.20 s',
      'interstitial "later": your file assets/intro.mp4 (video 2.50 s, with sound) for 2.50 s',
      'outro: your file assets/end.png (image) for 3.00 s',
    ]);
    expect(p.warnings).toEqual([]);
  });

  it('a scenario duration wins; a missing or unreadable file is a warning and the use shows nothing', () => {
    const t = tl();
    t.video!.intro = { video: 'assets/intro.mp4', duration: 2 };
    t.scenes[1].card = { video: 'assets/gone.mp4' };
    t.scenes[2].interstitial = { lottie: 'assets/bad.json' };
    const p = plan(t, { files: { ...FILES, 'assets/gone.mp4': { file: '/media/gone.mp4', missing: true }, 'assets/bad.json': { file: '/media/bad.json', error: 'not a JSON file' } } });
    expect(seg(p, 'intro').durationInFrames).toBe(60);
    expect(seg(p, 'cup').component.media).toBeUndefined();
    expect(p.warnings).toEqual(['card "cup": file assets/gone.mp4 not found: nothing is shown', 'interstitial "later": file assets/bad.json: not a JSON file: nothing is shown']);
    // Not assets of the plan either: the renderer refuses a plan whose assets are missing.
    const served = Object.values(p.assets);
    expect(served).not.toContain('/media/gone.mp4');
    expect(served).not.toContain('/media/bad.json');
    expect(served.some((f) => f.endsWith('intro.mp4'))).toBe(true);
  });

  it("a theme's own intro file (no intro component at all), relative to the template folder; the scenario's file wins", async () => {
    const dir = join(root, 'theme-own');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'template.yaml'), 'name: own\ncomponents:\n  intro: {video: media/brand-intro.mp4, duration: 2.5}\n');
    const own = { ...editorial, name: 'own', dir, template: { ...editorial.template, components: { ...editorial.template.components, intro: { video: 'media/brand-intro.mp4', duration: 2.5 } } } };
    const abs = join(dir, 'media/brand-intro.mp4');
    expect(themeFileRefs(own)).toEqual([abs]);
    const t = tl();
    delete t.video!.intro;
    const p = plan(t, { template: own, files: { ...FILES, [abs]: { ...video(1280, 720, 5), file: abs } } });
    expect(seg(p, 'intro').component).toMatchObject({ id: 'studio/media', source: 'theme', slots: { file: abs }, media: { file: { kind: 'video', width: 1280 } } });
    expect(seg(p, 'intro').durationInFrames).toBe(75);
    // The scenario's own file wins over the theme's.
    const q = plan(tl(), { template: own, files: { ...FILES, [abs]: { ...video(1280, 720, 5), file: abs } } });
    expect(seg(q, 'intro').component).toMatchObject({ source: 'scenario', slots: { file: 'assets/intro.mp4' } });
  });

  it('planFileRefs lists the files of segments and file overlays (planInputFiles reads them)', () => {
    const t = tl();
    t.scenes[1].card = { lottie: 'assets/cup.json' };
    t.events.push({ scene: 's', scene_index: 0, step: 1, action: 'hover', t_start: 4, t_end: 5, status: 'ok', overlay: overlay({ component: 'studio/media', slots: { file: 'assets/burst.webm' }, params: {} }) });
    expect(planFileRefs(t)).toEqual(['assets/burst.webm', 'assets/cup.json', 'assets/end.png', 'assets/intro.mp4']);
  });

  it('a 16:9 file shows whole in the vertical variant (fit auto, with a note); covers in landscape; a written fit wins', () => {
    const fitNotes = (p: EditPlan) => p.notes.filter((n) => n.includes('does not have the shape'));
    expect(fitNotes(plan(tl()))).toEqual([]);
    const v = plan(tl(), { overrides: { variant: 'vertical' } });
    expect(seg(v, 'intro').component.params.fit).toBe('auto');
    expect(fitNotes(v)).toEqual([
      'intro: assets/intro.mp4 (1920×1080) does not have the shape of the 1080×1920 video: shown whole on the background (fit: contain; write fit: cover to fill the frame, cropped)',
      'outro: assets/end.png (1920×1080) does not have the shape of the 1080×1920 video: shown whole on the background (fit: contain; write fit: cover to fill the frame, cropped)',
    ]);
    const t = tl();
    t.video!.intro = { video: 'assets/intro.mp4', fit: 'cover' };
    const w = plan(t, { overrides: { variant: 'vertical' } });
    expect(seg(w, 'intro').component.params.fit).toBe('cover');
    expect(fitNotes(w)).toHaveLength(1);
  });

  it('the music bed ducks under a file with sound like under footage, not under an image or a silent file', () => {
    const t = tl();
    t.scenes[1].card = { video: 'assets/burst.webm' };
    const p = plan(t, { music: 30 });
    const spans = duckSpans(p);
    const intro = seg(p, 'intro');
    expect(spans[0]).toEqual([intro.from, intro.from + intro.durationInFrames]);
    expect(spans.some(([a]) => a === seg(p, 'cup').from)).toBe(false);
    expect(spans.some(([a]) => a === seg(p, 'outro').from)).toBe(false);
    const m = p.music!;
    expect(musicVolumeAt(p, 60)).toBeCloseTo(m.volume * m.duck, 4);
    const outro = seg(p, 'outro');
    expect(musicVolumeAt(p, outro.from + 30)).toBeCloseTo(m.volume, 4);
    // A muted file (volume 0) does not duck the bed.
    t.video!.intro = { video: 'assets/intro.mp4', volume: 0 };
    expect(duckSpans(plan(t, { music: 30 })).length).toBe(spans.length - 1);
  });
});

describe('overlays that are your own files (R-OWN-02, R-OWN-03)', () => {
  const tl = (o: Array<NonNullable<TimelineEvent['overlay']>>) =>
    synthTimeline({
      duration: 14,
      entries: [
        {
          ...SCENE,
          t_end: 14,
          steps: [
            { action: 'click', t_start: 2, t_end: 4, t_click: 3, target: { desc: 'button', bbox: { x: 800, y: 500, w: 200, h: 60 } }, overlay: o[0], mark: 'm' },
            { action: 'hover', t_start: 4, t_end: 6, overlay: o[1] },
            { action: 'hover', t_start: 6, t_end: 8, overlay: o[2] },
          ].filter((s) => s.overlay !== undefined) as never,
        },
      ],
    });

  it('a video on the target from the click: its own size × scale in page px, its own length, on the screen layer', () => {
    const p = plan(tl([overlay({ component: 'studio/media', slots: { file: 'assets/burst.webm' }, params: { fit: 'contain', background: 'none' }, at: 'click', box: { anchor: 'target', scale: 0.5 }, bbox: { x: 800, y: 500, w: 200, h: 60 } })]));
    const c = seg(p, 's') as ClipSegment;
    const o = c.overlays[0];
    expect(o.component).toMatchObject({ id: 'studio/media', kind: 'overlay', media: { file: { kind: 'video', alpha: true } } });
    expect(o.box).toEqual({ anchor: 'target', rect: { x: 780, y: 410, w: 240, h: 240 } });
    expect(o.layer).toBe('screen');
    // From the click (capture 3 s: 1 s after the still's end at 1×), for the file's 1.2 s.
    expect(o.from).toBe(c.srcFrames.findIndex((f) => f >= 90));
    expect(o.durationInFrames).toBe(36);
    // The box maps through the card layout (1560 / 1920) every frame.
    const box = overlayBoxAt(p, c, o, o.from)!;
    const k = 1560 / 1920;
    expect(box.w).toBeCloseTo(240 * k, 1);
    expect(box.x).toBeCloseTo(c.layout.capture.x + 780 * k, 1);
  });

  it('a Lottie at a corner of the screen, looped to the end of the clip; an image in a rect of the page; `at` a mark or seconds', () => {
    const p = plan(
      tl([
        overlay({ component: 'studio/overlay-callout', slots: { text: 'x' }, params: {} }),
        overlay({ component: 'studio/lottie', slots: { file: 'assets/check.json' }, params: { loop: true, fit: 'contain', background: 'none' }, at: 'mark:m', box: { anchor: 'top-right', scale: 0.5 } }),
        overlay({ component: 'studio/media', slots: { file: 'assets/end.png' }, params: {}, at: 0.5, box: { rect: { x: 0, y: 0, w: 960, h: 540 } } }),
      ]),
    );
    const c = seg(p, 's') as ClipSegment;
    const [callout, lottie, image] = c.overlays;
    expect(callout.box).toBeUndefined();
    expect(lottie.box).toEqual({ anchor: 'top-right', size: { w: 120, h: 120 } });
    // `at: mark:m` = the marked step's time (its start, 2 s).
    expect(lottie.from).toBe(c.srcFrames.findIndex((f) => f >= 60));
    // Looped without a duration: to the end of the clip (its held frames excluded? no: the clip's whole length).
    expect(lottie.from + lottie.durationInFrames).toBe(c.durationInFrames);
    const box = overlayBoxAt(p, c, lottie, lottie.from)!;
    const screen = c.layout.capture;
    const m = OVERLAY_BOX_MARGIN * Math.min(screen.w, screen.h);
    expect(box.x + box.w).toBeCloseTo(screen.x + screen.w - m, 1);
    expect(box.y).toBeCloseTo(screen.y + m, 1);
    expect(image.box).toEqual({ anchor: 'rect', rect: { x: 0, y: 0, w: 960, h: 540 } });
    expect(image.from).toBe(c.srcFrames.findIndex((f) => f >= Math.round(6.5 * 30)));
    expect(image.durationInFrames).toBe(90); // studio/media's default (3 s): an image has no length of its own
    expect(overlayBoxAt(p, c, { ...image, box: { anchor: 'screen' } }, image.from)).toEqual(screen);
  });

  it('a kind-wide overlay override restyles the provided overlays, not your own files (with a note)', () => {
    const p = plan(
      tl([
        overlay({ component: 'studio/media', slots: { file: 'assets/burst.webm' }, params: { fit: 'contain', background: 'none' }, at: 'click', box: { anchor: 'target' }, bbox: { x: 800, y: 500, w: 200, h: 60 } }),
        overlay({ component: 'studio/lottie', slots: { file: 'assets/check.json' }, params: { fit: 'contain', background: 'none' }, box: { anchor: 'top-right' } }),
        overlay({ component: 'studio/overlay-callout', slots: { text: 'Sent' }, params: {} }),
      ]),
      { overrides: { components: { overlay: 'studio/overlay-lower-third' } } },
    );
    const c = seg(p, 's') as ClipSegment;
    expect(c.overlays.map((o) => `${o.component.id}:${o.component.source}`)).toEqual(['studio/media:scenario', 'studio/lottie:scenario', 'studio/overlay-lower-third:override']);
    expect(c.overlays[0].component.media?.file).toMatchObject({ kind: 'video' });
    expect(p.notes.filter((n) => n.includes('your file is kept'))).toHaveLength(2);
  });
});

describe('your own overlays in a vertical / square framing (R-OWN-02, review fixes)', () => {
  /** Box of an overlay frame by frame: its share inside the visible capture. */
  const visibleShare = (p: EditPlan, c: ClipSegment, o: ClipSegment['overlays'][number]) =>
    Array.from({ length: o.durationInFrames }, (_, k) => {
      const f = o.from + k;
      const b = overlayBoxAt(p, c, o, f)!;
      const sc = c.layout.capture;
      const ix = Math.max(0, Math.min(b.x + b.w, sc.x + sc.w) - Math.max(b.x, sc.x));
      const iy = Math.max(0, Math.min(b.y + b.h, sc.y + sc.h) - Math.max(b.y, sc.y));
      return (ix * iy) / (b.w * b.h);
    });
  const far = (o: NonNullable<TimelineEvent['overlay']>) =>
    synthTimeline({
      duration: 20,
      entries: [
        {
          ...SCENE,
          t_end: 20,
          steps: [
            // An overlay on a target at the right of the page (the resting cursor at the centre), then a long hover at
            // its far left.
            { action: 'hover', t_start: 2, t_end: 3, mark: 'later', target: { desc: 'right', bbox: { x: 1500, y: 500, w: 120, h: 60 } }, overlay: o },
            { action: 'hover', t_start: 3, t_end: 14, target: { desc: 'left', bbox: { x: 80, y: 500, w: 120, h: 60 } } },
          ] as never,
        },
      ],
    });
  const check = { component: 'studio/lottie', slots: { file: 'assets/check.json' }, params: { fit: 'contain', background: 'none' } };

  it('the reframe keeps the box in view while the overlay really shows: `at` seconds or a mark, its file length', () => {
    for (const at of [undefined, 6, 'mark:later'] as const) {
      const t = far(overlay({ ...check, ...(at !== undefined ? { at } : {}), box: { anchor: 'target' }, bbox: { x: 1500, y: 500, w: 120, h: 60 } }));
      if (at === 'mark:later') t.markers[0].t = 7;
      const p = plan(t, { overrides: { variant: 'vertical' } });
      const c = seg(p, 's') as ClipSegment;
      const o = c.overlays[0];
      // The check file's own 2 s.
      expect(o.durationInFrames, String(at)).toBe(60);
      const shares = visibleShare(p, c, o);
      expect(Math.min(...shares), `at ${String(at)}: share of the box on screen`).toBeGreaterThan(0.99);
    }
  });

  it('a file on the cursor (no target recorded) is kept in view around the cursor', () => {
    // Where the cursor was at the end of the step (the cursor then rests at the centre).
    const t = far(overlay({ ...check, at: 6, box: { anchor: 'cursor' }, point: { x: 1560, y: 530 } }));
    t.events.find((e) => e.step === 0)!.target = undefined;
    const p = plan(t, { overrides: { variant: 'vertical' } });
    const c = seg(p, 's') as ClipSegment;
    const o = c.overlays[0];
    expect(o.box?.anchor).toBe('cursor');
    expect(Math.min(...visibleShare(p, c, o))).toBeGreaterThan(0.99);
  });

  it('a corner file moves to the nearest free corner when, in this framing, it would cover the step\'s target (note); landscape keeps it', () => {
    // A wide row near the top of the page, hovered on its right part; a check badge asked at the top-right.
    const t = synthTimeline({
      duration: 12,
      cursor: [[0, 960, 540], [2, 1250, 150]],
      entries: [
        {
          ...SCENE,
          steps: [
            { action: 'hover', t_start: 2, t_end: 3, holdS: 2, point: { x: 1250, y: 150 }, target: { desc: 'row', bbox: { x: 700, y: 120, w: 700, h: 60 } }, overlay: overlay({ ...check, box: { anchor: 'top-right', scale: 1.4 } }) },
            { action: 'click', t_start: 6, t_end: 7, t_click: 6.5, point: { x: 1250, y: 150 }, target: { desc: 'row', bbox: { x: 700, y: 120, w: 700, h: 60 } } },
          ] as never,
        },
      ],
    });
    const land = plan(t);
    expect((seg(land, 's') as ClipSegment).overlays[0].box?.anchor).toBe('top-right');
    expect(land.notes.filter((n) => n.includes('would cover'))).toEqual([]);
    const v = plan(t, { overrides: { variant: 'vertical' } });
    const c = seg(v, 's') as ClipSegment;
    const o = c.overlays[0];
    expect(o.box?.anchor).not.toBe('top-right');
    expect(v.notes.filter((n) => n.includes('would cover'))).toEqual([`scene "s" step 0 overlay: at top-right it would cover the hover target of step 0 (row) in this vertical framing: placed at ${o.box!.anchor}`]);
    // Clear of the row (around the cursor and its leading part) on every frame.
    const ev = t.events.find((e) => e.step === 0)!;
    for (let k = 0; k < o.durationInFrames; k += 3) {
      const b = overlayBoxAt(v, c, o, o.from + k)!;
      for (const box of stepBoxes(ev)) {
        const r = mapSourceRect(v, c, o.from + k, box);
        const ox = Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x);
        const oy = Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y);
        expect(ox > 0 && oy > 0, `frame ${k}`).toBe(false);
      }
    }
  });
});

describe('waiting plays faster (the catalogue long-wait, root cause)', () => {
  const ev = (step: number, action: TimelineEvent['action'], t_start: number, t_end: number, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({ scene: 's', scene_index: 0, step, action, t_start, t_end, status: 'ok', ...extra });

  it('a wait step, and the pause after a page change before a wait that still waited (the page was loading)', () => {
    const events = [ev(0, 'click', 1, 3.5, { t_click: 1.8 }), ev(1, 'wait_for', 3.5, 3.52), ev(2, 'wait_for', 3.53, 6.4, { mark: 'reveal' }), ev(3, 'scroll', 6.5, 8)];
    expect(waitingSpans(events, [2])).toEqual([{ t_start: 2 + WAIT_KEEP_S, t_end: 6.4 }]);
    // Without a page change: only the waits.
    expect(waitingSpans(events, [])).toEqual([{ t_start: 3.5 + WAIT_KEEP_S, t_end: 6.4 }]);
    // A wait that did not wait (the page was ready): the pause after the change shows the new page — kept.
    const ready = [ev(0, 'click', 1, 3.5, { t_click: 1.8 }), ev(1, 'wait_for', 3.5, 3.6), ev(2, 'hover', 3.6, 5)];
    expect(waitingSpans(ready, [2])).toEqual([]);
    // A step speed wins; a fixed `wait` is the author's.
    expect(waitingSpans([ev(0, 'wait_for', 1, 5, { speed: 1 }), ev(1, 'wait', 5, 9)], [])).toEqual([]);
  });

  it('a marked wait protects the moment it waited for (its end), not the waiting', () => {
    const clips = [{ scene: 's', A: 0, B: 300, baseSpeed: 1, events: [ev(0, 'wait_for', 2, 6, { mark: 'm' }), ev(1, 'click', 6, 7, { mark: 'n' })] }];
    const spans = protectedSpans(clips, 30).filter((s) => s.reason === 'mark');
    expect(spans.map((s) => [s.a, s.b])).toEqual([
      [(6 - MARK_WINDOW_S) * 30, (6 + MARK_WINDOW_S) * 30],
      [(6 - MARK_WINDOW_S) * 30, (7 + MARK_WINDOW_S) * 30],
    ]);
    // Waits not played faster (overrides.trim_idle: false): the whole marked step, as before.
    expect(protectedSpans(clips, 30, false).filter((s) => s.reason === 'mark' && s.step === 0).map((s) => [s.a, s.b])).toEqual([[(2 - MARK_WINDOW_S) * 30, (6 + MARK_WINDOW_S) * 30]]);
  });

  it('the planner plays the waiting at up to 4× (ramped), the rest of the scene at its speed, with a note', () => {
    const t = synthTimeline({
      duration: 14,
      entries: [{ ...SCENE, t_end: 14, steps: [{ action: 'click', t_start: 2, t_end: 3 }, { action: 'wait_for', t_start: 3, t_end: 9 }, { action: 'click', t_start: 9, t_end: 14 }] }],
    });
    const p = plan(t);
    const c = seg(p, 's') as ClipSegment;
    expect(Math.max(...c.speeds.map((s) => s.speed))).toBe(4);
    // 13.5 s shown; of the 6 s of waiting 0.5 s are kept, 5.5 s play at up to 4× (two 0.3 s ramps) → 1.6 s.
    const n = c.durationInFrames - c.heldFrames;
    expect(n / 30).toBeCloseTo(13.5 - 5.5 + 1.6, 1);
    expect(p.notes).toContain(`"s": waiting 3.50 s–9.00 s of the capture played at up to 4× (a loading state; marks and holds stay at 1×)`);
    // overrides.trim_idle = false keeps every second.
    const q = plan(t);
    expect(planEdit({ timeline: t, template: editorial, project, registry, captureFile: '/c.mp4', overrides: { trim_idle: false } }).durationInFrames).toBeGreaterThan(q.durationInFrames + 90);
  });
});
