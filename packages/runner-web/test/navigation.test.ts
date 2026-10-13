/**
 * R-ISS-08 for real: full-page navigations never show a blank or loading frame in the capture. A grey home page links
 * to a page that paints only a yellow skeleton for 1 s (no text, image or SVG: no first contentful paint) on the same
 * site and on another site (localhost vs 127.0.0.1: another renderer), to a page that never paints content (blue
 * blocks) and to a client-side route. Captured with the debug cursor (a magenta dot) and its frames kept: no yellow or
 * white picture in capture.mp4 — a fresh tab's about:blank included —, `timeline.loading` lists each held load, no
 * frame lies inside one, the stills start after them, the first frame after each shows the cursor, and a click that
 * navigated keeps after_navigation_ms of the new page after the held load. A control records the same navigation
 * without the hold: its frames show the skeleton. Then (L1.2 review): a fresh tab opened by a step or after a
 * switch_page is not waited for, a step's hold after a non-click navigation starts on the painted page, and a cancelled
 * run stops waiting for a held load.
 */
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TimelineSchema } from '@demo-studio/core';
import type { Timeline, TimelineEvent, TimelineLoading } from '@demo-studio/core';
import { CaptureClock, ScreencastRecorder, kitConfigFor, openSession, runScenario } from '../src/index.js';
import type { FrameIndexEntry } from '../src/index.js';
import { FAST, debugTemplate, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';
import { NO_CONTENT_PAGE, latePaintPage, navHomePage } from './pages.js';

let here: TestServer;
let away: TestServer;
let awayUrl: string;
let dir: string;
let tl: Timeline;
let runDir: string;

const GREY = [221, 227, 234];
const GREEN = [31, 174, 75];
const BLUE = [48, 96, 208];
const YELLOWS = [
  [245, 208, 0],
  [224, 187, 0],
];
const WHITE = [255, 255, 255];
/** A page that never paints content and never goes network idle (a request every 200 ms): held up to the 10 s limit. */
const BUSY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Busy</title></head><body style="margin:0;background:#3060d0">
<div style="width:400px;height:300px;background:#204090"></div><script>setInterval(() => fetch('/ping?' + Math.random()).catch(() => {}), 200);</script></body></html>`;
/** A page that goes to the slow page by itself 2.2 s after it loaded (an app's own navigation). */
const REDIRECT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Redirect</title></head><body style="margin:0;background:#dde3ea;font-family:sans-serif">
<h1 style="margin:40px">Moving on</h1><script>addEventListener('load', () => setTimeout(() => (location.href = '/late'), 2200));</script></body></html>`;
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** Pixels of a video or an image sequence scaled to 80×60 (one pixel per 10×10 block of the 800×600 capture). */
function decodeSmall(args: string[]): Buffer[] {
  const out = execFileSync('ffmpeg', ['-v', 'error', ...args, '-vf', 'scale=80:60', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 512 * 1024 * 1024 });
  const n = 80 * 60 * 3;
  return Array.from({ length: Math.floor(out.length / n) }, (_, i) => out.subarray(i * n, (i + 1) * n));
}
/** The bottom-right block (780–790, 580–590 px): only a page's background, never a link or the cursor. */
const corner = (f: Buffer) => [...f.subarray((58 * 80 + 78) * 3, (58 * 80 + 78) * 3 + 3)];

/** Magenta pixels (the debug cursor's dot) in a full-size frame file. */
function hasCursor(file: string): boolean {
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  let n = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] > 190 && px[i + 1] < 90 && px[i + 2] > 190) n++;
  return n >= 6;
}

async function frameIndex(file: string): Promise<FrameIndexEntry[]> {
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as FrameIndexEntry)
    .sort((x, y) => x.t - y.t);
}

