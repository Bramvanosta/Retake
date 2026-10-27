/**
 * L4.5 part C, gated (`DEMO_STUDIO_TEST_CHROME=1`; skipped when Google Chrome is not installed): the timeline screen in
 * the installed Google Chrome (Playwright `channel: 'chrome'`, a temporary profile Playwright creates and deletes — never
 * the person's own; Playwright's mock keychain, no `ignoreDefaultArgs`), which plays H.264 like the person's browser:
 * - takes encoded as the capture encodes — VideoToolbox (keyframes every 12 frames, no B-frames; when this Mac's ffmpeg
 *   has it) and the libx264 fallback (a 250-frame GOP, B-frames) — of the self-numbering synthetic take: no "cannot play"
 *   message, every seek shows exactly the plan's source frame, and the numbers (critique B14): seek → settled latency
 *   (median, p95, max) per encoder, playback (output frames per second of wall time);
 * - with `DEMO_STUDIO_TEST_REAL=<workspace>:<project>:<scenario>`, also a real capture of the fixture product in that
 *   workspace (opened read-only: nothing is written there but the Studio's own state folder): it loads, seeks settle,
 *   it plays — the same numbers. `DEMO_STUDIO_UI_SHOTS=<folder>` saves a screenshot of it there.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TimelineViewResult } from '@demo-studio/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { BITS_TEXT, bitsTimeline, hasEncoder, readBits, takeWorkspace, writeTake } from './timeline-take.js';
import type { TakeCodec } from './timeline-take.js';

const CHROME_APP = '/Applications/Google Chrome.app';
const gated = process.env.DEMO_STUDIO_TEST_CHROME === '1' && hasTool('ffmpeg') && hasTool('ffprobe') && (process.platform !== 'darwin' || existsSync(CHROME_APP));
const REAL = process.env.DEMO_STUDIO_TEST_REAL;
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const POLL = { timeout: 30_000 };
const savedHome = process.env.DEMO_STUDIO_HOME;

let ws: string;
let browser: Browser;
const servers: StudioServer[] = [];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openTimeline(studio: StudioServer, project: string, scenario: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 1, name: 'Projects' }).waitFor();
  await page.goto(`${studio.url}#/p/${encodeURIComponent(project)}/s/${encodeURIComponent(scenario)}/timeline`);
  await page.getByTestId('tracks').waitFor();
  return page;
}

const settled = (page: Page) => expect.poll(() => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
const shown = async (page: Page) => Number(await page.getByTestId('preview').getAttribute('data-frame'));

/** Seek with the keys to each target (Home, then Shift+→ / →), timing key press → settled. */
async function seekTimes(page: Page, targets: number[], fps: number, check?: (frame: number) => Promise<void>): Promise<number[]> {
  const times: number[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const t of targets) {
    // To the frame before the target (Home, Shift+→ per second, → per frame), settled.
    await page.keyboard.press('Home');
    await settled(page);
    const seconds = Math.floor((t - 1) / fps);
    for (let i = 0; i < seconds; i++) await page.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < t - 1 - seconds * fps; i++) await page.keyboard.press('ArrowRight');
    await settled(page);
    // The timed seek: one frame on, from a settled preview.
    const t0 = Date.now();
    await page.keyboard.press('ArrowRight');
    await settled(page);
    times.push(Date.now() - t0);
    expect(await shown(page)).toBe(t);
    await check?.(t);
  }
  return times;
}

