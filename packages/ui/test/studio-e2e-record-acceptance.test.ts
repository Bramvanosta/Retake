/**
 * L4.8 acceptance (slow: gated by RETAKE_TEST_SLOW=1 — `pnpm test:slow`): the Record screen, then the scenario it
 * saved filmed and rendered. The built-in Studio server on a clean copy of projects/northfield-fixture (its local
 * environment pointed at the fixture product on free ports), headless Chromium on the Studio app, and every job run by
 * a worker IN THIS PROCESS — the `record` job's window played by Playwright (`ports.recordWindow.drive`: a worker process cannot
 * receive it; the real window with a person switching to the Studio is MACOS-CHECKLIST 13i). The window is headless;
 * `RETAKE_TEST_HEADED=1` shows it.
 *
 * Record (the shop's quote flow) → a caption with a kicker and a zoom (the theme's max_zoom, 1.4×) waiting in the Studio, taken by the next
 * action (Request a quote) → a pick among that click's verified alternatives → Increase twice → a mark, taken by the bag
 * size → a message typed, committed by a Studio visit → a wait for a text and a hold 2 s at the end → Stop and keep →
 * the check replay passed → Save → a dry run and a capture of the saved scenario from the Studio (`scenario_run`) → a
 * render and its review (`scenario_render`): the plan holds the caption, the zoom and the marker on the steps they were
 * placed on, and the frames at those moments are cut (`RETAKE_UI_SHOTS=<folder>`: screenshots, the frames and the
 * timings there). Every stage is timed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseYaml } from '@retake/core';
import { runWorker } from '@retake/engine';
import type { RecordWindow } from '@retake/engine';
import { timelineOf } from '@retake/editor';
import type { EditPlan } from '@retake/editor';
import { startStudioServer } from '../src/index.js';
import type { RecordViewAnswer, StudioServer } from '../src/index.js';
import { REPO } from '../../engine/test/helpers.js';
import { raw } from './http.js';

type Window = Parameters<NonNullable<RecordWindow['drive']>>[0];

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

const ENABLED = process.env.RETAKE_TEST_SLOW === '1';
const HEADED = process.env.RETAKE_TEST_HEADED === '1';
const SHOTS = process.env.RETAKE_UI_SHOTS;
const P = 'northfield-fixture';
const S = 'recorded-quote';
const FIXTURE_PROJECT = join(REPO, 'projects', P);
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.retake', 'frames', 'comments']);
const POLL = { timeout: 20_000, interval: 150 };
const CAPTION = 'Ask for a quote';
const KICKER = 'Wholesale';

let fixture: Fixture;
let root: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const savedHome = process.env.RETAKE_HOME;
const workerLogs: string[] = [];
const consoleErrors: string[] = [];
const timings: Record<string, number> = {};

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** One Studio op over HTTP, as the page calls it. */
async function call<T>(op: string, args: Record<string, unknown>): Promise<T> {
  const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
  expect(r.status, `${op}: ${r.body.slice(0, 600)}`).toBe(200);
  return r.json<{ data: T }>().data;
}

/** The jobs queued so far, run by a worker in this process; it exits once idle. */
function drain(recordWindow?: RecordWindow): Promise<number> {
  return runWorker({ root, idleExitMs: 1500, pollMs: 100, log: (m) => workerLogs.push(m), ...(recordWindow ? { ports: { recordWindow }, once: true, idleExitMs: 0 } : {}) });
}

const stateOf = () => page.getByTestId('record-state').first().getAttribute('data-state');
const stepRow = (text: string) => page.locator('[data-testid=record-step]', { hasText: text }).last();

