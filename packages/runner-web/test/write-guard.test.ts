/**
 * The read-only guard (L1.7, R-ENV-03), in a real Chromium against a recording server: every write that reaches the
 * server is listed in `hits`, so a write the guard missed shows. The app is on 127.0.0.1 (the guarded host); localhost
 * is another site on the same server (a frame from there runs out of process; guarded too on a production environment,
 * unguarded on a read-only one that is not). One row per hole of the guard: fetch / XHR / beacon / worker / cross-site
 * frame / popup / form POST (main frame, iframe, new window), fetchLater and shared workers, writes sent while a page
 * unloads, service workers, the automated sign-in tab, other persona browsers, js hook tabs, WebSockets, redirects;
 * mocks, allow entries and GraphQL; and in a run: a stopped form submit never stalls the click, writes are recorded, a
 * read-write run stops writes to the hosts of a read-only environment only.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WriteRefusedError, compileWritePolicy, PERSON_POLICY } from '@retake/core';
import type { LoadedProject, ResolvedEnvironment, RunProgress, Scenario, WriteMockSpec } from '@retake/core';
import { closePage, evalHookInPage, kitConfigFor, openSession, runScenario } from '../src/index.js';
import type { BrowserSession, GuardedWrite } from '../src/index.js';
import { FAST, makeScenario } from '@retake/test-support/capture';
import { makeProject, readTimeline, tempDir, testHookRunner } from './helpers.js';

let server: Server;
let A = ''; // the app: guarded
let L = ''; // the same server as another site (localhost): unguarded
/** Writes (non-GET requests) that reached the server: "METHOD host path". */
const hits: string[] = [];
let dir = '';

const html = (body: string) => `<!doctype html><html><head><title>Guard</title></head><body>${body}</body></html>`;

const UNLOAD = (path: string) =>
  html(`<h1>Leaving</h1><script>
  addEventListener('pagehide', () => {
    navigator.sendBeacon('${path}/beacon-pagehide', 'b');
    fetch('${path}/keepalive-pagehide', { method: 'POST', body: 'k', keepalive: true }).catch(() => {});
  });
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    navigator.sendBeacon('${path}/beacon-hidden', 'h');
    fetch('${path}/keepalive-hidden', { method: 'POST', body: 'k', keepalive: true }).catch(() => {});
  });
</script>`);

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      const host = (req.headers.host ?? '').split(':')[0];
      const origin = req.headers.origin;
      const cors: Record<string, string> = origin
        ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE', 'access-control-allow-headers': '*' }
        : {};
      if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
      if (req.method !== 'GET' && req.method !== 'HEAD') hits.push(`${req.method} ${host} ${path}`);
      const page = (b: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html(b));
      const js = (b: string) => res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(b);
      if (path === '/redirect307') return void res.writeHead(307, { ...cors, location: `${A}/api/after-307` }).end();
      if (path.startsWith('/api/') || path === '/graphql') {
        return void res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, method: req.method, path }));
      }
      if (path === '/form.html') {
        return page(`<h1>Form</h1>
          <form id="main" method="post" action="/api/form"><input name="a" value="1"><button id="send">Send request</button></form>
          <form id="blank" method="post" action="/api/form-blank" target="_blank"><input name="a" value="1"></form>
          <iframe name="inner" src="/inner.html"></iframe>
          <form id="framed" method="post" action="/api/form-frame" target="inner"><input name="a" value="1"></form>
          <p><a id="doc" href="/terms.html" target="_blank">Open the terms</a></p>`);
      }
      if (path === '/inner.html') return page('<p id="inner">inner frame</p>');
      if (path === '/terms.html') return page('<h1>Terms</h1><p>Prices include roasting.</p>');
      if (path === '/popup.html') return page(`<p>popup</p><script>fetch('/api/popup', { method: 'DELETE' }).catch(() => {})</script>`);
      if (path === '/unload.html') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(UNLOAD('/api'));
      if (path === '/worker.js') return js(`onmessage = (e) => fetch(e.data, { method: 'POST', body: 'w' }).then((r) => postMessage('reached ' + r.status), () => postMessage('blocked'));`);
      if (path === '/shared.js') {
        return js(
          `onconnect = (e) => { const port = e.ports[0]; port.onmessage = (m) => fetch(m.data, { method: 'POST', body: 's' }).then((r) => port.postMessage('reached ' + r.status), () => port.postMessage('blocked')); port.start(); };`,
        );
      }
      // A page that uses fetchLater and a shared worker when the browser has them (as apps do: feature-detected).
      if (path === '/deferred.html') {
        return page(`<p id="out">-</p><script>
          const out = [typeof fetchLater, typeof SharedWorker];
          if (typeof fetchLater === 'function') fetchLater('/api/fetch-later', { method: 'POST', body: 'l' });
          if (typeof fetchLater === 'function') fetchLater('/api/fetch-later-timer', { method: 'POST', body: 't', activateAfter: 0 });
          if (typeof SharedWorker === 'function') { const w = new SharedWorker('/shared.js'); w.port.start(); w.port.postMessage('/api/from-shared-worker'); }
          document.getElementById('out').textContent = out.join(' ');
        </script>`);
      }
      // A service worker that passes POSTs through (Workbox NetworkOnly style): its fetch is its own, without a page.
      if (path === '/sw-pass.js') {
        return js(`self.addEventListener('install', () => self.skipWaiting());
          self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
          self.addEventListener('fetch', (e) => { if (e.request.method === 'POST') e.respondWith(fetch(e.request)); });`);
      }
      if (path === '/sign-in') return page('<h1>Sign in</h1>');
      if (path === '/sw.js') {
        return js(`self.addEventListener('install', () => self.skipWaiting());
          self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
          self.addEventListener('message', (e) => e.waitUntil(fetch('/api/sw-background', { method: 'POST', body: 'bg' }).then((r) => e.source.postMessage('bg ' + r.status), () => e.source.postMessage('bg blocked'))));
          self.addEventListener('fetch', (e) => { if (new URL(e.request.url).pathname === '/sw-proxied') e.respondWith(fetch('/api/from-sw', { method: 'POST', body: 's' })); });`);
      }
      // A cross-site frame (localhost ≠ 127.0.0.1: out of process) that writes to the app.
      if (path === '/xframe.html') return page(`<p>widget</p><script>fetch('${A}/api/from-frame', { method: 'POST', body: 'f', credentials: 'include' }).catch(() => {})</script>`);
      if (path === '/framed.html') return page(`<p>framed</p><iframe src="${L}/xframe.html"></iframe>`);
      return page('<h1>App</h1><p id="out"></p>');
    });
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  A = `http://127.0.0.1:${port}`;
  L = `http://localhost:${port}`;
  dir = await tempDir('rw-guard-');
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
});

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

