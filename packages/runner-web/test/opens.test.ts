/**
 * What the runner opens, in a real browser: every navigation it starts — a scene's `open`, a multi-page scene's
 * `pages[].open`, an `open` step, a `new_tab` step (its `href`, or the clicked link's) and the prewarm visits — is
 * checked on its final URL, templated and resolved: http(s) or about:blank for every run; for work submitted through MCP
 * or the Studio, a URL the scenario wrote is on an origin of the environment's pages, while a link the page provides gets
 * the scheme rule only (plus blob: of the page's own origin). A refused URL is a step error and its page never loads.
 * Under it, the browser of every run refuses file: requests itself (a browser-level CDP session, not a route: the HTTP
 * cache keeps working), and a run whose browser cannot be guarded does not start.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileWritePolicy } from '@retake/core';
import type { RunRecord, Scenario } from '@retake/core';
import { kitConfigFor, openSession, runScenario } from '../src/index.js';
import { armFileGuard } from '../src/session.js';
import { openProblem } from '../src/opens.js';
import { prewarmTargets } from '../src/prewarm.js';
import { FAST, makeProject, makeScenario, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

const SECRET = 'local-file-marker-7731';
let dir: string;
let outside: string;
let fileUrl: string;
let app: TestServer;
let other: TestServer;
/** The other server by name: another origin (another port, another host spelling). */
let otherUrl: string;

/** A link the page provides, clicked: its default prevented, so the runner follows its href itself (new_tab fallback). */
const linkPage = (href: string) =>
  `<!doctype html><html><body><h1>Links</h1><a id="l" href="${href}" onclick="event.preventDefault()">go</a></body></html>`;
/** A page that makes a document of its own (a blob: URL of its origin) and links to it. */
const BLOB_PAGE = `<!doctype html><html><body><h1>Blob</h1><a id="l" href="#" onclick="event.preventDefault()">doc</a>
<script>document.getElementById('l').href = URL.createObjectURL(new Blob(['<h1>Made by the page</h1>'], { type: 'text/html' }));</script></body></html>`;

beforeAll(async () => {
  dir = await tempDir('rw-opens-');
  outside = await tempDir('rw-opens-outside-');
  await writeFile(join(outside, 'secret.txt'), SECRET);
  fileUrl = `file://${outside}/secret.txt`;
  other = await startServer({ '/': '<h1>Other site</h1>', '/x': '<h1>Other site X</h1>' });
  otherUrl = other.url.replace('127.0.0.1', 'localhost');
  app = await startServer({
    '/': '<h1>Home</h1>',
    '/file-link': linkPage(fileUrl),
    '/other-link': linkPage(`${otherUrl}/x`),
    '/blob-link': BLOB_PAGE,
  });
});

afterAll(async () => {
  await app?.close();
  await other?.close();
  for (const d of [dir, outside]) if (d) await rm(d, { recursive: true, force: true });
});

type Trust = 'author' | 'mcp';
async function run(name: string, sc: Omit<Scenario, 'video'>, o: { trust?: Trust; mode?: 'dry' | 'capture'; prewarm?: boolean } = {}): Promise<RunRecord> {
  const project = makeProject(dir, { app: app.url });
  if (o.prewarm) project.config.capture = { ...project.config.capture!, prewarm: true };
  return runScenario({
    project,
    scenario: makeScenario(name, { pacing: FAST, ...sc }),
    mode: o.mode ?? 'dry',
    env: 'test',
    runId: `${name}-${Date.now()}`,
    ...(o.trust === 'mcp' ? { hookTrust: 'mcp' as const } : {}),
  });
}

/** Every text file a run wrote, joined (run.json, timeline, logs, DOM snapshots). */
async function runText(rec: RunRecord): Promise<string> {
  let out = '';
  for (const f of await readdir(rec.dir, { recursive: true, withFileTypes: true })) {
    if (!f.isFile() || !/\.(json|jsonl|txt|log|html|md|yaml)$/.test(f.name)) continue;
    out += await readFile(join(f.parentPath, f.name), 'utf8');
  }
  return out;
}

