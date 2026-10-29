/**
 * L4.2 part 3: the scenario screen end to end in headless Chromium (the installed build of playwright-core; nothing
 * downloaded), against a Studio server on a scratch workspace — the fixture project plus synthetic runs (solid-colour
 * frames and screenshots, one colour per step): the project page links a scenario → its blocks (scenes with page, URL,
 * caption, speed, layout, duration; steps with an action badge, a plain-words target, chips; the hooks strip; what
 * would stop a run from the Studio) → each step's picture read back pixel by pixel through a canvas (a data: URL) →
 * the picker swaps the pictures; a failed run says why later steps have none → the listbox keyboard pattern and the
 * inspector → "Show in YAML" → the events: a running run's progress is a run_status read, another scenario or another
 * run changes nothing, the file edited on disk is read again (a step inserted: the others keep their colours) →
 * hostile scenario and page text inert → a 1,200-step scenario under ≈ 5 s with strict request counts, its pictures
 * asked in batches of ≤ 24 for the rows on screen → the run actions (part 4): a blocked Capture is disabled with its
 * reason and command before any click (no request), Dry run calls scenario_run with the pinned arguments only, the
 * queued run's banner and Cancel (run_cancel), the cancelled run then in the picker. `DEMO_STUDIO_UI_SHOTS=<folder>`
 * saves screenshots there.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Request } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import { raw } from './http.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { BLOCKS_YAML, BLUE, CYAN, GREEN, GREY, MAGENTA, ORANGE, RED, YELLOW, capture, colourName, near, writeRun } from '../../engine/test/synthetic-runs.js';
import type { Rgb, SynthRun } from '../../engine/test/synthetic-runs.js';

const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const POLL = { timeout: 15_000 };
const P = 'northfield-fixture';
const CAPTURE = '20261020-100000-blocks';
const DRY = '20261019-100000-blocks';
const FAILED = '20261018-100000-blocks';
const RUNNING = '20261023-120000-blocks';
const LONG_SCENES = 12;
const LONG_PER = 100;
const PALETTE: Rgb[] = [RED, GREEN, BLUE, CYAN, YELLOW, MAGENTA, ORANGE, GREY];
const HOSTILE_YAML = [
  '# <script>window.__pwned="comment"</script>',
  'video: "<img src=x onerror=window.__pwned=1>"',
  'scenes:',
  '  - id: evil',
  '    page: shop',
  '    open: "javascript:window.__pwned=2"',
  '    caption: {kicker: "<b onmouseover=window.__pwned=3>", text: "‮gnp.exe <svg/onload=window.__pwned=4>"}',
  '    steps:',
  '      - click: "<img src=x onerror=window.__pwned=5> ‮txt.exe"',
  '      - type: {text: "<script>window.__pwned=6</script>", into: {label: "<iframe srcdoc=x>"}}',
  '',
].join('\n');

let ws: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const savedHome = process.env.DEMO_STUDIO_HOME;
const dialogs: string[] = [];
const consoleErrors: string[] = [];
/** Every call the page made: [op, time, body]. */
const requests: Array<{ op: string; at: number; body: Record<string, unknown> }> = [];
const project = () => join(ws, 'projects', P);

const ops = (op: string, since = 0) => requests.filter((r) => r.op === op && r.at >= since);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

const pwned = () => page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned ?? null);
const csp = () => page.evaluate(() => (window as unknown as { __csp: number }).__csp);

/** The centre pixel of every loaded thumbnail, by its row's step key (drawn on a canvas: data: URLs are same-origin). */
async function thumbColours(): Promise<Record<string, Rgb>> {
  return page.evaluate(() => {
    const out: Record<string, [number, number, number]> = {};
    for (const img of document.querySelectorAll<HTMLImageElement>('[data-testid="step"] img')) {
      const key = img.closest('[data-key]')?.getAttribute('data-key');
      if (!key || !img.complete || img.naturalWidth === 0) continue;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      out[key] = [d[0], d[1], d[2]];
    }
    return out;
  });
}