beforeAll(async () => {
  away = await startServer({ '/late': latePaintPage(1000) });
  // Another site: the same loopback by name, not by address.
  awayUrl = away.url.replace('127.0.0.1', 'localhost');
  here = await startServer({ '/': navHomePage(awayUrl), '/late': latePaintPage(1000), '/plain': NO_CONTENT_PAGE, '/spa-route': navHomePage(awayUrl), '/busy': BUSY_PAGE, '/redirect': REDIRECT_PAGE });
  dir = await tempDir('rw-nav-');
  const project = makeProject(dir, { app: here.url, other: awayUrl });
  const scenario = makeScenario('nav', {
    pacing: { ...FAST, after_navigation_ms: 800 },
    scenes: [
      { id: 'same', page: 'app', open: '/', steps: [{ click: { css: '#late' } }, { wait_for: { text: 'Report ready' } }, { hold: 0.3 }] },
      { id: 'away', page: 'app', open: '/', steps: [{ click: { css: '#away' } }, { wait_for: { text: 'Report ready' } }, { hold: 0.3 }] },
      // A fresh tab (about:blank) opening a slow page at the scene's start.
      { id: 'direct', page: 'other', open: '/late', steps: [{ hold: 0.3 }] },
      { id: 'plain', page: 'app', open: '/plain', steps: [{ hold: 0.3 }] },
      { id: 'spa', page: 'app', open: '/', steps: [{ click: { css: '#spa' } }, { hold: 0.3 }] },
    ],
  });
  const rec = await runScenario({ project, scenario, template: debugTemplate(), mode: 'capture', runId: `nav-${Date.now()}` });
  expect(rec.error?.message).toBeUndefined();
  tl = await readTimeline(rec.timeline!);
  runDir = rec.dir;
}, 240_000);