function env(over: Partial<ResolvedEnvironment> = {}): ResolvedEnvironment {
  return { name: 'production', pages: { app: A }, production: true, ...over };
}

/** A guarded session; `seen` collects what the guard reports. */
async function guarded(o: { env?: ResolvedEnvironment; mocks?: WriteMockSpec[]; realms?: string[] } = {}): Promise<{ session: BrowserSession; seen: GuardedWrite[]; sockets: string[] }> {
  const seen: GuardedWrite[] = [];
  const sockets: string[] = [];
  const session = await openSession({
    policy: PERSON_POLICY,
    width: 800,
    height: 600,
    scale: 1,
    kit: kitConfigFor(undefined),
    writes: { policy: compileWritePolicy(o.env ?? env(), { scenarioMocks: o.mocks }), onWrite: (w) => seen.push(w), onWebSocket: (h) => sockets.push(h) },
    ...(o.realms ? { realms: o.realms.map((name) => ({ name })), realmOf: (id: string) => (o.realms!.includes(id) ? id : '') } : {}),
  });
  return { session, seen, sockets };
}

const brief = (seen: GuardedWrite[]) => seen.map((w) => `${w.outcome} ${w.via} ${w.label}`);

describe('the context guard: every way a page writes (R-ENV-03)', () => {
  let s: Awaited<ReturnType<typeof guarded>>;
  beforeAll(async () => {
    s = await guarded();
  });
  afterAll(async () => {
    await s?.session.close();
  });
  beforeEach(() => {
    s.seen.length = 0;
  });

  it('fetch, XHR, a dedicated worker, a popup, a cross-site frame: stopped before the server; reads pass', async () => {
    const page = await s.session.page('app');
    await page.goto(`${A}/`);
    const out = await page.evaluate(async (L) => {
      const fate = (p: Promise<Response>) =>
        p.then(
          (r) => `reached ${r.status}`,
          () => 'blocked',
        );
      const xhr = () =>
        new Promise<string>((resolve) => {
          const x = new XMLHttpRequest();
          x.open('PUT', '/api/xhr');
          x.onload = () => resolve(`reached ${x.status}`);
          x.onerror = () => resolve('blocked');
          x.send('x');
        });
      return {
        get: await fate(fetch('/api/read')),
        head: await fate(fetch('/api/read', { method: 'HEAD' })),
        post: await fate(fetch('/api/quotes', { method: 'POST', body: JSON.stringify({ q: 1 }), headers: { 'content-type': 'application/json' } })),
        patch: await fate(fetch('/api/quotes/7', { method: 'PATCH', body: '{}' })),
        xhr: await xhr(),
        worker: await new Promise((resolve) => {
          const w = new Worker('/worker.js');
          w.onmessage = (e) => resolve(e.data);
          w.postMessage('/api/worker');
        }),
        // Production: a write to any other host is stopped too (fail closed).
        third: await fate(fetch(`${L}/api/third`, { method: 'POST', body: 't' })),
      };
    }, L);
    expect(out).toEqual({ get: 'reached 200', head: 'reached 200', post: 'blocked', patch: 'blocked', xhr: 'blocked', worker: 'blocked', third: 'blocked' });
    // A popup's DELETE (its first requests have no resolvable frame: guarded like a capture page's).
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => void window.open('/popup.html'))]);
    await popup.waitForLoadState('load');
    // A cross-site frame (its own process) posting to the app.
    await page.goto(`${A}/framed.html`);
    await settle(600);
    expect(hits).toEqual([]);
    expect(brief(s.seen).sort()).toEqual(
      [
        'blocked page POST app:/api/quotes',
        'blocked page PATCH app:/api/quotes/7',
        'blocked page PUT app:/api/xhr',
        'blocked page POST app:/api/worker',
        `blocked page POST localhost:${new URL(L).port}/api/third`,
        'blocked page DELETE app:/api/popup',
        'blocked page POST app:/api/from-frame',
      ].sort(),
    );
    await closePage(popup);
  });

  it('a form POST is answered 204: the page stays (no error page) — in the main frame, an iframe, a new window', async () => {
    const page = await s.session.page('app');
    await page.goto(`${A}/form.html`);
    await page.evaluate(() => (document.getElementById('main') as HTMLFormElement).submit());
    await page.evaluate(() => (document.getElementById('framed') as HTMLFormElement).submit());
    // The new window, if Chromium opens one before the answer (it stays blank: nothing commits).
    const popup = page.waitForEvent('popup', { timeout: 1000 }).catch(() => null);
    await page.evaluate(() => (document.getElementById('blank') as HTMLFormElement).submit());
    const win = await popup;
    await settle(600);
    expect(page.url()).toBe(`${A}/form.html`);
    expect(await page.evaluate(() => document.querySelector('h1')?.textContent)).toBe('Form');
    // The iframe still shows its page (not chrome-error://).
    const inner = page.frames().find((f) => f !== page.mainFrame());
    expect(inner?.url()).toBe(`${A}/inner.html`);
    expect(hits).toEqual([]);
    expect(brief(s.seen).sort()).toEqual(['blocked page POST app:/api/form', 'blocked page POST app:/api/form-blank', 'blocked page POST app:/api/form-frame']);
    if (win) await closePage(win);
  });

  it('fetchLater and SharedWorker do not exist in a guarded page — in a frame or a popup either (the route never sees their requests)', async () => {
    const page = await s.session.page('app');
    await page.goto(`${A}/deferred.html`);
    expect(await page.textContent('#out')).toBe('undefined undefined');
    expect(
      await page.evaluate(() => {
        const f = document.createElement('iframe');
        document.body.append(f);
        const w = window.open('about:blank');
        const r = [
          typeof (f.contentWindow as unknown as Record<string, unknown>).fetchLater,
          typeof (f.contentWindow as unknown as Record<string, unknown>).SharedWorker,
          typeof (w as unknown as Record<string, unknown>)?.SharedWorker,
        ];
        w?.close();
        return r;
      }),
    ).toEqual(['undefined', 'undefined', 'undefined']);
    // What the page would have deferred is never sent: not when it navigates, not when its tab closes.
    await page.goto(`${A}/`);
    const tab = await s.session.newPage('deferred', { like: page });
    await tab.goto(`${A}/deferred.html`);
    await closePage(tab);
    await settle(600);
    expect(hits).toEqual([]);
  });

  it('a WebSocket to a guarded host is let through and reported (its messages are not checked)', async () => {
    const page = await s.session.page('app');
    await page.goto(`${A}/`);
    await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const ws = new WebSocket(url);
          ws.onclose = () => resolve(null);
          ws.onerror = () => resolve(null);
        }),
      A.replace('http', 'ws') + '/live',
    );
    await settle(200);
    expect(s.sockets).toEqual(['127.0.0.1']);
  });
});

