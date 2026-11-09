/**
 * L5.16c — the installed app's Set-up sheet (shell/SetupSheet.tsx, setup-ops.ts; DESIGN §4p (c),
 * docs/reference/studio-ui.md), in Chromium with the app's flag, on a Studio server whose machine is injected (a fake
 * app, a scratch HOME, scratch Claude Desktop config, a fake `claude`; the desktop pipe attached as the shell's):
 * - it opens by itself at the first start (setup_status `seen` false); its a11y tour in dark (1280 / 1440 / 900) and light,
 *   the Tab walk staying inside the modal; Done remembers it (no sheet at the next load);
 * - every step on its click only: Install retake links the scratch HOME's ~/.local/bin; Add to Claude Desktop… shows
 *   its confirmation, then writes; Run with Claude Code (a fake `claude`) — its output, the current Desktop entry and
 *   the server's words are text (markup shown, never rendered);
 * - Help › Set Up / Install the retake Command… (the shell's `studio:setup` event, its section) and `#/setup` open it;
 *   a malformed event is ignored;
 * - critique H1: from a translocated copy the sheet says "Move Retake to Applications, then open it again" and the
 *   command, Claude Code and Claude Desktop buttons are off (its own a11y tour, dark and light);
 * - a browser tab (no flag) has no Set-up sheet.
 * L5.16c fixes (review c A-M2 / A-L6 / A-L7 / A-L8): the focus — the sheet opens on its title (Return chooses nothing,
 * Escape closes it without remembering it: it opens again), Help › Uninstall on the confirmation's Uninstall, a
 * confirmation on its own button and back to its opener on Cancel / Keep it, the item's first action (or its title)
 * once an action's button is gone; the folder panel said only once the shell opened it, "No folder was chosen" after a
 * cancel; the process list read only while the Claude Desktop step is in view, at most every 5 s.
 * Screenshots go to RETAKE_UI_SHOTS when set.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BundleInfo } from '@retake/core/io';
import { readAppSettings } from '@retake/engine/integrations';
import { applyShellLine, startStudioServer } from '../src/index.js';
import type { SetupContext, StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { station } from './a11y-tour.js';
import type { Tour } from './a11y-tour.js';

const POLL = { timeout: 15_000 };
const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-e2e-setup-')));
const ws = join(base, 'ws');
const home = join(base, 'home');
const retakeHome = join(base, 'retake-home');
const savedHome = process.env.RETAKE_HOME;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let ctx: SetupContext;
const lines: string[] = [];
const errors: string[] = [];
let psCalls = 0;

function fakeApp(dir: string): BundleInfo {
  const sealed = join(dir, 'Retake.app');
  const root = join(sealed, 'Contents', 'Resources');
  for (const d of ['bin', 'node/bin', 'engine/dist', 'plugin/.claude-plugin', 'plugin/skills/.claude-plugin']) mkdirSync(join(root, d), { recursive: true });
  for (const [f, text] of [['bin/retake', '#!/bin/sh\n'], ['node/bin/node', '#!/bin/sh\n'], ['node/guard.cjs', ''], ['engine/dist/bin.js', ''], ['plugin/.claude-plugin/marketplace.json', '{}'], ['plugin/skills/.claude-plugin/plugin.json', '{}']] as const) writeFileSync(join(root, f), text);
  chmodSync(join(root, 'bin/retake'), 0o755);
  return { root, sealed, manifest: {} as BundleInfo['manifest'], paths: { node: join(root, 'node/bin/node'), engine: join(root, 'engine'), browsers: join(root, 'browsers'), ffmpeg: null, templates: join(root, 'engine/templates'), plugin: join(root, 'plugin') } };
}
const app = fakeApp(join(base, 'Applications'));
const moved = fakeApp(join(base, 'AppTranslocation', '0A1B', 'd'));
const desktopConfig = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const machine = (o: Partial<SetupContext> = {}): SetupContext => ({
  bundle: app,
  home,
  env: { PATH: '/usr/bin:/bin', RETAKE_HOME: retakeHome, CLAUDE_CONFIG_DIR: join(base, 'claude-cfg') },
  uid: process.getuid!(),
  readOnly: () => false,
  processes: async () => (psCalls++, ''),
  desktopConfig,
  ...o,
});

async function open(app: boolean, hash = ''): Promise<Page> {
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  if (app) await p.addInitScript(() => ((window as unknown as { __studioShell: unknown }).__studioShell = Object.freeze({ titleBar: 'standard' })));
  await p.goto(studio.launchUrl());
  await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
  if (hash) await p.evaluate((h) => (location.hash = h), hash);
  return p;
}
const sheet = (p: Page) => p.locator('dialog[data-testid="setup-sheet"]');
const isOpen = (p: Page) => sheet(p).evaluate((d: HTMLDialogElement) => d.open).catch(() => false);
const tour = (page: Page): Tour => ({ page, log: [] }) as unknown as Tour;
/** The focused element: its test id, else its tag and text. */
const focused = (p: Page) => p.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  return a?.dataset.testid ?? `${a?.tagName.toLowerCase()}:${a?.textContent?.trim().slice(0, 40)}`;
});
const SCHEMES = [{ scheme: 'dark' as const, widths: [1280, 1440, 900] }, { scheme: 'light' as const, widths: [1280] }];