/** The rows' pictures load when they come on screen: the first wanted row is scrolled to the top, then the colours. */
async function expectColours(want: Record<string, Rgb>): Promise<void> {
  const first = Object.keys(want)[0];
  await page.locator(`[data-testid="step"][data-key="${first}"]`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect
    .poll(async () => {
      const got = await thumbColours();
      return Object.entries(want).map(([k, c]) => `${k}:${got[k] ? colourName(got[k]) : 'none'}${got[k] && !near(got[k], c, 40) ? '!' : ''}`);
    }, POLL)
    .toEqual(Object.entries(want).map(([k, c]) => `${k}:${colourName(c)}`));
}

const row = (key: string) => page.locator(`[data-testid="step"][data-key="${key}"]`);

function longYaml(): string {
  const lines = ['video: long', 'scenes:'];
  for (let s = 0; s < LONG_SCENES; s++) {
    lines.push(`  - id: s${s}`, ...(s === 0 ? ['    page: console', '    open: /'] : []), '    steps:');
    for (let i = 0; i < LONG_PER; i++) lines.push(`      - click: Button ${s}-${i}`);
  }
  return `${lines.join('\n')}\n`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-scenario-e2e-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  const dir = project();
  await writeFile(join(dir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
  // The default source: a capture with kept frames (RED, GREEN, GREEN, YELLOW, MAGENTA at the step ends).
  await writeRun(dir, capture(CAPTURE, { video: false }));
  // An older dry run: one screenshot per step, other colours.
  const ev = (scene: string, step: number, action: string, extra: Partial<NonNullable<SynthRun['events']>[number]> = {}) => ({ scene, step, action, t_start: 0, t_end: 0.5, ...extra });
  await writeRun(dir, {
    id: DRY, scenario: 'blocks', mode: 'dry', snapshot: BLOCKS_YAML,
    scenes: [{ id: 'one' }, { id: 'two' }],
    events: [ev('one', 0, 'click'), ev('one', 1, 'click'), ev('one', 2, 'hold'), ev('two', 0, 'click'), ev('two', 1, 'click')],
    screenshots: { 'one-00-click.png': ORANGE, 'one-01-click.png': BLUE, 'one-02-hold.png': CYAN, 'two-00-click.png': GREY, 'two-01-click.png': RED },
  });
  // An older dry run that failed at two.0: its error screenshot, two.1 not reached, page text with markup.
  await writeRun(dir, {
    id: FAILED, scenario: 'blocks', mode: 'dry', status: 'failed', snapshot: BLOCKS_YAML,
    scenes: [{ id: 'one' }, { id: 'two', status: 'failed' }],
    events: [ev('one', 0, 'click'), ev('one', 1, 'click'), ev('one', 2, 'hold'), ev('two', 0, 'click', { status: 'failed', error: 'no element "<img src=x onerror=window.__pwned=9>" ‮txt.exe', target: '<svg/onload=window.__pwned=10>' })],
    screenshots: { 'one-00-click.png': BLUE, 'one-01-click.png': BLUE, 'one-02-hold.png': BLUE, 'error-two-0.png': YELLOW },
    error: { scene: 'two', step: 0, message: 'boom <script>window.__pwned=11</script>' },
    steps_total: 5,
  });
  await writeFile(join(dir, 'scenarios', 'hostile.yaml'), HOSTILE_YAML);
  await writeRun(dir, {
    id: '20261020-110000-hostile', scenario: 'hostile', mode: 'dry', snapshot: HOSTILE_YAML,
    scenes: [{ id: 'evil' }],
    events: [ev('evil', 0, 'click', { target: 'link "<img src=x onerror=window.__pwned=12>" ‮gnp.exe', url: 'http://user:secret@localhost:4402/<script>' }), ev('evil', 1, 'type', { error: '<iframe srcdoc="<script>parent.__pwned=13</script>">' })],
    screenshots: { 'evil-00-click.png': GREEN, 'evil-01-type.png': BLUE },
  });
  await writeFile(join(dir, 'scenarios', 'long.yaml'), longYaml());
  const longEvents = [];
  const shots: Record<string, Rgb> = {};
  for (let s = 0; s < LONG_SCENES; s++) {
    for (let i = 0; i < LONG_PER; i++) {
      longEvents.push(ev(`s${s}`, i, 'click'));
      shots[`s${s}-${pad2(i)}-click.png`] = PALETTE[(s * LONG_PER + i) % PALETTE.length];
    }
  }
  await writeRun(dir, { id: '20261020-120000-long', scenario: 'long', mode: 'dry', snapshot: longYaml(), scenes: Array.from({ length: LONG_SCENES }, (_x, s) => ({ id: `s${s}` })), events: longEvents, screenshots: shots });
  // No worker: a dry run started from the screen stays queued until Cancel (the real worker is test:slow's).
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await context.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  page = await context.newPage();
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('request', (r: Request) => {
    const m = /\/v1\/call\/([a-z_]+)$/.exec(r.url());
    if (!m) return;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.postData() ?? '{}') as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    requests.push({ op: m[1], at: Date.now(), body });
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the scenario screen in Chromium', () => {
  it('the project page links each scenario; quote as blocks: scenes, URLs, captions, steps, chips, hooks, what stops a run', async () => {
    await page.goto(`${studio.url}#/p/${P}`);
    await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor();
    // L5.10a: a poster selects (the inspector shows it), its Open opens it.
    await page.locator('[role="option"][data-id="quote"]').click();
    await page.getByTestId('scenario-link').click();
    await page.getByRole('heading', { level: 1, name: 'quote' }).waitFor();
    expect(page.url()).toBe(`${studio.url}#/p/${P}/s/quote`);
    expect(await page.title()).toBe('quote · Scenario · Demo Studio');
    const scenes = page.getByTestId('scene');
    await expect.poll(() => scenes.count(), POLL).toBe(4);
    const d = await page.locator('[data-scene="discover"]').innerText();
    expect(d).toContain('http://localhost:4402/');
    expect(d).toContain('shown as https://shop.northfield.example/');
    expect(d).toMatch(/Speed/);
    expect(d).toMatch(/Layout/);
    expect(d).toMatch(/Duration/);
    expect(await page.locator('[data-scene="request"]').innerText()).toContain('continues from discover');
    expect(await page.getByTestId('caption').first().innerText()).toContain('Award-winning lots');
    // Steps: an action badge in words, a target in plain words, chips.
    const first = row('discover.0');
    expect(await first.getByTestId('action-badge').innerText()).toMatch(/hover/i);
    expect(await page.locator('[data-chip]').count()).toBeGreaterThan(0);
    // The hooks strip and what would stop a run from the Studio.
    expect(await page.getByTestId('hook').count()).toBeGreaterThan(1);
    expect(await page.getByTestId('hooks').innerText()).toMatch(/destructive|rollback/i);
    expect(await page.getByTestId('blockers-dry-run').innerText()).toContain('nothing stops it');
    const cap = await page.getByTestId('blockers-capture').innerText();
    expect(cap).toContain('needs the terminal');
    expect(cap).toContain('The Studio cannot approve hooks yet');
    expect(cap).not.toMatch(/MCP/);
    expect(await page.getByTestId('blocker-fix').first().innerText()).toMatch(new RegExp(`run ${P} quote$`));
    // The fixture's quote run kept no copy of the scenario: matched by position, said in words.
    expect(await page.getByText('Cannot tell whether the scenario changed since this run').count()).toBe(1);
    expect(await page.getByRole('listbox').count()).toBe(4);
    expect(await page.locator('[role="listbox"][tabindex="0"]').count()).toBe(1);
    await shot('10-scenario-quote');
  });

  it('off camera (L5.8): a hook step\'s badge and words, the named hooks in the strip by name, an offscreen scene said so', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/off-camera`);
    await page.getByRole('heading', { level: 1, name: 'off-camera' }).waitFor();
    const hook = row('requests.2');
    expect(await hook.getByTestId('action-badge').innerText()).toMatch(/^hook$/i);
    expect(await hook.innerText()).toContain('off camera: cut from the video');
    const named = await page.getByTestId('named-hooks').innerText();
    expect(named).toContain('run during the take by a hook step, off camera');
    expect(named).toMatch(/request[\s\S]*queue/);
    expect(named).toContain('Needs a person');
    expect(await page.locator('[data-scene="to-the-list"]').innerText()).toContain('off camera: played, not in the video');
    expect(await page.getByTestId('blockers-capture').innerText()).toContain('The Studio cannot approve hooks yet');
    await shot('10b-scenario-off-camera');
  });

  it('pictures: each step shows the frame at its end (pixel colours); the picker swaps them; a failed run says why', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/blocks`);
    await page.getByRole('heading', { level: 1, name: 'blocks' }).waitFor();
    expect(await page.getByTestId('source-line').innerText()).toContain(CAPTURE);
    await expectColours({ 'one.0': RED, 'one.1': GREEN, 'one.2': GREEN, 'two.0': YELLOW, 'two.1': MAGENTA });
    const img = row('one.0').locator('img');
    expect(await img.getAttribute('alt')).toBe(`click “First” — step 1 of scene one, at the end of the step in capture ${CAPTURE}`);
    expect((await img.getAttribute('src'))?.startsWith('data:image/jpeg;base64,')).toBe(true);
    // Thumbnails were asked by the run's own keys, at most 24 per call.
    const thumbs = ops('run_thumbs');
    expect(thumbs.length).toBeGreaterThan(0);
    for (const t of thumbs) expect((t.body.keys as string[]).length).toBeLessThanOrEqual(24);
    expect(await page.getByTestId('step-state').first().innerText()).toMatch(/done/);
    await shot('11-scenario-blocks-capture');
    // Another run: the dry run's screenshots.
    await page.getByTestId('run-picker').selectOption(DRY);
    await expect.poll(() => page.getByTestId('source-line').innerText(), POLL).toContain(DRY);
    await expectColours({ 'one.0': ORANGE, 'one.1': BLUE, 'one.2': CYAN, 'two.0': GREY, 'two.1': RED });
    // The failed run: its error screenshot for the failed step, the next one not reached — in words.
    await page.getByTestId('run-picker').selectOption(FAILED);
    await expect.poll(() => page.getByTestId('source-line').innerText(), POLL).toContain(FAILED);
    await expectColours({ 'one.0': BLUE, 'two.0': YELLOW });
    expect(await row('two.0').getByTestId('step-state').innerText()).toContain('failed in this run');
    expect(await row('two.1').innerText()).toContain('Not reached: the run failed at step 1 of two');
    expect(await row('two.1').getByTestId('thumb').getAttribute('data-state')).toBe('none');
    // Its page text: in a box, as text.
    expect(await page.getByTestId('run-error').innerText()).toContain('<script>window.__pwned=11</script>');
    await shot('12-scenario-failed-run');
    await page.getByTestId('run-picker').selectOption('');
    await expect.poll(() => page.getByTestId('source-line').innerText(), POLL).toContain(CAPTURE);
  });

  it('keyboard: one tab stop, Up / Down across scenes, Home / End; the inspector follows; Show in YAML outlines the lines', async () => {
    await row('one.0').click();
    const active = () => page.evaluate(() => ({ role: document.activeElement?.getAttribute('role'), label: document.activeElement?.getAttribute('aria-label'), desc: document.activeElement?.getAttribute('aria-activedescendant') }));
    const selected = () => page.locator('[role="option"][aria-selected="true"]').getAttribute('data-key');
    expect(await active()).toMatchObject({ role: 'listbox', label: 'Steps of scene one' });
    expect(await selected()).toBe('one.0');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await selected()).toBe('one.2');
    expect(await page.getByTestId('inspector-step').innerText()).toBe('Step 3 of scene one');
    await page.keyboard.press('ArrowDown'); // into the next scene's list
    expect(await selected()).toBe('two.0');
    expect(await active()).toMatchObject({ role: 'listbox', label: 'Steps of scene two' });
    const desc = (await active()).desc!;
    expect(await page.locator(`#${desc}`).getAttribute('data-key')).toBe('two.0');
    await page.keyboard.press('End');
    expect(await selected()).toBe('two.1');
    expect(await page.getByTestId('inspector-args').innerText()).toContain('Fourth');
    expect(await page.getByTestId('inspector-hint').innerText()).toMatch(/Click an element/);
    expect(await page.getByTestId('inspector-run').innerText()).toMatch(/ok · .* · picture from frame/);
    expect(await page.getByTestId('edit-hint').innerText()).toContain('scenarios/blocks.yaml');
    await page.keyboard.press('Home');
    expect(await selected()).toBe('one.0');
    expect(await page.locator('[role="listbox"][tabindex="0"]').count()).toBe(1);
    expect(await page.locator('[role="option"][aria-selected="true"]').count()).toBe(1);
    // Tab leaves the step area at once (the other scene's list is not a tab stop).
    await page.keyboard.press('Tab');
    expect((await active()).role).not.toBe('listbox');
    expect(await page.getByTestId('inspector').getByRole('heading', { name: 'Step inspector' }).count()).toBe(1);
    expect(await page.getByTestId('inspector-source').innerText()).toBe('click: First');
    await shot('13-scenario-inspector');
    await page.getByRole('button', { name: 'Show in YAML' }).click();
    await page.waitForURL(/\/s\/blocks\/yaml$/);
    const focused = page.locator('[data-testid="yaml"] li[data-focus="true"]');
    await expect.poll(() => focused.count(), POLL).toBe(1);
    expect(await focused.innerText()).toContain('- click: First');
    expect(await page.getByTestId('yaml').locator('li').count()).toBe(BLOCKS_YAML.split('\n').length);
    await shot('14-scenario-yaml');
    await page.getByRole('link', { name: 'Blocks' }).click();
    await row('one.0').waitFor();
    expect(await page.locator('[role="option"][aria-selected="true"]').getAttribute('data-key')).toBe('one.0');
  });

  it('events: progress is a run_status read; other scenarios and runs change nothing; its own runs and file are read again', async () => {
    if (!page.url().endsWith('/s/blocks')) await page.goto(`${studio.url}#/p/${P}/s/blocks`);
    await expectColours({ 'one.0': RED });
    await sleep(800);
    const t0 = Date.now();
    // A running run of this scenario appears: one re-read (the running banner), then its progress — run_status only.
    const running: SynthRun = { id: RUNNING, scenario: 'blocks', mode: 'capture', status: 'running', noTimeline: true, steps_total: 5, events: [] };
    await writeRun(project(), running);
    await expect.poll(() => page.getByTestId('running').count(), POLL).toBe(1);
    await expect.poll(() => ops('scenario_blocks', t0).length, POLL).toBe(1);
    const t1 = Date.now();
    for (let k = 1; k <= 4; k++) {
      await sleep(400);
      await writeFile(join(project(), 'runs', RUNNING, 'run.json'), JSON.stringify({ ...JSON.parse(await readFile(join(project(), 'runs', RUNNING, 'run.json'), 'utf8')), steps_done: k, current: { scene: 'one', step: k - 1, action: 'click' } }));
    }
    await sleep(600);
    expect(ops('scenario_blocks', t1), 'progress never re-reads the view').toHaveLength(0);
    await expect.poll(() => page.getByTestId('running').innerText(), POLL).toContain('4/5 steps');
    expect(await page.getByTestId('running').innerText()).toContain('current step 4 of one · click');
    expect(ops('run_status', t1).length).toBeGreaterThan(0);
    for (const r of ops('run_status', t1)) expect(r.body).toEqual({ project: P, run_id: RUNNING });
    // Another scenario's file and another scenario's run: nothing.
    await writeFile(join(project(), 'scenarios', 'quote.yaml'), `${await readFile(join(project(), 'scenarios', 'quote.yaml'), 'utf8')}# edited\n`);
    await writeRun(project(), { ...capture('20261023-130000-catalogue'), scenario: 'catalogue', snapshot: undefined, video: false });
    await sleep(1500);
    expect(ops('scenario_blocks', t1)).toHaveLength(0);
    await page.evaluate(() => document.getElementById('main')?.scrollTo(0, 0));
    await shot('15-scenario-running');
    // The run finishes: one re-read, no banner.
    const t2 = Date.now();
    await writeFile(join(project(), 'runs', RUNNING, 'run.json'), JSON.stringify({ ...JSON.parse(await readFile(join(project(), 'runs', RUNNING, 'run.json'), 'utf8')), status: 'cancelled', finished_at: new Date().toISOString() }));
    await expect.poll(() => page.getByTestId('running').count(), POLL).toBe(0);
    await sleep(800);
    expect(ops('scenario_blocks', t2)).toHaveLength(1);
    // Its own file edited on disk (in place): a step inserted at the top of scene one. Read again once; the scenario
    // changed since the run; the new step has no picture, every other step keeps its own colour (bound by identity).
    const t3 = Date.now();
    await writeFile(join(project(), 'scenarios', 'blocks.yaml'), BLOCKS_YAML.replace('    steps:\n      - click: First', '    steps:\n      - click: Zero\n      - click: First'));
    await expect.poll(() => page.getByText('What the browser does changed since this run').count(), POLL).toBe(1);
    // L5.5: the notice names the filmed part that changed.
    expect(await page.locator('.notice', { hasText: 'What the browser does changed since this run' }).innerText()).toContain('Changed: scene one: step one.0 added.');
    await sleep(500);
    expect(ops('scenario_blocks', t3)).toHaveLength(1);
    expect(await row('one.0').innerText()).toContain('New since this run');
    await expectColours({ 'one.1': RED, 'one.2': GREEN, 'one.3': GREEN, 'two.0': YELLOW, 'two.1': MAGENTA });
    await shot('16-scenario-changed');
  });

  it('hostile scenario and page text are inert text: no script, no CSP report, no dialog; direction controls visible', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/hostile`);
    await page.getByRole('heading', { level: 1, name: 'hostile' }).waitFor();
    await expectColours({ 'evil.0': GREEN, 'evil.1': BLUE });
    const scene = await page.locator('[data-scene="evil"]').innerText();
    expect(scene).toContain('javascript:window.__pwned=2');
    expect(scene).toContain('[U+202E]gnp.exe <svg/onload=window.__pwned=4>');
    expect(await row('evil.0').innerText()).toContain('[U+202E]txt.exe');
    // Attributes cannot be isolated: the row's name and the picture's alt show the control as a mark (review A #8).
    expect(await row('evil.0').getAttribute('aria-label')).toContain('[U+202E]txt.exe');
    expect(await row('evil.0').locator('img').getAttribute('alt')).toContain('[U+202E]txt.exe');
    expect(await row('evil.0').getAttribute('aria-label')).not.toContain('\u202E');
    await row('evil.0').click();
    expect(await page.getByTestId('inspector-source').innerText()).toContain('[U+202E]txt.exe');
    const from = await page.getByTestId('from-page').innerText();
    expect(from).toContain('<img src=x onerror=window.__pwned=12>');
    expect(from).toContain('[U+202E]gnp.exe');
    expect(from).not.toContain('secret');
    await row('evil.1').click();
    expect(await page.getByTestId('from-page').innerText()).toContain('<iframe srcdoc=');
    expect(await page.getByTestId('video-block').innerText()).toContain('<img src=x onerror=window.__pwned=1>');
    await page.getByRole('link', { name: 'YAML' }).click();
    await page.getByTestId('yaml').waitFor();
    const yaml = await page.getByTestId('yaml').innerText();
    expect(yaml).toContain('<script>window.__pwned="comment"</script>');
    expect(yaml).toContain('[U+202E]gnp.exe');
    expect(yaml).toContain('[U+202E]txt.exe');
    await shot('17-scenario-hostile');
    expect(await page.locator('iframe, script:not([src]), svg image, object, embed').count()).toBe(0);
    expect(await page.locator('img').evaluateAll((els) => els.every((e) => (e as HTMLImageElement).src.startsWith('data:image/jpeg;base64,')))).toBe(true);
    expect(await pwned()).toBeNull();
    expect(await csp()).toBe(0);
    expect(dialogs).toEqual([]);
  });

  it('a 1,200-step scenario: interactive under ≈ 5 s, one view read, pictures only for rows on screen, ≤ 24 keys a call', async () => {
    expect(LONG_SCENES * LONG_PER).toBe(1200);
    await page.goto(`${studio.url}#/p/${P}`);
    await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor();
    await sleep(300);
    const t0 = Date.now();
    await page.evaluate(() => {
      location.hash = '#/p/northfield-fixture/s/long';
    });
    await page.getByRole('heading', { level: 1, name: 'long' }).waitFor({ timeout: 10_000 });
    await expect.poll(() => page.locator('[data-testid="step"]').count(), { timeout: 10_000, interval: 50 }).toBe(LONG_SCENES * LONG_PER);
    await page.locator('[data-testid="step"] img').first().waitFor({ timeout: 10_000 });
    const ready = Date.now() - t0;
    expect(ready, `screen with pictures in ${ready} ms`).toBeLessThan(5000);
    if (SHOTS) await writeFile(join(SHOTS, 'long-timing.json'), JSON.stringify({ ready_ms: ready }));
    await sleep(500);
    expect(ops('scenario_blocks', t0)).toHaveLength(1);
    const early = ops('run_thumbs', t0);
    expect(early.length, 'run_thumbs calls before any scroll').toBeLessThanOrEqual(2);
    for (const t of early) expect((t.body.keys as string[]).length).toBeLessThanOrEqual(24);
    const asked = early.flatMap((t) => t.body.keys as string[]);
    expect(asked).toContain('s0.0');
    expect(asked.every((k) => /^s0\.\d+$/.test(k))).toBe(true);
    await shot('18-scenario-long-top');
    // The keyboard to the last step: the list scrolls; the rows passed on the way are never asked for.
    await row('s0.0').click();
    const t1 = Date.now();
    await page.keyboard.press('End');
    await expect.poll(() => row('s11.99').getByTestId('thumb').getAttribute('data-state'), POLL).toBe('ok');
    const colours = await thumbColours();
    expect(colourName(colours['s11.99'])).toBe(colourName(PALETTE[(LONG_SCENES * LONG_PER - 1) % PALETTE.length]));
    await sleep(500);
    const late = ops('run_thumbs', t1);
    expect(late.length).toBeLessThanOrEqual(2);
    for (const t of late) expect((t.body.keys as string[]).length).toBeLessThanOrEqual(24);
    expect(late.flatMap((t) => t.body.keys as string[]).every((k) => /^s11\.\d+$/.test(k))).toBe(true);
    expect(ops('scenario_blocks', t0)).toHaveLength(1);
    await shot('19-scenario-long-end');
    // A fast scroll through the middle: calls whose rows left the screen are aborted, never more than 2 at a time
    // (review B L4: counted in the browser — each answer held 400 ms so calls overlap).
    const flight = { now: 0, max: 0, aborted: 0, done: 0 };
    const isThumbs = (r: Request) => /\/v1\/call\/run_thumbs$/.test(r.url());
    const onReq = (r: Request) => {
      if (!isThumbs(r)) return;
      flight.now++;
      flight.max = Math.max(flight.max, flight.now);
    };
    const onEnd = (failed: boolean) => (r: Request) => {
      if (!isThumbs(r)) return;
      flight.now--;
      if (failed && /ABORT/i.test(r.failure()?.errorText ?? '')) flight.aborted++;
      if (!failed) flight.done++;
    };
    const onFailed = onEnd(true);
    const onFinished = onEnd(false);
    page.on('request', onReq);
    page.on('requestfailed', onFailed);
    page.on('requestfinished', onFinished);
    await page.route('**/v1/call/run_thumbs', async (route) => {
      await sleep(400);
      await route.continue().catch(() => undefined);
    });
    const t2 = Date.now();
    try {
      for (let y = 0; y < 30; y++) {
        await page.mouse.wheel(0, -2500);
        await sleep(60);
      }
      await sleep(1500);
    } finally {
      await page.unroute('**/v1/call/run_thumbs');
      page.off('request', onReq);
      page.off('requestfailed', onFailed);
      page.off('requestfinished', onFinished);
    }
    console.log(`fast scroll: ${ops('run_thumbs', t2).length} run_thumbs calls, ${flight.aborted} aborted, ${flight.done} answered, at most ${flight.max} in flight`);
    for (const t of ops('run_thumbs', t2)) expect((t.body.keys as string[]).length).toBeLessThanOrEqual(24);
    expect(flight.max).toBeGreaterThanOrEqual(1);
    expect(flight.max).toBeLessThanOrEqual(2);
    expect(flight.aborted).toBeGreaterThanOrEqual(1);
    expect(consoleErrors).toEqual([]);
  });
  it('run actions: a blocked Capture is disabled with its reason and command (no request); Dry run → scenario_run with pinned arguments → the banner → Cancel', async () => {
    const t0 = Date.now();
    await page.goto(`${studio.url}#/p/${P}/s/quote`);
    await page.getByRole('heading', { level: 1, name: 'quote' }).waitFor();
    const capture = page.getByTestId('run-capture');
    await capture.waitFor();
    expect(await capture.isDisabled()).toBe(true);
    expect(await capture.innerText()).toBe('Capture — needs the terminal');
    const described = await capture.getAttribute('aria-describedby');
    expect(await page.locator(`#${described}`).innerText()).toBe('why, and the command to type, below');
    // Said once (review B L6), with the command and its node form for a person without `studio` on their PATH.
    expect((await page.getByTestId('blockers-capture').innerText()).match(/needs the terminal/g)).toHaveLength(1);
    expect(await page.getByTestId('blockers-capture').getByTestId('blocker-fix').innerText()).toBe(`studio -C ${ws} run ${P} quote`);
    expect(await page.getByTestId('blockers-capture').getByTestId('blocker-fix-node').innerText()).toMatch(new RegExp(`/packages/cli/dist/bin\\.js -C ${ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} run ${P} quote$`));
    expect(await page.getByTestId('blockers-capture').innerText()).not.toMatch(/MCP/);
    const dry = page.getByTestId('run-dry');
    expect(await dry.isDisabled()).toBe(false);
    expect(await dry.innerText()).toBe('Dry run');
    // A click on the disabled button sends nothing.
    await capture.click({ force: true });
    await sleep(300);
    expect(ops('scenario_run', t0)).toHaveLength(0);
    await page.evaluate(() => document.getElementById('main')?.scrollTo(0, 0));
    await shot('20-scenario-run-blocked');
    // blocks: a dry run from the screen.
    await page.goto(`${studio.url}#/p/${P}/s/blocks`);
    await page.getByRole('heading', { level: 1, name: 'blocks' }).waitFor();
    await page.getByTestId('run-dry').click();
    await expect.poll(() => ops('scenario_run', t0).length, POLL).toBe(1);
    // Pinned arguments, and the file as the screen showed it (review A #6).
    const shown = createHash('sha256').update(await readFile(join(project(), 'scenarios', 'blocks.yaml'))).digest('hex');
    expect(ops('scenario_run', t0)[0].body).toEqual({ project: P, name: 'blocks', mode: 'dry', hash: shown });
    const submitted = page.getByTestId('run-submitted');
    await submitted.waitFor();
    const runId = /(\d{8}-\d{6}-blocks)/.exec(await submitted.innerText())?.[1];
    expect(runId).toBeTruthy();
    // Queued (no worker here): the banner names it; both buttons wait while it is unfinished.
    await expect.poll(() => page.getByTestId('running').count(), POLL).toBe(1);
    expect(await page.getByTestId('running').innerText()).toContain(runId!);
    expect(await page.getByTestId('run-dry').isDisabled()).toBe(true);
    expect(await page.getByTestId('blockers-dry-run').innerText()).toContain('waits for the run of this scenario to finish');
    await page.evaluate(() => document.getElementById('main')?.scrollTo(0, 0));
    await shot('21-scenario-run-queued');
    const t1 = Date.now();
    await page.getByTestId('run-cancel').click();
    await expect.poll(() => ops('run_cancel', t1).length, POLL).toBe(1);
    expect(ops('run_cancel', t1)[0].body).toEqual({ project: P, run_id: runId });
    await expect.poll(() => page.getByTestId('running').count(), POLL).toBe(0);
    expect(await page.getByTestId('run-dry').isDisabled()).toBe(false);
    expect(await page.getByTestId('run-submitted').count(), 'the queued note goes once its run is over').toBe(0);
    // Its outcome instead (review B H1).
    await expect.poll(() => page.getByTestId('run-outcome').count(), POLL).toBe(1);
    expect(await page.locator('.notice', { has: page.getByTestId('run-outcome') }).innerText()).toMatch(new RegExp(`The dry run ${runId} cancelled[\\s\\S]*It left no picture\\.`));
    // The cancelled run is one of the picker's runs (it has no pictures: the source stays the capture).
    await expect.poll(() => page.getByTestId('run-picker').locator('option').allInnerTexts(), POLL).toContain(`Dry run ${runId} · cancelled · no pictures`);
    expect(await page.getByTestId('source-line').innerText()).toContain(CAPTURE);
    expect(ops('scenario_run', t0)).toHaveLength(1);
    expect(consoleErrors).toEqual([]);
    await shot('22-scenario-run-cancelled');
  });

  /** The job of a run (its job.json path and record), from the jobs folder. */
  async function jobOf(runId: string): Promise<{ file: string; rec: Record<string, unknown> }> {
    const dir = join(ws, '.demo-studio', 'jobs');
    for (const id of await readdir(dir)) {
      const file = join(dir, id, 'job.json');
      const rec = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { input?: { run_id?: string } };
      if (rec.input?.run_id === runId) return { file, rec: rec as Record<string, unknown> };
    }
    throw new Error(`no job for ${runId}`);
  }

  async function startDry(scenario: string): Promise<string> {
    await page.goto(`${studio.url}#/p/${P}/s/${scenario}`);
    await page.getByRole('heading', { level: 1, name: scenario }).waitFor();
    await page.getByTestId('run-dry').click();
    const submitted = page.getByTestId('run-submitted');
    await submitted.waitFor();
    const runId = new RegExp(`(\\d{8}-\\d{6}-${scenario})`).exec(await submitted.innerText())?.[1];
    expect(runId).toBeTruthy();
    await expect.poll(() => page.getByTestId('running').count(), POLL).toBe(1);
    return runId!;
  }

  it('a Studio run that fails before its first step (the site down): its outcome and first error line, named over the pictures (review B H1)', async () => {
    await writeFile(join(project(), 'scenarios', 'down.yaml'), BLOCKS_YAML);
    await writeRun(project(), capture('20261020-090000-down', { scenario: 'down', video: false }));
    const runId = await startDry('down');
    // What the worker writes when the page cannot be reached: failed, no timeline, no picture.
    const file = join(project(), 'runs', runId, 'run.json');
    const rec = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...rec, status: 'failed', finished_at: new Date().toISOString(), error: { scene: 'one', step: 0, action: 'click', message: 'scene one, step 0 (click “First”): page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4401/\nCall log: …' } }));
    await expect.poll(() => page.getByTestId('running').count(), POLL).toBe(0);
    await expect.poll(() => page.getByTestId('run-outcome-error').count(), POLL).toBe(1);
    const notice = await page.locator('.notice', { has: page.getByTestId('run-outcome') }).innerText();
    expect(notice).toContain(`The dry run ${runId} failed at step 1 of one`);
    expect(notice).toContain('It left no picture.');
    // The runner's 0-based prefix in the screen's words (review B M2), its first line only.
    expect(await page.getByTestId('run-outcome-error').innerText()).toContain('step 1 of one (click “First”): page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4401/');
    expect(await page.getByTestId('run-outcome-error').innerText()).not.toContain('Call log');
    // The source stays the capture; the failed run is named above the pictures.
    expect(await page.getByTestId('source-line').innerText()).toContain('20261020-090000-down');
    expect(await page.locator('.notice', { hasText: 'Newer runs stopped early' }).innerText()).toContain(`${runId} (failed at step 1 of one, no pictures)`);
    await page.evaluate(() => document.getElementById('main')?.scrollTo(0, 0));
    await shot('23-scenario-run-failed');
    const job = await jobOf(runId);
    await raw(studio.port, 'POST', '/v1/call/run_cancel', { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify({ project: P, run_id: runId }));
    expect(job.file).toBeTruthy();
    expect(consoleErrors).toEqual([]);
  });

  it('a worker that dies mid-run: the banner goes without a focus or a reload, the run interrupted (review B M4)', async () => {
    await writeFile(join(project(), 'scenarios', 'crash.yaml'), BLOCKS_YAML);
    const runId = await startDry('crash');
    // A worker takes the job and runs it (a stand-in process), then dies.
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      const job = await jobOf(runId);
      await writeFile(job.file, JSON.stringify({ ...job.rec, state: 'running', started_at: new Date().toISOString(), worker: { pid: worker.pid } }));
      const file = join(project(), 'runs', runId, 'run.json');
      const rec = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...rec, status: 'running', steps_done: 1, current: { scene: 'one', step: 1, action: 'click' } }));
      await expect.poll(() => page.locator('.notice', { has: page.getByTestId('running') }).innerText().catch(() => ''), POLL).toContain('is running');
      const t0 = Date.now();
      worker.kill('SIGKILL');
      await expect.poll(() => page.getByTestId('running').count(), POLL).toBe(0);
      expect(ops('run_status', t0).length).toBeGreaterThanOrEqual(1);
      expect(ops('scenario_blocks', t0).length).toBeGreaterThanOrEqual(1);
      await expect.poll(() => page.getByTestId('run-picker').locator('option').allInnerTexts(), POLL).toContain(`Dry run ${runId} · interrupted · no pictures`);
      expect(await page.getByTestId('run-dry').isDisabled()).toBe(false);
    } finally {
      worker.kill('SIGKILL');
    }
    expect(consoleErrors).toEqual([]);
  });

  it('a multi-page scene: each page’s full URL or the scene it continues from, the layout the video uses; filmed scenes numbered 1, 2, 3; notes from the file (review B M1, L3, M5)', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/phone-and-desktop`);
    await page.getByRole('heading', { level: 1, name: 'phone-and-desktop' }).waitFor();
    const phone = page.locator('[data-testid="scene"][data-scene="phone"]');
    const pages = await phone.getByTestId('scene-pages').innerText();
    expect(pages).toMatch(/desk \(Desktop\) · page shop · http:\/\/localhost:4402\/quotes/);
    expect(pages).toMatch(/phone \(Phone\) · page shop · http:\/\/localhost:4402\/products\/selowa-ridge/);
    expect(await phone.innerText()).not.toContain('the first page');
    expect(await phone.innerText()).toContain('2 pages, picture in picture (pip) — the video’s frame');
    expect(await page.locator('[data-testid="scene"][data-scene="send"]').getByTestId('scene-pages').innerText()).toMatch(/desk · page shop · continues from phone/);
    const video = await page.getByTestId('video-block').innerText();
    expect(video).toContain('Notes from the file');
    expect(video).toContain('One account, two screens (L2.11): the same shop filmed on a desktop and on a phone');
    expect(video).not.toMatch(/yaml-language-server|\$schema/);
    await page.getByTestId('video-block').scrollIntoViewIfNeeded();
    await shot('25-scenario-video-card');
    await phone.scrollIntoViewIfNeeded();
    await shot('24-scenario-multi-page');
    // quote: two cards between its filmed scenes — the scenes are 1, 2, 3, 4 all the same.
    await page.goto(`${studio.url}#/p/${P}/s/quote`);
    await page.getByRole('heading', { level: 1, name: 'quote' }).waitFor();
    const titles = await page.locator('[data-testid="scene"] .scene-title .muted').allInnerTexts();
    expect(titles).toEqual(titles.map((_t, i) => `Scene ${i + 1}`));
    expect(await page.getByTestId('card').count()).toBeGreaterThan(0);
  });

  it('a step with two actions says why it has no picture (review B M3); a file over the step cap shows the first 2,000 and says so (review A #8)', async () => {
    const yaml = BLOCKS_YAML.replace('      - click: Second\n', '      - {click: Second, hover: Elsewhere}\n');
    await writeFile(join(project(), 'scenarios', 'two-actions.yaml'), yaml);
    await writeRun(project(), capture('20261020-080000-two-actions', { scenario: 'two-actions', snapshot: yaml, video: false }));
    await page.goto(`${studio.url}#/p/${P}/s/two-actions`);
    await page.getByRole('heading', { level: 1, name: 'two-actions' }).waitFor();
    await expect.poll(() => row('one.1').innerText(), POLL).toContain('Cannot tell: this step has no single action');
    const lines = ['video: huge', 'scenes:'];
    for (let sc = 0; sc < 3; sc++) {
      lines.push(`  - id: h${sc}`, '    page: console', '    open: /', '    steps:');
      for (let i = 0; i < 700; i++) lines.push(`      - click: B${sc}-${i}`);
    }
    await writeFile(join(project(), 'scenarios', 'huge.yaml'), `${lines.join('\n')}\n`);
    await page.goto(`${studio.url}#/p/${P}/s/huge`);
    await page.getByRole('heading', { level: 1, name: 'huge' }).waitFor({ timeout: 10_000 });
    await expect.poll(() => page.locator('[data-testid="step"]').count(), { timeout: 15_000 }).toBe(2000);
    expect(await page.locator('.notice', { has: page.getByTestId('steps-limit') }).innerText()).toContain('Showing the first 2,000 steps of 2,100');
    expect(consoleErrors).toEqual([]);
  });
});
