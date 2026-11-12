/**
 * L2.8 planner rules: the theme default zoom (R-ED-22: style_bias balanced / motion + motion.default_zoom → at most one
 * slow zoom per scene on a marked step's target, eased back out before the scene ends; real → static) and the music
 * bed (R-ED-17: fades, ducking under footage, loop with crossfaded seams or trim to the video, the volume curve).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedTemplate } from '@retake/core';
import { DEFAULT_ZOOM, MUSIC_DEFAULTS, musicPlayGain, musicPlays, musicVolumeAt, planEdit } from '@retake/editor';
import type { EditOverrides, EditPlan } from '@retake/editor';
import { clip, clips, studioWorkspace } from './helpers.js';
import { fixtureProject, realTimeline, synthTimeline, template } from '@retake/test-support/timeline';
import type { EntrySpec } from '@retake/test-support/timeline';
import type { Workspace } from './helpers.js';

const FPS = 30;
let ws: Workspace;
let editorial: LoadedTemplate;
let motion: LoadedTemplate;

beforeAll(async () => {
  ws = await studioWorkspace();
  editorial = await template('editorial');
  motion = await template('motion');
});
afterAll(async () => {
  await ws.cleanup();
});

function withTheme(t: LoadedTemplate, patch: Partial<LoadedTemplate['template']>): LoadedTemplate {
  return { ...t, template: { ...t.template, ...patch, motion: { ...t.template.motion, ...(patch.motion ?? {}) } } };
}

async function plan(timeline: Parameters<typeof planEdit>[0]['timeline'], tpl: LoadedTemplate, overrides?: EditOverrides, extra: { musicDuration_s?: number } = {}): Promise<EditPlan> {
  return planEdit({ timeline, template: tpl, project: await fixtureProject(), registry: ws.registry, captureFile: '/c.mp4', overrides, ...extra });
}

/** Two scenes on the same page (joined) and a third after a page load; marks in the first and the third. */
function scenes(): EntrySpec[] {
  return [
    {
      id: 'a',
      t_start: 0,
      t_end: 10,
      open_end: 0.5,
      still: [0.6, 2],
      steps: [
        { action: 'click', t_start: 2, t_end: 3, t_click: 2.6, target: { desc: 'x', bbox: { x: 1200, y: 600, w: 200, h: 40 } } },
        { action: 'wait_for', t_start: 3, t_end: 3.1, mark: 'first', target: { desc: 'total', bbox: { x: 1400, y: 500, w: 160, h: 50 } } },
        { action: 'hold', t_start: 3.1, t_end: 10 },
      ],
    },
    { id: 'b', t_start: 10, t_end: 14, still: [10.004, 11], steps: [{ action: 'hold', t_start: 11, t_end: 14 }] },
    {
      id: 'c',
      t_start: 14,
      t_end: 22,
      open_end: 14.5,
      still: [14.6, 16],
      steps: [
        { action: 'click', t_start: 16, t_end: 17, t_click: 16.5, mark: 'second', target: { desc: 'y', bbox: { x: 300, y: 300, w: 100, h: 40 } } },
        { action: 'hold', t_start: 17, t_end: 22 },
      ],
    },
  ];
}

