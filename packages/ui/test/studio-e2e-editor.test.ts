/**
 * L4.1 fixes (reviews A and B): the README editor's edge cases and the live-update fallbacks, end to end in headless
 * Chromium against an in-process Studio server on a scratch workspace —
 * a CR LF README round-trips byte for byte and loading it is no change (B M1); a README that is not UTF-8, or that
 * links out of the project, opens read-only with why (B M1, M3); one linked inside the project is saved through the
 * link (B M3); a missing README says saving creates it (B L7); the cap counts the final line break (B L6); a re-read
 * that started before a save is ignored (the epoch guard), closing a tab with unsaved text asks first, every stream slot
 * taken → the tab polls and still sees changes, a lost stream's successor re-reads what changed meanwhile (B M4); the
 * Projects screen re-reads its cards in one call (B L2); and the session ending (server restarted on the same port)
 * keeps the unsaved text on screen (B H1).
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { ClientRequest, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const POLL = { timeout: 15_000 };
const FIXTURE = 'northfield-fixture';
const CRLF = '# Title\r\n\r\nLine one\r\nLine two\r\n';
const LATIN1 = Buffer.from('# Caf\xe9 cr\xe8me\n\nPr\xe9sentation du produit.\n', 'latin1');
const SECRET = 'OUTSIDE THE PROJECT: never shown\n';

let ws: string;
let studio: StudioServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const savedHome = process.env.RETAKE_HOME;
const readme = (slug: string) => join(ws, 'projects', slug, 'README.md');
const textarea = (p: Page = page) => p.locator('#readme-text');
const state = (p: Page = page) => p.getByTestId('save-state').innerText();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function project(slug: string, readmeText?: string | Buffer): Promise<string> {
  const dir = join(ws, 'projects', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), `version: 1\nname: ${slug}\nenvironments: {}\n`);
  if (readmeText !== undefined) await writeFile(join(dir, 'README.md'), readmeText);
  return dir;
}

/** Open the editor of `slug` in `p` (a tab that already holds a session). */
async function openEditor(slug: string, p: Page = page): Promise<void> {
  await p.goto(`${studio.url}#/p/${slug}/readme`);
  await p.getByRole('heading', { level: 1, name: 'README.md' }).waitFor(POLL);
}