const hitsOf = (s: TestServer, path = '/') => s.hits.filter((h) => h.method === 'GET' && h.path === path).length;
/** A page's text once whatever it is showing has loaded (an error page replaces a failed load). */
async function textOf(page: import('playwright-core').Page): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      await page.waitForLoadState('load');
      return await page.evaluate(() => document.body?.innerText ?? '');
    } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe('the rule (pure)', () => {
  it('a URL the scenario wrote: the scheme rule always, the environment origins under agent trust; a page link: the scheme rule, blob: of its own origin', () => {
    const origins = ['http://127.0.0.1:9'];
    for (const url of ['file:///etc/hosts', 'FILE:///etc/hosts', ' file:///etc/hosts', 'data:text/html,x', 'javascript:alert(1)', 'view-source:http://127.0.0.1:9/', 'chrome://version']) {
      expect(openProblem(url), url).toMatch(/a scenario opens only http: and https: pages/);
      expect(openProblem(url, {}, { from: 'page', opener: 'http://127.0.0.1:9/' }), url).toMatch(/^the clicked link's href is not followed/);
    }
    expect(openProblem('blob:http://127.0.0.1:9/u', { origins })).toMatch(/a blob: URL/);
    expect(openProblem('http://u:p@127.0.0.1:9/')).toContain('sign-in details');
    expect(openProblem('http://localhost:10/', { origins })).toContain('not an origin of');
    expect(openProblem('http://127.0.0.1:9/x', { origins })).toBeNull();
    expect(openProblem('about:blank', { origins })).toBeNull();
    // A page links anywhere on the web; its own blob: documents are followed, another origin's are not.
    expect(openProblem('http://localhost:10/', { origins }, { from: 'page', opener: 'http://127.0.0.1:9/a' })).toBeNull();
    expect(openProblem('blob:http://127.0.0.1:9/u', { origins }, { from: 'page', opener: 'http://127.0.0.1:9/a' })).toBeNull();
    expect(openProblem('blob:http://localhost:10/u', { origins }, { from: 'page', opener: 'http://127.0.0.1:9/a' })).toMatch(/not followed: .* a blob: URL/);
    expect(openProblem('blob:null/u', {}, { from: 'page', opener: 'about:blank' })).toMatch(/not followed/);
  });

  it('prewarm leaves out a URL the take may not open', () => {
    const scenario = { scenes: [{ id: 'a', page: 'app', open: '/', steps: [{ open: 'http://localhost:10/x' }] }] } as never;
    const opts = { envPages: { app: 'http://127.0.0.1:9' }, capture: { width: 800, height: 600 }, template: (e: never) => e };
    expect(prewarmTargets(scenario, opts).map((t) => t.url)).toEqual(['http://127.0.0.1:9/', 'http://localhost:10/x']);
    expect(prewarmTargets(scenario, { ...opts, mayOpen: (u) => openProblem(u, { origins: ['http://127.0.0.1:9'] }) === null }).map((t) => t.url)).toEqual(['http://127.0.0.1:9/']);
  });

  it('the browser guard throws when it cannot arm: no browser-level session, no CDP session, Fetch refused', async () => {
    const ctx = (browser: unknown) => ({ browser: () => browser }) as never;
    await expect(armFileGuard(ctx(null))).rejects.toThrow(/could not set the browser to refuse file: pages: no browser-level session/);
    await expect(armFileGuard(ctx({ newBrowserCDPSession: () => Promise.reject(new Error('closed')) }), 'buyer')).rejects.toThrow(/of persona buyer to refuse file: pages: closed/);
    const cdp = { on: () => undefined, send: () => Promise.reject(new Error('Fetch.enable wasn\'t found')), detach: () => Promise.resolve() };
    await expect(armFileGuard(ctx({ newBrowserCDPSession: () => Promise.resolve(cdp) }))).rejects.toThrow(/Fetch\.enable/);
  });
});

describe('every navigation the runner starts (real browser)', () => {
  it('a scene open, an open step, a new_tab href and a page open refuse a non-http URL once templated and resolved, in every run; the page never loads', async () => {
    const cases: Array<[string, Omit<Scenario, 'video'>, RegExp]> = [
      // Templated, with a leading space: resolved against the environment page, it is a file: URL.
      ['scene-open', { vars: { u: ` ${fileUrl}` }, scenes: [{ id: 'a', page: 'app', open: '{{vars.u}}', steps: [{ hold: 0.1 }] }] }, /open: refused: file:\/\/.* opens a file: URL/],
      ['open-step', { vars: { u: `data:text/html;base64,${Buffer.from(`<h1>${SECRET}</h1>`).toString('base64')}` }, scenes: [{ id: 'a', page: 'app', open: '/', steps: [{ open: '{{vars.u}}' }] }] }, /open: refused: .* opens a data: URL/],
      ['new-tab-href', { vars: { u: fileUrl }, scenes: [{ id: 'a', page: 'app', open: '/', steps: [{ new_tab: { href: '{{vars.u}}', as: 'doc' } }] }] }, /new_tab: refused: file:/],
      ['page-open', { vars: { u: `view-source:${fileUrl}` }, scenes: [{ id: 'a', pages: { left: { page: 'app', open: '/' }, right: { page: 'app', open: '{{vars.u}}' } }, steps: [{ hold: 0.1 }] }] }, /page "right" open: refused: .* a view-source: URL/],
    ];
    for (const trust of ['author', 'mcp'] as const) {
      for (const [name, sc, message] of cases) {
        const rec = await run(`${name}-${trust}`, sc, { trust });
        expect(rec.status, `${name} ${trust}`).toBe('failed');
        expect(rec.error?.message, `${name} ${trust}`).toMatch(message);
        expect(await runText(rec), `${name} ${trust}`).not.toContain(SECRET);
      }
    }
  });

  it("under agent trust a URL the scenario wrote stays on the environment origins (never fetched, nor prewarmed); a person's run opens it", async () => {
    const sc: Omit<Scenario, 'video'> = { vars: { u: `${otherUrl}/` }, scenes: [{ id: 'a', page: 'app', open: '/', steps: [{ open: '{{vars.u}}' }, { hold: 0.1 }] }] };
    const before = hitsOf(other);
    const agent = await run('origin-mcp', sc, { trust: 'mcp', mode: 'capture', prewarm: true });
    expect(agent.status).toBe('failed');
    expect(agent.error?.message).toMatch(/open: refused: .* is on http:\/\/localhost:\d+, not an origin of environment test's pages \(http:\/\/127\.0\.0\.1:\d+\)/);
    expect(hitsOf(other)).toBe(before);
    const person = await run('origin-author', sc, { mode: 'capture', prewarm: true });
    expect(person.error?.message).toBeUndefined();
    // The prewarm visit and the take's.
    expect(hitsOf(other)).toBe(before + 2);
  });

  it("new_tab, the click opening no page: the clicked link gets the scheme rule only (another site followed, a blob: of its origin too, file: refused); the step's href the origin rule", async () => {
    const tab = (path: string, shows = 'Links', extra: Record<string, unknown> = {}): Omit<Scenario, 'video'> => ({
      scenes: [{ id: 'a', page: 'app', open: path, steps: [{ new_tab: { target: { css: '#l' }, as: 'doc', ...extra } }, { assert: shows }] }],
    });
    for (const trust of ['author', 'mcp'] as const) {
      const file = await run(`fallback-file-${trust}`, tab('/file-link'), { trust });
      expect(file.status).toBe('failed');
      expect(file.error?.message).toMatch(/new_tab: refused: the clicked link's href is not followed: file:\/\/.* opens a file: URL/);
      expect(await runText(file)).not.toContain(SECRET);
      const before = hitsOf(other, '/x');
      const away = await run(`fallback-other-${trust}`, tab('/other-link', 'Other site X'), { trust });
      expect(away.error?.message, trust).toBeUndefined();
      expect(hitsOf(other, '/x')).toBe(before + 1);
      const blob = await run(`fallback-blob-${trust}`, tab('/blob-link', 'Made by the page'), { trust });
      expect(blob.error?.message, trust).toBeUndefined();
      expect((await runText(blob)).includes('blob:http://127.0.0.1:')).toBe(true);
    }
    // The step's own href is the scenario's: under agent trust, on the environment's origins.
    const own = await run('fallback-href-mcp', { ...tab('/other-link', 'Other site', { href: '{{vars.u}}' }), vars: { u: `${otherUrl}/` } }, { trust: 'mcp' });
    expect(own.status).toBe('failed');
    expect(own.error?.message).toMatch(/new_tab: refused: .* not an origin of environment test's pages/);
  });
});

describe("the browser's own guard against file: (real browser)", () => {
  /** Serves a page and a cacheable script; counts the script's requests. */
  async function cacheServer(): Promise<{ url: string; scriptHits: () => number; close: () => Promise<void> }> {
    let n = 0;
    const srv = createServer((req, res) => {
      if (req.url === '/c.js') {
        n++;
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=600' });
        return res.end('window.cached = 1;');
      }
      if (req.url === '/redir') {
        res.writeHead(302, { location: fileUrl });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end('<h1>Page</h1><script src="/c.js"></script>');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      scriptHits: () => n,
      close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))),
    };
  }

  it('a direct page.goto(file:) fails on the first page, a new page and a popup, with or without the write guard; a redirect to file: fails; the HTTP cache still serves', async () => {
    const web = await cacheServer();
    try {
      for (const readOnly of [false, true]) {
        const session = await openSession({
          width: 800,
          height: 600,
          scale: 1,
          kit: kitConfigFor(undefined),
          ...(readOnly ? { writes: { policy: compileWritePolicy({ name: 'production', pages: { app: web.url }, production: true }, {}) } } : {}),
        });
        try {
          const first = session.context.pages()[0] ?? (await session.context.newPage());
          const fresh = await session.context.newPage();
          const popupP = session.context.waitForEvent('page');
          await fresh.goto(`${web.url}/`);
          await fresh.evaluate(() => void window.open('about:blank'));
          const popup = await popupP;
          for (const [label, page] of [['first', first], ['new', fresh], ['popup', popup]] as const) {
            const err = await page.goto(fileUrl, { timeout: 10_000 }).then(() => null, (e: Error) => e.message);
            expect(err, `${label} read-only=${readOnly}`).toContain('net::ERR_BLOCKED_BY_CLIENT');
            expect(await textOf(page), label).not.toContain(SECRET);
          }
          // Chromium itself refuses an http redirect to a local file.
          const redirected = await fresh.goto(`${web.url}/redir`, { timeout: 10_000 }).then(() => null, (e: Error) => e.message);
          expect(redirected).toMatch(/net::ERR_/);
          expect(await textOf(fresh)).not.toContain(SECRET);
          // Not a route: the cacheable script, fetched with the first page, comes from the HTTP cache afterwards.
          expect(web.scriptHits()).toBeGreaterThan(0);
          const hits = web.scriptHits();
          await fresh.goto(`${web.url}/?again`);
          await fresh.goto(`${web.url}/?once-more`);
          expect(await fresh.evaluate(() => (window as unknown as { cached?: number }).cached)).toBe(1);
          if (!readOnly) expect(web.scriptHits() - hits).toBe(0);
        } finally {
          await session.close();
        }
      }
    } finally {
      await web.close();
    }
  });
});