describe('theme default zoom (R-ED-22)', () => {
  it('motion style + default_zoom: one slow zoom per scene on the marked step target, back to 1× before the scene ends', async () => {
    const p = await plan(synthTimeline({ entries: scenes(), duration: 22 }), withTheme(motion, { motion: { ...motion.template.motion, default_zoom: 1.12 } }));
    const a = clip(p, 'a');
    const c = clip(p, 'c');
    expect(a.zooms).toHaveLength(1);
    expect(a.zooms[0]).toMatchObject({ source: 'theme', step: 1, zoom: 1.12, focus: { x: 1480, y: 525 } });
    expect(a.zooms[0].in_frames).toBeGreaterThanOrEqual(DEFAULT_ZOOM.in_min_s * FPS);
    expect(a.zooms[0].in_frames).toBeLessThanOrEqual(DEFAULT_ZOOM.in_max_s * FPS);
    expect(c.zooms).toHaveLength(1);
    expect(c.zooms[0]).toMatchObject({ source: 'theme', step: 0, focus: { x: 350, y: 320 } });
    // The joined scene "b" has no mark: no zoom; the camera is back at 1× when "a" ends (never across the join) and
    // when "c" ends (never across the cut).
    expect(clip(p, 'b').zooms).toEqual([]);
    for (const k of [a, c]) {
      const end = k.camera![k.durationInFrames - k.heldFrames - 1];
      expect(end[0]).toBeCloseTo(1, 2);
      expect(k.zooms[0].out_at + k.zooms[0].out_frames).toBeLessThanOrEqual(k.durationInFrames - k.heldFrames + 0.01);
    }
    expect(clip(p, 'b').camera).toBeNull();
    // The zoom eases (no jump).
    const zs = a.camera!.map((f) => f[0]);
    expect(Math.max(...zs.slice(1).map((z, i) => Math.abs(z - zs[i])))).toBeLessThan(0.012);
    expect(p.notes.some((n) => /theme zoom 1\.12× on the mark "first"/.test(n))).toBe(true);
  });

  it('balanced works the same; real keeps a static camera (a note says why); overrides.camera = false disables it', async () => {
    const tl = synthTimeline({ entries: scenes(), duration: 22 });
    const balanced = await plan(tl, withTheme(editorial, { style_bias: 'balanced', motion: { ...editorial.template.motion, default_zoom: 1.1 } }));
    expect(
      clips(balanced)
        .flatMap((c) => c.zooms)
        .map((z) => z.source),
    ).toEqual(['theme', 'theme']);
    const real = await plan(tl, withTheme(editorial, { style_bias: 'real', motion: { ...editorial.template.motion, default_zoom: 1.1 } }));
    expect(clips(real).flatMap((c) => c.zooms)).toEqual([]);
    expect(clips(real).every((c) => c.camera === null)).toBe(true);
    expect(real.notes.some((n) => /style_bias "real" keeps a static camera/.test(n))).toBe(true);
    const off = await plan(tl, withTheme(motion, { motion: { ...motion.template.motion, default_zoom: 1.1 } }), { camera: false });
    expect(clips(off).flatMap((c) => c.zooms)).toEqual([]);
    // default_zoom none (the editorial starter): nothing.
    expect(clips(await plan(tl, editorial)).flatMap((c) => c.zooms)).toEqual([]);
  });

  it('a scene with its own camera hint keeps it (no theme zoom); a scene too short after its mark gets none', async () => {
    const entries = scenes();
    const a = entries[0] as Extract<EntrySpec, { id: string }>;
    a.steps![0] = { ...a.steps![0], camera: { zoom: 1.3, bbox: { x: 1200, y: 600, w: 200, h: 40 } } };
    const c = entries[2] as Extract<EntrySpec, { id: string }>;
    c.t_end = 17.6;
    c.steps = [c.steps![0], { action: 'hold', t_start: 17, t_end: 17.6 }];
    const p = await plan(synthTimeline({ entries, duration: 17.6 }), withTheme(motion, { motion: { ...motion.template.motion, default_zoom: 1.12 } }));
    expect(clip(p, 'a').zooms.map((z) => z.source ?? 'hint')).toEqual(['hint']);
    expect(clip(p, 'c').zooms).toEqual([]);
    expect(p.notes.some((n) => /"c": no theme zoom on the mark "second"/.test(n))).toBe(true);
  });

  it("clamps default_zoom to max_zoom; the motion starter theme zooms on the quote fixture's marked proposal", async () => {
    const p = await plan(synthTimeline({ entries: scenes(), duration: 22 }), withTheme(motion, { motion: { ...motion.template.motion, default_zoom: 2, max_zoom: 1.3 } }));
    expect(clip(p, 'a').zooms[0]).toMatchObject({ zoom: 1.3, requested_zoom: 2 });
    const q = await plan(realTimeline('quote'), motion);
    const z = clips(q).flatMap((c) => c.zooms);
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ scene: 'proposal', source: 'theme', zoom: 1.12 });
  });
});