/** Plays `ms` from the start: output frames per second of wall time. */
async function playback(page: Page, ms: number, fps: number): Promise<{ fps: number; errors: string }> {
  await page.keyboard.press('Home');
  await settled(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const t0 = Date.now();
  await page.keyboard.press(' ');
  await expect.poll(() => page.getByTestId('play').innerText(), POLL).toBe('Pause');
  await sleep(ms);
  const f = await shown(page);
  const wall = (Date.now() - t0) / 1000;
  await page.keyboard.press(' ');
  await expect.poll(() => page.getByTestId('play').innerText(), POLL).toBe('Play');
  await settled(page);
  const notes = (await page.getByTestId('preview-notes').count()) ? await page.getByTestId('preview-notes').innerText() : '';
  void fps;
  return { fps: Math.round((f / wall) * 10) / 10, errors: notes };
}

beforeAll(async () => {
  if (!gated) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-chrome-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) await s.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!gated)('the timeline in the installed Google Chrome (H.264)', () => {
  it('the capture encoders’ H.264 takes play: exact frames, seek latency and playback measured', async () => {
    const dir = await takeWorkspace(ws);
    const codecs: TakeCodec[] = [...(hasEncoder('h264_videotoolbox') ? (['h264-videotoolbox'] as const) : []), 'h264-x264'];
    for (const c of codecs) await writeTake(dir, c, { run: `20260101-120000-${c}`, text: BITS_TEXT.replace('video: Bits', `video: ${c}`), timeline: bitsTimeline(), codec: c, seconds: 8 });
    const studio = await startStudioServer({ root: ws, startWorker: false });
    servers.push(studio);
    for (const c of codecs) {
      const v = (await studio.engine.timeline.view({ project: 'demo', scenario: c })) as Extract<TimelineViewResult, { view: unknown }>;
      const srcAt = (frame: number) => {
        for (const s of v.plan.segments) if (s.kind === 'clip' && s.from <= frame && frame < s.from + s.durationInFrames) return s.srcFrames[frame - s.from];
        return undefined;
      };
      const page = await openTimeline(studio, 'demo', c);
      expect(await page.getByTestId('cannot-play').count()).toBe(0);
      expect(await page.getByTestId('capture-codec').innerText()).toContain('H.264');
      await settled(page);
      const m = v.view.model;
      // Frames inside the clips (not in a transition): scene a's first step, scene b after its crossfade.
      const a = m.segments.find((s) => s.id === 'a')!;
      const b = m.segments.find((s) => s.id === 'b')!;
      const targets = [5, 17, 29, 41, b.from + (b.transition?.frames ?? 0) + 2, b.from + (b.transition?.frames ?? 0) + 9, b.to - 6, a.from + 50].filter((f) => srcAt(f) !== undefined);
      const exact: string[] = [];
      const times = await seekTimes(page, targets, m.fps, async (f) => {
        const got = readBits(await page.getByTestId('preview-frame').screenshot());
        exact.push(`${f}→${got}`);
        expect(got, `${c}: output frame ${f}`).toBe(srcAt(f));
      });
      const play = await playback(page, 2000, m.fps);
      expect(play.fps).toBeGreaterThan(m.fps * 0.5);
      expect(play.errors).toBe('');
      console.log(
        `chrome ${c}: keyframes every ${v.view.capture.keyframe_interval_s} s${v.view.capture.b_frames ? ', B-frames' : ''}; ${times.length} seeks exact (${exact.join(', ')}); seek → settled median ${pct(times, 0.5)} ms, p95 ${pct(times, 0.95)} ms, max ${Math.max(...times)} ms; playback ${play.fps} output frames/s (plan ${m.fps})`,
      );
      await page.context().close();
    }
  }, 300_000);

  it.skipIf(!REAL)('a real capture of the fixture product (DEMO_STUDIO_TEST_REAL): loads, seeks settle, plays', async () => {
    const [root, project, scenario] = (REAL ?? '').split(':');
    const studio = await startStudioServer({ root, startWorker: false });
    servers.push(studio);
    const t0 = Date.now();
    const v = await studio.engine.timeline.view({ project, scenario });
    const viewMs = Date.now() - t0;
    if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
    const m = v.view.model;
    const page = await openTimeline(studio, project, scenario);
    const opened = Date.now();
    expect(await page.getByTestId('cannot-play').count()).toBe(0);
    await settled(page);
    const firstMs = Date.now() - opened;
    const step = Math.floor(m.frames / 9);
    const times = await seekTimes(page, Array.from({ length: 8 }, (_x, i) => (i + 1) * step), m.fps);
    const play = await playback(page, 3000, m.fps);
    expect(play.errors).toBe('');
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (let i = 0; i < 4; i++) await page.keyboard.press(']');
      await settled(page);
      await page.screenshot({ path: join(SHOTS, 'timeline-chrome-real.png') });
    }
    console.log(
      `chrome real ${project}/${scenario} (${v.view.run_id}): ${m.frames} frames, ${m.segments.length} segments, ${v.view.capture.codec} keyframes every ${v.view.capture.keyframe_interval_s} s${v.view.capture.b_frames ? ', B-frames' : ''}; timeline view ${viewMs} ms; first frame settled ${firstMs} ms after the tracks; seek → settled median ${pct(times, 0.5)} ms, p95 ${pct(times, 0.95)} ms, max ${Math.max(...times)} ms; playback ${play.fps} output frames/s (plan ${m.fps})`,
    );
    await page.context().close();
  }, 300_000);
});
