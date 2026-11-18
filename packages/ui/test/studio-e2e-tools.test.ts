/**
 * The app's Tools in the Studio (tools-ops.ts; ToolsItem.tsx, tools-parts.tsx, ToolsScreen.tsx; DESIGN §4p), in
 * Chromium with the app's flag, on a Studio server whose app is faked (the engine's Tools: three small fixture Tools)
 * and whose download is faked (tools-fake.ts — held, wrong bytes, no connection: never the network):
 * - the Set-up sheet's first item "Browser and render tools": its rows, the folder, "Download · N MB" (the download
 *   total), Terms of each tool…; its a11y tour in dark and light;
 * - Download: the item's bars and Pause / Cancel, the status bar's "Downloading tools · N %", Welcome's card; Done
 *   closes the sheet and the download goes on; once ready the bar and the card go;
 * - a capture asked meanwhile waits: its live screen says "Waiting for the browser" and starts by itself;
 * - a digest mismatch: the Tool refused, the expected and received digests, the URL; no connection: what arrived is kept;
 * - the Tools page (`#/setup/tools`): the table (download and disk), the folder, Check again, Show in Finder's pipe
 *   line, the terms, the older versions and Remove… with its confirmation; its a11y tour in dark and light.
 * Screenshots go to RETAKE_UI_SHOTS when set.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { SetupContext } from '../src/server/setup-ops.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { scratchHome } from '@retake/test-support/home';
import { station } from './a11y-tour.js';
import type { Tour } from './a11y-tour.js';
import { fakeSetupApp, fakeTools } from './tools-fake.js';
import type { FakeNet } from './tools-fake.js';
import type { FixtureTools } from '@retake/test-support/tools';

const POLL = { timeout: 20_000 };
const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-e2e-tools-')));
const ws = join(base, 'ws');
const rhome = join(base, 'retake-home');
const testHome = scratchHome();
const SHOTS = process.env.RETAKE_UI_SHOTS;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let net: FakeNet;
let fx: FixtureTools;
const lines: string[] = [];
const errors: string[] = [];

const app = fakeSetupApp(join(base, 'Applications'));
const machine = (): SetupContext => ({
  bundle: app,
  home: join(base, 'home'),
  env: { PATH: '/usr/bin:/bin', RETAKE_HOME: rhome },
  uid: process.getuid!(),
  readOnly: () => false,
  processes: async () => '',
  desktopConfig: join(base, 'home', 'claude.json'),
});
function wipe(dir: string): void {
  spawnSync('/bin/chmod', ['-R', 'u+w', dir]);
  rmSync(dir, { recursive: true, force: true });
}
const MB = (n: number) => `${Math.round(n / 1e6) < 10 ? (n / 1e6).toFixed(1) : Math.round(n / 1e6)} MB`;

async function open(hash = ''): Promise<Page> {
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.addInitScript(() => ((window as unknown as { __studioShell: unknown }).__studioShell = Object.freeze({ titleBar: 'standard' })));
  await p.goto(studio.launchUrl());
  await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
  if (hash) await p.evaluate((h) => (location.hash = h), hash);
  return p;
}
const sheet = (p: Page) => p.locator('dialog[data-testid="setup-sheet"]');
const item = (p: Page) => sheet(p).getByTestId('setup-tools');
const tour = (page: Page): Tour => ({ page, log: [] }) as unknown as Tour;
const shot = async (p: Page, name: string) => {
  if (!SHOTS) return;
  for (const scheme of ['dark', 'light'] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await p.emulateMedia({ colorScheme: 'dark' });
};
const statusOf = () => studio.engine.tools.status();

beforeAll(async () => {
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(base, 'home'), { recursive: true });
  testHome.use(rhome);
  await fixtureWorkspace(ws);
  const t = await fakeTools(base);
  net = t.net;
  fx = t.fx;
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false, setup: machine, tools: t.engineTools });
  studio.desktop.attach((l) => (l.startsWith('{"type":"menu",') || l.startsWith('{"type":"cli",') || lines.push(l), true));
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  testHome.restore();
  wipe(base);
});

describe("the app's Tools in the Studio", () => {
  it('the Set-up sheet opens with "Browser and render tools" first: its rows, the folder, Download · the total, the terms; its a11y tour', async () => {
    const p = await open();
    await expect
      .poll(
        () =>
          sheet(p)
            .evaluate((d: HTMLDialogElement) => d.open)
            .catch(() => false),
        POLL,
      )
      .toBe(true);
    await item(p).waitFor(POLL);
    expect((await sheet(p).locator('.k-check-title').allInnerTexts())[0]).toBe('Browser and render tools');
    expect(await item(p).locator('.k-check-word').innerText()).toBe('Needed: not downloaded yet');
    const total = fx.entries.reduce((n, e) => n + e.bytes, 0);
    expect(await item(p).getByTestId('tools-download').innerText()).toBe(`Download · ${MB(total)}`);
    expect(await item(p).getByTestId('tools-parts').locator('li').count()).toBe(3);
    expect(await item(p).innerText()).toContain(join(rhome, 'tools'));
    await item(p).getByTestId('tools-terms-toggle').click();
    expect(await item(p).getByTestId('tools-terms').innerText()).toContain('the app does not redistribute it');
    await item(p).getByTestId('tools-terms-toggle').click();
    // Nothing was downloaded without the click.
    expect(net.calls).toEqual([]);
    const r = await station(tour(p), 'setup-tools', async () => item(p).locator('.k-check-word').waitFor(POLL), {
      schemes: [
        { scheme: 'dark', widths: [1440, 900] },
        { scheme: 'light', widths: [1440] },
      ],
      walkMax: 60,
    });
    expect(r.findings, r.report).toEqual([]);
    await p.setViewportSize({ width: 1440, height: 900 });
    await sheet(p).evaluate((x) => (x.scrollTop = 0));
    await shot(p, 'tools-1-sheet-needed');
    // Work outside the queue that needs the render tools says so, with the way to them (the library's posters).
    await sheet(p).getByTestId('setup-done').click();
    await p.evaluate(() => (location.hash = '#/p/northfield-fixture/library'));
    const lib = p.getByTestId('library-tools');
    await lib.waitFor(POLL);
    expect(await lib.innerText()).toMatch(/Not downloaded yet[\s\S]*Rendering the components' posters and loops needs the render tools, which Retake has not downloaded yet\./);
    expect(await lib.getByTestId('library-tools-download').innerText()).toBe(`Download · ${MB(total)}`);
    expect(net.calls).toEqual([]);
    await p.close();
  }, 180_000);

  it('Download: bars, Pause, the status bar and Welcome follow it; Done keeps it going; a queued capture waits, then the bar and card go', async () => {
    const p = await open('#/setup');
    await item(p).waitFor(POLL);
    net.hold = true;
    await item(p).getByTestId('tools-download').click();
    await expect.poll(() => item(p).locator('.k-check-word').innerText(), POLL).toMatch(/^Downloading · /);
    await item(p).getByTestId('tools-pause').waitFor(POLL);
    await item(p).getByTestId('tools-cancel').waitFor(POLL);
    await expect.poll(() => p.getByTestId('tools-bar').innerText(), POLL).toMatch(/Downloading tools · \d+ %/);
    await shot(p, 'tools-2-sheet-downloading');
    await sheet(p).getByTestId('setup-done').click();
    await p.getByTestId('welcome-tools').waitFor(POLL);
    expect(await p.getByTestId('welcome-tools').innerText()).toContain('A job asked meanwhile waits in the queue.');
    await p.getByTestId('welcome-tools').scrollIntoViewIfNeeded();
    await shot(p, 'tools-3-background');
    // A capture asked now waits for the browser in the queue.
    const sub = await studio.engine.runs.submit({ project: 'northfield-fixture', scenario: 'highlights', mode: 'capture' });
    await p.evaluate((h) => (location.hash = h), `#/p/northfield-fixture/s/highlights/run/${sub.run_id}`);
    const waiting = p.getByTestId('live-tools');
    await waiting.waitFor(POLL);
    expect(await waiting.innerText()).toMatch(/Waiting for the browser[\s\S]*This capture starts by itself once the browser is downloaded and checked/);
    await shot(p, 'tools-4-blocked');
    net.hold = false;
    await expect.poll(() => statusOf().state, POLL).toBe('ready');
    await expect.poll(() => p.getByTestId('tools-bar').count(), POLL).toBe(0);
    await expect.poll(() => waiting.count(), POLL).toBe(0);
    await studio.engine.runs.cancel?.('northfield-fixture', sub.run_id).catch(() => undefined);
    await p.evaluate(() => (location.hash = '#/'));
    await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    expect(await p.getByTestId('welcome-tools').count()).toBe(0);
    await p.close();
  }, 120_000);

  it('a digest mismatch says the Tool, the expected and received digests and the URL; no connection keeps what arrived', async () => {
    wipe(join(rhome, 'tools'));
    net.wrong = true;
    const p = await open('#/setup');
    await item(p).waitFor(POLL);
    await item(p).getByTestId('tools-download').click();
    const m = item(p).getByTestId('tools-mismatch');
    await m.waitFor(POLL);
    const b = statusOf().tools.find((t) => t.id === 'browser')!;
    const text = await m.innerText();
    expect(text).toContain("The browser's file is not the one this version of Retake expects");
    expect(text).toContain(`${b.expected!.slice(0, 4)}…${b.expected!.slice(-4)}`);
    expect(text).toContain(`${b.got!.slice(0, 4)}…${b.got!.slice(-4)}`);
    expect(text).toContain('storage.googleapis.com/');
    expect(await item(p).getByTestId('tools-retry').innerText()).toBe('Try again');
    await item(p).getByTestId('tools-copy').click();
    expect(await p.evaluate(() => navigator.clipboard.readText())).toContain(`Received sha256: ${b.got}`);
    await p.waitForTimeout(500);
    await shot(p, 'tools-5-failed-mismatch');
    net.wrong = false;
    net.offline = true;
    await item(p).getByTestId('tools-retry').click();
    const o = item(p).getByTestId('tools-offline');
    await o.waitFor(POLL);
    expect(await o.innerText()).toMatch(/What arrived is kept: Resume goes on from/);
    expect(await item(p).locator('.k-check-word').innerText()).toBe('Stopped: no connection');
    await shot(p, 'tools-5-failed-offline');
    net.offline = false;
    await item(p).getByTestId('tools-resume').click();
    await expect.poll(() => statusOf().state, POLL).toBe('ready');
    await expect.poll(() => item(p).locator('.k-check-word').innerText(), POLL).toBe('Ready');
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('the Tools page: the table, the folder, Check again, Show in Finder, the terms, Remove… older versions; its a11y tour', async () => {
    const old = join(rhome, 'tools', 'browsers', 'chromium-1');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'x'), 'old');
    const p = await open('#/setup/tools');
    const page = p.getByTestId('tools-screen');
    await page.waitFor(POLL);
    expect(await p.locator('h1').innerText()).toBe('Tools');
    const rows = await page.getByTestId('tools-table').locator('tbody tr').allInnerTexts();
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.includes('Ready'))).toBe(true);
    expect(await page.innerText()).toContain(join(rhome, 'tools'));
    await page.getByTestId('tools-check').click();
    await expect.poll(() => page.innerText(), POLL).toMatch(/every file matches/);
    lines.length = 0;
    await page.getByTestId('tools-reveal').click();
    await expect.poll(() => lines, POLL).toEqual(['{"type":"setup","action":"tools_folder"}']);
    await page.getByTestId('tools-terms-toggle').click();
    expect(await page.getByTestId('tools-terms').innerText()).toContain('LICENSE.headless_shell');
    expect(await page.getByTestId('tools-older').innerText()).toContain('browsers/chromium-1');
    await shot(p, 'tools-7-page');
    const r = await station(tour(p), 'tools-page', async () => page.getByTestId('tools-older').waitFor(POLL), {
      schemes: [
        { scheme: 'dark', widths: [1440, 900] },
        { scheme: 'light', widths: [1440] },
      ],
      walkMax: 60,
    });
    expect(r.findings, r.report).toEqual([]);
    await page.getByTestId('tools-remove').click();
    await page.getByTestId('tools-remove-confirm').click();
    await page.getByTestId('tools-pruned').waitFor(POLL);
    expect(await page.getByTestId('tools-pruned').innerText()).toMatch(/Removed 1 folder/);
    expect(errors).toEqual([]);
    await p.close();
  }, 180_000);
});
