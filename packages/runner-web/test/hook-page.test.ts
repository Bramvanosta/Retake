/**
 * The js hook tab (R-SEC-06), in a real Chromium: a guarded tab per environment page key, sharing the context's storage,
 * kept for the session. "elsewhere.test" is mapped to 127.0.0.1 by the browser's resolver, so a request the guard
 * missed would reach the recording server below: every case counts its requests.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HostRefusedError } from '@retake/core';
import type { NotificationArtefact } from '@retake/core';
import { evalHookInPage, kitConfigFor, openSession, runScenario } from '../src/index.js';
import type { BrowserSession, HookPageOptions } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, tempDir } from './helpers.js';

const RESOLVE = '--host-resolver-rules=MAP elsewhere.test 127.0.0.1';

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

let app: Server;
let other: Server;
let A = '';
let E = '';
let W = '';
/** Requests and WebSocket upgrades that reached the "elsewhere" server. */
const hits: string[] = [];
let pinged = false;
let dir = '';

const html = (body: string) => `<!doctype html><html><head><title>Hook page</title></head><body>${body}</body></html>`;

beforeAll(async () => {
  const o = await listen((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': req.url?.startsWith('/es') ? 'text/event-stream' : 'text/plain' });
    res.end('reached');
  });
  other = o.server;
  other.on('upgrade', (req, socket) => {
    hits.push(`upgrade ${req.url}`);
    socket.destroy();
  });
  E = `http://elsewhere.test:${o.port}`;
  W = `ws://elsewhere.test:${o.port}`;
  let appPort = 0;
  const a = await listen((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const js = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(body);
    };
    if (path === '/redirect') return void res.writeHead(302, { location: `${E}/login` }).end();
    if (path === '/go') return void res.writeHead(302, { location: '/go2' }).end();
    if (path === '/go2') return void res.writeHead(302, { location: `${E}/two-hop` }).end();
    if (path === '/sw.js') {
      return js(`self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
        self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));`);
    }
    if (path === '/worker.js') return js(`onmessage = (e) => fetch(e.data, { mode: 'no-cors' }).then(() => postMessage('ok'), () => postMessage('blocked'));`);
    if (path === '/api/ping') {
      pinged = true;
      res.writeHead(204);
      return void res.end();
    }
    if (path === '/api/pinged') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify({ pinged }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (path === '/storage.html') {
      return void res.end(
        html(`<p id="v"></p><button onclick="fetch('/api/ping', { method: 'POST' }).then(() => { document.getElementById('s').textContent = 'pinged'; })">Ping</button><p id="s"></p>
        <script>document.getElementById('v').textContent = 'tour-done=' + localStorage.getItem('tour-done');</script>`),
      );
    }
    if (path === '/notifier.html') {
      // Polls like the fixture's console: a web notification once the app was pinged.
      return void res.end(
        html(`<p>notifier</p><script>
          const timer = setInterval(async () => {
            const r = await fetch('/api/pinged').then((x) => x.json());
            if (!r.pinged) return;
            clearInterval(timer);
            new Notification('Ping received', { body: 'from the app', tag: 'ping' });
          }, 150);</script>`),
      );
    }
    if (path === '/third-party.html') return void res.end(html(`<p>with a pixel</p><img src="${E}/pixel.png">`));
    // 127.0.0.1 and localhost are different sites: the frame runs out of process (its own target).
    if (path === '/outer.html') return void res.end(html(`<p>outer</p><iframe src="http://localhost:${appPort}/inner.html"></iframe>`));
    if (path === '/inner.html') {
      return void res.end(html(`<p>inner</p><img src="${E}/frame-pixel.png"><script>fetch('${E}/frame-fetch', { mode: 'no-cors' }).catch(() => {})</script>`));
    }
    res.end(html('<p>app</p>'));
  });
  app = a.server;
  appPort = a.port;
  A = `http://127.0.0.1:${a.port}`;
  dir = await tempDir('rw-hook-page-');
});

