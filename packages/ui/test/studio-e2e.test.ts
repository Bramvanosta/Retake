/**
 * L4.1 parts 2 and 3: the Studio app end to end in headless Chromium (the installed build of playwright-core 1.56.1; nothing
 * downloaded), against a Studio server on a scratch workspace — a copy of the fixture project plus hostile ones:
 * bootstrap code → projects list → a project → edit and save its README (bytes and hash on disk, atomic) → reload keeps
 * the session → search and recent activity (the index) → the file changed on disk, told by the event stream (clean:
 * reloaded; dirty: banner) → the 409 conflict panel, both ways out → seven more tabs share ONE event stream (Web Lock
 * + BroadcastChannel), every call answers, a change reaches a follower tab, the stream passes on when its tab closes →
 * hostile project names, URLs, errors and README text shown as inert text (no script ran, no CSP report) → a tab
 * without a code ends → a cross-origin page holding the token is refused and runs no op → a DNS-rebinding navigation
 * gets 421. `RETAKE_UI_SHOTS=<folder>` saves screenshots of the screens there.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const SHOTS = process.env.RETAKE_UI_SHOTS;
/** DOM-state waits, generous for a loaded machine (the editor re-reads its file every 3 s). */
const POLL = { timeout: 15_000 };
const FIXTURE = 'northfield-fixture';
const HOSTILE_NAME = `<img src=x onerror="window.__pwned='name'"> \u202Egnp.exe`;
const HOSTILE_FOLDER = '<img src=x onerror=window.__pwned=5>';
const HOSTILE_README = [
  "# <script>window.__pwned='readme'</script>",
  '',
  `<img src=x onerror="window.__pwned='readme-img'">`,
  "[click me](javascript:window.__pwned='link')",
  '<iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>',
  '\u202Etxt.exe',
  '',
].join('\n');

let ws: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const savedHome = process.env.RETAKE_HOME;
const dialogs: string[] = [];
const consoleErrors: string[] = [];
const readmeFile = (slug = FIXTURE) => join(ws, 'projects', slug, 'README.md');

async function shot(name: string, p: Page = page): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

