/**
 * L4.8 part 5: the Record screen end to end — the built-in Studio server on a scratch workspace and home, headless
 * Chromium on the Studio app, the fixture product on this test's own ports (4551–4554), and the `record` job run by a
 * worker IN THIS PROCESS with Playwright playing the person in the recording window (`recordTest.drive`: a worker
 * process cannot receive it — the real headed window with a person switching to the Studio is MACOS-CHECKLIST 13i).
 * While the window is open, the test works the Studio page as the person would. Covered:
 *
 * - the project page's Record button → the start form (the window note: full size, the desktop layout filmed) → Start
 *   → the recording's route, its state live;
 * - a pick on a click that later folds: the Email click shows its verified alternatives, one is picked, then the typing
 *   folds the click into one `type {into}` step that keeps the pick;
 * - a password typed in the window: the draft shows `{{vars.password_1}}` only; the sentinel is nowhere (files, every
 *   op answer the page got, the page's text, the Studio's log and stderr, the worker's log);
 * - a blur mid-word (a Studio visit commits the typing): "Two wo", the live draft shows it, then "rds" — one step;
 * - each quick insert at the end (caption with a kicker, mark, a zoom at the theme's max_zoom, hold 2 s, wait for a
 *   text): the modifiers wait for the next action ("applies to your next action"), then go on it; a scroll down to
 *   "Far away" (the recorder's scroll row, its target picked) and a button revealed then pressed after a pause (the
 *   recorder's wait row);
 * - the cursor by row identity (review B-H1 / B-M1): a hold after a chosen step, after the recorder's scroll row and
 *   after its wait row goes immediately after that row; the cursor moves onto the hold, and the next one goes right
 *   after it; each row's Insert after names its step;
 * - one Stop visible while recording (the inspector's "Stop recording"; the status bar says "Recording · browser window
 *   open" with the counts and holds the actions slot, L5.11a review A-L7 / L5.11b);
 * - L5.11b (critique L2 / H1 of L5.11): while a recording goes, Rehearse and Capture send nothing and say why (the
 *   scenario remembered in context is never run from the Record route); ⌘. stops the recording — after a reload too;
 * - L5.11b: the Discard sheet — "Keep it" holds the focus, Return keeps it (nothing sent), Discard then discards and the
 *   focus lands on the title; after Save the focus is in the centre pane (never dropped);
 * - Stop and keep → the check replay passed; Save: a taken name refused (the file untouched), then a new scenario (no
 *   YAML alias: the block editor deletes and duplicates the scroll row) and the scenario screen;
 * - the hostile flagged page (`/record-lab?hostile=1`): its label shown as inert text (no script ran, the direction
 *   override shown as [U+202E]); saved, its step is left out (hidden_text): no hidden character in the file;
 * - Discard while the window is open: a neutral "discarded", no danger notice, the note gone (review B-M5);
 * - a recording Claude started: read-only; a preflight refusal (a persona not signed in): the Sessions panel's Sign in.
 *
 * `RETAKE_UI_SHOTS=<folder>` saves screenshots there (1280 and 1600 wide).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyStepEdit, firstHiddenChar, parseScenario, stepGuard } from '@retake/core';
import { FileJobQueue, newRecordId, runWorker, selfIdentity } from '@retake/engine';
import type { JobRecord, RecordJobTestHooks } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { RecordViewAnswer, StudioServer } from '../src/index.js';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

type Window = Parameters<NonNullable<RecordJobTestHooks['drive']>>[0];

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

const P = 'northfield-fixture';
const SHOTS = process.env.RETAKE_UI_SHOTS;
const SENTINEL = `Sentinel-${randomBytes(6).toString('hex')}`;
const POLL = { timeout: 20_000, interval: 150 };
const saved = { home: process.env.RETAKE_HOME, max: process.env.RETAKE_RECORD_MAX_MIN };
let fixture: Fixture;
let ws: string;
let studio: StudioServer;
let queue: FileJobQueue;
let browser: Browser;
let page: Page;
const logs: string[] = [];
const workerLogs: string[] = [];
const stderr: string[] = [];
const answers: string[] = [];
/** Every op the page called, in order (`/v1/call/<op>`). */
const calls: string[] = [];
const consoleErrors: string[] = [];
const writeErr = process.stderr.write.bind(process.stderr);

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

const recDir = (id: string) => join(ws, 'projects', P, '.retake', 'records', id);
const recOf = () => /#\/p\/[^/]+\/record\/([^/]+)$/.exec(page.url())?.[1] ?? '';
const stateOf = () => page.getByTestId('record-state').first().getAttribute('data-state');
const said = () => page.locator('.sh-said').innerText();
const command = (id: string) => page.evaluate((x) => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: x } })), id);
/** Selects a draft row (its option: the cursor goes right after it, its alternatives show), then waits for them. */
async function pickAlternatives(row: ReturnType<Page['locator']>) {
  await row.getByTestId('record-insert-after').click();
  expect(await row.getByTestId('record-insert-after').getAttribute('aria-selected')).toBe('true');
  const alts = page.getByTestId('record-alternatives');
  await alts.waitFor({ timeout: 20_000 });
  return alts;
}

