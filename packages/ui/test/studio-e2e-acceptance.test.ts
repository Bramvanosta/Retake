/**
 * L4.9 part D, the R-ACC4-01 acceptance (SPEC §14.4), gated by BOTH `DEMO_STUDIO_TEST_SLOW=1` and the installed-Chrome
 * opt-in `DEMO_STUDIO_TEST_CHROME=1` (skipped when Google Chrome is not installed or ffmpeg is missing): the Studio end
 * to end through its screens on the fixture product, in the installed Google Chrome (Playwright `channel: 'chrome'`, a
 * temporary profile Playwright creates and deletes — never the person's own; captures are H.264, which Playwright's
 * Chromium cannot play), on a copy of projects/northfield-fixture whose environments point at the fixture started on
 * free ports (never 4401–4404). The Studio starts the worker itself on the first job (as a person's Studio does; the
 * live worker of the workspace's lock — its start time checked, never a pid read earlier that may be reused — is killed at
 * the end, whatever happened). Every action is a click or a key on the page:
 * 1. Projects → Northfield (fixture) → highlights;
 * 2. blocks: a step selected, its hold changed in the inspector form → exactly that line of the file changes;
 * 3. Dry run → the Run screen: the live picture paints, the steps finish, succeeded; Capture → succeeded;
 * 4. Open timeline → the quotes segment → its layout switched to another value → one line written, the preview
 *    settles on the same frame with other pixels; ⌘Z → the exact bytes, the view back on its first hash (the click
 *    after an undo still in flight would be dropped); switched again and kept → Render → the review's verdict inline
 *    (the wait fails fast, with the job's phase, when the render job runs with no live worker or makes no progress for
 *    5 min);
 * 5. Comment at the playhead → the Comments screen at that frame of v1, a region typed in the four % fields → Post →
 *    a thread of the channel `studio`;
 * 6. a proposal (an in-process engine of client `mcp`, as `comment_reply` makes one — no model involved): its diff in
 *    the thread → Apply → the file holds exactly the proposed bytes → Resolve.
 * The checker (a11y.ts, every rule but the Tab walk — the tours walk) runs on each of the 11 stages at 1280, and at 1440
 * on six (projects, blocks-edited, timeline, rendered, comment-composer, proposal): 17 audits.
 * Timings logged; no CSP violation, no console error. `DEMO_STUDIO_UI_SHOTS=<folder>` saves a screenshot of every
 * stage, the preview before / after the switch and a frame of the render cut on the switched segment.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentThread } from '@demo-studio/core';
import { createEngine, liveWorker } from '@demo-studio/engine';
import type { Engine } from '@demo-studio/engine';
import type { RenderRecord } from '@demo-studio/editor';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO } from '../../engine/test/helpers.js';
import { hasTool, linkSharedCache } from '../../editor/test/render-helpers.js';
import { auditPage, formatFindings, settle } from './a11y.js';

const CHROME_APP = '/Applications/Google Chrome.app';
const gated = process.env.DEMO_STUDIO_TEST_SLOW === '1' && process.env.DEMO_STUDIO_TEST_CHROME === '1' && hasTool('ffmpeg') && hasTool('ffprobe') && (process.platform !== 'darwin' || existsSync(CHROME_APP));
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const P = 'northfield-fixture';
const S = 'highlights';
const FIXTURE_PROJECT = join(REPO, 'projects', P);
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.demo-studio', 'frames', 'comments']);
const POLL = { timeout: 60_000 };
const LONG = { timeout: 600_000, interval: 250 };
/** The render + review wait: its bound, and how long the job may show the same phase before the wait gives up. */
const RENDER_MAX_MS = 600_000;
const RENDER_STALL_MS = 300_000;
const AUTHOR = 'Studio Person';
const CAPTION = 'caption: {kicker: Quotes, text: "Every request and every proposal, in one list."}';
const PROPOSED_CAPTION = 'Every request and its proposal, side by side.';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

