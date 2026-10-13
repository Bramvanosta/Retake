/**
 * reviewRender on synthetic renders (quarter-size plans of synthetic runs, drawn with ffmpeg): a clean case, one
 * case per check (blank screen, blank scene start, overlapping captions, captions too long, cursor outside the zoom,
 * two zooms, a 35 s scene at 1×, a transition over a click, a long wait on a loading screen, a video outside 1–2 min,
 * empty cards), pagination, the diff with the previous render and the base64 thumbnails. Needs ffmpeg/ffprobe.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewRender } from '../src/index.js';
import type { Finding, ReviewResult } from '../src/index.js';
import type { OutputTimeline } from '../src/timeline.js';
import type { ClipSegment, EditPlan } from '@demo-studio/editor';
import { hasTool, makeCase, scenesTimeline, workspace } from './helpers.js';
import type { Workspace } from './helpers.js';

const can = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 240_000;
let ws: Workspace;

beforeAll(async () => {
  if (can) ws = await workspace();
}, LONG);
afterAll(async () => {
  if (!process.env.DEMO_STUDIO_KEEP_TEST_OUTPUT) await ws?.cleanup();
});

const codes = (r: ReviewResult) => r.findings.map((f) => f.code);
const of = (r: ReviewResult, code: string): Finding[] => r.findings.filter((f) => f.code === code);
const review = (render: string, extra: Partial<Parameters<typeof reviewRender>[0]> = {}) => reviewRender({ project: ws.project, render, registry: ws.registry, ...extra });

describe.skipIf(!can)('reviewRender', () => {
  it('a clean synthetic render: no error or warning, every artefact written', async () => {
    // L1.7: a run that records its environment gets the line in report.md (and report.json `environment`).
    const timeline = scenesTimeline([19, 19, 21]);
    timeline.environment = { name: 'local', access: 'read-write', clock: { at: '2026-11-02T10:24:00', epoch_ms: Date.UTC(2026, 10, 2, 10, 24) } };
    await makeCase(ws, 'clean', timeline);
    const r = await review('clean-v1');
    expect(r.environment).toEqual({ name: 'local', access: 'read-write', clock: { at: '2026-11-02T10:24:00' }, writes: { blocked: 0, mocked: 0, allowed: 0, passed: 0 } });
    expect(r.findings.filter((f) => f.severity !== 'info'), JSON.stringify(r.findings, null, 1)).toEqual([]);
    expect(r.clean).toBe(true);
    expect(r.counts).toMatchObject({ error: 0, warning: 0 });
    expect(r.render).toMatchObject({ id: 'clean-v1', scenario: 'clean', width: 480, height: 270, fps: 30 });
    expect(r.durations.total_s).toBeGreaterThan(60);
    expect(r.durations.total_s).toBeLessThan(120);
    expect(r.durations.segments.map((d) => d.id)).toEqual(['intro', 's1', 's2', 's3', 'outro']);
    const dir = join(ws.project.dir, 'review', 'clean-v1');
    expect(r.files.dir).toBe(dir);
    // 61 s at 1 fps: 61 tiles on two pages of at most 60 (shared evenly: 31 + 30).
    expect(r.files.sheets).toEqual([join(dir, 'sheet_1fps.jpg'), join(dir, 'sheet_1fps_p2.jpg')]);
    expect(Object.keys(r.files.scene_sheets)).toEqual(['s1', 's2', 's3']);
    expect(Object.keys(r.files.keyframes).sort()).toEqual(['intro-hold', 'outro-hold', 's1-first', 's1-last', 's2-first', 's2-last', 's3-first', 's3-last']);
    for (const f of [...r.files.sheets, ...Object.values(r.files.scene_sheets).flat(), ...Object.values(r.files.keyframes), r.files.timeline, r.files.report_json, r.files.report_md]) {
      expect(existsSync(f), f).toBe(true);
    }
    const kf = await sharp(r.files.keyframes['s2-first']).metadata();
    expect(kf).toMatchObject({ format: 'png', width: 480, height: 270 });
    const sheet = await sharp(r.files.sheets[0]).metadata();
    expect(sheet.format).toBe('jpeg');
    // Output-time timeline: segments with components, captions, step spans and the clicks placed on the output.
    const tl = JSON.parse(await readFile(r.files.timeline, 'utf8')) as OutputTimeline;
    expect(tl.segments.map((s) => [s.id, s.component.id])).toEqual([
      ['intro', 'studio/intro-stack'],
      ['s1', 'studio/layout-card'],
      ['s2', 'studio/layout-card'],
      ['s3', 'studio/layout-card'],
      ['outro', 'studio/outro-stack'],
    ]);
    expect(tl.segments[1].caption?.id).toBe('studio/caption-below');
    expect(tl.segments[1].transition_in).toMatchObject({ kind: 'crossfade', frames: 11 });
    expect(tl.captions.map((c) => c.scene)).toEqual(['s1', 's2', 's3']);
    expect(tl.steps.filter((s) => s.action === 'click').map((s) => s.scene)).toEqual(['s1', 's2', 's3']);
    expect(tl.clicks).toHaveLength(3);
    for (const c of tl.clicks) {
      const seg = tl.segments.find((s) => s.id === c.segment)!;
      expect(c.frame).toBeGreaterThanOrEqual(seg.from);
      expect(c.frame).toBeLessThan(seg.to);
      expect(c.time).toBeCloseTo(c.frame / 30, 2);
      // (960, 540) in a 1920×1080 capture lands in the middle of the card's capture rect.
      expect(c.screen!.x).toBeCloseTo(45 + 390 / 2, 0);
    }
    const report = JSON.parse(await readFile(r.files.report_json, 'utf8')) as ReviewResult;
    expect(report.clean).toBe(true);
    expect(report.thumbnails).toBeUndefined();
    const md = await readFile(r.files.report_md, 'utf8');
    expect(md).toContain('# Review — clean-v1');
    expect(md).toContain('\nEnvironment local · read-write · clock 2026-11-02T10:24:00\n');
    expect(md).toContain('clean: no error, no warning');
    expect(md).toContain('| 2 | s1 | clip |');
  }, LONG);

  it('a report never names a local host: hidden addresses, the plan\'s warning about them, a caption naming one (V4)', async () => {
    const timeline = scenesTimeline([19, 19, 21], { captions: ['Open localhost:4499/admin to start.'] });
    timeline.pages = [{ id: 'app', t_start: 0, t_end: 59, url: 'http://localhost:4499/start' }];
    timeline.environment = { name: 'local', access: 'read-write' };
    const c = await makeCase(ws, 'local-urls', timeline, { overrides: { frame: 'browser' } });
    expect(c.plan.warnings.join('\n')).toMatch(/localhost:4499/);
    const r = await review('local-urls-v1');
    expect(codes(r)).toEqual(expect.arrayContaining(['plan-warning', 'url-hidden', 'local-url-text']));
    // Findings (report.json and report.md) name paths only; the caption the scenario wrote is quoted as written (and
    // flagged: local-url-text).
    const json = JSON.parse(await readFile(r.files.report_json, 'utf8')) as ReviewResult;
    expect(JSON.stringify(json.findings)).not.toMatch(/localhost|4499/);
    const md = await readFile(r.files.report_md, 'utf8');
    expect(md.replace(/## Captions[\s\S]*?\n## /, '## ')).not.toMatch(/localhost|4499/);
    expect(md).toContain('Open localhost:4499/admin to start.');
  }, LONG);

  it('base64 thumbnails: JPEG ≤ 1280 px (sheets + marker key frames by default, everything with "all")', async () => {
    const r = await review('clean-v1', { thumbnails: 'all' });
    expect(r.thumbnails.length).toBeGreaterThan(8);
    for (const t of r.thumbnails) {
      expect(t.mime).toBe('image/jpeg');
      expect(Math.max(t.width, t.height)).toBeLessThanOrEqual(1280);
      const meta = await sharp(Buffer.from(t.base64, 'base64')).metadata();
      expect(meta).toMatchObject({ format: 'jpeg', width: t.width, height: t.height });
      expect(t.bytes).toBe(Buffer.from(t.base64, 'base64').length);
    }
    expect(r.thumbnails.map((t) => t.name)).toEqual(expect.arrayContaining(['sheet_1fps', 'keyframe:s1-first', 'sheet_scene_s2']));
    const def = await review('clean-v1', { thumbnail_px: 400 });
    expect(def.thumbnails.map((t) => t.name)).toEqual(['sheet_1fps', 'sheet_1fps_p2']);
    expect(Math.max(def.thumbnails[0].width, def.thumbnails[0].height)).toBe(400);
    const none = await review('clean-v1', { thumbnails: false });
    expect(none.thumbnails).toEqual([]);
  }, LONG);

  it('blank screen inside a clip and at a scene start (rendered and captured)', async () => {
    const clipOf = (plan: EditPlan, id: string) => plan.segments.find((x) => x.id === id)!;
    await makeCase(ws, 'blank', scenesTimeline([8, 8]), {
      draw: {
        // s1 starts on a blank screen (render only); s2 is blank for 3 s in the middle (capture 10.5–13.5 s too).
        blank: (plan) => [
          [clipOf(plan, 's1').from, clipOf(plan, 's1').from + 40],
          [clipOf(plan, 's2').from + 60, clipOf(plan, 's2').from + 150],
        ],
        blankCapture: [[10.5, 13.5]],
      },
    });
    const r = await review('blank-v1');
    expect(r.clean).toBe(false);
    const start = of(r, 'blank-scene-start');
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ severity: 'error', at: { segment: 's1', scene: 's1' } });
    expect(start[0].message).toContain('rendered frame');
    const blank = of(r, 'blank-screen').filter((f) => f.at?.segment === 's2');
    expect(blank).toHaveLength(1);
    expect(blank[0].severity).toBe('error');
    expect(blank[0].message).toMatch(/blank for ≈ 3\.0 s/);
    expect(blank[0].message).toContain('is blank too');
    // The tile of a blank frame is outlined on the contact sheet; the frame of the finding is inside s2.
    const s2 = r.durations.segments.find((d) => d.id === 's2')!;
    expect(blank[0].at!.frame!).toBeGreaterThanOrEqual(s2.from + 60);
    expect(blank[0].at!.frame!).toBeLessThan(s2.from + 75);
  }, LONG);

  it('overlapping captions and a caption shown on the wrong scene', async () => {
    await makeCase(ws, 'captions', scenesTimeline([6, 6]), {
      mutate: (plan) => {
        const [s1, s2] = plan.segments.filter((x): x is ClipSegment => x.kind === 'clip');
        s1.cues = [
          { from: 0, to: 120, kicker: 'Scene 1', text: 'Scene number 1 shows one thing.', scene: 's1' },
          { from: 90, to: s1.durationInFrames, kicker: 'Scene 1', text: 'A second line on top of the first.', scene: 's1' },
        ];
        s2.cues = s2.cues.map((c) => ({ ...c, scene: 's1' }));
        plan.captions = [
          ...s1.cues.map((c) => ({ ...c, from: s1.from + c.from, to: Math.min(s1.from + c.to, s2.from) })),
          ...s2.cues.map((c) => ({ ...c, from: s2.from + c.from, to: s2.from + c.to })),
        ];
      },
    });
    const r = await review('captions-v1');
    const overlaps = of(r, 'caption-overlap');
    expect(overlaps.length).toBeGreaterThanOrEqual(1);
    expect(overlaps.every((f) => f.severity === 'error')).toBe(true);
    expect(overlaps[0].message).toContain('A second line on top of the first.');
    expect(overlaps[0].at?.segment).toBe('s1');
    const mismatch = of(r, 'caption-scene-mismatch');
    expect(mismatch.some((f) => f.severity === 'error' && f.at?.segment === 's2' && /of scene "s1" is shown on scene "s2"/.test(f.message))).toBe(true);
  }, LONG);

  it('captions too long for their area (fitText with the theme font) and text slots over max_chars', async () => {
    const cut = 'This caption is far too long for one line of the caption area, it keeps going with more and more words about the product, its features, its prices and its many happy customers everywhere.';
    const long = 'This caption is a bit too long for one line: it keeps going with more words about the product and its happy customers.';
    await makeCase(ws, 'longcaps', scenesTimeline([6, 6], { captions: [cut, long] }));
    const r = await review('longcaps-v1');
    const truncated = of(r, 'caption-truncated');
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toMatchObject({ severity: 'error', at: { segment: 's1' } });
    const tooLong = of(r, 'caption-too-long');
    expect(tooLong).toHaveLength(1);
    expect(tooLong[0]).toMatchObject({ severity: 'warning', at: { segment: 's2' } });
    expect(tooLong[0].message).toMatch(/shrinks to \d\d % of the theme size/);
    const slots = of(r, 'text-slot-overflow');
    expect(slots.map((f) => f.at?.segment).sort()).toEqual(['s1', 's2']);
    expect(slots[0].message).toContain('studio/caption-below allows 90');
  }, LONG);

  it('cursor outside the zoomed view and off screen at clicks; two zooms in one video', async () => {
    await makeCase(
      ws,
      'camera',
      scenesTimeline([10, 10], {
        steps: {
          0: [
            { action: 'scroll', t_start: 2.5, t_end: 3.5, camera: { zoom: 1.4, bbox: { x: 100, y: 100, w: 200, h: 100 } } },
            { action: 'click', t_start: 6.6, t_end: 7.4, t_click: 7, point: { x: 1800, y: 950 } },
          ],
          1: [
            { action: 'scroll', t_start: 12.5, t_end: 13.5, camera: { zoom: 1.3 } },
            { action: 'click', t_start: 16, t_end: 16.6, t_click: 16.3, point: { x: -40, y: 500 } },
          ],
        },
      }),
    );
    const r = await review('camera-v1');
    const outside = of(r, 'cursor-outside-view');
    expect(outside).toHaveLength(1);
    expect(outside[0]).toMatchObject({ severity: 'error', at: { segment: 's1', scene: 's1' } });
    expect(outside[0].message).toContain('zoomed view (1.40×)');
    expect(outside[0].message).toContain('(1800, 950)');
    const off = of(r, 'cursor-offscreen');
    expect(off).toHaveLength(1);
    expect(off[0].at?.segment).toBe('s2');
    // The clicks at (960, 540) stay inside both zoomed views.
    expect(r.findings.filter((f) => f.code.startsWith('cursor') && f.message.includes('(960, 540)'))).toEqual([]);
    const zooms = of(r, 'zoom-count');
    expect(zooms).toHaveLength(1);
    expect(zooms[0]).toMatchObject({ severity: 'warning', at: { segment: 's2', step: 0 } });
    expect(zooms[0].message).toContain('2 camera zooms');
    expect(of(r, 'zoom-not-slow')).toHaveLength(2);
  }, LONG);

  it('a transition over a click', async () => {
    await makeCase(ws, 'transition', scenesTimeline([6, 6], { steps: { 0: [{ action: 'click', t_start: 5.3, t_end: 5.95, t_click: 5.9, point: { x: 700, y: 400 } }] } }));
    const r = await review('transition-v1');
    const t = of(r, 'transition-on-click');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ severity: 'warning', at: { segment: 's1', scene: 's1', step: 1 } });
    expect(t[0].message).toContain('crossfade s1→s2');
  }, LONG);

  it('a 35 s scene at 1×, a long wait on an unchanging screen, empty cards, a video far under 1 min; pagination', async () => {
    // A fixed `wait` (since L2.12 the planner plays a `wait_for`'s waiting faster; a fixed wait is the author's choice).
    await makeCase(ws, 'long', scenesTimeline([35], { steps: { 0: [{ action: 'wait', t_start: 8, t_end: 13 }] } }), { draw: { emptyCards: true } });
    const r = await review('long-v1', { sheet: { columns: 4, rows: 3 } });
    expect(of(r, 'long-scene')).toHaveLength(1);
    expect(of(r, 'long-scene')[0]).toMatchObject({ severity: 'warning', at: { segment: 's1' } });
    expect(of(r, 'long-scene')[0].message).toMatch(/lasts 34\.\d s at 1\.00×/);
    expect(of(r, 'scene-length')[0]).toMatchObject({ severity: 'info' });
    const wait = of(r, 'long-wait');
    expect(wait).toHaveLength(1);
    expect(wait[0].severity).toBe('warning');
    // The wait (8–13 s) and the time after it until the next step (16.9 s): 8.9 s of output at 1×.
    expect(wait[0].message).toMatch(/barely changes for 8\.9 s while the scenario waits \(step 0, /);
    expect(of(r, 'empty-segment').map((f) => f.at?.segment)).toEqual(['intro', 'outro']);
    const length = of(r, 'video-length');
    expect(length).toHaveLength(1);
    expect(length[0].severity).toBe('warning');
    // Pagination: 40 s at 1 fps on 4 × 3 pages → 4 pages of 10; the scene sheet (2 fps, 69 tiles) → 6 pages.
    const dir = r.files.dir;
    expect(r.files.sheets.map((f) => f.slice(dir.length + 1))).toEqual(['sheet_1fps.jpg', 'sheet_1fps_p2.jpg', 'sheet_1fps_p3.jpg', 'sheet_1fps_p4.jpg']);
    expect(r.files.scene_sheets.s1.map((f) => f.slice(dir.length + 1))).toEqual(['sheet_scene_s1.jpg', ...[2, 3, 4, 5, 6].map((p) => `sheet_scene_s1_p${p}.jpg`)]);
    const page = await sharp(r.files.sheets[0]).metadata();
    expect(page.width).toBe(4 * 300 + 5 * 8);
    // Reviewing again replaces the folder: no stale page is left.
    const again = await review('long-v1', { fps: 2 });
    expect((await readdir(dir)).filter((f) => f.startsWith('sheet_1fps'))).toEqual([]);
    expect(again.files.sheets[0]).toBe(join(dir, 'sheet_2fps.jpg'));
  }, LONG);

  it('video length: a warning far outside 1–2 min, info when a little outside (rules adjustable)', async () => {
    await makeCase(ws, 'short', scenesTimeline([5, 5]));
    const r = await review('short-v1');
    expect(of(r, 'video-length')[0]).toMatchObject({ severity: 'warning' });
    expect(of(r, 'video-length')[0].message).toMatch(/the video lasts 1\d\.\d s: \d+\.\d s shorter than the 60–120 s target/);
    const lenient = await review('short-v1', { rules: { video_min_s: 15, video_max_s: 30 } });
    expect(of(lenient, 'video-length')[0]).toMatchObject({ severity: 'info' });
    expect(of(lenient, 'video-length')[0].message).toContain('within the 25 % tolerance');
    const inside = await review('short-v1', { rules: { video_min_s: 10, video_max_s: 30 } });
    expect(of(inside, 'video-length')).toEqual([]);
  }, LONG);

  it('diff with the previous render of the scenario: durations, plan changes, visibly changed frames', async () => {
    const v1 = await makeCase(ws, 'diff', scenesTimeline([6, 6]));
    await makeCase(ws, 'diff', v1.timeline, {
      version: 2,
      run: v1.run,
      draw: { otherPattern: ['s2'] },
      mutate: (plan) => {
        for (const c of plan.captions) if (c.scene === 's1') c.text = 'A new caption for the first scene.';
        const s1 = plan.segments.find((x): x is ClipSegment => x.kind === 'clip' && x.scene === 's1')!;
        s1.cues = s1.cues.map((c) => ({ ...c, text: 'A new caption for the first scene.' }));
      },
    });
    const r = await review('latest', { scenario: 'diff' });
    expect(r.render.id).toBe('diff-v2');
    const d = r.diff!;
    expect(d.previous).toBe('diff-v1');
    expect(d.duration_s.delta).toBe(0);
    expect(d.segments.find((x) => x.id === 's1')).toMatchObject({ status: 'changed', changes: ['caption text'] });
    expect(d.segments.find((x) => x.id === 's2')).toMatchObject({ status: 'same' });
    expect(d.compared).toBeGreaterThan(10);
    expect(d.changed_frames.length).toBeGreaterThan(2);
    expect(new Set(d.changed_frames.map((f) => f.segment))).toEqual(new Set(['s2']));
    expect(existsSync(d.sheet!)).toBe(true);
    expect(r.files.diff_sheet).toBe(join(r.files.dir, 'diff_diff-v1.jpg'));
    expect(codes(r)).toEqual(expect.arrayContaining(['diff-duration', 'diff-segment', 'diff-frames']));
    expect(r.findings.filter((f) => f.code.startsWith('diff-')).every((f) => f.severity === 'info')).toBe(true);
    const none = await review('diff-v2', { previous: false });
    expect(none.diff).toBeUndefined();
    expect(none.files.diff_sheet).toBeUndefined();
    const explicit = await review('diff-v2', { previous: 'diff-v1', fps: 2 });
    expect(explicit.diff?.compared).toBeGreaterThan(d.compared);
    // The first render has nothing to compare with.
    expect((await review('diff-v1')).diff).toBeUndefined();
    await expect(review('diff-v2', { previous: 'diff-v2' })).rejects.toThrow(/is the render under review/);
  }, LONG);

  it('finds renders by id, path or latest, and says when one is missing', async () => {
    const byPath = await review(join(ws.project.dir, 'renders', 'clean-v1.mp4'), { thumbnails: false, previous: false });
    expect(byPath.render.id).toBe('clean-v1');
    await expect(review('nope-v9')).rejects.toThrow(/render "nope-v9" not found/);
    await expect(review('latest', { scenario: 'ghost' })).rejects.toThrow(/no render of scenario "ghost"/);
  }, LONG);
});
