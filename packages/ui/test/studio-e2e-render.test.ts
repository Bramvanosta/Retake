/**
 * L4.5 part E: Render from the timeline, end to end in headless Chromium against a real Studio server — on a tiny
 * synthetic take (two seconds, VP9: the preview plays it), with the jobs worker run in this process when the test says
 * so (the Studio's own worker is off: the queued state is seen first):
 * - Render in Edit's status bar queues the capture shown (the status bar says "next in the queue", the button is off: one
 *   render of a scenario at a time); L5.12a: the queue, the renders and the reviews are the Review report's;
 * - the worker renders it (the report's queue shows its phase and progress while the page polls) and reviews it in the
 *   same job;
 * - the render appears with its review's verdict and "from this version"; the report shows the newest render's review:
 *   the verdict, and the contact sheet as an image (a data: JPEG through the gate, decoded by the page); Edit's status bar
 *   says "Latest: v1 · … · from this version";
 * - the scenario screen's Renders card shows the same render and verdict (and a step's picture still shows: the same
 *   one `<img>` under the step pictures' cap); its row opens the render's report.
 * No CSP violation, no console error. `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots there.
 * L4.5 fixes (review B H1): the real render's plan signature is the timeline's ("from this version"); a render of the
 * same file with other options is another version — L5.12a: its findings' Show in Edit never seeks the preview to their
 * frame (said); a copy of the same plan does; a render that failed after them is said in Edit's status bar.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, runWorker } from '@demo-studio/engine';
import type { JobRecord } from '@demo-studio/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { hasTool, linkSharedCache } from '../../editor/test/render-helpers.js';
import { takeWorkspace, writeTake } from './timeline-take.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const POLL = { timeout: 60_000 };
const RUN = '20260101-120000-tiny';
const TEXT = `video: Tiny
title: {text: Tiny}
intro: false
outro: false
frame: card
scenes:
  - id: a
    page: app
    open: /
    caption: Every frame carries its number.
    steps:
      - hold: 1
`;
let ws: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const savedHome = process.env.DEMO_STUDIO_HOME;
const consoleErrors: string[] = [];

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-render-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  const dir = await takeWorkspace(ws);
  const t = synthTimeline({
    duration: 2,
    entries: [{ id: 'a', t_start: 0.3, t_end: 1.9, caption: { text: 'Every frame carries its number.' }, steps: [{ action: 'hold', t_start: 0.4, t_end: 1.9 }] }],
    video: { title: { text: 'Tiny' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  await writeTake(dir, 'tiny', { run: RUN, text: TEXT, timeline: t, codec: 'vp9', seconds: 2 });
  // The render shares the repository's bundle cache (no rebundle per test file).
  await linkSharedCache(ws);
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
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
  await page.goto(`${studio.url}#/p/demo/s/tiny/timeline`);
  await page.getByTestId('tracks').waitFor();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('Render from the timeline in Chromium (L4.5 part E)', () => {
  it('Render → queued → progress → the review status → the contact sheet; the scenario screen shows the same', async () => {
    await expect.poll(() => page.getByTestId('render-status').innerText(), POLL).toBe('renders this capture with the theme of the files, then reviews it');

    // Render (Edit's status bar): queued, the button off (one render of a scenario at a time).
    await page.getByTestId('render').click();
    const bar = page.getByTestId('render-job');
    await expect.poll(() => bar.getAttribute('data-state'), POLL).toBe('queued');
    expect(await bar.innerText()).toContain('v1 · queued — next in the queue');
    expect(await page.getByTestId('render').isDisabled()).toBe(true);
    await shot('render-1-queued');

    // L5.12a: the queue in full on the Review report (what each job renders).
    await page.goto(`${studio.url}#/p/demo/s/tiny/review`);
    const job = page.getByTestId('render-job');
    await expect.poll(() => job.getAttribute('data-state'), POLL).toBe('queued');
    expect(await job.innerText()).toContain('v1 · queued — next in the queue');
    expect(await job.innerText()).toContain('renders this version');
    expect(await page.getByTestId('render').isDisabled()).toBe(true);

    // The worker renders and reviews it; the page follows (events → scenario_renders), its states noted as they pass.
    const seen = new Set<string>();
    let polling = true;
    let progressShot = false;
    const watch = (async () => {
      while (polling) {
        const st = await job.getAttribute('data-state', { timeout: 200 }).catch(() => null);
        if (st) seen.add(st);
        if (st === 'running' && !progressShot && (await page.getByTestId('render-progress').count()) > 0) {
          progressShot = true;
          await shot('render-2-running');
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const t0 = Date.now();
    const code = await runWorker({ root: ws, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined });
    expect(code).toBe(0);
    const row = page.locator('[data-testid="render-row"][data-id="tiny-v1"]');
    await expect.poll(() => row.getAttribute('data-review'), POLL).toMatch(/^(clean|warnings|errors)$/);
    polling = false;
    await watch;
    console.log(`render + review: ${Date.now() - t0} ms; states seen: ${[...seen].join(', ')}`);
    expect(seen.has('running') || seen.has('reviewing')).toBe(true);
    expect(await page.getByTestId('render-job').count()).toBe(0);
    expect(await row.innerText()).toContain('from this version');

    // The report shows the newest render's review: the verdict, and the contact sheet decoded as an image.
    await expect.poll(() => page.getByTestId('review-verdict').innerText(), POLL).toMatch(/\d+ errors?, \d+ warnings?, \d+ notes?/);
    const sheet = page.getByTestId('review-sheet').first();
    await expect.poll(() => sheet.getAttribute('data-state'), POLL).toBe('ok');
    const img = sheet.locator('img');
    expect(await img.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
    expect(await img.evaluate((el: HTMLImageElement) => el.decode().then(() => el.naturalWidth))).toBeGreaterThan(200);
    expect(await sheet.locator('figcaption').innerText()).toBe('contact sheet (1 fps)');
    expect(await page.getByTestId('render').isDisabled()).toBe(false);
    await shot('render-3-review');
    // A click shows it larger.
    await sheet.locator('button').click();
    expect(await sheet.getAttribute('class')).toContain('is-large');

    const verdict = await row.getAttribute('data-review');
    // Edit's status bar: the latest render, its verdict, this version.
    await page.goto(`${studio.url}#/p/demo/s/tiny/timeline`);
    await expect.poll(() => page.getByTestId('render-status').innerText(), POLL).toMatch(/^Latest: v1 · (clean|\d+ warnings?|\d+ errors?) · from this version$/);
    expect(await page.getByTestId('render').isDisabled()).toBe(false);
    expect(await page.getByTestId('render-open-review').getAttribute('href')).toBe('#/p/demo/s/tiny/review/tiny-v1');

    // The scenario screen's Renders card: the same render, the same verdict; its row opens the render's report.
    await page.goto(`${studio.url}#/p/demo/s/tiny`);
    // L5.10b: in the closed "Renders and review" section at the board's end.
    await page.getByTestId('renders-section').locator('summary').click();
    const card = page.getByTestId('renders-card');
    await card.waitFor();
    const sRow = card.locator('[data-testid="render-row"][data-id="tiny-v1"]');
    await expect.poll(() => sRow.getAttribute('data-review'), POLL).toBe(verdict);
    expect(await sRow.innerText()).toContain('from this version');
    // The step's picture still comes through the same one <img> (Thumb.tsx's Jpeg, under the step pictures' cap).
    await page.getByTestId('thumb').first().scrollIntoViewIfNeeded();
    await expect.poll(() => page.getByTestId('thumb').first().getAttribute('data-state'), POLL).toBe('ok');
    await card.scrollIntoViewIfNeeded();
    await shot('render-4-scenario');
    // (L5.12a fixes, review A-L5: a link to the report, never a toggle.)
    expect(await sRow.locator('a').getAttribute('href')).toBe('#/p/demo/s/tiny/review/tiny-v1');
    await sRow.locator('a').click();
    await page.waitForURL('**#/p/demo/s/tiny/review/tiny-v1');
    await expect.poll(() => page.getByTestId('review-sheet').first().getAttribute('data-state'), POLL).toBe('ok');

    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(consoleErrors).toEqual([]);
  }, 240_000);

  it('review B H1: a render with other options never seeks the preview; the same plan does; a newer failure shows in the Render bar', async () => {
    const dir = join(ws, 'projects', 'demo');
    const v1 = JSON.parse(await readFile(join(dir, 'renders', 'tiny-v1.json'), 'utf8')) as Record<string, unknown> & { plan: Record<string, unknown>; created_at: string };
    const later = (n: number) => new Date(Date.parse(v1.created_at) + n * 60_000).toISOString();
    const copy = async (id: string, n: number, change: (r: typeof v1) => void) => {
      const r = structuredClone(v1);
      Object.assign(r, { id, render_version: n, created_at: later(n), finished_at: later(n) });
      change(r);
      await writeFile(join(dir, 'renders', `${id}.json`), JSON.stringify(r));
      await writeFile(join(dir, 'renders', `${id}.mp4`), 'video');
      await mkdir(join(dir, 'review', id), { recursive: true });
      await writeFile(
        join(dir, 'review', id, 'report.json'),
        JSON.stringify({ version: 1, clean: false, counts: { error: 0, warning: 1, info: 0 }, review: { created_at: later(n + 0.5), fps: 1 }, findings: [{ severity: 'warning', code: 'caption-too-long', message: 'long', at: { frame: 12, segment: 'a' } }], files: { sheets: [], keyframes: {} } }),
      );
    };
    // `render --no-intro --scale 0.25` of the same file and capture (another plan), and a copy of v1 (the same plan).
    await copy('tiny-v2', 2, (r) => Object.assign(r, { overrides: { intro: false, scale: 0.25 }, plan: { ...r.plan, width: 480, height: 270 }, width: 480, height: 270 }));
    await copy('tiny-v3', 3, () => undefined);
    // L5.12a: the rows on the Review report; Show in Edit of a finding seeks the preview only for the same plan.
    await page.goto(`${studio.url}#/p/demo/s/tiny/review`);
    const row = (id: string) => page.locator(`[data-testid="render-row"][data-id="${id}"]`);
    await expect.poll(() => row('tiny-v3').getAttribute('data-review'), POLL).toBe('warnings');
    expect(await row('tiny-v3').innerText()).toContain('from this version');
    expect(await row('tiny-v2').innerText()).toContain('with other options');
    // v2 (other options): Edit opens on the take, says why it does not go to the finding's frame (12), stays where it is.
    await page.goto(`${studio.url}#/p/demo/s/tiny/review/tiny-v2`);
    await page.getByTestId('review-finding').first().waitFor(POLL);
    await page.getByTestId('review-show-in-edit').click();
    await page.waitForURL(`**#/p/demo/s/tiny/timeline/${RUN}`);
    await page.getByTestId('edit-seek-note').waitFor(POLL);
    expect(await page.getByTestId('edit-seek-note').innerText()).toContain('v2 was made from another version of the edit');
    expect(Number(await page.getByTestId('preview').getAttribute('data-frame'))).toBe(0);
    // v3 (the same plan): Edit goes to the finding's frame, nothing said.
    await page.goto(`${studio.url}#/p/demo/s/tiny/review/tiny-v3`);
    await page.getByTestId('review-finding').first().waitFor(POLL);
    await page.getByTestId('review-show-in-edit').click();
    await page.waitForURL(`**#/p/demo/s/tiny/timeline/${RUN}`);
    await expect.poll(async () => Number(await page.getByTestId('preview').getAttribute('data-frame')), POLL).toBe(12);
    expect(await page.getByTestId('edit-seek-note').count()).toBe(0);
    // A render that failed after them: Edit's status bar says so (not "Latest: v3").
    const queue = new FileJobQueue(ws);
    const job = await queue.enqueue({ version: 1, kind: 'render', project: 'demo', scenario: 'tiny', run_id: RUN, timeline_sha256: 'a'.repeat(64), render_id: 'tiny-v4', overrides: {}, submitted_by: 'test' });
    const rec = (await queue.get(job.id))!;
    await queue.write({ ...rec, state: 'failed', finished_at: later(10), error: { code: 'internal', message: 'Error: the render failed' } } as JobRecord);
    await expect.poll(() => page.getByTestId('render-status').innerText(), POLL).toContain('v4 failed');
    expect(await page.getByTestId('render-bar-failed').count()).toBe(1);
  }, 120_000);
});
