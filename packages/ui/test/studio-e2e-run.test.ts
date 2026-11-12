/**
 * L4.4 part C (slow: gated by RETAKE_TEST_SLOW=1 — `pnpm test:slow`): the Run screen end to end — the built-in
 * Studio server, the real worker it starts, headless Chromium (the installed build of playwright-core; nothing
 * downloaded) and a small product page of this test's own on a free port (an animated board: the live picture keeps
 * changing, also during a pause — critique B16). Covered:
 *
 * - a dry run watched live: the preflight first, Start → its own route, frames drawn on the canvas (pixels that vary),
 *   steps progressing from the run's outline, log lines; a step description holding markup stays text (S9);
 * - a hidden tab closes its stream and the job's upstream (B8), the tab shown again reopens it with `after`;
 * - Pause → "paused before step n", no step moves for 2 s while the picture still updates, Resume → the run ends;
 * - a capture: the picture OFF by default (no `frames` asked, no frame drawn), the toggle shows it (`frames: true`,
 *   frames drawn); a second tab follows it too, a third gets the 503 fallback (run_status) without breaking the others;
 *   Pause works on a capture too (part D: "the video does not show the pause"); Stop while paused → cancelled, its
 *   teardown hook said in words;
 * - the Sessions panel (Sign in = a headed job, here answered by a stub so no window opens; Cancel) and the capture's
 *   confirmation for a persona never signed in: nothing is sent before the person confirms, then `sessions_ack`, and
 *   the run's own preflight result is the first row (it stops before filming). Review B L4: the dialog closes before
 *   it goes — Escape gives focus back to Start capture, "Sign in first" moves it to that persona's Sign in button.
 *
 * The worker is killed by pid at the end whatever happened. `RETAKE_UI_SHOTS=<folder>` saves screenshots there.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkerLock } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO } from '../../engine/test/helpers.js';

const ENABLED = process.env.RETAKE_TEST_SLOW === '1';
const SHOTS = process.env.RETAKE_UI_SHOTS;
const P = 'live';
const RUN = { timeout: 120_000, interval: 200 };
const MARKUP = '<b>markup</b> stays text';

let product: Server;
let base: string;
let resets = 0;
let root: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const savedHome = process.env.RETAKE_HOME;
const workers = new Set<number>();
const consoleErrors: string[] = [];
/** Bodies of the page's POST /v1/live and /v1/call/<op> requests, in order. */
const streams: Array<Record<string, unknown>> = [];
const calls: Array<{ op: string; body: Record<string, unknown> }> = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(name: string, p: Page = page): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await p.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function noteWorker(): void {
  const w = readWorkerLock(root);
  if (w) workers.add(w.pid);
}

function watch(p: Page): void {
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  p.on('request', (r) => {
    if (r.method() !== 'POST') return;
    const u = new URL(r.url());
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.postData() ?? '{}') as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (u.pathname === '/v1/live') streams.push(body);
    const m = /^\/v1\/call\/([a-z_]+)$/.exec(u.pathname);
    if (m) calls.push({ op: m[1], body });
  });
}

/** An animated board (a box sliding forever), a members page, a sign-in page and a reset endpoint for the hooks. */
const BOARD = `<!doctype html><html><head><meta charset="utf-8"><title>Board</title><style>
body{margin:0;font:20px sans-serif;background:#f4f1ea}h1{margin:24px}
.track{position:relative;height:120px;margin:0 24px;background:#e3ddd0}
.box{position:absolute;top:20px;left:0;width:80px;height:80px;background:#2357d9;animation:slide 1.2s linear infinite alternate}
@keyframes slide{from{transform:translateX(0)}to{transform:translateX(900px);background:#d94e23}}
</style></head><body><h1>Live board</h1><div class="track"><div class="box"></div></div><p id="note">&lt;b&gt;markup&lt;/b&gt; stays text</p></body></html>`;

