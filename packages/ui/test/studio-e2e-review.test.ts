/**
 * L5.12a: the Review report and Edit's Render, end to end in headless Chromium against a real Studio server (no worker:
 * nothing renders) — on the self-numbering bits take (test-support take.ts) with bits-v1, a render of the version the
 * timeline shows (a11y-tour's writeRender: its plan, an x264 video for its frames), and its review written by hand
 * (two sheets, three findings — one message carries markup), a render whose review is queued (v2), one whose review
 * failed (v3, its message hostile), one made with other theme files (v4, the newest: its finding's frame is not the
 * preview's), and a scenario without renders:
 * - the report (of bits-v1, by its address): the Mode's Review current, the browser pane hidden, the View (Report · Comments (1 open)); the head and
 *   the counts in words (⚑ never "passed"); ⚑ the sheets asked one at a time; the checks by family, each a group of one
 *   listbox, the keys move the selection; the inspector shows the finding's frame (render_frame) and its message as text;
 * - ⚑ Show in Edit opens the take at the finding's frame (the same plan as the timeline's);
 * - ⚑ Export video (MP4) queues one export job through review_export (path-free answer, the button off while it
 *   waits); the raw capture is a command to copy, built from the ids;
 * - a review queued (progress), a review failed (its message as text), ⚑ an unknown render id (said, nothing read with
 *   it), a malformed one (not found), no render yet; the scenario card (no "passed", its link to the report);
 * - ⚑ H2: Render — the report's and Edit's (the screen owns ⌘B: the menu's command is its button) queue a render through
 *   useRenders; ⚑ on a proposal's preview ⌘B renders nothing (said); ⚑ a file changed since Edit showed it is refused
 *   (render-refused) and the view read again.
 * L5.12a fixes (the two reviews): ⚑ on a proposal's preview Render is refused before the view is read and on an error too
 * (A-M1); ⚑ Show in Edit says "another version" only when the render is found and differs (B-M1), ⚑ a pending one is
 * dropped by an Edit that cannot show the take, whose browser pane stays collapsed (A-L6, A-L7); the renders newest first,
 * with their time of day when they share a date, each a link (B-L2, A-L5); the report's status bar says "Rendered" with a
 * neutral mark (B-L1); Edit: its status line in plain words (B-L3), the inspector's general hint last with no blank band
 * (B-L4), ⚑ the transport leaves the arrows to the playhead after a click (B-L5), [ ] and Shift+← → on the scrubber (A-L2),
 * every track item a 24 px target (A-L3).
 * `RETAKE_UI_SHOTS=<folder>` saves screenshots there.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page, Route } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, createEngine } from '@retake/engine';
import type { JobRecord } from '@retake/engine';
import type { EditPlan } from '@retake/editor';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { hasTool } from '@retake/test-support/repo';
import { writeRender } from './a11y-tour.js';
import { BITS_TEXT, bitsTimeline, takeWorkspace, writeTake, writeThread } from '@retake/test-support/take';
import { scratchHome } from '@retake/test-support/home';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const SHOTS = process.env.RETAKE_UI_SHOTS;
const POLL = { timeout: 30_000 };
const RUN = '20260101-120000-bits';
const THREAD = 'c_01JAAAAAAAAAAAAAAAAAAAAAAA';
const HOSTILE = 'The caption <b>Every frame</b> is long';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let ws: string;
let dir: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
let queue: FileJobQueue;
let entry: string;
/** The bits take's frames per second and the first frame of step a.1 (where v4's finding sends Edit). */
let fps = 30;
let stepA1 = 0;
const retakeHome = scratchHome();
const consoleErrors: string[] = [];
/** The ops the page called (name and body), in order. */
const calls: Array<{ op: string; body: string }> = [];
let inFlight = 0;
let maxImagesInFlight = 0;

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const jpeg = (file: string, colour: string) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=960x270`, '-frames:v', '1', file]);
const said = () => page.getByTestId('said').innerText();
const command = (id: string) => page.evaluate((x) => window.dispatchEvent(new CustomEvent('studio:command', { detail: { id: x } })), id);
const openJobs = async (kind: 'render' | 'export') => (await queue.list({ project: 'demo', kinds: [kind], limit: 50 })).filter((j) => j.state === 'queued' || j.state === 'running');

/** A copy of bits-v1's record under another id (no video of its own; no report). */
async function copyRender(id: string, n: number, created: string): Promise<void> {
  const r = JSON.parse(await readFile(join(dir, 'renders', 'bits-v1.json'), 'utf8')) as Record<string, unknown>;
  Object.assign(r, { id, render_version: n, created_at: created, finished_at: created, file: join(dir, 'renders', `${id}.mp4`), record: join(dir, 'renders', `${id}.json`) });
  await writeFile(join(dir, 'renders', `${id}.mp4`), 'video');
  await writeFile(join(dir, 'renders', `${id}.json`), JSON.stringify(r));
}

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-review-'));
  retakeHome.use(join(ws, '.home'));
  dir = await takeWorkspace(ws);
  await writeTake(dir, 'bits', { run: RUN, text: BITS_TEXT, timeline: bitsTimeline(), codec: 'vp9', seconds: 8 });
  await writeTake(dir, 'other', { run: '20260101-110000-other', text: BITS_TEXT.replace('video: Bits', 'video: Other'), timeline: bitsTimeline(), codec: 'vp9', seconds: 2 });
  studio = await startStudioServer({ root: ws, startWorker: false, pollMs: 100 });
  queue = new FileJobQueue(ws);
  const v = await studio.engine.timeline.view({ project: 'demo', scenario: 'bits' });
  if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
  await writeRender(dir, v.plan as EditPlan, v.view.hash!);
  // Its theme folder's hash as a render writes it (the timeline's "from this version" compares plan and theme files).
  // (L5.12a fixes, review B-L2: the oldest of the four, so the list reads v4, v3, v2, v1 — newest first.)
  const rec = JSON.parse(await readFile(join(dir, 'renders', 'bits-v1.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(
    join(dir, 'renders', 'bits-v1.json'),
    JSON.stringify({ ...rec, template_sha256: v.view.theme_sha256, created_at: '2026-01-01T11:00:00.000Z', finished_at: '2026-01-01T11:00:00.000Z' }),
  );
  fps = v.view.model.fps;
  stepA1 = v.view.model.steps.filter((s) => s.key === 'a.1').sort((a, b) => a.from - b.from)[0].from;
  // bits-v1's review, by hand: two sheets, three findings (one message with markup: text, never markup).
  const rv = join(dir, 'review', 'bits-v1');
  await mkdir(rv, { recursive: true });
  jpeg(join(rv, 'sheet_1fps.jpg'), 'navy');
  jpeg(join(rv, 'sheet_scene_a.jpg'), 'teal');
  await writeFile(
    join(rv, 'report.json'),
    JSON.stringify({
      version: 1,
      clean: false,
      counts: { error: 1, warning: 1, info: 1 },
      review: { created_at: '2026-01-01T13:01:00.000Z', fps: 1 },
      findings: [
        { severity: 'warning', code: 'caption-too-long', message: HOSTILE, at: { frame: 30, segment: 'a', scene: 'a', step: 1 } },
        { severity: 'info', code: 'video-length', message: 'the video lasts 6 s: shorter than the target of the reference look' },
        { severity: 'error', code: 'blank-screen', message: 'the screen is blank for 0.5 s', at: { frame: 120, segment: 'b', scene: 'b', step: 0 } },
      ],
      files: { sheets: [join(rv, 'sheet_1fps.jpg')], scene_sheets: { a: [join(rv, 'sheet_scene_a.jpg')] }, keyframes: {} },
    }),
  );
  // v2: its review queued; v3: its review failed (a hostile message); v4: other theme files (another version), reviewed.
  await copyRender('bits-v2', 2, '2026-01-01T12:00:00.000Z');
  await copyRender('bits-v3', 3, '2026-01-01T12:30:00.000Z');
  await copyRender('bits-v4', 4, '2026-01-01T12:45:00.000Z');
  const v4 = JSON.parse(await readFile(join(dir, 'renders', 'bits-v4.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(join(dir, 'renders', 'bits-v4.json'), JSON.stringify({ ...v4, template_sha256: 'f'.repeat(64) }));
  await mkdir(join(dir, 'review', 'bits-v4'), { recursive: true });
  await writeFile(
    join(dir, 'review', 'bits-v4', 'report.json'),
    JSON.stringify({
      version: 1,
      clean: false,
      counts: { error: 0, warning: 1, info: 0 },
      review: { created_at: '2026-01-01T12:46:00.000Z', fps: 1 },
      findings: [{ severity: 'warning', code: 'caption-too-long', message: 'long', at: { frame: stepA1 + 5, segment: 'a', scene: 'a', step: 1 } }],
      files: { sheets: [], keyframes: {} },
    }),
  );
  await queue.enqueue({ version: 1, kind: 'review', project: 'demo', render_id: 'bits-v2', fps: 1, submitted_by: 'test' });
  const failed = await queue.enqueue({ version: 1, kind: 'review', project: 'demo', render_id: 'bits-v3', fps: 1, submitted_by: 'test' });
  await queue.write({
    ...(await queue.get(failed.id))!,
    state: 'failed',
    finished_at: '2026-01-01T12:31:00.000Z',
    error: { code: 'internal', message: 'Error: the review <i>crashed</i>' },
  } as JobRecord);
  // A thread with Claude's proposal (its preview is Edit on a proposal route).
  await writeThread(dir, {
    id: THREAD,
    scenario: 'bits',
    run: RUN,
    frames: v.plan.durationInFrames,
    text: 'The caption could be plainer',
    anchor: { segment: 'a', kind: 'clip', scene: 'a', step: 1 },
  });
  const mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  entry = (
    await mcp.comments.reply('demo', THREAD, 'A plainer caption.', {
      proposal: { scenario_yaml: BITS_TEXT.replace('caption: Every frame carries its number.', 'caption: Every frame shows its number.'), scenario_hash: sha(BITS_TEXT) },
    })
  ).entry;
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('request', (r) => {
    const m = /\/v1\/call\/([a-z_]+)/.exec(r.url());
    if (!m) return;
    calls.push({ op: m[1], body: r.postData() ?? '' });
    if (m[1] === 'review_image') maxImagesInFlight = Math.max(maxImagesInFlight, ++inFlight);
  });
  const done = (r: { url(): string }) => {
    if (r.url().includes('/v1/call/review_image')) inFlight--;
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('the Review report in Chromium (L5.12a)', () => {
  it('⚑ the report: the View, the counts in words (never "passed"), the sheets one at a time, the checks by family and their keys, the frame of a check', async () => {
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v1`);
    await page.getByTestId('review-report').waitFor(POLL);
    await expect.poll(() => page.locator('.rv-h1').innerText(), POLL).toBe('bits · v1');
    expect(await page.title()).toBe('bits · Review report · Retake');
    expect(await page.getByRole('navigation', { name: 'Mode' }).getByRole('link', { name: 'Review' }).getAttribute('aria-current')).toBe('page');
    expect(await page.locator('.sh-app').getAttribute('data-browser')).toBe('none');
    const views = page.getByRole('navigation', { name: 'View' });
    expect(await views.getByRole('link', { name: 'Report' }).getAttribute('aria-current')).toBe('page');
    await expect.poll(() => page.getByTestId('comments-tab').innerText(), POLL).toBe('Comments (1 open)');
    await expect.poll(() => page.getByTestId('review-verdict').innerText(), POLL).toContain('1 error, 1 warning, 1 note');
    // The status bar: what the render did, with a neutral mark — never a verdict beside the review's (review B-L1).
    // L5.12b fixes (review B-M3): the line Review shares with Comments ends with the scenario's comment counts.
    expect((await page.getByTestId('review-state').textContent())!.replace(/\s+/g, ' ').trim()).toMatch(/^Rendered · .+ · v1 · \d+ open · \d+ resolved$/);
    expect(await page.getByTestId('review-state').locator('.k-mark-shape').getAttribute('class')).toContain('k-mark-idle');
    // v1 shows the version on screen: no "another version" note.
    expect(await page.getByTestId('review-other-version').count()).toBe(0);
    // ⚑ Never "passed" (a review does not record which checks ran).
    expect(await page.locator('#main').innerText()).not.toMatch(/\bpassed\b/i);
    // ⚑ The sheets, each asked once its turn came (one review_image in flight at a time), shown as checked JPEGs.
    await expect.poll(() => page.locator('[data-testid="review-sheet"][data-state="ok"]').count(), POLL).toBe(2);
    expect(maxImagesInFlight).toBe(1);
    expect(await page.getByTestId('review-sheet').first().locator('img').getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
    expect(await page.getByTestId('review-sheet').allInnerTexts()).toEqual(['contact sheet (1 fps)', 'scene sheet a']);
    // The checks: the families that found something, in the table's order, each a group of the one listbox.
    expect(await page.getByTestId('review-family').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).toEqual(['length', 'captions', 'blank']);
    expect(await page.locator('[role="listbox"] [role="group"]').count()).toBe(3);
    expect(await page.getByTestId('review-finding').count()).toBe(3);
    expect(await page.getByTestId('review-nothing-else').innerText()).toBe('Nothing else found.');
    // A message is text (its markup shown, never made).
    expect(await page.getByTestId('review-findings').innerText()).toContain(HOSTILE);
    expect(await page.locator('#main b, .sh-inspector b').count()).toBe(0);
    // The keys: the first is selected; ↓ the caption's (its frame), End the blank screen's, Home back.
    const list = page.getByRole('listbox');
    await list.focus();
    const active = () => list.getAttribute('aria-activedescendant');
    expect(await active()).toBe('rv-finding-1');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toBe('rv-finding-0');
    expect(await page.locator('#rv-finding-0').getAttribute('aria-selected')).toBe('true');
    await expect.poll(() => page.getByTestId('review-check-message').innerText(), POLL).toBe(HOSTILE);
    const frame = page.getByTestId('review-frame');
    await expect.poll(() => frame.getAttribute('data-state'), POLL).toBe('ok');
    expect(await frame.getAttribute('data-frame')).toBe('30');
    expect(await frame.locator('img').evaluate((el: HTMLImageElement) => el.decode().then(() => el.naturalWidth))).toBeGreaterThan(100);
    await shot('review-1-check');
    await page.keyboard.press('End');
    expect(await active()).toBe('rv-finding-2');
    await expect.poll(() => frame.getAttribute('data-frame'), POLL).toBe('120');
    await page.keyboard.press('Home');
    expect(await active()).toBe('rv-finding-1');
    await expect.poll(() => page.getByTestId('review-frame').count(), POLL).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
  }, 120_000);

  it("⚑ Show in Edit opens the take at the finding's frame (the same plan as the timeline's)", async () => {
    await page.getByRole('listbox').focus();
    await page.keyboard.press('ArrowDown');
    await page.getByTestId('review-show-in-edit').click();
    await page.waitForURL(`**#/p/demo/s/bits/timeline/${RUN}`);
    await expect.poll(async () => Number(await page.getByTestId('preview').getAttribute('data-frame')), POLL).toBe(30);
    expect(await page.getByTestId('edit-seek-note').count()).toBe(0);
  }, 60_000);

  it('⚑ Export video (MP4): one export job through review_export, a path-free answer, the button off while it waits; the raw capture a command to copy', async () => {
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v1`);
    await page.getByTestId('review-export').waitFor(POLL);
    const answer = page.waitForResponse((r) => r.url().includes('/v1/call/review_export'));
    await page.getByTestId('review-export').click();
    const body = await (await answer).text();
    for (const needle of [ws, 'exports/', '.mp4']) expect(body.includes(needle), needle).toBe(false);
    await expect.poll(() => page.getByTestId('review-export-state').innerText(), POLL).toMatch(/^Export of v1 queued \(job j_[A-Za-z0-9_-]+\): MP4 1080p, into the project's exports folder\.$/);
    expect(await page.getByTestId('review-export').isDisabled()).toBe(true);
    const jobs = await openJobs('export');
    expect(jobs.map((j) => j.input)).toEqual([{ version: 1, kind: 'export', project: 'demo', render_id: 'bits-v1', formats: ['mp4_1080p'], submitted_by: 'ui' }]);
    // A reload follows the same job from the activity (path-free), the button still off.
    await page.reload();
    await expect.poll(() => page.getByTestId('review-export-state').innerText(), POLL).toContain(`(job ${jobs[0].id})`);
    expect(await page.getByTestId('review-export').isDisabled()).toBe(true);
    // The raw capture: a command built from the ids, copied as shown.
    const raw = page.getByTestId('review-export-raw');
    expect(await raw.innerText()).toContain(`retake export-capture demo ${RUN}`);
    await raw.getByRole('button', { name: 'Copy command' }).click();
    await expect.poll(() => raw.locator('.k-copied').innerText(), POLL).toBe('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`retake export-capture demo ${RUN}`);
    await raw.scrollIntoViewIfNeeded();
    await shot('review-2-export');
    await studio.engine.jobs.cancel(jobs[0].id);
  }, 60_000);

  it('a review queued, a review failed, ⚑ an unknown render (nothing read with it), a malformed one, no render yet; the scenario card', async () => {
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v2`);
    await page.getByTestId('review-running').waitFor(POLL);
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v3`);
    await page.getByTestId('review-failed').waitFor(POLL);
    expect(await page.getByTestId('review-failed').innerText()).toContain('the review <i>crashed</i>');
    expect(await page.locator('#main i').count()).toBe(0);
    // ⚑ Unknown: said, and no read names it.
    const before = calls.length;
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v9`);
    await page.getByTestId('review-unknown').waitFor(POLL);
    expect(await page.getByTestId('review-unknown').innerText()).toContain('bits has no render bits-v9');
    expect(calls.slice(before).filter((c) => c.body.includes('bits-v9'))).toEqual([]);
    // A malformed render id: not an address of the Studio.
    await page.goto(`${studio.url}#/p/demo/s/bits/review/..%2Fx`);
    await page.getByRole('heading', { level: 1, name: 'Nothing here' }).waitFor(POLL);
    // No render yet.
    await page.goto(`${studio.url}#/p/demo/s/other/review`);
    await page.getByTestId('review-empty').waitFor(POLL);
    await shot('review-3-empty');
    // The scenario's card: its renders and their verdict (never "passed"), and the way to the report.
    await page.goto(`${studio.url}#/p/demo/s/bits`);
    await page.getByTestId('renders-section').locator('summary').click();
    const card = page.getByTestId('renders-card');
    await expect.poll(() => card.locator('[data-testid="render-row"]').count(), POLL).toBe(3);
    expect(await card.innerText()).not.toMatch(/\bpassed\b/i);
    // Newest first (the newest three, then Show all); they share a date, so each says its time of day too (review B-L2);
    // a row is a link (A-L5).
    expect(await card.getByTestId('render-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(['bits-v4', 'bits-v3', 'bits-v2']);
    await card.getByRole('button', { name: 'Show all 4 renders' }).click();
    expect(await card.getByTestId('render-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(['bits-v4', 'bits-v3', 'bits-v2', 'bits-v1']);
    for (const t of await card.getByTestId('render-row').allInnerTexts()) expect(t).toMatch(/Jan 1, 2026 \d{2}:\d{2} · /);
    expect(await card.locator('[data-testid="render-row"][data-id="bits-v2"] a').getAttribute('href')).toBe('#/p/demo/s/bits/review/bits-v2');
    expect(await card.locator('[data-testid="render-row"] [aria-pressed]').count()).toBe(0);
    expect(await card.getByTestId('open-review-report').getAttribute('href')).toBe('#/p/demo/s/bits/review');
  }, 60_000);

  it("the screens at 1440, 1280 and 900, dark and light: the status bar's Render in sight, nothing scrolls sideways (shots)", async () => {
    const check = async (name: string) => {
      for (const [scheme, widths] of [
        ['dark', [1440, 1280, 900]],
        ['light', [1280, 900]],
      ] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForTimeout(150);
          const box = (await page.getByTestId('render').boundingBox())!;
          expect(box.x + box.width, `${name} ${scheme} ${width}: Render in sight`).toBeLessThanOrEqual(width);
          expect(await page.evaluate(() => document.getElementById('main')!.scrollWidth - document.getElementById('main')!.clientWidth), `${name} ${scheme} ${width}`).toBeLessThanOrEqual(1);
          await shot(`${name}-${scheme}-${width}`);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: 'dark' });
    };
    await page.goto(`${studio.url}#/p/demo/s/bits/timeline`);
    await page.getByTestId('tracks').waitFor(POLL);
    await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
    await check('edit-segment');
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v1`);
    await page.getByRole('listbox').focus();
    await page.keyboard.press('ArrowDown');
    await page.locator('[data-testid="review-frame"][data-state="ok"]').waitFor(POLL);
    await check('review-check');
  }, 120_000);

  it("⚑ H2: Render — the report's and Edit's own (the menu's ⌘B is their button); on a proposal ⌘B renders nothing; a changed file is refused and read again", async () => {
    // The report: Render renders the scenario's latest capture with the file on disk.
    await page.goto(`${studio.url}#/p/demo/s/other/review`);
    await page.getByTestId('review-empty').waitFor(POLL);
    await expect.poll(() => page.getByTestId('render').isDisabled(), POLL).toBe(false);
    await command('render');
    await expect.poll(async () => (await openJobs('render')).length, POLL).toBe(1);
    const job = (await openJobs('render'))[0];
    expect(job.input).toMatchObject({
      kind: 'render',
      scenario: 'other',
      run_id: '20260101-110000-other',
      edit_sha256: sha(BITS_TEXT.replace('video: Bits', 'video: Other')),
      review: { fps: 1 },
      submitted_by: 'ui',
    });
    // One render of a scenario at a time: the button off, ⌘B says why and queues nothing.
    await expect.poll(() => page.getByTestId('render').isDisabled(), POLL).toBe(true);
    await command('render');
    await expect.poll(said, POLL).toMatch(/^Render of other: v1 is queued: one render of a scenario at a time$/);
    expect(await openJobs('render')).toHaveLength(1);
    await studio.engine.jobs.cancel(job.id);

    // ⚑ A proposal's preview: Render is off, ⌘B says why and renders nothing.
    await page.goto(`${studio.url}#/p/demo/s/bits/proposal/${THREAD}/${entry}`);
    await page.getByTestId('tracks').waitFor(POLL);
    expect(await page.getByTestId('render').isDisabled()).toBe(true);
    await command('render');
    await expect.poll(said, POLL).toBe('Render of bits: Previewing a proposal: apply it (Apply and re-render renders it)');
    expect(await openJobs('render')).toEqual([]);

    // Edit: ⌘B renders the capture and the file shown.
    await page.goto(`${studio.url}#/p/demo/s/bits/timeline`);
    await page.getByTestId('tracks').waitFor(POLL);
    await expect.poll(() => page.getByTestId('render').isDisabled(), POLL).toBe(false);
    await command('render');
    await expect.poll(async () => (await openJobs('render')).length, POLL).toBe(1);
    const edit = (await openJobs('render'))[0];
    expect(edit.input).toMatchObject({ kind: 'render', scenario: 'bits', run_id: RUN, edit_sha256: sha(BITS_TEXT) });
    await expect.poll(() => page.getByTestId('render-job').getAttribute('data-state'), POLL).toBe('queued');
    // M6: Cancel in the status bar (Stop is for runs).
    await page.getByTestId('render-cancel').click();
    await expect.poll(async () => (await openJobs('render')).length, POLL).toBe(0);

    // ⚑ The file changed since Edit showed it: refused (said, nothing queued), the view read again.
    const held: Route[] = [];
    await page.route('**/v1/call/timeline_view', (r) => void held.push(r));
    const changed = BITS_TEXT.replace('caption: Every frame carries its number.', 'caption: Every frame, numbered.');
    await writeFile(join(dir, 'scenarios', 'bits.yaml'), changed);
    await expect.poll(() => page.getByTestId('render').isDisabled(), POLL).toBe(false);
    await page.getByTestId('render').click();
    await page.getByTestId('render-refused').waitFor(POLL);
    expect(await openJobs('render')).toEqual([]);
    await page.unroute('**/v1/call/timeline_view');
    for (const r of held) await r.continue().catch(() => undefined);
    await expect.poll(() => page.getByTestId('timeline').getAttribute('data-hash'), POLL).toBe(sha(changed));
    await writeFile(join(dir, 'scenarios', 'bits.yaml'), BITS_TEXT);
    expect(consoleErrors).toEqual([]);
  }, 120_000);

  it("⚑ A-M1: on a proposal's preview Render is refused before the view is read and on an error — ⌘B and the status bar's Render queue nothing", async () => {
    // The view held back: Edit is still loading (not mounted), the status bar's own Render shows.
    const held: Route[] = [];
    await page.route('**/v1/call/timeline_view', (r) => void held.push(r));
    await page.goto(`${studio.url}#/p/demo/s/bits/proposal/${THREAD}/${entry}`);
    await page.getByText('Loading the timeline…').waitFor(POLL);
    await expect.poll(() => page.getByTestId('run-render').isDisabled(), POLL).toBe(true);
    expect(await page.locator(`#${await page.getByTestId('run-render').getAttribute('aria-describedby')}`).innerText()).toBe(
      'Render: Previewing a proposal: apply it (Apply and re-render renders it)',
    );
    await command('render');
    await expect.poll(said, POLL).toBe('Render of bits: Previewing a proposal: apply it (Apply and re-render renders it)');
    expect(await openJobs('render')).toEqual([]);
    await page.unroute('**/v1/call/timeline_view');
    for (const r of held) await r.continue().catch(() => undefined);
    // A stale entry: Edit's error state — still refused.
    await page.goto(`${studio.url}#/p/demo/s/bits/proposal/${THREAD}/e_01JBBBBBBBBBBBBBBBBBBBBBBB`);
    await page.getByTestId('timeline-error').waitFor(POLL);
    await expect.poll(() => page.getByTestId('run-render').isDisabled(), POLL).toBe(true);
    await command('render');
    await expect.poll(said, POLL).toBe('Render of bits: Previewing a proposal: apply it (Apply and re-render renders it)');
    expect(await openJobs('render')).toEqual([]);
  }, 60_000);

  it('⚑ B-M1 / A-L6 / A-L7: Show in Edit — no "another version" for a finding without a frame on this version; the note and the step for v4 (another version); a pending one dropped by an Edit that cannot show the take (its browser pane collapsed)', async () => {
    // bits-v1, the video's length (no frame): Edit opens, says nothing about another version, stays at the start.
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v1`);
    await page.getByRole('listbox').focus();
    await page.keyboard.press('Home');
    await expect.poll(() => page.getByTestId('review-check-message').innerText(), POLL).toContain('the video lasts 6 s');
    await page.getByTestId('review-show-in-edit').click();
    await page.waitForURL(`**#/p/demo/s/bits/timeline/${RUN}`);
    await page.getByTestId('tracks').waitFor(POLL);
    await page.waitForTimeout(500);
    expect(await page.getByTestId('edit-seek-note').count()).toBe(0);
    expect(Number(await page.getByTestId('preview').getAttribute('data-frame'))).toBe(0);
    // bits-v4 (other theme files: the report, which plans nothing, cannot tell): Edit goes to the step its finding points
    // at, with the note.
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v4`);
    await page.getByTestId('review-finding').first().waitFor(POLL);
    await page.getByTestId('review-show-in-edit').click();
    await page.waitForURL(`**#/p/demo/s/bits/timeline/${RUN}`);
    await page.getByTestId('edit-seek-note').waitFor(POLL);
    expect(await page.getByTestId('edit-seek-note').innerText()).toContain('v4 was made from another version of the edit');
    await expect.poll(async () => Number(await page.getByTestId('preview').getAttribute('data-frame')), POLL).toBe(stepA1);
    // An Edit that cannot show the take: the ask is dropped (no seek on the next visit), the browser pane stays collapsed.
    await page.goto(`${studio.url}#/p/demo/s/bits/review/bits-v1`);
    await page.getByRole('listbox').focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.getByTestId('review-check-message').innerText(), POLL).toBe(HOSTILE);
    await page.route('**/v1/call/timeline_view', (r) =>
      r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'not_found', message: 'No capture of bits' } }) }),
    );
    await page.getByTestId('review-show-in-edit').click();
    await page.getByTestId('timeline-error').waitFor(POLL);
    expect(await page.locator('.sh-app').getAttribute('data-browser')).toBe('none');
    await page.unroute('**/v1/call/timeline_view');
    await page.goto(`${studio.url}#/p/demo/s/bits/timeline`);
    await page.getByTestId('tracks').waitFor(POLL);
    await page.waitForTimeout(500);
    expect(Number(await page.getByTestId('preview').getAttribute('data-frame'))).toBe(0);
    expect(await page.getByTestId('edit-seek-note').count()).toBe(0);
  }, 90_000);

  it("Edit: the status line in plain words (B-L3); the inspector's general hint last, no blank band (B-L4); ⚑ the transport leaves the arrows to the playhead after a click (B-L5); [ ] and Shift+← → on the scrubber (A-L2); every track item a 24 px target (A-L3)", async () => {
    await page.goto(`${studio.url}#/p/demo/s/bits/timeline`);
    await page.getByTestId('tracks').waitFor(POLL);
    const frame = async () => Number(await page.getByTestId('preview').getAttribute('data-frame'));
    // B-L3: plain words, no tag, never two spaces.
    const source = page.getByTestId('timeline-source');
    expect(await source.innerText()).toBe(`Today's edit of take ${RUN}`);
    expect(await source.locator('.k-tag').count()).toBe(0);
    expect(await page.getByTestId('edit-state').innerText()).not.toMatch(/ {2}/);
    // B-L4: the selected segment first (right under the pane's top), the general hint last.
    await page.locator('[data-testid="tl-segment"][data-id="a"]').click();
    const band = await page.evaluate(
      () => document.querySelector('[data-testid="inspector-segment"]')!.getBoundingClientRect().top - document.querySelector('.sh-inspector')!.getBoundingClientRect().top,
    );
    expect(band).toBeLessThanOrEqual(16);
    expect(await page.locator('.ed-inspector > :last-child').getAttribute('data-testid')).toBe('inspector-general');
    // B-L5: a click on Next frame (no blur), then → and End are the playhead's, not the toolbar's.
    await page.getByTestId('play').waitFor(POLL);
    const at = await frame();
    await page.getByTestId('next-frame').click();
    await expect.poll(frame, POLL).toBe(at + 1);
    await page.keyboard.press('ArrowRight');
    await expect.poll(frame, POLL).toBe(at + 2);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('next-frame');
    await page.keyboard.press('Home');
    await expect.poll(frame, POLL).toBe(0);
    // (After a Tab into it the toolbar roves: the kit's own test.) A-L2: the scrubber focused — ] the next segment, Shift+→ a second.
    await page.getByTestId('scrubber').focus();
    await page.keyboard.press(']');
    await expect.poll(frame, POLL).toBeGreaterThan(0);
    const seg = await frame();
    expect(await page.locator('[data-testid="tl-segment"][aria-pressed="true"]').count()).toBe(1);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(frame, POLL).toBe(seg + fps);
    await page.keyboard.press('[');
    await expect.poll(frame, POLL).toBe(seg);
    // A-L3: every track item is at least 24 px tall; a tick 24 px wide; a span narrower has a 24 px hit area.
    const sizes = await page.locator('.k-trackitem-button').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        const hit = Math.max(r.width, parseFloat(getComputedStyle(e, '::before').width) || 0);
        return { h: r.height, hit, tick: e.parentElement!.classList.contains('is-tick') };
      }),
    );
    expect(sizes.length).toBeGreaterThan(5);
    for (const z of sizes) {
      expect(z.h).toBeGreaterThanOrEqual(24);
      expect(z.hit).toBeGreaterThanOrEqual(24);
    }
  }, 60_000);
});
