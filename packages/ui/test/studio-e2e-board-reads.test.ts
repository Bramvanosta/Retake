/**
 * L5.10a fixes (reviews A-H1 and B-H1): the open project's shared reads, counted at the server's door in headless
 * Chromium against an in-process Studio on a scratch copy of the fixture (the fixture product on free ports):
 * - ⚑ a take run from a terminal (`retake run … --dry`, a separate process: every step rewrites run.json) while the
 *   Project screen and the Cast are open in two tabs — project_board, project_get and auth_status stay under a ceiling
 *   set by the take's changes (it started, it ended), far under its step count (they were one read per step);
 * - ⚑ a project whose project.yaml does not load: its reads over 5 s stay bounded (they looped ~300 times a second);
 * - ⚑ the arrow keys in the poster grid: no project read at all (they were one read of each op per key press);
 * - ⚑ L5.11a (critique H2): the status bar's `scenario_actions` for the production selected reads once the selection
 *   settled (10 quick arrow keys: ≤ 2 reads); a terminal take's steps never re-read it; on the Scenario screen it reads
 *   nothing (the screen feeds it its own view: a change of the file is one scenario_blocks, no scenario_actions);
 * - a job of another project re-reads nothing here; one of this project re-reads the board (review A-L7);
 * - the inspector hidden: what it shows has a home in the centre pane (review B-M1); the poster grid at the desktop
 *   app's narrowest window, 900 px, keeps readable posters (review B-M2);
 * - the lows: a production the search hides leaves the inspector (A-L1); the warnings' disclosure says what it shows,
 *   the README preview has a tab stop, the folder its full path in a tooltip (A-L6, B-L6); the searches keep their
 *   limits (B-L4); a persona's location on a line of its own in the browser (B-L1).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';

const P = 'northfield-fixture';
const POLL = { timeout: 20_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const savedHome = process.env.RETAKE_HOME;
const STEPS = 24;

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

let ws: string;
let fixture: Fixture;
let studio: StudioServer;
let browser: Browser;

/**
 * A tab with a session and a browser context of its own (its own event stream: another tab closing never hands it the
 * stream, whose first message re-reads everything), at `hash`.
 */
async function tab(hash: string, viewport = { width: 1280, height: 820 }): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
  await page.goto(`${studio.url}#${hash}`);
  return page;
}

