/**
 * The desktop app's native context menus, page side (shell/context-menu.ts, DESIGN §4j), in headless Chromium against
 * an in-process Studio server: the app's window is a page with the shell's flag (`window.__studioShell`, the main-frame
 * init script of menu.rs), its `desktop_menu` calls caught by the test (this server is not supervised: no pipe).
 * - In the app a right-click on a scenario's poster selects it and asks the shell for its menu by id — `{popup:
 *   "scenario"}` and nothing else (no name, no label, no place);
 * - the menu's pick (`studio:command` with the menu's id) acts on the poster right-clicked, not on the scenario in
 *   context; a second pick, or one with no right-click before it, does nothing; an id outside the menu does nothing;
 * - WebKit's own menu is suppressed outside text: an empty area and a poster prevented, a text field and the text
 *   selection itself left (Copy, Look Up) — and a debug build's ⌥-right-click left (Inspect Element);
 * - in a browser tab a right-click is the browser's: nothing prevented, no op called (the poster is still selected).
 * - a target waits TARGET_MS at most and only for the menu of its own right-click (a later right-click elsewhere
 *   forgets it); a pick while a modal is open does nothing; a selection keeps WebKit's menu on itself only.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { scratchHome } from '@retake/test-support/home';

const POLL = { timeout: 15_000 };
const P = 'northfield-fixture';

let ws: string;
let studio: StudioServer;
let browser: Browser;
const retakeHome = scratchHome();

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-e2e-context-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

interface Tab {
  page: Page;
  context: BrowserContext;
  /** The `desktop_menu` {popup} bodies the page sent. */
  popups: () => unknown[];
  /** Every op the page called. */
  ops: () => string[];
  /** `contextmenu` events as they left the page (bubble phase on window): prevented or not. */
  prevented: () => Promise<boolean[]>;
}

/** A tab on Productions: the app's window (`flag`) or a browser tab. */
async function productions(flag: Record<string, unknown> | null, o: { clock?: boolean } = {}): Promise<Tab> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (o.clock) await context.clock.install();
  if (flag) await context.addInitScript((f) => ((window as unknown as { __studioShell: unknown }).__studioShell = Object.freeze(f)), flag);
  await context.addInitScript(() => {
    const w = window as unknown as { __ctx: boolean[] };
    w.__ctx = [];
    window.addEventListener('contextmenu', (e) => w.__ctx.push(e.defaultPrevented));
  });
  const popups: unknown[] = [];
  const ops: string[] = [];
  await context.route('**/v1/call/*', async (route) => {
    const op = /\/v1\/call\/([a-z_]+)/.exec(route.request().url())?.[1] ?? '';
    ops.push(op);
    if (op !== 'desktop_menu') return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if ('popup' in body) popups.push(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ summary: 'ok', data: { ok: true, sent: true } }) });
  });
  const page = await context.newPage();
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
  await page.evaluate((p) => (location.hash = `#/p/${p}`), P);
  await page.locator('.k-posters [role="option"]').nth(1).waitFor(POLL);
  return { page, context, popups: () => [...popups], ops: () => [...ops], prevented: () => page.evaluate(() => [...(window as unknown as { __ctx: boolean[] }).__ctx]) };
}

const poster = (t: Tab, n: number) => t.page.locator('.k-posters [role="option"]').nth(n);
const nameOf = async (t: Tab, n: number) => (await poster(t, n).getAttribute('data-id')) ?? '';
/** A right-click on main's empty corner (bottom right: no poster, no text there). */
const emptyArea = async (t: Tab) => {
  const b = (await t.page.locator('main').boundingBox())!;
  await t.page.mouse.click(b.x + b.width - 8, b.y + b.height - 8, { button: 'right' });
};
const pick = (t: Tab, detail: Record<string, unknown>) => t.page.evaluate((d) => window.dispatchEvent(new CustomEvent('studio:command', { detail: d })), detail);

