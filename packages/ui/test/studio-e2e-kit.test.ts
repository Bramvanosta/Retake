/**
 * L5.9 part E: the design system's behaviours in headless Chromium against an in-process Studio server (the fixture
 * project, a scenario with a long name), on the UI gallery and the shell:
 * - ⚑ appearance switching — dark with no preference or `dark`, light only when the system asks, flipped live without a
 *   reload; a `data-appearance` scope keeps its own; the kit's focus ring is --ui-ring with its radius (the legacy layer
 *   cannot override it: critique M4);
 * - the segmented control (arrows, a disabled segment skipped), the switch (Space), the toolbar (one tab stop; arrows,
 *   Home, End: L8; ⚑ holding a menu, radios and a URL field, it leaves their keys to them: review A-M2), the menu
 *   (Enter / ↓ / ↑ open it on the first or last item, arrows, typeahead, Enter chooses, Escape and Tab close it with the
 *   focus back on the trigger, a click on the open trigger closes it: L9, outside click), the sheet (the focus on the
 *   default, a destructive default falls back to Cancel, Escape cancels, focus back; ⚑ a sheet its owner keeps open
 *   stays in step when the platform closes it: A-L1; ⚑ the focus goes back at once, a late `close` event never
 *   takes it from where it moved since — sheet and palette), the palette (filter, ↑ ↓ move `aria-activedescendant` with a 3 px
 *   cue: M1, Enter runs, Escape gives the focus back — to the centre pane when a command took the opener away: A-L6;
 *   "Nothing matches" in the tree: A-L5; nothing while an input method composes: A-L9);
 * - the shell — ⌘K (a Mac) / Ctrl+K (elsewhere, outside a text field: B-L3) opens its palette in a browser tab and a
 *   command navigates; ⚑ while a modal dialog is open `studio:command` and ⌘K wait (M5); the modes follow the scenario
 *   in context and say when there is none; one current page in the browser (A-L9); the centre pane keeps its scroll
 *   inside a screen and starts at the top of a new one (M2); a long scenario name never runs under the mode switch at
 *   900 px (L5);
 * - ⚑ the overlay title bar contract (DESIGN §4j): with `window.__studioShell = {titleBar: 'overlay'}` (the desktop
 *   app's main-frame init script) the bar keeps 80 px for the window buttons, the page binds no ⌘K (the app's menu
 *   does) and a `studio:command` opens the palette; an id off the list does nothing; without it, inset 0; the mode
 *   switch centred on the window either way (B-L1).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

const POLL = { timeout: 15_000 };
const P = 'northfield-fixture';
const LONG = 'a-scenario-whose-name-goes-on-and-on-well-past-any-title-bar';

let ws: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const savedHome = process.env.DEMO_STUDIO_HOME;

async function open(ctx: BrowserContext): Promise<Page> {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await p.goto(studio.launchUrl());
  await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
  return p;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-kit-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(join(ws, 'projects', P, 'scenarios', `${LONG}.yaml`), 'video: Long\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 1\n');
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await open(context);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

/**
 * The gallery, mounted afresh: a test never inherits the last one's open sheet, palette or answers (`#/ui` → `#/ui` is a
 * same-document navigation that keeps the screen, so the way goes through Projects).
 */
const gallery = async (p = page) => {
  if (new URL(p.url()).hash === '#/ui') {
    await p.goto(`${studio.url}#/`);
    await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
  }
  await p.goto(`${studio.url}#/ui`);
  await p.getByTestId('gallery').waitFor(POLL);
  expect(await p.locator('dialog[open]').count()).toBe(0);
};
const focused = (p = page) => p.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  return a ? `${a.tagName.toLowerCase()}:${a.getAttribute('role') ?? ''}:${(a.textContent ?? '').trim().slice(0, 40) || (a as HTMLInputElement).value || ''}` : 'none';
});
/** How far the mode switch's middle is from the window's (px). */
const centreOffset = (p: Page) => p.evaluate(() => {
  const r = document.querySelector('.sh-titlebar-centre')!.getBoundingClientRect();
  return Math.abs(r.left + r.width / 2 - document.documentElement.clientWidth / 2);
});
const look = (p: Page, sel: string, prop: string) => p.locator(sel).first().evaluate((el, pr) => getComputedStyle(el).getPropertyValue(pr).trim(), prop);

