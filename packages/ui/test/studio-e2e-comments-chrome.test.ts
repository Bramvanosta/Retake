/**
 * L4.6 part E, gated (`DEMO_STUDIO_TEST_CHROME=1`; skipped when Google Chrome is not installed): the frame-comments loop
 * on the real fixture product, in the installed Google Chrome (Playwright `channel: 'chrome'`, a temporary profile
 * Playwright creates and deletes — never the person's own), on a copy of projects/northfield-fixture whose local
 * environment points at the fixture product started on free ports (never 4401–4404), the worker run in this process:
 * - capture `highlights`, then Render from its timeline (the files' theme, reviewed inline);
 * - the timeline's Comment at the accepted proposal's total → the Comments screen at that frame of v1; a region dragged
 *   over the total; Post → a thread of the channel `studio` under the Studio's name, at the viewer's frame, with the
 *   region of the four fields and a still;
 * - Claude's proposal (an in-process engine of client `mcp`, as `comment_reply` makes one): a caption change, its diff in
 *   the thread, all three buttons offered; Preview change → the timeline's banner and the proposed caption, switches
 *   off and greyed, the playhead on the comment's pin (its step in the proposed text), the file untouched, no Apply on
 *   the banner (review A M1); Back to the comment → the thread at its proposal, whose Apply and re-render → the file
 *   holds exactly the proposed bytes, v2 rendered and reviewed, Resolve with v2 → resolved by the channel `studio`;
 * - the viewer's frame latency (render_frame request → the frame shown) on the real render and on a 4K copy of it (x264
 *   with its default GOP and B-frames): first / median / worst, logged; and the sticky sidebar in a real viewport scroll.
 * No CSP violation, no console error. `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots there (viewport-sized).
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
import { createEngine, runWorker } from '@demo-studio/engine';
import type { Engine } from '@demo-studio/engine';
import type { RenderRecord } from '@demo-studio/editor';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO } from '../../engine/test/helpers.js';
import { hasTool, linkSharedCache } from '../../editor/test/render-helpers.js';

const CHROME_APP = '/Applications/Google Chrome.app';
const gated = process.env.DEMO_STUDIO_TEST_CHROME === '1' && hasTool('ffmpeg') && hasTool('ffprobe') && (process.platform !== 'darwin' || existsSync(CHROME_APP));
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const P = 'northfield-fixture';
const S = 'highlights';
const FIXTURE_PROJECT = join(REPO, 'projects', P);
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.demo-studio', 'frames', 'comments']);
const POLL = { timeout: 60_000 };
const AUTHOR = 'Studio Person';
const CAPTION = 'caption: {kicker: Quotes, text: "Every request and every proposal, in one list."}';
const PROPOSED_CAPTION = 'Every request and its proposal, side by side.';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let root: string;
let dir: string;
let studio: StudioServer;
let mcp: Engine;
let browser: Browser;
let page: Page;
const saved = { home: process.env.DEMO_STUDIO_HOME, author: process.env.DEMO_STUDIO_AUTHOR };
const consoleErrors: string[] = [];
/** The capture, the thread and its frame (each test goes on from the one before). */
const ids = { run: '', thread: '', frame: 0, entry: '' };

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `comments-chrome-${name}.png`) });
}

const work = async (what: string) => {
  const t0 = Date.now();
  expect(await runWorker({ root, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined }), what).toBe(0);
  return Date.now() - t0;
};
const scenarioFile = () => join(dir, 'scenarios', `${S}.yaml`);
const readThread = async (id: string) => JSON.parse(await readFile(join(dir, 'comments', S, `${id}.json`), 'utf8')) as CommentThread;
const shownFrame = async () => Number(await page.getByTestId('viewer').getAttribute('data-shown'));
const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const fields = async () => {
  const v: Record<string, number> = {};
  for (const k of ['x', 'y', 'w', 'h']) v[k] = Number(await page.getByTestId(`region-${k}`).inputValue());
  return v;
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};

/**
 * Opens `frame` of `render` on the Comments screen (a hash change: the page stays) and times, in the page, the change →
 * the viewer showing that frame (its render_frame answer drawn: `data-shown`).
 */
