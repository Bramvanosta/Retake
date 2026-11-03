/**
 * L5.12a: Edit's 1,200-step budget (R-UI-45) — a take of 1,200 steps answered in the page (`timeline_view` fetched from
 * the real server on the bits take, its model given 1,200 steps over 40,000 frames; no preview URL: the stage says
 * nothing plays), in headless Chromium:
 * - the first paint: every step drawn (1,200 items on the Steps track) within the budget;
 * - ⚑ the playhead never re-renders the tracks: ten seeks with the keys move the playhead and render no track item
 *   again — counted from React's own commits (the DevTools hook's commit callback, installed before the bundle loads: a
 *   step item whose props object changed since the last commit was rendered) — and change nothing in the tracks' DOM (a
 *   MutationObserver).
 * `RETAKE_UI_SHOTS=<folder>` saves a screenshot there.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { BITS_TEXT, bitsTimeline, takeWorkspace, writeTake } from './timeline-take.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const SHOTS = process.env.RETAKE_UI_SHOTS;
const POLL = { timeout: 30_000 };
const RUN = '20260101-120000-bits';
const STEPS = 1200;
const FRAMES = 40_000;
/** The first paint of 1,200 steps, at most (ms; a loaded machine included). */
const FIRST_PAINT_MS = 6000;
let ws: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-budget-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  const dir = await takeWorkspace(ws);
  await writeTake(dir, 'bits', { run: RUN, text: BITS_TEXT, timeline: bitsTimeline(), codec: 'vp9', seconds: 2 });
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  // React's DevTools hook (before the bundle loads): each commit, the step items whose props changed were rendered.
  await context.addInitScript(() => {
    const w = window as unknown as { __trackRenders: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    w.__trackRenders = 0;
    type Fiber = { child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps: unknown; type: unknown };
    // The props each step item showed at the last commit (by its fiber and its alternate: the two copies React swaps).
    const seen = new WeakMap<Fiber, unknown>();
    const visit = (f: Fiber | null) => {
      for (let n = f; n; n = n.sibling) {
        const p = n.memoizedProps as { testId?: unknown } | null;
        if (typeof n.type === 'function' && p && p.testId === 'tl-step') {
          const last = seen.has(n) ? seen.get(n) : n.alternate ? seen.get(n.alternate) : undefined;
          if (last !== undefined && last !== n.memoizedProps) w.__trackRenders++;
          seen.set(n, n.memoizedProps);
          if (n.alternate) seen.set(n.alternate, n.memoizedProps);
        }
        visit(n.child);
      }
    };
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => visit(root.current),
    };
  });
  page = await context.newPage();
  // The view of a 1,200-step take: the real answer, its model given STEPS steps over FRAMES frames, no preview.
  await page.route('**/v1/call/timeline_view', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> & { model: Record<string, unknown>; untrusted: { steps: Record<string, string> } } };
    const d = body.data;
    delete d.frame_url;
    delete d.plan_url;
    const per = Math.floor(FRAMES / STEPS);
    d.model = {
      ...d.model,
      frames: FRAMES,
      steps: Array.from({ length: STEPS }, (_x, i) => ({ key: `a.${i}`, scene: 'a', step: i, action: 'click', from: i * per, to: (i + 1) * per })),
    };
    d.untrusted = { ...d.untrusted, steps: Object.fromEntries(Array.from({ length: STEPS }, (_x, i) => [`a.${i}`, `Click button ${i + 1}`])) };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('Edit with 1,200 steps (L5.12a)', () => {
  it('⚑ the first paint within the budget; ten playhead moves render no track item and change nothing in the tracks', async () => {
    const t0 = Date.now();
    await page.goto(`${studio.url}#/p/demo/s/bits/timeline`);
    await expect.poll(() => page.getByTestId('tl-step').count(), POLL).toBe(STEPS);
    const firstPaint = Date.now() - t0;
    console.log(`Edit, ${STEPS} steps: first paint ${firstPaint} ms`);
    expect(firstPaint).toBeLessThan(FIRST_PAINT_MS);
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, 'edit-1200-steps.png') });
    }
    // The page takes the keyboard (its first key gives the window the focus: the Studio reads what it shows again — a new
    // view re-renders the tracks, as it should); once that settled, watch the tracks' DOM and React's commits.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Home');
    let last = -1;
    await expect
      .poll(
        async () => {
          const n = await page.evaluate(() => (window as unknown as { __trackRenders: number }).__trackRenders);
          const still = n === last;
          last = n;
          return still;
        },
        { timeout: 30_000, interval: 1000 },
      )
      .toBe(true);
    await page.evaluate(() => {
      const w = window as unknown as { __trackRenders: number; __mutations: number };
      w.__trackRenders = 0;
      w.__mutations = 0;
      new MutationObserver((list) => (w.__mutations += list.length)).observe(document.querySelector('[data-testid="tracks"]')!, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const views: string[] = [];
    page.on('request', (r) => r.url().includes('/v1/call/timeline_view') && views.push(r.url()));
    const left = () => page.getByTestId('playhead').evaluate((el) => (el as HTMLElement).style.left);
    const before = await left();
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => Number(await page.getByTestId('preview').getAttribute('data-frame')), POLL).toBe(300);
    expect(await left()).not.toBe(before);
    const counts = await page.evaluate(() => {
      const w = window as unknown as { __trackRenders: number; __mutations: number };
      return { renders: w.__trackRenders, mutations: w.__mutations };
    });
    expect(views, 'no new view read meanwhile').toEqual([]);
    expect(counts).toEqual({ renders: 0, mutations: 0 });
    // The hook does count: a change of the selection (the segments' pressed state) re-renders the tracks once.
    // (The bits take's segments sit in the first 180 of the 40,000 frames: a click from the page, not the pointer.)
    await page.locator('[data-testid="tl-segment"]').first().evaluate((el) => (el as HTMLButtonElement).click());
    await expect.poll(() => page.evaluate(() => (window as unknown as { __trackRenders: number }).__trackRenders), POLL).toBeGreaterThan(0);
  }, 120_000);
});