/** An event stream held open from outside the browser (it takes one of the server's 4 slots). */
function holdStream(): Promise<ClientRequest> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: studio.port, path: '/v1/events', method: 'GET', agent: false, setHost: false, headers: { host: `127.0.0.1:${studio.port}`, authorization: `Bearer ${studio.token}` } },
      (res) => {
        res.on('data', () => undefined);
        res.on('error', () => undefined);
        expect(res.statusCode).toBe(200);
        resolve(req);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-e2e-editor-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await project('crlf', CRLF);
  await project('latin', LATIN1);
  await project('missing');
  const inside = await project('in-link');
  await mkdir(join(inside, 'docs'), { recursive: true });
  await writeFile(join(inside, 'docs', 'product.md'), '# Product doc\n');
  await symlink('docs/product.md', join(inside, 'README.md'));
  await mkdir(join(ws, 'outside'), { recursive: true });
  await writeFile(join(ws, 'outside', 'secret.md'), SECRET);
  const out = await project('out-link');
  await symlink('../../outside/secret.md', join(out, 'README.md'));
  studio = await startStudioServer({ root: ws });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  page = await context.newPage();
  await page.goto(studio.launchUrl());
  await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the README editor keeps the bytes it was given (review B M1, M3, L6, L7)', () => {
  it('CR LF: loading is no change, typing and deleting leaves none, a save keeps CR LF on every line', async () => {
    await openEditor('crlf');
    expect(await textarea().inputValue()).toBe(CRLF.replace(/\r\n/g, '\n'));
    await expect.poll(() => state(), POLL).toBe('No changes');
    await textarea().click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('x');
    expect(await state()).toBe('Unsaved changes');
    await page.keyboard.press('Backspace');
    expect(await state()).toBe('No changes');
    await page.keyboard.type('Line three');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => state(), POLL).toMatch(/^Saved · /);
    const bytes = await readFile(readme('crlf'), 'utf8');
    expect(bytes).toBe('# Title\r\n\r\nLine one\r\nLine two\r\nLine three\r\n');
    expect(await state()).toBe(`Saved · ${sha(bytes).slice(0, 12)}`);
  });

  it('a README that is not UTF-8 opens read-only with why, and is never rewritten', async () => {
    await openEditor('latin');
    const why = page.getByTestId('readme-readonly');
    await why.waitFor(POLL);
    expect(await why.innerText()).toContain('not UTF-8');
    expect(await textarea().count()).toBe(0);
    expect(await page.getByLabel('README.md (read-only)').inputValue()).toContain('Caf�');
    expect(await page.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
    expect(await readFile(readme('latin'))).toEqual(LATIN1);
  });

  it('a project with no README.md: the editor says saving creates it', async () => {
    await openEditor('missing');
    await page.getByTestId('readme-missing').waitFor(POLL);
    expect(await state()).toBe('No README.md yet');
    await textarea().fill('# Missing no more');
    await textarea().press('ControlOrMeta+s');
    await expect.poll(() => state(), POLL).toMatch(/^Saved · /);
    expect(await readFile(readme('missing'), 'utf8')).toBe('# Missing no more\n');
    expect(await page.getByTestId('readme-missing').count()).toBe(0);
  });

  it('a README linked inside the project is saved through the link; one linked out opens read-only, its target never shown', async () => {
    await openEditor('in-link');
    expect(await textarea().inputValue()).toBe('# Product doc\n');
    await textarea().fill('# Product doc, edited in the Studio\n');
    await textarea().press('ControlOrMeta+s');
    await expect.poll(() => state(), POLL).toMatch(/^Saved · /);
    expect((await lstat(readme('in-link'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(ws, 'projects', 'in-link', 'docs', 'product.md'), 'utf8')).toBe('# Product doc, edited in the Studio\n');
    // Linked out: the project opens (its card and page are not a dead end), the README is never read.
    await page.goto(`${studio.url}#/p/out-link`);
    await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor(POLL);
    // L5.10a: the README's notice is in the project inspector.
    await expect.poll(() => page.locator('.sh-inspector').innerText(), POLL).toContain('README.md cannot be edited here');
    await page.getByRole('link', { name: 'Open the README' }).click();
    await page.getByTestId('readme-readonly').waitFor(POLL);
    expect(await page.getByTestId('readme-readonly').innerText()).toContain('symbolic link leading out of the project folder');
    expect(await page.locator('body').innerText()).not.toContain(SECRET.trim());
    expect(await readFile(join(ws, 'outside', 'secret.md'), 'utf8')).toBe(SECRET);
  });

  it('the cap counts the final line break: 200,000 characters without one are refused before anything is sent', async () => {
    await openEditor('missing');
    await textarea().waitFor();
    const before = await readFile(readme('missing'));
    let writes = 0;
    const count = (r: { url(): string }) => r.url().endsWith('/v1/call/project_update_readme') && writes++;
    page.on('request', count);
    try {
      await textarea().fill('x'.repeat(200_000));
      await textarea().press('ControlOrMeta+s');
      await page.getByRole('alert').filter({ hasText: 'limited to 200,000 characters, its final line break included' }).waitFor(POLL);
      expect(writes).toBe(0);
      expect(await readFile(readme('missing'))).toEqual(before);
      // One character less fits, final line break included; and the file then reads back as a text that saves.
      await textarea().fill('x'.repeat(199_999));
      await textarea().press('ControlOrMeta+s');
      await expect.poll(() => state(), POLL).toMatch(/^Saved · /);
      expect((await readFile(readme('missing'), 'utf8')).length).toBe(200_000);
      expect(writes).toBe(1);
    } finally {
      page.off('request', count);
    }
  });
});

describe('the Projects screen (review B L2)', () => {
  it('a focus re-reads every card in one call: no project_get or run_list per card', async () => {
    await page.goto(`${studio.url}#/`);
    const cards = page.getByTestId('project-card');
    await expect.poll(() => cards.count(), POLL).toBe(6);
    await cards.filter({ hasText: 'Northfield (fixture)' }).getByText(/production/).first().waitFor(POLL);
    expect(await cards.filter({ hasText: 'Northfield (fixture)' }).innerText()).toMatch(/Last rehearsal failed\s*·\s*quote/);
    // The flag words exactly, not the environment's name (review B-M3).
    expect(await cards.filter({ hasText: 'Northfield (fixture)' }).innerText()).toContain('production: production · read-only');
    await sleep(1000);
    const ops: string[] = [];
    const seen = (r: { url(): string }) => r.url().includes('/v1/call/') && ops.push(r.url().split('/v1/call/')[1]);
    page.on('request', seen);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(1500);
    } finally {
      page.off('request', seen);
    }
    // One overview for the six cards (an engine_info tick or an event may add a call or two, never one per card).
    expect(ops).toContain('projects_overview');
    expect(ops.filter((o) => o === 'project_get' || o === 'run_list')).toEqual([]);
    expect(ops.length).toBeLessThanOrEqual(6);
  });

  it('L5.10a: opening a project reads it once — one project_get, one project_board, one auth_status (the browser and the screen share them); a focus re-reads each once', async () => {
    await page.goto(`${studio.url}#/`);
    await page.getByTestId('project-card').first().waitFor(POLL);
    await sleep(500);
    const ops: string[] = [];
    const seen = (r: { url(): string }) => r.url().includes('/v1/call/') && ops.push(r.url().split('/v1/call/')[1]);
    page.on('request', seen);
    try {
      await page.getByTestId('project-card').filter({ hasText: 'Northfield (fixture)' }).getByRole('link').click();
      await page.getByRole('heading', { level: 1, name: 'Productions' }).waitFor(POLL);
      await page.locator('[role="option"]').first().waitFor(POLL);
      await sleep(1000);
      const count = (op: string) => ops.filter((o) => o === op).length;
      expect([count('project_get'), count('project_board'), count('auth_status')]).toEqual([1, 1, 1]);
      ops.length = 0;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(1500);
      expect([count('project_get'), count('project_board'), count('auth_status')]).toEqual([1, 1, 1]);
    } finally {
      page.off('request', seen);
    }
  });
});

