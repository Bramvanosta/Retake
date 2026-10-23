/**
 * L4.2 part 4 acceptance (slow: gated by DEMO_STUDIO_TEST_SLOW=1 — `pnpm test:slow`): the scenario screen's Dry run
 * with the real worker, in headless Chromium, on a copy of projects/northfield-fixture whose local environment points
 * at the fixture product started on free ports. The Studio starts the worker on the click (critique B5: clean
 * environment, `started_by: ui`); `highlights` (nothing blocks its dry run) → the running banner with its progress
 * (run_status, steps 1-based) → finished → the new run's pictures replace the words; a second dry run is cancelled while
 * it runs (its banner goes, the run ends cancelled). The worker is killed by pid at the end, whatever happened (no
 * orphan). `DEMO_STUDIO_UI_SHOTS=<folder>` saves screenshots there.
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkerLock } from '@demo-studio/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO } from '../../engine/test/helpers.js';

const ENABLED = process.env.DEMO_STUDIO_TEST_SLOW === '1';
const SHOTS = process.env.DEMO_STUDIO_UI_SHOTS;
const P = 'northfield-fixture';
const FIXTURE_PROJECT = join(REPO, 'projects', P);
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.demo-studio', 'frames', 'comments']);
const RUN = { timeout: 180_000, interval: 250 };

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

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function noteWorker(): void {
  const w = readWorkerLock(root);
  if (w) workers.add(w.pid);
}

describe.skipIf(!ENABLED)('the scenario screen’s run actions with the real worker on the fixture (DEMO_STUDIO_TEST_SLOW=1)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    root = await mkdtemp(join(tmpdir(), 'studio-ui-run-acceptance-'));
    process.env.DEMO_STUDIO_HOME = join(root, '.home');
    await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(root, 'projects', P);
    await cp(FIXTURE_PROJECT, project, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
    const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
    await writeFile(join(project, 'project.yaml'), yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')));
    await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
    studio = await startStudioServer({ root, workerIdleExitMs: 5000 });
    const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
    page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    await page.goto(studio.launchUrl());
    await page.getByRole('heading', { level: 1, name: 'Projects' }).waitFor();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    if (root) noteWorker();
    // The worker is detached and idles 5 s here: killed by pid whatever happened (no orphan left by the suite).
    for (const pid of workers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* exited on its own */
      }
    }
    await fixture?.close();
    if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
    else process.env.DEMO_STUDIO_HOME = savedHome;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('Dry run of highlights from the screen: the worker starts, progress, then the new run’s pictures', async () => {
    await page.goto(`${studio.url}#/p/${P}/s/highlights`);
    await page.getByRole('heading', { level: 1, name: 'highlights' }).waitFor();
    expect(await page.getByTestId('blockers-dry-run').innerText()).toContain('nothing stops it');
    expect(await page.getByText('No run of this scenario yet').count()).toBe(1);
    await page.getByTestId('run-dry').click();
    await page.getByTestId('run-submitted').waitFor();
    const runId = /(\d{8}-\d{6}-highlights)/.exec(await page.getByTestId('run-submitted').innerText())![1];
    await expect.poll(() => page.getByTestId('running').count(), RUN).toBe(1);
    await expect.poll(() => readWorkerLock(root)?.started_by, RUN).toBe('ui');
    noteWorker();
    // Progress through run_status: "n/N steps · current step k of <scene>".
    await expect.poll(async () => (await page.getByTestId('running').innerText().catch(() => '')).match(/current step \d+ of [a-z-]+/) !== null, RUN).toBe(true);
    await shot('30-real-dry-running');
    await expect.poll(() => page.getByTestId('running').count(), RUN).toBe(0);
    await expect.poll(() => page.getByTestId('source-line').innerText().catch(() => ''), RUN).toContain(runId);
    expect(await page.getByTestId('source-line').innerText()).toContain('succeeded');
    await expect.poll(() => page.locator('[data-testid="thumb"][data-state="ok"]').count(), RUN).toBeGreaterThan(0);
    const first = page.locator('[data-testid="step"] img').first();
    expect(await first.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
    await shot('31-real-dry-pictures');
  }, 300_000);

  it('Cancel a running dry run: the banner goes, the run ends cancelled', async () => {
    await page.getByTestId('run-dry').click();
    await page.getByTestId('run-submitted').waitFor();
    const runId = /(\d{8}-\d{6}-highlights)/.exec(await page.getByTestId('run-submitted').innerText())![1];
    await expect.poll(async () => /current step/.test(await page.getByTestId('running').innerText().catch(() => '')), RUN).toBe(true);
    noteWorker();
    await page.getByTestId('run-cancel').click();
    await expect.poll(() => page.getByTestId('running').count(), RUN).toBe(0);
    await expect.poll(async () => JSON.parse(await readFile(join(root, 'projects', P, 'runs', runId, 'run.json'), 'utf8')).status as string, RUN).toBe('cancelled');
    await expect.poll(async () => (await page.getByTestId('run-picker').locator('option').allInnerTexts()).some((t) => t.startsWith(`Dry run ${runId} · cancelled`)), RUN).toBe(true);
    expect(consoleErrors).toEqual([]);
    await shot('32-real-dry-cancelled');
  }, 300_000);
});
