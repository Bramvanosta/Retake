/**
 * L5.16d — the desktop app's update in the Studio (shell/UpdateSheet.tsx, update-ops.ts; DESIGN §4p (d),
 * docs/reference/studio-ui.md), in Chromium with the app's flag, on a Studio server whose desktop pipe is attached as
 * the shell's and whose update lines are the shell's own (applyShellLine):
 * - "Update available · v0.2.1" in the status bar (a kit Button) opens a kit Sheet: the version, the notes as text
 *   (markup shown, never rendered), Later · Install and Restart; its a11y tour in dark (1280 / 900) and light;
 * - nothing is written before the click; Install and Restart writes exactly `{"type":"update","action":"install"}`;
 *   the sheet follows the shell's states (waiting for jobs, Later stops it, a failure in words);
 * - review d: a refusal keeps the sheet open with its words ("not writable": install from the disk image), a failed
 *   install offers Install again only when the shell says it may (`retry`), Later acknowledges a failure; the badge
 *   stays a live button while downloading (it reopens the sheet: Later); the notes are a named region the keyboard
 *   scrolls; the words before the click are in the future tense;
 * - Help › Check for Updates… (the shell's `studio:update` event) opens the sheet;
 * - up to date or off: nothing in the status bar; a browser tab (no flag) has no update control.
 * Screenshots go to RETAKE_UI_SHOTS when set.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyShellLine, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { station } from './a11y-tour.js';
import type { Tour } from './a11y-tour.js';

const POLL = { timeout: 15_000 };
const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-e2e-update-')));
const ws = join(base, 'ws');
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
const lines: string[] = [];
const errors: string[] = [];

const shell = (o: Record<string, unknown>) => expect(applyShellLine(studio.setup, ws, JSON.stringify(o), studio.update)).toBe(true);
const NOTES = 'Faster renders.\n<b>not bold</b> & <img src=x onerror=alert(1)>';
const available = { type: 'update', state: 'available', current: '0.2.0', version: '0.2.1', notes: NOTES, checked: 1762000000 };

async function open(app: boolean): Promise<Page> {
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('dialog', (d) => (errors.push(`dialog: ${d.message()}`), void d.dismiss()));
  if (app) await p.addInitScript(() => ((window as unknown as { __studioShell: unknown }).__studioShell = Object.freeze({ titleBar: 'standard' })));
  await p.goto(studio.launchUrl());
  await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
  return p;
}
const sheet = (p: Page) => p.locator('dialog[data-testid="update-sheet"]');
const isOpen = (p: Page) => sheet(p).evaluate((d: HTMLDialogElement) => d.open).catch(() => false);
const badge = (p: Page) => p.getByTestId('update-badge');
const tour = (page: Page): Tour => ({ page, log: [] }) as unknown as Tour;
const shot = async (p: Page, name: string) => {
  if (process.env.RETAKE_UI_SHOTS) await p.screenshot({ path: join(process.env.RETAKE_UI_SHOTS, `${name}.png`) });
};

beforeAll(async () => {
  mkdirSync(ws, { recursive: true });
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  studio.desktop.attach((l) => (lines.push(l), true));
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  rmSync(base, { recursive: true, force: true });
});

describe('the update in the status bar and its sheet', () => {
  it('up to date or off: nothing in the status bar; a browser tab has no update control', async () => {
    shell({ type: 'update', state: 'idle', current: '0.2.0', checked: 1762000000 });
    const p = await open(true);
    await p.waitForTimeout(500);
    expect(await badge(p).count()).toBe(0);
    shell({ type: 'update', state: 'off', current: '0.2.0', reason: 'build' });
    await p.reload();
    await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    await p.waitForTimeout(500);
    expect(await badge(p).count()).toBe(0);
    await p.close();
    shell(available);
    const tab = await open(false);
    await tab.waitForTimeout(800);
    expect(await badge(tab).count()).toBe(0);
    expect(await sheet(tab).count()).toBe(0);
    await tab.close();
  });

  it('"Update available · v0.2.1" opens the sheet: the notes as text, Later · Install and Restart; its a11y tour; nothing written before the click', async () => {
    lines.length = 0;
    shell(available);
    const p = await open(true);
    await expect.poll(() => badge(p).innerText().catch(() => ''), POLL).toBe('Update available · v0.2.1');
    await shot(p, 'update-badge');
    await badge(p).click();
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    expect(await sheet(p).locator('h2').first().innerText()).toBe('Update Retake to v0.2.1?');
    const notes = sheet(p).locator('.sh-update-notes');
    expect(await notes.innerText()).toBe(NOTES);
    expect(await notes.locator('b, img').count()).toBe(0);
    expect(await sheet(p).innerText()).toContain("You have v0.2.0. Install and Restart downloads the update and checks its signature, waits for this workspace's jobs to end, asks about unsaved text, then restarts Retake.");
    // Review d A-L3: a named region the keyboard reaches and scrolls.
    expect(await notes.evaluate((e) => [e.tagName, e.getAttribute('tabindex'), e.getAttribute('role'), e.getAttribute('aria-label')])).toEqual(['DIV', '0', 'region', 'Release notes, from the update feed']);
    expect(await sheet(p).locator('.k-sheet-actions button').allInnerTexts()).toEqual(['Later', 'Install and Restart']);
    const r = await station(tour(p), 'update-sheet', async () => {
      await sheet(p).getByTestId('update-install').waitFor(POLL);
    }, { schemes: [{ scheme: 'dark', widths: [1280, 900] }, { scheme: 'light', widths: [1280] }], walkMax: 20 });
    expect(r.findings, r.report).toEqual([]);
    for (const scheme of ['dark', 'light'] as const) {
      await p.emulateMedia({ colorScheme: scheme });
      await p.setViewportSize({ width: 1280, height: 900 });
      await shot(p, `update-sheet-${scheme}`);
    }
    await p.emulateMedia({ colorScheme: 'dark' });
    expect(lines).toEqual([]);
    // Later with nothing under way closes the sheet and writes nothing; the button stays in the status bar.
    await sheet(p).getByTestId('update-later').click();
    await expect.poll(() => isOpen(p), POLL).toBe(false);
    expect(lines).toEqual([]);
    expect(await badge(p).count()).toBe(1);
    await p.close();
  }, 120_000);

  it('Install and Restart: one pipe line; the sheet follows the shell — waiting for jobs, Later stops it, a failure in words', async () => {
    lines.length = 0;
    shell(available);
    const p = await open(true);
    await badge(p).click();
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    await sheet(p).getByTestId('update-install').click();
    await expect.poll(() => lines, POLL).toEqual(['{"type":"update","action":"install"}']);
    shell({ type: 'update', state: 'waiting', current: '0.2.0', version: '0.2.1', jobs: 2 });
    await expect.poll(() => sheet(p).getByTestId('update-progress').innerText().catch(() => ''), POLL).toBe('Waiting for 2 jobs\n\nRetake restarts once the 2 jobs of this workspace end. Later stops waiting.');
    await expect.poll(() => badge(p).innerText(), POLL).toBe('Update waits for 2 jobs');
    await shot(p, 'update-sheet-waiting');
    expect(await sheet(p).locator('.k-sheet-actions button').allInnerTexts()).toEqual(['Close', 'Later']);
    await sheet(p).getByTestId('update-later').click();
    await expect.poll(() => lines, POLL).toEqual(['{"type":"update","action":"install"}', '{"type":"update","action":"later"}']);
    await expect.poll(() => isOpen(p), POLL).toBe(false);
    // A failed install remembered by the restarted app, before its check: said, and no dead Install and Restart.
    shell({ type: 'update', state: 'failed', current: '0.2.0', failure: 'install', version: '0.2.1', checked: null, retry: false });
    await p.reload();
    await expect.poll(() => badge(p).innerText().catch(() => ''), POLL).toBe('Update v0.2.1 not installed');
    await badge(p).click();
    await expect.poll(() => sheet(p).getByTestId('update-progress').innerText().catch(() => ''), POLL).toBe('The update did not go through\n\nThe update could not be installed: Retake 0.2.0 was kept.');
    expect(await sheet(p).getByTestId('update-progress').getAttribute('role')).toBe('alert');
    expect(await sheet(p).locator('.k-sheet-actions button').allInnerTexts()).toEqual(['Close']);
    await shot(p, 'update-sheet-failed');
    // Its check found the version again: Install may be tried again; Later acknowledges the failure (one pipe line).
    lines.length = 0;
    shell({ type: 'update', state: 'failed', current: '0.2.0', failure: 'install', version: '0.2.1', checked: 1762000000, retry: true });
    await expect.poll(() => sheet(p).locator('.k-sheet-actions button').allInnerTexts(), POLL).toEqual(['Later', 'Install and Restart']);
    await sheet(p).getByTestId('update-later').click();
    await expect.poll(() => lines, POLL).toEqual(['{"type":"update","action":"later"}']);
    await expect.poll(() => isOpen(p), POLL).toBe(false);
    await p.close();
  }, 120_000);

  it('review d: a refusal stays in the sheet in words (not writable → the disk image); the badge stays live while downloading', async () => {
    lines.length = 0;
    shell(available);
    const p = await open(true);
    await badge(p).click();
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    await sheet(p).getByTestId('update-install').click();
    await expect.poll(() => lines, POLL).toEqual(['{"type":"update","action":"install"}']);
    // The shell refuses: the app's folder is not writable by this account.
    shell({ type: 'update', state: 'failed', current: '0.2.0', failure: 'not_writable', version: '0.2.1', checked: 1762000000, retry: false });
    await expect.poll(() => sheet(p).getByTestId('update-progress').innerText().catch(() => ''), POLL).toBe('The update cannot be installed here\n\nRetake cannot replace itself in its folder (this account may not write there): install the new version from its disk image.');
    await p.waitForTimeout(2500);
    expect(await isOpen(p)).toBe(true);
    // The long sentence wraps inside the sheet (it sits in the status bar's one-line text otherwise).
    expect(await sheet(p).getByTestId('update-progress').evaluate((c) => c.scrollWidth <= c.clientWidth)).toBe(true);
    expect(await badge(p).innerText()).toBe('Update v0.2.1: install it from its disk image');
    expect(await sheet(p).locator('.k-sheet-actions button').allInnerTexts()).toEqual(['Close']);
    await shot(p, 'update-sheet-not-writable');
    await sheet(p).getByTestId('update-close').click();
    await expect.poll(() => isOpen(p), POLL).toBe(false);
    // Off after a click: said too.
    shell({ type: 'update', state: 'off', current: '0.2.0', reason: 'translocated' });
    await p.evaluate(() => window.dispatchEvent(new CustomEvent('studio:update', { detail: {} })));
    await expect.poll(() => sheet(p).getByTestId('update-progress').innerText().catch(() => ''), POLL).toBe('Updates are off\n\nRetake runs from a temporary copy macOS made: move it to Applications, then open it again.');
    await sheet(p).getByTestId('update-close').click();
    // Downloading: the badge is a live button (not disabled, aria-busy) that reopens the sheet with Later.
    shell({ type: 'update', state: 'downloading', current: '0.2.0', version: '0.2.1' });
    await p.reload();
    await expect.poll(() => badge(p).innerText().catch(() => ''), POLL).toBe('Downloading v0.2.1…');
    expect(await badge(p).evaluate((b: HTMLButtonElement) => [b.disabled, b.getAttribute('aria-busy')])).toEqual([false, 'true']);
    await badge(p).focus();
    await p.keyboard.press('Enter');
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    expect(await sheet(p).locator('.k-sheet-actions button').allInnerTexts()).toEqual(['Close', 'Later']);
    lines.length = 0;
    await sheet(p).getByTestId('update-later').click();
    await expect.poll(() => lines, POLL).toEqual(['{"type":"update","action":"later"}']);
    // Long notes scroll from the keyboard once the region has the focus.
    shell({ ...available, notes: Array.from({ length: 80 }, (_, i) => `Line ${i + 1}.`).join('\n') });
    await badge(p).click();
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    const region = sheet(p).getByTestId('update-notes');
    await region.focus();
    await p.keyboard.press('PageDown');
    await expect.poll(() => region.evaluate((e) => e.scrollTop), POLL).toBeGreaterThan(0);
    await p.close();
    expect(errors).toEqual([]);
  }, 120_000);

  it('Help › Check for Updates… (the shell\'s studio:update event) opens the sheet', async () => {
    shell(available);
    const p = await open(true);
    await badge(p).waitFor(POLL);
    expect(await isOpen(p)).toBe(false);
    await p.evaluate(() => window.dispatchEvent(new CustomEvent('studio:update', { detail: {} })));
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    await p.close();
    expect(errors).toEqual([]);
  });
});