describe('mocks, allow entries, GraphQL (R-ENV-03)', () => {
  it('a mock answers (status, JSON, delay), an allow entry lets through, GraphQL queries read, mutations and persisted queries write', async () => {
    const s = await guarded({
      env: env({ read_only: { allow: ['POST app:/api/session/refresh', { request: 'POST app:/graphql', operation: 'SearchProducts' }], mocks: [{ request: 'POST /api/track', status: 204 }] } }),
      mocks: [{ request: 'POST app:/api/quotes', status: 201, json: { id: 9001, supplier: 'Northfield Roasters' }, delay_ms: 300 }],
    });
    try {
      const page = await s.session.page('app');
      await page.goto(`${A}/`);
      const out = await page.evaluate(async () => {
        const post = (path: string, body: unknown) => fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
        const fate = (p: Promise<Response>) =>
          p.then(
            async (r) => `${r.status} ${r.status === 204 ? '' : await r.text()}`.trim(),
            () => 'blocked',
          );
        const t = performance.now();
        const quote = await fate(post('/api/quotes', { bag: '1 kg' }));
        const quoteMs = performance.now() - t;
        return {
          quote,
          quoteMs,
          track: await fate(post('/api/track', { e: 'view' })),
          refresh: await fate(post('/api/session/refresh', {})),
          query: await fate(post('/graphql', { query: 'query Products { products { id } }' })),
          mutation: await fate(post('/graphql', { query: 'mutation SaveQuote { save { id } }', operationName: 'SaveQuote' })),
          persistedAllowed: await fate(post('/graphql', { operationName: 'SearchProducts', extensions: { persistedQuery: { sha256Hash: 'abc' } } })),
          persisted: await fate(post('/graphql', { operationName: 'DeleteAll', extensions: { persistedQuery: { sha256Hash: 'def' } } })),
        };
      });
      expect(out).toMatchObject({
        quote: '201 {"id":9001,"supplier":"Northfield Roasters"}',
        track: '204',
        refresh: '200 {"ok":true,"method":"POST","path":"/api/session/refresh"}',
        query: '200 {"ok":true,"method":"POST","path":"/graphql"}',
        mutation: 'blocked',
        persistedAllowed: '200 {"ok":true,"method":"POST","path":"/graphql"}',
        persisted: 'blocked',
      });
      expect(out.quoteMs).toBeGreaterThanOrEqual(280);
      await settle(200);
      expect(hits).toEqual(['POST 127.0.0.1 /api/session/refresh', 'POST 127.0.0.1 /graphql', 'POST 127.0.0.1 /graphql']);
      expect(s.seen.map((w) => [w.outcome, w.label, w.rule ?? null, w.status ?? null, w.operation ?? null])).toEqual([
        ['mocked', 'POST app:/api/quotes', 'POST app:/api/quotes', 201, null],
        ['mocked', 'POST app:/api/track', 'POST /api/track', 204, null],
        ['allowed', 'POST app:/api/session/refresh', 'POST app:/api/session/refresh', null, null],
        ['blocked', 'POST app:/graphql', null, null, 'SaveQuote'],
        ['allowed', 'POST app:/graphql', 'POST app:/graphql', null, 'SearchProducts'],
        ['blocked', 'POST app:/graphql', null, null, 'DeleteAll'],
      ]);
    } finally {
      await s.session.close();
    }
  });

  it('a read-only environment that is not production: a write to another host passes, recorded `passed`', async () => {
    const s = await guarded({ env: env({ name: 'staging', production: false, access: 'read-only' }) });
    try {
      const page = await s.session.page('app');
      await page.goto(`${A}/`);
      const out = await page.evaluate(
        (L) =>
          fetch(`${L}/api/third`, { method: 'POST', body: 't' }).then(
            (r) => `reached ${r.status}`,
            () => 'blocked',
          ),
        L,
      );
      expect(out).toBe('reached 200');
      await settle(200);
      expect(hits).toEqual(['POST localhost /api/third']);
      expect(brief(s.seen)).toEqual([`passed page POST localhost:${new URL(L).port}/api/third`]);
    } finally {
      await s.session.close();
    }
  });

  it('a POST to an unguarded host that redirects (307) to a guarded one: its first hop is recorded `passed` (later hops are not seen — a README limit)', async () => {
    const s = await guarded({ env: env({ name: 'staging', production: false, access: 'read-only' }) });
    try {
      const page = await s.session.page('app');
      await page.goto(`${A}/`);
      await page.evaluate((L) => fetch(`${L}/redirect307`, { method: 'POST', body: 'r' }).catch(() => null), L);
      await settle(300);
      expect(brief(s.seen)).toEqual([`passed page POST localhost:${new URL(L).port}/redirect307`]);
    } finally {
      await s.session.close();
    }
  });
});