afterAll(async () => {
  for (const s of [app, other]) {
    s?.closeAllConnections();
    await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
});

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe('evalHookInPage: the guarded js hook tab', () => {
  let session: BrowserSession;
  const logs: string[] = [];
  const pages = () => ({
    app: `${A}/`,
    later: `${A}/`,
    nav: `${A}/`,
    sw: `${A}/`,
    routed: `${A}/`,
    allowed: `${A}/`,
    redirect: `${A}/redirect`,
    pixel: `${A}/third-party.html`,
    framed: `${A}/outer.html`,
  });
  const opts = (allow: string[] = []): HookPageOptions => {
    const project = makeProject(dir, pages());
    if (allow.length) project.config.allow_hosts = allow;
    return { project, env: { name: 'test', pages: pages() }, log: (level, message) => logs.push(`${level} ${message}`) };
  };

  beforeAll(async () => {
    session = await openSession({ width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined), browser: { args: [RESOLVE] } });
  });
  afterAll(async () => {
    await session?.close();
  });

  it('runs in a tab of its own that shares storage with the capture tabs, kept and reused per page key', async () => {
    expect(await evalHookInPage(session, opts(), 'app', "localStorage.setItem('k', 'v'); window.mark = 7; return location.hostname")).toBe('127.0.0.1');
    const tab = session.hookPages.get('app')!;
    expect(session.hookPageId(tab)).toBe('app');
    expect(session.pages.size).toBe(0); // never a capture page
    // Reused, not reloaded: the page state of the first hook is still there.
    expect(await evalHookInPage(session, opts(), 'app', 'return window.mark')).toBe(7);
    expect(session.hookPages.get('app')).toBe(tab);
    const capture = await session.page('main');
    await capture.goto(`${A}/`);
    expect(await capture.evaluate(() => localStorage.getItem('k'))).toBe('v');
    expect([...session.pages.keys()]).toEqual(['main']);
  });

  it('a request to an unlisted host never leaves: a hook that fails on it is refused, one that catches it goes on with a warning', async () => {
    const error = await evalHookInPage(session, opts(), 'app', `await fetch('${E}/hit', { method: 'POST', mode: 'no-cors' })`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRefusedError);
    expect((error as HostRefusedError).hosts).toEqual(['elsewhere.test']);
    expect((error as Error).message).toMatch(
      /^refusing to contact elsewhere\.test \(blocked while the js hook ran\): it is not in the allow-list of project "northfield" \(allowed: localhost, 127\.0\.0\.1, ::1\); .*; the hook threw: TypeError: Failed to fetch$/,
    );
    logs.length = 0;
    expect(await evalHookInPage(session, opts(), 'app', `return fetch('${E}/hit', { mode: 'no-cors' }).then(() => 'reached', () => 'caught')`)).toBe('caught');
    expect(logs).toEqual(['warn js hook on page "app": blocked elsewhere.test (not in the allow-list); the hook went on without it']);
    await settle();
    expect(hits).toEqual([]);
  });

  it('every way out is blocked: redirect hops, beacons, EventSource, WebSocket, workers, images, frames, popups', async () => {
    const out = await evalHookInPage(
      session,
      opts(),
      'app',
      `const out = {};
      const fate = (p) => p.then((r) => 'reached ' + r.status, () => 'blocked');
      out.redirect = await fate(fetch('/redirect'));
      out.twoHops = await fate(fetch('/go'));
      out.beacon = navigator.sendBeacon('${E}/beacon', 'x');
      out.eventSource = await new Promise((r) => { const es = new EventSource('${E}/es'); es.onerror = () => { es.close(); r('error'); }; es.onopen = () => r('open'); });
      out.webSocket = await new Promise((r) => { const ws = new WebSocket('${W}/ws'); ws.onopen = () => r('open'); ws.onclose = (e) => r('closed ' + e.code); });
      out.worker = await new Promise((r) => { const w = new Worker('/worker.js'); w.onmessage = (e) => r(e.data); w.postMessage('${E}/worker'); });
      out.image = await new Promise((r) => { const i = new Image(); i.onload = () => r('load'); i.onerror = () => r('error'); i.src = '${E}/img.png'; });
      out.frame = await new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r('loaded'); f.src = '${E}/frame'; document.body.append(f); });
      out.popup = window.open('${E}/popup');
      return out;`,
    );
    expect(out).toEqual({
      redirect: 'blocked',
      twoHops: 'blocked',
      beacon: true,
      eventSource: 'error',
      webSocket: 'closed 1008',
      worker: 'blocked',
      image: 'error',
      frame: 'loaded', // the frame shows Chromium's error page
      popup: null,
    });
    // A navigation away: blocked, and the next hook on that key opens the environment page again.
    expect(await evalHookInPage(session, opts(), 'nav', `location.href = '${E}/nav'; return 1`)).toBe(1);
    await settle();
    expect(session.hookPages.get('nav')!.url()).not.toMatch(/^http/);
    expect(await evalHookInPage(session, opts(), 'nav', 'return location.pathname')).toBe('/');
    await settle();
    expect(hits).toEqual([]);
  });

  it('the guard stays while the tab stays open: deferred requests are blocked and logged', async () => {
    logs.length = 0;
    expect(await evalHookInPage(session, opts(), 'later', `setTimeout(() => fetch('${E}/later', { mode: 'no-cors' }).catch(() => {}), 200); return 1`)).toBe(1);
    await settle(700);
    expect(hits).toEqual([]);
    expect(logs).toEqual(['info js hook tab "later": blocked a request to elsewhere.test (not in the allow-list)']);
  });

  it('a page that loads a resource of an unlisted host: loaded without it, logged', async () => {
    logs.length = 0;
    expect(await evalHookInPage(session, opts(), 'pixel', 'return document.querySelector("img").naturalWidth')).toBe(0);
    expect(logs).toEqual(['info js hook page "pixel": blocked elsewhere.test while loading (not in the allow-list; add to allow_hosts what the page needs)']);
    expect(hits).toEqual([]);
  });

  it('a cross-site frame of the page (out of process) is guarded too', async () => {
    expect(await evalHookInPage(session, opts(), 'framed', 'return document.querySelector("iframe").src')).toMatch(/^http:\/\/localhost:\d+\/inner\.html$/);
    await settle();
    expect(session.hookPages.get('framed')!.frames().map((f) => new URL(f.url()).hostname)).toEqual(['127.0.0.1', 'localhost']);
    expect(hits).toEqual([]);
  });

  it('an environment page that redirects to an unlisted host is refused', async () => {
    const error = await evalHookInPage(session, opts(), 'redirect', 'return 1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRefusedError);
    expect((error as Error).message).toMatch(/^refusing to contact elsewhere\.test \(js hook page "redirect" redirected to it\):/);
    await settle();
    expect(hits).toEqual([]);
  });

  it('service workers are bypassed: a worker that controls the origin never carries a hook request', async () => {
    const capture = await session.page('sw-capture');
    await capture.goto(`${A}/`);
    await capture.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));
    await capture.reload();
    expect(await capture.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const r = await evalHookInPage(
      session,
      opts(),
      'sw',
      `return [!!navigator.serviceWorker.controller, await fetch('${E}/via-sw', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')]`,
    );
    expect(r).toEqual([false, 'blocked']);
    await settle();
    expect(hits).toEqual([]);
  });

  it('composes with another interception of the context (a context route)', async () => {
    let routed = 0;
    const handler = (route: import('playwright-core').Route) => {
      routed++;
      return route.fallback();
    };
    await session.context.route('**/*', handler);
    try {
      const r = await evalHookInPage(session, opts(), 'routed', `return [await fetch('/x').then((x) => x.status), await fetch('${E}/routed', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')]`);
      expect(r).toEqual([200, 'blocked']);
      expect(routed).toBeGreaterThan(0);
    } finally {
      await session.context.unroute('**/*', handler);
    }
    await settle();
    expect(hits).toEqual([]);
  });

  it('control: a host in allow_hosts is reached (the resolver mapping works, the guard is what blocks)', async () => {
    const r = await evalHookInPage(session, opts(['elsewhere.test']), 'allowed', `return fetch('${E}/allowed', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`);
    expect(r).toBe('reached');
    expect(hits).toEqual(['/allowed']);
  });

  it('logs name hosts, never URLs or code', () => {
    const text = logs.join('\n');
    expect(text).not.toContain('://');
    expect(text).not.toContain('fetch(');
  });
});