describe('⚑ appearance (L5.9 part E)', () => {
  it('dark with no preference or dark, light when the system asks — live, no reload; a scope keeps its own; the kit\'s ring is --ui-ring', async () => {
    await gallery();
    const nav = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    for (const [scheme, want] of [['no-preference', 'dark'], ['dark', 'dark'], ['light', 'light'], ['dark', 'dark']] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await look(page, 'html', 'color-scheme'), scheme).toBe(want);
      expect(await look(page, 'html', '--ui-canvas'), scheme).toBe(want === 'dark' ? '#111214' : '#f6f6f7');
      expect(await look(page, '.sh-app', 'background-color'), scheme).toBe(want === 'dark' ? 'rgb(17, 18, 20)' : 'rgb(246, 246, 247)');
      expect(await look(page, 'body', 'color'), scheme).toBe(want === 'dark' ? 'rgb(236, 236, 239)' : 'rgb(22, 24, 29)');
      // The scopes hold whatever the system says.
      expect(await look(page, '[data-testid="scope-light"]', 'background-color')).toBe('rgb(246, 246, 247)');
      expect(await look(page, '[data-testid="scope-dark"]', 'background-color')).toBe('rgb(17, 18, 20)');
    }
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(nav);
    // The bundled fonts are the ones in use.
    expect(await page.evaluate(() => document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')).sort()))).toEqual(expect.arrayContaining(['Geist']));
    // A kit button's focus ring: --ui-ring, 2 px, the control's radius — in a light scope inside a dark page too.
    await page.emulateMedia({ colorScheme: 'dark' });
    const btn = page.getByTestId('scope-light').getByRole('button', { name: 'Rehearse' }).first();
    await btn.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect(await btn.evaluate((el) => el === document.activeElement)).toBe(true);
    const ring = await btn.evaluate((el) => ({ c: getComputedStyle(el).outlineColor, w: getComputedStyle(el).outlineWidth, r: getComputedStyle(el).borderTopLeftRadius }));
    expect(ring).toEqual({ c: 'rgb(47, 111, 224)', w: '2px', r: '7px' });
  });
});

describe('the kit\'s keys (L5.9 part E)', () => {
  it('segmented: arrows move the choice and skip a disabled segment; switch: Space; toolbar: one stop, arrows / Home / End', async () => {
    await gallery();
    const col = page.getByTestId('scope-dark');
    const view = col.getByRole('group', { name: 'View (Dark)' });
    await view.getByRole('radio', { name: 'Blocks' }).focus();
    await page.keyboard.press('ArrowRight');
    expect(await view.getByRole('radio', { name: 'YAML' }).isChecked()).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await view.getByRole('radio', { name: 'Blocks' }).isChecked()).toBe(true);
    expect(await view.locator('.k-seg-item.is-current').innerText()).toBe('Blocks');
    const sw = col.getByRole('switch', { name: /Cursor trail/ });
    await sw.focus();
    await page.keyboard.press('Space');
    expect(await sw.isChecked()).toBe(true);
    await page.keyboard.press('Space');
    expect(await sw.isChecked()).toBe(false);
    const bar = col.getByRole('toolbar', { name: 'Step tools (Dark)' });
    expect(await bar.locator('[tabindex="0"]').count()).toBe(1);
    await bar.getByRole('button', { name: 'Add a step' }).focus();
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('button::');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Duplicate the step');
    await page.keyboard.press('End');
    expect(await focused()).toBe('button::Open timeline');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Add a step');
    await page.keyboard.press('Home');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Add a step');
    expect(await bar.locator('[tabindex="0"]').count()).toBe(1);
    // Tab leaves the toolbar in one press.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Tab');
    expect(await bar.evaluate((el) => el.contains(document.activeElement))).toBe(false);
  });

  it('⚑ a toolbar holding a menu, a segmented control and a URL field: the arrows skip the closed menu\'s items, stay in the open menu, move the radios\' choice and the field\'s caret (review A-M2)', async () => {
    await gallery();
    const col = page.getByTestId('scope-dark');
    const bar = col.getByRole('toolbar', { name: 'Take tools (Dark)' });
    const name = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    expect(await bar.locator('[tabindex="0"]:visible').count()).toBe(1);
    await bar.getByRole('button', { name: 'Add a take' }).focus();
    await page.keyboard.press('ArrowRight');
    expect(await name()).toBe('More take tools (Dark)');
    // From the menu's trigger → goes on to the next control (not into the closed menu's items).
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('input::fit');
    // On a radio the arrows are the group's: the choice moves.
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('input::fill');
    expect(await bar.getByRole('radio', { name: 'Fill' }).isChecked()).toBe(true);
    // End and Home: the last and the first visible control.
    await page.keyboard.press('End');
    expect(await name()).toBe('Remove the take');
    await page.keyboard.press('Home');
    expect(await name()).toBe('Add a take');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    // A URL field keeps its arrows, Home and End (the caret moves; the focus stays).
    const field = bar.getByRole('textbox', { name: 'Link' });
    expect(await field.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    expect(await field.evaluate((el) => [el === document.activeElement, (el as HTMLInputElement).selectionStart])).toEqual([true, 'https://example.com/a'.length - 1]);
    // (Home moves the caret on some platforms only: the focus staying is the point.)
    await page.keyboard.press('Home');
    expect(await field.evaluate((el) => el === document.activeElement)).toBe(true);
    // The open menu keeps its own arrows: ↓ on the last item wraps to the first, ↑ on the first to the last, → stays.
    const more = bar.getByRole('button', { name: 'More take tools (Dark)' });
    const menu = col.getByRole('menu', { name: 'More take tools (Dark)' });
    await more.focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focused(), POLL).toBe('button:menuitem:Make it the first');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('button:menuitem:Make it the last');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('button:menuitem:Make it the first');
    await page.keyboard.press('ArrowUp');
    expect(await focused()).toBe('button:menuitem:Make it the last');
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('button:menuitem:Make it the last');
    await page.keyboard.press('Home');
    expect(await focused()).toBe('button:menuitem:Make it the first');
    expect(await menu.isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    expect(await more.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await bar.locator('[tabindex="0"]:visible').count()).toBe(1);
    // A control that handles a key itself (preventDefault) keeps it: the toolbar does not move on.
    const add = bar.getByRole('button', { name: 'Add a take' });
    await add.evaluate((el) => el.addEventListener('keydown', (e) => e.key === 'ArrowRight' && e.preventDefault()));
    await add.focus();
    await page.keyboard.press('ArrowRight');
    expect(await name()).toBe('Add a take');
    await page.keyboard.press('ArrowLeft');
    expect(await name()).toBe('Remove the take');
  });

  it('menu: Enter / ↓ / ↑ open it, arrows and typeahead move, Enter chooses; Escape, Tab, the trigger and an outside click close it; focus back on the trigger', async () => {
    await gallery();
    const col = page.getByTestId('scope-light');
    const trigger = col.getByRole('button', { name: 'Take', exact: true });
    const menu = col.getByRole('menu');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await menu.waitFor(POLL);
    await expect.poll(() => trigger.getAttribute('aria-expanded'), POLL).toBe('true');
    await expect.poll(() => focused(), POLL).toBe('button:menuitem:Duplicate⌘D');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('button:menuitem:Rename…');
    // The disabled Export is skipped.
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('button:menuitem:Delete take');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('button:menuitem:Duplicate⌘D');
    await page.keyboard.press('d');
    expect(await focused()).toBe('button:menuitem:Delete take');
    await page.keyboard.press('r');
    expect(await focused()).toBe('button:menuitem:Rename…');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    await expect.poll(() => trigger.getAttribute('aria-expanded'), POLL).toBe('false');
    // ↑ opens on the last item; Tab closes, focus on the trigger.
    await page.keyboard.press('ArrowUp');
    await menu.waitFor(POLL);
    // (The focus moves on the popover's toggle event, a task after it shows.)
    await expect.poll(() => focused(), POLL).toBe('button:menuitem:Delete take');
    await page.keyboard.press('Tab');
    await menu.waitFor({ state: 'hidden' });
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    // A click opens it, a click on the open trigger closes it (never re-opens: popovertarget), an outside click closes it.
    await trigger.click();
    await menu.waitFor(POLL);
    await trigger.click();
    await menu.waitFor({ state: 'hidden' });
    await trigger.click();
    await menu.waitFor(POLL);
    await page.mouse.click(5, 450);
    await menu.waitFor({ state: 'hidden' });
    // Enter chooses.
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focused(), POLL).toBe('button:menuitem:Duplicate⌘D');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('answer-light').innerText(), POLL).toBe('Last answer: rename');
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    await menu.waitFor({ state: 'hidden' });
  });

  it('sheet: modal, the focus on Cancel (a destructive default never takes Return), Escape cancels, the focus back on its opener', async () => {
    await gallery();
    const col = page.getByTestId('scope-dark');
    const opener = col.getByRole('button', { name: 'Discard the take…' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('alertdialog', { name: 'Discard the take?' });
    await sheet.waitFor(POLL);
    expect(await sheet.evaluate((d) => d.matches(':modal'))).toBe(true);
    expect(await focused()).toBe('button::Cancel');
    await page.keyboard.press('Enter');
    await sheet.waitFor({ state: 'hidden' });
    expect(await page.getByTestId('answer-dark').innerText()).toBe('Last answer: cancel');
    expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    await sheet.waitFor(POLL);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    expect(await page.getByTestId('answer-dark').innerText()).toBe('Last answer: cancel');
    expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);
    // The destructive action, chosen on purpose.
    await page.keyboard.press('Enter');
    await sheet.getByRole('button', { name: 'Discard' }).click();
    expect(await page.getByTestId('answer-dark').innerText()).toBe('Last answer: discard');
    await sheet.waitFor({ state: 'hidden' });
    await expect.poll(() => opener.evaluate((el) => el === document.activeElement), POLL).toBe(true);
  });

  it('⚑ a sheet its owner keeps open (Escape refused) stays in step with it when the platform closes the dialog itself (review A-L1)', async () => {
    await gallery();
    const col = page.getByTestId('scope-dark');
    const opener = col.getByRole('button', { name: 'Render the take…' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Rendering the take' });
    await sheet.waitFor(POLL);
    // Escape twice with no activation between: Chromium lets the page refuse the first only, then closes the dialog.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await page.getByTestId('answer-dark').innerText()).toBe('Last answer: wait');
    expect(await sheet.evaluate((d) => d.matches(':modal'))).toBe(true);
    expect(await sheet.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    // The owner's own way out closes it; the focus goes back; it opens again (never stuck).
    await sheet.getByRole('button', { name: 'Stop rendering' }).click();
    await sheet.waitFor({ state: 'hidden' });
    expect(await page.getByTestId('answer-dark').innerText()).toBe('Last answer: stop');
    expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    await sheet.waitFor(POLL);
    await sheet.getByRole('button', { name: 'Stop rendering' }).click();
    await sheet.waitFor({ state: 'hidden' });
  });

  it('⚑ the focus goes back when a sheet or the palette closes, at once: a late close event never takes it from where it has moved since', async () => {
    await gallery();
    const col = page.getByTestId('scope-dark');
    // A dialog's close event is a task of its own that a loaded machine delivers late: hold it back, then let it land.
    type Held = Window & { __hold?: AbortController; __held?: Promise<EventTarget> };
    const hold = (selector: string) => page.evaluate((sel) => {
      const w = window as Held;
      const ac = new AbortController();
      w.__hold = ac;
      w.__held = new Promise((resolve) => window.addEventListener('close', (e) => {
        if (!(e.target as Element).matches(sel)) return;
        e.stopImmediatePropagation();
        ac.abort();
        resolve(e.target!);
      }, { capture: true, signal: ac.signal }));
    }, selector);
    const land = () => page.evaluate(async () => {
      const w = window as Held;
      const target = await Promise.race([w.__held!, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
      w.__hold!.abort();
      target?.dispatchEvent(new Event('close'));
      return target ? (target as HTMLElement).getAttribute('aria-label') ?? (target as HTMLElement).textContent!.slice(0, 17) : 'no close event';
    });
    const discard = col.getByRole('button', { name: 'Discard the take…' });
    const render = col.getByRole('button', { name: 'Render the take…' });
    await hold('dialog[role=alertdialog]');
    await discard.click();
    const sheet = page.getByRole('alertdialog', { name: 'Discard the take?' });
    await sheet.waitFor(POLL);
    await sheet.getByRole('button', { name: 'Discard' }).click();
    await sheet.waitFor({ state: 'hidden' });
    expect(await discard.evaluate((el) => el === document.activeElement)).toBe(true);
    // The user moves on before the event lands: it leaves the focus there, and Return opens the sheet focused.
    await render.focus();
    expect(await land()).toBe('Discard the take?');
    expect(await render.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    const busy = page.getByRole('dialog', { name: 'Rendering the take' });
    await busy.waitFor(POLL);
    expect(await sheet.isVisible()).toBe(false);
    await busy.getByRole('button', { name: 'Stop rendering' }).click();
    await busy.waitFor({ state: 'hidden' });
    expect(await render.evaluate((el) => el === document.activeElement)).toBe(true);
    // The palette alike.
    await hold('dialog.k-palette');
    const opener = col.getByRole('button', { name: /Open the palette/ });
    await opener.click();
    await page.getByRole('combobox', { name: 'Command' }).waitFor(POLL);
    await page.keyboard.press('Escape');
    await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);
    await render.focus();
    expect(await land()).toBe('Command palette');
    expect(await render.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  it('palette: the focus in the combobox; typing filters; ↑ ↓ move the active option (a 3 px cue); Enter runs it; Escape gives the focus back', async () => {
    await gallery();
    const col = page.getByTestId('scope-dark');
    const opener = col.getByRole('button', { name: /Open the palette/ });
    await opener.click();
    const box = page.getByRole('combobox', { name: 'Command' });
    await box.waitFor(POLL);
    expect(await box.evaluate((el) => el === document.activeElement)).toBe(true);
    const active = () => box.evaluate((el) => document.getElementById(el.getAttribute('aria-activedescendant') ?? '')?.textContent ?? null);
    expect(await active()).toBe('Projects');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toBe('UI gallerythis page');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await active()).toMatch(/^Toggle the sample inspector/);
    const cue = await page.locator('dialog.k-palette[open] .k-palette-option.is-active').evaluate((el) => getComputedStyle(el).boxShadow);
    expect(cue).toMatch(/3px 0px 0px 0px inset/);
    await box.fill('hello');
    expect(await page.locator('dialog.k-palette[open]').getByRole('option').allInnerTexts()).toEqual(['Say hello\nwrites the last answer']);
    // Review A-L9: Enter while an input method composes a word confirms the word, it runs nothing.
    await box.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(100);
    expect(await page.locator('dialog.k-palette[open]').count()).toBe(1);
    expect(await page.getByTestId('answer-dark').innerText()).not.toBe('Last answer: hello');
    await page.keyboard.press('Enter');
    await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    expect(await page.getByTestId('answer-dark').innerText()).toBe('Last answer: hello');
    await expect.poll(() => opener.evaluate((el) => el === document.activeElement), POLL).toBe(true);
    await page.keyboard.press('Enter');
    await box.waitFor(POLL);
    // The "Nothing matches" live region is in the accessibility tree before it speaks (review A-L5).
    expect(await page.locator('dialog.k-palette[open] .k-palette-none').evaluate((el) => [getComputedStyle(el).display, el.textContent])).toEqual(['block', '']);
    await box.fill('zzz');
    expect(await page.locator('dialog.k-palette[open]').getByRole('option').count()).toBe(0);
    expect(await box.getAttribute('aria-activedescendant')).toBeNull();
    expect(await page.locator('dialog.k-palette[open] .k-palette-none').innerText()).toBe('Nothing matches');
    await page.keyboard.press('Escape');
    await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    await expect.poll(() => opener.evaluate((el) => el === document.activeElement), POLL).toBe(true);
    // Review A-L6: a command that takes the opener away (Go to Projects) leaves the focus on the centre pane.
    await page.keyboard.press('Enter');
    await box.waitFor(POLL);
    await box.fill('projects');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id), POLL).toBe('main');
    // … and so does hiding the inspector with the focus inside it.
    await gallery();
    await page.locator('.sh-inspector summary').focus();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'inspector' } })));
    await expect.poll(() => page.locator('.sh-inspector').isVisible(), POLL).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'inspector' } })));
    await expect.poll(() => page.locator('.sh-inspector').isVisible(), POLL).toBe(true);
  });
});