describe('writes sent while a page unloads never leak (D3)', () => {
  it('sendBeacon and keepalive fetches in pagehide / visibilitychange: on a navigation, a tab closed by the runner, the session closed — 3 times each', async () => {
    // The guard turns them into ordinary fetches: one the unloading document cancels before it reaches the network is
    // never seen at all (nothing leaks either) — some round may see none, the three rounds together see some.
    let seen = 0;
    for (let round = 0; round < 3; round++) {
      const s = await guarded();
      const page = await s.session.page('app');
      // A navigation away.
      await page.goto(`${A}/unload.html`);
      await page.goto(`${A}/`);
      // A tab the runner closes (switch_page close_current, a download's tab…).
      const tab = await s.session.newPage('tab', { like: page });
      await tab.goto(`${A}/unload.html`);
      await closePage(tab);
      // The session closing with a page still on it.
      await page.goto(`${A}/unload.html`);
      await s.session.close();
      await settle(500);
      expect(hits, `round ${round}`).toEqual([]);
      expect(s.seen.every((w) => w.outcome === 'blocked')).toBe(true);
      seen += s.seen.length;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('service workers (D10): what a service worker sends meets the guard', () => {
  it('a write a service worker sends to answer the page, or in the background, is stopped', async () => {
    const s = await guarded();
    try {
      const page = await s.session.page('app');
      await page.goto(`${A}/`);
      const out = await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 50));
        const proxied = await fetch('/sw-proxied').then(
          (r) => `reached ${r.status}`,
          () => 'blocked',
        );
        const background = await new Promise((resolve) => {
          navigator.serviceWorker.onmessage = (e) => resolve(e.data);
          navigator.serviceWorker.controller!.postMessage('go');
          setTimeout(() => resolve('timeout'), 3000);
        });
        return { controlled: !!navigator.serviceWorker.controller, proxied, background };
      });
      await settle(300);
      expect(out).toEqual({ controlled: true, proxied: 'blocked', background: 'bg blocked' });
      expect(hits).toEqual([]);
      expect(brief(s.seen).sort()).toEqual(['blocked page POST app:/api/from-sw', 'blocked page POST app:/api/sw-background']);
    } finally {
      await s.session.close();
    }
  });
});

describe('the automated sign-in tab: exempt on its sign-in page only, and it bypasses service workers', () => {
  const onSignIn = (url: string) => {
    try {
      return new URL(url).pathname === '/sign-in';
    } catch {
      return false;
    }
  };

  it('its writes from the sign-in page pass (exempt); from the page it lands on they are guarded (via sign-in)', async () => {
    const s = await guarded();
    try {
      const page = await (await s.session.contextOf('')).newPage();
      await s.session.markSignIn(page, onSignIn);
      await page.goto(`${A}/sign-in`);
      const post = (path: string) =>
        page.evaluate(
          (p) =>
            fetch(p, { method: 'POST', body: '{}' }).then(
              (r) => `reached ${r.status}`,
              () => 'blocked',
            ),
          path,
        );
      expect(await post('/api/auth/login')).toBe('reached 200');
      await page.goto(`${A}/`);
      expect(await post('/api/onboarding/complete')).toBe('blocked');
      await closePage(page);
      await settle(200);
      expect(hits).toEqual(['POST 127.0.0.1 /api/auth/login']);
      expect(brief(s.seen)).toEqual(['exempt sign-in POST app:/api/auth/login', 'blocked sign-in POST app:/api/onboarding/complete']);
    } finally {
      await s.session.close();
    }
  });

  it("a service worker that passes POSTs through: the sign-in tab bypasses it (its sign-in POST is exempt); a capture page's goes through it and is stopped", async () => {
    const s = await guarded();
    const viaWorker = (p: import('playwright-core').Page) =>
      p.evaluate(async () => {
        await navigator.serviceWorker.register('/sw-pass.js');
        await navigator.serviceWorker.ready;
        for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 50));
        return fetch('/api/auth/login', { method: 'POST', body: '{}' }).then(
          (r) => `reached ${r.status}`,
          () => 'blocked',
        );
      });
    try {
      const signIn = await (await s.session.contextOf('')).newPage();
      await s.session.markSignIn(signIn, onSignIn);
      await signIn.goto(`${A}/sign-in`);
      expect(await viaWorker(signIn)).toBe('reached 200');
      await closePage(signIn);
      const capture = await s.session.page('app');
      await capture.goto(`${A}/sign-in`);
      expect(await viaWorker(capture)).toBe('blocked');
      await settle(200);
      expect(hits).toEqual(['POST 127.0.0.1 /api/auth/login']);
      expect(brief(s.seen)).toEqual(['exempt sign-in POST app:/api/auth/login', 'blocked page POST app:/api/auth/login']);
    } finally {
      await s.session.close();
    }
  });
});

