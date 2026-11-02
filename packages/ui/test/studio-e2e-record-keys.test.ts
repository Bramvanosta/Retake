/**
 * L5.11b fixes: the Record screen's keyboard, its one change in flight and its commands, on a recording the test plays —
 * the built-in Studio server on a scratch workspace and home, headless Chromium, and `record_view` / `record_annotate` /
 * `record_stop` / `record_discard` answered by the test (page routes: a live recording of any length and state, a
 * change held back), so each rule is checked in a few seconds without a recording window (the real recorder:
 * studio-e2e-record.test.ts). Covered:
 *
 * - ⚑ ⌘. is the recording's from the route's first paint — before its view is read ("Wait: the recording is still being
 *   read", nothing sent) — and Rehearse / Capture / Render say why they wait in every live state (queued, preflight,
 *   recording: "stop the recording first"; draft, check: "made and checked"); ⌘. in each state says what it does (review
 *   B-L1);
 * - the draft is ONE tab stop (a listbox per scene): from the title, Stop is a few Tabs away with 60 rows; ↑ / ↓ cross
 *   scenes, Home / End, Enter selects (the cursor moves), Enter again goes back to the end; the cursor block is a group,
 *   not an option (review A-M2 / A-L3);
 * - ⌘K on a live recording: "Stop recording" and "Discard…" named after the recording, never the scenario in context
 *   (review A-M2 / A-L1);
 * - the alternatives with a save held back: two arrow presses — the radio follows each press, one write in flight, the
 *   newest pick sent when it ends; the focused radio = the checked one = the saved one (review A-M1);
 * - Stop pressed while a change is written: sent right after it (review A-L6);
 * - an open Caption… keeps its text and its focus when the first row arrives, and when a new scene starts (review A-L7);
 * - hiding / showing the inspector keeps the Name typed; hidden, the one Stop is at the top of the centre (review B-L4);
 * - Save disabled with its reason in each state, enabled when done; Enter in Name says why (review B-M2 / A-L4);
 * - Zoom… with a factor other than the default sends that factor (review B-L7);
 * - an info note is a status, not an alert (review A-L5);
 * - a narrow centre (900 px): a row's aside goes under its text, a word is never broken (review A-L2).
 *
 * `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots there (a live recording: 1440 dark, 900 dark, the inspector hidden,
 * 1280 light).
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page, Route } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

const P = 'northfield-fixture';
const POLL = { timeout: 15_000, interval: 100 };
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const savedHome = process.env.DEMO_STUDIO_HOME;

let ws: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];
/** Every op the page called, in order, with its body. */
const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
const sent = (op: string) => calls.filter((c) => c.op === op);
const said = () => page.locator('.sh-said').innerText();
const command = (id: string) => page.evaluate((x) => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: x } })), id);
const focusedTestId = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null);

type State = 'queued' | 'preflight' | 'recording' | 'draft' | 'check' | 'done';

/** The recording the test plays: its state, its scenes' row counts, its picks; every change bumps its version and rev. */
interface Stub {
  rec: string;
  state: State;
  scenes: number[];
  name: string;
  rev: number;
  version: number;
  chosen: Record<number, number>;
  stopRequested: boolean;
  /** record_view answers wait for this while set (a reload before the view is read). */
  viewGate: Promise<void> | null;
  /** record_annotate answers wait for this while set (a save held back). */
  annotateGate: Promise<void> | null;
  discardAnswer: 'discarded' | 'discarding';
}
let stub: Stub;
let recCount = 0;

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

function bump(change: Partial<Stub> = {}): void {
  Object.assign(stub, change);
  stub.version++;
  stub.rev++;
}

const OPEN: ReadonlySet<State> = new Set(['queued', 'preflight', 'recording']);