describe('the shell (L5.9 part E)', () => {
  it('⌘K / Ctrl+K opens the palette in a browser tab and a command goes; ⚑ a modal dialog makes the commands wait', async () => {
    await gallery();
    await page.keyboard.press('ControlOrMeta+k');
    const box = page.getByRole('combobox', { name: 'Command' });
    await box.waitFor(POLL);
    await box.fill('projects');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    // Review B-L3: in a text field Ctrl+K is the field's (on a Mac "delete to the end of the line"); on a Mac it never
    // opens the palette at all — ⌘K does.
    await gallery();
    const title = page.getByTestId('scope-dark').getByRole('textbox', { name: 'Title' });
    await title.focus();
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    expect(await page.locator('dialog.k-palette[open]').count()).toBe(0);
    const mac = await page.evaluate(() => /^(?:mac|iphone|ipad)/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform));
    if (mac) {
      await page.locator('h1').first().click();
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(200);
      expect(await page.locator('dialog.k-palette[open]').count()).toBe(0);
    }
    // ⌘K on a Mac (in a field too), Ctrl+K elsewhere outside a field.
    if (!mac) await page.locator('h1').first().click();
    await page.keyboard.press(mac ? 'Meta+k' : 'Control+k');
    await box.waitFor(POLL);
    await page.keyboard.press('Escape');
    await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    // ⌘K again closes it.
    await page.keyboard.press('ControlOrMeta+k');
    await box.waitFor(POLL);
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('dialog.k-palette[open]').waitFor({ state: 'detached' });
    // A modal open: neither ⌘K, nor a menu command, nor a mode does anything.
    await page.goto(`${studio.url}#/p/${P}/s/quote`);
    await page.locator('[data-testid="step"]').first().waitFor(POLL);
    await gallery();
    await page.getByTestId('scope-dark').getByRole('button', { name: 'Discard the take…' }).click();
    await page.getByRole('alertdialog').waitFor(POLL);
    await page.keyboard.press('ControlOrMeta+k');
    for (const id of ['palette', 'mode-script', 'inspector']) await page.evaluate((x) => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: x } })), id);
    await page.waitForTimeout(300);
    expect(await page.locator('dialog[open]').count()).toBe(1);
    expect(page.url()).toMatch(/#\/ui$/);
    expect(await page.locator('.sh-inspector').isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    // Closed: the same command acts (the scenario opened last in the project is not the gallery's: no mode here).
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'inspector' } })));
    await expect.poll(() => page.locator('.sh-inspector').isVisible(), POLL).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'inspector' } })));
    await expect.poll(() => page.locator('.sh-inspector').isVisible(), POLL).toBe(true);
    // An id off the list does nothing.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'reload' } })));
    await page.waitForTimeout(200);
    expect(page.url()).toMatch(/#\/ui$/);
  });

  it('the modes follow the scenario in context (or say there is none); the centre keeps its scroll inside a screen, starts at the top of a new one', async () => {
    await page.goto(`${studio.url}#/`);
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    const modes = page.getByRole('navigation', { name: 'Mode' });
    expect(await modes.getByRole('button', { disabled: true }).count()).toBe(4);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'mode-edit' } })));
    await expect.poll(() => page.locator('.sh-said').innerText(), POLL).toBe('Open a scenario first');
    await page.goto(`${studio.url}#/p/${P}/s/quote`);
    await page.locator('[data-testid="step"]').first().waitFor(POLL);
    expect(await modes.getByRole('link', { name: 'Script' }).getAttribute('aria-current')).toBe('page');
    expect(await modes.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(`#/p/${P}/s/quote/timeline`);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'mode-review' } })));
    await page.waitForURL(`**#/p/${P}/s/quote/comments`);
    expect(await modes.getByRole('link', { name: 'Review' }).getAttribute('aria-current')).toBe('page');
    // On the project's own page the scenario opened last stays in context.
    await page.goto(`${studio.url}#/p/${P}`);
    await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor(POLL);
    expect(await modes.getByRole('link', { name: 'Shoot' }).getAttribute('href')).toBe(`#/p/${P}/s/quote/run`);
    expect(await modes.locator('[aria-current]').count()).toBe(0);
    // One current page in the browser: Productions (L5.10a: the open project's tree), nothing else (review A-L9).
    expect(await page.locator('.sh-browser [aria-current="page"] .k-source-label').allInnerTexts()).toEqual(['Productions']);
    // …and one current row whatever its content (review B-M3: a stray aria-current without a label child counts too).
    expect(await page.locator('.sh-browser [aria-current="page"]').count()).toBe(1);
    // The centre pane: scrolled inside the comments screen, a thread address keeps the scroll; a new screen starts at 0.
    await page.goto(`${studio.url}#/p/${P}/s/quote/comments`);
    await page.locator('main h1').waitFor(POLL);
    await page.evaluate(() => {
      const m = document.getElementById('main')!;
      (m.firstElementChild as HTMLElement).style.minHeight = '4000px';
      m.scrollTop = 900;
    });
    expect(await page.evaluate(() => document.getElementById('main')!.scrollTop)).toBe(900);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    await page.evaluate((p) => (location.hash = `#/p/${p}/s/quote/comments/c_01JZZZZZZZZZZZZZZZZZZZZZZZ`), P);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.getElementById('main')!.scrollTop)).toBe(900);
    await page.evaluate((p) => (location.hash = `#/p/${p}/s/quote/timeline`), P);
    await expect.poll(() => page.evaluate(() => document.getElementById('main')!.scrollTop), POLL).toBe(0);
  });

  it('a long scenario name never runs under the mode switch at 900 px; the bars stay in view', async () => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`${studio.url}#/p/${P}/s/${LONG}`);
    await page.locator('main h1').waitFor(POLL);
    const box = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { start: r('.sh-titlebar-start').right, centre: r('.sh-titlebar-centre').left, centreR: r('.sh-titlebar-centre').right, end: r('.sh-titlebar-end').left, bar: r('.sh-titlebar').height, status: r('.sh-statusbar-wrap').bottom, sw: document.scrollingElement!.scrollWidth };
    });
    expect(box.start).toBeLessThanOrEqual(box.centre);
    expect(box.centreR).toBeLessThanOrEqual(box.end);
    expect(await centreOffset(page)).toBeLessThanOrEqual(1);
    expect(box.bar).toBe(48);
    expect(box.status).toBe(700);
    expect(box.sw).toBeLessThanOrEqual(900);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});

