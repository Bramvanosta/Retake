/**
 * L5.2b (critique M6) — the page's unsaved-text report end to end in headless Chromium against an in-process Studio
 * server: typing in the README editor puts `readme:<project>` on the server's board within a second, typed fields of a
 * step form put a `step_form` item, saving or clearing takes them off, and a reload clears the old tab session
 * (its `pagehide` report, sent with keepalive) — the board never keeps a tab that is gone. Kinds and names only reach
 * the server: the request bodies are checked for the typed text. (WebKit's visibility change on a hidden window is
 * MACOS-CHECKLIST 14a; the comments composer's mark is the same hook, checked in studio-e2e-comments.) Review B L7: the
 * Library's "create a component" words, a changed new-theme form and a theme editor's colour draft report too.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { BLOCKS_YAML, capture, writeRun } from '../../engine/test/synthetic-runs.js';

const POLL = { timeout: 15_000 };
const P = 'northfield-fixture';
const TYPED = 'Words typed into the README that never leave the tab';
const FORMS = `video: forms
scenes:
  - id: a
    page: console
    open: /
    steps:
      - click: First
      - type: {into: {label: Message}, text: "Light roast", cps: 18}
`;

let ws: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const bodies: string[] = [];
const savedHome = process.env.DEMO_STUDIO_HOME;
const board = () => studio.unsaved.items();

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-unsaved-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  // Its own templates folder (the starters stay starters): the theme editor's case copies one.
  await writeFile(join(ws, 'studio.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(ws, 'templates'));
  await writeFile(join(ws, 'projects', P, 'scenarios', 'forms.yaml'), FORMS);
  await writeFile(join(ws, 'projects', P, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
  await writeRun(join(ws, 'projects', P), capture('20261020-100000-blocks', { video: false }));
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  page = await context.newPage();
  page.on('dialog', (d) => void d.accept());
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/call/unsaved_report')) bodies.push(r.postData() ?? '');
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 1, name: 'Projects' }).waitFor(POLL);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the unsaved-text report (L5.2b, M6)', () => {
  it('nothing typed: no report at all', async () => {
    await page.goto(`${studio.url}#/p/${P}/readme`);
    await page.getByRole('heading', { level: 1, name: 'README.md' }).waitFor(POLL);
    await new Promise((r) => setTimeout(r, 500));
    expect(bodies).toEqual([]);
    expect(board()).toEqual([]);
  });

  it('typing in the README editor puts it on the board within a second; deleting the typing takes it off', async () => {
    const t0 = Date.now();
    await page.locator('#readme-text').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(TYPED.slice(0, 5));
    await expect.poll(() => board(), POLL).toEqual([{ kind: 'readme', project: P }]);
    expect(Date.now() - t0).toBeLessThan(3000);
    await page.keyboard.type(TYPED.slice(5));
    for (let i = 0; i < TYPED.length; i++) await page.keyboard.press('Backspace');
    await expect.poll(() => board(), POLL).toEqual([]);
    for (const b of bodies) expect(b).not.toContain(TYPED.slice(0, 5));
    expect(bodies.every((b) => /^\{"tab":"[A-Za-z0-9_-]{22}","hidden":(true|false),"items":\[.*\]\}$/.test(b))).toBe(true);
  });

  it("a step form's typed fields put a step_form item; a reload clears the old tab session (pagehide, keepalive)", async () => {
    await page.goto(`${studio.url}#/p/${P}/s/forms`);
    await page.getByTestId('blocks').waitFor(POLL);
    await page.locator('[data-testid="step"][data-key="a.1"]').click();
    await page.getByTestId('step-form').waitFor(POLL);
    await page.getByTestId('step-form').locator('[data-field="type.text"]').fill('Dark roast');
    await expect.poll(() => board(), POLL).toEqual([{ kind: 'step_form', project: P, scenario: 'forms' }]);
    // Also a README draft, from the same tab.
    await page.goto(`${studio.url}#/p/${P}/readme`);
    await page.getByRole('heading', { level: 1, name: 'README.md' }).waitFor(POLL);
    await page.locator('#readme-text').click();
    await page.keyboard.type('x');
    await expect.poll(() => board(), POLL).toEqual([{ kind: 'readme', project: P }]);
    expect(studio.unsaved.tabCount).toBe(1);
    // Reload (the beforeunload prompt for the README draft is accepted): the old session's pagehide report clears it.
    await page.reload();
    await page.getByRole('heading', { level: 1 }).waitFor(POLL);
    await expect.poll(() => studio.unsaved.tabCount, POLL).toBe(0);
    expect(board()).toEqual([]);
    expect(bodies.at(-1)).toMatch(/"hidden":true,"items":\[\]\}$/);
  });

  it('review B L7: the Library component words, a changed new-theme form and a colour draft are named; leaving each clears it', async () => {
    await page.goto(`${studio.url}#/p/${P}/library`);
    await page.getByTestId('lib-create-open').click();
    await page.getByTestId('lib-create-words').fill('A split intro with the logo left');
    await expect.poll(() => board(), POLL).toEqual([{ kind: 'component_brief', project: P }]);
    await page.getByTestId('lib-create-words').fill('');
    await expect.poll(() => board(), POLL).toEqual([]);
    await page.goto(`${studio.url}#/p/${P}/themes`);
    await page.getByTestId('theme-new-open').click();
    await page.getByTestId('new-brand-name').fill('Northfield');
    await expect.poll(() => board(), POLL).toEqual([{ kind: 'new_theme', project: P }]);
    // An editable theme (a copy of a starter), its accent picked and not released: a draft not written yet.
    const auth = { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json', origin: studio.url.replace(/\/$/, '') };
    const copied = await fetch(`${studio.url}v1/call/theme_copy`, { method: 'POST', headers: auth, body: JSON.stringify({ from: 'editorial', name: 'unsaved-copy' }) });
    expect(copied.status).toBe(200);
    await page.goto(`${studio.url}#/p/${P}/themes/unsaved-copy`);
    await expect.poll(() => page.getByTestId('theme-editor').getAttribute('data-editable'), POLL).toBe('yes');
    await expect.poll(() => board(), POLL).toEqual([]);
    // React's onChange is the input event (each move of the picker); the write is the native change, never sent here.
    await page.getByTestId('color-accent-picker').evaluate((el: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '#123456');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(() => board(), POLL).toEqual([{ kind: 'theme_draft', project: P }]);
    await page.goto(`${studio.url}#/p/${P}/readme`);
    await expect.poll(() => board(), POLL).toEqual([]);
    for (const b of bodies) expect(b).not.toMatch(/split intro|#123456/);
  });
});