function view(): Record<string, unknown> {
  const s = stub;
  const live = s.state !== 'done';
  const windowSeen = s.state !== 'queued' && s.state !== 'preflight';
  const entries: unknown[] = [];
  const sources: unknown[] = [];
  const alternatives: unknown[] = [];
  let seq = 0;
  s.scenes.forEach((rows, si) => {
    const id = `scene-${si + 1}`;
    const steps: unknown[] = [];
    for (let i = 0; i < rows; i++) {
      seq++;
      const target = seq === 1 ? 'buyer@example.com' : `button “Item ${seq}”`;
      steps.push({ key: `${id}.${i}`, index: i, action: 'click', category: 'interaction', label: 'click', target, chips: [] });
      sources.push({ scene: id, step: i, seqs: [seq, seq], role: 'action', row: `a${seq}`, target_seqs: [seq], target_seq: seq });
      if (seq % 3 === 1) {
        alternatives.push({
          scene: id,
          step: i,
          seq,
          chosen: s.chosen[seq] ?? 0,
          options: [0, 1, 2].map((k) => ({ index: k, target: { text: `Item ${seq}` }, words: k === 0 ? target : k === 1 ? `text “Item ${seq}”` : `element matching #it-${seq}`, fragile: k === 2 ? ['css'] : [] })),
        });
      }
    }
    entries.push({ type: 'scene', index: si, id, page: 'shop', open: '/', continues: false, steps });
  });
  const total = s.scenes.reduce((a, b) => a + b, 0);
  return {
    rec_id: s.rec,
    state: s.state,
    version: `v${s.version}`,
    job: live ? { id: `j_${s.rec}`, state: 'running', phase: s.state, cancel_requested: false, stop_requested: s.stopRequested } : null,
    started_by: 'ui',
    can: { annotate: windowSeen, save: s.state === 'done', discard: true, stop: OPEN.has(s.state) && !s.stopRequested },
    name: s.name,
    env: 'local',
    persona: null,
    access: 'read-write',
    page: 'shop',
    path: '/',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ends_at: new Date(Date.now() + 1_700_000).toISOString(),
    rev: s.rev,
    draft_sha256: s.state === 'done' ? 'abc' : null,
    zoom: windowSeen ? { max: 1.5, options: [1.25, 1.5], default: 1.25 } : null,
    counts: { events: total, actions: total, dropped_lines: 0 },
    stats: windowSeen ? { steps: total } : null,
    issues: { error: 0, warning: 0, info: 0 },
    check: null,
    saved: null,
    warnings: [],
    writes: { total: 0, by_steps: 0, ambient: 0 },
    untrusted: windowSeen
      ? {
          blocks: { parsed: true, video: {}, hooks: { setup: [], teardown: [], named: [] }, entries, step_count: total, issues: [] },
          sources,
          issues: [],
          pending: [],
          placeholders: [],
          alternatives,
          inserts: [],
          writes: [],
          yaml_lines: [],
        }
      : null,
  };
}