/** The person: the quote flow in the window, the Studio's inserts and a pick on the way. */
async function person(w: Window): Promise<void> {
  await w.waitForLoadState('domcontentloaded');
  await w.waitForTimeout(800);
  await expect.poll(stateOf, POLL).toBe('recording');
  await w.mouse.wheel(0, 900);
  await w.waitForTimeout(800);
  await w.getByText('Selowa Ridge').first().click();
  await w.getByRole('button', { name: 'Request a quote' }).waitFor();
  await w.waitForTimeout(1500);

  // A caption and a zoom wait in the Studio for the next action.
  await page.getByTestId('record-insert-caption').click();
  await page.getByTestId('record-caption-text').fill(CAPTION);
  await page.getByTestId('record-caption-kicker').fill(KICKER);
  await page.getByTestId('record-caption-text').press('Enter');
  await page.getByTestId('record-pending').waitFor();
  // Zoom… (L5.11b: a disclosure): the theme's maximum, 1.4×, is the default.
  expect(await page.getByTestId('record-insert-zoom').textContent()).toBe('Zoom…');
  await page.getByTestId('record-insert-zoom').click();
  expect(await page.getByRole('radio', { name: /^1\.4×/ }).isChecked()).toBe(true);
  await page.getByTestId('record-zoom-add').click();
  await expect.poll(() => page.getByTestId('record-pending').getByTestId('record-insert-chip').count(), POLL).toBe(2);
  await shot('acc-pending');

  await w.getByRole('button', { name: 'Request a quote' }).click();
  await expect.poll(() => page.getByTestId('record-pending').count(), POLL).toBe(0);
  // A pick among the click's verified alternatives (L5.11b: the row pressed shows them under it; then back to the end).
  const row = stepRow('Request a quote');
  await row.locator('.k-rowcard-aside').waitFor({ timeout: 20_000 });
  await row.getByTestId('record-insert-after').click();
  const alts = page.getByTestId('record-alternatives');
  await alts.waitFor({ timeout: 20_000 });
  const picked = ((await alts.locator('.k-radio').nth(1).locator('.rc-alt-words').textContent()) ?? '').trim();
  await alts.getByTestId('record-alternative').nth(1).click();
  await expect.poll(() => alts.getByTestId('record-alt-state').textContent(), POLL).toMatch(/picked by you/);
  await page.getByTestId('record-cursor-end').click();
  pickedTarget = picked;

  await w.waitForTimeout(500);
  await w.getByRole('dialog').getByLabel('Increase').click();
  await w.getByRole('dialog').getByLabel('Increase').click();
  // A mark for the bag size.
  await page.getByTestId('record-insert-mark').click();
  await expect.poll(() => page.getByTestId('record-pending').getByTestId('record-insert-chip').count(), POLL).toBe(1);
  await w.getByRole('combobox', { name: 'Bag size' }).click();
  await w.waitForTimeout(400);
  await w.getByRole('option', { name: '5 kg' }).click();
  await expect.poll(() => page.getByTestId('record-pending').count(), POLL).toBe(0);
  await w.waitForTimeout(300);
  await w.getByLabel('Message').click();
  await w.waitForFunction(() => document.activeElement?.id === 'quote-message', null, { timeout: 5000 });
  await w.keyboard.type('Light roast for filter, please.');
  // A visit to the Studio commits the typing.
  await w.getByLabel('Message').blur();
  await expect.poll(() => page.getByTestId('record-draft').textContent(), POLL).toContain('Light roast for filter, please.');
  // A wait for a text and a hold at the end.
  await page.getByTestId('record-insert-wait').click();
  await page.getByLabel('a text shows').check();
  await page.getByTestId('record-wait-text').fill('Delivery window');
  await page.getByTestId('record-wait-text').press('Enter');
  await expect.poll(() => page.locator('[data-testid=record-step][data-role=insert]').count(), POLL).toBe(1);
  await page.getByTestId('record-insert-hold').click();
  await expect.poll(() => page.locator('[data-testid=record-step][data-role=insert]').count(), POLL).toBe(2);
  await shot('acc-live');
  timings.recording_ms = Date.now() - recordStart;
  // Stop and keep from the Studio: the window closes as if closed.
  await page.getByTestId('record-stop').click();
  stopAt = Date.now();
  await w.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);
}

let pickedTarget = '';
let recordStart = 0;
let stopAt = 0;
let runId = '';