/** The view as the server tells it (the test's own read; the page reads it too). */
async function view(rec: string): Promise<RecordViewAnswer> {
  const r = await raw(studio.port, 'POST', '/v1/call/record_view', { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify({ project: P, rec_id: rec }));
  answers.push(r.body);
  expect(r.status, r.body).toBe(200);
  return r.json<{ data: RecordViewAnswer }>().data;
}

/**
 * The in-process worker (one job), Playwright playing the person; the window closes after `drive` if still open. A drive
 * that throws fails the job — and the test, with the drive's own error (L5.11b fixes, review B-L2: not a later "failed").
 */
async function work(drive: (w: Window) => Promise<void>): Promise<number> {
  let failed: { error: unknown } | null = null;
  const code = await runWorker({
    root: ws,
    once: true,
    idleExitMs: 0,
    pollMs: 50,
    log: (m) => workerLogs.push(m),
    recordTest: {
      headless: true,
      windowSize: { width: 1400, height: 1000 },
      drive: async (w) => {
        await w.waitForLoadState('domcontentloaded');
        await w.waitForTimeout(800);
        try {
          await drive(w);
        } catch (error) {
          failed = { error };
          throw error;
        }
        await w.waitForTimeout(400).catch(() => undefined);
        await w.close().catch(() => undefined);
      },
    },
  });
  if (failed) throw (failed as { error: unknown }).error;
  return code;
}

/** Wait for the screen to show a state; a failed or cancelled job ends the wait at once, with the worker's log. */
async function untilState(want: string, timeout = 60_000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    const s = await stateOf();
    if (s === want) return;
    if ((s === 'failed' || s === 'cancelled') && want !== s) throw new Error(`the recording is ${s}: ${workerLogs.slice(-6).join(' | ')} — ${await page.getByTestId('record-job-error').textContent().catch(() => '')}`);
    if (Date.now() > end) throw new Error(`timed out waiting for the state ${want} (now ${s})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Fill the start form and Start: the recording's id from the route. */
async function startRecording(o: { path: string; name: string; env?: string }): Promise<string> {
  await page.goto(`${studio.url}#/p/${P}/record`);
  await page.getByTestId('record-start-form').waitFor();
  if (o.env) await page.getByTestId('record-env').selectOption(o.env);
  else {
    await page.getByTestId('record-page').selectOption('shop');
    await page.getByTestId('record-path').fill(o.path);
  }
  await page.getByTestId('record-name').fill(o.name);
  await page.getByTestId('record-start').click();
  await expect.poll(recOf, POLL).toMatch(/^rec_/);
  return recOf();
}

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: Record<string, unknown>): Promise<Fixture> };
  fixture = await mod.startFixture({ consolePort: 4551, shopPort: 4552, host: '127.0.0.1', auth: { consolePort: 4553, shopPort: 4554 } });
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-record-e2e-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  delete process.env.RETAKE_RECORD_MAX_MIN;
  await fixtureWorkspace(ws);
  const project = join(ws, 'projects', P);
  const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
  const strip = (u: string) => u.replace(/\/$/, '');
  await writeFile(
    join(project, 'project.yaml'),
    yaml
      .replaceAll('http://localhost:4401', strip(fixture.urls.console))
      .replaceAll('http://localhost:4402', strip(fixture.urls.shop))
      .replaceAll('http://localhost:4403', strip(fixture.urls.signedIn!.console))
      .replaceAll('http://localhost:4404', strip(fixture.urls.signedIn!.shop)),
  );
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (writeErr as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  studio = await startStudioServer({
    root: ws,
    startWorker: false,
    pollMs: 150,
    log: (m) => {
      logs.push(m);
      process.stderr.write(`${m}\n`);
    },
  });
  queue = new FileJobQueue(ws);
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('request', (r) => {
    const m = /\/v1\/call\/([a-z_]+)/.exec(new URL(r.url()).pathname);
    if (m) calls.push(m[1]);
  });
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/v1/call/')) void r.text().then((t) => answers.push(t), () => undefined);
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
}, 120_000);