const ok = (route: Route, data: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
const body = (route: Route) => JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;

/** A new recording to play (a new id: the screen starts afresh), and its route opened. */
async function open(change: Partial<Stub> = {}, o: { wait?: boolean } = {}): Promise<void> {
  recCount++;
  stub = { rec: `rec_stub${String(recCount).padStart(4, '0')}`, state: 'recording', scenes: [12], name: 'stub-draft', rev: 1, version: 1, chosen: {}, stopRequested: false, viewGate: null, annotateGate: null, discardAnswer: 'discarded', ...change };
  await page.goto(`${studio.url}#/p/${P}/record/${stub.rec}`);
  await page.getByTestId('record-title').waitFor(POLL);
  if (o.wait !== false) await expect.poll(() => page.getByTestId('record-state').getAttribute('data-state'), POLL).toBe(stub.state);
}

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-record-keys-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 150 });
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('request', (r) => {
    const m = /\/v1\/call\/([a-z_]+)$/.exec(new URL(r.url()).pathname);
    if (!m) return;
    let b: Record<string, unknown> = {};
    try {
      b = JSON.parse(r.postData() ?? '{}') as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    calls.push({ op: m[1], body: b });
  });
  await page.route('**/v1/call/record_view', async (route) => {
    const b = body(route);
    if (!stub || b.rec_id !== stub.rec) return route.continue();
    if (stub.viewGate) await stub.viewGate;
    if (b.since === `v${stub.version}`) return ok(route, { rec_id: stub.rec, state: stub.state, version: `v${stub.version}`, rev: stub.rev, unchanged: true });
    return ok(route, view());
  });
  await page.route('**/v1/call/record_annotate', async (route) => {
    const b = body(route);
    if (stub.annotateGate) await stub.annotateGate;
    const change = b.change as { op: string; seq?: number; index?: number };
    if (change.op === 'choose') stub.chosen[change.seq!] = change.index!;
    bump();
    return ok(route, { rev: stub.rev, view: view() });
  });
  await page.route('**/v1/call/record_stop', async (route) => {
    bump({ stopRequested: true });
    return ok(route, { action: 'stop', view: view() });
  });
  await page.route('**/v1/call/record_discard', async (route) => {
    if (stub.discardAnswer === 'discarded') bump({ state: 'done' });
    return ok(route, { rec_id: stub.rec, state: stub.discardAnswer });
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the Record screen on a played recording (L5.11b fixes)', () => {
  it('⚑ ⌘. is the recording\'s before its view is read; Rehearse / Capture / Render wait in every live state, ⌘. says what it does (B-L1)', async () => {
    // A scenario in context (the status bar's defaults would act on it).
    await page.goto(`${studio.url}#/p/${P}/s/quote`);
    await page.getByTestId('run-dry').waitFor(POLL);
    const g = gate();
    await open({ viewGate: g.promise }, { wait: false });
    const before = calls.length;
    await command('stop');
    await expect.poll(said, POLL).toBe('Wait: the recording is still being read');
    await command('capture');
    await expect.poll(said, POLL).toBe('Capture waits while a recording window is open: stop the recording first');
    stub.viewGate = null;
    g.open();
    await expect.poll(() => page.getByTestId('record-state').getAttribute('data-state'), POLL).toBe('recording');
    const words: Record<State, string> = {
      queued: 'waits while a recording window is open: stop the recording first',
      preflight: 'waits while a recording window is open: stop the recording first',
      recording: 'waits while a recording window is open: stop the recording first',
      draft: 'waits while the recording’s draft is made and checked',
      check: 'waits while the recording’s draft is made and checked',
      done: '',
    };
    for (const state of ['queued', 'preflight', 'recording', 'draft', 'check'] as const) {
      bump({ state });
      await expect.poll(() => page.getByTestId('record-state').getAttribute('data-state'), POLL).toBe(state);
      for (const [id, word] of [
        ['rehearse', 'Rehearse'],
        ['capture', 'Capture'],
        ['render', 'Render'],
      ] as const) {
        await command(id);
        await expect.poll(said, POLL).toBe(`${word} ${words[state]}`);
      }
      if (state === 'draft' || state === 'check') {
        await command('stop');
        await expect.poll(said, POLL).toBe(`Nothing to stop: the recording is ${state === 'draft' ? 'making the draft' : 'checking the draft'}`);
      }
    }
    // A stop already asked says so.
    bump({ state: 'recording', stopRequested: true });
    await expect.poll(() => page.getByTestId('record-state').getAttribute('data-state'), POLL).toBe('recording');
    expect(await page.getByTestId('record-stop').count()).toBe(0);
    await command('stop');
    await expect.poll(said, POLL).toBe('The recording is already stopping');
    expect(calls.slice(before).map((c) => c.op).filter((op) => /^(scenario_run|scenario_render|run_cancel|run_pause|record_stop)$/.test(op))).toEqual([]);
  });

  it('⚑ the draft is one tab stop: Stop a few Tabs from the title with 60 rows; ↑ ↓ cross scenes, Home / End, Enter selects; the cursor block is no option (A-M2 / A-L3)', async () => {
    await open({ scenes: [40, 20] });
    const lists = page.getByTestId('record-rows');
    expect(await lists.count()).toBe(2);
    expect(await page.locator('[role="listbox"] [role="option"]').count()).toBe(60);
    // Exactly one list is a tab stop; no option is one.
    expect(await page.locator('[data-testid="record-rows"][tabindex="0"]').count()).toBe(1);
    expect(await page.locator('[role="option"][tabindex]').count()).toBe(0);
    // From the title, Tab reaches Stop recording in a few presses (it was behind every row).
    await page.getByTestId('record-title').focus();
    let tabs = 0;
    while ((await focusedTestId()) !== 'record-stop' && tabs < 40) {
      await page.keyboard.press('Tab');
      tabs++;
    }
    expect(await focusedTestId()).toBe('record-stop');
    expect(tabs).toBeLessThanOrEqual(20);
    // The keys: the first list's active row moves; Enter selects it (the cursor goes after it), Enter again: the end.
    const first = lists.first();
    await first.focus();
    const active = () => page.evaluate(() => {
      const id = document.activeElement?.getAttribute('aria-activedescendant');
      const el = id ? document.getElementById(id) : null;
      return el ? { n: el.querySelector('.k-rowcard-tile')?.textContent, list: [...document.querySelectorAll('[data-testid="record-rows"]')].indexOf(document.activeElement!) } : null;
    });
    expect(await active()).toEqual({ n: '1', list: 0 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toEqual({ n: '3', list: 0 });
    expect(await page.locator('[role="option"][aria-selected="true"]').count()).toBe(0);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('record-cursor-where').textContent(), POLL).toBe('Insert after step 3 of scene-1');
    expect(await page.locator('[role="option"][aria-selected="true"] .k-rowcard-tile').textContent()).toBe('3');
    // The cursor block right after the row: a group inside the list, not an option (the list's options are the rows).
    const block = page.getByTestId('record-cursor');
    expect(await block.getAttribute('role')).toBe('group');
    expect(await block.evaluate((el) => el.closest('[role="option"]') === null && el.closest('[role="listbox"]') !== null)).toBe(true);
    expect(await page.locator('[role="listbox"] [role="option"]').count()).toBe(60);
    expect(await focusedTestId()).toBe('record-rows');
    await shot('record-live-keyboard-1440-dark');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('record-cursor-where').textContent(), POLL).toMatch(/^Insert at the end/);
    // End: the last row of all — the second scene's list takes the focus; Home: back to the first.
    await page.keyboard.press('End');
    expect(await active()).toEqual({ n: '20', list: 1 });
    expect(await page.locator('[data-testid="record-rows"][tabindex="0"]').count()).toBe(1);
    await page.keyboard.press('Home');
    expect(await active()).toEqual({ n: '1', list: 0 });
    // ↓ from the first scene's last row: the next scene's first row.
    for (let i = 0; i < 39; i++) await page.keyboard.press('ArrowDown');
    expect(await active()).toEqual({ n: '40', list: 0 });
    await page.keyboard.press('ArrowDown');
    expect(await active()).toEqual({ n: '1', list: 1 });
    await page.keyboard.press(' ');
    await expect.poll(() => page.getByTestId('record-cursor-where').textContent(), POLL).toBe('Insert after step 1 of scene-2');
    // A click selects too (and makes the row the active one).
    await page.locator('[role="option"]', { hasText: 'Item 5' }).first().click();
    await expect.poll(() => page.getByTestId('record-cursor-where').textContent(), POLL).toBe('Insert after step 5 of scene-1');
  });

  it('⚑ ⌘K on a live recording: Stop recording and Discard… named after the recording, never the scenario in context (A-M2 / A-L1)', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/quote`);
    await page.getByTestId('run-dry').waitFor(POLL);
    await open();
    await command('palette');
    await page.locator('dialog.k-palette[open]').waitFor(POLL);
    const options = () => page.locator('.k-palette-option').evaluateAll((els) => els.map((e) => `${e.querySelector('.k-palette-label')?.textContent ?? ''} · ${e.querySelector('.k-palette-hint')?.textContent ?? ''}`));
    const all = await options();
    expect(all).toContain('Stop recording · stub-draft');
    expect(all).toContain('Discard… · stub-draft');
    for (const label of ['Rehearse', 'Capture', 'Render', 'Stop']) expect(all.filter((o) => o.startsWith(`${label} · `)), label).toEqual([]);
    // Discard… opens the sheet (Keep it holds the focus).
    await page.locator('.k-palette-option', { hasText: 'Discard…' }).click();
    await page.getByTestId('record-discard-confirm').waitFor(POLL);
    await expect.poll(focusedTestId, POLL).toBe('record-discard-keep');
    await page.keyboard.press('Escape');
    await page.getByTestId('record-discard-confirm').waitFor({ state: 'hidden' });
    expect(sent('record_discard')).toEqual([]);
    // Stop recording stops this recording.
    const before = sent('record_stop').length;
    await command('palette');
    await page.locator('dialog.k-palette[open]').waitFor(POLL);
    await page.locator('.k-palette-option', { hasText: 'Stop recording' }).click();
    await expect.poll(() => sent('record_stop').length, POLL).toBe(before + 1);
    expect(sent('record_stop').at(-1)!.body.rec_id).toBe(stub.rec);
    // Once over, the Scenario group is the scenario's again.
    bump({ state: 'done', stopRequested: false });
    await expect.poll(() => page.getByTestId('record-state').getAttribute('data-state'), POLL).toBe('done');
    await command('palette');
    await page.locator('dialog.k-palette[open]').waitFor(POLL);
    expect(await options()).toContain('Rehearse · quote');
    await page.keyboard.press('Escape');
  });

  it('⚑ the alternatives with a save held back: the radio follows each arrow press, one write in flight, the newest pick sent after it (A-M1)', async () => {
    await open({ scenes: [6] });
    await page.locator('[role="option"]').first().click();
    const radios = page.getByTestId('record-alternative');
    await expect.poll(() => radios.count(), POLL).toBe(3);
    const checked = () => radios.evaluateAll((els) => els.findIndex((e) => (e as HTMLInputElement).checked));
    const focused = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="record-alternative"]')].indexOf(document.activeElement!));
    const g = gate();
    stub.annotateGate = g.promise;
    const before = sent('record_annotate').length;
    await radios.first().focus();
    await page.keyboard.press('ArrowDown');
    expect(await checked()).toBe(1);
    expect(await focused()).toBe(1);
    await page.keyboard.press('ArrowDown');
    // The radio shows the choice asked for at once; the second waits for the first.
    expect(await checked()).toBe(2);
    expect(await focused()).toBe(2);
    await expect.poll(() => sent('record_annotate').length, POLL).toBe(before + 1);
    await page.waitForTimeout(300);
    expect(sent('record_annotate').length).toBe(before + 1);
    expect(await checked()).toBe(2);
    stub.annotateGate = null;
    g.open();
    await expect.poll(() => sent('record_annotate').length, POLL).toBe(before + 2);
    expect(sent('record_annotate').slice(before).map((c) => (c.body.change as { index: number }).index)).toEqual([1, 2]);
    await expect.poll(() => stub.chosen[1], POLL).toBe(2);
    await expect.poll(() => page.getByTestId('record-alt-state').textContent(), POLL).toBe('Target picked by you');
    expect(await checked()).toBe(2);
    expect(await focused()).toBe(2);
    expect(await page.locator('.sh-said').innerText()).not.toMatch(/try again/);
  });

  it('⚑ Stop pressed while a change is written is sent right after it (A-L6)', async () => {
    await open();
    const g = gate();
    stub.annotateGate = g.promise;
    const before = calls.length;
    await page.getByTestId('record-insert-mark').click();
    await expect.poll(() => sent('record_annotate').length > 0 && calls.slice(before).some((c) => c.op === 'record_annotate'), POLL).toBe(true);
    await page.getByTestId('record-stop').click();
    await expect.poll(said, POLL).toBe('Stopping once the change being written is saved');
    await page.waitForTimeout(300);
    expect(calls.slice(before).filter((c) => c.op === 'record_stop')).toEqual([]);
    stub.annotateGate = null;
    g.open();
    await expect.poll(() => calls.slice(before).filter((c) => c.op === 'record_stop').length, POLL).toBe(1);
    const ops = calls.slice(before).map((c) => c.op).filter((op) => op === 'record_annotate' || op === 'record_stop');
    expect(ops).toEqual(['record_annotate', 'record_stop']);
  });

  it('⚑ an open Caption… keeps its text and its focus when the first row arrives and when a new scene starts (A-L7)', async () => {
    await open({ scenes: [0] });
    await page.getByTestId('record-no-steps').waitFor(POLL);
    await page.getByTestId('record-insert-caption').click();
    await page.getByTestId('record-caption-text').fill('Pick a bag');
    await page.getByTestId('record-caption-kicker').fill('Order');
    await page.getByTestId('record-caption-text').focus();
    bump({ scenes: [1] });
    await expect.poll(() => page.locator('[role="option"]').count(), POLL).toBe(1);
    expect(await page.getByTestId('record-caption-text').inputValue()).toBe('Pick a bag');
    expect(await page.getByTestId('record-caption-kicker').inputValue()).toBe('Order');
    expect(await focusedTestId()).toBe('record-caption-text');
    // Typing goes on in the field.
    await page.keyboard.type(' size');
    bump({ scenes: [1, 1] });
    await expect.poll(() => page.locator('[role="option"]').count(), POLL).toBe(2);
    expect(await page.getByTestId('record-caption-text').inputValue()).toBe('Pick a bag size');
    expect(await focusedTestId()).toBe('record-caption-text');
    // With the cursor after a row whose block moves (a row arrives before it): the text survives too.
    await page.locator('[role="option"]').last().click();
    await expect.poll(() => page.getByTestId('record-cursor-where').textContent(), POLL).toBe('Insert after step 1 of scene-2');
    expect(await page.getByTestId('record-caption-text').inputValue()).toBe('Pick a bag size');
    await page.getByTestId('record-caption-text').focus();
    bump({ scenes: [2, 1] });
    await expect.poll(() => page.locator('[role="option"]').count(), POLL).toBe(3);
    expect(await page.getByTestId('record-caption-text').inputValue()).toBe('Pick a bag size');
    expect(await focusedTestId()).toBe('record-caption-text');
  });

  it('⚑ hiding / showing the inspector keeps the Name typed; hidden, the one Stop is at the top of the centre (B-L4)', async () => {
    await open({ scenes: [30] });
    await page.locator('.sh-inspector').getByTestId('record-save-name').fill('kept-name');
    await command('inspector');
    await page.getByTestId('inline-inspector').waitFor(POLL);
    expect(await page.getByTestId('inline-inspector').getByTestId('record-save-name').inputValue()).toBe('kept-name');
    // One Stop, in the head beside the time — above the draft, not under it.
    expect(await page.getByTestId('record-stop').count()).toBe(1);
    expect(await page.getByTestId('record-stop').evaluate((el) => el.closest('.rc-head') !== null)).toBe(true);
    const [stopY, draftY] = await Promise.all([page.getByTestId('record-stop').boundingBox(), page.getByTestId('record-draft-section').boundingBox()]);
    expect(stopY!.y).toBeLessThan(draftY!.y);
    await shot('record-live-inspector-hidden-1440-dark');
    await command('inspector');
    await page.locator('.sh-inspector').getByTestId('record-save-name').waitFor(POLL);
    expect(await page.locator('.sh-inspector').getByTestId('record-save-name').inputValue()).toBe('kept-name');
    expect(await page.getByTestId('record-stop').count()).toBe(1);
    expect(await page.getByTestId('record-stop').evaluate((el) => el.closest('.sh-inspector') !== null)).toBe(true);
  });

  it('⚑ Save: disabled with its reason while recording and while the check runs, enabled when done; Enter in Name says why (B-M2 / A-L4)', async () => {
    await open();
    const save = page.getByTestId('record-save');
    const why = page.getByTestId('record-save-why');
    expect(await save.isDisabled()).toBe(true);
    expect(await why.textContent()).toBe('Saving opens after Stop. It writes a new file, scenarios/stub-draft.yaml.');
    await page.getByTestId('record-save-name').press('Enter');
    await expect.poll(said, POLL).toBe('Saving opens after Stop. It writes a new file, scenarios/stub-draft.yaml.');
    expect(sent('record_save')).toEqual([]);
    for (const state of ['draft', 'check'] as const) {
      bump({ state });
      await expect.poll(() => why.textContent(), POLL).toBe('Saving opens once the check is over.');
      expect(await save.isDisabled()).toBe(true);
    }
    bump({ state: 'done' });
    await expect.poll(() => save.isDisabled(), POLL).toBe(false);
    expect(await why.textContent()).toBe('It writes a new file, scenarios/stub-draft.yaml, then opens it.');
  });

  it('⚑ Zoom… with a factor other than the default sends that factor (B-L7)', async () => {
    await open();
    await page.getByTestId('record-insert-zoom').click();
    expect(await page.getByRole('radio', { name: /^1\.25×/ }).isChecked()).toBe(true);
    await page.getByRole('radio', { name: /^1\.5×/ }).check();
    const before = sent('record_annotate').length;
    await page.getByTestId('record-zoom-add').click();
    await expect.poll(() => sent('record_annotate').length, POLL).toBe(before + 1);
    expect((sent('record_annotate').at(-1)!.body.change as { insert: unknown }).insert).toEqual({ kind: 'camera', zoom: 1.5, until: 'scene_end' });
  });

  it('⚑ an info note is a status, not an alert (A-L5)', async () => {
    await open({ discardAnswer: 'discarding' });
    await page.getByTestId('record-discard').click();
    await page.getByTestId('record-discard-yes').click();
    await page.getByTestId('record-note').waitFor(POLL);
    const role = await page.getByTestId('record-note').evaluate((el) => el.closest('.k-callout')?.getAttribute('role'));
    expect(role).toBe('status');
  });

  it('⚑ a narrow centre (900 px): a row\'s aside goes under its text, a word is never broken; the shots (A-L2)', async () => {
    await open({ scenes: [24] });
    await shot('record-live-1440-dark');
    await page.setViewportSize({ width: 900, height: 900 });
    try {
      const row = page.locator('[role="option"]').first();
      await expect.poll(async () => (await row.boundingBox())?.width ?? 0, POLL).toBeLessThan(560);
      const box = await row.evaluate((el) => {
        const text = el.querySelector('.k-rowcard-text')!.getBoundingClientRect();
        const aside = el.querySelector('.k-rowcard-aside')!.getBoundingClientRect();
        const target = el.querySelector('.rc-row-target')!;
        return { asideTop: aside.top, textBottom: text.bottom, targetLines: target.getClientRects().length, target: target.textContent };
      });
      expect(box.target).toBe('buyer@example.com');
      expect(box.asideTop).toBeGreaterThanOrEqual(box.textBottom - 1);
      expect(box.targetLines).toBe(1);
      await shot('record-live-900-dark');
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    // Wide: the aside on the row's right, on the text's line.
    const wide = await page.locator('[role="option"]').first().evaluate((el) => {
      const text = el.querySelector('.k-rowcard-text')!.getBoundingClientRect();
      const aside = el.querySelector('.k-rowcard-aside')!.getBoundingClientRect();
      return aside.left >= text.right - 1 && aside.top < text.bottom;
    });
    expect(wide).toBe(true);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await shot('record-live-1280-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it('no console error', () => {
    expect(consoleErrors).toEqual([]);
  });
});