let fixture: Fixture;
let root: string;
let dir: string;
let studio: StudioServer;
let mcp: Engine;
let browser: Browser;
let page: Page;
const saved = { home: process.env.DEMO_STUDIO_HOME, author: process.env.DEMO_STUDIO_AUTHOR, disk: process.env.DEMO_STUDIO_DISK_WARN };
const consoleErrors: string[] = [];
const timings: string[] = [];
const audits: string[] = [];
const ids = { capture: '', thread: '', frame: 0 };

const scenarioFile = () => join(dir, 'scenarios', `${S}.yaml`);
const timed = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  const r = await fn();
  timings.push(`${what} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return r;
};

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `acceptance-${name}.png`) });
}

/** The checker on the page as it stands, at 1280 (and 1440 when asked, back to 1280 after). */
async function check(name: string, wide = false): Promise<void> {
  for (const width of wide ? [1280, 1440] : [1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const a = await auditPage(page);
    audits.push(`${name}@${width}: ${a.stats.texts} texts (${a.stats.overMedia} over media, ${a.stats.unmeasured.length} unmeasured), ${a.stats.controls} controls; ${a.findings.length} findings`);
    expect(a.findings, `${name} @${width}\n${formatFindings(a.findings)}`).toEqual([]);
    // Text straight on the live picture or the preview (no veil between) cannot be measured: none on these screens.
    expect(a.stats.unmeasured, `${name} @${width}`).toEqual([]);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The share (%) of pixels that changed (a channel by more than 24 levels) between two PNG pictures of the preview, over their common top-left area (the frame may settle a pixel taller). */
function pictureDiff(a: Buffer, b: Buffer): number {
  const size = (png: Buffer) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: png }).toString().trim().split(',').map(Number);
  const [wa, ha] = size(a);
  const [wb, hb] = size(b);
  const w = Math.min(wa, wb);
  const h = Math.min(ha, hb);
  expect(Math.abs(wa - wb) + Math.abs(ha - hb)).toBeLessThanOrEqual(4);
  const rgb = (png: Buffer) => execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', `crop=${w}:${h}:0:0`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 * 1024 });
  const A = rgb(a);
  const B = rgb(b);
  let changed = 0;
  for (let i = 0; i < A.length; i += 3) if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > 24) changed++;
  return (100 * changed) / (A.length / 3);
}

beforeAll(async () => {
  if (!gated) return;
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: Record<string, unknown>): Promise<Fixture> };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
  root = await mkdtemp(join(tmpdir(), 'studio-ui-acceptance-'));
  process.env.DEMO_STUDIO_HOME = join(root, '.home');
  process.env.DEMO_STUDIO_AUTHOR = AUTHOR;
  process.env.DEMO_STUDIO_DISK_WARN = 'off';
  await writeFile(join(root, 'studio.yaml'), `version: 1\nprojects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  dir = join(root, 'projects', P);
  await cp(FIXTURE_PROJECT, dir, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
  const strip = (u: string) => u.replace(/\/$/, '');
  const yaml = await readFile(join(dir, 'project.yaml'), 'utf8');
  await writeFile(
    join(dir, 'project.yaml'),
    yaml
      .replaceAll('http://localhost:4401', strip(fixture.urls.console))
      .replaceAll('http://localhost:4402', strip(fixture.urls.shop))
      .replaceAll('http://localhost:4403', strip(fixture.urls.signedIn!.console))
      .replaceAll('http://localhost:4404', strip(fixture.urls.signedIn!.shop)),
  );
  await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
  // The repository's render cache (no rebundle per test file), as the other render acceptances (made when absent).
  await linkSharedCache(root);
  // The worker is the Studio's own: started on the first job, exits after 20 s idle (killed by pid at the end).
  studio = await startStudioServer({ root, pollMs: 100, workerIdleExitMs: 20_000, log: () => undefined });
  mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  await context.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
}, 240_000);