afterAll(async () => {
  process.stderr.write = writeErr;
  await browser?.close();
  await studio?.close();
  await fixture?.close();
  if (ws) await rm(ws, { recursive: true, force: true });
  for (const [k, v] of [
    ['RETAKE_HOME', saved.home],
    ['RETAKE_RECORD_MAX_MIN', saved.max],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let lab = '';

describe('recording the lab from the Studio', () => {
  it('Record → the start form → the window open; a pick that folds, a password, a blur mid-word, each insert, Stop and keep', async () => {
    await page.goto(`${studio.url}#/p/${P}`);
    await page.getByTestId('record-link').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/record`);
    const note = await page.getByTestId('record-window-note').textContent();
    expect(note).toMatch(/full size/);
    expect(note).toMatch(/desktop layout/);
    expect(await page.locator('main').textContent()).not.toMatch(/side by side/i);
    await page.getByTestId('record-page').waitFor();
    await shot('record-start-1280');
    lab = await startRecording({ path: '/record-lab', name: 'e2e-draft' });
    expect(['queued', 'preflight']).toContain(await stateOf());

    let picked = '';
    await work(async (w) => {
      await w.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await expect.poll(stateOf, POLL).toBe('recording');
      expect(await page.getByTestId('record-sentence').textContent()).toMatch(/full size/);
      await expect.poll(() => page.getByTestId('record-time-left').textContent(), POLL).toMatch(/^\d+:\d\d left$/);

      // A pick on a click that later folds into the typing.
      await w.locator('#lab-email').click();
      // L5.11b: a row with verified alternatives says so on its right; pressing it shows them under it (a radio group).
      const emailRow = page.locator('[data-testid=record-step]', { has: page.locator('.k-rowcard-aside') }).first();
      await emailRow.waitFor({ timeout: 20_000 });
      expect(await emailRow.locator('.k-rowcard-aside').textContent()).toMatch(/^\d+ alternatives?$/);
      const alts = await pickAlternatives(emailRow);
      const options = alts.getByTestId('record-alternative');
      expect(await options.count()).toBeGreaterThanOrEqual(2);
      picked = ((await alts.locator('.k-radio').nth(1).locator('.rc-alt-words').textContent()) ?? '').trim();
      // The radio follows the server's answer (a controlled choice): a click, then the view says so.
      await options.nth(1).click();
      await expect.poll(() => alts.getByTestId('record-alt-state').textContent(), POLL).toMatch(/picked by you/);
      expect(await options.nth(1).isChecked()).toBe(true);
      // Only the selected row shows its alternatives.
      expect(await page.getByTestId('record-alternatives').count()).toBe(1);
      // Back to the end: the next inserts follow the next actions.
      await page.getByTestId('record-cursor-end').click();
      await expect.poll(() => page.getByTestId('record-cursor-where').textContent(), POLL).toMatch(/^Insert at the end/);
      await w.keyboard.type('buyer@example.com');

      // A password: a placeholder only.
      await w.locator('#lab-password').click();
      await w.keyboard.type(SENTINEL);

      // A blur mid-word (a visit to the Studio commits the typing), then the rest of the word.
      const noteField = w.getByLabel('Note');
      await noteField.click();
      await w.keyboard.type('Two wo');
      await noteField.blur();
      await expect.poll(() => page.getByTestId('record-draft').textContent(), POLL).toContain('Two wo');
      await noteField.focus();
      await w.keyboard.type('rds');
      await noteField.blur();
      await expect.poll(() => page.getByTestId('record-draft').textContent(), POLL).toContain('Two words');

      // Each quick insert at the end: the modifiers wait for the next action.
      await page.getByTestId('record-insert-caption').click();
      await page.getByTestId('record-caption-text').fill('Pick a bag size');
      await page.getByTestId('record-caption-kicker').fill('Order');
      await page.getByTestId('record-caption-text').press('Enter');
      await page.getByTestId('record-pending').waitFor();
      await page.getByTestId('record-insert-mark').click();
      await expect.poll(() => page.getByTestId('record-pending').getByTestId('record-insert-chip').count(), POLL).toBe(2);
      // Zoom…: the theme's factors, its maximum (1.4) the default (L5.11b: a disclosure like Wait for… and Caption…).
      expect(await page.getByTestId('record-insert-zoom').textContent()).toBe('Zoom…');
      await page.getByTestId('record-insert-zoom').click();
      expect(await page.getByRole('radio', { name: /^1\.4×/ }).isChecked()).toBe(true);
      await page.getByTestId('record-zoom-add').click();
      await expect.poll(() => page.getByTestId('record-pending').getByTestId('record-insert-chip').count(), POLL).toBe(3);
      await page.getByTestId('record-insert-hold').click();
      await expect.poll(() => page.locator('[data-testid=record-step][data-role=insert]').count(), POLL).toBe(1);
      await page.getByTestId('record-insert-wait').click();
      await page.getByLabel('a text shows').check();
      await page.getByTestId('record-wait-text').fill('Forgery');
      await page.getByTestId('record-wait-text').press('Enter');
      await expect.poll(() => page.locator('[data-testid=record-step][data-role=insert]').count(), POLL).toBe(2);
      // Escape closes a disclosure and gives focus back to its button.
      await page.getByTestId('record-insert-caption').click();
      await page.getByTestId('record-caption-text').press('Escape');
      expect(await page.getByTestId('record-caption-text').count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('record-insert-caption');
      expect(await page.getByTestId('record-pending').textContent()).toMatch(/Applies to your next action/);
      await shot('record-live-1280');

      // The next action takes the modifiers.
      await w.getByRole('button', { name: 'Forgery target' }).click();
      await expect.poll(() => page.getByTestId('record-pending').count(), POLL).toBe(0);
      // Further down: a scroll to "Far away" (the recorder's scroll row), its target picked (an object target the scroll
      // row shares); a button revealed by another and pressed after a pause (the recorder's wait row).
      // A wheel in steps, as a person scrolls (one instant jump of 2400 px is scrolled before the recorder sees the wheel).
      await w.mouse.move(700, 500);
      for (let i = 0; i < 8; i++) {
        await w.mouse.wheel(0, 300);
        await w.waitForTimeout(60);
      }
      await w.waitForTimeout(700);
      await w.getByRole('button', { name: 'Far away' }).click();
      const farRow = page.locator('[data-testid=record-step][data-role=action]', { hasText: 'Far away' });
      await farRow.locator('.k-rowcard-aside').waitFor({ timeout: 20_000 });
      const far = await pickAlternatives(farRow);
      await far.locator('.k-radio', { hasText: 'lab-far', hasNotText: '#lab-far' }).getByTestId('record-alternative').click();
      await expect.poll(() => far.getByTestId('record-alt-state').textContent(), POLL).toMatch(/picked by you/);
      // The inspector shows the selected step.
      expect(await page.getByTestId('record-step-inspector').textContent()).toMatch(/Step \d+ · /);
      await page.getByTestId('record-cursor-end').click();
      await w.getByRole('button', { name: 'Unlock the last step' }).click();
      await w.waitForTimeout(1700);
      await w.getByRole('button', { name: 'Delayed control' }).click();
      await expect.poll(() => page.locator('[data-testid=record-step][data-helper=wait]').count(), POLL).toBe(1);
      expect(await page.locator('[data-testid=record-step][data-helper=scroll]').count()).toBe(1);
      // L5.11a (review A-L7) / L5.11b: while recording, ONE Stop is visible — the inspector's; the status bar says
      // "Recording · browser window open" with the counts and holds the actions slot (no Rehearse / Capture / second
      // Stop there), and no scenario's state line beside it.
      await page.getByTestId('status-recording').waitFor(POLL);
      const stops = await page.getByRole('button', { name: /^(Stop|Stop and keep|Stop recording|Cancel recording)$/ }).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.textContent?.trim()));
      expect(stops).toEqual(['Stop recording']);
      expect(await page.locator('.sh-inspector').getByTestId('record-stop').count()).toBe(1);
      expect(await page.getByTestId('status-actions').count()).toBe(0);
      expect(await page.getByTestId('status-scenario').count()).toBe(0);
      expect(await page.getByTestId('status-recording').textContent()).toMatch(/^Recording · browser window open · \d+ actions · 5 inserts · draft updated (just now|\d+ s ago)$/);
      // Stop and keep from the Studio: the window closes as if closed.
      await page.getByTestId('record-stop').click();
      await w.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);
    });
    // A drive that threw fails the job: say why.
    expect(workerLogs.filter((l) => /: failed \(/.test(l))).toEqual([]);
    await untilState('done');
    await expect.poll(() => page.getByTestId('record-check').getAttribute('data-status'), POLL).toBe('passed');
    expect(existsSync(join(ws, 'projects', P, 'scenarios', 'e2e-draft.yaml'))).toBe(false);
    const v = await view(lab);
    expect(v).toMatchObject({ state: 'done', started_by: 'ui', can: { annotate: true, save: true, discard: true, stop: false }, check: { status: 'passed' } });
    const yaml = v.untrusted!.yaml_lines.join('\n');
    // The pick followed the fold: one typing step into the picked target.
    const typing = v.untrusted!.blocks.entries.flatMap((e) => (e.type === 'scene' ? e.steps : [])).filter((s) => s.action === 'type');
    expect(typing.map((s) => s.target)).toContain(picked);
    expect(typing.find((s) => s.target === picked)?.summary).toMatch(/buyer@example\.com/);
    // The choice in effect on that step is the one made on the click (the latest press of the target that has one).
    expect(v.untrusted!.sources.some((x) => x.role === 'action' && x.chosen?.index === 1)).toBe(true);
    expect(await page.locator('.k-rowcard-aside', { hasText: 'Target picked by you' }).count()).toBeGreaterThanOrEqual(1);
    // Over: the status bar is the defaults' again (the recording no longer claims it).
    await expect.poll(() => page.getByTestId('status-recording').count(), POLL).toBe(0);
    expect(yaml).toContain('{{vars.password_1}}');
    // One step for the split word.
    expect(yaml).toContain('Two words');
    expect(yaml).not.toMatch(/text: "?rds/);
    expect(v.untrusted!.inserts.map((i) => i.kind).sort()).toEqual(['camera', 'caption', 'hold', 'mark', 'wait_for']);
    expect(v.untrusted!.pending).toEqual([]);
    const forgery = v.untrusted!.sources.find((s) => s.modifiers && s.modifiers.length === 3);
    expect(forgery?.role).toBe('action');
    for (const t of ['caption:', 'Pick a bag size', 'mark: m1', 'zoom: 1.4', 'hold: 2', 'Forgery', 'scroll: {to: {testid: lab-far}}', 'wait_for: {target: Delayed control']) expect(yaml, t).toContain(t);
    expect(yaml).not.toMatch(/[&*]a\d/);
  }, 240_000);

  it('the cursor by row identity: a hold after a chosen step, after the recorder\'s scroll and wait rows, right after that row; Remove; the screens at 1280 and 1600', async () => {
    /** The draft's rows and the cursor line, in screen order (`role:helper:row`). */
    const rows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid=record-step], [data-testid=record-cursor]')].map((e) =>
          e.getAttribute('data-testid') === 'record-cursor' ? 'CURSOR' : `${e.getAttribute('data-role')}:${e.getAttribute('data-helper')}:${e.getAttribute('data-row')}`,
        ),
      );
    const inserts = async () => (await view(lab)).untrusted!.inserts;
    const after = async (rowSel: string) => {
      const row = page.locator(rowSel).first();
      const id = (await row.getAttribute('data-row'))!;
      // L5.11b: the row itself is an option of its scene's listbox (its name its own words); selected, the toolbar right
      // after it says where.
      const btn = row.getByTestId('record-insert-after');
      expect(await btn.getAttribute('aria-selected')).toBe('false');
      await btn.click();
      expect(await btn.getAttribute('aria-selected')).toBe('true');
      expect(await page.getByTestId('record-cursor-where').textContent()).toMatch(/^Insert after step \d+ of /);
      return id;
    };
    const holdAt = async (n: number) => {
      await page.getByTestId('record-insert-hold').click();
      await expect.poll(async () => (await inserts()).length, POLL).toBe(n);
      const added = (await inserts()).at(-1)!;
      await expect.poll(async () => (await rows()).includes(`insert::i:${added.id}`), POLL).toBe(true);
      return `insert::i:${added.id}`;
    };
    const before = (await inserts()).length;

    // After the first step: the hold is the row right after it, and the cursor moves onto the hold.
    const first = await after('[data-testid=record-step]');
    expect(await page.getByTestId('record-cursor-where').textContent()).toMatch(/after step 1 of/);
    const h1 = await holdAt(before + 1);
    let r = await rows();
    expect(r.slice(r.findIndex((x) => x.endsWith(`:${first}`)), r.findIndex((x) => x.endsWith(`:${first}`)) + 3)).toEqual([expect.stringMatching(new RegExp(`:${first}$`)), h1, 'CURSOR']);
    await expect.poll(() => page.getByTestId('record-cursor-where').textContent(), POLL).toMatch(/after step 2 of/);
    // Remove takes it out again (L5.11b fixes: the selected row's Remove is in its cursor block — the cursor is on the hold);
    // the cursor's row is gone: back to the end.
    expect(await page.locator(`[data-testid=record-step][data-row="${h1.split('::')[1]}"]`).getByTestId('record-insert-after').getAttribute('aria-selected')).toBe('true');
    await page.getByTestId('record-cursor').getByTestId('record-insert-remove').click();
    await expect.poll(async () => (await inserts()).length, POLL).toBe(before);
    await expect.poll(() => page.getByTestId('record-cursor-where').textContent(), POLL).toMatch(/at the end/);

    // After the recorder's scroll row: between the scroll and its press — then the next hold right after the first.
    const scroll = await after('[data-testid=record-step][data-helper=scroll]');
    const s1 = await holdAt(before + 1);
    const s2 = await holdAt(before + 2);
    r = await rows();
    const at = r.findIndex((x) => x === `helper:scroll:${scroll}`);
    expect(r.slice(at, at + 5)).toEqual([`helper:scroll:${scroll}`, s1, s2, 'CURSOR', expect.stringMatching(/^action::a\d+$/)]);
    // The press after them is the "Far away" click (its target picked earlier: the test id, L5.11b shows the pick in the row).
    expect(await page.locator('[data-testid=record-step]').nth(r.slice(0, at + 4).filter((x) => x !== 'CURSOR').length).textContent()).toContain('lab-far');

    // After the recorder's wait row: between the wait and its press.
    const wait = await after('[data-testid=record-step][data-helper=wait]');
    const w1 = await holdAt(before + 3);
    r = await rows();
    const wi = r.findIndex((x) => x === `helper:wait:${wait}`);
    expect(r.slice(wi, wi + 4)).toEqual([`helper:wait:${wait}`, w1, 'CURSOR', expect.stringMatching(/^action::a\d+$/)]);
    expect(await page.locator('[data-testid=record-step]').nth(r.slice(0, wi + 3).filter((x) => x !== 'CURSOR').length).textContent()).toContain('Delayed control');
    // The server placed them there too (the saved scenario holds this order).
    const yaml = (await view(lab)).untrusted!.yaml_lines.join('\n');
    expect(yaml).toMatch(/scroll: \{to: \{testid: lab-far\}\}\n\s+- hold: 2\n\s+- hold: 2\n\s+- click: \{testid: lab-far\}/);
    expect(yaml).toMatch(/wait_for: \{target: Delayed control[^\n]*\n\s+- hold: 2\n\s+- click: Delayed control/);

    await page.getByTestId('record-cursor-end').click();
    expect(await page.getByTestId('record-cursor-where').textContent()).toMatch(/at the end/);
    await page.setViewportSize({ width: 1280, height: 900 });
    await shot('record-done-1280');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await shot('record-done-1600');
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  it('Save: a taken name refused (the file untouched), then a new scenario and its screen', async () => {
    const quote = await readFile(join(ws, 'projects', P, 'scenarios', 'quote.yaml'), 'utf8');
    await page.getByTestId('record-save-name').fill('quote');
    await page.getByTestId('record-save').click();
    await page.getByTestId('record-save-taken').waitFor();
    expect(await page.getByTestId('record-save-taken').textContent()).toMatch(/choose another name/);
    expect(await readFile(join(ws, 'projects', P, 'scenarios', 'quote.yaml'), 'utf8')).toBe(quote);
    await page.getByTestId('record-save-name').fill('e2e-lab');
    await page.getByTestId('record-save').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/s/e2e-lab`);
    await page.getByTestId('step').first().waitFor();
    // L5.11b: the focus is never dropped — the Save button went with the screen; the centre pane holds it.
    expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)).toBe(true);
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#main')))).toBe(true);
    const text = await readFile(join(ws, 'projects', P, 'scenarios', 'e2e-lab.yaml'), 'utf8');
    for (const t of ['{{vars.password_1}}', 'Two words', 'Pick a bag size', 'mark: m1', 'zoom: 1.4', 'hold: 2']) expect(text, t).toContain(t);
    expect(text).not.toContain(SENTINEL);
    // No YAML alias (review B-M2): the block editor deletes or duplicates the recorder's scroll row (it shares the picked
    // target with its press).
    expect(text).not.toMatch(/[&*]a\d/);
    const parsed = parseScenario(text).scenario as unknown as { scenes: Array<{ id: string; steps: Array<Record<string, unknown>> }> };
    const sc = parsed.scenes.find((x) => x.steps.some((st) => 'scroll' in st))!;
    const index = sc.steps.findIndex((st) => 'scroll' in st);
    for (const kind of ['delete_step', 'duplicate_step'] as const) {
      const edited = applyStepEdit(text, { kind, at: { scene: sc.id, index, guard: stepGuard(sc.steps[index]) } } as never);
      expect(parseScenario(edited.text).issues.filter((i) => i.severity === 'error'), kind).toEqual([]);
    }
    expect(await page.getByTestId('step').count()).toBeGreaterThanOrEqual(6);
    // Back on the recording: saved, read-only now, with the links.
    await page.goto(`${studio.url}#/p/${P}/record/${lab}`);
    await page.getByTestId('record-saved').waitFor();
    expect(await page.getByTestId('record-save').count()).toBe(0);
    expect(await page.getByTestId('record-insert-hold').count()).toBe(0);
    // The start form's recent list says so.
    await page.goto(`${studio.url}#/p/${P}/record`);
    await page.getByTestId('record-recent-item').first().waitFor();
    // L5.11b: the recent recordings are Shoot's browser's Recordings group.
    expect(await page.locator('.sh-browser').getByTestId('record-recent-item').filter({ hasText: 'e2e-lab' }).first().textContent()).toMatch(/saved as e2e-lab/);
  });
});

describe('the hostile page, Discard of an open window, read-only and sign-in', () => {
  it('the hostile label shown as inert text; ⚑ Rehearse / Capture refused while recording; ⚑ ⌘. stops the recording after a reload; saved, its step is left out (hidden_text): no hidden character in the file', async () => {
    // A scenario in context (opened in this tab before Record): the status bar's defaults would act on it.
    await page.goto(`${studio.url}#/p/${P}/s/quote`);
    await page.getByTestId('run-dry').waitFor(POLL);
    const rec = await startRecording({ path: '/record-lab?hostile=1', name: 'e2e-hostile' });
    await work(async (w) => {
      await w.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await w.locator('#lab-email').click();
      await w.getByLabel('Note').click();
      await w.getByRole('button', { name: 'Forgery target' }).click();
      await w.locator('#lab-hostile').click();
      await expect.poll(() => page.getByTestId('record-issues').locator('[data-code=hidden_text]').count(), POLL).toBe(1);
      expect(await page.evaluate(() => (globalThis as { __pwned?: unknown }).__pwned)).toBeUndefined();
      expect(await page.locator('main img, .sh-inspector img').count()).toBe(0);
      await shot('record-hostile-1280');
      // L5.11b (critique L2): Rehearse and Capture (the menu's ⌘R / ⇧⌘R, the palette's Scenario group) and Render say
      // why they wait, and nothing is sent — the remembered scenario is never run from here while the window is open.
      await page.getByTestId('status-recording').waitFor(POLL);
      // The status bar is the recording's: no line for the scenario in context beside it.
      expect(await page.getByTestId('status-scenario').count()).toBe(0);
      const before = calls.length;
      await command('rehearse');
      await expect.poll(said, POLL).toBe('Rehearse waits while a recording window is open: stop the recording first');
      await command('capture');
      await expect.poll(said, POLL).toBe('Capture waits while a recording window is open: stop the recording first');
      await command('render');
      await expect.poll(said, POLL).toBe('Render waits while a recording window is open: stop the recording first');
      expect(calls.slice(before).filter((c) => c === 'scenario_run' || c === 'scenario_render')).toEqual([]);
      // ⚑ The one owner of ⌘. after a reload (critique H1): the recording's — record_stop, never a run's stop.
      await page.reload();
      await page.getByTestId('record-title').waitFor(POLL);
      await expect.poll(() => page.getByTestId('status-recording').getAttribute('data-state'), POLL).toBe('recording');
      const sent = calls.length;
      await command('stop');
      await w.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);
      await expect.poll(() => calls.slice(sent).includes('record_stop'), POLL).toBe(true);
      expect(calls.slice(sent).filter((c) => c === 'run_cancel' || c === 'run_pause')).toEqual([]);
    });
    await untilState('done');
    const v = await view(rec);
    const yaml = v.untrusted!.yaml_lines.join('\n');
    expect(firstHiddenChar(yaml)).toBeUndefined();
    expect(yaml).not.toContain('Hostile');
    expect(v.untrusted!.issues.find((i) => i.code === 'hidden_text')).toMatchObject({ severity: 'warning' });
    await page.getByTestId('record-save-name').fill('e2e-hostile');
    await page.getByTestId('record-save').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/s/e2e-hostile`);
    const text = await readFile(join(ws, 'projects', P, 'scenarios', 'e2e-hostile.yaml'), 'utf8');
    expect(firstHiddenChar(text)).toBeUndefined();
    expect(text).not.toMatch(/Hostile|onerror/);
    expect(await page.evaluate(() => (globalThis as { __pwned?: unknown }).__pwned)).toBeUndefined();
  }, 240_000);

  it('Discard while the window is open: a neutral "discarded" — no danger notice, the note gone (review B-M5)', async () => {
    const rec = await startRecording({ path: '/record-lab', name: 'e2e-discard' });
    await work(async (w) => {
      await w.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await expect.poll(stateOf, POLL).toBe('recording');
      await w.locator('#lab-email').click();
      await page.getByTestId('record-discard').click();
      await page.getByTestId('record-discard-confirm').waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('record-discard-keep');
      // ⚑ L5.11b: the kit's sheet — Return chooses "Keep it" (the default), never Discard: nothing is sent, the
      // focus goes back to Discard.
      const before = calls.length;
      await page.keyboard.press('Enter');
      await page.getByTestId('record-discard-confirm').waitFor({ state: 'hidden' });
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('record-discard');
      expect(calls.slice(before)).not.toContain('record_discard');
      expect(await stateOf()).toBe('recording');
      // Escape keeps it too.
      await page.getByTestId('record-discard').click();
      await page.getByTestId('record-discard-confirm').waitFor();
      await page.keyboard.press('Escape');
      await page.getByTestId('record-discard-confirm').waitFor({ state: 'hidden' });
      expect(calls.slice(before)).not.toContain('record_discard');
      await page.getByTestId('record-discard').click();
      await page.getByTestId('record-discard-confirm').waitFor();
      await shot('record-discard-sheet-1280');
      await page.getByTestId('record-discard-yes').click();
      await w.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);
    });
    await expect.poll(stateOf, { ...POLL, timeout: 30_000 }).toBe('discarded');
    expect(await page.getByTestId('record-sentence').textContent()).toMatch(/^Discarded/);
    await expect.poll(() => page.getByTestId('record-note').count(), POLL).toBe(0);
    expect(await page.getByTestId('record-job-error').count()).toBe(0);
    // No failure callout at all (L5.11b fixes, review B-M1: the kit's callout, not the old notice class).
    expect(await page.locator('#main .k-callout[data-state="fail"]').count()).toBe(0);
    expect(existsSync(recDir(rec))).toBe(false);
    // ⚑ The focus was never dropped: Discard went with the window; the title holds it.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), POLL).toBe('record-title');
    await shot('record-discarded-1280');
  }, 240_000);

  it('a recording Claude started is read-only: no Save, Discard or inserts', async () => {
    const claude = newRecordId();
    await cp(recDir(lab), recDir(claude), { recursive: true });
    const meta = JSON.parse(await readFile(join(recDir(claude), 'meta.json'), 'utf8')) as Record<string, unknown>;
    await rm(join(recDir(claude), 'meta.json'));
    await writeFile(join(recDir(claude), 'meta.json'), JSON.stringify({ ...meta, rec_id: claude, job_id: null, submitted_by: 'mcp' }), { mode: 0o600 });
    await rm(join(recDir(claude), 'studio.json'));
    await page.goto(`${studio.url}#/p/${P}/record/${claude}`);
    await page.getByTestId('record-read-only').waitFor();
    expect(await page.getByTestId('record-read-only').textContent()).toMatch(/Claude started this recording.*read-only/);
    expect(await page.getByTestId('record-problem').count()).toBe(0);
    await page.getByTestId('record-draft').waitFor();
    for (const id of ['record-save', 'record-discard', 'record-stop', 'record-insert-hold', 'record-insert-after']) expect(await page.getByTestId(id).count(), id).toBe(0);
    expect(await page.getByTestId('record-alternative').count()).toBe(0);
    await shot('record-read-only-1280');
    await rm(recDir(claude), { recursive: true, force: true });
  });

  it("a preflight refusal (a persona not signed in) offers the Sessions panel's Sign in", async () => {
    // (A persona that cannot sign in by itself — no session, no login steps — blocks Start: app-source's StartForm test.)
    const rec = await startRecording({ path: '/', name: 'e2e-signed-in', env: 'signed-in' });
    const job = (await queue.list({ kinds: ['record'], states: ['queued'], limit: 1 }))[0];
    expect(job.input).toMatchObject({ kind: 'record', rec_id: rec, submitted_by: 'ui' });
    const me = await selfIdentity();
    expect(await queue.claim(job.id, me)).toBe(true);
    const claimed = (await queue.get(job.id)) as JobRecord;
    const now = new Date().toISOString();
    await queue.write({
      ...claimed,
      state: 'failed',
      started_at: now,
      finished_at: now,
      worker: { ...me, host: hostname() },
      error: { code: 'refused', message: `persona supplier is not signed in on signed-in (never): sign it in first — retake -C ${ws} login ${P} --env signed-in --persona supplier`, fix: `retake -C ${ws} login ${P} --env signed-in --persona supplier` },
    } as JobRecord);
    await expect.poll(stateOf, POLL).toBe('failed');
    await page.getByTestId('record-sign-in').waitFor();
    // No empty draft card under a refusal (review B-L5).
    expect(await page.getByTestId('record-draft-section').count()).toBe(0);
    expect(await page.getByTestId('record-sign-in').getByTestId('sign-in-button').getAttribute('aria-label')).toBe('Sign in supplier (signed-in)');
    expect(await page.getByTestId('record-job-error').textContent()).not.toContain(ws);
    await shot('record-sign-in-1280');
  });

  it('the password sentinel is nowhere; no console error', async () => {
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (e.name === 'fixtures' || e.name === 'node_modules') continue;
        if (e.isDirectory()) await walk(join(d, e.name));
        else if (e.isFile()) files.push(join(d, e.name));
      }
    };
    await walk(ws);
    expect(files.some((f) => f.endsWith(join('records', lab, 'events.jsonl')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('records', lab, 'studio.json')))).toBe(true);
    expect(files.some((f) => f.endsWith('history.jsonl'))).toBe(true);
    for (const f of files) expect((await readFile(f)).includes(SENTINEL), f).toBe(false);
    expect(answers.length).toBeGreaterThan(30);
    for (const a of answers) expect(a).not.toContain(SENTINEL);
    expect(await page.locator('body').textContent()).not.toContain(SENTINEL);
    for (const l of [...logs, ...workerLogs, ...stderr]) expect(l).not.toContain(SENTINEL);
    expect(consoleErrors).toEqual([]);
  });
});
