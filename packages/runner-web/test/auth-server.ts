/**
 * A small app with a cookie sign-in for the L1.6 tests: two accounts on ONE host with the SAME cookie name (one browser
 * holds one of them at a time: two personas need two browsers), a session cookie for one and a persistent cookie for
 * the other, a server-side expiry, a page that routes itself to the sign-in page (pushState), a document link that opens
 * a tab, a page that never answers, a page that shows the browser clock's year, a landing page that writes as it loads
 * (L1.7: what the automated sign-in tab sends after the sign-in), and counters.
 */
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { launchTarget, writeSnapshot } from '../src/index.js';
import { PERSON_POLICY } from '@retake/core';

export interface Account {
  email: string;
  password: string;
  name: string;
  /** Persistent cookie (Max-Age) instead of a session cookie. */
  persistent: boolean;
}

export const ACCOUNTS: Record<string, Account> = {
  supplier: { email: 'ada@supplier.example', password: 'supplier-pass-4182', name: 'Ada Supplier', persistent: false },
  buyer: { email: 'ben@buyer.example', password: 'buyer-pass-9361', name: 'Ben Buyer', persistent: true },
};

export interface AuthServer {
  url: string;
  /** Requests to /api/ping (setup hooks). */
  pings: () => number;
  /** Writes (non-GET requests) to /api/… that reached the server: "METHOD /path". */
  apiWrites: () => string[];
  /** Forget every session (or one account's). */
  expire: (persona?: string) => void;
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><style>body{font:16px sans-serif;margin:40px}</style></head><body>${body}</body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

export async function startAuthServer(): Promise<AuthServer> {
  const sessions = new Map<string, string>();
  let pings = 0;
  const apiWrites: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (path.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD') apiWrites.push(`${req.method} ${path}`);
    if (path === '/api/last-seen' || path === '/api/onboarding') {
      res.writeHead(204).end();
      return;
    }
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const who = sid ? sessions.get(sid) : undefined;
    const html = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    if (path === '/api/ping') {
      pings++;
      res.writeHead(204).end();
      return;
    }
    if (path === '/expire' && req.method === 'POST') {
      const persona = url.searchParams.get('persona');
      for (const [k, v] of [...sessions]) if (!persona || v === persona) sessions.delete(k);
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
      return;
    }
    if (path === '/api/whoami') {
      res.writeHead(who ? 200 : 401, { 'content-type': 'text/plain' }).end(who ? ACCOUNTS[who].name : 'signed out');
      return;
    }
    if (path === '/sign-in' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const persona = Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].email === form.get('email') && ACCOUNTS[k].password === form.get('password'));
      if (!persona) return html(401, page('Sign in', '<p>Wrong email or password</p>'));
      const token = randomBytes(8).toString('hex');
      sessions.set(token, persona);
      const cookie = `sid=${token}; Path=/; HttpOnly; SameSite=Lax${ACCOUNTS[persona].persistent ? '; Max-Age=3600' : ''}`;
      const next = form.get('next') ?? '/';
      return html(303, '', { location: next.startsWith('/') ? next : '/', 'set-cookie': cookie });
    }
    if (path === '/sign-in') {
      const next = url.searchParams.get('next') ?? '/';
      return html(
        200,
        page(
          'Sign in',
          `<h1>Sign in</h1><form method="post" action="/sign-in"><input type="hidden" name="next" value="${next.replace(/"/g, '')}">
          <label>Email <input name="email" type="email"></label><br><label>Password <input name="password" type="password"></label><br>
          <button type="submit">Sign in</button></form>`,
        ),
      );
    }
    if (path === '/public') return html(200, page('Public', '<h1>Public page</h1><a href="/home">Home</a>'));
    // Never answers (a check that hangs; closing the server ends it).
    if (path === '/hang') return;
    if (!who) return html(302, '', { location: `/sign-in?next=${encodeURIComponent(path + url.search)}` });
    const account = ACCOUNTS[who];
    // The browser's clock (L1.7): which year the page reads.
    if (path === '/clock') {
      return html(200, page('Clock', `<h1>Signed in as ${account.name}</h1><p id="y"></p><script>document.getElementById('y').textContent = 'Year ' + new Date().getFullYear()</script>`));
    }
    // The page a sign-in lands on (next=/welcome): it writes as it loads, like a product's "last seen" ping.
    if (path === '/welcome') {
      return html(
        200,
        page('Welcome', `<h1>Signed in as ${account.name}</h1><script>fetch('/api/last-seen', { method: 'PUT', body: '{}' }); navigator.sendBeacon('/api/onboarding', 'done');</script>`),
      );
    }
    // A page that routes itself to the sign-in page after `?ms=` (default 800): a session lost while nobody acts.
    if (path === '/later') {
      const ms = Number(url.searchParams.get('ms') ?? 800);
      return html(
        200,
        page('Later', `<h1>Signed in as ${account.name}</h1><script>setTimeout(() => { history.pushState({}, '', '/sign-in'); document.querySelector('h1').textContent = 'Sign in'; }, ${ms});</script>`),
      );
    }
    if (path === '/spa') {
      return html(
        200,
        page(
          'App',
          `<h1>Signed in as ${account.name}</h1><button onclick="history.pushState({}, '', '/sign-in'); document.querySelector('h1').textContent = 'Sign in'">Leave</button>`,
        ),
      );
    }
    return html(
      200,
      page(
        'App',
        `<h1>Signed in as ${account.name}</h1><p>Page ${path}</p><a href="/quotes">Quotes</a> <a href="/home">Home</a>
        <a href="/document" target="_blank">Document</a>
        <button onclick="fetch('/expire', { method: 'POST' }).then(() => { document.querySelector('p').textContent = 'expired' })">Expire</button>`,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    pings: () => pings,
    apiWrites: () => [...apiWrites],
    expire: (persona) => {
      for (const [k, v] of [...sessions]) if (!persona || v === persona) sessions.delete(k);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * What `retake login` leaves behind, made headless: a master profile signed in as `persona` (its session cookie, if
 * any, is lost when it closes — as with a real browser) and the snapshot of that session (session cookies included).
 */
export async function signInMaster(opts: { url: string; persona: string; profileDir?: string; snapshot: string; project: string; env: string }): Promise<void> {
  const a = ACCOUNTS[opts.persona];
  const context = opts.profileDir
    ? await chromium.launchPersistentContext(opts.profileDir, { headless: true, ...launchTarget({}, { policy: PERSON_POLICY }) })
    : await (await chromium.launch({ headless: true, ...launchTarget({}, { policy: PERSON_POLICY }) })).newContext();
  try {
    const p = context.pages()[0] ?? (await context.newPage());
    await p.goto(`${opts.url}/sign-in`);
    await p.fill('input[name=email]', a.email);
    await p.fill('input[name=password]', a.password);
    await Promise.all([p.waitForURL(`${opts.url}/`), p.click('button[type=submit]')]);
    const state = await context.storageState();
    await writeSnapshot(opts.snapshot, state, { project: opts.project, env: opts.env, persona: opts.persona, how: 'test' });
  } finally {
    const browser = context.browser();
    await context.close();
    if (!opts.profileDir) await browser?.close();
  }
}