async function timeFrame(render: string, frame: number, how: 'route' | 'slider'): Promise<number> {
  return page.evaluate(
    async (o) => {
      const viewerShows = () => {
        const v = document.querySelector('[data-testid="viewer"]');
        return v !== null && v.getAttribute('data-render') === o.render && v.getAttribute('data-shown') === String(o.frame);
      };
      const t0 = performance.now();
      const done = new Promise<number>((resolve, reject) => {
        const obs = new MutationObserver(() => {
          if (!viewerShows()) return;
          obs.disconnect();
          resolve(performance.now() - t0);
        });
        obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-shown', 'data-render'] });
        setTimeout(() => {
          obs.disconnect();
          reject(new Error(`frame ${o.frame} of ${o.render} not shown within 30 s`));
        }, 30_000);
      });
      if (o.how === 'route') location.hash = o.hash;
      else {
        const slider = document.querySelector('[data-testid="frame-slider"]') as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, String(o.frame));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return Math.round(await done);
    },
    { render, frame, how, hash: `#/p/${P}/s/${S}/comments/at/${render}/${frame}` },
  );
}

/** Keyframe indexes of a video (ffprobe, keyframes only). */
function keyframes(file: string, fps: number): number[] {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => Math.round(Number(l.split(',')[0]) * fps));
}

/** The viewer's latency on one render: the first frame (cold: probe + decode), then uncached frames by the slider. */
async function viewerLatency(rec: RenderRecord): Promise<{ first: number; times: number[]; targets: number[]; gop: string }> {
  const keys = keyframes(rec.file, rec.fps);
  const gaps = keys.slice(1).map((k, i) => k - keys[i]);
  // Worst cases: the frame before each of three keyframes (a decode from the keyframe before); and frames spread over the take.
  const before = keys.filter((k) => k > 1).slice(0, 3).map((k) => k - 1);
  const spread = [0.12, 0.27, 0.41, 0.58, 0.73, 0.88, 0.97].map((q) => Math.floor(q * (rec.frames - 1)));
  const targets = [...new Set([...before, ...spread])].filter((f) => f > 5 && f < rec.frames).sort((a, b) => a - b);
  const first = await timeFrame(rec.id, 3, 'route');
  const times: number[] = [];
  for (const f of targets) times.push(await timeFrame(rec.id, f, 'slider'));
  return { first, times, targets, gop: `keyframes ${keys.length} (gap median ${pct(gaps, 0.5) ?? '-'}, max ${gaps.length ? Math.max(...gaps) : '-'} frames)` };
}