describe('L5.10a: the productions listbox and the project shell', () => {
  it('⚑ the poster grid is ONE tab stop: arrows move the selection (a row is three), Home / End, Enter opens, Escape clears; a click selects, a double-click opens', async () => {
    // Wide enough for the gallery's half column to hold three posters (review B-M2: as many columns as fit).
    await page.setViewportSize({ width: 2200, height: 900 });
    await gallery();
    const col = page.getByTestId('scope-dark');
    const grid = col.getByRole('listbox', { name: /Sample productions/ });
    const selected = () => grid.locator('[role="option"][aria-selected="true"]').allInnerTexts();
    const columns = () => grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    // Nothing selected: no aria-activedescendant at all (review A-L6: never an empty reference).
    expect(await grid.getAttribute('aria-activedescendant')).toBeNull();
    expect(await columns()).toBe(3);
    await grid.focus();
    await page.keyboard.press('ArrowRight');
    expect((await selected())[0]).toMatch(/^Request a quote/);
    expect(await grid.getAttribute('aria-activedescendant')).toBe(await grid.locator('[role="option"]').first().getAttribute('id'));
    await page.keyboard.press('ArrowDown');
    expect((await selected())[0]).toMatch(/^Reports/);
    await page.keyboard.press('ArrowUp');
    expect((await selected())[0]).toMatch(/^Request a quote/);
    await page.keyboard.press('End');
    expect((await selected())[0]).toMatch(/^Reports/);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    expect((await selected())[0]).toMatch(/^Manage the catalogue/);
    // The selected option carries the fill and the 2 px ring (more than colour).
    expect(await grid.locator('[aria-selected="true"]').evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/2px/);
    await page.keyboard.press('Enter');
    expect(await page.getByTestId('answer-dark').innerText()).toBe('Last answer: open catalogue');
    await page.keyboard.press('Escape');
    expect(await selected()).toEqual([]);
    // One tab stop: Tab leaves the grid at once (no option is a stop).
    expect(await grid.locator('[role="option"][tabindex]').count()).toBe(0);
    await grid.focus();
    await page.keyboard.press('Tab');
    expect(await grid.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    await grid.locator('[role="option"]').nth(2).click();
    expect((await selected())[0]).toMatch(/^Sign up/);
    await grid.locator('[role="option"]').nth(3).dblclick();
    expect(await page.getByTestId('answer-dark').innerText()).toBe('Last answer: open reports');
    // Narrower: one poster a row — ↓ moves by the row the layout shows, one.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(columns).toBe(1);
    await grid.locator('[role="option"]').first().click();
    await page.keyboard.press('ArrowDown');
    expect((await selected())[0]).toMatch(/^Manage the catalogue/);
  });

  it('the open project: its tree in the browser (Productions and its groups, Library, Locations, Cast, Project); the title bar\'s project menu goes to another project or Welcome', async () => {
    await page.goto(`${studio.url}#/p/${P}`);
    await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor(POLL);
    const nav = page.getByRole('navigation', { name: 'Studio' });
    await expect.poll(() => nav.getByRole('link', { name: /^Needs a shoot/ }).count(), POLL).toBe(1);
    for (const name of [/^Productions/, /^Ready to render/, /^Failed/, /^Components/, /^Themes/, /^local/, /^Sessions/, /^README/, /^Record a scenario/]) expect(await nav.getByRole('link', { name }).count(), String(name)).toBe(1);
    expect(await nav.getByRole('heading').allInnerTexts()).toEqual(['Library', 'Locations', 'Cast', 'Project']);
    // A location's flags in words; a persona's session as a shape and a word.
    expect(await nav.getByRole('link', { name: /^production/ }).innerText()).toMatch(/production$/);
    await expect.poll(async () => (await nav.locator('.k-source-item.is-quiet').allInnerTexts()).join('|'), POLL).toMatch(/supplier/);
    expect(await nav.locator('.k-source-item.is-quiet .k-mark-word').first().innerText()).toMatch(/\w/);
    // A smart group: the grid filtered, its row current.
    await nav.getByRole('link', { name: /^Needs a shoot/ }).click();
    await page.getByRole('heading', { level: 1, name: 'Needs a shoot' }).waitFor(POLL);
    expect(await page.locator('.sh-browser [aria-current="page"] .k-source-label').allInnerTexts()).toEqual(['Needs a shoot']);
    // The project menu.
    const menu = page.getByRole('banner').getByRole('button', { name: 'Northfield (fixture)' });
    await menu.click();
    await page.getByRole('menuitem', { name: 'All projects' }).click();
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    expect(page.url()).toMatch(/#\/$/);
  });
});

describe('⚑ the overlay title bar contract (L5.9, DESIGN §4j)', () => {
  it('under the desktop app\'s overlay bar: 80 px for the window buttons, no ⌘K of its own, commands from the menu; without it, inset 0', async () => {
    const app = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await app.addInitScript(() => {
      (window as unknown as { __studioShell: unknown }).__studioShell = Object.freeze({ titleBar: 'overlay' });
    });
    const p = await open(app);
    try {
      expect(await p.evaluate(() => document.documentElement.dataset.titlebar)).toBe('overlay');
      const geo = await p.evaluate(() => ({ mark: document.querySelector('.sh-appmark')!.getBoundingClientRect().left, bar: document.querySelector('.sh-titlebar')!.getBoundingClientRect().height, select: getComputedStyle(document.querySelector('.sh-titlebar')!).userSelect }));
      expect(geo.mark).toBeGreaterThanOrEqual(80);
      expect(geo.bar).toBe(48);
      // The mode switch stays centred on the window, inset or not (review B-L1: it sat 42 px right).
      expect(await centreOffset(p)).toBeLessThanOrEqual(1);
      expect(geo.select).toBe('none');
      // The skip link shows clear of the window buttons too.
      await p.keyboard.press('Tab');
      expect(await p.evaluate(() => document.activeElement!.getBoundingClientRect().left)).toBeGreaterThanOrEqual(80);
      // ⌘K is the menu's: the page leaves it alone; the command opens the palette.
      await p.keyboard.press('ControlOrMeta+k');
      await p.waitForTimeout(300);
      expect(await p.locator('dialog[open]').count()).toBe(0);
      await p.evaluate(() => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'palette' } })));
      await p.getByRole('combobox', { name: 'Command' }).waitFor(POLL);
      await p.keyboard.press('Escape');
      await p.locator('dialog[open]').waitFor({ state: 'detached' });
      for (const detail of [{ id: 'reload' }, { id: 'eval' }, null, 'palette', { id: ['palette'] }]) await p.evaluate((d) => window.dispatchEvent(new CustomEvent('studio:command', { detail: d })), detail);
      await p.waitForTimeout(200);
      expect(await p.locator('dialog[open]').count()).toBe(0);
    } finally {
      await app.close();
    }
    // A browser tab: no flag, no inset; the switch centred too.
    expect(await page.evaluate(() => document.documentElement.dataset.titlebar ?? null)).toBeNull();
    expect(await centreOffset(page)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.querySelector('.sh-appmark')!.getBoundingClientRect().left)).toBeLessThan(40);
    expect(errors).toEqual([]);
  });
});