describe('every browser of a read-only run is guarded', () => {
  it('two persona browsers and the default browser opened later', async () => {
    const s = await guarded({ realms: ['supplier', 'buyer'] });
    try {
      for (const id of ['supplier', 'buyer', 'later']) {
        const page = await s.session.page(id);
        await page.goto(`${A}/`);
        expect(
          await page.evaluate(() =>
            fetch('/api/write', { method: 'POST' }).then(
              () => 'reached',
              () => 'blocked',
            ),
          ),
          id,
        ).toBe('blocked');
      }
      expect(s.session.contexts).toHaveLength(3);
      await settle(200);
      expect(hits).toEqual([]);
      expect(brief(s.seen)).toEqual(['blocked page POST app:/api/write', 'blocked page POST app:/api/write', 'blocked page POST app:/api/write']);
    } finally {
      await s.session.close();
    }
  });
});

describe('js hook tabs on a read-only run: their own guard, never mocked', () => {
  it('the context guard leaves them to their tab; a hook that fails on a stopped write is refused, one that catches it goes on', async () => {
    const s = await guarded({ mocks: [{ request: 'POST app:/api/reset', status: 200, json: { ok: true } }] });
    const logs: string[] = [];
    const project = makeProject(dir, { app: A });
    const opts = {
      project,
      env: { name: 'production', pages: { app: A } },
      log: (level: string, message: string) => logs.push(`${level} ${message}`),
      writes: { policy: compileWritePolicy(env(), { scenarioMocks: [{ request: 'POST app:/api/reset', status: 200, json: { ok: true } }] }), onWrite: (w: GuardedWrite) => s.seen.push(w) },
    };
    try {
      // A mock never answers a hook: the write is stopped and the hook that needed it is refused.
      const error = await evalHookInPage(s.session, opts, 'app', `const r = await fetch('/api/reset', { method: 'POST' }); return r.status`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WriteRefusedError);
      expect((error as Error).message).toBe('a js hook wrote on read-only environment production (POST app:/api/reset): stopped in its tab; the hook threw: TypeError: Failed to fetch');
      expect(await evalHookInPage(s.session, opts, 'app', `return fetch('/api/reset', { method: 'POST' }).then(() => 'reached', () => 'caught')`)).toBe('caught');
      expect(logs).toContain('warn js hook on page "app": stopped POST app:/api/reset (environment production is read-only); the hook went on without it');
      // Reads pass.
      expect(await evalHookInPage(s.session, opts, 'app', `return (await fetch('/api/health')).status`)).toBe(200);
      await settle(200);
      expect(hits).toEqual([]);
      // Reported once per write by the tab (via hook), never by the context guard.
      expect(brief(s.seen)).toEqual(['blocked hook POST app:/api/reset', 'blocked hook POST app:/api/reset']);
    } finally {
      await s.session.close();
    }
  });
});

