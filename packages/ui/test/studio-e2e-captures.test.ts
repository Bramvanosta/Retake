/**
 * L5.14 (captures first) in the Studio, in headless Chromium against a real Studio server (no worker: the states are
 * set by the test) — a render job's row on the Review report and the status bar say what a filming take does to it:
 * - queued while a take films elsewhere on this Mac (a filming marker of another workspace): "waiting for a take to
 *   finish (elsewhere on this Mac)", the status bar "a render waits for a take to finish (…)";
 * - running at background priority (its worker's yield.json): "slowed during a take (…)", the status bar "a render is
 *   slowed during a take (…)";
 * - in a narrow window (960 px) the status bar keeps it in its short form ("a render slowed by a take"), on one line;
 * - the take over: both gone.
 * Each state passes the accessibility checker in dark and light (kit components only). Never a path, slug or id of the
 * other workspace on the page. `RETAKE_UI_SHOTS=<folder>` saves screenshots there.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, FilmingMarker, selfIdentity } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { auditPage, formatFindings, settle } from './a11y.js';
import { takeWorkspace, writeTake } from './timeline-take.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const SHOTS = process.env.RETAKE_UI_SHOTS;
const POLL = { timeout: 30_000 };
/** The status bar follows the jobs events, not engine_info's 15 s re-read: well under it. */
const LIVE = { timeout: 8_000 };
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
const savedHome = process.env.RETAKE_HOME;
const consoleErrors: string[] = [];

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** The page passes the checker in dark and light (and goes back to dark). */
async function audited(name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    const a = await auditPage(page);
    expect(formatFindings(a.findings), `${name} (${scheme})`).toBe('');
    expect(a.stats.statusTokens).toBeGreaterThan(0);
    await shot(`${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'retake-e2e-captures-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  const dir = await takeWorkspace(ws);
  const t = synthTimeline({
    duration: 2,
    entries: [{ id: 'a', t_start: 0.3, t_end: 1.9, caption: { text: 'Every frame carries its number.' }, steps: [{ action: 'hold', t_start: 0.4, t_end: 1.9 }] }],
    video: { title: { text: 'Tiny' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  await writeTake(dir, 'tiny', { run: RUN, text: TEXT, timeline: t, codec: 'vp9', seconds: 2 });
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  const executablePath = process.env.RETAKE_CHROMIUM;
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
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('captures first in the Studio (L5.14)', () => {
  it('a render held by a take: "waiting for a take to finish", then "slowed during a take", in its row and the status bar; dark and light', async () => {
    await expect.poll(() => page.getByTestId('render-status').innerText(), POLL).toBe('renders this capture with the theme of the files, then reviews it');
    await page.getByTestId('render').click();
    await page.goto(`${studio.url}#/p/demo/s/tiny/review`);
    const job = page.getByTestId('render-job');
    await expect.poll(() => job.getAttribute('data-state'), POLL).toBe('queued');
    expect(await job.innerText()).toContain('v1 · queued — next in the queue');
    const held = page.getByTestId('held');
    expect(await held.count()).toBe(0);

    // A take films in another workspace (its marker names no workspace): the render waits for it.
    const other = join(ws, 'elsewhere-workspace');
    const marker = FilmingMarker.open({ root: other, source: 'cli', owner: await selfIdentity() });
    expect(marker).not.toBeNull();
    try {
      await expect.poll(() => job.innerText(), POLL).toContain('v1 · queued — waiting for a take to finish (elsewhere on this Mac)');
      await expect.poll(() => held.innerText().catch(() => ''), LIVE).toContain('a render waits for a take to finish (elsewhere on this Mac)');
      expect(await held.getAttribute('data-held')).toBe('waiting');
      await audited('captures-1-waiting');

      // Running at background priority (what its worker writes): slowed during the take.
      const queue = new FileJobQueue(ws);
      const rec = (await queue.list({ project: 'demo', kinds: ['render'], limit: 1 }))[0]!;
      const me = { ...(await selfIdentity()), host: hostname() };
      await queue.write({
        ...rec,
        state: 'running',
        started_at: new Date().toISOString(),
        worker: me,
        supervisor: me,
        progress: { phase: 'rendering', fraction: 0.4, steps_done: 0, steps_total: 0 },
      } as never);
      await writeFile(queue.files.yield(rec.id), `${JSON.stringify({ v: 1, state: 'background', since: new Date().toISOString(), cause: 'elsewhere' })}\n`);
      await expect.poll(() => job.innerText(), POLL).toContain('v1 · rendering 40 % · slowed during a take (elsewhere on this Mac)');
      await expect.poll(() => held.innerText().catch(() => ''), LIVE).toContain('a render is slowed during a take (elsewhere on this Mac)');
      expect(await held.getAttribute('data-held')).toBe('background');
      await audited('captures-2-slowed');
      // Review B L6: a narrow window keeps it, in its short form, on one line of the status bar.
      await page.setViewportSize({ width: 960, height: 900 });
      await expect.poll(() => held.innerText().catch(() => ''), LIVE).toContain('a render slowed by a take');
      expect(await held.innerText()).not.toContain('elsewhere on this Mac');
      const bar = page.locator('.sh-statusbar-wrap');
      expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await audited('captures-3-slowed-narrow');
      await page.setViewportSize({ width: 1360, height: 900 });
      await expect.poll(() => held.innerText().catch(() => ''), LIVE).toContain('a render is slowed during a take (elsewhere on this Mac)');
      // Nothing of the other workspace on the page.
      expect(await page.locator('body').innerText()).not.toContain('elsewhere-workspace');

      // The take over: normal priority again, said within one poll.
      marker!.closeSync();
      await rm(queue.files.yield(rec.id), { force: true });
      await expect.poll(() => held.count(), LIVE).toBe(0);
      await expect.poll(() => job.innerText(), POLL).not.toContain('during a take');
      await queue.write({ ...rec, state: 'cancelled', finished_at: new Date().toISOString() } as never);
    } finally {
      marker?.closeSync();
    }
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(consoleErrors).toEqual([]);
  }, 180_000);
});
