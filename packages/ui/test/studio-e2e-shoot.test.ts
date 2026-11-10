/**
 * L5.11a: Shoot's actions end to end in headless Chromium — the built-in Studio server with no worker (a started run
 * stays queued: nothing reaches a page), a project of this test's own:
 *
 * - ⚑ one run per start: a click and two menu commands in the same tick queue ONE rehearsal (the store's `sending`
 *   guard; the server's one-run-per-scenario 409 stays the authority); in a browser tab ⌘R, ⇧⌘R, ⌘B and ⌘. stay the
 *   browser's (nothing bound, nothing sent) and the palette's Scenario group runs them (critique M3);
 * - ⚑ a command acts only when it can: a blocked capture by ⇧⌘R sends nothing and says why in the gate's words; no
 *   scenario in context says so; the blocker line's Copy command copies exactly the command;
 * - ⚑ Stop's owner (critique H1): after a reload of a live route the screen's own Stop answers ⌘. — a terminal's run is
 *   told "Ctrl-C there" and nothing is sent; a Studio run's live screen stops ITS run; off the live route the status
 *   bar's Stop is off for a terminal's run (critique M4);
 * - ⚑ the confirmation sheet: "Sign in owner first…" holds the focus (Return chooses it), Escape and Cancel queue
 *   nothing and give the focus back, Capture anyway sends `sessions_ack` once; on Prepare it asks before any request;
 * - ⚑ the location: the status bar sends `env` only when the tab chose another location than the file's — on the
 *   Project screen too — and names it;
 * - ⚑ a step's progress is never said in the polite line, and the status bar follows it with run_status, not
 *   scenario_actions.
 * L5.11a fixes (reviews A and B):
 * - ⚑ the blocker's command is shown in full in a popover beside its Copy (what is copied is what is shown, A-M3);
 * - ⚑ a start from Prepare leaves the focus on the live screen's title; a refusal shows its words and takes the focus
 *   (A-M2 / B-M2); the polite line is text (A-M4), goes on a route change and after 6 s (B-M1); a scenario that cannot
 *   be read says so where it would wait (B-L6);
 * - ⚑ a run's job rewritten at each step reads no scenario_actions and no engine_info (A-M1);
 * - ⚑ a terminal's run and a Studio run together: Stop acts on the Studio run; ⌘. on a live screen stops the run it
 *   shows and nothing else (B-M5 / A-L4); ⌘. twice says the stop is on its way (A-L3); the outcome's Rehearse again and
 *   Start capture open the new run (B-L4);
 * - ⚑ Prepare's sessions table at 1280 and 900 px: no Location column, no cell under its header word, nothing overlaps,
 *   notes on their own line and never repeating an issue, no Sign in for a persona its login steps sign in (B-H1,
 *   B-L1); ⌘. with the palette open closes it and answers (A-L3).
 * `RETAKE_UI_SHOTS=<folder>` saves screenshots there.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { writeRun } from '../../engine/test/synthetic-runs.js';

const P = 'shoot';
const POLL = { timeout: 20_000 };
const SHOTS = process.env.RETAKE_UI_SHOTS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const savedHome = process.env.RETAKE_HOME;
const LEAD_VAR = 'SHOOT_E2E_LEAD_PASSWORD';

let ws: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const requests: Array<{ op: string; at: number; body: Record<string, unknown> }> = [];
const consoleErrors: string[] = [];
const project = () => join(ws, 'projects', P);
const ops = (op: string, since = 0) => requests.filter((r) => r.op === op && r.at >= since);
const said = () => page.locator('.sh-said').innerText();
const command = (id: string) => page.evaluate((x) => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: x } })), id);

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function openScenario(name: string): Promise<void> {
  await page.goto(`${studio.url}#/p/${P}/s/${name}`);
  await page.getByRole('heading', { level: 1, name }).waitFor(POLL);
  await page.getByTestId('status-actions').waitFor(POLL);
}

/** The run of the scenario in context stopped from the page (⌘.), as a person does (no worker: it stays queued otherwise). */
async function stopAll(): Promise<void> {
  await expect.poll(() => page.getByTestId('run-stop').count(), POLL).toBe(1);
  await command('stop');
  await expect.poll(() => page.getByTestId('run-stop').count(), POLL).toBe(0);
  await expect.poll(async () => (await studio.engine.jobs.list({ project: P, states: ['queued', 'running'] })).length, POLL).toBe(0);
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-shoot-e2e-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  await mkdir(join(project(), 'scenarios'), { recursive: true });
  await writeFile(
    join(project(), 'project.yaml'),
    [
      'version: 1',
      'name: Shoot',
      'environments:',
      '  local:',
      '    app: http://localhost:4890',
      '  staging:',
      '    app: http://localhost:4891',
      '  signed-in:',
      '    app: http://localhost:4892',
      '  team:',
      '    app: http://localhost:4893',
      '    admin: http://localhost:4894',
      'auth:',
      '  signed-in:',
      '    login_url: /sign-in',
      '    personas:',
      '      owner: {pages: [app], check: {url: "app:/members", expect_text: Members}}',
      '  team:',
      '    login_url: /sign-in',
      '    personas:',
      `      lead: {pages: [app], check: {url: "app:/", expect_text: Team}, login: [{open: "app:/sign-in"}, {type: {into: {label: Password}, text: "{{env:${LEAD_VAR}}}"}}]}`,
      '      editor: {pages: [admin], login: [{open: "admin:/sign-in"}, {type: {into: {label: Password}, text: "{{env:SHOOT_E2E_EDITOR_PASSWORD}}"}}]}',
      'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
      'template: default',
      '',
    ].join('\n'),
  );
  const scenario = (name: string, lines: string[]) => writeFile(join(project(), 'scenarios', `${name}.yaml`), `${['version: 1', `video: ${name}`, ...lines].join('\n')}\n`);
  await scenario('free', ['scenes:', '  - id: one', '    page: app', '    open: /', '    steps:', ...Array.from({ length: 8 }, () => '      - hold: 0.4')]);
  await scenario('hooked', ['setup:', '  - http: {method: POST, url: "{{app}}/x", rollback: {method: DELETE, url: "{{app}}/x"}}', 'scenes:', '  - id: one', '    page: app', '    open: /', '    steps:', '      - hold: 0.4']);
  await scenario('members', ['env: signed-in', 'scenes:', '  - id: list', '    page: app', '    open: /members', '    steps:', '      - hold: 0.5']);
  await scenario('team', ['env: team', 'scenes:', '  - id: one', '    page: app', '    open: /', '    steps:', '      - hold: 0.3', '  - id: two', '    page: admin', '    open: /', '    steps:', '      - hold: 0.3']);
  // The lead's login steps find their secret where the worker starts: every run signs it in (no "Sign in…").
  process.env[LEAD_VAR] = 'not-a-real-secret';
  studio = await startStudioServer({ root: ws, pollMs: 100, startWorker: false });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: studio.url.replace(/\/$/, '') });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('request', (r) => {
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
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  delete process.env[LEAD_VAR];
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('Shoot: the status bar\'s actions, the Scenario menu, the sheet', () => {
  it('⚑ one run per start (a click and two menu commands in one tick: one scenario_run); a browser tab binds none of ⌘R ⇧⌘R ⌘B ⌘.; the palette runs Rehearse', async () => {
    await openScenario('free');
    const dry = page.getByTestId('run-dry');
    await expect.poll(() => dry.isDisabled(), POLL).toBe(false);
    // No key caps in a browser tab (the app's menu names them).
    expect(await page.getByTestId('status-actions').locator('kbd').count()).toBe(0);
    // The browser keeps its keys: nothing prevents them, nothing is sent.
    const t0 = Date.now();
    const prevented = await page.evaluate(() =>
      [
        { key: 'r', metaKey: true },
        { key: 'R', metaKey: true, shiftKey: true },
        { key: 'b', metaKey: true },
        { key: '.', metaKey: true },
        { key: 'r', ctrlKey: true },
      ].map((k) => {
        const e = new KeyboardEvent('keydown', { ...k, bubbles: true, cancelable: true });
        document.body.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    );
    expect(prevented).toEqual([false, false, false, false, false]);
    await sleep(300);
    expect(ops('scenario_run', t0)).toEqual([]);
    // One tick: a click, a held ⌘R (two menu commands): ONE call.
    await page.evaluate(() => {
      (document.querySelector('[data-testid="run-dry"]') as HTMLButtonElement).click();
      for (let i = 0; i < 2; i++) window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'rehearse' } }));
    });
    await expect.poll(() => ops('scenario_run', t0).length, POLL).toBe(1);
    await sleep(800);
    expect(ops('scenario_run', t0)).toHaveLength(1);
    expect(ops('scenario_run', t0)[0].body).toMatchObject({ project: P, name: 'free', mode: 'dry' });
    expect(ops('scenario_run', t0)[0].body.env).toBeUndefined();
    await expect.poll(said, POLL).toContain('Rehearsal of free queued');
    await expect.poll(() => page.getByTestId('status-scenario').innerText(), POLL).toContain('Rehearsal queued');
    await shot('60-shoot-queued');
    // ⌘. (the menu's Stop) on the Scenario screen: the status bar's default stops the scenario's run.
    const t1 = Date.now();
    await command('stop');
    await expect.poll(() => ops('run_cancel', t1).length, POLL).toBe(1);
    await expect.poll(() => page.getByTestId('run-stop').count(), POLL).toBe(0);
    // The palette's Scenario group (⌘K, the one key a tab binds): Rehearse.
    await expect.poll(() => dry.isDisabled(), POLL).toBe(false);
    const t2 = Date.now();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.locator('dialog.k-palette[open]').waitFor(POLL);
    await page.keyboard.type('Rehearse');
    await page.keyboard.press('Enter');
    await expect.poll(() => ops('scenario_run', t2).length, POLL).toBe(1);
    await page.getByTestId('run-stop').click();
    await expect.poll(() => page.getByTestId('run-stop').count(), POLL).toBe(0);
    expect(consoleErrors).toEqual([]);
  });

  it('⚑ a command acts only when it can: a blocked capture by ⇧⌘R sends nothing, said in the gate\'s words; no scenario in context; the command shown in full in a popover, Copy copies exactly what it shows', async () => {
    await openScenario('hooked');
    const line = page.getByTestId('blockers-capture');
    await line.waitFor(POLL);
    expect(await line.innerText()).toContain('1 hook to approve');
    expect(await page.getByTestId('run-capture').isDisabled()).toBe(true);
    const t0 = Date.now();
    await command('capture');
    await expect.poll(said, POLL).toBe('Capture of hooked is blocked: 1 hook to approve');
    expect(ops('scenario_run', t0)).toEqual([]);
    // Command…: a popover SHOWS the whole command (review A-M3: never a command copied unseen) beside its Copy.
    const pop = page.getByTestId('blockers-capture-popover');
    expect(await pop.isVisible()).toBe(false);
    expect(await line.innerText()).not.toContain(ws);
    await page.getByTestId('blockers-capture-action').click();
    await expect.poll(() => pop.isVisible(), POLL).toBe(true);
    await expect.poll(() => page.getByTestId('blockers-capture-action').getAttribute('aria-expanded'), POLL).toBe('true');
    const shownCommand = await pop.locator('.k-blocker-code').innerText();
    expect(shownCommand).toBe(`retake -C ${ws} run ${P} hooked`);
    // Shown in full: wrapped, never cut.
    expect(await pop.locator('.k-blocker-code').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('blockers-capture-copy');
    await page.getByTestId('blockers-capture-copy').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), POLL).toBe(shownCommand);
    // "Copied" is visible (review B-L8), not only to a screen reader.
    await expect.poll(() => pop.getByRole('status').innerText(), POLL).toBe('Copied');
    const copiedBox = await pop.getByRole('status').boundingBox();
    expect(copiedBox!.width).toBeGreaterThan(20);
    expect(await pop.getByRole('status').evaluate((el) => getComputedStyle(el).clipPath)).toBe('none');
    await shot('61-shoot-blocked');
    await page.keyboard.press('Escape');
    await expect.poll(() => pop.isVisible(), POLL).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('blockers-capture-action');
    // No scenario in context (Welcome): said, nothing sent.
    await page.goto(`${studio.url}#/`);
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    for (const id of ['rehearse', 'capture', 'render', 'stop']) {
      await command(id);
      await expect.poll(said, POLL).toBe('Open a scenario first');
    }
    expect(ops('scenario_run', t0)).toEqual([]);
    expect(ops('scenario_render', t0)).toEqual([]);
  });

  it('⚑ Stop\'s owner after a reload (critique H1): a terminal\'s run says Ctrl-C and sends nothing; a Studio run\'s live screen stops its own run; the status bar\'s Stop is off for a terminal\'s run (M4)', async () => {
    const term = '20261102-100000-free';
    await writeRun(project(), { id: term, scenario: 'free', mode: 'dry', status: 'running', noTimeline: true, steps_total: 8, events: [] });
    await appendFile(join(project(), 'runs', term, 'log.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), type: 'run_start', run: { id: term, scenario: 'free', mode: 'dry', status: 'running', env: 'local', steps_total: 8 } })}\n`);
    try {
      await page.goto(`${studio.url}#/p/${P}/s/free/run/${term}`);
      await page.getByRole('heading', { level: 1, name: 'Rehearsal of free' }).waitFor(POLL);
      await page.reload();
      await page.getByRole('heading', { level: 1, name: 'Rehearsal of free' }).waitFor(POLL);
      await page.getByTestId('controls-why').waitFor(POLL);
      await page.locator('.sp-live-screen[data-read="yes"]').waitFor(POLL);
      // Review A-L6: the live state word is the status bar's ("Rehearsing"), not "worker busy".
      await expect.poll(() => page.getByTestId('live-state').innerText(), POLL).toBe('Rehearsing');
      const t0 = Date.now();
      await command('stop');
      await expect.poll(said, POLL).toContain('Started in a terminal: press Ctrl-C there');
      expect(ops('run_cancel', t0)).toEqual([]);
      // Off the live route: the status bar's Stop is off, its description says why; ⌘. says the same.
      await openScenario('free');
      await expect.poll(() => page.getByTestId('run-stop').isDisabled(), POLL).toBe(true);
      expect(await page.locator('#sh-why-stop').textContent()).toContain('Ctrl-C');
      await command('stop');
      await expect.poll(said, POLL).toContain('Ctrl-C');
      expect(ops('run_cancel', t0)).toEqual([]);
      // Prepare: its disabled Pause and Stop say why (review A-L2), and the running callout says it in words.
      await page.goto(`${studio.url}#/p/${P}/s/free/run`);
      await page.getByRole('heading', { level: 1, name: 'Prepare a take of free' }).waitFor(POLL);
      await expect.poll(() => page.getByTestId('run-stop').isDisabled(), POLL).toBe(true);
      for (const id of ['run-stop', 'run-pause']) {
        const desc = await page.getByTestId(id).getAttribute('aria-describedby');
        expect(await page.locator(`#${desc}`).textContent(), id).toContain('Started in a terminal: press Ctrl-C there to stop it.');
      }
      expect(await page.getByTestId('watch-terminal').innerText()).toContain('press Ctrl-C there');
      expect(await page.getByTestId('status-scenario').innerText()).toContain('Rehearsing');
    } finally {
      const file = join(project(), 'runs', term, 'run.json');
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status: 'succeeded', finished_at: new Date().toISOString() }));
    }
    // A Studio run: queued from the status bar, its live route reloaded, ⌘. stops THAT run.
    await openScenario('free');
    await expect.poll(() => page.getByTestId('run-dry').isDisabled(), POLL).toBe(false);
    const t1 = Date.now();
    await command('rehearse');
    await expect.poll(() => ops('scenario_run', t1).length, POLL).toBe(1);
    await page.getByTestId('status-watch').click();
    await page.getByRole('heading', { level: 1, name: 'Rehearsal of free' }).waitFor(POLL);
    const runId = decodeURIComponent(/\/run\/([^/]+)$/.exec(new URL(page.url()).hash)![1]);
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Rehearsal of free' }).waitFor(POLL);
    await page.getByTestId('controls-why').waitFor(POLL);
    await page.locator('.sp-live-screen[data-read="yes"]').waitFor(POLL);
    const t2 = Date.now();
    await command('stop');
    await expect.poll(() => ops('run_cancel', t2).length, POLL).toBe(1);
    expect(ops('run_cancel', t2)[0].body).toEqual({ project: P, run_id: runId });
    await expect.poll(() => page.getByTestId('run-outcome').count(), POLL).toBe(1);
    expect(consoleErrors).toEqual([]);
  });

  it('⚑ the sheet: "Sign in owner first…" holds the focus; Escape and Cancel queue nothing and give it back; Capture anyway sends sessions_ack once; Prepare asks before any request', async () => {
    await openScenario('members');
    const capture = page.getByTestId('run-capture');
    await expect.poll(() => capture.isDisabled(), POLL).toBe(false);
    const sheet = page.getByTestId('confirm-sessions');
    const t0 = Date.now();
    await capture.click();
    await expect.poll(() => sheet.isVisible(), POLL).toBe(true);
    expect(await sheet.getAttribute('role')).toBe('alertdialog');
    expect(await sheet.innerText()).toContain('owner — never signed in · checked before filming');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('confirm-sign-in-first');
    expect(await page.getByTestId('confirm-sign-in-first').innerText()).toBe('Sign in owner first…');
    await shot('62-shoot-sheet');
    // The status bar asked once and the server refused (409, the sessions listed): nothing queued, nothing acknowledged.
    expect(ops('scenario_run', t0).map((r) => r.body.sessions_ack)).toEqual([undefined]);
    await page.keyboard.press('Escape');
    await expect.poll(() => sheet.isVisible(), POLL).toBe(false);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), POLL).toBe('run-capture');
    await capture.click();
    await expect.poll(() => sheet.isVisible(), POLL).toBe(true);
    await page.getByTestId('confirm-cancel').click();
    await expect.poll(() => sheet.isVisible(), POLL).toBe(false);
    expect((await studio.engine.jobs.list({ project: P, states: ['queued', 'running'] })).length).toBe(0);
    expect(ops('scenario_run', t0).filter((r) => r.body.sessions_ack)).toEqual([]);
    // Capture anyway: one call, the persona acknowledged.
    await capture.click();
    await expect.poll(() => sheet.isVisible(), POLL).toBe(true);
    await page.getByTestId('confirm-capture-anyway').click();
    await expect.poll(() => ops('scenario_run', t0).filter((r) => r.body.sessions_ack).length, POLL).toBe(1);
    expect(ops('scenario_run', t0).filter((r) => r.body.sessions_ack)[0].body).toMatchObject({ project: P, name: 'members', mode: 'capture', sessions_ack: ['owner'] });
    await expect.poll(said, POLL).toContain('Capture of members queued');
    await stopAll();
    // Prepare knows who to confirm: the sheet opens before any request; Sign in first focuses that persona's Sign in.
    await page.goto(`${studio.url}#/p/${P}/s/members/run`);
    await page.getByRole('heading', { level: 1, name: 'Prepare a take of members' }).waitFor(POLL);
    await expect.poll(() => page.getByTestId('start-capture').isDisabled(), POLL).toBe(false);
    const t1 = Date.now();
    await page.getByTestId('start-capture').click();
    await expect.poll(() => sheet.isVisible(), POLL).toBe(true);
    expect(ops('scenario_run', t1)).toEqual([]);
    await page.keyboard.press('Enter');
    await expect.poll(() => sheet.isVisible(), POLL).toBe(false);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')), POLL).toBe('Sign in owner (signed-in)');
    expect(ops('scenario_run', t1)).toEqual([]);
    await shot('63-shoot-prepare');
    expect(consoleErrors).toEqual([]);
  });

  it('⚑ the location: env sent only when the tab chose another than the file\'s — from the Scenario screen and the Project screen — and named in the status bar', async () => {
    await openScenario('free');
    const select = page.getByTestId('location-select');
    await select.selectOption('staging');
    await expect.poll(() => page.getByTestId('status-scenario').innerText(), POLL).toContain('on staging');
    const t0 = Date.now();
    await expect.poll(() => page.getByTestId('run-dry').isDisabled(), POLL).toBe(false);
    await page.getByTestId('run-dry').click();
    await expect.poll(() => ops('scenario_run', t0).length, POLL).toBe(1);
    expect(ops('scenario_run', t0)[0].body).toMatchObject({ name: 'free', mode: 'dry', env: 'staging' });
    await expect.poll(said, POLL).toContain('Rehearsal of free on staging queued');
    await stopAll();
    // The Project screen: the production selected is the scenario in context, its location the tab's choice.
    await page.goto(`${studio.url}#/p/${P}`);
    await page.locator('[role="option"][data-id="free"]').click();
    await expect.poll(() => page.getByTestId('status-scenario').innerText(), POLL).toContain('on staging');
    expect(ops('scenario_actions', t0).some((r) => r.body.env === 'staging')).toBe(true);
    await expect.poll(() => page.getByTestId('run-dry').isDisabled(), POLL).toBe(false);
    const t1 = Date.now();
    await command('rehearse');
    await expect.poll(() => ops('scenario_run', t1).length, POLL).toBe(1);
    expect(ops('scenario_run', t1)[0].body).toMatchObject({ name: 'free', env: 'staging' });
    await stopAll();
    // Back to the file's own: no env.
    await openScenario('free');
    await select.selectOption('local');
    await expect.poll(() => page.getByTestId('status-scenario').innerText(), POLL).not.toContain('on staging');
    await expect.poll(() => page.getByTestId('run-dry').isDisabled(), POLL).toBe(false);
    const t2 = Date.now();
    await page.getByTestId('run-dry').click();
    await expect.poll(() => ops('scenario_run', t2).length, POLL).toBe(1);
    expect(ops('scenario_run', t2)[0].body.env).toBeUndefined();
    await stopAll();
  });

  it('⚑ a step\'s progress is never said in the polite line; the Project screen\'s status bar follows it with run_status, not scenario_actions', async () => {
    const id = '20991231-110000-free'; // newer than every run of this test: the last take once it ends
    await writeRun(project(), { id, scenario: 'free', mode: 'dry', status: 'running', noTimeline: true, steps_total: 8, events: [] });
    await page.goto(`${studio.url}#/p/${P}`);
    await page.locator('[role="option"][data-id="free"]').click();
    await expect.poll(() => page.getByTestId('status-scenario').innerText(), POLL).toContain('Rehearsing');
    await page.evaluate(() => {
      const w = window as unknown as { __said: number };
      w.__said = 0;
      new MutationObserver(() => w.__said++).observe(document.querySelector('.sh-said')!, { childList: true, characterData: true, subtree: true });
    });
    const t0 = Date.now();
    const file = join(project(), 'runs', id, 'run.json');
    for (let k = 1; k <= 6; k++) {
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), steps_done: k, current: { scene: 'one', step: k, action: 'hold' } }));
      await sleep(400);
    }
    await expect.poll(() => page.getByTestId('status-scenario').innerText(), POLL).toContain('step 7 of 8');
    const changes = await page.evaluate(() => (window as unknown as { __said: number }).__said);
    expect(changes).toBeLessThanOrEqual(3);
    expect(ops('run_status', t0).length).toBeGreaterThan(0);
    expect(ops('scenario_actions', t0).length).toBeLessThanOrEqual(1);
    // The run ends as the runner ends one: its step in flight leaves the record (a succeeded record never holds one).
    const { current: _current, ...ended } = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...ended, status: 'succeeded', finished_at: new Date().toISOString() }));
    await expect.poll(() => page.getByTestId('status-scenario').innerText(), POLL).toContain('Last take succeeded');
    expect(consoleErrors).toEqual([]);
  });

  it('⚑ Prepare\'s start leaves the focus on the live title; a refusal shows its words and takes the focus; the polite line is text, goes on a route change and after 6 s; a scenario that cannot be read says so', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/free/run`);
    await page.getByRole('heading', { level: 1, name: 'Prepare a take of free' }).waitFor(POLL);
    const start = page.getByTestId('start-dry');
    await expect.poll(() => start.isDisabled(), POLL).toBe(false);
    const t0 = Date.now();
    await start.click();
    await page.waitForURL(/\/run\/\d{8}-\d{6}-free$/, POLL);
    await page.getByTestId('live-title').waitFor(POLL);
    // Review A-M2: the focus is on the live screen's title, never left on <body>.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), POLL).toBe('live-title');
    expect(ops('scenario_run', t0)).toHaveLength(1);
    // Review B-M1: "queued" was said on Prepare; the live screen says the run's own state — the line went with the route
    // (at once: long before its 6 s).
    await sleep(1000); // past the line's own 30 ms re-announce delay: a line kept would show by now
    expect(await said()).toBe('');
    expect(Date.now() - t0).toBeLessThan(5000);
    await page.locator('.sp-live-screen[data-read="yes"]').waitFor(POLL);
    await command('stop');
    await expect.poll(() => page.getByTestId('run-outcome').count(), POLL).toBe(1);
    expect(await page.getByTestId('live-state').count()).toBe(0);

    // A refusal (the server's 409, its message carrying a direction override): its words, the focus on them.
    // The answer is held 1.5 s: while it is sent, the button stays enabled and focused, a second click sends nothing.
    await page.route('**/v1/call/scenario_run', async (route) => {
      await sleep(1500);
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'conflict', message: 'refused \u202Eby the test', fix: `retake -C ${ws} run ${P} free` } }) });
    });
    try {
      await page.goto(`${studio.url}#/p/${P}/s/free/run`);
      await page.getByRole('heading', { level: 1, name: 'Prepare a take of free' }).waitFor(POLL);
      await expect.poll(() => start.isDisabled(), POLL).toBe(false);
      const tr = Date.now();
      await start.click();
      await expect.poll(() => start.innerText(), POLL).toBe('Starting the rehearsal…');
      expect(await start.isDisabled()).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('start-dry');
      await start.click();
      await expect.poll(said, POLL).toBe('Wait: the rehearsal of free is being started');
      await page.getByTestId('start-refused').waitFor(POLL);
      expect(ops('scenario_run', tr)).toHaveLength(1);
      expect(await page.getByTestId('start-refused').innerText()).toBe('refused [U+202E]by the test');
      expect(await page.getByTestId('start-refused-box').innerText()).toContain('The rehearsal was not started');
      expect(await page.getByTestId('start-refused-box').getByTestId('blocker-fix').innerText()).toBe(`retake -C ${ws} run ${P} free`);
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), POLL).toBe('start-refused-box');
      // Review A-M4: the polite line is text — the override shown as a mark, never applied.
      await expect.poll(said, POLL).toBe('The rehearsal of free was not started: refused [U+202E]by the test');
      expect(await page.locator('.sh-said bdi').count()).toBe(1);
      // Gone after about 6 s (announced once), on the same screen.
      await expect.poll(said, { timeout: 10_000 }).toBe('');
    } finally {
      await page.unroute('**/v1/call/scenario_run');
    }

    // From the Scenario screen: "queued" goes as soon as the screen changes (long before 6 s).
    await openScenario('free');
    await expect.poll(() => page.getByTestId('run-dry').isDisabled(), POLL).toBe(false);
    await command('rehearse');
    await expect.poll(said, POLL).toContain('Rehearsal of free queued');
    const t1 = Date.now();
    await page.goto(`${studio.url}#/p/${P}/cast`);
    await sleep(800);
    expect(await said()).toBe('');
    expect(Date.now() - t1).toBeLessThan(4000);
    await openScenario('free');
    await stopAll();

    // Review B-L6: a scenario whose actions cannot be read says so where it would wait (not "Loading…").
    await page.route('**/v1/call/scenario_actions', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'unreadable by the test' } }) }));
    try {
      await page.goto(`${studio.url}#/p/${P}/s/free/run`);
      await page.getByTestId('prepare-failed').waitFor(POLL);
      await expect.poll(() => page.locator('#start-why-dry').innerText(), POLL).toBe('The scenario cannot be read: see above');
      expect(await page.getByTestId('status-scenario').innerText()).toContain('The scenario cannot be read');
      expect(await page.getByTestId('preflight-blockers').innerText()).toContain('Cannot be read');
    } finally {
      await page.unroute('**/v1/call/scenario_actions');
    }
    expect(consoleErrors).toEqual([]);
  });

  it('⚑ a run\'s job rewritten at each step (its progress) reads no scenario_actions and no engine_info — on its live screen and on the Project screen; its end reads once', async () => {
    await openScenario('free');
    await expect.poll(() => page.getByTestId('run-dry').isDisabled(), POLL).toBe(false);
    await command('rehearse');
    await page.getByTestId('status-watch').waitFor(POLL);
    const [job] = await studio.engine.jobs.list({ project: P, states: ['queued'] });
    expect(job).toBeDefined();
    const file = join(ws, '.retake', 'jobs', job.id, 'job.json');
    let step = 0;
    /** A real job record rewritten as a worker does at each step (`ctx.progress`): the server sends a `jobs` event naming it. */
    const steps = async (n: number) => {
      for (let i = 0; i < n; i++) {
        step++;
        const rec = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        await writeFile(file, JSON.stringify({ ...rec, progress: { steps_done: step, steps_total: 8, current: { scene: 'one', step }, updated_at: new Date().toISOString() } }, null, 2));
        await sleep(400);
      }
      await sleep(2600); // longer than JOBS_THROTTLE_MS: a throttled re-read would have come
    };
    /** Until the page read nothing for 2 s (the new run's folder appearing in the index comes ~2 s after the start). */
    const settle = async () => {
      for (let i = 0; i < 40; i++) {
        const last = requests.filter((r) => r.op === 'scenario_actions' || r.op === 'project_board').at(-1)?.at ?? 0;
        if (Date.now() - last > 2000) return;
        await sleep(250);
      }
    };
    await page.getByTestId('status-watch').click();
    await page.getByTestId('live-title').waitFor(POLL);
    await settle();
    const t0 = Date.now();
    await steps(6);
    expect(ops('scenario_actions', t0)).toEqual([]);
    // The 15 s tick may land in the window once; a read per job change would be six.
    expect(ops('engine_info', t0).length).toBeLessThanOrEqual(1);
    // The Project screen with the scenario selected (the status bar's own read).
    await page.goto(`${studio.url}#/p/${P}`);
    await page.locator('[role="option"][data-id="free"]').click();
    await expect.poll(() => page.getByTestId('status-scenario').innerText(), POLL).toContain('Rehearsal queued');
    await settle();
    const t1 = Date.now();
    await steps(6);
    expect(ops('scenario_actions', t1)).toEqual([]);
    expect(ops('engine_info', t1).length).toBeLessThanOrEqual(1);
    // Its end: read again, once or twice (Stop's own reload, the run's status change).
    const t2 = Date.now();
    await stopAll();
    await sleep(1500);
    expect(ops('scenario_actions', t2).length).toBeGreaterThanOrEqual(1);
    expect(ops('scenario_actions', t2).length).toBeLessThanOrEqual(3);
    expect(consoleErrors).toEqual([]);
  });

  it('⚑ Prepare\'s sessions at 1280 and 900 px: no Location column, no cell under its header word, nothing overlaps, notes on their own line (an issue said once), no Sign in for a persona its login signs in; at 900 px the Start buttons on screen and the status bar cuts no word; ⌘. with the palette open closes it and answers', async () => {
    /** What is wrong with the table's geometry (empty: nothing). Stacked rows (no visible header): every cell ≥ 80 px. */
    const geometry = () =>
      page.evaluate(() => {
        const t = document.querySelector<HTMLElement>('[data-testid="sessions-table"]')!;
        const vis = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        };
        const textWidth = (el: Element) => {
          const rg = document.createRange();
          rg.selectNodeContents(el);
          return rg.getBoundingClientRect().width;
        };
        const out: string[] = [];
        const stacked = getComputedStyle(t).display === 'block';
        const heads = stacked ? [] : [...t.querySelectorAll('thead th')].filter(vis);
        for (const h of heads) if (h.scrollWidth > h.clientWidth + 1) out.push(`header cut: ${h.textContent}`);
        const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        const hr = heads.map((h) => [h.textContent ?? '', h.getBoundingClientRect()] as const);
        for (let i = 0; i < hr.length; i++) for (let j = i + 1; j < hr.length; j++) if (overlap(hr[i][1], hr[j][1])) out.push(`headers overlap: ${hr[i][0]} / ${hr[j][0]}`);
        for (const row of t.querySelectorAll('tbody tr[data-testid="session-row"]')) {
          const cells = [...row.children].filter(vis);
          cells.forEach((c, i) => {
            const w = c.getBoundingClientRect().width;
            const min = stacked ? 80 : heads[i] && heads[i].textContent && !heads[i].querySelector('.k-sr') ? textWidth(heads[i]) : 0;
            if (w + 0.5 < min) out.push(`${row.getAttribute('data-persona')} cell ${i} ${Math.round(w)} px < ${Math.round(min)} px`);
            // A state word on one line (never a letter per line).
            for (const m of c.querySelectorAll('.k-mark-word')) if (m.getBoundingClientRect().height > 2 * parseFloat(getComputedStyle(m).lineHeight)) out.push(`${row.getAttribute('data-persona')}: "${m.textContent}" wraps`);
          });
          const rects = cells.map((c) => c.getBoundingClientRect());
          for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i], rects[j])) out.push(`${row.getAttribute('data-persona')}: cells ${i} and ${j} overlap`);
        }
        if (t.scrollWidth > (t.parentElement?.clientWidth ?? 0) + 1) out.push(`the table is wider than its pane (${t.scrollWidth} px)`);
        return { stacked, out };
      });
    try {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(`${studio.url}#/p/${P}/s/team/run`);
      await page.getByRole('heading', { level: 1, name: 'Prepare a take of team' }).waitFor(POLL);
      const table = page.getByTestId('preflight-sessions').getByTestId('sessions-table');
      await table.waitFor(POLL);
      expect(await table.locator('thead th').allTextContents()).toEqual(['Persona', 'Session', 'Last check', 'Sign in']);
      const lead = table.locator('[data-testid="session-row"][data-persona="lead"]');
      const editor = table.locator('[data-testid="session-row"][data-persona="editor"]');
      // Review B-L1: the lead's login steps sign it in at every run — no "Sign in…" to offer.
      expect(await lead.getByTestId('sign-in-button').count()).toBe(0);
      expect(await lead.getByTestId('signed-in-by').innerText()).toBe('Each run signs it in, off camera');
      expect(await editor.getByTestId('sign-in-button').count()).toBe(1);
      // The editor's notes: on their own line; its missing secret is the issue's callout, not repeated in the row.
      const notes = table.locator('[data-testid="session-notes"][data-persona="editor"]');
      expect(await notes.innerText()).toBe('No check: a run uses its saved session as it is, unverified.');
      expect(await page.getByTestId('preflight-sessions').innerText()).toContain('persona editor: its login steps use SHOOT_E2E_EDITOR_PASSWORD');
      expect(await page.getByTestId('preflight-sessions').innerText().then((t) => t.match(/SHOOT_E2E_EDITOR_PASSWORD/g)?.length)).toBe(1);
      const g1280 = await geometry();
      expect(g1280).toEqual({ stacked: false, out: [] });
      const [noteW, tableW] = await Promise.all([notes.locator('td').evaluate((el) => el.getBoundingClientRect().width), table.evaluate((el) => el.getBoundingClientRect().width)]);
      expect(noteW).toBeGreaterThan(tableW - 2);
      await shot('64-shoot-sessions-1280');
      await page.setViewportSize({ width: 900, height: 760 });
      await expect.poll(geometry, POLL).toEqual({ stacked: true, out: [] });
      // Review A-L1: the Start actions are on screen at 900 px without scrolling past the checks.
      const box = await page.getByTestId('start-dry').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(760 - 34);
      await shot('65-shoot-sessions-900');
      // Review A-L1: at 900 px the status bar drops whole segments (the last take, the scenario's name), never cuts a
      // word — a production with a last take AND a blocker on the Project screen, the tightest case.
      await writeRun(project(), { id: '20261101-090000-hooked', scenario: 'hooked', mode: 'dry', status: 'cancelled', noTimeline: true, steps_total: 1, events: [] });
      await page.goto(`${studio.url}#/p/${P}`);
      await page.locator('[role="option"][data-id="hooked"]').click();
      await page.getByTestId('blockers-capture').waitFor(POLL);
      const cut = () =>
        page.evaluate(() => {
          const bar = document.querySelector('.k-statusbar')!;
          const out: string[] = [];
          for (const el of bar.querySelectorAll<HTMLElement>('.k-mark-word, .k-blocker-text, .k-btn-label, .sh-seg')) {
            const r = el.getBoundingClientRect();
            // Visually hidden on purpose (a label kept for assistive technology) is not cut.
            if (r.width < 1 || el.closest('.k-sr, [popover]') || getComputedStyle(el).clipPath !== 'none') continue;
            if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== 'inline') out.push(`cut: ${el.textContent}`);
            if (getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.push(`ellipsis: ${el.textContent}`);
          }
          const info = bar.querySelector<HTMLElement>('.k-statusbar-info');
          if (info && info.scrollWidth > info.clientWidth + 1) out.push(`the info is cut: ${info.textContent}`);
          if (document.documentElement.scrollWidth > window.innerWidth) out.push('the page scrolls sideways');
          return out;
        });
      await expect.poll(cut, POLL).toEqual([]);
      expect(await page.getByTestId('blockers-capture').innerText()).toContain('Capture blocked: 1 hook to approve');
      expect(await page.locator('.sh-seg[data-drop="last"]').evaluate((el) => getComputedStyle(el).display)).toBe('none');
      await shot('66-shoot-statusbar-900');
      await page.setViewportSize({ width: 1360, height: 860 });
      expect(await page.locator('.sh-seg[data-drop="last"]').evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
      expect(await page.getByTestId('status-scenario').innerText()).toContain('Last take stopped');
    } finally {
      await page.setViewportSize({ width: 1360, height: 860 });
    }
    // Review A-L3: ⌘. always answers — the palette open, it closes and Stop's owner says what it does.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.locator('dialog.k-palette[open]').waitFor(POLL);
    await command('stop');
    await expect.poll(() => page.locator('dialog.k-palette[open]').count(), POLL).toBe(0);
    await expect.poll(said, POLL).toBe('Nothing of hooked is running');
    expect(consoleErrors).toEqual([]);
  });

  it('⚑ a terminal\'s run and a Studio run together: Stop acts on the Studio run; ⌘. on each live screen (reloaded) acts on the run it shows only; ⌘. twice says the stop is on its way; the outcome\'s next takes open the new run', async () => {
    // The Studio's rehearsal first (the status bar waits while any run is unfinished), then a terminal's run of the same scenario.
    await openScenario('free');
    await expect.poll(() => page.getByTestId('run-dry').isDisabled(), POLL).toBe(false);
    const t0 = Date.now();
    await command('rehearse');
    await expect.poll(() => ops('scenario_run', t0).length, POLL).toBe(1);
    await page.getByTestId('status-watch').waitFor(POLL);
    const [job] = await studio.engine.jobs.list({ project: P, states: ['queued'] });
    const studioRun = (job.input as { run_id: string }).run_id;
    const term = '20991231-120000-free'; // the newest run: listed first
    await writeRun(project(), { id: term, scenario: 'free', mode: 'dry', status: 'running', noTimeline: true, steps_total: 8, events: [] });
    const finishTerm = async () => {
      const f = join(project(), 'runs', term, 'run.json');
      await writeFile(f, JSON.stringify({ ...JSON.parse(await readFile(f, 'utf8')), status: 'succeeded', finished_at: new Date().toISOString() }));
    };
    try {
      // The status bar: Stop is on and acts on the Studio's run (not "Ctrl-C there").
      await openScenario('free');
      await expect.poll(() => page.getByTestId('run-stop').isDisabled(), POLL).toBe(false);
      expect(await page.locator('#sh-why-stop').textContent()).not.toContain('Ctrl-C');
      // The terminal's live screen, reloaded: ⌘. says Ctrl-C there and stops nothing — the Studio's run goes on.
      await page.goto(`${studio.url}#/p/${P}/s/free/run/${term}`);
      await page.getByTestId('controls-why').waitFor(POLL);
      await page.reload();
      await page.getByTestId('controls-why').waitFor(POLL);
      await page.locator('.sp-live-screen[data-read="yes"]').waitFor(POLL);
      const t1 = Date.now();
      await command('stop');
      await expect.poll(said, POLL).toContain('Started in a terminal: press Ctrl-C there');
      await sleep(500);
      expect(ops('run_cancel', t1)).toEqual([]);
      expect((await studio.engine.jobs.list({ project: P, states: ['queued'] })).map((j) => j.id)).toEqual([job.id]);
      // The Studio run's live screen, reloaded: ⌘. stops THAT run; twice in one tick, one call and the second said.
      await page.goto(`${studio.url}#/p/${P}/s/free/run/${studioRun}`);
      await page.getByTestId('controls-why').waitFor(POLL);
      await page.reload();
      await page.getByTestId('controls-why').waitFor(POLL);
      await page.locator('.sp-live-screen[data-read="yes"]').waitFor(POLL);
      const t2 = Date.now();
      await page.evaluate(() => {
        for (let i = 0; i < 2; i++) window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: 'stop' } }));
      });
      await expect.poll(() => ops('run_cancel', t2).length, POLL).toBe(1);
      expect(ops('run_cancel', t2)[0].body).toEqual({ project: P, run_id: studioRun });
      await expect.poll(said, POLL).toMatch(/^Wait: stopping…$|already stopping/);
      await expect.poll(() => page.getByTestId('run-outcome').count(), POLL).toBe(1);
      await sleep(400);
      expect(ops('run_cancel', t2)).toHaveLength(1);
      // The terminal's run still runs (nothing touched its run.json).
      expect(JSON.parse(await readFile(join(project(), 'runs', term, 'run.json'), 'utf8')).status).toBe('running');
    } finally {
      await finishTerm();
    }
    // The outcome's Rehearse again (a stopped rehearsal): the new run's live screen opens, its title focused.
    await expect.poll(() => page.getByTestId('outcome-rehearse').count(), POLL).toBe(1);
    await sleep(600); // the status bar sees the terminal's run finished
    const t3 = Date.now();
    await page.getByTestId('outcome-rehearse').click();
    await expect.poll(() => ops('scenario_run', t3).length, POLL).toBe(1);
    await page.waitForURL((u) => /\/run\/\d{8}-\d{6}-free$/.test(u.hash) && !u.hash.endsWith(studioRun), POLL);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), POLL).toBe('live-title');
    await page.locator('.sp-live-screen[data-read="yes"]').waitFor(POLL);
    await command('stop');
    await expect.poll(() => page.getByTestId('run-outcome').count(), POLL).toBe(1);
    await expect.poll(async () => (await studio.engine.jobs.list({ project: P, states: ['queued', 'running'] })).length, POLL).toBe(0);
    // A rehearsal that succeeded: its outcome's Start capture queues a capture and opens it.
    const ok = '20991231-130000-free';
    await writeRun(project(), { id: ok, scenario: 'free', mode: 'dry', status: 'succeeded', noTimeline: true, steps_total: 8, events: [] });
    await page.goto(`${studio.url}#/p/${P}/s/free/run/${ok}`);
    await page.getByTestId('outcome-capture').waitFor(POLL);
    const t4 = Date.now();
    await page.getByTestId('outcome-capture').click();
    await expect.poll(() => ops('scenario_run', t4).length, POLL).toBe(1);
    expect(ops('scenario_run', t4)[0].body).toMatchObject({ project: P, name: 'free', mode: 'capture' });
    await page.waitForURL((u) => /\/run\/\d{8}-\d{6}-free$/.test(u.hash) && !u.hash.endsWith(ok), POLL);
    await page.getByRole('heading', { level: 1, name: 'Capture of free' }).waitFor(POLL);
    await page.locator('.sp-live-screen[data-read="yes"]').waitFor(POLL);
    await command('stop');
    await expect.poll(async () => (await studio.engine.jobs.list({ project: P, states: ['queued', 'running'] })).length, POLL).toBe(0);
    expect(consoleErrors).toEqual([]);
  });
});