describe.skipIf(!ENABLED)('the Record screen, then its scenario filmed and rendered, with an in-process worker on the fixture (RETAKE_TEST_SLOW=1)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    root = await mkdtemp(join(tmpdir(), 'studio-ui-record-acceptance-'));
    process.env.RETAKE_HOME = join(root, '.home');
    await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(root, 'projects', P);
    await cp(FIXTURE_PROJECT, project, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
    const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
    await writeFile(
      join(project, 'project.yaml'),
      yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')),
    );
    await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
    studio = await startStudioServer({ root, startWorker: false, pollMs: 150, log: () => undefined });
    const executablePath = process.env.RETAKE_CHROMIUM;
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })).newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    await page.goto(studio.launchUrl());
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
  }, 180_000);

  afterAll(async () => {
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      await writeFile(join(SHOTS, 'acc-timings.json'), `${JSON.stringify(timings, null, 1)}\n`);
    }
    await browser?.close();
    await studio?.close();
    await fixture?.close();
    if (root) await rm(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = savedHome;
  });

  it('record → inserts and a pick → Stop → the check → Save: the scenario holds them where they were placed', async () => {
    await fetch(`${fixture.urls.console}/api/reset`, { method: 'POST' });
    await page.goto(`${studio.url}#/p/${P}`);
    await page.getByTestId('record-link').click();
    await page.getByTestId('record-start-form').waitFor();
    await page.getByTestId('record-page').selectOption('shop');
    await page.getByTestId('record-path').fill('/');
    await page.getByTestId('record-name').fill(S);
    recordStart = Date.now();
    await page.getByTestId('record-start').click();
    await expect.poll(() => /#\/p\/[^/]+\/record\/(rec_[^/]+)$/.exec(page.url())?.[1] ?? '', POLL).toMatch(/^rec_/);
    const rec = /record\/(rec_[^/]+)$/.exec(page.url())![1];
    await drain({ headless: !HEADED, windowSize: { width: 1400, height: 1000 }, drive: person });
    expect(workerLogs.filter((l) => /: failed \(/.test(l))).toEqual([]);
    await expect.poll(stateOf, { ...POLL, timeout: 90_000 }).toBe('done');
    timings.stop_to_checked_ms = Date.now() - stopAt;
    await expect.poll(() => page.getByTestId('record-check').getAttribute('data-status'), POLL).toBe('passed');
    const v = await call<RecordViewAnswer>('record_view', { project: P, rec_id: rec });
    expect(v).toMatchObject({ state: 'done', started_by: 'ui', check: { status: 'passed' }, issues: { error: 0 } });
    expect(v.untrusted!.pending).toEqual([]);
    expect(v.untrusted!.inserts.map((i) => i.kind).sort()).toEqual(['camera', 'caption', 'hold', 'mark', 'wait_for']);
    const pick = v.untrusted!.alternatives.find((a) => a.chosen === 1);
    expect(pick, JSON.stringify(v.untrusted!.alternatives)).toBeDefined();
    expect(pick!.options[1].words).toBe(pickedTarget);
    await shot('acc-done');

    const t0 = Date.now();
    await page.getByTestId('record-save-name').fill(S);
    await page.getByTestId('record-save').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/s/${S}`);
    timings.save_ms = Date.now() - t0;
    timings.record_total_ms = Date.now() - recordStart;
    const text = await readFile(join(root, 'projects', P, 'scenarios', `${S}.yaml`), 'utf8');
    if (SHOTS) await writeFile(join(SHOTS, `acc-${S}.yaml`), text);
    const doc = parseYaml(text).value as { scenes: Array<{ id: string; steps: Array<Record<string, unknown>> }> };
    const steps = doc.scenes.flatMap((s) => s.steps.map((st): Record<string, unknown> => ({ scene: s.id, ...st })));
    // The caption and the zoom on the Request a quote click, its target the one picked.
    const quoteClick = steps.find((s) => s.caption !== undefined);
    expect(quoteClick, text).toBeDefined();
    expect(quoteClick!.caption).toMatchObject({ text: CAPTION, kicker: KICKER });
    expect(quoteClick!.camera).toMatchObject({ zoom: 1.4 });
    expect(JSON.stringify(quoteClick!.click)).toContain('Request a quote');
    // The pick is the click's target, and the recorder's wait and scroll before it follow it.
    expect(quoteClick!.click).toEqual(pick!.options[1].target);
    const helpers = steps.slice(steps.indexOf(quoteClick!) - 2, steps.indexOf(quoteClick!));
    expect(helpers.map((h) => Object.keys(h).find((k) => k !== 'scene'))).toEqual(['wait_for', 'scroll']);
    expect(helpers[0].wait_for).toMatchObject({ target: pick!.options[1].target });
    expect(helpers[1].scroll).toEqual({ to: pick!.options[1].target });
    // The mark on the bag size.
    const marked = steps.find((s) => s.mark !== undefined);
    expect(JSON.stringify(marked)).toContain('Bag size');
    expect(text).toMatch(/hold: 2/);
    expect(text).toContain('Delivery window');
  }, 600_000);

  it('the saved scenario: a dry run and a capture from the Studio, then a render with its review', async () => {
    let t0 = Date.now();
    const dry = await call<{ run_id: string }>('scenario_run', { project: P, name: S, mode: 'dry' });
    await drain();
    expect((await studio.engine.runs.status(P, dry.run_id)).status).toBe('succeeded');
    timings.dry_run_ms = Date.now() - t0;

    await fetch(`${fixture.urls.console}/api/reset`, { method: 'POST' });
    t0 = Date.now();
    const capture = await call<{ run_id: string }>('scenario_run', { project: P, name: S, mode: 'capture' });
    await drain();
    expect((await studio.engine.runs.status(P, capture.run_id)).status).toBe('succeeded');
    timings.capture_ms = Date.now() - t0;
    runId = capture.run_id;

    t0 = Date.now();
    const file = await readFile(join(root, 'projects', P, 'scenarios', `${S}.yaml`));
    const render = await call<{ render_id: string }>('scenario_render', { project: P, name: S, run: runId, expect_edit_sha256: createHash('sha256').update(file).digest('hex') });
    await drain();
    timings.render_review_ms = Date.now() - t0;
    const rendersDir = join(root, 'projects', P, 'renders');
    const record = JSON.parse(await readFile(join(rendersDir, `${render.render_id}.json`), 'utf8')) as { status: string; duration_s: number; plan: EditPlan; review?: { verdict?: string } };
    expect(record.status).toBe('succeeded');
    const model = timelineOf(record.plan);
    const key = (s: { scene: string; step?: number }) => `${s.scene}.${s.step}`;
    // The caption, on the scene of the Request a quote click; the zoom on that click; the marker on the bag size.
    const ci = model.untrusted.captions.findIndex((c) => c.text === CAPTION);
    expect(ci, JSON.stringify(model.untrusted.captions)).toBeGreaterThanOrEqual(0);
    expect(model.untrusted.captions[ci].kicker).toBe(KICKER);
    const caption = model.captions.find((c) => c.i === ci)!;
    // The zoom the Studio offered is the theme's max_zoom: planned as requested, never clamped (review B-M3).
    const zoom = model.camera.find((c) => c.zoom === 1.4);
    expect(zoom?.requested_zoom ?? 1.4, JSON.stringify(model.camera)).toBe(1.4);
    expect(zoom, JSON.stringify(model.camera)).toBeDefined();
    const quoteStep = model.steps.find((s) => s.key === zoom!.key)!;
    expect(quoteStep.action).toBe('click');
    expect(caption.scene).toBe(quoteStep.scene);
    const mi = model.untrusted.markers.indexOf('m1');
    expect(mi, JSON.stringify(model.untrusted.markers)).toBeGreaterThanOrEqual(0);
    const marker = model.markers.find((m) => m.i === mi)!;
    expect(model.steps.find((s) => s.key === key(marker))?.action).toBe('select');
    expect(marker.frame).toBeGreaterThan(quoteStep.from);

    if (SHOTS) {
      const video = join(rendersDir, (await readdir(rendersDir)).find((f) => f.startsWith(render.render_id) && f.endsWith('.mp4'))!);
      const at = (frame: number) => (frame / model.fps).toFixed(3);
      const cut = (name: string, frame: number) =>
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', at(frame), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-1', join(SHOTS, `acc-frame-${name}.png`)]);
      cut('before-zoom', Math.max(0, zoom!.from - 15));
      cut('zoom-in', zoom!.in_to + 2);
      cut('zoom-end', zoom!.out_from - 2);
      cut('caption', Math.round((caption.from + caption.to) / 2));
      cut('marker', marker.frame);
      cut('marker-done', marker.done ?? marker.frame + 30);
      await writeFile(
        join(SHOTS, 'acc-model.json'),
        `${JSON.stringify({ captions: model.captions, camera: model.camera, markers: model.markers, steps: model.steps, untrusted: model.untrusted, frames: model.frames, fps: model.fps }, null, 1)}\n`,
      );
    }
    timings.video_s = record.duration_s;
    expect(consoleErrors).toEqual([]);
  }, 900_000);
});