/** Every page of the context: CSP reports counted, dialogs recorded (a script that ran would raise them). */
async function watch(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => (window as unknown as { __csp: number }).__csp++);
  });
  ctx.on('page', (p) => {
    p.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    p.on('console', (m) => {
      // A refused call (400 for the hostile folder's slug) is logged by the browser itself: not an app error.
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
  });
}

const pwned = (p: Page) => p.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned ?? null);
const csp = (p: Page) => p.evaluate(() => (window as unknown as { __csp: number }).__csp);
const textarea = () => page.locator('#readme-text');
/** L5.10a: back to Welcome through the title bar's project menu (or the address when no project is open). */
async function toWelcome(p: Page): Promise<void> {
  const menu = p.getByRole('banner').getByRole('button', { name: /./ }).filter({ has: p.locator('.k-btn-label') }).first();
  if (await menu.count()) {
    await menu.click();
    await p.getByRole('menuitem', { name: 'All projects' }).click();
  } else await p.goto(`${studio.url}#/`);
  await p.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await mkdir(join(ws, '.retake'), { recursive: true });
  await writeFile(
    join(ws, '.retake', 'history.jsonl'),
    `${JSON.stringify({ v: 1, at: new Date(Date.now() - 120_000).toISOString(), kind: 'run', project: FIXTURE, submitted_by: 'mcp', state: 'succeeded', run: { id: '20261016-090000-catalogue', scenario: 'catalogue', mode: 'capture', status: 'succeeded' }, counted: { captures: 1, dry_runs: 0, renders: 0 } })}\n`,
  );
  const hostile = join(ws, 'projects', 'hostile');
  await mkdir(hostile, { recursive: true });
  await writeFile(
    join(hostile, 'project.yaml'),
    [
      'version: 1',
      `name: ${JSON.stringify(HOSTILE_NAME)}`,
      'environments:',
      '  staging:',
      `    app: {url: "https://app.staging.example.com/<svg/onload=window.__pwned=7>", display: "shop.example.com/\\"><svg/onload=window.__pwned='display'>"}`,
      'default_env: staging',
      '',
    ].join('\n'),
  );
  await writeFile(join(hostile, 'README.md'), HOSTILE_README);
  // L5.10a: a production whose title is markup and a right-to-left override (the poster, the inspector).
  await mkdir(join(hostile, 'scenarios'), { recursive: true });
  await writeFile(join(hostile, 'scenarios', 'evil.yaml'), `version: 1\nvideo: evil\ntitle: {text: ${JSON.stringify(HOSTILE_NAME)}}\nscenes:\n  - id: a\n    page: app\n    open: /\n    steps:\n      - hold: 1\n`);
  const folder = join(ws, 'projects', HOSTILE_FOLDER);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'project.yaml'), `version: 1\nname: "<svg onload=window.__pwned='folder'>"\nenvironments: {}\n`);
  const broken = join(ws, 'projects', 'broken');
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, 'project.yaml'), `version: 1\nname: Broken project\nenvironments:\n  local: "<iframe src=javascript:window.__pwned='error'>"\n`);
  studio = await startStudioServer({ root: ws });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    args: ['--host-resolver-rules=MAP rebind.test 127.0.0.1'],
  });
  context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await watch(context);
  page = await context.newPage();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the Studio in Chromium', () => {
  it('bootstrap: the one-time code becomes a session; the address bar keeps no secret', async () => {
    const url = studio.launchUrl();
    await page.goto(url);
    await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor();
    expect(page.url()).toBe(studio.url);
    expect(await page.evaluate(() => sessionStorage.getItem('retake.token'))).toBe(studio.token);
    // The same link in another tab: already spent, and the new tab holds no token.
    const other = await context.newPage();
    await other.goto(url);
    await other.getByTestId('session-ended').waitFor();
    // A tab with no code at all.
    await other.goto(studio.url);
    await other.getByTestId('session-ended').waitFor();
    expect(await other.evaluate(() => sessionStorage.getItem('retake.token'))).toBeNull();
    await shot('00-session-ended', other);
    await other.close();
  });

  it('projects: every project with its scenarios, environment flags in words and last run; a broken one with its error', async () => {
    const cards = page.getByTestId('project-card');
    await expect.poll(() => cards.count(), POLL).toBe(4);
    const fixture = cards.filter({ hasText: 'Northfield (fixture)' });
    await fixture.getByText(/production/).first().waitFor();
    const text = await fixture.innerText();
    expect(text).toMatch(/\d+ scenarios/);
    // Each flagged environment with its flag words exactly (review B-M3: its name alone must not satisfy the check).
    expect(text).toContain('production: production · read-only');
    expect(text).toContain('sandbox: sandbox');
    expect(text).toMatch(/Last rehearsal failed\s*·\s*quote/);
    const broken = cards.filter({ hasText: 'Broken project' });
    expect(await broken.innerText()).toContain('This project does not load');
    // The sidebar lists them too, the current screen marked.
    expect(await page.getByRole('navigation', { name: 'Studio' }).getByRole('link', { name: 'Projects', exact: true }).getAttribute('aria-current')).toBe('page');
    expect(await page.getByTestId('connection').innerText()).toMatch(/Connected/);
    await shot('01-projects');
  });

  it('a project: README as text, environments, scenarios, recent runs', async () => {
    await page.getByTestId('project-card').filter({ hasText: 'Northfield (fixture)' }).getByRole('link').click();
    await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor();
    expect(page.url()).toBe(`${studio.url}#/p/${FIXTURE}`);
    const disk = await readFile(readmeFile(), 'utf8');
    expect(await page.getByTestId('readme-preview').textContent()).toBe(disk.split('\n').slice(0, 40).join('\n'));
    await page.getByRole('heading', { name: 'Recent runs' }).waitFor();
    await page.getByText('20261017').or(page.getByText('rehearsal ·').first()).first().waitFor();
    await shot('02-project');
    // L5.10a: a location's pages, display URLs and flags are in the inspector (the browser's Locations row).
    await page.getByRole('navigation', { name: 'Studio' }).getByRole('link', { name: /^local/ }).click();
    await page.getByTestId('location-pages').waitFor();
    expect(await page.getByTestId('location-pages').locator('.k-facts').count()).toBeGreaterThan(0);
  });

  it('search (the index): hits as one types, each a link to its project; recent activity from the history', async () => {
    await toWelcome(page);
    const activity = page.getByTestId('activity');
    await activity.getByTestId('activity-item').first().waitFor(POLL);
    expect(await activity.innerText()).toMatch(/capture of catalogue[\s\S]*by Claude/);
    await page.getByRole('searchbox').fill('quo');
    const hits = page.getByTestId('search-hit');
    await expect.poll(() => hits.count(), POLL).toBeGreaterThan(1);
    const text = await page.getByTestId('search-hits').innerText();
    expect(text).toContain('scenario');
    expect(text).toContain('20261017-120000-quote');
    await shot('01b-search');
    await page.getByRole('searchbox').fill('zzzz-nothing');
    await page.getByTestId('search-empty').waitFor(POLL);
    await page.getByRole('searchbox').fill('quote');
    await hits.filter({ hasText: 'scenario' }).first().getByRole('link').click();
    await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor();
    expect(await page.getByTestId('connection').getAttribute('data-updates')).toBe('stream');
    await shot('02b-project-activity');
  });

  it('edit and save the README: Cmd/Ctrl+S, the exact bytes on disk, the hash, no temp file; a reload keeps the session', async () => {
    await page.getByRole('link', { name: 'Edit the README' }).click();
    await textarea().waitFor();
    expect(await textarea().inputValue()).toBe(await readFile(readmeFile(), 'utf8'));
    expect(await textarea().getAttribute('maxlength')).toBe('200000');
    await expect.poll(() => page.getByTestId('save-state').innerText(), POLL).toBe('No changes');
    const text = '# Northfield\n\nEdited from the Studio, in a browser.';
    await textarea().fill(text);
    expect(await page.getByTestId('save-state').innerText()).toBe('Unsaved changes');
    expect(await page.getByRole('navigation', { name: 'Studio' }).innerText()).toContain('unsaved');
    await textarea().press('ControlOrMeta+s');
    await expect.poll(() => page.getByTestId('save-state').innerText(), POLL).toMatch(/^Saved · [0-9a-f]{12}$/);
    const bytes = await readFile(readmeFile(), 'utf8');
    expect(bytes).toBe(`${text}\n`);
    expect(await page.getByTestId('save-state').innerText()).toBe(`Saved · ${sha(bytes).slice(0, 12)}`);
    expect((await readdir(join(ws, 'projects', FIXTURE))).filter((f) => f.includes('.tmp'))).toEqual([]);
    await shot('03-readme-saved');
    await page.reload();
    await textarea().waitFor();
    expect(page.url()).toBe(`${studio.url}#/p/${FIXTURE}/readme`);
    expect(await textarea().inputValue()).toBe(`${text}\n`);
  });

  it('changed on disk: with no unsaved text the editor loads the new version and says so', async () => {
    await writeFile(readmeFile(), '# Northfield\n\nChanged in another editor.\n');
    await expect.poll(() => textarea().inputValue(), POLL).toBe('# Northfield\n\nChanged in another editor.\n');
    await page.getByText('README.md changed on disk: the editor now shows the new version.').waitFor();
  });

  it('changed on disk with unsaved text: banner, edits kept; save → conflict panel → "Save mine over it"', async () => {
    await textarea().fill('# Mine\n\nMy version.\n');
    await writeFile(readmeFile(), '# Theirs\n\nWritten meanwhile.\n');
    await page.getByRole('alert').filter({ hasText: 'README.md changed on disk' }).waitFor(POLL);
    expect(await textarea().inputValue()).toBe('# Mine\n\nMy version.\n');
    await shot('04-changed-on-disk');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const conflict = page.getByTestId('conflict');
    await conflict.waitFor();
    expect(await page.getByTestId('conflict-disk').inputValue()).toBe('# Theirs\n\nWritten meanwhile.\n');
    expect(await readFile(readmeFile(), 'utf8')).toBe('# Theirs\n\nWritten meanwhile.\n');
    await shot('05-conflict');
    await conflict.getByRole('button', { name: 'Save mine over it' }).click();
    await conflict.waitFor({ state: 'detached' });
    await expect.poll(() => page.getByTestId('save-state').innerText(), POLL).toMatch(/^Saved/);
    expect(await readFile(readmeFile(), 'utf8')).toBe('# Mine\n\nMy version.\n');
  });

  it('conflict → "Load the version on disk": the disk wins, the person\'s text stays readable to copy', async () => {
    await textarea().fill('# Mine again\n');
    await writeFile(readmeFile(), '# Theirs again\n');
    await page.getByRole('alert').filter({ hasText: 'README.md changed on disk' }).waitFor(POLL);
    await textarea().press('ControlOrMeta+s');
    const conflict = page.getByTestId('conflict');
    await conflict.waitFor();
    await conflict.getByRole('button', { name: 'Load the version on disk' }).click();
    expect(await textarea().inputValue()).toBe('# Theirs again\n');
    expect(await page.getByLabel('Your previous text').inputValue()).toBe('# Mine again\n');
    expect(await readFile(readmeFile(), 'utf8')).toBe('# Theirs again\n');
    expect(await page.getByTestId('save-state').innerText()).toBe('No changes');
  });

  it('seven more tabs: one event stream for the browser, every call answers at once, a change reaches a follower; the stream passes on (B1)', async () => {
    expect(studio.streams).toBe(1);
    const tabs: Page[] = [];
    for (let i = 0; i < 7; i++) {
      const t = await context.newPage();
      await t.goto(studio.launchUrl());
      await t.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
      tabs.push(t);
    }
    expect(studio.streams).toBe(1);
    for (const t of tabs) {
      const [status, ms] = await t.evaluate(async () => {
        const t0 = performance.now();
        const r = await fetch('/v1/info', { headers: { Authorization: `Bearer ${sessionStorage.getItem('retake.token')}` } });
        return [r.status, performance.now() - t0];
      });
      expect(status).toBe(200);
      expect(ms).toBeLessThan(1000);
      expect(await t.getByTestId('connection').getAttribute('data-updates')).toBe('relay');
    }
    // A follower's editor hears of a change on disk (relayed by the leader's tab).
    const follower = tabs[6];
    await follower.goto(`${studio.url}#/p/${FIXTURE}/readme`);
    await follower.locator('#readme-text').waitFor();
    await writeFile(readmeFile(), '# Northfield\n\nChanged while eight tabs were open.\n');
    await expect.poll(() => follower.locator('#readme-text').inputValue(), POLL).toBe('# Northfield\n\nChanged while eight tabs were open.\n');
    await follower.getByText('README.md changed on disk: the editor now shows the new version.').waitFor();
    // The leader's tab closes: another tab takes the lock and opens the stream; changes still arrive.
    await page.close();
    await expect.poll(async () => (await Promise.all(tabs.map((t) => t.getByTestId('connection').getAttribute('data-updates')))).filter((m) => m === 'stream').length, POLL).toBe(1);
    expect(studio.streams).toBe(1);
    await writeFile(readmeFile(), '# Northfield\n\nAfter the hand-over.\n');
    await expect.poll(() => follower.locator('#readme-text').inputValue(), POLL).toBe('# Northfield\n\nAfter the hand-over.\n');
    page = tabs[6];
    for (const t of tabs.slice(0, 6)) await t.close();
    await expect.poll(() => page.getByTestId('connection').getAttribute('data-updates'), POLL).toBe('stream');
    await expect.poll(() => studio.streams, POLL).toBe(1);
  });

  it('hostile names, URLs, errors and README text are shown as text: no script runs, no CSP report, no link from data', async () => {
    await toWelcome(page);
    const cards = page.getByTestId('project-card');
    await expect.poll(() => cards.count(), POLL).toBe(4);
    const hostileCard = cards.filter({ hasText: 'gnp.exe' });
    // The markup is text; the right-to-left override is a visible mark ("exe.png" never shows).
    expect(await hostileCard.getByRole('heading').innerText()).toBe('<img src=x onerror="window.__pwned=\'name\'"> [U+202E]gnp.exe');
    await page.getByText(HOSTILE_FOLDER, { exact: true }).first().waitFor();
    await shot('06-hostile-projects');
    // The project whose folder name is markup: its slug is refused by the server, shown as text.
    await cards.filter({ hasText: HOSTILE_FOLDER }).getByRole('link').click();
    await page.getByText('This project cannot be opened').waitFor();
    // The broken project: its full error, hostile line included, as text.
    await page.goto(`${studio.url}#/p/broken`);
    await page.getByText('This project cannot be opened').waitFor();
    expect(await page.getByRole('alert').innerText()).toContain("<iframe src=javascript:window.__pwned='error'>");
    // The hostile project: name, page URL, display URL and README.
    await page.goto(`${studio.url}#/p/hostile`);
    await page.getByRole('banner').getByRole('button').filter({ hasText: 'gnp.exe' }).waitFor();
    // The production's title on its poster and in the inspector: text, the override a visible mark (L5.10a).
    const poster = page.locator('[role="option"][data-id="evil"]');
    await poster.waitFor();
    expect(await poster.locator('.k-card-title').innerText()).toBe('<img src=x onerror="window.__pwned=\'name\'"> [U+202E]gnp.exe');
    await poster.click();
    expect(await page.locator('.sh-inspector .pr-title h3').innerText()).toBe('<img src=x onerror="window.__pwned=\'name\'"> [U+202E]gnp.exe');
    await poster.click();
    await page.keyboard.press('Escape');
    // The README preview is text; its right-to-left override a visible mark (L5.10a: through Txt, like every text from
    // data — a raw override in the preview could reorder what it shows; the editor below keeps the exact bytes).
    expect(await page.getByTestId('readme-preview').textContent()).toBe(HOSTILE_README.replace('\u202E', '[U+202E]'));
    await shot('07-hostile-project');
    // The location's page URL and display URL: text in the inspector (L5.10a) — reached with a production selected,
    // no Escape first (review B-M1: the location route shows the location).
    await poster.click();
    await page.locator('.sh-inspector .pr-title h3').waitFor();
    await page.goto(`${studio.url}#/p/hostile/loc/staging`);
    await page.getByTestId('location-pages').waitFor();
    const main = await page.locator('.sh-inspector').innerText();
    expect(main).toContain('https://app.staging.example.com/<svg/onload=window.__pwned=7>');
    await page.goto(`${studio.url}#/p/hostile`);
    await page.getByRole('link', { name: 'Edit the README' }).click();
    await textarea().waitFor();
    expect(await textarea().inputValue()).toBe(HOSTILE_README);
    // Nothing ran, nothing was injected, nothing was refused by the CSP (the second line was never needed).
    expect(await pwned(page)).toBeNull();
    expect(dialogs).toEqual([]);
    expect(await csp(page)).toBe(0);
    // (The kit's own icons, state shapes and app mark — classes k-icon, k-mark-svg and k-appmark, the kit's own — are
    // aria-hidden SVG drawn by the Studio, never from data; the __pwned and CSP checks above stay the real guard.)
    expect(await page.locator('img, iframe, svg:not(.k-icon):not(.k-mark-svg):not(.k-appmark), object, embed').count()).toBe(0);
    expect(await page.locator('script').count()).toBe(1);
    const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h, h).toMatch(/^#\//);
    expect(consoleErrors).toEqual([]);
  });

  it('a cross-origin page holding the token is refused and runs no op; a DNS-rebinding navigation gets 421', async () => {
    // Close the Studio's own tab first: its polling would count as ops.
    const token = await page.evaluate(() => sessionStorage.getItem('retake.token'));
    expect(token).toBe(studio.token);
    await page.close();
    const before = await readFile(readmeFile());
    const calls = studio.calls;
    const target = `http://127.0.0.1:${studio.port}/v1/call/project_update_readme`;
    const body = JSON.stringify({ project: FIXTURE, markdown: '# pwned', if_match: sha(before) });
    const evil = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><form id="f" method="POST" enctype="text/plain" action="${target}"><input name='${body.slice(0, -1)},"x":"' value='"}'></form><script>
        const t = ${JSON.stringify(token)}, b = ${JSON.stringify(body)};
        window.results = [];
        fetch(${JSON.stringify(target)}, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: b })
          .then((r) => results.push('cors ' + r.status), () => results.push('cors blocked'));
        fetch(${JSON.stringify(target)}, { method: 'POST', mode: 'no-cors', headers: { Authorization: 'Bearer ' + t }, body: b })
          .then(() => results.push('no-cors opaque'), () => results.push('no-cors failed'));
      </script>`);
    });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    try {
      const ep = await context.newPage();
      const seen: Array<[string, number]> = [];
      ep.on('response', (r) => r.url().startsWith(`http://127.0.0.1:${studio.port}/`) && seen.push([r.request().method(), r.status()]));
      await ep.goto(`http://127.0.0.1:${(evil.address() as AddressInfo).port}/`);
      await ep.waitForFunction(() => (window as unknown as { results: string[] }).results.length === 2);
      const results = await ep.evaluate(() => (window as unknown as { results: string[] }).results);
      expect(results).toContain('cors blocked');
      expect(results.some((r) => r.startsWith('no-cors'))).toBe(true);
      const form = ep.waitForResponse((r) => r.url() === target);
      await ep.evaluate(() => (document.getElementById('f') as HTMLFormElement).submit());
      expect((await form).status()).toBe(403);
      // The preflight is refused (403 at the Origin layer), the no-cors POST too: nothing got past the gate.
      for (const [, status] of seen) expect(status).toBe(403);
      expect(studio.calls).toBe(calls);
      expect(await readFile(readmeFile())).toEqual(before);
      await ep.close();
    } finally {
      await new Promise<void>((r) => evil.close(() => r()));
    }
    // DNS rebinding: a name that resolves to 127.0.0.1 carries its own Host.
    const rb = await context.newPage();
    const res = await rb.goto(`http://rebind.test:${studio.port}/`);
    expect(res?.status()).toBe(421);
    await rb.close();
    expect(dialogs).toEqual([]);
  });
});