describe('the editor and the live updates when things go wrong (review B M4)', () => {
  it('a re-read that started before a save and answers after it is ignored (the epoch guard)', async () => {
    await openEditor(FIXTURE);
    await expect.poll(() => state(), POLL).toBe('No changes');
    await textarea().fill('# Northfield\n\nSaved while a re-read was on its way.\n');
    // Every project_get of the next moment answers with what the server said then — 1.5 s late.
    let hold = true;
    await page.route('**/v1/call/project_get', async (route) => {
      if (!hold) return route.continue();
      const stale = await route.fetch();
      await sleep(1500);
      await route.fulfill({ response: stale });
    });
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(300);
      hold = false;
      await textarea().press('ControlOrMeta+s');
      await expect.poll(() => state(), POLL).toMatch(/^Saved · /);
      // The stale answers (the file before the save) arrive now: the editor must not take them for a change on disk.
      await sleep(2000);
      expect(await textarea().inputValue()).toBe('# Northfield\n\nSaved while a re-read was on its way.\n');
      expect(await page.getByText('README.md changed on disk').count()).toBe(0);
      expect(await state()).toMatch(/^Saved · /);
    } finally {
      await page.unroute('**/v1/call/project_get');
    }
  });

  it('closing a tab with unsaved text asks first (beforeunload)', async () => {
    const tab = await context.newPage();
    try {
      await tab.goto(studio.launchUrl());
      await tab.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
      await openEditor(FIXTURE, tab);
      await textarea(tab).click();
      await tab.keyboard.type(' unsaved');
      expect(await state(tab)).toBe('Unsaved changes');
      // Accepted, so the tab then closes (a dismissed beforeunload leaves Playwright unable to close it later).
      const asked = new Promise<string>((resolve) => tab.once('dialog', (d) => void d.accept().then(() => resolve(d.type()))));
      const closed = new Promise<void>((resolve) => tab.once('close', () => resolve()));
      await tab.close({ runBeforeUnload: true });
      expect(await Promise.race([asked, sleep(5000).then(() => 'no dialog within 5 s')])).toBe('beforeunload');
      await closed;
    } finally {
      if (!tab.isClosed()) await tab.close();
    }
  });

  it('every stream slot taken: the tab polls every 3 s ("updates every 3 s") and still sees a change on disk', async () => {
    const held: ClientRequest[] = [];
    const other = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    try {
      while (studio.streams < 4) held.push(await holdStream());
      const tab = await other.newPage();
      await tab.goto(studio.launchUrl());
      await tab.getByRole('heading', { level: 2, name: 'Projects' }).waitFor(POLL);
      await expect.poll(() => tab.getByTestId('connection').getAttribute('data-updates'), POLL).toBe('polling');
      expect(await tab.getByTestId('connection').innerText()).toContain('updates every 3 s');
      await openEditor(FIXTURE, tab);
      await expect.poll(() => state(tab), POLL).toBe('No changes');
      await writeFile(readme(FIXTURE), '# Northfield\n\nChanged while every stream slot was taken.\n');
      await expect.poll(() => textarea(tab).inputValue(), POLL).toBe('# Northfield\n\nChanged while every stream slot was taken.\n');
    } finally {
      for (const r of held) r.destroy();
      await other.close();
    }
    await expect.poll(() => studio.streams, POLL).toBe(1);
  });

  it('a lost stream: the next one makes every screen re-read — a change told to nobody meanwhile shows', async () => {
    await openEditor(FIXTURE);
    await expect.poll(() => page.getByTestId('connection').getAttribute('data-updates'), POLL).toBe('stream');
    await expect.poll(() => state(), POLL).toMatch(/^(No changes|Saved · )/);
    const streams = (studio.live as unknown as { streams: Set<ServerResponse> }).streams;
    expect(streams.size).toBe(1);
    for (const res of streams) res.destroy();
    // While no stream is open (the page waits 1 s before it reconnects): change the file, and let the server's index
    // take the change in (two refreshes: one may already be running) — no stream hears of it.
    await writeFile(readme(FIXTURE), '# Northfield\n\nChanged while the stream was down.\n');
    for (let i = 0; i < 2; i++) expect((await raw(studio.port, 'POST', '/v1/call/search', { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, '{"q":"down"}')).status).toBe(200);
    await expect.poll(() => textarea().inputValue(), POLL).toBe('# Northfield\n\nChanged while the stream was down.\n');
    await expect.poll(() => page.getByTestId('connection').getAttribute('data-updates'), POLL).toBe('stream');
  });

  it('the session ends (the server restarted on its port) with unsaved text: the text stays on screen to copy (review B H1)', async () => {
    await openEditor(FIXTURE);
    const mine = '# My long unsaved text\n\nthat I typed for ten minutes';
    await textarea().fill(mine);
    expect(await state()).toBe('Unsaved changes');
    const port = studio.port;
    await studio.close();
    studio = await startStudioServer({ root: ws, port });
    await page.getByTestId('session-ended').waitFor(POLL);
    expect(await page.getByTestId('unsaved-draft').inputValue()).toBe(mine);
    expect(await page.getByTestId('unsaved-drafts').innerText()).toContain(`README.md of ${FIXTURE}`);
    expect(await readFile(readme(FIXTURE), 'utf8')).not.toContain('ten minutes');
  });
});