/** The ops a tab calls from now on, until `stop()`. */
function countOps(page: Page): { ops: string[]; count: (op: string) => number; stop: () => void } {
  const ops: string[] = [];
  const seen = (r: { url(): string }) => {
    const u = r.url();
    if (u.includes('/v1/call/')) ops.push(u.split('/v1/call/')[1]);
  };
  page.on('request', seen);
  return { ops, count: (op) => ops.filter((o) => o === op).length, stop: () => page.off('request', seen) };
}

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A finished job of `project` written straight into the queue (the event stream sees a new job id). */
async function plantJob(project: string, n: number): Promise<string> {
  const id = `j_01JC${Array.from({ length: 22 }, (_, k) => ALPHA[(n * 7 + k) % 32]).join('')}`;
  const dir = join(ws, '.retake', 'jobs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'job.json'),
    JSON.stringify({
      version: 1,
      id,
      kind: 'run',
      input: { kind: 'run', project, scenario: 'quote', run_id: `20261001-10000${n}-quote` },
      state: 'succeeded',
      created_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }),
  );
  return id;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-reads-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: Record<string, unknown>): Promise<Fixture> };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
  const file = join(ws, 'projects', P, 'project.yaml');
  const strip = (u: string) => u.replace(/\/$/, '');
  await writeFile(
    file,
    (await readFile(file, 'utf8'))
      .replaceAll('http://localhost:4401', strip(fixture.urls.console))
      .replaceAll('http://localhost:4402', strip(fixture.urls.shop))
      .replaceAll('http://localhost:4403', strip(fixture.urls.signedIn!.console))
      .replaceAll('http://localhost:4404', strip(fixture.urls.signedIn!.shop)),
  );
  // A take of many quick steps (each one rewrites run.json: a progress event).
  await writeFile(
    join(ws, 'projects', P, 'scenarios', 'many-steps.yaml'),
    `version: 1\nvideo: many-steps\nscenes:\n  - id: look\n    page: console\n    open: /products\n    steps:\n${'      - wait_for: {text: Sales reports}\n'.repeat(STEPS)}`,
  );
  // A project with one project.yaml warning (no environment yet).
  await mkdir(join(ws, 'projects', 'warned', 'scenarios'), { recursive: true });
  await writeFile(join(ws, 'projects', 'warned', 'project.yaml'), 'version: 1\nname: Warned\nenvironments: {}\n');
  // A project whose project.yaml does not load (an environment name that is not a name).
  await mkdir(join(ws, 'projects', 'broken', 'scenarios'), { recursive: true });
  await writeFile(join(ws, 'projects', 'broken', 'project.yaml'), 'version: 1\nname: Broken\nenvironments:\n  "Not A Name!": {app: {url: "http://localhost:1"}}\n');
  studio = await startStudioServer({ root: ws });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await fixture?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the open project reads by events, never by steps (reviews A-H1, B-H1)', () => {
  it('⚑ a take from a terminal with the Project screen and the Cast open: project_board / project_get / auth_status bounded by its changes, not its steps', async () => {
    const proj = await tab(`/p/${P}`);
    await proj.locator('[role="option"]').first().waitFor(POLL);
    // L5.11a: the take's production selected — the scenario in context of the status bar.
    await proj.locator('[role="option"][data-id="many-steps"]').click();
    await proj.getByTestId('status-scenario').waitFor(POLL);
    const cast = await tab(`/p/${P}/cast`);
    await cast.getByRole('heading', { level: 1, name: 'Cast' }).waitFor(POLL);
    await sleep(1500);
    const a = countOps(proj);
    const b = countOps(cast);
    let out = '';
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [join(REPO, 'packages/cli/dist/bin.js'), '-C', ws, 'run', P, 'many-steps', '--dry'], {
          env: { ...process.env, RETAKE_HOME: join(ws, '.home') },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('error', reject);
        child.on('exit', resolve);
      });
      expect(code, out).toBe(0);
      // The take's last changes reach the tabs (the stream polls), then nothing more is read.
      await sleep(3000);
    } finally {
      a.stop();
      b.stop();
    }
    const id = (await readdir(join(ws, 'projects', P, 'runs')))
      .filter((n) => n.endsWith('-many-steps'))
      .sort()
      .at(-1)!;
    const rec = JSON.parse(await readFile(join(ws, 'projects', P, 'runs', id, 'run.json'), 'utf8')) as { steps_done: number; status: string };
    const tally = (c: ReturnType<typeof countOps>) => ({ project_board: c.count('project_board'), project_get: c.count('project_get'), auth_status: c.count('auth_status') });
    console.log(`a ${rec.steps_done}-step dry run from a terminal: Project screen ${JSON.stringify(tally(a))} (run_status ${a.count('run_status')}), Cast ${JSON.stringify(tally(b))}`);
    expect(rec.status).toBe('succeeded');
    expect(rec.steps_done).toBe(STEPS);
    // Its changes: a run folder appeared, the run was told, its status changed (started, ended) — a board read each at
    // most; nothing of the project's files or sessions changed (project_get and auth_status: a stray read at most).
    // Never one per step (measured before the fix: one of each per step on the Project screen, two auth_status a step
    // on the Cast).
    for (const c of [a, b]) {
      expect(c.count('project_board')).toBeLessThanOrEqual(4);
      expect(c.count('project_get')).toBeLessThanOrEqual(1);
      expect(c.count('auth_status')).toBeLessThanOrEqual(1);
    }
    // L5.11a (M14 of the plan): the status bar's read of the take's scenario follows its changes, never its steps.
    console.log(`  scenario_actions: Project screen ${a.count('scenario_actions')}`);
    expect(a.count('scenario_actions')).toBeLessThanOrEqual(4);
    await proj.context().close();
    await cast.context().close();
  }, 180_000);

  it('⚑ a project whose project.yaml does not load: its reads over 5 s stay bounded (read again after 2 s, then 4 s…), never in a loop', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(studio.launchUrl());
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
    const c = countOps(page);
    try {
      await page.goto(`${studio.url}#/p/broken`);
      await page.getByText('This project cannot be opened').waitFor(POLL);
      await sleep(5000);
    } finally {
      c.stop();
    }
    console.log(`a broken project.yaml, 5 s: project_get ${c.count('project_get')}, project_board ${c.count('project_board')}, auth_status ${c.count('auth_status')}`);
    for (const op of ['project_get', 'project_board', 'auth_status']) {
      expect(c.count(op), op).toBeGreaterThanOrEqual(1);
      expect(c.count(op), op).toBeLessThanOrEqual(3);
    }
    await page.context().close();
  });

  it('⚑ the arrow keys in the poster grid read nothing of the project (no project_get, project_board or auth_status)', async () => {
    const page = await tab(`/p/${P}`);
    const grid = page.getByRole('listbox');
    await page.locator('[role="option"]').first().waitFor(POLL);
    // The window has the focus first (a window coming into focus re-reads everything once: that is not the arrows).
    await page.bringToFront();
    await grid.focus();
    await sleep(1500);
    const c = countOps(page);
    let afterFirst: string[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(i < 4 ? 'ArrowRight' : 'ArrowDown');
        await sleep(i === 0 ? 1000 : 300);
        if (i === 0) afterFirst = [...c.ops];
      }
      await sleep(1500);
    } finally {
      c.stop();
    }
    console.log(`six arrow keys in the poster grid: ${JSON.stringify(c.ops)}`);
    expect(await page.locator('[role="option"][aria-selected="true"]').count()).toBe(1);
    // The first one opens a production's inspector (its Lately reads the project's activity once); the next ones: nothing
    // of the project — L5.11a: the status bar reads the production in context once it settled (300 ms), at most a key.
    const project = (l: string[]) => l.filter((o) => o !== 'scenario_actions');
    expect(project(afterFirst).filter((o) => o !== 'activity_list')).toEqual([]);
    expect(project(c.ops.slice(afterFirst.length))).toEqual([]);
    expect(c.count('scenario_actions')).toBeLessThanOrEqual(6);
    await page.context().close();
  });

  it("⚑ L5.11a (critique H2): 10 quick arrow keys read the status bar's scenario ≤ 2 times; on the Scenario screen a change of the file is one scenario_blocks and no scenario_actions", async () => {
    const page = await tab(`/p/${P}`);
    const grid = page.getByRole('listbox');
    await page.locator('[role="option"]').first().waitFor(POLL);
    await page.bringToFront();
    await grid.focus();
    await sleep(1500);
    const c = countOps(page);
    try {
      for (let i = 0; i < 10; i++) await page.keyboard.press(i % 3 === 2 ? 'ArrowDown' : 'ArrowRight', { delay: 20 });
      await sleep(1500);
    } finally {
      c.stop();
    }
    console.log(`ten quick arrow keys: scenario_actions ${c.count('scenario_actions')}`);
    expect(c.count('scenario_actions')).toBeGreaterThanOrEqual(1);
    expect(c.count('scenario_actions')).toBeLessThanOrEqual(2);
    // The Scenario screen feeds the status bar its own view.
    await page.goto(`${studio.url}#/p/${P}/s/many-steps`);
    await page.getByRole('heading', { level: 1, name: 'many-steps' }).waitFor(POLL);
    await page.getByTestId('status-actions').waitFor(POLL);
    await sleep(1000);
    const d = countOps(page);
    try {
      const file = join(ws, 'projects', P, 'scenarios', 'many-steps.yaml');
      await writeFile(file, `${await readFile(file, 'utf8')}# touched\n`);
      await expect.poll(() => d.count('scenario_blocks'), POLL).toBeGreaterThanOrEqual(1);
      await sleep(1500);
    } finally {
      d.stop();
    }
    console.log(`a change of the open scenario's file: ${JSON.stringify(d.ops)}`);
    expect(d.count('scenario_blocks')).toBe(1);
    expect(d.count('scenario_actions')).toBe(0);
    await page.context().close();
  });

  it('a job of another project re-reads nothing here (the event names its project); one of this project re-reads the board once', async () => {
    const page = await tab(`/p/${P}`);
    await page.locator('[role="option"]').first().waitFor(POLL);
    await sleep(2500);
    const c = countOps(page);
    try {
      await plantJob('other-project', 1);
      await sleep(3500);
      expect(c.count('project_board')).toBe(0);
      expect(c.count('auth_status')).toBe(0);
      await plantJob(P, 2);
      await expect.poll(() => c.count('project_board'), POLL).toBe(1);
    } finally {
      c.stop();
    }
    await page.context().close();
  });
});

