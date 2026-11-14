/**
 * L5.12c: the Library's budget (R-UI-49) — a library of 240 components answered in the page (`library_view` fetched from
 * the real server on the fixture project, its items cloned to 240 workspace cards whose previews are queued: nothing is
 * rendered or loaded), in headless Chromium:
 * - the first paint: every card drawn within the budget;
 * - ⚑ the cards are memoised: selecting a card renders the two cards whose selection changed and no other, Play renders
 *   the one card played, and a re-read of the view with the same values (the window's focus re-reads it) renders none —
 *   counted from React's own commits (the DevTools hook's commit callback, installed before the bundle loads: a card
 *   whose props object changed since the last commit was rendered).
 * `RETAKE_UI_SHOTS=<folder>` saves a screenshot there.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { scratchHome } from '@retake/test-support/home';

const P = 'northfield-fixture';
const SHOTS = process.env.RETAKE_UI_SHOTS;
const POLL = { timeout: 30_000 };
const CARDS = 240;
/** The first paint of 240 cards, at most (ms; a loaded machine included). */
const FIRST_PAINT_MS = 6000;
let ws: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const retakeHome = scratchHome();

const renders = () => page.evaluate(() => (window as unknown as { __cardRenders: string[] }).__cardRenders);
/** Waits until no card rendered for a second (the page settled), then counts from zero. */
async function quiet(): Promise<void> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const n = (await renders()).length;
        const still = n === last;
        last = n;
        return still;
      },
      { timeout: 30_000, interval: 1000 },
    )
    .toBe(true);
  await page.evaluate(() => ((window as unknown as { __cardRenders: string[] }).__cardRenders = []));
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-lib-budget-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(ws, 'templates'));
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  // React's DevTools hook (before the bundle loads): each commit, the cards whose props changed were rendered.
  await context.addInitScript(() => {
    const w = window as unknown as { __cardRenders: string[]; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    w.__cardRenders = [];
    type Fiber = { child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps: unknown; type: unknown };
    const seen = new WeakMap<Fiber, unknown>();
    const visit = (f: Fiber | null) => {
      for (let n = f; n; n = n.sibling) {
        const p = n.memoizedProps as { testId?: unknown; item?: { component?: string } } | null;
        if (typeof n.type === 'function' && p && p.testId === 'lib-card') {
          const last = seen.has(n) ? seen.get(n) : n.alternate ? seen.get(n.alternate) : undefined;
          if (last !== undefined && last !== n.memoizedProps) w.__cardRenders.push(p.item?.component ?? '?');
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
  // 240 cards: the real answer's items cloned as workspace components, their previews queued (no render, no image).
  await page.route('**/v1/call/library_view', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { ok: boolean; data: { items: Array<Record<string, any>>; queued: number } };
    const base = body.data.items;
    body.data.items = Array.from({ length: CARDS }, (_x, i) => {
      const b = base[i % base.length];
      const key = (n: number) => `${(i * 2 + n).toString(16).padStart(32, '0')}`;
      return {
        ...b,
        component: `acme/budget-${String(i).padStart(3, '0')}`,
        source: 'workspace',
        theme_default: [],
        poster: { key: key(0), state: 'missing', queued: true },
        loop: { key: key(1), state: 'missing', queued: true },
        untrusted: { name: `Budget card ${i + 1}`, description: 'A card of the budget test.' },
      };
    });
    body.data.queued = 0;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the Library with 240 cards (L5.12c)', () => {
  it('⚑ the first paint within the budget; a selection renders two cards, Play one, a re-read with the same values none', async () => {
    const t0 = Date.now();
    await page.goto(`${studio.url}#/p/${P}/library`);
    await expect.poll(() => page.getByTestId('lib-card').count(), POLL).toBeGreaterThanOrEqual(CARDS);
    const firstPaint = Date.now() - t0;
    console.log(`Library, ${await page.getByTestId('lib-card').count()} cards: first paint ${firstPaint} ms`);
    expect(firstPaint).toBeLessThan(FIRST_PAINT_MS);
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, 'library-240-cards.png') });
    }
    await quiet();
    // A card selected (from the page: no pointer move over others): it and nothing else; then another — the two.
    const pick = (id: string) =>
      page
        .locator(`[data-testid="lib-card"][data-component="${id}"] .k-card`)
        .first()
        .evaluate((el) => (el as HTMLButtonElement).click());
    // (L5.12c fixes, review A-M3: the grid's one tab stop moves from the first card shown to the selected one — the two.)
    const first = (await page.getByTestId('lib-card').first().getAttribute('data-component'))!;
    expect(first).not.toBe('acme/budget-005');
    await pick('acme/budget-005');
    await page.getByTestId('lib-inspector').waitFor(POLL);
    await expect.poll(async () => [...new Set(await renders())].sort(), POLL).toEqual([first, 'acme/budget-005'].sort());
    await quiet();
    await pick('acme/budget-120');
    await expect.poll(async () => [...new Set(await renders())].sort(), POLL).toEqual(['acme/budget-005', 'acme/budget-120']);
    await quiet();
    // Play: the one card played.
    await page
      .locator('[data-testid="lib-card"][data-component="acme/budget-007"] [data-testid="lib-play"]')
      .first()
      .evaluate((el) => (el as HTMLButtonElement).click());
    await expect.poll(async () => [...new Set(await renders())].sort(), POLL).toEqual(['acme/budget-007']);
    await quiet();
    // A re-read of the view (the window's focus) hands new objects with the same values: no card renders.
    const views: string[] = [];
    page.on('request', (r) => r.url().includes('/v1/call/library_view') && views.push(r.url()));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => views.length, POLL).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    expect(await renders()).toEqual([]);
  }, 120_000);

  it('⚑ L5.12c fixes (review A-M3): with 240 cards the grid is one tab stop — from the selected card, its Play and the inspector in at most 5 Tabs; Enter takes the focus to the inspector', async () => {
    const sel = page.locator('[data-testid="lib-card"][data-component="acme/budget-120"] .k-card').first();
    expect(await sel.getAttribute('aria-pressed')).toBe('true');
    // One card's controls are stops: every other card's are not.
    const stops = await page
      .locator('.lb-grid')
      .evaluateAll((uls) =>
        uls.flatMap((ul) =>
          [...ul.querySelectorAll<HTMLElement>('button, a[href]')]
            .filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled)
            .map((e) => e.closest('[data-testid="lib-card"]')!.getAttribute('data-component')),
        ),
      );
    expect([...new Set(stops)]).toEqual(['acme/budget-120']);
    await sel.focus();
    const where = () =>
      page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return a?.closest('[data-testid="lib-inspector"]') ? 'inspector' : (a?.getAttribute('data-testid') ?? a?.tagName ?? 'none');
      });
    const path: string[] = [];
    for (let i = 0; i < 5 && (path.at(-1) ?? '') !== 'inspector'; i++) {
      await page.keyboard.press('Tab');
      path.push(await where());
    }
    console.log(`Tabs from the selected card (240 cards): ${path.join(' → ')}`);
    expect(path[0]).toBe('lib-play');
    expect(path.at(-1)).toBe('inspector');
    expect(path.length).toBeLessThanOrEqual(5);
    await sel.focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-lib-focus'))).toBe(true);
  }, 60_000);
});
