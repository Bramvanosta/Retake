/**
 * L4.7 part D2: the theme screens end to end in headless Chromium, against a real Studio server and its player origin
 * (no worker), on a scratch workspace whose templates_dir is its own folder (the starters stay starters) with the
 * fixture project (theme: editorial), a workspace intro component, brand files and a seeded site extraction:
 * - the list: ⚑ starters read-only by real path with why and Copy to edit; the project's theme; the site panel's page
 *   text (an HTML title with a direction override) shown literally — no element built from it, no dialog;
 * - a starter opens read-only (every control off) → Copy to edit → the copy's editor (editable);
 * - the live frame: the intro settles; a background switched to solid in one write (type and colour together);
 *   ⚑ a colour dragged → previews at most five a second, the frame's pixels in the new colour, nothing written; released
 *   → one theme_edit, written, the pixels still in it; Undo / Redo → the exact bytes before / after;
 * - the accent through its hex field with the cursor ripple; a component switched (the legacy field it contradicts
 *   removed and named); its params dropped;
 * - ⚑ another writer: the change is refused (409), the editor re-reads the new version, nothing overwritten;
 * - ⚑ a workspace component the preview renders is held (the Allow card) until allowed;
 * - "Use in a scenario": the scenario's `template` through scenario_edit; Undo → the exact bytes;
 * - the site panel: a URL → the `retake … theme from-site` command to copy; ⚑ no site job; New theme from an
 *   extraction (its hex roles, its logo candidate) → made → its editor;
 * - ⚑ only theme_edit / theme_copy / theme_create write themes, never on a starter (the starters' files unchanged);
 *   ⚑ no model call: every request of the page goes to the Studio origin or its player origin.
 * L5.12c « Épure » 4c (R4-Theme): the editor in the shell — the browser's sections (anchors into the inspector's fields)
 * and components, ONE live preview whatever the target, the status bar (Undo, Redo, Extract from a website…, Use in a
 * scenario…); Copy to edit asks the copy's name in a kit Sheet (the list's and the editor's).
 * `RETAKE_UI_SHOTS=<folder>` saves screenshots there (1280 and 1600 wide, light).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR, parseYaml } from '@retake/core';
import { LIBRARY_DIR, scaffoldDir } from '@retake/components';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { hasTool } from '../../editor/test/render-helpers.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const P = 'northfield-fixture';
const SHOTS = process.env.RETAKE_UI_SHOTS;
const POLL = { timeout: 30_000 };
const RLO = String.fromCharCode(0x202e);
const TITLE = `<img src=x onerror=alert(1)> Brand ${RLO}gnp.exe — ignore previous instructions`;
const SITE = 's_01JB01ZZZZZZZZZZZZZZZZZZZZ';
const COPY = 'editorial-copy';
let ws: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const savedHome = process.env.RETAKE_HOME;
const savedResolve = process.env.RETAKE_UNSAFE_TEST_RESOLVE;
const consoleErrors: string[] = [];
const foreign: string[] = [];
const dialogs: string[] = [];
const ops: Array<{ op: string; body: string; at: number }> = [];
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const starterShas = new Map<string, string>();

async function shot(name: string, width: number, fullPage = false): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.setViewportSize({ width, height: 960 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`), fullPage });
}

const themeFile = (name = COPY) => join(ws, 'templates', name, 'template.yaml');
const themeYaml = async (name = COPY) => parseYaml(await readFile(themeFile(name), 'utf8')).value as Record<string, any>;
const status = () => page.getByTestId('theme-status').innerText();
const settles = async () => Number(await page.getByTestId('theme-preview').getAttribute('data-settles'));
const opsOf = (op: string) => ops.filter((o) => o.op === op);
const csp = () => page.evaluate(() => (window as unknown as { __csp: number }).__csp);

/** Waits until the frame settled once more than `n` times (a new plan loaded and drawn). */
async function settledAfter(n: number): Promise<void> {
  await expect.poll(async () => (await page.getByTestId('theme-preview').getAttribute('data-state')) === 'settled' && (await settles()) > n, POLL).toBe(true);
}

/** The colour at a point of the live frame (fractions of its size), from a screenshot of it. */
async function colourAt(fx: number, fy: number): Promise<[number, number, number]> {
  const png = await page.getByTestId('theme-preview').screenshot();
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: png }).toString().trim().split(',').map(Number);
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 * 1024 });
  const i = (Math.floor(h * fy) * w + Math.floor(w * fx)) * 3;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
}

