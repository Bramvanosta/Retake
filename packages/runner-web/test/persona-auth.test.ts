/**
 * Hotfix v0.2.3 — `auth: {persona}` of an http hook: what a persona's browser sends with a request, read in a real
 * Chromium. A Firebase-like app keeps its user in IndexedDB (`firebaseLocalStorageDb`, as the Firebase SDK does) with a
 * one-hour ID token, and refreshes a token about to expire when its page loads; a signed-out page routes to /login.
 * A fresh token is read without any request to the product; a stale one through the product's page; a page that lands
 * on the sign-in page says the session expired.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import { chromium } from 'playwright-core';
import { PERSON_POLICY, resolvePersonas } from '@retake/core';
import { retakeHome } from '@retake/core/io';
import { launchTarget, personaAuthReader } from '../src/index.js';
import { makeProject, tempDir } from './helpers.js';

const APP = `<!doctype html><html><head><title>App</title></head><body><h1 id="h">…</h1><script>
const open = () => new Promise((res, rej) => { const r = indexedDB.open('firebaseLocalStorageDb', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const KEY = 'firebase:authUser:demo-key:[DEFAULT]';
const get = async () => { const db = await open(); return new Promise((res) => { const q = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').get(KEY); q.onsuccess = () => res(q.result); }); };
const put = async (value) => { const db = await open(); return new Promise((res) => { const t = db.transaction('firebaseLocalStorage', 'readwrite'); t.objectStore('firebaseLocalStorage').put({ fbase_key: KEY, value }); t.oncomplete = res; }); };
(async () => {
  const u = await get();
  if (!u) { history.replaceState({}, '', '/login'); document.getElementById('h').textContent = 'Sign in'; return; }
  if (u.value.stsTokenManager.expirationTime - Date.now() < 5 * 60000) {
    const r = await fetch('/api/refresh', { method: 'POST' });
    const { token } = await r.json();
    await put({ ...u.value, stsTokenManager: { ...u.value.stsTokenManager, accessToken: token, expirationTime: Date.now() + 3600000 } });
  }
  document.getElementById('h').textContent = 'Signed in';
})();
</script></body></html>`;

let server: Server;
let url = '';
const hits: string[] = [];
/** The product signed the session out: its pages redirect to /login. */
let signedOut = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (signedOut && req.url === '/') return res.writeHead(302, { location: '/login' }).end();
    if (req.url === '/api/refresh') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":"refreshed-token"}');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(APP);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** A browser whose app origin holds a Firebase user with `token` expiring at `expires` (none: signed out). */
async function browserWith(user: { token: string; expires: number } | null, cookie = true): Promise<BrowserContext> {
  const t = launchTarget({}, { headless: true, policy: PERSON_POLICY });
  const context = await chromium.launchPersistentContext(await tempDir('ds-pauth-profile-'), { headless: true, executablePath: t.executablePath, channel: t.channel });
  if (cookie) await context.addCookies([{ name: 'sid', value: 'session-cookie-1', url }]);
  const page = await context.newPage();
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto(`${url}/`);
  if (user) {
    await page.evaluate(async (u) => {
      await new Promise<void>((done) => {
        const r = indexedDB.open('firebaseLocalStorageDb', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
        r.onsuccess = () => {
          const tx = r.result.transaction('firebaseLocalStorage', 'readwrite');
          tx.objectStore('firebaseLocalStorage').put({
            fbase_key: 'firebase:authUser:demo-key:[DEFAULT]',
            value: { uid: 'u1', stsTokenManager: { accessToken: u.token, refreshToken: 'r', expirationTime: u.expires } },
          });
          tx.oncomplete = () => done();
        };
      });
    }, user);
  }
  await page.close();
  return context;
}

async function reader(context: BrowserContext, origins?: readonly string[]) {
  const project = makeProject(await tempDir('ds-pauth-'), { app: url });
  project.config.auth = { login_url: '/login', personas: { buyer: { pages: ['app'] } } };
  const persona = resolvePersonas(project, 'test', { home: retakeHome() }).find((p) => p.name === 'buyer')!;
  return personaAuthReader({ persona, context: async () => context, envPages: { app: url }, relogin: 'retake login northfield --persona buyer', ...(origins ? { origins } : {}) });
}

describe('the session of a persona as an http hook sends it (hotfix v0.2.3)', () => {
  it("with `origins` (trust mcp: the persona's own pages): read for those origins, refused elsewhere before the session is touched", async () => {
    const context = await browserWith({ token: 'fresh-token', expires: Date.now() + 3_600_000 });
    try {
      const own = new URL(url).origin;
      const read = await reader(context, [own]);
      expect(await read(`${url}/api/things`)).toEqual({ authorization: 'Bearer fresh-token', cookie: 'sid=session-cookie-1' });
      let touched = false;
      const guarded = await reader(new Proxy(context, { get: (t, k) => ((touched = true), Reflect.get(t, k)) }), [own]);
      await expect(guarded('https://elsewhere.example/collect')).rejects.toThrow(
        /persona buyer .*sends its session only to that persona's own pages .*https:\/\/elsewhere\.example is not one of them/,
      );
      expect(touched).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('a fresh Firebase ID token and the cookies: read without asking the product anything', async () => {
    const context = await browserWith({ token: 'fresh-token', expires: Date.now() + 3_600_000 });
    try {
      hits.length = 0;
      const read = await reader(context);
      expect(await read(`${url}/api/things`)).toEqual({ authorization: 'Bearer fresh-token', cookie: 'sid=session-cookie-1' });
      expect(hits).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('a token about to expire: the product page refreshes it', async () => {
    const context = await browserWith({ token: 'old-token', expires: Date.now() + 60_000 }, false);
    try {
      hits.length = 0;
      const read = await reader(context);
      expect(await read(`${url}/api/things`)).toEqual({ authorization: 'Bearer refreshed-token' });
      expect(hits).toContain('POST /api/refresh');
      // Cached: the next hook asks nothing again.
      hits.length = 0;
      expect((await read(`${url}/api/other`)).authorization).toBe('Bearer refreshed-token');
      expect(hits).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('nothing to send when signed out with no cookie; an expired session that lands on the sign-in page says so', async () => {
    const out = await browserWith(null, false);
    try {
      expect(await (await reader(out))(`${url}/api/things`)).toEqual({});
    } finally {
      await out.close();
    }
    const stale = await browserWith({ token: 'old-token', expires: Date.now() + 60_000 });
    signedOut = true;
    try {
      await expect((await reader(stale))(`${url}/api/things`)).rejects.toThrow(
        'persona buyer: its saved session lands on the sign-in page (' + url + '/login): it expired — sign in again: retake login northfield --persona buyer',
      );
    } finally {
      signedOut = false;
      await stale.close();
    }
  });
});