function serve(): Promise<void> {
  product = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/reset') {
      resets++;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    // The members page needs a session (a cookie nobody here sets): without one it sends to the sign-in page.
    if (req.url === '/members' && !/\bsession=ok\b/.test(req.headers.cookie ?? '')) {
      res.writeHead(302, { Location: '/sign-in' }).end();
      return;
    }
    const html = req.url === '/members' ? '<!doctype html><title>Members</title><h1>Members</h1>' : req.url === '/sign-in' ? '<!doctype html><title>Sign in</title><h1>Sign in</h1>' : BOARD;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  return new Promise((r) =>
    product.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(product.address() as AddressInfo).port}`;
      r();
    }),
  );
}

const holds = (n: number, s: number) => Array.from({ length: n }, () => `      - hold: ${s}`);

async function workspace(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'studio-ui-run-e2e-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  const dir = join(root, 'projects', P);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(
    join(dir, 'project.yaml'),
    [
      'version: 1',
      'name: Live board',
      'environments:',
      '  local:',
      `    app: ${base}`,
      '  signed-in:',
      `    app: ${base}`,
      'auth:',
      '  signed-in:',
      '    login_url: /sign-in',
      '    personas:',
      '      owner: {pages: [app], check: {url: "app:/members", expect_text: Members}}',
      'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
      'template: default',
      '',
    ].join('\n'),
  );
  const scenario = (name: string, lines: string[]) => writeFile(join(dir, 'scenarios', `${name}.yaml`), `${['version: 1', `video: ${name}`, ...lines].join('\n')}\n`);
  await scenario('watch', ['scenes:', '  - id: board', '    page: app', '    open: /', '    steps:', `      - wait_for: {text: ${JSON.stringify(MARKUP)}}`, ...holds(26, 0.6)]);
  await scenario('film', [
    'setup:',
    '  - name: reset',
    '    http: {method: POST, url: "{{app}}/api/reset"}',
    'teardown:',
    '  - name: reset',
    '    http: {method: POST, url: "{{app}}/api/reset"}',
    'scenes:',
    '  - id: board',
    '    page: app',
    '    open: /',
    '    steps:',
    ...holds(30, 0.8),
  ]);
  await scenario('members', ['env: signed-in', 'scenes:', '  - id: list', '    page: app', '    open: /members', '    steps:', '      - hold: 0.5']);
}

const frames = (p: Page = page) => p.getByTestId('live-canvas').evaluate((c) => Number((c as HTMLCanvasElement).dataset.frames ?? 0));
const stepsDone = (p: Page = page) => p.locator('[data-testid="run-step"][data-status="ok"], [data-testid="run-step"][data-status="dry"]').count();
const runIdOf = (p: Page = page) => decodeURIComponent(/\/run\/([^/]+)$/.exec(new URL(p.url()).hash)?.[1] ?? '');

describe.skipIf(!ENABLED)('the Run screen with the real worker (RETAKE_TEST_SLOW=1)', () => {
  beforeAll(async () => {
    await serve();
    await workspace();
    studio = await startStudioServer({ root, workerIdleExitMs: 5000 });
    const executablePath = process.env.RETAKE_CHROMIUM;
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    watch(page);
    await page.goto(studio.launchUrl());
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    // A worker spawned just before a failure may write its lock a moment later: read it twice.
    if (root) {
      noteWorker();
      await sleep(1500);
      noteWorker();
    }
    for (const pid of workers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* exited on its own */
      }
    }
    await new Promise<void>((r) => (product ? product.close(() => r()) : r()));
    if (savedHome === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = savedHome;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a dry run watched live: frames, steps, log; a hidden tab closes the stream; pause / resume; the outcome', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/watch/run`);
    // L5.11a: Prepare a take (Shoot's first screen), then the live screen.
    await page.getByRole('heading', { level: 1, name: 'Prepare a take of watch' }).waitFor();
    // The preflight first: the sessions (none on this environment), then Start.
    await expect.poll(() => page.getByTestId('preflight-sessions').innerText(), RUN).toContain('None needed on');
    await shot('40-run-preflight');
    await page.getByTestId('start-dry').click();
    await expect.poll(() => runIdOf(), RUN).toMatch(/^\d{8}-\d{6}-watch$/);
    const runId = runIdOf();
    noteWorker();
    // The picture: on by default for a dry run (no `frames` asked), frames drawn, pixels that vary.
    await expect.poll(() => frames(), RUN).toBeGreaterThan(3);
    expect(streams.at(-1)).toEqual({ project: P, run_id: runId });
    expect(await page.getByTestId('picture-toggle').getAttribute('aria-pressed')).toBe('true');
    const colours = await page.getByTestId('live-canvas').evaluate((c) => {
      const d = (c as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 960, 540).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    });
    expect(colours).toBeGreaterThan(5);
    // Steps from the outline, progressing; the step holding markup is text (no element made of it).
    await expect.poll(() => page.locator('[data-testid="run-step"]').count(), RUN).toBe(27);
    await expect.poll(() => stepsDone(), RUN).toBeGreaterThan(2);
    expect(await page.getByTestId('run-steps').innerText()).toContain(MARKUP);
    expect(await page.locator('[data-testid="run-steps"] b, [data-testid="run-log"] b').count()).toBe(0);
    await expect.poll(() => page.getByTestId('log-line').count(), RUN).toBeGreaterThan(0);
    expect(await page.getByTestId('run-facts').innerText()).toMatch(/running/);
    // One polite status line on the screen (no live region for frames, steps or log lines); labelled controls.
    expect(await page.locator('.sp-screen [aria-live], .sp-screen [role="status"], .sp-screen [role="log"], .sp-screen [role="alert"]').count()).toBe(1);
    expect(await page.getByTestId('run-status-line').innerText()).toBe('Running.');
    expect(await page.getByRole('img', { name: /Live picture of the page the run is acting on/ }).count()).toBe(1);
    expect(await page.getByRole('progressbar', { name: 'Steps done' }).count()).toBe(1);
    await shot('41-run-dry-live');

    // B8: a hidden tab closes its stream — the Studio's upstream to the worker goes too — and reopens it with `after`.
    expect(studio.runLive.streamCount).toBe(1);
    const before = streams.length;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => studio.runLive.streamCount, RUN).toBe(0);
    await expect.poll(() => studio.runLive.upstreams, RUN).toBe(0);
    const hiddenAt = await frames();
    await sleep(1200);
    expect(await frames()).toBe(hiddenAt);
    expect(streams.length).toBe(before);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => studio.runLive.streamCount, RUN).toBe(1);
    const reopened = streams.at(-1)!;
    expect(reopened).toMatchObject({ project: P, run_id: runId, after: { log: expect.any(Number) } });
    expect((reopened.after as { log: number }).log).toBeGreaterThan(0);
    await expect.poll(() => frames(), RUN).toBeGreaterThan(hiddenAt);
    // No duplicate after the reconnect: each step once.
    expect(await page.locator('[data-testid="run-step"]').count()).toBe(27);

    // Pause before the next step: nothing moves for 2 s but the picture (the board animates), then Resume.
    // By keyboard: Enter on Pause, Space on Resume.
    await page.getByTestId('run-pause').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('controls-why').innerText(), RUN).toMatch(/^Paused before step \d+ of board/);
    expect(await page.getByTestId('run-status-line').innerText()).toBe('Paused.');
    expect(await page.getByText('paused before this step').count()).toBe(1);
    const atPause = await stepsDone();
    const framesAtPause = await frames();
    await sleep(2000);
    expect(await stepsDone()).toBe(atPause);
    expect(await frames()).toBeGreaterThan(framesAtPause);
    expect(await page.getByTestId('run-facts').innerText()).toMatch(/paused/);
    expect(calls.filter((c) => c.op === 'run_pause').map((c) => c.body)).toEqual([{ project: P, run_id: runId, paused: true }]);
    await shot('42-run-dry-paused');
    await page.getByTestId('run-resume').focus();
    await page.keyboard.press(' ');
    await expect.poll(() => stepsDone(), RUN).toBeGreaterThan(atPause);
    expect(calls.filter((c) => c.op === 'run_pause').at(-1)?.body).toEqual({ project: P, run_id: runId, paused: false });

    // The outcome: succeeded, every step done, the stream ended (no upstream left).
    await expect
      .poll(
        () =>
          page
            .getByTestId('run-outcome')
            .getAttribute('data-status')
            .catch(() => null),
        RUN,
      )
      .toBe('succeeded');
    expect(await stepsDone()).toBe(27);
    expect(await page.getByTestId('run-pause').count()).toBe(0);
    await expect.poll(() => studio.runLive.streamCount, RUN).toBe(0);
    expect(studio.runLive.upstreams).toBe(0);
    await shot('43-run-dry-ended');
  }, 300_000);

  it('a capture: the picture off by default, shown on request; a third tab falls back to run_status; Stop runs the teardown', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/film/run`);
    await page.getByRole('heading', { level: 1, name: 'Prepare a take of film' }).waitFor();
    const resetsBefore = resets;
    await page.getByTestId('start-capture').click();
    await expect.poll(() => runIdOf(), RUN).toMatch(/^\d{8}-\d{6}-film$/);
    const runId = runIdOf();
    noteWorker();
    await expect.poll(() => stepsDone(), RUN).toBeGreaterThan(1);
    // Off by default: no `frames` asked (the server's capture default), nothing drawn, the toggle says how to show it.
    expect(streams.filter((s) => s.run_id === runId).every((s) => !('frames' in s))).toBe(true);
    expect(await frames()).toBe(0);
    const toggle = page.getByTestId('picture-toggle');
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    expect(await toggle.innerText()).toBe('Show live picture');
    expect(await page.getByTestId('picture-state').innerText()).toContain('Live picture hidden');
    expect(await page.getByTestId('picture-help').innerText()).toContain('costs');
    expect(studio.runLive.upstreams).toBe(0);
    // A capture pauses too (part D): the button is enabled and says the video does not show the pause.
    expect(await page.getByTestId('run-pause').isDisabled()).toBe(false);
    expect(await page.getByTestId('controls-why').innerText()).toContain('(the video does not show the pause)');
    await shot('44-run-capture-picture-off');
    await toggle.click();
    await expect.poll(() => streams.at(-1), RUN).toMatchObject({ run_id: runId, frames: true, after: { log: expect.any(Number) } });
    await expect.poll(() => frames(), RUN).toBeGreaterThan(3);
    expect(await toggle.getAttribute('aria-pressed')).toBe('true');
    await expect.poll(() => studio.runLive.upstreams, RUN).toBe(1);
    await shot('45-run-capture-picture-on');

    // A second tab follows the same run (the Studio's one upstream fans out); a third gets 503 → run_status.
    // Each tab opens its own session (a Studio link works once, in one tab), then the run's route.
    const open = async (): Promise<Page> => {
      const tab = await context.newPage();
      watch(tab);
      await tab.goto(studio.launchUrl());
      await tab.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
      await tab.goto(page.url());
      return tab;
    };
    const second = await open();
    await expect.poll(() => second.locator('[data-testid="run-step"]').count(), RUN).toBe(30);
    await expect.poll(() => studio.runLive.streamCount, RUN).toBe(2);
    const third = await open();
    await third.getByTestId('run-busy').waitFor({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (
            await third
              .getByTestId('run-steps-done')
              .innerText()
              .catch(() => '')
          ).match(/^\d+ \/ 30 steps done/) !== null,
        RUN,
      )
      .toBe(true);
    expect(await third.getByTestId('picture-state').innerText()).toContain('another live screen');
    await shot('46-run-third-tab-fallback', third);
    await third.close();
    await second.close();
    await expect.poll(() => studio.runLive.streamCount, RUN).toBe(1);
    expect(await frames()).toBeGreaterThan(3);

    // Pause the capture (between steps), then Stop while paused: run_cancel, then the teardown said in words.
    await page.getByTestId('run-pause').click();
    await expect.poll(() => page.getByTestId('run-status-line').innerText(), RUN).toBe('Paused.');
    expect(calls.filter((c) => c.op === 'run_pause').at(-1)?.body).toEqual({ project: P, run_id: runId, paused: true });
    expect(await page.getByTestId('controls-why').innerText()).toContain('The video does not show the pause');
    const atPause = await stepsDone();
    await sleep(1500);
    expect(await stepsDone()).toBe(atPause);
    await shot('46b-run-capture-paused');
    await page.getByTestId('run-stop').click();
    expect(calls.filter((c) => c.op === 'run_cancel').at(-1)?.body).toEqual({ project: P, run_id: runId });
    await expect
      .poll(
        () =>
          page
            .getByTestId('run-outcome')
            .getAttribute('data-status')
            .catch(() => null),
        RUN,
      )
      .toBe('cancelled');
    const outcome = await page.getByTestId('run-outcome').innerText();
    expect(outcome).toContain('Its teardown ran: reset ok');
    expect(outcome).toContain('No rollback was pending');
    expect(await page.locator('[data-testid="run-hook"][data-phase="teardown"][data-status="ok"]').count()).toBe(1);
    expect(resets - resetsBefore).toBe(2);
    expect(await page.locator('[data-testid="run-step"][data-status="not_reached"]').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-testid="run-step"][data-status="failed"]').count()).toBe(0);
    expect(await page.locator('[data-testid="run-step"][data-status="stopped"]').count()).toBeLessThanOrEqual(1);
    expect(await page.getByTestId('run-status-line').innerText()).toBe('The run was stopped.');
    await expect.poll(() => studio.runLive.upstreams, RUN).toBe(0);
    await shot('47-run-capture-stopped');
  }, 300_000);

  it('the Sessions panel (Sign in, Cancel) and the confirmation before capturing with a session never signed in', async () => {
    // Sign in = a headed window for the person: stubbed here (no window on a test machine) — the request is checked.
    const job = { id: 'j_20261026T120000Z_abcdef', kind: 'auth_login', state: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString() };
    await page.route('**/v1/call/auth_login', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: job }) }));
    await page.route('**/v1/call/job_list', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { jobs: [job], worker: null } }) }));
    await page.route('**/v1/call/sign_in_cancel', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { id: job.id, kind: 'auth_login', state: 'cancelled' } }) }),
    );
    // L5.10a: the Sessions panel lives on the Cast (the project page it was on is the poster grid now).
    await page.goto(`${studio.url}#/p/${P}/cast`);
    const panel = page.getByTestId('sessions-panel');
    // L5.11a: a persona never signed in is a missing session (a state word beside its shape); one section per location.
    await expect.poll(() => panel.innerText(), RUN).toContain('Missing session');
    const row = panel.locator('[data-testid="session-row"][data-persona="owner"]');
    expect(await row.locator('xpath=ancestor::section[1]').innerText()).toContain('signed-in');
    await row.getByRole('button', { name: 'Sign in owner (signed-in)' }).click();
    await expect.poll(() => row.getByTestId('sign-in-state').innerText(), RUN).toContain('sign in there yourself, then close it');
    expect(await row.getByTestId('sign-in-state').innerText()).toContain('time limit');
    expect(calls.filter((c) => c.op === 'auth_login').map((c) => c.body)).toEqual([{ project: P, persona: 'owner', env: 'signed-in' }]);
    await shot('48-sessions-sign-in');
    await row.getByRole('button', { name: 'Cancel the sign-in of owner' }).click();
    // The stub's job has no result yet: nothing more is claimed than what is sure (review A L5).
    await expect.poll(() => row.getByTestId('sign-in-state').innerText(), RUN).toContain('Stopped: the saved session was not updated.');
    expect(calls.filter((c) => c.op === 'sign_in_cancel').map((c) => c.body)).toEqual([{ job: job.id }]);
    await page.unrouteAll();

    // The capture's confirmation: shown before anything is sent; Escape closes it and sends nothing.
    await page.goto(`${studio.url}#/p/${P}/s/members/run`);
    await expect.poll(() => page.getByTestId('preflight-sessions').innerText(), RUN).toContain('Missing session');
    expect(await page.getByTestId('preflight-confirm-note').innerText()).toContain('A capture asks first');
    const sent = () => calls.filter((c) => c.op === 'scenario_run' && c.body.name === 'members').length;
    await page.getByTestId('start-capture').click();
    const dialog = page.getByTestId('confirm-sessions');
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain('stops before filming');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('confirm-sign-in-first');
    expect(sent()).toBe(0);
    await shot('49-confirm-dialog');
    await page.keyboard.press('Escape');
    // L5.11a: the shell's one sheet (the kit's) stays in the document, closed.
    await expect.poll(() => dialog.isVisible(), RUN).toBe(false);
    expect(sent()).toBe(0);
    // Focus back on the button that opened the dialog; "Sign in first" moves it to that persona's Sign in button.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), RUN).toBe('start-capture');
    await page.getByTestId('start-capture').click();
    await page.getByTestId('confirm-sign-in-first').click();
    await expect.poll(() => dialog.isVisible(), RUN).toBe(false);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')), RUN).toBe('Sign in owner (signed-in)');
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="preflight-sessions"]') !== null)).toBe(true);
    expect(sent()).toBe(0);
    await page.getByTestId('start-capture').click();
    await page.getByTestId('confirm-capture-anyway').click();
    await expect.poll(() => runIdOf(), RUN).toMatch(/^\d{8}-\d{6}-members$/);
    expect(calls.filter((c) => c.op === 'scenario_run' && c.body.name === 'members').map((c) => c.body.sessions_ack)).toEqual([['owner']]);
    noteWorker();
    // The run's own preflight is the authority: its result is the first row, and nothing is filmed.
    await expect
      .poll(
        () =>
          page
            .getByTestId('run-outcome')
            .getAttribute('data-status')
            .catch(() => null),
        RUN,
      )
      .toBe('failed');
    const first = page.locator('[data-testid="run-steps"] [data-testid="run-session"]').first();
    expect(await first.getAttribute('data-persona')).toBe('owner');
    expect(await first.getAttribute('data-status')).toBe('failed');
    expect(await page.getByTestId('run-steps').innerText()).toContain('the run stops before filming');
    // The preflight's error is the tool's, not a page's: said plainly, not boxed as text the site controls (review B L9).
    expect(await page.getByTestId('outcome-error').getAttribute('data-from')).toBe('run');
    expect(await page.getByTestId('run-outcome').innerText()).not.toContain('text the site controls');
    expect(await frames()).toBe(0);
    await shot('50-capture-preflight-failed');
    expect(consoleErrors).toEqual([]);
  }, 300_000);
});