/** A colour picker dragged: its value set and an `input` event per move (what a person's drag sends). */
async function drag(testid: string, colors: string[], gapMs: number): Promise<void> {
  await page.getByTestId(testid).evaluate(
    async (el, a) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      for (const c of a.colors) {
        set.call(el, c);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, a.gapMs));
      }
    },
    { colors, gapMs },
  );
}
const release = (testid: string) => page.getByTestId(testid).evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-themes-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  // The extraction's host (a reserved name, as every test host) is taken as a site name here only.
  process.env.RETAKE_UNSAFE_TEST_RESOLVE = 'brand.test=127.0.0.1:9';
  await fixtureWorkspace(ws);
  await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(ws, 'templates'));
  await mkdir(join(ws, 'brand'));
  const png = await readFile(join(LIBRARY_DIR, 'studio', 'card-title', 'preview.png'));
  await writeFile(join(ws, 'brand', 'logo.png'), png);
  // A workspace intro (code an agent may have written): held in the preview until allowed.
  const comp = join(ws, 'components', 'acme', 'intro');
  await mkdir(comp, { recursive: true });
  await cp(scaffoldDir('intro'), comp, { recursive: true });
  await writeFile(join(comp, 'component.yaml'), (await readFile(join(comp, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/intro'));
  // A site extraction made by the CLI (no signed job): its page text is untrusted.
  const site = join(ws, '.retake', 'site', SITE);
  await mkdir(site, { recursive: true });
  await writeFile(join(site, 'logo-1.png'), png);
  await writeFile(
    join(site, 'site.json'),
    JSON.stringify({
      version: 1,
      url: 'https://brand.test/',
      host: 'brand.test',
      at: '2026-10-01T00:00:00.000Z',
      status: 'ok',
      http_status: 200,
      redirects: 0,
      palette: { roles: { paper: '#fbfaf7', text: '#1b1b1f', accent: '#0f6e5a', dark: null }, swatches: [] },
      candidates: [{ file: 'logo-1.png', source: 'header-img', width: 960, height: 540 }],
      screenshot: null,
      network: { requests: 1, blocked: {}, tunnels: 1, bytes: 10, refused: {}, capped: 0 },
      warnings: [],
      untrusted: { title: TITLE, site_name: 'Brand' },
    }),
  );
  for (const n of ['editorial', 'default', 'motion']) starterShas.set(n, sha(await readFile(join(STARTER_TEMPLATES_DIR, n, 'template.yaml'))));
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1280, height: 960 }, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: studio.url.replace(/\/$/, '') });
  await context.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const origins = new Set([new URL(studio.url).origin, studio.player.origin]);
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('data:') || u === 'about:blank') return;
    const url = new URL(u);
    if (!origins.has(url.origin)) foreign.push(u);
    const m = /^\/v1\/call\/([a-z_]+)$/.exec(url.pathname);
    if (m) ops.push({ op: m[1], body: r.postData() ?? '', at: Date.now() });
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (savedResolve === undefined) delete process.env.RETAKE_UNSAFE_TEST_RESOLVE;
  else process.env.RETAKE_UNSAFE_TEST_RESOLVE = savedResolve;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('the theme screens in Chromium', () => {
  it('⚑ the list: starters read-only with why and Copy to edit; the project\'s theme; the site panel\'s page text as text', async () => {
    await page.goto(`${studio.url}#/p/${P}`);
    await page.getByRole('link', { name: 'Themes', exact: true }).click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/themes`);
    await page.getByRole('heading', { level: 1, name: 'Themes' }).waitFor();
    expect(await page.title()).toBe('Themes · Retake');
    const row = page.locator('[data-testid="theme-row"][data-theme="editorial"]');
    await row.waitFor();
    expect(await row.getAttribute('data-editable')).toBe('no');
    expect(await row.getByTestId('theme-tag').allInnerTexts()).toEqual(expect.arrayContaining(['Starter', "The project's theme", 'Read-only']));
    expect(await row.getByTestId('theme-row-why').innerText()).toMatch(/starter theme shipped with Retake: copy it to edit it/);
    expect(await row.getByTestId('theme-row-copy').isVisible()).toBe(true);
    // The site panel: the page's title shown literally, its override as a visible mark; nothing built from it.
    const site = page.locator(`[data-testid="site-row"][data-site="${SITE}"]`);
    await site.waitFor();
    expect(await site.getByTestId('site-title').innerText()).toBe(`Page title (as the page wrote it): ${TITLE.replace(RLO, '[U+202E]')}`);
    expect(await page.locator('main img, main b, img[onerror]').count()).toBe(0);
    expect(dialogs).toEqual([]);
    await shot('themes-list', 1280);
    await shot('themes-list', 1600);
    await page.setViewportSize({ width: 1280, height: 960 });
  });

  it('⚑ a starter opens read-only (every control off); Copy to edit → the copy\'s editor, editable', async () => {
    await page.locator('[data-testid="theme-row"][data-theme="editorial"]').getByTestId('theme-open').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/themes/editorial`);
    const ed = page.getByTestId('theme-editor');
    await ed.waitFor();
    expect(await ed.getAttribute('data-editable')).toBe('no');
    expect(await page.title()).toBe('editorial · Themes · Retake');
    expect(await page.getByTestId('theme-readonly-why').innerText()).toMatch(/copy it to edit it/);
    for (const id of ['color-accent-picker', 'color-accent-hex', 'background-type', 'font-display', 'text-brand.name']) expect(await page.getByTestId(id).isDisabled(), id).toBe(true);
    expect(await page.locator('[data-testid="theme-fields"] select:not([disabled]), [data-testid="theme-fields"] input:not([disabled])').count()).toBe(0);
    // (L5.12c: the fields' chips stay focusable, each aria-disabled with the group's.)
    expect(await page.locator('[data-testid="theme-fields"] [role="radio"]:not([aria-disabled="true"])').count()).toBe(0);
    expect(opsOf('theme_edit')).toHaveLength(0);
    // Review B L2: every control of the editor has a name (the Default zoom select was the one without).
    expect(await page.getByRole('combobox', { name: 'Default zoom', exact: true }).count()).toBe(1);
    const unnamed = await page.locator('[data-testid="theme-editor"] :is(select, input, button), [data-testid="theme-fields"] :is(select, input, button)').evaluateAll((els) =>
      els.filter((e) => !(e as HTMLElement).closest('[hidden]') && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !(e as HTMLInputElement).labels?.length && !(e.textContent ?? '').trim() && (e as HTMLInputElement).type !== 'hidden').map((e) => e.outerHTML.slice(0, 80)),
    );
    expect(unnamed).toEqual([]);
    // L5.12c: Copy to edit… asks the copy's name in a kit Sheet.
    await page.getByTestId('theme-copy-open').click();
    await page.locator('[data-testid="theme-copy-sheet"][open]').waitFor();
    expect(await page.getByTestId('theme-copy-name').inputValue()).toBe(COPY);
    await page.getByTestId('theme-copy').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/themes/${COPY}`);
    await expect.poll(() => page.getByTestId('theme-editor').getAttribute('data-editable'), POLL).toBe('yes');
    expect(await page.getByTestId('color-accent-picker').isDisabled()).toBe(false);
    expect((await themeYaml()).name).toBe(COPY);
  });

  it('the live frame: the intro settles; a background switched to solid in one write; ⚑ a colour dragged → ≤ 5 previews a second, its pixels, nothing written; released → written; Undo / Redo exact', async () => {
    await settledAfter(0);
    // The background type: type and colour in one write.
    const n0 = await settles();
    await page.getByTestId('background-type').selectOption('solid');
    await expect.poll(status, POLL).toMatch(/^Set the background to solid #f8f4ef/);
    expect((await themeYaml()).background).toEqual({ type: 'solid', color: '#f8f4ef' });
    expect(JSON.parse(opsOf('theme_edit').at(-1)!.body)).toMatchObject({ theme: COPY, edit: { kind: 'set_background', from: { type: 'radial', from: '#f8f4ef', to: '#ebe4dc' }, to: { type: 'solid', color: '#f8f4ef' } } });
    await settledAfter(n0);
    const beforeDrag = await readFile(themeFile());
    // A drag of one second, a move every 20 ms, ending on green.
    const moves = Array.from({ length: 50 }, (_, i) => `#00${(0x40 + i * 2).toString(16).padStart(2, '0')}00`);
    moves.push('#00c000');
    const writesBefore = opsOf('theme_edit').length;
    const t0 = Date.now();
    await drag('background-color-picker', moves, 20);
    const t1 = Date.now();
    const n1 = await settles();
    await expect.poll(() => page.getByTestId('background').innerText(), POLL).toMatch(/previewing #00c000/);
    await page.waitForTimeout(400);
    const drafts = ops.filter((o) => o.op === 'theme_preview' && o.at >= t0 && o.body.includes('"draft"'));
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.length).toBeLessThanOrEqual(Math.ceil((t1 - t0 + 400) / 200) + 1);
    // Seen from the test process (event delivery adds jitter under load — 96 ms seen in a full run): spaced, never a burst
    // of the drag's 20 ms moves (the 200 ms rule itself: theme-app.test).
    for (let i = 1; i < drafts.length; i++) expect(drafts[i].at - drafts[i - 1].at).toBeGreaterThanOrEqual(50);
    expect(JSON.parse(drafts.at(-1)!.body).draft).toEqual({ background: { type: 'solid', color: '#00c000' } });
    await settledAfter(n1 - 1);
    await expect.poll(async () => (await colourAt(0.03, 0.05))[1], POLL).toBeGreaterThan(150);
    const [r, , b] = await colourAt(0.03, 0.05);
    expect(r).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    // Nothing written while dragging.
    expect(opsOf('theme_edit').length).toBe(writesBefore);
    expect(Buffer.compare(await readFile(themeFile()), beforeDrag)).toBe(0);
    await shot('theme-editor-draft', 1280);
    await shot('theme-editor-draft', 1600);
    await page.setViewportSize({ width: 1280, height: 960 });
    // Released: one write, then the written theme previewed (still green).
    const n2 = await settles();
    await release('background-color-picker');
    await expect.poll(status, POLL).toMatch(/^Set the background colour|^Set background\.color|#00c000/);
    expect(opsOf('theme_edit').length).toBe(writesBefore + 1);
    expect(JSON.parse(opsOf('theme_edit').at(-1)!.body)).toMatchObject({ edit: { kind: 'set_field', field: 'background.color', from: '#f8f4ef', to: '#00c000' } });
    expect((await themeYaml()).background).toEqual({ type: 'solid', color: '#00c000' });
    const afterDrag = await readFile(themeFile());
    await settledAfter(n2);
    expect((await colourAt(0.03, 0.05))[1]).toBeGreaterThan(150);
    // Undo → the exact bytes before; Redo → the exact bytes after.
    await page.getByTestId('theme-undo').click();
    await expect.poll(async () => Buffer.compare(await readFile(themeFile()), beforeDrag), POLL).toBe(0);
    await expect.poll(status, POLL).toMatch(/^Undone: /);
    expect(JSON.parse(opsOf('theme_edit').at(-1)!.body).edit).toEqual({ kind: 'restore', text: beforeDrag.toString('utf8'), text_hash: sha(beforeDrag) });
    await expect.poll(() => page.getByTestId('theme-redo').isDisabled(), POLL).toBe(false);
    await page.getByTestId('theme-redo').click();
    await expect.poll(async () => Buffer.compare(await readFile(themeFile()), afterDrag), POLL).toBe(0);
    expect(await csp()).toBe(0);
  }, 120_000);

  it('the accent through its hex field with the cursor ripple; a component switched, the legacy field it contradicts removed and named; its params dropped', async () => {
    await expect.poll(() => page.getByTestId('color-accent-hex').isDisabled(), POLL).toBe(false);
    await page.getByTestId('color-accent-hex').fill('#225588');
    await page.getByTestId('color-accent-hex').press('Enter');
    await expect.poll(async () => (await themeYaml()).colors.accent, POLL).toBe('#225588');
    expect((await themeYaml()).cursor.ripple_color).toBe('rgba(34, 85, 136, 0.45)');
    await expect.poll(() => page.locator('[data-testid="palette"] li[data-check="accent_on_paper"]').innerText(), POLL).toMatch(/Accent on paper: \d+\.\d\d:1/);
    // A cut instead of the crossfade: `transitions.between_scenes` contradicted it — removed by the same write, named.
    await expect.poll(() => page.locator('[data-testid="component-transition"] select').isDisabled(), POLL).toBe(false);
    await page.locator('[data-testid="component-transition"] select').selectOption('');
    await expect.poll(status, POLL).toMatch(/removed .*transitions/);
    const y = await themeYaml();
    expect(y.components.transition).toBeNull();
    expect(y.transitions?.between_scenes).toBeUndefined();
    // The layout's params are dropped by default (keep is the other choice).
    await expect.poll(() => page.locator('[data-testid="component-layout"] select').isDisabled(), POLL).toBe(false);
    expect(await page.getByTestId('component-layout').innerText()).toMatch(/Its params \(width, radius, shadow\)/);
    await page.locator('[data-testid="component-layout"] select').selectOption('studio/layout-browser');
    await expect.poll(async () => (await themeYaml()).components.layout, POLL).toBe('studio/layout-browser');
    expect(JSON.parse(opsOf('theme_edit').at(-1)!.body).edit).toEqual({ kind: 'set_component', component: 'layout', from: 'studio/layout-card', id: 'studio/layout-browser', params: 'drop' });
  });

  it('⚑ another writer: the change is refused (409), the editor re-reads the new version, nothing overwritten', async () => {
    await expect.poll(() => page.getByTestId('text-brand.name').isDisabled(), POLL).toBe(false);
    // The other writer changes another field (the brand URL): the version, not the value, refuses the change.
    const outside = (await readFile(themeFile(), 'utf8')).replace('brand: {name: Atelier, url: example.com}', 'brand: {name: Atelier, url: outside.example}');
    expect(outside).toContain('outside.example');
    await writeFile(themeFile(), outside);
    await page.getByTestId('text-brand.name').fill('Inside');
    await page.getByTestId('text-brand.name').press('Enter');
    await expect.poll(status, POLL).toMatch(/The theme changed meanwhile .*your change was not written/);
    expect(await readFile(themeFile(), 'utf8')).toBe(outside);
    await expect.poll(() => page.getByTestId('text-brand.url').inputValue(), POLL).toBe('outside.example');
    expect(await page.getByTestId('text-brand.name').inputValue()).toBe('Atelier');
    // The history was another version's: nothing to undo over the other writer's bytes.
    expect(await page.getByTestId('theme-undo').isDisabled()).toBe(true);
  });

  it('⚑ L5.12c fixes (review A-M1): a colour refused by a 409 is never written when its hex field is left — the field shows the written value of the new version', async () => {
    await expect.poll(() => page.getByTestId('color-accent-hex').isDisabled(), POLL).toBe(false);
    const accent = (await themeYaml()).colors.accent as string;
    expect(await page.getByTestId('color-accent-hex').inputValue()).toBe(accent);
    // Someone else writes another field (the brand URL) while the edit is in flight: the server refuses it (409).
    let held = 0;
    await page.route('**/v1/call/theme_edit', async (route) => {
      if (held++ === 0) await writeFile(themeFile(), (await readFile(themeFile(), 'utf8')).replace(/url: [a-z.]+example(\.com)?}/, 'url: second.example}'));
      await route.continue();
    });
    try {
      const before = opsOf('theme_edit').length;
      await page.getByTestId('color-accent-hex').fill('#123456');
      await page.getByTestId('color-accent-hex').press('Enter');
      await expect.poll(status, POLL).toMatch(/The theme changed meanwhile .*your change was not written/);
      expect(opsOf('theme_edit').length).toBe(before + 1);
      const outside = await readFile(themeFile(), 'utf8');
      expect(outside).toContain('second.example');
      // The new version shown: the field holds what is written (the same accent), not the refused text.
      await expect.poll(() => page.getByTestId('color-accent-hex').inputValue(), POLL).toBe(accent);
      // Leaving the field (a keyboard user tabbing through the inspector) writes nothing.
      await page.getByTestId('color-accent-hex').focus();
      await page.keyboard.press('Tab');
      await page.waitForTimeout(500);
      expect(opsOf('theme_edit').length).toBe(before + 1);
      expect(await readFile(themeFile(), 'utf8')).toBe(outside);
      expect((await themeYaml()).colors.accent).toBe(accent);
    } finally {
      await page.unroute('**/v1/call/theme_edit');
    }
  });

  it('⚑ L5.12c fixes (review A-L4): a colour drag renders the dragged field (and the frame), not the editor — about one commit per move, no other colour field, section or component pick rendered', async () => {
    // React's DevTools hook (before the bundle loads again): commits, and the fields whose props changed.
    await context.addInitScript(() => {
      const w = window as unknown as { __commits: number; __fields: string[]; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
      w.__commits = 0;
      w.__fields = [];
      type Fiber = { child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps: unknown; type: unknown };
      const seen = new WeakMap<Fiber, unknown>();
      const what = (p: Record<string, unknown>): string | null => {
        if (typeof p.testId === 'string' && p.testId.startsWith('color-') && 'picker' in p) return p.testId;
        if ('choices' in p && typeof p.kind === 'string') return `pick:${p.kind}`;
        if (typeof p.k === 'string' && 'title' in p && p.k !== 'colours') return `section:${p.k}`;
        return null;
      };
      const visit = (f: Fiber | null) => {
        for (let n = f; n; n = n.sibling) {
          const p = n.memoizedProps as Record<string, unknown> | null;
          const name = typeof n.type === 'function' && p && typeof p === 'object' ? what(p) : null;
          if (name) {
            const last = seen.has(n) ? seen.get(n) : n.alternate ? seen.get(n.alternate) : undefined;
            if (last !== undefined && last !== n.memoizedProps) w.__fields.push(name);
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
        onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
          w.__commits++;
          visit(root.current);
        },
      };
    });
    await page.reload();
    await page.locator('[data-testid="theme-editor"][data-editable="yes"]').waitFor(POLL);
    await settledAfter(0);
    await expect.poll(() => page.getByTestId('color-muted-picker').isDisabled(), POLL).toBe(false);
    await page.waitForTimeout(800);
    // The previews held (their answers would load the frame: not the fields' renders): the drag's own commits only.
    const pending: Array<() => Promise<void>> = [];
    await page.route('**/v1/call/theme_preview', (route) => void pending.push(() => route.continue()));
    try {
      await page.evaluate(() => {
        const w = window as unknown as { __commits: number; __fields: string[] };
        w.__commits = 0;
        w.__fields = [];
      });
      const moves = Array.from({ length: 30 }, (_, i) => `#${(0x30 + i * 3).toString(16).padStart(2, '0')}4060`);
      await drag('color-muted-picker', moves, 15);
      await expect.poll(() => page.getByTestId('color-muted').innerText(), POLL).toContain(`previewing ${moves.at(-1)}`);
      const got = await page.evaluate(() => {
        const w = window as unknown as { __commits: number; __fields: string[] };
        return { commits: w.__commits, fields: [...new Set(w.__fields)].sort(), muted: w.__fields.filter((f) => f === 'color-muted').length };
      });
      console.log(`colour drag: ${moves.length} moves, ${got.commits} commits, rendered ${got.fields.join(', ')}`);
      expect(got.fields).toEqual(['color-muted']);
      expect(got.muted).toBeLessThanOrEqual(moves.length + 1);
      expect(got.commits).toBeLessThanOrEqual(moves.length + 3);
    } finally {
      await page.unroute('**/v1/call/theme_preview');
      for (const go of pending) await go().catch(() => undefined);
    }
    // Nothing written: the draft dropped with a reload.
    await page.reload();
    await page.locator('[data-testid="theme-editor"][data-editable="yes"]').waitFor(POLL);
  });

  it('⚑ a workspace component the preview renders is held (the Allow card) until allowed', async () => {
    // (L5.12c: the target is the kit's segmented control: its radio covers its label.)
    await page.getByTestId('chips-target').getByRole('radio', { name: 'Intro', exact: true }).check();
    await expect.poll(() => page.locator('[data-testid="component-intro"] select').isDisabled(), POLL).toBe(false);
    await page.locator('[data-testid="component-intro"] select').selectOption('acme/intro');
    await expect.poll(async () => (await themeYaml()).components.intro, POLL).toBe('acme/intro');
    const held = page.locator('[data-testid="held-component"][data-id="acme/intro"]');
    await held.waitFor({ timeout: 30_000 });
    const preview = JSON.parse(ops.filter((o) => o.op === 'theme_preview').at(-1)!.body);
    expect(preview).toMatchObject({ project: P, theme: COPY, target: 'intro' });
    await held.getByTestId('allow-component').click();
    await expect.poll(() => page.getByTestId('preview-held').count(), POLL).toBe(0);
    await expect.poll(() => page.getByTestId('theme-preview').getAttribute('data-state'), POLL).toBe('settled');
    expect(opsOf('preview_allow')).toHaveLength(1);
  });

  it('Use in a scenario: the scenario\'s template through scenario_edit; Undo → the exact bytes', async () => {
    const file = join(ws, 'projects', P, 'scenarios', 'quote.yaml');
    const before = await readFile(file);
    await page.getByTestId('use-scenario').selectOption('quote');
    await page.getByTestId('use-in-scenario-go').click();
    await expect.poll(() => page.getByTestId('use-in-scenario-state').innerText(), POLL).toMatch(new RegExp(`Set the theme to ${COPY}`));
    expect((parseYaml(await readFile(file, 'utf8')).value as Record<string, unknown>).template).toBe(COPY);
    expect(JSON.parse(opsOf('scenario_edit').at(-1)!.body)).toMatchObject({ project: P, name: 'quote', edit: { kind: 'set_field', at: { entry: 'top' }, field: 'template', to: COPY } });
    expect(await page.getByTestId('use-in-scenario').innerText()).toMatch(/The cursor style is filmed/);
    await expect.poll(() => page.getByTestId('theme-used-by').innerText(), POLL).toBe('Used by 1 scenario');
    await shot('theme-editor', 1280, true);
    await shot('theme-editor', 1600, true);
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.getByTestId('use-in-scenario-undo').click();
    await expect.poll(async () => Buffer.compare(await readFile(file), before), POLL).toBe(0);
  });

  it('⚑ L5.12c: the editor in the shell — the browser\'s sections bring the inspector\'s fields, its components go to the library; one live preview whatever the target; the status bar\'s Use in a scenario… brings the scenario', async () => {
    const pane = page.getByRole('complementary', { name: 'Browser' });
    await pane.getByRole('button', { name: 'Colours', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-section')), POLL).toBe('colours');
    const inspector = (await page.getByRole('complementary', { name: 'Inspector' }).boundingBox())!;
    const section = (await page.locator('[data-section="colours"]').boundingBox())!;
    expect(section.y).toBeGreaterThanOrEqual(inspector.y - 1);
    expect(section.y).toBeLessThan(inspector.y + inspector.height);
    // The theme's components: each a link to its page in the library, in this theme.
    expect(await pane.locator(`a[href="#/p/${P}/library/${COPY}/studio/layout-browser"]`).count()).toBe(1);
    // One preview (critique M5: no grid of three): each target loads into the one frame.
    for (const t of ['Clip with caption', 'Outro', 'Intro']) {
      const n = await settles();
      await page.getByTestId('chips-target').getByRole('radio', { name: t, exact: true }).check();
      await settledAfter(n);
      expect(await page.locator('[data-testid="preview-frame"]').count()).toBe(1);
      expect(await page.getByTestId('theme-preview').count()).toBe(1);
    }
    // The status bar: Undo, Redo, Extract from a website… (the list's site panel), Use in a scenario… (its select).
    const bar = page.getByRole('region', { name: 'Status' });
    expect(await bar.getByTestId('theme-undo').count()).toBe(1);
    expect(await bar.getByTestId('theme-redo').count()).toBe(1);
    expect(await bar.getByRole('link', { name: 'Extract from a website…' }).getAttribute('href')).toBe(`#/p/${P}/themes`);
    await bar.getByRole('button', { name: 'Use in a scenario…' }).click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('use-scenario');
  });

  it('⚑ L5.12c: the list\'s Copy to edit… asks the name in a kit Sheet — Escape closes it, nothing copied', async () => {
    await page.goto(`${studio.url}#/p/${P}/themes`);
    const row = page.locator('[data-testid="theme-row"][data-theme="motion"]');
    await row.waitFor();
    const before = execFileSync('ls', [join(ws, 'templates')]).toString();
    await row.getByTestId('theme-row-copy').click();
    await page.locator('[data-testid="theme-row-copy-sheet"][open]').waitFor();
    expect(await page.getByTestId('theme-row-copy-name').inputValue()).toBe('motion-copy');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('theme-row-copy-yes');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('dialog[open]').count(), POLL).toBe(0);
    expect(execFileSync('ls', [join(ws, 'templates')]).toString()).toBe(before);
    expect(opsOf('theme_copy').filter((o) => JSON.parse(o.body).from === 'motion')).toHaveLength(0);
  });

  it('⚑ L5.12c fixes (review A-L2 / B-L2): Return in the copy\'s name field copies — the name as edited — and opens the copy', async () => {
    await page.goto(`${studio.url}#/p/${P}/themes`);
    const row = page.locator('[data-testid="theme-row"][data-theme="motion"]');
    await row.waitFor();
    await row.getByTestId('theme-row-copy').click();
    await page.locator('[data-testid="theme-row-copy-sheet"][open]').waitFor();
    await page.getByTestId('theme-row-copy-name').fill('motion-two');
    await page.getByTestId('theme-row-copy-name').press('Enter');
    await expect.poll(() => page.getByTestId('theme-editor').getAttribute('data-theme'), POLL).toBe('motion-two');
    expect(JSON.parse(opsOf('theme_copy').at(-1)!.body)).toEqual({ from: 'motion', name: 'motion-two' });
    expect(await page.locator('dialog[open]').count()).toBe(0);
  });

  it('⚑ L5.12c fixes (review B-M2): the New theme form takes each keystroke of a colour — a value that is not a hex stays and the form says why (nothing made); "Make the theme" follows the typed accent', async () => {
    await page.goto(`${studio.url}#/p/${P}/themes`);
    await page.locator(`[data-testid="site-row"][data-site="${SITE}"]`).getByTestId('site-new-theme').click();
    await page.getByTestId('theme-new').waitFor();
    await page.getByTestId('new-name').fill('typed-theme');
    const made = opsOf('theme_create').length;
    // A paper that is not a hex, the field left: it stays as typed and the form's line says why; nothing can be made.
    await page.getByTestId('new-paper-hex').fill('#12345');
    await page.keyboard.press('Tab');
    expect(await page.getByTestId('new-paper-hex').inputValue()).toBe('#12345');
    await expect.poll(() => page.getByTestId('new-problem').innerText(), POLL).toBe('The paper colour is a hex value: #rgb or #rrggbb.');
    expect(await page.getByTestId('new-create').isDisabled()).toBe(true);
    await page.getByTestId('new-paper-hex').fill('');
    // An accent typed, not yet left: each keystroke reaches the form (a half-typed one is said at once).
    await page.getByTestId('new-accent-hex').fill('#1a2b');
    await expect.poll(() => page.getByTestId('new-problem').innerText(), POLL).toBe('The accent colour is a hex value: #rgb or #rrggbb.');
    expect(await page.getByTestId('new-create').isDisabled()).toBe(true);
    await page.getByTestId('new-accent-hex').pressSequentially('3c');
    await expect.poll(() => page.getByTestId('new-create').isDisabled(), POLL).toBe(false);
    expect(await page.getByTestId('new-problem').innerText()).toBe('');
    await page.getByTestId('new-create').click();
    await page.getByTestId('theme-new-made').waitFor({ timeout: 30_000 });
    expect(opsOf('theme_create').length).toBe(made + 1);
    expect(JSON.parse(opsOf('theme_create').at(-1)!.body)).toMatchObject({ name: 'typed-theme', colors: { accent: '#1a2b3c', text: '#1b1b1f' } });
    expect(JSON.parse(opsOf('theme_create').at(-1)!.body).colors.paper).toBeUndefined();
    await page.getByTestId('theme-new-made').getByRole('button', { name: 'Close' }).click();
  });

  it('the site panel: a URL → the command to copy; ⚑ no site job; New theme from an extraction → made → its editor', async () => {
    await page.goto(`${studio.url}#/p/${P}/themes`);
    await page.getByTestId('site-url').fill('https://example.com/pricing');
    await page.getByTestId('site-command').click();
    await expect.poll(() => page.getByTestId('site-command-line').innerText(), POLL).toBe(`${studio.engine.cli} theme from-site https://example.com/pricing`);
    await page.getByTestId('site-command-copy').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), POLL).toBe(`${studio.engine.cli} theme from-site https://example.com/pricing`);
    await page.locator(`[data-testid="site-row"][data-site="${SITE}"]`).getByTestId('site-new-theme').click();
    const form = page.getByTestId('theme-new');
    await form.waitFor();
    expect(await page.getByTestId('new-name').inputValue()).toBe('site-theme');
    // (L5.12c: the kit's ColorField — the field `new-accent`, its hex `new-accent-hex`.)
    expect(await page.getByTestId('new-accent').count()).toBe(1);
    expect(await page.getByTestId('new-accent-hex').inputValue()).toBe('#0f6e5a');
    expect(await page.getByTestId('new-logo').inputValue()).toBe(`site:${SITE}/logo-1`);
    await shot('themes-site', 1280);
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.getByTestId('new-create').click();
    await page.getByTestId('theme-new-made').waitFor({ timeout: 30_000 });
    expect(JSON.parse(opsOf('theme_create').at(-1)!.body)).toEqual({ name: 'site-theme', base: 'editorial', colors: { accent: '#0f6e5a', text: '#1b1b1f', paper: '#fbfaf7' }, logo: `site:${SITE}/logo-1` });
    await page.getByTestId('theme-new-edit').click();
    await expect.poll(() => page.getByTestId('theme-editor').getAttribute('data-theme'), POLL).toBe('site-theme');
    expect(await page.getByTestId('theme-editor').getAttribute('data-editable')).toBe('yes');
    expect(await studio.engine.jobs.list({ kinds: ['site'] })).toEqual([]);
  }, 60_000);

  it('⚑ only theme_edit / theme_copy / theme_create wrote themes, never on a starter; no model call; no site op', async () => {
    const reads = new Set(['engine_info', 'auth_status', 'project_list', 'project_get', 'project_board', 'run_list', 'job_list', 'activity_list', 'projects_overview', 'search', 'theme_list', 'theme_view', 'theme_preview', 'timeline_leave', 'site_list', 'brand_files', 'scenario_blocks']);
    // L5.2b review B L7: a colour draft or a changed new-theme form reports unsaved text (kinds only; it writes no file).
    reads.add('unsaved_report');
    const writes = [...new Set(ops.map((o) => o.op))].filter((op) => !reads.has(op));
    expect(writes.sort()).toEqual(['preview_allow', 'scenario_edit', 'theme_copy', 'theme_create', 'theme_edit']);
    for (const o of opsOf('theme_edit')) expect(['editorial', 'default', 'motion']).not.toContain(JSON.parse(o.body).theme);
    for (const [n, h] of starterShas) expect(sha(await readFile(join(STARTER_TEMPLATES_DIR, n, 'template.yaml'))), n).toBe(h);
    expect(ops.some((o) => /site/.test(o.op) && o.op !== 'site_list')).toBe(false);
    expect(foreign).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