describe('js setup hooks in a run', () => {
  it('prepare the capture tab\'s storage, and a hook tab left open keeps working: its notification is captured', async () => {
    pinged = false;
    const project = makeProject(dir, { app: A, notifier: `${A}/notifier.html` });
    const rec = await runScenario({
      project,
      scenario: makeScenario('hook-tab', {
        pacing: FAST,
        setup: [
          { js: { code: "localStorage.setItem('tour-done', '1')", page: 'app' } },
          { name: 'open-notifier', js: { code: 'return document.title', page: 'notifier' } },
        ],
        scenes: [
          {
            id: 'main',
            page: 'app',
            open: '/storage.html',
            steps: [{ assert: { text: 'tour-done=1' } }, { click: 'Ping' }, { wait_for: { text: 'pinged' } }, { wait: 1 }],
          },
        ],
      }),
      mode: 'dry',
      hooks: 'run',
      runId: `hook-tab-${Date.now()}`,
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(rec.hooks.setup).toBe('ok');
    const tl = await readTimeline(rec.timeline!);
    const n = tl.artefacts?.filter((a): a is NotificationArtefact => a.kind === 'notification') ?? [];
    expect(n).toMatchObject([{ name: 'ping', title: 'Ping received', page: 'notifier', scene: 'main' }]);
    expect(tl.events.filter((e) => e.action === 'notification')).toMatchObject([{ scene: 'main', page: 'notifier', data: { name: 'ping' } }]);
    // The capture never showed the hook tab.
    expect(tl.pages.map((p) => p.id)).toEqual(['app']);
  });
});
