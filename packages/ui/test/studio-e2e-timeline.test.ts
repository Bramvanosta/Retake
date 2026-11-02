/**
 * L4.5 part C: the timeline screen end to end in headless Chromium (playwright-core's build: it plays VP9, not H.264),
 * against a real Studio server, its player origin and the real preview bundle, on a synthetic take whose every
 * capture frame shows its own index in binary (timeline-take.ts):
 * - the scenario screen's "Open timeline" (R-UI-15: disabled with why without a capture) → the timeline route; the
 *   tracks from the view (segments, captions, steps, camera, speed and cuts, markers, comment pins at their frames, a
 *   comment of another take beside the track); one iframe, with PREVIEW_FRAME_ATTRS and a frame URL of the player origin;
 * - the preview: loading until `settled`, muted at first ("Unmute" asks the frame, its state answers); clicks on the
 *   tracks, a drag of the scrubber and the keys (arrows, Shift+arrows, Home, End, ], Space) — after each, the frame shown
 *   in the iframe (a screenshot of its region, decoded) is exactly the source frame the plan maps that output frame to,
 *   in a scene at normal speed and in a scene at 2×; zoom fit and in; "Show in timeline" (a step's route);
 * - a take encoded as the capture encodes (libx264, H.264): Playwright's Chromium cannot play it — the real message
 *   (critique B14), no frame, the tracks and the scrubber still working, the codec and the slow-scrub note shown.
 * - L5.9 (review B-M1): inside the shell at 1440 × 900 and 1280 × 800, as many track rows show on load as before it.
 * `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots there.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TimelineViewResult } from '@demo-studio/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { FRAME_URL_RE, landingOf } from '../src/app/timeline-words.js';
import { PREVIEW_FRAME_ATTRS } from '../src/player/parent.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { BITS_TEXT, bitsTimeline, readBits, takeWorkspace, writeTake, writeThread } from './timeline-take.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const POLL = { timeout: 30_000 };
const RUN = '20260101-120000-bits';
const H264_RUN = '20260101-120000-h264';
let ws: string;
let dir: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let plan: Extract<TimelineViewResult, { view: unknown }>;
const savedHome = process.env.DEMO_STUDIO_HOME;
const consoleErrors: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The source frame the plan shows at an output frame (a clip's srcFrames), or undefined (not a clip). */
function srcAt(frame: number): number | undefined {
  for (const s of plan.plan.segments) if (s.kind === 'clip' && s.from <= frame && frame < s.from + s.durationInFrames) return s.srcFrames[frame - s.from];
  return undefined;
}

const csp = () => page.evaluate(() => (window as unknown as { __csp: number }).__csp);
const shown = async () => Number(await page.getByTestId('preview').getAttribute('data-frame'));