afterAll(async () => {
  await here?.close();
  await away?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** The scene a capture time belongs to (a load begun while the scene's page is switched to: that scene). */
const sceneOf = (t: number) => tl.scenes.find((s) => s.kind === 'scene' && t < s.t_end)!;
const loadsIn = (scene: string) => (tl.loading ?? []).filter((l) => sceneOf(l.t_start)?.id === scene);

describe('full-page loads in the capture (R-ISS-08)', () => {
  it('lists every held load in timeline.loading: until the paint, a load without one, never a client-side route', () => {
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
    const click = (scene: string) => tl.events.find((e) => e.scene === scene && e.step === 0)!;
    const after = (scene: string): TimelineLoading => loadsIn(scene).find((l) => l.t_start >= click(scene).t_click! - 1e-3)!;
    for (const scene of ['same', 'away']) {
      const l = after(scene);
      expect(l, JSON.stringify(tl.loading)).toMatchObject({ page: 'app', until: 'paint' });
      // The skeleton lasts 1 s after the page's own load.
      expect(l.t_end - l.t_start, scene).toBeGreaterThan(0.9);
      expect(l.held_frames).toBeGreaterThan(10);
    }
    // The fresh tab: from about:blank to the paint, before the still.
    const direct = loadsIn('direct');
    expect(direct.some((l) => l.page === 'other' && l.until === 'paint' && l.t_end - l.t_start > 0.9), JSON.stringify(direct)).toBe(true);
    // A page that never paints content: shown once loaded and quiet.
    expect(loadsIn('plain').some((l) => l.page === 'app' && l.until === 'load'), JSON.stringify(loadsIn('plain'))).toBe(true);
    // A client-side route (pushState) is no page load.
    expect(loadsIn('spa').filter((l) => l.t_start >= click('spa').t_click! - 1e-3)).toEqual([]);
    expect(tl.warnings.filter((w) => /painted nothing|froze/.test(w))).toEqual([]);
  });

  it('no frame inside a held load; every still starts after them; the first frame after one shows the cursor', async () => {
    const frames = await frameIndex(join(runDir, 'frames.jsonl'));
    for (const l of tl.loading ?? []) {
      expect(frames.filter((f) => f.t >= l.t_start && f.t < l.t_end), JSON.stringify(l)).toEqual([]);
      const still = tl.events.find((e) => e.action === 'scene_still' && e.scene === sceneOf(l.t_start).id)!;
      if (l.t_start < still.t_start) expect(l.t_end, JSON.stringify(l)).toBeLessThanOrEqual(still.t_start + 1e-3);
    }
    // The cursor is drawn in the first frame of a painted page (no blink) once it is known (after the first scene's start).
    const painted = (tl.loading ?? []).filter((l) => l.until === 'paint' && l.t_start > 1);
    expect(painted.length).toBeGreaterThanOrEqual(3);
    for (const l of painted) {
      const first = frames.find((f) => f.t >= l.t_end)!;
      expect(first, JSON.stringify(l)).toBeDefined();
      expect(hasCursor(join(runDir, 'frames', first.file)), `${first.file} after ${JSON.stringify(l)}`).toBe(true);
    }
  });

  it('capture.mp4 never shows the skeleton or a blank page, its first frame included', () => {
    const frames = decodeSmall(['-i', join(runDir, 'capture.mp4')]);
    expect(frames.length).toBeGreaterThan(30);
    const colours = frames.map(corner);
    const bad = colours.map((c, i) => [i, c] as const).filter(([, c]) => YELLOWS.some((y) => near(c, y)) || near(c, WHITE, 12));
    expect(bad.slice(0, 5)).toEqual([]);
    const other = colours.map((c, i) => [i, c] as const).filter(([, c]) => ![GREY, GREEN, BLUE].some((k) => near(c, k)));
    expect(other.slice(0, 5)).toEqual([]);
    expect(colours.some((c) => near(c, GREEN)) && colours.some((c) => near(c, BLUE))).toBe(true);
  });

  it('a click that navigated leaves after_navigation_ms of the new page after the held load (R-CHO-07)', () => {
    for (const scene of ['same', 'away']) {
      const click = tl.events.find((e) => e.scene === scene && e.step === 0)!;
      const l = loadsIn(scene).find((x) => x.t_start >= click.t_click! - 1e-3)!;
      expect(click.t_end - click.t_click!, scene).toBeGreaterThanOrEqual(0.8 + (l.t_end - l.t_start) - 0.02);
      // …and the page is shown that long after its paint.
      expect(click.t_end - l.t_end, scene).toBeGreaterThan(0.5);
    }
  });
});

describe('control: the same navigation recorded without the hold (R-ISS-08)', () => {
  it('the skeleton is filmed without the hold, never with it', async () => {
    const session = await openSession({ width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined, { style: 'debug' }) });
    try {
      const page = await session.page('main');
      const out: Record<string, { frames: Buffer[]; loading: TimelineLoading[] }> = {};
      for (const holdLoads of [false, true]) {
        await page.goto(`${here.url}/`);
        const clock = new CaptureClock();
        const sub = join(dir, `control-${holdLoads}`);
        const rec = new ScreencastRecorder({ framesDir: join(sub, 'frames'), indexFile: join(sub, 'frames.jsonl'), format: 'jpeg', quality: 80, width: 800, height: 600, scale: 1, clock, holdLoads });
        await rec.start(page);
        await page.waitForTimeout(200);
        await page.click('#late');
        await page.waitForFunction(() => document.body.innerText.includes('Report ready'));
        await page.waitForTimeout(400);
        await rec.stop();
        out[String(holdLoads)] = { frames: decodeSmall(['-framerate', '30', '-i', join(sub, 'frames', '%06d.jpg')]), loading: rec.loadingIntervals() };
      }
      const yellow = (fs: Buffer[]) => fs.map(corner).filter((c) => YELLOWS.some((y) => near(c, y))).length;
      expect(yellow(out.false.frames)).toBeGreaterThan(5);
      expect(out.false.loading).toEqual([]);
      expect(yellow(out.true.frames)).toBe(0);
      expect(out.true.frames.map(corner).some((c) => near(c, GREEN))).toBe(true);
      expect(out.true.loading).toEqual([expect.objectContaining({ until: 'paint' })]);
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe('blank tabs, non-click navigations and cancelling a held load (R-ISS-08, L1.2 review)', () => {
  let tl2: Timeline;
  let dir2: string;
  let ms: number;

  beforeAll(async () => {
    const project = makeProject(dir, { app: here.url, other: awayUrl });
    const scenario = makeScenario('nav2', {
      pacing: FAST,
      scenes: [
        // No scene `open`: the first step opens the page — the fresh tab's about:blank is not waited for (no 10 s stall).
        { id: 'fresh', page: 'app', steps: [{ open: '/late', hold: 0.3 }] },
        // A page never opened yet, then opened up to its commit only: the step's hold starts on the painted page.
        { id: 'commit', page: 'app', open: '/', steps: [{ switch_page: 'other' }, { open: { url: '/late', wait_until: 'commit' }, hold: 0.3 }] },
      ],
    });
    const t0 = Date.now();
    const rec = await runScenario({ project, scenario, template: debugTemplate(), mode: 'capture', runId: `nav2-${Date.now()}` });
    ms = Date.now() - t0;
    expect(rec.error?.message).toBeUndefined();
    tl2 = await readTimeline(rec.timeline!);
    dir2 = rec.dir;
  }, 120_000);

  it('a fresh tab is not waited for: the run goes on, the page is held until the step opens it, no time limit hit', async () => {
    expect(ms).toBeLessThan(9000);
    const fresh = tl2.events.find((e) => e.scene === 'fresh' && e.action === 'scene_still')!;
    expect(fresh.t_start).toBeLessThan(2);
    expect((tl2.loading ?? []).filter((l) => l.until === 'limit')).toEqual([]);
    expect(tl2.warnings.filter((w) => /stayed blank|painted nothing/.test(w))).toEqual([]);
    // Both slow pages held until their paint (≥ 1 s of skeleton), no frame inside a hold.
    expect((tl2.loading ?? []).filter((l) => l.until === 'paint' && l.t_end - l.t_start > 0.9).map((l) => l.page)).toEqual(['app', 'other']);
    const frames = await frameIndex(join(dir2, 'frames.jsonl'));
    for (const l of tl2.loading ?? []) expect(frames.filter((f) => f.t >= l.t_start && f.t < l.t_end), JSON.stringify(l)).toEqual([]);
  });

  it('a step that navigated without a click ends on the painted page: its hold is never inside the held load', () => {
    const opens = tl2.events.filter((e): e is TimelineEvent & { hold: { t_start: number; t_end: number } } => e.action === 'open' && e.hold !== undefined);
    expect(opens).toHaveLength(2);
    for (const e of opens) {
      // The load the step started (for a fresh tab: held since the tab opened, continued by the navigation).
      const l = (tl2.loading ?? []).find((x) => x.t_end > e.t_start && x.t_start < e.t_end)!;
      expect(l, JSON.stringify(e)).toBeDefined();
      expect(e.hold.t_start, JSON.stringify({ e, l })).toBeGreaterThanOrEqual(l.t_end - 1e-3);
    }
  });

  it('a cancelled run stops waiting for a held load at once', async () => {
    const project = makeProject(dir, { app: here.url });
    const scenario = makeScenario('busy', { pacing: FAST, scenes: [{ id: 'busy', page: 'app', open: '/', steps: [{ open: '/busy' }, { hold: 0.3 }] }] });
    const ac = new AbortController();
    let abortedAt = 0;
    const rec = await runScenario({
      project,
      scenario,
      mode: 'capture',
      signal: ac.signal,
      runId: `busy-${Date.now()}`,
      onProgress: (e) => {
        // The `open` step waits for the page's paint (it never comes before the 10 s limit): cancel meanwhile.
        if (e.type === 'step_start' && e.step === 0) setTimeout(() => ((abortedAt = Date.now()), ac.abort()), 1500);
      },
    });
    expect(rec.status).toBe('cancelled');
    expect(abortedAt).toBeGreaterThan(0);
    expect(Date.now() - abortedAt).toBeLessThan(4000);
  }, 60_000);

  it('a multi-page scene: no step starts while another page’s load is held (it is cut from every page)', async () => {
    const project = makeProject(dir, { app: here.url, other: awayUrl });
    const steps = Array.from({ length: 8 }, () => ({ on: 'right', hold: 0.3 }));
    const scenario = makeScenario('two', {
      pacing: FAST,
      scenes: [{ id: 'two', pages: { left: { page: 'app', open: '/redirect' }, right: { page: 'other', open: '/late' } }, steps }],
    });
    const rec = await runScenario({ project, scenario, mode: 'capture', runId: `two-${Date.now()}` });
    expect(rec.error?.message).toBeUndefined();
    const t = await readTimeline(rec.timeline!);
    // The left page's own navigation (the skeleton page, ≥ 1 s) happened during the right page's steps.
    const held = (t.tracks?.find((tr) => tr.id === 'left')?.loading ?? []).filter((l) => l.until === 'paint' && l.t_end - l.t_start > 0.9);
    const still = t.events.find((e) => e.action === 'scene_still')!;
    expect(held.filter((l) => l.t_start > still.t_end), JSON.stringify(t.tracks?.map((tr) => tr.loading))).toHaveLength(1);
    const starts = t.events.filter((e) => e.step >= 0).map((e) => e.t_start);
    for (const l of held) expect(starts.filter((x) => x > l.t_start + 0.02 && x < l.t_end - 1e-3), JSON.stringify(l)).toEqual([]);
  }, 60_000);
});
