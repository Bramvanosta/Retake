/**
 * L5.12d — the desktop app's quit question in the window's page (shell/QuitSheet.tsx, shell/quit.ts; DESIGN §4j), in
 * Chromium with the app's flag (`window.__studioShell`, as the shell's init script sets it) and `studio:quit` events
 * dispatched as the shell's `page_quit_js` writes them (desktop_answer is fulfilled by the test: this server is not
 * supervised):
 * - the alert's keys: unsaved text → Return = Cancel, Quit Anyway destructive with no default, Escape = Cancel; jobs only →
 *   Return = Quit Anyway; every answer goes out once with the question's id, and the sheet closes;
 * - L5.12d fixes: the buttons in the native alert's visual order (its default rightmost: review B-M1); Return on a
 *   Tab-focused Quit Anyway answers Cancel (A-L2); the sheet stays open and busy until the answer settles, a failed one
 *   is said in the sheet and the question stays answerable (A-L3: a held 409);
 * - the ack: once, after the dialog is open and painted, only while the page is visible (a hidden window acks when it
 *   shows); a re-sent question (a second ⌘Q) acks again; `studio:quit-close {id}` closes it without an answer (another
 *   id does not);
 * - anything but the exact shape is ignored (an extra key, a bad id, three buttons, proceed = cancel, words too long);
 * - the words are text (a name with markup and a direction override shows as text); it stacks over the palette;
 * - a browser tab (no flag) has no quit sheet at all.
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
const ID = 'quitQuestion0000000_-a';
const ID2 = 'quitQuestion0000000_-b';

let ws: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const bodies: Array<Record<string, unknown>> = [];
const retakeHome = scratchHome();

/** The shell's words for unsaved text (words.rs), and for jobs only. */
const UNSAVED = {
  id: ID,
  action: 'quit',
  title: 'Quit Retake?',
  text: 'Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved:\n• README.md of <b>shop</b>\u202egnp.exe\n• A comment being written',
  buttons: ['Cancel', 'Quit Anyway'],
  proceed: 1,
  cancel: 0,
  destructive: true,
};
const JOBS = {
  ...UNSAVED,
  id: ID2,
  text: 'These jobs keep running after the app quits, but it will not tell you when they end:\n• Render of shop · quote (running)',
  buttons: ['Quit Anyway', 'Cancel'],
  proceed: 0,
  cancel: 1,
  destructive: false,
};

const dispatch = (p: Page, detail: unknown) => p.evaluate((d) => window.dispatchEvent(new CustomEvent('studio:quit', { detail: d })), detail);
const close = (p: Page, id: string) => p.evaluate((i) => window.dispatchEvent(new CustomEvent('studio:quit-close', { detail: { id: i } })), id);
const sheet = (p: Page) => p.locator('dialog[data-testid="quit-sheet"]');
const shownAcks = () => bodies.filter((b) => b.shown === true);
const answers = () => bodies.filter((b) => 'answer' in b);
/** The next answer held until `release`, then answered `status` (an error), once. */
let held: { status: number; gate: Promise<void> } | null = null;