afterAll(async () => {
  if (timings.length) console.log(`R-ACC4-01 acceptance timings: ${timings.join('; ')}\nchecker:\n  ${audits.join('\n  ')}`);
  await browser?.close();
  await studio?.close();
  // The workspace's live worker only (liveWorker checks the lock's start time: a pid read earlier may be another process now).
  const w = root ? await liveWorker(root) : null;
  if (w) {
    try {
      process.kill(w.pid, 'SIGKILL');
    } catch {
      /* exited meanwhile */
    }
  }
  await fixture?.close();
  for (const [k, val] of [['DEMO_STUDIO_HOME', saved.home], ['DEMO_STUDIO_AUTHOR', saved.author], ['DEMO_STUDIO_DISK_WARN', saved.disk]] as const) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!gated)('R-ACC4-01: the Studio end to end on the fixture in the installed Google Chrome (L4.9 part D)', () => {
  it('projects → highlights; a hold changed in the form (one line); a dry run watched live; a capture', async () => {
    await page.goto(studio.launchUrl());
    await page.getByRole('heading', { level: 1, name: 'Projects' }).waitFor(POLL);
    await check('projects', true);
    await page.locator('main').getByRole('link', { name: 'Northfield (fixture)' }).first().click();
    await page.waitForURL(`**#/p/${P}`);
    await page.locator('main').getByRole('link', { name: S, exact: true }).first().click();
    await page.waitForURL(`**#/p/${P}/s/${S}`);
    await page.getByTestId('blocks').waitFor(POLL);
    await shot('1-blocks');

    // The second step of coffees: its hold 1.2 → 1.6 in the inspector form; exactly that line changes.
    const before = await readFile(scenarioFile(), 'utf8');
    await page.locator('[data-testid="step"][data-key="coffees.1"]').click();
    const form = page.getByTestId('step-form');
    await form.waitFor(POLL);
    expect(await form.locator('[data-field="hold"]').inputValue()).toBe('1.2');
    await form.locator('[data-field="hold"]').fill('1.6');
    await page.getByTestId('form-save').click();
    await expect.poll(() => page.getByTestId('edit-live').innerText(), POLL).toMatch(/Saved/);
    const after = await readFile(scenarioFile(), 'utf8');
    expect(after).toBe(before.replace('        hold: 1.2\n', '        hold: 1.6\n'));
    await check('blocks-edited', true);
    await shot('2-form-saved');

    // Dry run from the Run screen (a dry run skips hooks: the shop reset first, as the setup hook would).
    expect((await fetch(`${fixture.urls.shop.replace(/\/$/, '')}/api/reset`, { method: 'POST' })).ok).toBe(true);
    await page.goto(`${studio.url}#/p/${P}/s/${S}/run`);
    await page.getByTestId('start-dry').waitFor(POLL);
    await check('run-preflight');
    await timed('dry run (click → succeeded)', async () => {
      await page.getByTestId('start-dry').click();
      await expect.poll(() => page.url(), POLL).toMatch(/\/run\/\d{8}-\d{6}-highlights$/);
      await expect.poll(() => page.getByTestId('live-canvas').evaluate((c) => Number((c as HTMLCanvasElement).dataset.frames ?? 0)), LONG).toBeGreaterThan(3);
      await check('run-live');
      await shot('3-dry-live');
      await expect.poll(() => page.getByTestId('run-outcome').getAttribute('data-status').catch(() => null), LONG).toBe('succeeded');
    });
    await check('run-succeeded');
    await shot('4-dry-succeeded');

    // Capture from the preflight.
    await page.goto(`${studio.url}#/p/${P}/s/${S}/run`);
    await page.getByTestId('start-capture').waitFor(POLL);
    await timed('capture (click → succeeded)', async () => {
      await page.getByTestId('start-capture').click();
      await expect.poll(() => page.url(), POLL).toMatch(/\/run\/\d{8}-\d{6}-highlights$/);
      ids.capture = /\/run\/(\d{8}-\d{6}-highlights)$/.exec(page.url())![1];
      await expect.poll(() => page.getByTestId('run-outcome').getAttribute('data-status').catch(() => null), LONG).toBe('succeeded');
    });
    expect((await studio.engine.runs.status(P, ids.capture)).status).toBe('succeeded');
    await shot('5-capture-succeeded');
  }, 900_000);

  it('Open timeline → the quotes segment\'s layout switched (one line, other pixels, same frame); ⌘Z; kept → Render → the verdict', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/${S}`);
    await page.getByTestId('open-timeline').click();
    await page.getByTestId('tracks').waitFor(POLL);
    await page.locator('[data-testid="tl-segment"][data-id="quotes"]').click();
    const key = 'scene:quotes:frame';
    const radios = page.locator(`[data-testid="switch"][data-key="${key}"] [role="radio"]`);
    await radios.first().waitFor(POLL);
    await expect.poll(() => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
    const frame0 = Number(await page.getByTestId('preview').getAttribute('data-frame'));
    const now = (await page.locator(`[data-testid="switch"][data-key="${key}"] [role="radio"][aria-checked="true"]`).getAttribute('data-value')) ?? '';
    const values = await radios.evaluateAll((els) => els.filter((e) => e.getAttribute('aria-disabled') !== 'true').map((e) => e.getAttribute('data-value') ?? ''));
    const target = ['browser', 'laptop', 'raw'].find((v) => v !== now && values.includes(v))!;
    expect(target, `${now} of ${values.join(', ')}`).toBeDefined();
    await check('timeline', true);
    // check() ends on a resize back to 1280: the layout settles before the "before" picture (two of them: ~0 % apart).
    expect(await settle(page)).toEqual([]);
    await expect.poll(() => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
    const pngBefore = await page.getByTestId('preview-frame').screenshot();
    const pngBefore2 = await page.getByTestId('preview-frame').screenshot();
    const still = pictureDiff(pngBefore, pngBefore2);
    timings.push(`preview pixels changed between two "before" pictures: ${still.toFixed(1)} %`);
    expect(still).toBeLessThan(0.5);
    if (SHOTS) await writeFile(join(SHOTS, 'acceptance-preview-before.png'), pngBefore);
    const text0 = await readFile(scenarioFile(), 'utf8');
    const hash0 = await page.getByTestId('timeline').getAttribute('data-hash');

    await timed(`layout ${now || '(theme default)'} → ${target}: click → preview settled`, async () => {
      await page.locator(`[data-testid="switch"][data-key="${key}"] [data-testid="switch-option"][data-value="${target}"]`).click();
      await expect.poll(() => page.getByTestId('timeline').getAttribute('data-hash'), POLL).not.toBe(hash0);
      await expect.poll(() => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
    });
    const text1 = await readFile(scenarioFile(), 'utf8');
    const added = text1.split('\n').filter((l) => !text0.split('\n').includes(l));
    const removed = text0.split('\n').filter((l) => !text1.split('\n').includes(l));
    expect(added.length + removed.length, JSON.stringify({ added, removed })).toBeLessThanOrEqual(2);
    expect(added.join('\n')).toContain(`frame: ${target}`);
    expect(Number(await page.getByTestId('preview').getAttribute('data-frame'))).toBe(frame0);
    const pngAfter = await page.getByTestId('preview-frame').screenshot();
    if (SHOTS) await writeFile(join(SHOTS, 'acceptance-preview-after.png'), pngAfter);
    const d = pictureDiff(pngBefore, pngAfter);
    timings.push(`preview pixels changed by the switch: ${d.toFixed(1)} %`);
    expect(d).toBeGreaterThan(2);
    await shot('6-switched');

    // ⌘Z (the focus on no field): the exact bytes; then the switch again, kept.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readFile(scenarioFile(), 'utf8'), POLL).toBe(text0);
    // The undo landed in the view (its hash back, the switches no longer busy) before the next click (review B-M1).
    await expect.poll(() => page.getByTestId('timeline').getAttribute('data-hash'), POLL).toBe(hash0);
    await expect.poll(() => page.getByTestId('tl-redo').isEnabled(), POLL).toBe(true);
    await page.locator(`[data-testid="switch"][data-key="${key}"] [data-testid="switch-option"][data-value="${target}"]`).click();
    await expect.poll(() => readFile(scenarioFile(), 'utf8'), POLL).toBe(text1);
    await expect.poll(() => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');

    // Render: the Studio's worker renders and reviews it; the verdict inline.
    await timed('render + review (click → verdict)', async () => {
      await page.getByTestId('render').click();
      await expect.poll(() => page.getByTestId('render-job').getAttribute('data-state').catch(() => null), POLL).not.toBeNull();
      const row = page.locator(`[data-testid="render-row"][data-id="${S}-v1"]`);
      // Polled with what the page and the job say meanwhile; fails fast (with the job's phase) when the render job runs
      // with no live worker, or shows the same phase for RENDER_STALL_MS (review B-M2: a cold-cache run once sat at
      // 'running' for 600 s with nothing to show).
      let phase = '';
      let since = Date.now();
      const state = async (): Promise<string> => {
        const review = await row.getAttribute('data-review', { timeout: 500 }).catch(() => null);
        if (review && /^(clean|warnings|errors)$/.test(review)) return review;
        const job = (await studio.engine.jobs.list({ kinds: ['render'] })).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
        const now = `${job?.state ?? 'no job'}${job?.progress ? ` · ${job.progress.phase ?? ''} ${job.progress.steps_done}/${job.progress.steps_total}` : ''}`;
        if (now !== phase) {
          phase = now;
          since = Date.now();
          timings.push(`render job: ${now} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        }
        const words = `${review ?? 'no row'}; job ${job?.id ?? '?'} ${now}; ${(await page.getByTestId('render-job').innerText({ timeout: 500 }).catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)}`;
        if (job?.state === 'running' && !(await liveWorker(root))) throw new Error(`the render job runs but no worker is alive: ${words}`);
        if (Date.now() - since > RENDER_STALL_MS) throw new Error(`no progress for ${RENDER_STALL_MS / 1000} s: ${words}`);
        return words;
      };
      const t0 = Date.now();
      for (let s = await state(); !/^(clean|warnings|errors)$/.test(s); s = await state()) {
        if (Date.now() - t0 > RENDER_MAX_MS) throw new Error(`render + review not done after ${RENDER_MAX_MS / 1000} s: ${s}`);
        await page.waitForTimeout(1000);
      }
    });
    const panel = page.locator(`[data-testid="review-panel"][data-id="${S}-v1"]`);
    await expect.poll(() => panel.getByTestId('review-verdict').innerText(), POLL).toMatch(/\d+ errors?, \d+ warnings?, \d+ notes?/);
    const v1 = JSON.parse(await readFile(join(dir, 'renders', `${S}-v1.json`), 'utf8')) as RenderRecord;
    expect(v1).toMatchObject({ status: 'succeeded', run_id: ids.capture, edit: { from: 'scenario', sha256: sha(text1) } });
    timings.push(`v1: ${v1.frames} frames, ${v1.width}×${v1.height}; verdict "${await panel.getByTestId('review-verdict').innerText()}"`);
    await check('rendered', true);
    await shot('7-rendered');
    // A frame of the render on the switched segment (looked at: the layout the switch chose).
    if (SHOTS) {
      const seg = await page.locator('[data-testid="tl-segment"][data-id="quotes"]');
      const from = Number(await seg.getAttribute('data-from').catch(() => null)) || frame0;
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', ((from + v1.fps) / v1.fps).toFixed(3), '-i', v1.file, '-frames:v', '1', join(SHOTS, 'acceptance-render-frame.png')]);
    }
  }, 1_500_000);

  it('Comment at the playhead → a region in the four fields → Post; the proposal\'s diff → Apply (exact bytes) → Resolve', async () => {
    const comment = page.getByTestId('comment-here');
    await expect.poll(() => comment.getAttribute('href'), POLL).toMatch(new RegExp(`#/p/${P}/s/${S}/comments/at/${S}-v1/\\d+$`));
    ids.frame = Number(/\/(\d+)$/.exec((await comment.getAttribute('href'))!)![1]);
    await comment.click();
    await page.waitForURL(`**#/p/${P}/s/${S}/comments/at/${S}-v1/${ids.frame}`);
    await expect.poll(() => page.getByTestId('viewer').getAttribute('data-shown'), POLL).toBe(String(ids.frame));
    for (const [k, v] of [['x', '55'], ['y', '30'], ['w', '30'], ['h', '25']] as const) await page.getByTestId(`region-${k}`).fill(v);
    await expect.poll(() => page.getByTestId('region-words').innerText(), POLL).toContain('from 55 % left');
    await page.getByTestId('comment-text').fill('The quotes list could breathe more on this layout.');
    await check('comment-composer', true);
    await shot('8-composer');
    await page.getByTestId('post-comment').click();
    await page.waitForURL(/#\/p\/northfield-fixture\/s\/highlights\/comments\/c_[0-9A-HJKMNP-TV-Z]{26}$/, POLL);
    ids.thread = decodeURIComponent(page.url().split('/comments/')[1]);
    await page.getByTestId('thread').waitFor(POLL);
    const threadFile = join(dir, 'comments', S, `${ids.thread}.json`);
    const t = JSON.parse(await readFile(threadFile, 'utf8')) as CommentThread;
    expect(t).toMatchObject({ frame: ids.frame, author: { via: 'studio', name: AUTHOR }, region: { x: 0.55, y: 0.3, w: 0.3, h: 0.25 } });
    await check('thread');

    // The proposal (as comment_reply makes one): a caption change; its diff; Apply → exactly the proposed bytes.
    const current = await readFile(scenarioFile(), 'utf8');
    expect(current).toContain(CAPTION);
    const proposed = current.replace(CAPTION, `caption: {kicker: Quotes, text: "${PROPOSED_CAPTION}"}`);
    const w = await mcp.comments.reply(P, ids.thread, 'A shorter caption for the quotes scene.', { proposal: { scenario_yaml: proposed, scenario_hash: sha(current) } });
    const proposal = page.getByTestId('proposal');
    await expect.poll(() => proposal.getAttribute('data-entry'), POLL).toBe(w.entry);
    expect(await page.getByTestId('proposal-summary').innerText()).toBe(`A change to the scenario file ${S}: 1 line added, 1 removed, in 1 place.`);
    await proposal.scrollIntoViewIfNeeded();
    await check('proposal', true);
    await shot('9-proposal');
    await page.getByTestId('proposal-apply').click();
    await expect.poll(() => readFile(scenarioFile(), 'utf8'), POLL).toBe(proposed);
    await expect.poll(() => proposal.getAttribute('data-state'), POLL).toBe('applied');
    await page.getByTestId('resolve-note').fill('The caption is shorter.');
    await page.getByTestId('resolve').click();
    await expect.poll(() => page.getByTestId('thread').getAttribute('data-status'), POLL).toBe('resolved');
    expect((JSON.parse(await readFile(threadFile, 'utf8')) as CommentThread).entries.at(-1)).toMatchObject({ kind: 'resolve', author: { via: 'studio', name: AUTHOR } });
    await check('resolved');
    await shot('10-resolved');
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(consoleErrors).toEqual([]);
  }, 600_000);
});