describe("js hook tabs never have fetchLater nor SharedWorker (their requests would escape the tab's own guard)", () => {
  it('on a read-write run too (the allow-list guard)', async () => {
    const session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined) });
    const opts = { project: makeProject(dir, { app: A }), env: { name: 'test', pages: { app: A } }, log: () => undefined };
    try {
      expect(await evalHookInPage(session, opts, 'app', 'return [typeof fetchLater, typeof SharedWorker]')).toEqual(['undefined', 'undefined']);
      await settle(200);
      expect(hits).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe('a read-only run (R-ENV-03)', () => {
  function project(): LoadedProject {
    const p = makeProject(dir, { app: A });
    p.config.environment_settings = { test: { production: true } };
    return p;
  }

  it('a stopped form submit never stalls the click (no 15 s wait, no warning); a mocked fetch shows; a document tab is fetched; writes are in the timeline', async () => {
    const events: RunProgress[] = [];
    const scenario: Omit<Scenario, 'video'> = {
      pacing: FAST,
      mocks: [{ request: 'POST app:/api/quotes', status: 201, json: { id: 9001 } }],
      scenes: [
        {
          id: 'request',
          page: 'app',
          open: '/form.html',
          steps: [
            { click: 'Send request' },
            { eval: `const r = await fetch('/api/quotes', { method: 'POST', body: '{}' }); document.querySelector('h1').textContent = 'Quote ' + (await r.json()).id;` },
            { assert: { text: 'Quote 9001' } },
            // A document a tab opens is fetched with the session (context.request: a GET, never routed) — and the tab is
            // closed through about:blank.
            { download: { click: { css: '#doc' }, as: 'terms' } },
          ],
        },
      ],
    };
    const rec = await runScenario({
      policy: PERSON_POLICY,
      project: project(),
      scenario: makeScenario('ro-form', scenario),
      mode: 'capture',
      env: 'test',
      runId: `ro-form-${Date.now()}`,
      onProgress: (e) => events.push(e),
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    const click = tl.events.find((e) => e.action === 'click')!;
    expect(click.t_end - click.t_start).toBeLessThan(2);
    expect(tl.warnings.filter((w) => w.includes('did not commit'))).toEqual([]);
    const stopped = tl.warnings.filter((w) => w.startsWith('a write was stopped'));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatch(
      /^a write was stopped \(POST app:\/api\/form, step request\.0, \d+\.\d s\): environment test is read-only — the app may show an error; answer it with a mock \(`mocks:` of the scenario\)$/,
    );
    expect(tl.environment).toMatchObject({ name: 'test', production: true, access: 'read-only' });
    const writes = tl.environment!.writes!;
    expect(writes.map((w) => [w.method, w.outcome, w.via, w.status ?? null, typeof w.t])).toEqual([
      ['POST', 'blocked', 'page', null, 'number'],
      ['POST', 'mocked', 'page', 201, 'number'],
    ]);
    expect(writes[0].url).toBe(`${A}/api/form`);
    expect(tl.artefacts?.find((a) => a.name === 'terms')).toMatchObject({ kind: 'document', via: 'tab' });
    expect(writes[0].t!).toBeGreaterThan(0);
    expect(writes[1].t!).toBeGreaterThan(writes[0].t!);
    expect(hits).toEqual([]);
    expect(events.some((e) => e.type === 'log' && e.message === 'read-only run: writes to every host are stopped (1 mock)')).toBe(true);
  });

  it('a js setup hook whose write is stopped is refused (read-only), never mocked; nothing reached the server', async () => {
    const rec = await runScenario({
      policy: PERSON_POLICY,
      project: project(),
      scenario: makeScenario('ro-hook', {
        pacing: FAST,
        mocks: [{ request: 'POST app:/api/reset', status: 200 }],
        setup: [{ name: 'reset', js: { code: `const r = await fetch('/api/reset', { method: 'POST' }); if (!r.ok) throw new Error('no');` } }],
        scenes: [{ id: 'a', page: 'app', open: '/', steps: [{ wait: 0.1 }] }],
      }),
      mode: 'dry',
      hooks: 'run',
      env: 'test',
      runId: `ro-hook-${Date.now()}`,
      hookRunner: testHookRunner(),
    });
    expect(rec.status).toBe('failed');
    expect(rec.hooks.setup).toBe('failed');
    expect(rec.error?.message).toContain('refusing a hook that writes (POST app:/api/reset, stopped in its tab) on read-only environment test');
    expect(rec.error?.message).toContain('the hook threw: TypeError: Failed to fetch');
    await settle(200);
    expect(hits).toEqual([]);
  });

  it('a read-write run stops writes to the hosts of a read-only environment (production) only: from its pages and its js hooks', async () => {
    // The run is on `test` (localhost); environment `production` is the same server as 127.0.0.1.
    const p = makeProject(dir, { app: L });
    p.config.environments.production = { app: A };
    p.config.environment_settings = { production: { production: true } };
    const events: RunProgress[] = [];
    const rec = await runScenario({
      policy: PERSON_POLICY,
      project: p,
      scenario: makeScenario('rw-cross', {
        pacing: FAST,
        setup: [{ name: 'prod-reset', optional: true, js: { code: `await fetch('${A}/api/hook-reset', { method: 'POST', credentials: 'omit' }); return 'reset'` } }],
        scenes: [
          {
            id: 'a',
            page: 'app',
            open: '/',
            steps: [
              {
                eval: `const out = await Promise.all([fetch('/api/own', { method: 'POST', body: '{}' }), fetch('${A}/api/prod', { method: 'POST', body: '{}', credentials: 'omit' })].map((p) => p.then((r) => 'reached ' + r.status, () => 'blocked')));
                  if (JSON.stringify(out) !== '["reached 200","blocked"]') throw new Error(JSON.stringify(out));`,
              },
            ],
          },
        ],
      }),
      mode: 'dry',
      hooks: 'run',
      env: 'test',
      runId: `rw-cross-${Date.now()}`,
      hookRunner: testHookRunner(),
      onProgress: (e) => events.push(e),
    });
    expect(rec.status).toBe('failed');
    // The js hook's write to production's host was refused (never tolerated by `optional`).
    expect(rec.error?.message).toContain(
      `refusing a hook that writes (POST ${new URL(A).host}/api/hook-reset, stopped in its tab) to a host of environment production — this run is on environment test`,
    );
    expect(hits).toEqual([]);
    // Without the hook: the page's write to its own host passes, the one to production's host is stopped.
    hits.length = 0;
    const rec2 = await runScenario({
      policy: PERSON_POLICY,
      project: p,
      scenario: makeScenario('rw-cross2', {
        pacing: FAST,
        scenes: [
          {
            id: 'a',
            page: 'app',
            open: '/',
            steps: [
              {
                eval: `const out = await Promise.all([fetch('/api/own', { method: 'POST', body: '{}' }), fetch('${A}/api/prod', { method: 'POST', body: '{}', credentials: 'omit' })].map((p) => p.then((r) => 'reached ' + r.status, () => 'blocked')));
                  if (JSON.stringify(out) !== '["reached 200","blocked"]') throw new Error(JSON.stringify(out));`,
              },
            ],
          },
        ],
      }),
      mode: 'dry',
      env: 'test',
      runId: `rw-cross2-${Date.now()}`,
      onProgress: (e) => events.push(e),
    });
    expect(rec2.error?.message).toBeUndefined();
    expect(rec2.status).toBe('succeeded');
    expect(hits).toEqual(['POST localhost /api/own']);
    const tl = await readTimeline(rec2.timeline!);
    expect(tl.environment?.access).toBe('read-write');
    expect(tl.environment?.writes?.map((w) => [w.method, w.url, w.outcome, w.via, w.protected_by])).toEqual([['POST', `${A}/api/prod`, 'blocked', 'page', 'production']]);
    expect(tl.warnings.filter((w) => w.startsWith('a write was stopped'))).toEqual([
      expect.stringMatching(
        /^a write was stopped \(POST 127\.0\.0\.1:\d+\/api\/prod, step a\.0, [\d.]+ s\): 127\.0\.0\.1 is a host of read-only environment production, and this run is on environment test/,
      ),
    ]);
    expect(events.some((e) => e.type === 'log' && e.message === 'writes to the hosts of read-only environment production (127.0.0.1) are stopped')).toBe(true);
  });

  it('a read-write run arms nothing: the same writes reach the server, no environment writes', async () => {
    const p = makeProject(dir, { app: A });
    const rec = await runScenario({
      policy: PERSON_POLICY,
      project: p,
      scenario: makeScenario('rw-form', { pacing: FAST, scenes: [{ id: 'a', page: 'app', open: '/', steps: [{ eval: `await fetch('/api/quotes', { method: 'POST', body: '{}' })` }] }] }),
      mode: 'dry',
      env: 'test',
      runId: `rw-form-${Date.now()}`,
    });
    expect(rec.status).toBe('succeeded');
    expect(hits).toEqual(['POST 127.0.0.1 /api/quotes']);
    const tl = await readTimeline(rec.timeline!);
    expect(tl.environment).toEqual({ name: 'test', access: 'read-write' });
  });
});