describe("the Project screen's homes and widths (reviews B-M1, B-M2)", () => {
  it('the inspector hidden: the selected production, then the project, then a location show in the centre pane, under a heading', async () => {
    const page = await tab(`/p/${P}`);
    await page.locator('[role="option"]').first().click();
    await page.getByRole('button', { name: 'Inspector' }).click();
    const inline = page.locator('main').getByTestId('inline-inspector');
    await inline.waitFor(POLL);
    expect(await inline.getAttribute('aria-label')).toBe('Production details');
    expect(await inline.getByTestId('scenario-link').count()).toBe(1);
    await page.getByRole('listbox').press('Escape');
    await expect.poll(() => inline.getAttribute('aria-label'), POLL).toBe('Project details');
    expect(await inline.getByTestId('readme-preview').count()).toBe(1);
    // A location row: its pages in the centre too.
    await page.locator(`.sh-browser a[href="#/p/${P}/loc/production"]`).click();
    await expect.poll(() => inline.getAttribute('aria-label'), POLL).toBe('Location details');
    await inline.getByTestId('location-pages').waitFor(POLL);
    // Shown again: the pane holds it, the centre does not.
    await page.getByRole('button', { name: 'Inspector' }).click();
    await expect.poll(() => inline.count(), POLL).toBe(0);
    await page.getByRole('complementary', { name: 'Inspector' }).getByTestId('location-pages').waitFor(POLL);
    await page.context().close();
  });

  it("at 900 px (the desktop app's narrowest window) the posters reflow: none narrower than 200 px, a state line on at most two lines", async () => {
    const page = await tab(`/p/${P}`, { width: 900, height: 700 });
    await page.locator('[role="option"]').first().waitFor(POLL);
    const sizes = await page.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('.k-poster')];
      const meta = [...document.querySelectorAll<HTMLElement>('.k-poster .k-card-meta')];
      const lead = parseFloat(getComputedStyle(meta[0]).lineHeight) || 20;
      return {
        width: Math.min(...cards.map((c) => c.getBoundingClientRect().width)),
        lines: Math.max(...meta.map((m) => m.getBoundingClientRect().height / lead)),
        scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    console.log(`posters at 900 px: narrowest ${sizes.width.toFixed(0)} px, state line ${sizes.lines.toFixed(2)} lines`);
    expect(sizes.width).toBeGreaterThanOrEqual(200);
    expect(sizes.lines).toBeLessThanOrEqual(2.6);
    expect(sizes.scroll).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  it('A-L1: a production the search hides is no longer selected — the inspector shows the project; B-L4: the search keeps its limits', async () => {
    const page = await tab(`/p/${P}`);
    await page.locator('[role="option"][data-id="quote"]').click();
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByTestId('scenario-link').waitFor(POLL);
    const search = page.getByRole('searchbox', { name: 'Search productions' });
    expect([await search.getAttribute('maxlength'), await search.getAttribute('autocomplete'), await search.getAttribute('spellcheck')]).toEqual(['200', 'off', 'false']);
    await search.fill('catalogue');
    await expect.poll(() => page.locator('[role="option"]').count(), POLL).toBeGreaterThan(0);
    expect(await page.locator('[role="option"][data-id="quote"]').count()).toBe(0);
    await inspector.getByTestId('readme-preview').waitFor(POLL);
    expect(await inspector.getByTestId('scenario-link').count()).toBe(0);
    expect(await page.locator('[role="option"][aria-selected="true"]').count()).toBe(0);
    // Welcome's search too.
    await page.goto(`${studio.url}#/`);
    const ws2 = page.getByRole('searchbox', { name: 'Search' });
    expect([await ws2.getAttribute('maxlength'), await ws2.getAttribute('autocomplete'), await ws2.getAttribute('spellcheck')]).toEqual(['200', 'off', 'false']);
    await page.context().close();
  });

  it("A-L6, B-L6, B-L1: the warnings' disclosure says what it shows; the README preview a tab stop; the folder its full path in a tooltip; a persona's location on its own line", async () => {
    const page = await tab('/p/warned');
    await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor(POLL);
    expect(await page.locator('main summary').innerText()).toBe('Show the warning');
    await page.goto(`${studio.url}#/p/${P}`);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    const pre = inspector.getByTestId('readme-preview');
    await pre.waitFor(POLL);
    expect(await pre.getAttribute('tabindex')).toBe('0');
    expect(await pre.getAttribute('aria-label')).toBe('README.md, the first lines');
    const folder = inspector.locator('.pr-path');
    expect(await folder.getAttribute('title')).toBe(join(ws, 'projects', P));
    // The fixture's personas live in more than one location: each one's location is a line of its own, never cut.
    const rows = page.locator('.sh-browser [aria-label="Personas"] .k-source-item');
    await rows.first().waitFor(POLL);
    const details = await page.locator('.sh-browser [aria-label="Personas"] .k-source-detail').allInnerTexts();
    expect(details.length).toBe(await rows.count());
    expect(details.every((d) => d.length > 0)).toBe(true);
    expect(
      await page
        .locator('.sh-browser [aria-label="Personas"] .k-source-label')
        .first()
        .evaluate((el) => (el.textContent ?? '').includes(' · ')),
    ).toBe(false);
    await page.context().close();
  });
});
