/**
 * L4.7 part E acceptance (slow: gated by DEMO_STUDIO_TEST_SLOW=1 — `pnpm test:slow`): the component library and the
 * theme editor with the real worker, in headless Chromium, on a copy of projects/northfield-fixture whose local
 * environment points at the fixture product started on free ports (never the fixture's own 4401–4404). A capture of
 * `highlights` is queued first; meanwhile the library → Play on a card: the worker renders its loop (a real Remotion GIF,
 * the whole-registry bundle) and the card shows it → Open the theme editor → Copy to edit → the background colour
 * dragged (the live frame shows the draft, nothing written) and released (written), the accent through its hex field →
 * Use in this scenario (`highlights`) → its timeline → Render: the worker renders the existing take with the new theme
 * (B1: the scenario's `template`, re-planned on the take), and a frame of the video shows the new background. The
 * workers are killed by pid at the end, whatever happened. `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots there.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseYaml } from '@demo-studio/core';
import { readWorkerLock } from '@demo-studio/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO } from '../../engine/test/helpers.js';

const ENABLED = process.env.DEMO_STUDIO_TEST_SLOW === '1';
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const P = 'northfield-fixture';
const S = 'highlights';
const COPY = 'editorial-copy';
const BG = '#bcd9f2';
const ACCENT = '#1f5f8b';
const FIXTURE_PROJECT = join(REPO, 'projects', P);
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.demo-studio', 'frames', 'comments']);
const POLL = { timeout: 30_000, interval: 200 };
const WORK = { timeout: 300_000, interval: 500 };

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let root: string;
let studio: StudioServer;
let browser: Browser;
let page: Page;
const savedHome = process.env.DEMO_STUDIO_HOME;
const workers = new Set<number>();
const consoleErrors: string[] = [];
const timings: Record<string, number> = {};

async function shot(name: string, fullPage = false): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
}

function noteWorker(): void {
  const w = readWorkerLock(root);
  if (w) workers.add(w.pid);
}

/** The colour at a point (fractions of the size) of a PNG screenshot or of a video frame at `t` seconds. */
function rgbAt(input: { png: Buffer } | { video: string; t: number }, fx: number, fy: number): [number, number, number] {
  const W = 320;
  const H = 180;
  const args = 'png' in input ? ['-v', 'error', '-i', 'pipe:0'] : ['-v', 'error', '-ss', String(input.t), '-i', input.video, '-frames:v', '1'];
  const rgb = execFileSync('ffmpeg', [...args, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { ...('png' in input ? { input: input.png } : {}), maxBuffer: 16 * 1024 * 1024 });
  const i = (Math.floor(H * fy) * W + Math.floor(W * fx)) * 3;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
}

/** Close to BG (a light blue: blue well above red), whatever the encoder did to it. */
const isBg = ([r, g, b]: [number, number, number]) => b - r > 30 && b > 200 && g > 180;

const themeYaml = async () => parseYaml(await readFile(join(root, 'templates', COPY, 'template.yaml'), 'utf8')).value as Record<string, any>;
const settles = async () => Number(await page.getByTestId('theme-preview').getAttribute('data-settles'));
async function settledAfter(n: number): Promise<void> {
  await expect.poll(async () => (await page.getByTestId('theme-preview').getAttribute('data-state')) === 'settled' && (await settles()) > n, POLL).toBe(true);
}

describe.skipIf(!ENABLED)('the library and the theme editor with the real worker on the fixture (DEMO_STUDIO_TEST_SLOW=1)', () => {
  let runId = '';

  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    root = await mkdtemp(join(tmpdir(), 'studio-ui-themes-acceptance-'));
    process.env.DEMO_STUDIO_HOME = join(root, '.home');
    // The workspace's own themes folder (copies go there); the starters are listed as starters, read-only.
    await writeFile(join(root, 'studio.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
    await mkdir(join(root, 'templates'));
    const project = join(root, 'projects', P);
    await cp(FIXTURE_PROJECT, project, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
    const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
    await writeFile(join(project, 'project.yaml'), yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')));
    await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
    studio = await startStudioServer({ root, workerIdleExitMs: 5000 });
    // The take the render will re-theme: captured first (the worker runs it before the loop asked below).
    const t0 = Date.now();
    runId = (await studio.engine.runs.submit({ project: P, scenario: S, mode: 'capture' })).run_id;
    void (async () => {
      for (;;) {
        const s = await studio.engine.runs.status(P, runId).catch(() => null);
        if (s && !['queued', 'running'].includes(String(s.status))) return void (timings.capture_ms = Date.now() - t0);
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
    page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'light' })).newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    await page.goto(studio.launchUrl());
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    if (root) noteWorker();
    for (const pid of workers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* exited on its own */
      }
    }
    await fixture?.close();
    console.log(`themes acceptance timings: ${JSON.stringify(timings)}`);
    if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
    else process.env.DEMO_STUDIO_HOME = savedHome;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('the library: Play on a card → the worker renders its loop (behind the capture) → the card plays the GIF', async () => {
    await page.goto(`${studio.url}#/p/${P}/library`);
    await page.getByRole('heading', { level: 1, name: 'Components' }).waitFor();
    await expect.poll(() => page.getByTestId('library').getAttribute('data-theme'), POLL).toBe('editorial');
    const card = page.locator('[data-testid="lib-card"][data-component="studio/transition-fade-black"]');
    await card.scrollIntoViewIfNeeded();
    // The editorial starter's committed poster, then Play: the loop is not cached yet → a library job.
    await expect.poll(() => card.getByTestId('lib-picture').getAttribute('data-state'), POLL).toBe('poster');
    const t0 = Date.now();
    await card.getByTestId('lib-play').click();
    expect(await card.getByTestId('lib-play').getAttribute('aria-pressed')).toBe('true');
    await expect.poll(() => card.getByTestId('lib-picture').getAttribute('data-state'), WORK).toBe('loop');
    timings.play_to_loop_ms = Date.now() - t0;
    noteWorker();
    const src = (await card.locator('img').getAttribute('src')) ?? '';
    expect(src).toMatch(/^data:image\/gif;base64,R0lGODlh/);
    expect(await card.locator('img').evaluate((el: HTMLImageElement) => el.decode().then(() => el.naturalWidth))).toBeGreaterThanOrEqual(480);
    await shot('e-library-loop');
  }, 360_000);

  it('the theme editor: Copy to edit; a colour dragged shows in the live frame unwritten, released → written; the accent', async () => {
    await page.getByTestId('lib-theme-editor').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/themes/editorial`);
    await page.getByTestId('theme-editor').waitFor();
    expect(await page.getByTestId('theme-editor').getAttribute('data-editable')).toBe('no');
    expect(await page.getByTestId('theme-copy-name').inputValue()).toBe(COPY);
    await page.getByTestId('theme-copy').click();
    await expect.poll(() => page.getByTestId('theme-editor').getAttribute('data-editable'), POLL).toBe('yes');
    await settledAfter(0);
    // A solid background (type and colour in one write), then its colour dragged to BG: the frame shows it, the file not.
    const n0 = await settles();
    await page.getByTestId('background-type').selectOption('solid');
    await expect.poll(async () => (await themeYaml()).background?.type, POLL).toBe('solid');
    await settledAfter(n0);
    const before = (await themeYaml()).background;
    const t0 = Date.now();
    await page.getByTestId('background-color-picker').evaluate(
      async (el, colors) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        for (const c of colors) {
          set.call(el, c);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 40));
        }
      },
      ['#e4e8ee', '#d6e2ef', '#c8ddf0', BG],
    );
    await expect.poll(() => page.getByTestId('background').innerText(), POLL).toMatch(new RegExp(`previewing ${BG}`));
    await expect.poll(async () => isBg(rgbAt({ png: await page.getByTestId('theme-preview').screenshot() }, 0.03, 0.05)), POLL).toBe(true);
    timings.draft_visible_ms = Date.now() - t0;
    expect((await themeYaml()).background).toEqual(before);
    await shot('e-theme-draft');
    await page.getByTestId('background-color-picker').evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
    await expect.poll(async () => (await themeYaml()).background, POLL).toEqual({ type: 'solid', color: BG });
    await page.getByTestId('color-accent-hex').fill(ACCENT);
    await page.getByTestId('color-accent-hex').press('Enter');
    await expect.poll(async () => (await themeYaml()).colors.accent, POLL).toBe(ACCENT);
    await expect.poll(async () => isBg(rgbAt({ png: await page.getByTestId('theme-preview').screenshot() }, 0.03, 0.05)), POLL).toBe(true);
    await shot('e-theme-written', true);
  }, 120_000);

  it('Use in this scenario → its timeline → Render: the existing take re-rendered with the new theme, seen in a frame', async () => {
    await page.getByTestId('use-scenario').selectOption(S);
    await page.getByTestId('use-in-scenario-go').click();
    await expect.poll(() => page.getByTestId('use-in-scenario-state').innerText(), POLL).toMatch(new RegExp(`Set the theme to ${COPY}`));
    expect((parseYaml(await readFile(join(root, 'projects', P, 'scenarios', `${S}.yaml`), 'utf8')).value as Record<string, unknown>).template).toBe(COPY);
    // The capture queued at the start has finished (it ran before the loop).
    await expect.poll(async () => String((await studio.engine.runs.status(P, runId)).status), WORK).toBe('succeeded');
    await page.getByTestId('use-in-scenario-timeline').click();
    await expect.poll(() => page.url(), POLL).toBe(`${studio.url}#/p/${P}/s/${S}/timeline`);
    await page.getByTestId('tracks').waitFor();
    await expect.poll(() => page.getByTestId('render').isDisabled(), POLL).toBe(false);
    const t0 = Date.now();
    await page.getByTestId('render').click();
    const row = page.locator('[data-testid="render-row"]').first();
    await expect.poll(() => row.getAttribute('data-review').catch(() => null), WORK).toMatch(/^(clean|warnings|errors)$/);
    timings.render_review_ms = Date.now() - t0;
    noteWorker();
    const renderId = (await row.getAttribute('data-id'))!;
    const rendersDir = join(root, 'projects', P, 'renders');
    const record = JSON.parse(await readFile(join(rendersDir, `${renderId}.json`), 'utf8')) as { template: string; run_id: string; duration_s: number };
    expect(record.template).toBe(COPY);
    expect(record.run_id).toBe(runId);
    const video = join(rendersDir, (await readdir(rendersDir)).find((f) => f.startsWith(renderId) && f.endsWith('.mp4'))!);
    // The intro (full-frame background) and the middle of the video (around the framed capture): the new background.
    for (const t of [1, record.duration_s / 2]) expect(isBg(rgbAt({ video, t }, 0.02, 0.03)), `frame at ${t} s: ${rgbAt({ video, t }, 0.02, 0.03).join(',')}`).toBe(true);
    if (SHOTS) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', video, '-frames:v', '1', '-vf', 'scale=960:-1', join(SHOTS, 'e-render-intro.png')]);
    if (SHOTS) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(record.duration_s / 2), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-1', join(SHOTS, 'e-render-middle.png')]);
    await shot('e-timeline-rendered');
    expect(consoleErrors).toEqual([]);
  }, 420_000);
});