async function open(ctx: BrowserContext, app: boolean): Promise<Page> {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  if (app) await p.addInitScript(() => ((window as unknown as { __studioShell: unknown }).__studioShell = Object.freeze({ titleBar: 'standard' })));
  await p.route('**/v1/call/desktop_answer', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    bodies.push(body);
    const h = 'answer' in body ? held : null;
    if (h) {
      held = null;
      await h.gate;
      await route.fulfill({
        status: h.status,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'conflict', message: "this Studio server is not the desktop app's (not supervised): there is no question to answer", details: { reason: 'not_supervised' } },
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, summary: 'ok', data: { ok: true } }) });
  });
  await p.goto(studio.launchUrl());
  await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
  return p;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-quit-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await open(context, true);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe("the quit sheet (the desktop app's question in its page)", () => {
  it("unsaved text: the alert's keys (Return = Cancel, Quit Anyway destructive with no key, Escape = Cancel), one ack after it is painted, words as text", async () => {
    bodies.length = 0;
    await dispatch(page, UNSAVED);
    const d = sheet(page);
    await expect.poll(() => d.evaluate((x: HTMLDialogElement) => x.open && x.matches(':modal')), POLL).toBe(true);
    expect(await d.getAttribute('role')).toBe('alertdialog');
    await expect.poll(() => shownAcks().length, POLL).toBe(1);
    expect(shownAcks()[0]).toEqual({ id: ID, shown: true });
    // Words: the shell's lines kept; markup and a direction override shown as text.
    expect(await d.locator('h2').innerText()).toBe('Quit Retake?');
    const text = await d.locator('.sh-quit-text').innerText();
    expect(text).toContain('• README.md of <b>shop</b>[U+202E]gnp.exe\n• A comment being written');
    expect(await d.locator('b').count()).toBe(0);
    // The native alert's visual order (review B-M1): Cancel, its default, rightmost (focused); Quit Anyway destructive on
    // its left, never the default.
    expect(await d.locator('.k-sheet-actions button').allInnerTexts()).toEqual(['Quit Anyway', 'Cancel']);
    expect(await d.locator('.k-sheet-actions button').evaluateAll((bs) => bs.map((b) => [(b as HTMLElement).dataset.testid, b.getAttribute('data-default')]))).toEqual([
      ['quit-proceed', null],
      ['quit-cancel', 'yes'],
    ]);
    const [left, right] = await d.locator('.k-sheet-actions button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().left));
    expect(left!).toBeLessThan(right!);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe('quit-cancel');
    expect(await page.getByTestId('quit-proceed').getAttribute('data-default')).toBeNull();
    expect(await page.getByTestId('quit-proceed').getAttribute('class')).toContain('destructive');
    // Return answers Cancel (the focused default) and closes.
    await page.keyboard.press('Enter');
    await expect.poll(() => answers(), POLL).toEqual([{ id: ID, answer: 'cancel' }]);
    await expect.poll(() => d.evaluate((x: HTMLDialogElement) => x.open), POLL).toBe(false);
    // Escape answers Cancel too.
    await dispatch(page, UNSAVED);
    await expect.poll(() => shownAcks().length, POLL).toBe(2);
    await page.keyboard.press('Escape');
    await expect.poll(() => answers().length, POLL).toBe(2);
    expect(answers()[1]).toEqual({ id: ID, answer: 'cancel' });
    // Review A-L2: Return on a Tab-focused Quit Anyway answers Cancel (the native alert's Return is its default's,
    // wherever the focus ring is); Space presses it.
    await dispatch(page, UNSAVED);
    await expect.poll(() => shownAcks().length, POLL).toBe(3);
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe('quit-proceed');
    await page.keyboard.press('Enter');
    await expect.poll(() => answers().length, POLL).toBe(3);
    expect(answers()[2]).toEqual({ id: ID, answer: 'cancel' });
    await expect.poll(() => d.evaluate((x: HTMLDialogElement) => x.open), POLL).toBe(false);
    await dispatch(page, UNSAVED);
    await expect.poll(() => shownAcks().length, POLL).toBe(4);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press(' ');
    await expect.poll(() => answers().length, POLL).toBe(4);
    expect(answers()[3]).toEqual({ id: ID, answer: 'proceed' });
    // Quit Anyway by click: proceed, once.
    await dispatch(page, UNSAVED);
    await expect.poll(() => shownAcks().length, POLL).toBe(5);
    await page.getByTestId('quit-proceed').click();
    await expect.poll(() => answers().length, POLL).toBe(5);
    expect(answers()[4]).toEqual({ id: ID, answer: 'proceed' });
    await page.waitForTimeout(300);
    expect(answers()).toHaveLength(5);
    expect(errors).toEqual([]);
  });

  it('jobs only: Return = Quit Anyway (nothing is lost); a re-sent question acks again; quit-close of its id closes it without an answer, another id does not', async () => {
    bodies.length = 0;
    await dispatch(page, JOBS);
    await expect.poll(() => shownAcks().length, POLL).toBe(1);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe('quit-proceed');
    // The native alert's visual order (review B-M1): Quit Anyway, its default, rightmost.
    expect(await sheet(page).locator('.k-sheet-actions button').allInnerTexts()).toEqual(['Cancel', 'Quit Anyway']);
    expect(await page.getByTestId('quit-proceed').getAttribute('data-default')).toBe('yes');
    // A second ⌘Q: the same id again — acked again, still one sheet.
    await dispatch(page, JOBS);
    await expect.poll(() => shownAcks().length, POLL).toBe(2);
    expect(await page.locator('dialog[data-testid="quit-sheet"][open]').count()).toBe(1);
    await page.keyboard.press('Enter');
    await expect.poll(() => answers(), POLL).toEqual([{ id: ID2, answer: 'proceed' }]);
    // Closed by the shell (the native alert took over): no answer.
    await dispatch(page, JOBS);
    await expect.poll(() => shownAcks().length, POLL).toBe(3);
    await close(page, ID);
    await page.waitForTimeout(200);
    expect(await sheet(page).evaluate((x: HTMLDialogElement) => x.open)).toBe(true);
    await close(page, ID2);
    await expect.poll(() => sheet(page).evaluate((x: HTMLDialogElement) => x.open), POLL).toBe(false);
    expect(answers()).toHaveLength(1);
  });

  it('a hidden window acks only once it is visible; the sheet stacks over the palette', async () => {
    bodies.length = 0;
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
    await dispatch(page, JOBS);
    await expect.poll(() => sheet(page).evaluate((x: HTMLDialogElement) => x.open), POLL).toBe(true);
    await page.waitForTimeout(500);
    expect(shownAcks()).toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => shownAcks().length, POLL).toBe(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => answers().length, POLL).toBe(1);
    // Closed once the answer arrived (A-L3: open, busy, until then).
    await expect.poll(() => sheet(page).evaluate((x: HTMLDialogElement) => x.open), POLL).toBe(false);
    // Over the palette (the menu's command; the app binds no ⌘K of its own).
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'palette' } })));
    await page.locator('dialog.k-palette[open]').waitFor(POLL);
    await dispatch(page, UNSAVED);
    await expect.poll(() => shownAcks().length, POLL).toBe(2);
    const top = await page.evaluate(() => {
      const d = document.querySelector('dialog[data-testid="quit-sheet"]')!.getBoundingClientRect();
      const el = document.elementFromPoint(d.left + d.width / 2, d.top + 10);
      return el?.closest('dialog')?.getAttribute('data-testid');
    });
    expect(top).toBe('quit-sheet');
    await page.keyboard.press('Escape');
    await expect.poll(() => answers().length, POLL).toBe(2);
    await expect.poll(() => sheet(page).evaluate((x: HTMLDialogElement) => x.open), POLL).toBe(false);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('dialog.k-palette[open]').count(), POLL).toBe(0);
  });

  it('⚑ an answer keeps the sheet open and busy until it settles; a failed one (a held 409) is said in the sheet, which stays answerable (review A-L3)', async () => {
    bodies.length = 0;
    let release = () => undefined as void;
    held = { status: 409, gate: new Promise<void>((r) => (release = r)) };
    await dispatch(page, UNSAVED);
    const d = sheet(page);
    await expect.poll(() => shownAcks().length, POLL).toBe(1);
    await page.getByTestId('quit-proceed').click();
    await expect.poll(() => answers(), POLL).toEqual([{ id: ID, answer: 'proceed' }]);
    // In flight: still open, Quit Anyway busy, Cancel off; Escape and another click send nothing.
    await page.waitForTimeout(300);
    expect(await d.evaluate((x: HTMLDialogElement) => x.open)).toBe(true);
    expect(await page.getByTestId('quit-proceed').evaluate((b) => [(b as HTMLButtonElement).disabled, b.classList.contains('is-busy')])).toEqual([true, true]);
    expect(await page.getByTestId('quit-cancel').isDisabled()).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(answers()).toHaveLength(1);
    expect(await d.evaluate((x: HTMLDialogElement) => x.open)).toBe(true);
    // The 409 lands: said in the sheet (an alert), the buttons back, the focus on the default; still open.
    release();
    const failed = page.getByTestId('quit-failed');
    await failed.waitFor(POLL);
    expect(await failed.getAttribute('role')).toBe('alert');
    expect(await failed.innerText()).toContain('The app did not get the answer');
    expect(await d.evaluate((x: HTMLDialogElement) => x.open)).toBe(true);
    expect(await page.getByTestId('quit-proceed').isEnabled()).toBe(true);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid), POLL).toBe('quit-cancel');
    // Answerable again: Cancel goes out and, answered, the sheet closes; the failure line went with it.
    await page.keyboard.press('Enter');
    await expect.poll(() => answers().length, POLL).toBe(2);
    expect(answers()[1]).toEqual({ id: ID, answer: 'cancel' });
    await expect.poll(() => d.evaluate((x: HTMLDialogElement) => x.open), POLL).toBe(false);
    // Words at the shell's bound (4000: guard_flow QUIT_TEXT_MAX, which words.rs's longest question fits) are taken.
    await dispatch(page, { ...UNSAVED, text: '• A comment being written\n'.repeat(160).slice(0, 4000) });
    await expect.poll(() => shownAcks().length, POLL).toBe(2);
    expect(await page.getByTestId('quit-failed').count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect.poll(() => answers().length, POLL).toBe(3);
    expect(errors).toEqual([]);
  });

  it("anything but the shell's exact shape is ignored: no sheet, no ack", async () => {
    bodies.length = 0;
    for (const bad of [
      { ...UNSAVED, extra: 1 },
      { ...UNSAVED, id: 'short' },
      { ...UNSAVED, id: 'quitQuestion0000000+/a' },
      { ...UNSAVED, action: 'open_workspace' },
      { ...UNSAVED, buttons: ['Cancel', 'Quit Anyway', 'Later'] },
      { ...UNSAVED, buttons: ['Cancel'] },
      { ...UNSAVED, proceed: 0 },
      { ...UNSAVED, proceed: 2 },
      { ...UNSAVED, destructive: 'yes' },
      { ...UNSAVED, text: 'x'.repeat(4001) },
      { ...UNSAVED, buttons: ['Cancel', ''] },
      (({ destructive: _d, ...rest }) => rest)(UNSAVED),
      null,
      'Quit now',
    ]) {
      await dispatch(page, bad);
    }
    await page.waitForTimeout(400);
    expect(await sheet(page).evaluate((x: HTMLDialogElement) => x.open)).toBe(false);
    expect(bodies).toEqual([]);
  });

  it('a browser tab (no app flag) has no quit sheet', async () => {
    const tab = await open(context, false);
    bodies.length = 0;
    await dispatch(tab, UNSAVED);
    await tab.waitForTimeout(400);
    expect(await tab.locator('dialog[data-testid="quit-sheet"]').count()).toBe(0);
    expect(bodies).toEqual([]);
    await tab.close();
  });
});