beforeAll(async () => {
  if (!gated) return;
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
  for (const u of Object.values(fixture.urls)) expect([4401, 4402, 4403, 4404]).not.toContain(Number(new URL(u).port));
  root = await mkdtemp(join(tmpdir(), 'ds-e2e-comments-chrome-'));
  process.env.DEMO_STUDIO_HOME = join(root, '.home');
  process.env.DEMO_STUDIO_AUTHOR = AUTHOR;
  await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  dir = join(root, 'projects', P);
  await cp(FIXTURE_PROJECT, dir, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
  const yaml = await readFile(join(dir, 'project.yaml'), 'utf8');
  await writeFile(join(dir, 'project.yaml'), yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')));
  await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
  await linkSharedCache(root);
  studio = await startStudioServer({ root, startWorker: false, pollMs: 100 });
  mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 1, name: 'Projects' }).waitFor();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await fixture?.close();
  for (const [k, val] of [['DEMO_STUDIO_HOME', saved.home], ['DEMO_STUDIO_AUTHOR', saved.author]] as const) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!gated)('frame comments on the fixture product in the installed Google Chrome (L4.6 part E)', () => {
  it('capture highlights, Render from its timeline; Comment at the total; a region; Post → a studio thread at the viewer\'s frame', async () => {
    // The capture (the worker in this process), then Render from the timeline: the files' theme, reviewed inline.
    const sub = await studio.engine.runs.submit({ project: P, scenario: S, mode: 'capture' });
    ids.run = sub.run_id;
    const captureMs = await work('capture');
    expect((await studio.engine.runs.status(P, ids.run)).status).toBe('succeeded');
    await page.goto(`${studio.url}#/p/${P}/s/${S}/timeline`);
    await page.getByTestId('tracks').waitFor(POLL);
    await page.getByTestId('render').click();
    await expect.poll(() => page.getByTestId('render-job').getAttribute('data-state'), POLL).toBe('queued');
    const renderMs = await work('render v1');
    const v1 = JSON.parse(await readFile(join(dir, 'renders', `${S}-v1.json`), 'utf8')) as RenderRecord;
    expect(v1).toMatchObject({ status: 'succeeded', run_id: ids.run, variant: 'landscape', overrides: {} });
    console.log(`fixture ${S}: capture ${captureMs} ms; render + review v1 ${renderMs} ms (${v1.frames} frames, ${v1.width}×${v1.height}, ${v1.fps} fps)`);

    // The accepted proposal's total: its marker, a second into the hold that follows.
    await page.locator('[data-testid="tl-marker"]').first().waitFor(POLL);
    const markers = await page.locator('[data-testid="tl-marker"]').evaluateAll((els) => els.map((e) => ({ frame: Number(e.getAttribute('data-frame')), label: e.getAttribute('aria-label') ?? '' })));
    const open = markers.find((m) => m.label.includes('proposal-open'));
    expect(open, JSON.stringify(markers)).toBeDefined();
    await page.locator(`[data-testid="tl-marker"][data-frame="${open!.frame}"]`).click();
    await expect.poll(async () => Number(await page.getByTestId('preview').getAttribute('data-frame')), POLL).toBe(open!.frame);
    await blur();
    await page.keyboard.press('Shift+ArrowRight');
    const at = open!.frame + Math.round(v1.fps);
    await expect.poll(async () => Number(await page.getByTestId('preview').getAttribute('data-frame')), POLL).toBe(at);
    const comment = page.getByTestId('comment-here');
    await expect.poll(() => comment.getAttribute('href'), POLL).toBe(`#/p/${P}/s/${S}/comments/at/${S}-v1/${at}`);
    await shot('0-timeline');
    await comment.click();
    await page.waitForURL(`**#/p/${P}/s/${S}/comments/at/${S}-v1/${at}`);
    await expect.poll(shownFrame, POLL).toBe(at);
    expect(Number(await page.getByTestId('frame-slider').inputValue())).toBe(at);

    // A region over the total (the proposal panel's total line, right of centre), then Post.
    const box = (await page.getByTestId('viewer-frame').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.66, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.46, { steps: 4 });
    await page.mouse.move(box.x + box.width * 0.84, box.y + box.height * 0.53, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await fields()).w, POLL).toBeGreaterThan(0);
    const f = await fields();
    await expect.poll(() => page.locator('[data-testid="composer"] [data-testid="chip-frame"]').innerText(), POLL).toContain(`Frame ${at.toLocaleString('en')} · `);
    await page.getByTestId('viewer').scrollIntoViewIfNeeded();
    await shot('1-composer');
    await page.getByTestId('comment-text').fill('Circle the total: it should stand out more.');
    await page.getByTestId('post-comment').click();
    await page.waitForURL(/#\/p\/northfield-fixture\/s\/highlights\/comments\/c_[0-9A-HJKMNP-TV-Z]{26}$/, POLL);
    ids.thread = decodeURIComponent(page.url().split('/comments/')[1]);
    ids.frame = at;
    await page.getByTestId('thread').waitFor(POLL);
    const t = await readThread(ids.thread);
    expect(t.author).toEqual({ via: 'studio', name: AUTHOR });
    expect(t.frame).toBe(at);
    expect(t.render).toMatchObject({ id: `${S}-v1`, created_at: v1.created_at });
    expect(t.region).toEqual({ x: f.x / 100, y: f.y / 100, w: f.w / 100, h: f.h / 100 });
    expect((await studio.engine.comments.get(P, ids.thread)).still).not.toBeNull();
    // The viewer moved onto the thread's frame with its region (the still shows only once its render is gone).
    await expect.poll(shownFrame, POLL).toBe(at);
    await expect.poll(() => page.getByTestId('viewer-region').innerText(), POLL).toBe("The comment's region");
    await shot('2-thread');
  }, 900_000);

  it("Claude's proposal: the diff; Preview change; Back to the comment; Apply and re-render → v2 rendered → Resolve with v2", async () => {
    const before = await readFile(scenarioFile(), 'utf8');
    expect(before).toContain(CAPTION);
    const proposed = before.replace(CAPTION, `caption: {kicker: Quotes, text: "${PROPOSED_CAPTION}"}`);
    const w = await mcp.comments.reply(P, ids.thread, 'A shorter caption for the quotes scene.', { proposal: { scenario_yaml: proposed, scenario_hash: sha(before) } });
    ids.entry = w.entry;
    const proposal = page.getByTestId('proposal');
    await expect.poll(() => proposal.getAttribute('data-entry'), POLL).toBe(ids.entry);
    expect(await proposal.getAttribute('data-state')).toBe('pending');
    expect(await proposal.getAttribute('data-verified')).toBe('yes');
    expect(await page.getByTestId('proposal-summary').innerText()).toBe(`A change to the scenario file ${S}: 1 line added, 1 removed, in 1 place.`);
    const added = await page.locator('[data-testid="proposal"] [data-testid="diff-row"][data-kind="add"] [data-testid="diff-line"]').allInnerTexts();
    // Leading spaces drawn as `·` (YAML's indentation is its meaning), the line itself literally.
    expect(added).toEqual([`····caption: {kicker: Quotes, text: "${PROPOSED_CAPTION}"}`]);
    for (const b of ['proposal-apply', 'proposal-preview', 'proposal-apply-render']) expect(await page.getByTestId(b).count(), b).toBe(1);
    await proposal.scrollIntoViewIfNeeded();
    await shot('3-proposal');

    // Preview change: the timeline's banner, the proposed caption on the caption track, the file untouched.
    await page.getByTestId('proposal-preview').click();
    await page.waitForURL(`**#/p/${P}/s/${S}/proposal/${ids.thread}/${ids.entry}`);
    await page.getByTestId('proposal-banner').waitFor(POLL);
    expect(await page.getByTestId('proposal-banner').getAttribute('data-shown')).toBe('yes');
    await expect.poll(async () => (await page.getByTestId('tl-caption').allInnerTexts()).some((x) => x.includes(PROPOSED_CAPTION)), POLL).toBe(true);
    expect(await page.getByTestId('render').isDisabled()).toBe(true);
    // Switches off (the view carries no text to edit); the playhead on the comment's pin — at its step in the proposed
    // text (the proposed plan is another version than v1's, so the pin is not at v1's own frame: review B M5).
    expect(await page.locator('[data-testid="inspector"] [role="radiogroup"]:not([aria-disabled="true"])').count()).toBe(0);
    const pin = page.locator(`[data-testid="tl-pin"][data-id="${ids.thread}"]`);
    await pin.waitFor(POLL);
    const pinAt = Number(await pin.getAttribute('data-frame'));
    expect(pinAt).toBeLessThanOrEqual(ids.frame);
    expect(ids.frame - pinAt).toBeLessThan(5 * 30);
    await expect.poll(async () => Number(await page.getByTestId('preview').getAttribute('data-frame')), POLL).toBe(pinAt);
    await expect.poll(() => page.getByTestId('preview').getAttribute('data-loading'), POLL).toBe('no');
    // The switched-off chips are greyed (part E's nit), and the banner never applies (review A M1).
    expect(Number(await page.locator('[data-testid="inspector"] .tl-radio.is-checked').first().evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
    await page.getByTestId('banner-back').waitFor(POLL);
    expect(await page.locator('[data-testid="proposal-banner"] button').count()).toBe(0);
    expect(await readFile(scenarioFile(), 'utf8')).toBe(before);
    await shot('4-preview');

    // Back to the comment → the proposal, its Apply and re-render: exactly the proposed bytes; v2 rendered and reviewed.
    await page.getByTestId('banner-back').click();
    await page.waitForURL(`**#/p/${P}/s/${S}/comments/${ids.thread}`);
    await page.getByTestId('proposal-apply-render').waitFor(POLL);
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('pp-head') ?? false), POLL).toBe(true);
    await page.getByTestId('proposal-apply-render').click();
    await expect.poll(() => readFile(scenarioFile(), 'utf8'), POLL).toBe(proposed);
    await expect.poll(() => page.getByTestId('proposal-render').getAttribute('data-state'), POLL).toBe('queued');
    const renderMs = await work('render v2');
    const resolveWith = page.getByTestId('resolve-with');
    await resolveWith.waitFor({ state: 'visible', timeout: 120_000 });
    expect(await resolveWith.getAttribute('data-render')).toBe(`${S}-v2`);
    const v2 = JSON.parse(await readFile(join(dir, 'renders', `${S}-v2.json`), 'utf8')) as RenderRecord;
    expect(v2).toMatchObject({ status: 'succeeded', run_id: ids.run, variant: 'landscape', edit: { from: 'scenario', sha256: sha(proposed) } });
    console.log(`fixture ${S}: Apply and re-render → render + review v2 ${renderMs} ms`);
    await page.getByTestId('thread').scrollIntoViewIfNeeded();
    await shot('5-rendered');
    await resolveWith.click();
    await expect.poll(() => page.getByTestId('thread').getAttribute('data-status'), POLL).toBe('resolved');
    expect((await readThread(ids.thread)).entries.at(-1)).toMatchObject({ kind: 'resolve', render_id: `${S}-v2`, render_created_at: v2.created_at, author: { via: 'studio', name: AUTHOR } });
    await shot('6-resolved');
  }, 900_000);

  it('the viewer\'s frame latency on the real render and on a 4K copy; the sidebar stays put in a real scroll', async () => {
    const v1 = JSON.parse(await readFile(join(dir, 'renders', `${S}-v1.json`), 'utf8')) as RenderRecord;
    // A 4K copy of v1 as a render of its own: x264 with its default GOP (keyframes up to 250 frames apart) and B-frames.
    const id4k = `${S}-v3`;
    const file4k = join(dir, 'renders', `${id4k}.mp4`);
    const t0 = Date.now();
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', v1.file, '-vf', 'scale=3840:2160:flags=bicubic', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', file4k]);
    const encodeMs = Date.now() - t0;
    const created = new Date(Date.parse(v1.created_at) + 3_600_000).toISOString();
    const r4k: RenderRecord = { ...v1, id: id4k, file: file4k, record: join(dir, 'renders', `${id4k}.json`), render_version: 3, created_at: created, finished_at: created, width: 3840, height: 2160 };
    await writeFile(r4k.record, JSON.stringify(r4k));

    const lines: string[] = [];
    for (const rec of [v1, r4k]) {
      const m = await viewerLatency(rec);
      expect(m.times.length).toBeGreaterThan(5);
      lines.push(`${rec.id} ${rec.width}×${rec.height} ${rec.frames} frames (${m.gop}): first frame (outline, probe, frame) ${m.first} ms; ${m.times.length} uncached frames median ${pct(m.times, 0.5)} ms, p90 ${pct(m.times, 0.9)} ms, worst ${Math.max(...m.times)} ms (${m.targets.map((f, i) => `${f}:${m.times[i]}`).join(' ')})`);
      if (rec === r4k) await shot('7-viewer-4k');
    }
    console.log(`viewer latency (render_frame → frame shown), 4K encode ${encodeMs} ms:\n  ${lines.join('\n  ')}`);

    // The sidebar is sticky: in a real viewport scroll of a tall page it stays at the top of the viewport (a full-page
    // screenshot draws it where the scroll left it — an artifact of the capture, not of the page).
    await page.goto(`${studio.url}#/p/${P}/s/${S}/comments/${ids.thread}`);
    await page.getByTestId('thread').waitFor(POLL);
    await page.getByTestId('filter-all').check();
    const tall = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(tall).toBeGreaterThan(200);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY), POLL).toBeGreaterThan(200);
    expect(Math.abs(await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().top))).toBeLessThan(1);
    await shot('8-scrolled');

    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(consoleErrors).toEqual([]);
  }, 900_000);
});