beforeAll(async () => {
  for (const d of [ws, home, join(desktopConfig, '..')]) mkdirSync(d, { recursive: true });
  process.env.RETAKE_HOME = retakeHome;
  await fixtureWorkspace(ws);
  // Claude Desktop's config with another server and a retake entry whose words are markup (shown as text).
  writeFileSync(desktopConfig, JSON.stringify({ theme: 'dark', mcpServers: { files: { command: 'x' }, retake: { command: 'node', args: ['<b>old</b>\u202ebin.js'] } } }));
  ctx = machine();
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false, setup: () => ctx });
  studio.desktop.attach((l) => (lines.push(l), true));
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  rmSync(base, { recursive: true, force: true });
});

describe('the Set-up sheet', () => {
  it('opens by itself at the first start; its a11y tour in dark and light, the walk inside the modal', async () => {
    const p = await open(true);
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    expect(await sheet(p).locator('h2').first().innerText()).toBe('Set up Retake');
    // Review c A-L6: the focus starts on the sheet's title (its top in view), never on Done below the fold; Return
    // there chooses nothing.
    await expect.poll(() => focused(p), POLL).toBe('h2:Set up Retake');
    expect(await sheet(p).evaluate((d) => d.scrollTop)).toBe(0);
    // Review c A-L8: the Claude Desktop step below the fold — the process list is not read (the polls skip it).
    expect(await sheet(p).getByTestId('setup-claude-desktop').evaluate((el) => el.getBoundingClientRect().top > window.innerHeight)).toBe(true);
    await p.waitForTimeout(2500);
    expect(psCalls).toBe(0);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(300);
    expect(await isOpen(p)).toBe(true);
    expect(await sheet(p).locator('.k-check-title').allInnerTexts()).toEqual(['Workspace', 'Retake home', 'Command line', 'Claude Code', 'Claude Desktop', 'Notifications', 'Screen recording', 'Local network']);
    expect(await sheet(p).getByTestId('setup-screen').innerText()).toContain('Captures are headless');
    const r = await station(tour(p), 'setup-sheet', async () => {
      await sheet(p).locator('[data-testid="setup-claude-desktop"] .k-check-word').waitFor(POLL);
    }, { schemes: SCHEMES, walkMax: 60 });
    expect(r.findings, r.report).toEqual([]);
    // The top of the sheet in both appearances (the tour's own shots end where its Tab walk left the focus).
    if (process.env.RETAKE_UI_SHOTS) {
      for (const scheme of ['dark', 'light'] as const) {
        await p.emulateMedia({ colorScheme: scheme });
        await sheet(p).evaluate((x) => (x.scrollTop = 0));
        await p.screenshot({ path: join(process.env.RETAKE_UI_SHOTS, `setup-sheet-top-${scheme}.png`) });
      }
      await p.emulateMedia({ colorScheme: 'dark' });
    }
    // Nothing happened without a click.
    expect(existsSync(join(home, '.local'))).toBe(false);
    expect(lines).toEqual([]);
    // Escape closes it without remembering it (no visible choice was made): the next start opens it again.
    await p.keyboard.press('Escape');
    await expect.poll(() => isOpen(p), POLL).toBe(false);
    await p.waitForTimeout(300);
    expect(readAppSettings(retakeHome).setup_seen).toBeUndefined();
    await p.close();
    const again = await open(true);
    await expect.poll(() => isOpen(again), POLL).toBe(true);
    await again.close();
  }, 120_000);

  it('Install retake, Add to Claude Desktop… (its confirmation), Run with Claude Code — other programs\' words as text; Done remembers', async () => {
    const p = await open(true);
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    const d = sheet(p);
    // The command.
    await d.getByTestId('setup-cli-install').click();
    await expect.poll(() => d.getByTestId('setup-cli').locator('.k-check-word').innerText(), POLL).toBe('Installed');
    expect(readlinkSync(join(home, '.local', 'bin', 'retake'))).toBe(join(app.root, 'bin', 'retake'));
    expect(await d.getByTestId('setup-cli').innerText()).toContain('export PATH="$HOME/.local/bin:$PATH"');
    // Claude Desktop: the entry there now is text (markup and a direction override not rendered); Replace… confirms.
    const desk = d.getByTestId('setup-claude-desktop');
    expect(await desk.locator('.k-check-word').innerText()).toBe('Conflict: another entry');
    expect(await desk.innerText()).toContain('<b>old</b>');
    expect(await desk.locator('b').count()).toBe(0);
    // Review c A-M2: the confirmation takes the focus on its button; Cancel gives it back to Replace….
    await desk.getByTestId('setup-claude-desktop-add').click();
    await expect.poll(() => focused(p), POLL).toBe('setup-claude-desktop-confirm');
    await desk.getByTestId('setup-claude-desktop-cancel').click();
    await expect.poll(() => focused(p), POLL).toBe('setup-claude-desktop-add');
    await p.keyboard.press('Enter');
    await expect.poll(() => focused(p), POLL).toBe('setup-claude-desktop-confirm');
    expect(JSON.parse(readFileSync(desktopConfig, 'utf8')).mcpServers.retake.command).toBe('node');
    await desk.getByTestId('setup-claude-desktop-confirm').click();
    await expect.poll(() => desk.locator('.k-check-word').innerText(), POLL).toBe('Added');
    // Its button gone (nothing left to do there): the focus is on the item's title, not lost to the page.
    await expect.poll(() => focused(p), POLL).toBe('h3:Claude Desktop');
    expect(await desk.getByTestId('setup-desktop-said').innerText()).toContain(join(retakeHome, 'backups', 'claude-desktop'));
    // Review c A-L8: the process list is read while this step is in view — at most every 5 s (polls run every 2 s).
    await desk.scrollIntoViewIfNeeded();
    const ps0 = psCalls;
    await p.waitForTimeout(6500);
    expect(psCalls - ps0).toBeGreaterThanOrEqual(1);
    expect(psCalls - ps0).toBeLessThanOrEqual(2);
    const written = JSON.parse(readFileSync(desktopConfig, 'utf8'));
    expect(written.theme).toBe('dark');
    expect(written.mcpServers.files).toEqual({ command: 'x' });
    expect(written.mcpServers.retake.command).toBe(app.paths.node);
    // Claude Code: off without claude; with a fake one, Run shows its output as text.
    expect(await d.getByTestId('setup-claude-code-run').isDisabled()).toBe(true);
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "<img src=x onerror=alert(1)> installed $1"\n');
    chmodSync(join(home, '.local', 'bin', 'claude'), 0o755);
    await expect.poll(() => d.getByTestId('setup-claude-code-run').isEnabled(), POLL).toBe(true);
    await d.getByTestId('setup-claude-code-run').click();
    const said = d.getByTestId('setup-claude-code-said');
    await said.waitFor(POLL);
    expect(await said.innerText()).toContain('Registered with Claude Code');
    expect(await said.innerText()).toContain('<img src=x onerror=alert(1)> installed plugin');
    expect(await d.locator('img').count()).toBe(0);
    // Review c A-L7: Choose a Folder… — the panel is said only once the shell says it opened; a cancel is said.
    await d.getByTestId('setup-cli-choose').click();
    await expect.poll(() => lines.at(-1), POLL).toBe('{"type":"setup","action":"cli_folder"}');
    await p.waitForTimeout(500);
    expect(await d.getByTestId('setup-cli-panel').count()).toBe(0);
    applyShellLine(studio.setup, ws, '{"type":"cli_folder_open"}');
    await expect.poll(() => d.getByTestId('setup-cli-panel').innerText().catch(() => ''), POLL).toContain('Choose the folder in the panel the app opened');
    applyShellLine(studio.setup, ws, '{"type":"cli_folder_cancelled"}');
    await expect.poll(() => d.getByTestId('setup-cli-panel').innerText().catch(() => ''), POLL).toContain('No folder was chosen');
    // Notifications: a pipe line for the shell.
    await d.getByTestId('setup-notifications-allow').click();
    await expect.poll(() => lines.at(-1), POLL).toBe('{"type":"setup","action":"notifications"}');
    // Done: closes, remembered.
    await d.getByTestId('setup-done').click();
    await expect.poll(() => isOpen(p), POLL).toBe(false);
    await expect.poll(() => readAppSettings(retakeHome).setup_seen ?? null, POLL).not.toBeNull();
    await p.close();
    const again = await open(true);
    await again.waitForTimeout(800);
    expect(await isOpen(again)).toBe(false);
    // Help › Install the retake Command… (the shell's event with its section) opens it on the command; junk is ignored.
    await again.evaluate(() => window.dispatchEvent(new CustomEvent('studio:setup', { detail: { section: 'nope' } })));
    await again.evaluate(() => window.dispatchEvent(new CustomEvent('studio:setup', { detail: { section: 'cli', x: 1 } })));
    await again.waitForTimeout(300);
    expect(await isOpen(again)).toBe(false);
    await again.evaluate(() => window.dispatchEvent(new CustomEvent('studio:setup', { detail: { section: 'cli' } })));
    await expect.poll(() => isOpen(again), POLL).toBe(true);
    // Review c A-M2: Help › Uninstall the retake Command… — the focus on the confirmation's Uninstall (Return there
    // never installs or opens a panel); Keep it gives it back to Uninstall…; after the removal, the item's first action.
    await again.evaluate(() => window.dispatchEvent(new CustomEvent('studio:setup', { detail: { section: 'cli-remove' } })));
    await expect.poll(() => focused(again), POLL).toBe('setup-cli-remove-confirm');
    await sheet(again).getByTestId('setup-cli-remove-keep').click();
    await expect.poll(() => focused(again), POLL).toBe('setup-cli-remove');
    await again.keyboard.press('Enter');
    await expect.poll(() => focused(again), POLL).toBe('setup-cli-remove-confirm');
    await again.keyboard.press('Enter');
    await expect.poll(() => existsSync(join(home, '.local', 'bin', 'retake')), POLL).toBe(false);
    await expect.poll(() => focused(again), POLL).toBe('setup-cli-install');
    await again.keyboard.press('Escape');
    await expect.poll(() => isOpen(again), POLL).toBe(false);
    expect(errors).toEqual([]);
    await again.close();
  }, 120_000);

  it('critique H1: from a translocated copy — "Move Retake to Applications", the command and Claude off (its a11y tour)', async () => {
    ctx = machine({ bundle: moved });
    const p = await open(true, '#/setup');
    await expect.poll(() => isOpen(p), POLL).toBe(true);
    const d = sheet(p);
    await d.getByTestId('setup-location').waitFor(POLL);
    expect(await d.getByTestId('setup-location').innerText()).toContain('Move Retake to Applications, then open it again');
    expect(await d.getByTestId('setup-cli').locator('.k-check-word').innerText()).toBe('Blocked: move the app first');
    for (const id of ['setup-cli-install', 'setup-cli-choose', 'setup-claude-code-run', 'setup-claude-desktop-add']) {
      if (await d.getByTestId(id).count()) expect(await d.getByTestId(id).isDisabled(), id).toBe(true);
    }
    const r = await station(tour(p), 'setup-sheet-moved', async () => undefined, { schemes: SCHEMES, walkMax: 60, exemptMax: 20 });
    expect(r.findings, r.report).toEqual([]);
    await d.getByTestId('setup-done').click();
    await expect.poll(() => p.evaluate(() => location.hash), POLL).toBe('#/');
    ctx = machine();
    await p.close();
  }, 120_000);

  it('a browser tab (no app flag) has no Set-up sheet, even at #/setup', async () => {
    const p = await open(false, '#/setup');
    await p.waitForTimeout(500);
    expect(await sheet(p).count()).toBe(0);
    await p.close();
  });
});