describe('native context menus, page side', () => {
  it('⚑ in the app a right-click on a poster selects it and asks the shell for the scenario menu — nothing else in the request', async () => {
    const t = await productions({ titleBar: 'standard' });
    try {
      await poster(t, 1).click({ button: 'right' });
      await expect.poll(() => t.popups().length, POLL).toBe(1);
      expect(t.popups()).toEqual([{ popup: 'scenario' }]);
      expect(await poster(t, 1).getAttribute('aria-selected')).toBe('true');
      expect(await t.prevented()).toEqual([true]);
      // ⌃-click is macOS's right-click (Chromium sends it as a contextmenu too on a Mac; here the right button again).
      await poster(t, 0).click({ button: 'right' });
      await expect.poll(() => t.popups().length, POLL).toBe(2);
      expect(JSON.stringify(t.popups())).not.toContain(await nameOf(t, 0));
    } finally {
      await t.context.close();
    }
  });

  it('a context command acts on the poster right-clicked, not on the scenario in context; without a fresh target it does nothing', async () => {
    const t = await productions({ titleBar: 'standard' });
    try {
      const [first, second] = [await nameOf(t, 0), await nameOf(t, 1)];
      // The scenario in context is the first one (opened, then back to Productions).
      await t.page.evaluate(([p, s]) => (location.hash = `#/p/${p}/s/${s}`), [P, first] as const);
      await t.page.locator('main h1').waitFor(POLL);
      await t.page.evaluate((p) => (location.hash = `#/p/${p}`), P);
      await poster(t, 1).waitFor(POLL);
      await poster(t, 1).click({ button: 'right' });
      await expect.poll(() => t.popups().length, POLL).toBe(1);
      await pick(t, { id: 'mode-edit', context: 'scenario' });
      await expect.poll(() => new URL(t.page.url()).hash, POLL).toBe(`#/p/${P}/s/${second}/timeline`);
      // The target was used once: the same pick again does nothing.
      await t.page.evaluate((p) => (location.hash = `#/p/${p}`), P);
      await poster(t, 1).waitFor(POLL);
      await pick(t, { id: 'mode-edit', context: 'scenario' });
      await t.page.waitForTimeout(300);
      expect(new URL(t.page.url()).hash).toBe(`#/p/${P}`);
      // An id outside the menu, a menu the page does not know: nothing, even with a fresh target.
      await poster(t, 1).click({ button: 'right' });
      await expect.poll(() => t.popups().length, POLL).toBe(2);
      for (const d of [
        { id: 'render', context: 'scenario' },
        { id: 'go-report', context: 'project' },
      ])
        await pick(t, d);
      await t.page.waitForTimeout(300);
      expect(new URL(t.page.url()).hash).toBe(`#/p/${P}`);
      // The report of the poster right-clicked (the refused picks above used no target: it is still there).
      await pick(t, { id: 'go-report', context: 'scenario' });
      await expect.poll(() => new URL(t.page.url()).hash, POLL).toBe(`#/p/${P}/s/${second}/review`);
    } finally {
      await t.context.close();
    }
  });

  it("⚑ in the app WebKit's own menu is suppressed outside text: an empty area and a poster prevented, a field and a selection left; a debug build's ⌥-right-click left", async () => {
    const t = await productions({ titleBar: 'standard' });
    try {
      await t.page.locator('main h1').click({ button: 'right' });
      await poster(t, 0).click({ button: 'right' });
      const field = t.page.locator('main input[type="search"], main input:not([type])').first();
      await field.click({ button: 'right' });
      // A right-click on the text selection itself keeps WebKit's menu (Copy, Look Up); elsewhere it does not.
      await t.page.evaluate(() => {
        const h = document.querySelector('main h1')!;
        const r = document.createRange();
        r.selectNodeContents(h);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
      });
      const sel = await t.page.evaluate(() => {
        const b = getSelection()!.getRangeAt(0).getClientRects()[0]!;
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await t.page.mouse.click(sel.x, sel.y, { button: 'right' });
      await poster(t, 1).click({ button: 'right' });
      // Not a debug build: ⌥ changes nothing.
      await t.page.locator('main h1').click({ button: 'right', modifiers: ['Alt'] });
      expect(await t.prevented()).toEqual([true, true, false, false, true, true]);
      // Only the posters asked for a menu, and only when prevented.
      expect(t.popups()).toHaveLength(2);
    } finally {
      await t.context.close();
    }
    const dbg = await productions({ titleBar: 'standard', inspect: true });
    try {
      await dbg.page.locator('main h1').click({ button: 'right', modifiers: ['Alt'] });
      await poster(dbg, 0).click({ button: 'right', modifiers: ['Alt'] });
      await dbg.page.locator('main h1').click({ button: 'right' });
      expect(await dbg.prevented()).toEqual([false, false, true]);
      // A poster's ⌥-right-click kept WebKit's menu: no native one asked on top of it.
      expect(dbg.popups()).toEqual([]);
    } finally {
      await dbg.context.close();
    }
  });

  it("in a browser tab a right-click is the browser's: nothing prevented, no op called", async () => {
    const t = await productions(null);
    try {
      const before = t.ops().length;
      await t.page.locator('main h1').click({ button: 'right' });
      await poster(t, 0).click({ button: 'right' });
      await t.page.waitForTimeout(300);
      expect(await t.prevented()).toEqual([false, false]);
      expect(
        t
          .ops()
          .slice(before)
          .filter((o) => o === 'desktop_menu'),
      ).toEqual([]);
      expect(t.popups()).toEqual([]);
      // A pick sent anyway (no shell): no target, nothing.
      await pick(t, { id: 'mode-edit', context: 'scenario' });
      await t.page.waitForTimeout(200);
      expect(new URL(t.page.url()).hash).toBe(`#/p/${P}`);
    } finally {
      await t.context.close();
    }
  });
  it("a target is the last right-click's only, for TARGET_MS at most; a pick while a modal is open does nothing", async () => {
    const t = await productions({ titleBar: 'standard' }, { clock: true });
    try {
      // A later right-click on an empty area forgets the poster's target: a pick then does nothing.
      await poster(t, 1).click({ button: 'right' });
      await expect.poll(() => t.popups().length, POLL).toBe(1);
      await emptyArea(t);
      await pick(t, { id: 'mode-edit', context: 'scenario' });
      await t.page.waitForTimeout(300);
      expect(new URL(t.page.url()).hash).toBe(`#/p/${P}`);
      // Past TARGET_MS (60 s): nothing.
      await poster(t, 1).click({ button: 'right' });
      await expect.poll(() => t.popups().length, POLL).toBe(2);
      await t.page.clock.fastForward(61_000);
      await pick(t, { id: 'mode-edit', context: 'scenario' });
      await t.page.waitForTimeout(300);
      expect(new URL(t.page.url()).hash).toBe(`#/p/${P}`);
      // Within it, while a modal (the palette) is open: nothing either.
      await poster(t, 1).click({ button: 'right' });
      await expect.poll(() => t.popups().length, POLL).toBe(3);
      await pick(t, { id: 'palette' });
      await t.page.locator('dialog.k-palette[open]').waitFor(POLL);
      await pick(t, { id: 'mode-edit', context: 'scenario' });
      await t.page.waitForTimeout(300);
      expect(new URL(t.page.url()).hash).toBe(`#/p/${P}`);
    } finally {
      await t.context.close();
    }
  });

  it("⚑ a selection keeps WebKit's menu on itself only: an empty area of the screen holding it is prevented", async () => {
    const t = await productions({ titleBar: 'standard' });
    try {
      // The contextmenu event itself, the selection held (a real right-click elsewhere would first move the caret in
      // Chromium): on main's empty corner — main holds the selection — prevented; on the selected text — WebKit's.
      const got = await t.page.evaluate(() => {
        const r = document.createRange();
        r.selectNodeContents(document.querySelector('main h1')!);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
        const main = document.querySelector('main')!.getBoundingClientRect();
        const text = r.getClientRects()[0]!;
        const fire = (el: Element, x: number, y: number) => {
          const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
          el.dispatchEvent(e);
          return e.defaultPrevented;
        };
        return [
          fire(document.querySelector('main')!, main.right - 8, main.bottom - 8),
          fire(document.querySelector('main h1')!, text.left + text.width / 2, text.top + text.height / 2),
          String(getSelection()).length > 0,
        ];
      });
      expect(got).toEqual([true, false, true]);
    } finally {
      await t.context.close();
    }
  });
});