describe('music bed (R-ED-17)', () => {
  it('musicPlays: one trimmed play, loops overlapping by the crossfade, or one play without loop', () => {
    expect(musicPlays(120, 1800, 30, true, 1)).toEqual([{ from: 0, frames: 1800, fadeIn: 0, fadeOut: 0 }]);
    const loops = musicPlays(16, 1800, 30, true, 1);
    expect(loops.map((l) => l.from)).toEqual([0, 450, 900, 1350]);
    expect(loops.map((l) => l.frames)).toEqual([480, 480, 480, 450]);
    expect(loops.map((l) => [l.fadeIn, l.fadeOut])).toEqual([
      [0, 30],
      [30, 30],
      [30, 30],
      [30, 0],
    ]);
    // Each play starts before the previous one ends: no gap.
    for (let i = 1; i < loops.length; i++) expect(loops[i].from).toBeLessThan(loops[i - 1].from + loops[i - 1].frames);
    expect(musicPlays(16, 1800, 30, false, 1)).toEqual([{ from: 0, frames: 480, fadeIn: 0, fadeOut: 0 }]);
  });

  it('equal-power seams: two overlapping plays keep the loudness (sin² + cos² = 1)', () => {
    const play = { frames: 480, fadeIn: 30, fadeOut: 30 };
    for (let k = 0; k < 30; k++) {
      const out = musicPlayGain(play, 480 - 30 + k);
      const inn = musicPlayGain(play, k);
      expect(out * out + inn * inn).toBeCloseTo(1, 1);
    }
    expect(musicPlayGain(play, 200)).toBe(1);
  });

  it('plans the bed from the timeline (volume, duck, loop), with the plays when the track length is known', async () => {
    const tl = synthTimeline({ entries: scenes(), duration: 22 });
    tl.video = { ...tl.video, music: { file: 'assets/bed.m4a', volume: 0.5, duck: 0.4 } };
    const p = await plan(tl, editorial, undefined, { musicDuration_s: 8 });
    expect(p.music).toMatchObject({ volume: 0.5, duck: 0.4, loop: true, crossfade_s: MUSIC_DEFAULTS.crossfade_s, duration_s: 8 });
    expect(p.music!.plays!.length).toBeGreaterThan(1);
    expect(p.notes.some((n) => /loops \d+× over/.test(n))).toBe(true);
    const long = await plan(tl, editorial, undefined, { musicDuration_s: 600 });
    expect(long.music!.plays).toEqual([{ from: 0, frames: long.durationInFrames, fadeIn: 0, fadeOut: 0 }]);
    expect(long.notes.some((n) => /trimmed to the video/.test(n))).toBe(true);
    tl.video.music = { file: 'assets/bed.m4a', loop: false };
    const once = await plan(tl, editorial, undefined, { musicDuration_s: 8 });
    expect(once.music!.plays).toHaveLength(1);
    expect(once.notes.some((n) => /plays once/.test(n))).toBe(true);
    // Without a measured length the composition loops the element itself.
    expect((await plan(tl, editorial)).music!.plays).toBeUndefined();
  });

  it('volume: base level on the intro and cards, ducked under footage, eased at the edges, faded in and out', async () => {
    const entries: EntrySpec[] = [{ card: { id: 'card-0', slots: { title: 'Hello' }, duration: 3 } }, ...scenes()];
    const tl = synthTimeline({ entries, duration: 22 });
    tl.video = { ...tl.video, intro: false, outro: false, music: { file: 'assets/bed.m4a', volume: 0.6, duck: 0.5 } };
    const p = await plan(tl, editorial, { transition: 'cut' });
    const a = clip(p, 'a');
    const vol = (f: number) => musicVolumeAt(p, f);
    expect(vol(0)).toBeLessThan(0.1); // fading in
    expect(vol(Math.round(1.5 * FPS))).toBeCloseTo(0.6, 3); // the card: base volume
    expect(vol(a.from + 3 * FPS)).toBeCloseTo(0.3, 3); // footage: ducked × 0.5
    // Eased around the clip start: monotonic, no step bigger than a few percent.
    const around = Array.from({ length: 40 }, (_, i) => vol(a.from - 20 + i));
    for (let i = 1; i < around.length; i++) {
      expect(around[i]).toBeLessThanOrEqual(around[i - 1] + 1e-9);
      expect(around[i - 1] - around[i]).toBeLessThan(0.05);
    }
    expect(vol(p.durationInFrames - 1)).toBeLessThan(0.02); // faded out
  });
});