/** Wait until the preview is settled at the frame the page shows, then read the frame in the iframe. */
async function settledFrame(): Promise<{ frame: number; src: number }> {
  await expect.poll(async () => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
  const frame = await shown();
  // The iframe's region of the page (scrolled into view), as the person sees it.
  const png = await page.getByTestId('preview-frame').screenshot();
  return { frame, src: readBits(png) };
}

/** The frame in the preview is exactly the plan's source frame for the frame shown. */
async function expectExact(what: string): Promise<number> {
  const { frame, src } = await settledFrame();
  expect(src, `${what}: output frame ${frame} shows source frame ${src}, the plan maps it to ${srcAt(frame)}`).toBe(srcAt(frame));
  return frame;
}

const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-timeline-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  dir = await takeWorkspace(ws);
  await writeTake(dir, 'bits', { run: RUN, text: BITS_TEXT, timeline: bitsTimeline(), codec: 'vp9', seconds: 8 });
  await writeTake(dir, 'h264', { run: H264_RUN, text: BITS_TEXT.replace('video: Bits', 'video: H264'), timeline: bitsTimeline(), codec: 'h264-x264', seconds: 8 });
  await writeTake(dir, 'nocap', { run: '20260101-110000-nocap', text: BITS_TEXT, timeline: bitsTimeline(), codec: 'vp9', seconds: 1 });
  await rm(join(dir, 'runs', '20260101-110000-nocap'), { recursive: true });
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  const v = await studio.engine.timeline.view({ project: 'demo', scenario: 'bits' });
  if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
  plan = v;
  // A comment on this take at step a.1, and one made on another take (beside the track).
  await writeThread(dir, { id: 'c_01JAAAAAAAAAAAAAAAAAAAAAAA', scenario: 'bits', run: RUN, frames: v.plan.durationInFrames, text: 'The zoom starts <b>too early</b>', anchor: { segment: 'a', kind: 'clip', scene: 'a', step: 1 } });
  await writeThread(dir, { id: 'c_01JBBBBBBBBBBBBBBBBBBBBBBB', scenario: 'bits', run: '20250101-120000-bits', frames: 100, text: 'An older take', anchor: { segment: 'b', kind: 'clip', scene: 'b', step: 0 } });
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('the timeline screen in Chromium', () => {
  it('Open timeline from the scenario screen (disabled with why without a capture); the tracks, pins and the one frame', async () => {
    await page.goto(`${studio.url}#/p/demo/s/nocap`);
    await page.getByRole('heading', { level: 1, name: 'nocap' }).waitFor();
    await expect.poll(() => page.getByTestId('open-timeline-off').isDisabled(), POLL).toBe(true);
    // L5.10b: the kit button says why it is off (aria-describedby).
    const why = await page.getByTestId('open-timeline-off').getAttribute('aria-describedby');
    expect(await page.locator(`[id="${why}"]`).innerText()).toContain('no finished capture yet');

    await page.goto(`${studio.url}#/p/demo/s/bits`);
    await page.getByRole('heading', { level: 1, name: 'bits' }).waitFor();
    await page.getByTestId('open-timeline').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/demo/s/bits/timeline/${RUN}`);
    await page.getByTestId('tracks').waitFor();
    expect(await page.title()).toBe('bits · Timeline · Demo Studio');
    // L5.10b fixes (review B L2): its link back to the scenario says "Board", as the scenario's View does.
    expect(await page.getByRole('navigation', { name: 'Scenario views' }).getByRole('link').allInnerTexts()).toEqual(expect.arrayContaining(['Board', 'YAML']));

    const m = plan.view.model;
    expect(await page.getByTestId('tl-segment').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(m.segments.map((s) => s.id));
    expect(await page.getByTestId('tl-caption').count()).toBe(m.captions.length);
    expect(await page.getByTestId('tl-caption').first().innerText()).toBe('Every frame carries its number.');
    expect(await page.getByTestId('tl-step').count()).toBe(m.steps.length);
    expect(m.camera.length).toBeGreaterThan(0);
    expect(await page.getByTestId('tl-zoom').count()).toBe(m.camera.length);
    expect(await page.getByTestId('tl-speed').count()).toBe(m.speed.length);
    expect(m.cuts.length).toBeGreaterThan(0);
    expect(await page.getByTestId('tl-cut').count()).toBe(m.cuts.length);
    expect(await page.getByTestId('tl-marker').count()).toBe(1);
    // Pins: the comment of this take at step a.1's first frame, the other beside the track; text as text.
    const a1 = m.steps.find((s) => s.key === 'a.1')!.from;
    const pins = await page.getByTestId('tl-pin').evaluateAll((els) => els.map((e) => [e.getAttribute('data-frame'), e.getAttribute('data-status'), e.getAttribute('aria-label')]));
    expect(pins).toEqual([[String(a1), 'open', expect.stringContaining('The zoom starts <b>too early</b>')]]);
    expect(await page.getByTestId('pins-elsewhere').innerText()).toContain('An older take');
    expect(await page.locator('b').count()).toBe(0);
    // The codec and the facts.
    expect(await page.getByTestId('capture-codec').innerText()).toContain('VP9');

    // One frame: the literal sandboxed attributes, a frame URL of the player origin.
    expect(await page.locator('iframe').count()).toBe(1);
    const attrs = await page.getByTestId('preview-frame').evaluate((f) => Object.fromEntries(Array.from(f.attributes).map((a) => [a.name, a.value])));
    for (const [k, val] of Object.entries(PREVIEW_FRAME_ATTRS)) expect(attrs[k], k).toBe(val);
    expect(attrs.src.startsWith(`${studio.player.origin}/s/`)).toBe(true);
    expect(FRAME_URL_RE.test(attrs.src)).toBe(true);
    await expectExact('the first frame');
    await shot('timeline-open');
    expect(await csp()).toBe(0);
  }, 120_000);

  it('⚑ L5.9 (review B-M1): inside the shell, at 1440 × 900 and 1280 × 800, as many track rows show on load as before it (the preview sizes from the centre pane)', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`${studio.url}#/p/demo/s/bits/timeline/${RUN}`);
      await page.getByTestId('tracks').waitFor();
      // Measured once the screen has settled (the preview loaded, nothing left to arrive above the tracks).
      await expect.poll(async () => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
      await expect.poll(() => page.evaluate(() => document.getElementById('main')!.scrollTop), POLL).toBe(0);
      // Before the shell (L4.9) the page began at the window's top and the preview was min(44vh, 460px) tall (the
      // inspector beside it at most 150 px taller: the stage moves with the preview), the rest of the screen the same
      // (review B: 0 computed-style differences): a row showed when its top cleared the window's bottom. Now: when it
      // clears the centre pane's.
      const rows = await page.evaluate(() => {
        const pane = document.getElementById('main')!.getBoundingClientRect();
        const preview = document.querySelector('.tl-preview')!.getBoundingClientRect().height;
        const before = Math.min(0.44 * innerHeight, 460) - preview;
        const tops = [...document.querySelectorAll('[data-testid="tracks"] .tl-row')].map((r) => r.getBoundingClientRect().top - pane.top);
        const tracks = document.querySelector('[data-testid="tracks"]')!.getBoundingClientRect().top - pane.top;
        return { now: tops.filter((t) => t < pane.height - 8).length, then: tops.filter((t) => t + before < innerHeight - 8).length, seen: pane.height - tracks, seenThen: innerHeight - (tracks + before), preview };
      });
      await shot(`timeline-shell-dark-${width}`);
      const why = `${width}×${height}: ${JSON.stringify(rows)}`;
      expect(rows.now, why).toBeGreaterThanOrEqual(rows.then);
      // … and as much of the tracks' height (to the pixel).
      expect(rows.seen, why).toBeGreaterThanOrEqual(rows.seenThen - 1);
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('muted at first; Unmute asks the frame; clicks, a scrubber drag and the keys show exactly the plan\'s frames', async () => {
    const mute = page.getByTestId('mute');
    expect(await mute.innerText()).toBe('Unmute');
    await mute.click();
    await expect.poll(() => mute.innerText(), POLL).toBe('Mute');

    const m = plan.view.model;
    const seen: Array<[number, number]> = [];
    const check = async (what: string) => {
      const f = await expectExact(what);
      seen.push([f, srcAt(f)!]);
      return f;
    };
    // A click on a step of scene a (normal speed), then a few frames on with the arrows.
    const a0 = m.steps.find((s) => s.key === 'a.0')!;
    await page.locator('[data-testid="tl-step"][data-key="a.0"]').click();
    expect(await shown()).toBe(a0.from);
    await check('a click on step a.0');
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
    expect(await shown()).toBe(a0.from + 7);
    await check('seven frames on');
    await page.keyboard.press('Shift+ArrowRight');
    expect(await shown()).toBe(a0.from + 7 + m.fps);
    await check('a second on');
    // Scene b plays at 2× between its steps: a frame where the source advances by two, reached with the arrows.
    const b = m.segments.find((s) => s.id === 'b')!;
    // (after the crossfade into it: two layers draw there)
    let fast = b.from + (b.transition?.frames ?? 0);
    while (fast < b.to - 1 && srcAt(fast + 1)! - srcAt(fast)! !== 2) fast++;
    expect(srcAt(fast + 1)! - srcAt(fast)!).toBe(2);
    // A click lands after the crossfade into it (review B: never inside the transition).
    const landB = landingOf(b);
    await page.locator('[data-testid="tl-segment"][data-id="b"]').click();
    expect(await shown()).toBe(landB);
    for (let f = landB; f < fast; f++) await page.keyboard.press('ArrowRight');
    expect(await check('a frame of scene b at 2×')).toBe(fast);
    await page.keyboard.press('ArrowRight');
    await check('the next frame at 2×');
    // The idle cut: its tick seeks to the first frame after the jump.
    const cut = m.cuts[0];
    await page.locator(`[data-testid="tl-cut"][data-at="${cut.at}"]`).click();
    expect(await shown()).toBe(cut.at);
    const after = await check('the frame after the idle cut');
    expect(srcAt(after)! - srcAt(after - 1)!).toBeGreaterThan(m.fps / 2);
    // A drag of the scrubber across the timeline: many seeks, one frame shown at the end, exact.
    const box = (await page.getByTestId('scrubber').boundingBox())!;
    // (from the end of the video back into scene a's first step, across the card)
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + box.width * (0.75 - i * 0.03), box.y + box.height / 2);
    await page.mouse.up();
    const dragged = await check('after a scrubber drag');
    expect(dragged).toBeGreaterThan(a0.from + 10);
    expect(dragged).toBeLessThan(a0.to);
    // ] the next segment, Home, End (the last frame), [ back.
    await blur();
    await page.keyboard.press('Home');
    expect(await shown()).toBe(0);
    await page.keyboard.press(']');
    expect(await shown()).toBe(landingOf(m.segments[1]));
    await page.keyboard.press('End');
    expect(await shown()).toBe(m.frames - 1);
    await check('End');
    await page.keyboard.press('[');
    expect(await shown()).toBe(landingOf(m.segments[m.segments.length - 1]));
    // The scrubber's own arrows move it by one frame (not two: the screen leaves them to it); its value text.
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.getByTestId('scrubber').focus();
    await page.keyboard.press('ArrowRight');
    expect(await shown()).toBe(3);
    await page.keyboard.press('ArrowLeft');
    expect(await shown()).toBe(2);
    expect(await page.getByTestId('scrubber').getAttribute('aria-valuetext')).toBe(`0:00.07 · scene a · step 1 ${plan.view.untrusted.steps['a.0']}`);
    await check('the scrubber\'s own arrow');
    // Space plays (the frame says so) and pauses; the frame shown afterwards is exact again.
    await page.keyboard.press('Home');
    await blur();
    await page.keyboard.press(' ');
    await expect.poll(() => page.getByTestId('play').innerText(), POLL).toBe('Pause');
    await sleep(800);
    await page.keyboard.press(' ');
    await expect.poll(() => page.getByTestId('play').innerText(), POLL).toBe('Play');
    const played = await check('after playing');
    expect(played).toBeGreaterThan(5);
    expect(new Set(seen.map(([, s]) => s)).size).toBeGreaterThanOrEqual(6);
    console.log(`timeline e2e: ${seen.length} frames checked exactly (output → source): ${seen.map(([f, s]) => `${f}→${s}`).join(', ')}`);
    await shot('timeline-scrubbed');
    expect(await csp()).toBe(0);
  }, 180_000);

  it('zoom fit and in; Show in timeline opens a step at its first frame', async () => {
    const scroll = page.getByTestId('timeline-scroll');
    const widths = () => scroll.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    let [sw, cw] = await widths();
    expect(sw).toBeLessThanOrEqual(cw + 1);
    await page.getByTestId('zoom-in').click();
    [sw, cw] = await widths();
    expect(sw).toBeGreaterThan(cw * 1.5);
    await shot('timeline-zoomed');
    await page.getByTestId('zoom-fit').click();
    [sw, cw] = await widths();
    expect(sw).toBeLessThanOrEqual(cw + 1);

    const a1 = plan.view.model.steps.find((s) => s.key === 'a.1')!.from;
    await page.goto(`${studio.url}#/p/demo/s/bits`);
    await page.getByRole('heading', { level: 1, name: 'bits' }).waitFor();
    await page.goto(`${studio.url}#/p/demo/s/bits/timeline/${RUN}/a.1`);
    await page.getByTestId('tracks').waitFor();
    await expect.poll(() => shown(), POLL).toBe(a1);
    await expectExact('Show in timeline (step a.1)');
  }, 120_000);

  it('critique B14: an H.264 take in a browser without H.264 — the message, no frame; the tracks, the scrubber, the codec and GOP note', async () => {
    await page.goto(`${studio.url}#/p/demo/s/h264/timeline`);
    await page.getByTestId('tracks').waitFor();
    await expect.poll(() => page.getByTestId('cannot-play').count(), POLL).toBe(1);
    expect(await page.getByTestId('cannot-play').innerText()).toBe("This browser cannot play the take's H.264 video: open the Studio in Chrome, Safari or Firefox. The tracks still work.");
    expect(await page.locator('iframe').count()).toBe(0);
    expect(await page.getByTestId('play').isDisabled()).toBe(true);
    expect(await page.getByTestId('capture-codec').innerText()).toMatch(/H\.264, keyframes at least every \d\.\d s, B-frames/);
    expect(await page.getByTestId('slow-scrub').innerText()).toMatch(/^scrubbing is slow on this take/);
    // The tracks and the scrubber still move the playhead.
    await page.locator('[data-testid="tl-segment"][data-id="b"]').click();
    const b = landingOf(plan.view.model.segments.find((s) => s.id === 'b')!);
    expect(await shown()).toBe(b);
    expect(await page.getByTestId('timecode').innerText()).toContain(`frame ${b}`);
    await shot('timeline-h264');
    expect(consoleErrors).toEqual([]);
    expect(await csp()).toBe(0);
  }, 60_000);
});
