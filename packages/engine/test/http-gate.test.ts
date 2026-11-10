/**
 * L4.1 (critique B3): the HTTP gate of the engine's local servers, layer by layer, each hostile request sent WITH the
 * valid token over a raw http.request with forged headers — so a layer that answers only because the token is missing
 * cannot pass for the layer under test. The order is fixed: Host (421) → Origin / Sec-Fetch-Site (403) → route /
 * method (404 / 405) → token (401) → content type (415) → size (413).
 */
import { request } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders, Server } from 'node:http';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_CODES_MAX,
  BodyTooLargeError,
  BootstrapCodes,
  ERROR_STATUS,
  ENGINE_ERROR_CODES,
  STUDIO_CSP,
  bearerToken,
  checkRequest,
  drainBody,
  fromBrowser,
  listenLoopback,
  newSecret,
  readBody,
  secretEquals,
  securityHeaders,
  studioCsp,
} from '../src/index.js';
import type { RouteSpec } from '../src/index.js';

const MAX = 64 * 1024;
const ROUTES: Record<string, RouteSpec> = {
  '/': { methods: ['GET', 'HEAD'], token: false, api: false },
  '/v1/info': { methods: ['GET'], token: true, api: true },
  '/v1/call/op': { methods: ['POST'], token: true, api: true, maxBody: MAX },
};
const TOKEN = newSecret();
let server: Server;
let port: number;
/** Handlers that ran (a refused request never reaches one). */
let executed = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const g = checkRequest(req, { port, token: TOKEN, route: (p) => ROUTES[p] });
    const kind = g.ok && !g.route.api ? 'static' : 'api';
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...securityHeaders(kind), 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(body));
    };
    if (!g.ok) {
      void drainBody(req).then((drained) => drained && send(g.status, { ok: false, error: { code: g.code } }, g.allow ? { Allow: g.allow, Connection: 'close' } : { Connection: 'close' }));
      return;
    }
    void (async () => {
      try {
        const body = g.route.maxBody !== undefined ? await readBody(req, g.route.maxBody) : Buffer.alloc(0);
        executed++;
        send(200, { ok: true, bytes: body.length });
      } catch (e) {
        if (e instanceof BodyTooLargeError) send(413, { ok: false, error: { code: 'too_large' } }, { Connection: 'close' });
        else send(500, { ok: false });
      }
    })();
  });
  port = await listenLoopback(server, 0);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A raw request: every header as given (Host included; `host: null` sends none). */
function raw(method: string, path: string, headers: Record<string, string | null>, body?: string | Buffer, chunked = false): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const h: OutgoingHttpHeaders = {};
    let setHost = true;
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'host' && v === null) setHost = false;
      else if (v !== null) h[k] = v;
    }
    if (!('host' in h) && setHost) h.host = `127.0.0.1:${port}`;
    if (body !== undefined && !chunked) h['content-length'] = String(Buffer.byteLength(body));
    const req = request({ host: '127.0.0.1', port, method, path, headers: h, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: -1, headers: {}, body: '' }) : reject(e)));
    if (body !== undefined && chunked) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      for (let i = 0; i < buf.length; i += 16 * 1024) req.write(buf.subarray(i, i + 16 * 1024));
    } else if (body !== undefined) req.write(body);
    req.end();
  });
}

const auth = () => ({ authorization: `Bearer ${TOKEN}` });
const json = { 'content-type': 'application/json' };
const call = (headers: Record<string, string | null>, body = '{}') => raw('POST', '/v1/call/op', { ...auth(), ...json, ...headers }, body);

describe('gate layer 1: Host (DNS rebinding), with a valid token', () => {
  it('answers 127.0.0.1:<port> and localhost:<port> only; 421 otherwise', async () => {
    expect((await raw('GET', '/v1/info', { ...auth(), host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await raw('GET', '/v1/info', { ...auth(), host: `localhost:${port}` })).status).toBe(200);
    expect((await raw('GET', '/v1/info', { ...auth(), host: `LocalHost:${port}` })).status).toBe(200);
    for (const host of [`rebind.test:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', 'localhost', `[::1]:${port}`, `0.0.0.0:${port}`, `127.0.0.2:${port}`, `127.0.0.1:${port}.rebind.test`, '']) {
      const r = await raw('GET', '/v1/info', { ...auth(), host });
      expect(r.status, host).toBe(421);
    }
    // No Host at all: node:http itself answers 400 (requireHostHeader), before the gate.
    expect((await raw('GET', '/v1/info', { ...auth(), host: null })).status).toBe(400);
    expect(checkRequest({ method: 'GET', url: '/v1/info', headers: { authorization: `Bearer ${TOKEN}` } }, { port, token: TOKEN, route: (p) => ROUTES[p] })).toMatchObject({ ok: false, status: 421 });
    // Static documents too: a rebinding page never loads the app from this server.
    expect((await raw('GET', '/', { host: `rebind.test:${port}` })).status).toBe(421);
    expect((await call({ host: `rebind.test:${port}` })).status).toBe(421);
  });
});

describe('gate layer 2: Origin and Sec-Fetch-Site (other pages), with a valid token', () => {
  it('a present Origin must be this server', async () => {
    expect((await call({})).status).toBe(200);
    expect((await call({ origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await call({ origin: `http://localhost:${port}` })).status).toBe(200);
    for (const origin of ['null', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, 'http://rebind.test', `http://127.0.0.1:${port}/`, `http://127.0.0.1:${port}, http://evil.test`]) {
      expect((await call({ origin })).status, origin).toBe(403);
    }
    expect((await raw('GET', '/', { origin: 'http://evil.test' })).status).toBe(403);
  });

  it('API routes: a present Sec-Fetch-Site must be same-origin or none (a cross-port page is same-site); static documents take any', async () => {
    expect((await call({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await call({ 'sec-fetch-site': 'none' })).status).toBe(200);
    for (const site of ['same-site', 'cross-site', 'SAME-ORIGIN', 'whatever']) {
      expect((await call({ 'sec-fetch-site': site })).status, site).toBe(403);
      expect((await raw('GET', '/v1/info', { ...auth(), 'sec-fetch-site': site })).status, site).toBe(403);
    }
    // What a no-cors fetch or a <form enctype=text/plain> of a cross-port page sends: refused before the body is read.
    expect((await raw('POST', '/v1/call/op', { 'content-type': 'text/plain', 'sec-fetch-site': 'same-site', origin: `http://127.0.0.1:${port + 1}`, ...auth() }, '{}')).status).toBe(403);
    expect((await raw('POST', '/v1/call/op', { 'content-type': 'text/plain', 'sec-fetch-site': 'same-site', ...auth() }, '{}')).status).toBe(403);
    // An unknown path counts as API.
    expect((await raw('GET', '/nope', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await raw('GET', '/', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
  });
});

describe('gate layer 3: route and method, with a valid token', () => {
  it('unknown path 404; OPTIONS and other methods 405 with Allow; never an Access-Control header', async () => {
    expect((await raw('GET', '/nope', auth())).status).toBe(404);
    const pre = await raw('OPTIONS', '/v1/call/op', { ...auth(), origin: `http://127.0.0.1:${port}`, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' });
    expect(pre.status).toBe(405);
    expect(pre.headers.allow).toBe('POST');
    expect((await raw('GET', '/v1/call/op', auth())).status).toBe(405);
    expect((await raw('POST', '/v1/info', { ...auth(), ...json }, '{}')).status).toBe(405);
    expect((await raw('DELETE', '/v1/info', auth())).status).toBe(405);
    expect((await raw('HEAD', '/', {})).status).toBe(200);
    for (const r of [pre, await call({}), await call({ origin: 'null' }), await raw('GET', '/', {})]) {
      expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
  });
});

describe('gate layer 4: token', () => {
  it('missing, wrong, truncated, of another scheme → 401; static documents need none', async () => {
    expect((await raw('GET', '/v1/info', {})).status).toBe(401);
    expect((await raw('GET', '/v1/info', { authorization: `Bearer ${newSecret()}` })).status).toBe(401);
    expect((await raw('GET', '/v1/info', { authorization: `Bearer ${TOKEN.slice(0, -1)}` })).status).toBe(401);
    expect((await raw('GET', '/v1/info', { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await raw('GET', '/v1/info', { authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await raw('GET', '/v1/info', { authorization: TOKEN })).status).toBe(401);
    expect((await raw('GET', '/v1/info', { authorization: `Bearer  ${TOKEN}` })).status).toBe(401);
    expect((await raw('GET', '/v1/info', auth())).status).toBe(200);
    expect((await raw('GET', '/v1/info', { authorization: `bearer ${TOKEN}` })).status).toBe(200);
    expect((await raw('GET', '/', {})).status).toBe(200);
  });

  it('helpers: constant-time equality of any lengths, bearer parsing', () => {
    expect(secretEquals(TOKEN, TOKEN)).toBe(true);
    expect(secretEquals(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(secretEquals('', TOKEN)).toBe(false);
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken(`Bearer ${TOKEN} extra`)).toBeUndefined();
    expect(newSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('gate layer 5: content type and size, with a valid token', () => {
  it('a POST must be application/json (415 otherwise)', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json', null]) {
      expect((await call({ 'content-type': type })).status, String(type)).toBe(415);
    }
    expect((await call({ 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
    expect((await call({ 'content-type': 'Application/JSON' })).status).toBe(200);
  });

  it('a body over the cap is 413 — declared or streamed; at the cap it is read', async () => {
    const at = Buffer.alloc(MAX, 0x20);
    const over = Buffer.alloc(MAX + 1, 0x20);
    expect((await call({}, at.toString())).status).toBe(200);
    expect((await call({}, over.toString())).status).toBe(413);
    const before = executed;
    const streamed = await raw('POST', '/v1/call/op', { ...auth(), ...json }, Buffer.alloc(MAX * 4, 0x20), true);
    expect(streamed.status).toBe(413);
    expect(executed).toBe(before);
    // Declared over the cap: answered before the body is used, after it is drained (the client reads a 413, not a reset).
    expect((await call({}, over.toString())).status).toBe(413);
    expect(executed).toBe(before);
  });
});

describe('gate order', () => {
  it('the first failing layer answers', async () => {
    expect((await raw('POST', '/v1/call/op', { host: `rebind.test:${port}`, origin: 'http://evil.test', 'content-type': 'text/plain' }, '{}')).status).toBe(421);
    expect((await raw('POST', '/v1/call/op', { origin: 'http://evil.test', 'content-type': 'text/plain' }, '{}')).status).toBe(403);
    expect((await raw('POST', '/v1/call/op', { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, '{}')).status).toBe(403);
    expect((await raw('OPTIONS', '/v1/call/op', {})).status).toBe(405);
    expect((await raw('POST', '/v1/call/op', { 'content-type': 'text/plain' }, '{}')).status).toBe(401);
    expect((await raw('POST', '/v1/call/op', { ...auth(), 'content-type': 'text/plain' }, 'x'.repeat(MAX + 1))).status).toBe(415);
  });

  it('a pure function over the request shape', () => {
    const o = { port: 4000, token: TOKEN, route: (p: string) => ROUTES[p] };
    expect(checkRequest({ method: 'GET', url: '/v1/info?x=1', headers: { host: '127.0.0.1:4000', authorization: `Bearer ${TOKEN}` } }, o)).toMatchObject({ ok: true, path: '/v1/info' });
    expect(checkRequest({ method: 'GET', url: 'http://127.0.0.1:4000/v1/info', headers: { host: '127.0.0.1:4000' } }, o)).toMatchObject({ ok: false, status: 400 });
    expect(checkRequest({ method: 'GET', url: '/../v1/info', headers: { host: '127.0.0.1:4000' } }, o)).toMatchObject({ ok: false, status: 404 });
    // A declared Content-Length over the cap is refused by the gate itself, before any byte is read.
    const post = (length: number) => checkRequest({ method: 'POST', url: '/v1/call/op', headers: { host: '127.0.0.1:4000', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(length) } }, o);
    expect(post(MAX)).toMatchObject({ ok: true });
    expect(post(MAX + 1)).toMatchObject({ ok: false, status: 413 });
  });
});

describe('refuseBrowsers (MCP over HTTP): after Host, before everything else', () => {
  const o = { port: 4000, token: TOKEN, route: (p: string) => (p === '/mcp' ? ({ methods: ['GET', 'POST', 'DELETE'], token: true, api: true, maxBody: MAX } as RouteSpec) : undefined), refuseBrowsers: true };
  const req = (headers: Record<string, string>, method = 'POST') =>
    checkRequest({ method, url: '/mcp', headers: { host: '127.0.0.1:4000', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers } }, o);

  it('any Origin (its own included) or Sec-Fetch-* header is 403 browser — but the lone Sec-Fetch-Mode: cors of Node fetch', () => {
    expect(req({})).toMatchObject({ ok: true, path: '/mcp' });
    expect(req({}, 'DELETE')).toMatchObject({ ok: true });
    expect(req({ 'sec-fetch-mode': 'cors' })).toMatchObject({ ok: true });
    for (const h of [{ origin: 'http://127.0.0.1:4000' }, { origin: 'null' }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-user': '?1' }, { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }] as Array<Record<string, string>>) {
      expect(req(h), JSON.stringify(h)).toMatchObject({ ok: false, status: 403, code: 'browser' });
    }
    // Host still answers first; without the option, the Studio's rules apply (its own Origin is fine).
    expect(checkRequest({ method: 'POST', url: '/mcp', headers: { host: 'rebind.test:4000', origin: 'http://127.0.0.1:4000' } }, o)).toMatchObject({ status: 421 });
    expect(checkRequest({ method: 'POST', url: '/mcp', headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }, { ...o, refuseBrowsers: false })).toMatchObject({ ok: true });
    expect(fromBrowser({ 'sec-fetch-mode': 'cors' })).toBe(false);
    expect(fromBrowser({ origin: 'x' })).toBe(true);
  });
});

describe('security headers and error statuses', () => {
  it('every answer carries the exact CSP and its companions — 200, 4xx alike', async () => {
    expect(STUDIO_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    for (const r of [await raw('GET', '/', {}), await call({}), await raw('GET', '/v1/info', {}), await raw('GET', '/v1/info', { host: 'x.test' }), await raw('GET', '/nope', auth())]) {
      expect(r.headers['content-security-policy']).toBe(STUDIO_CSP);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
      // L5.2 (critique L5): no camera / microphone / screen / location for the page and its frames.
      expect(r.headers['permissions-policy']).toBe('camera=(), microphone=(), display-capture=(), geolocation=()');
    }
    expect(securityHeaders('api')['Cache-Control']).toBe('no-store');
    expect(securityHeaders('static')['Cache-Control']).toBe('no-cache');
  });

  it('maps every engine error code to a status (needs_approval and cancelled included)', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ENGINE_ERROR_CODES].sort());
    expect(ERROR_STATUS).toMatchObject({ invalid: 400, refused: 403, needs_approval: 403, not_found: 404, conflict: 409, cancelled: 409, busy: 423, unavailable: 503, internal: 500 });
  });
});

describe('the player origin (L4.5)', () => {
  const ASSET: RouteSpec = { methods: ['GET', 'HEAD'], token: false, api: false };
  const o = { port: 4000, token: TOKEN, route: () => ASSET };
  const get = (headers: Record<string, string>, opts: Partial<Parameters<typeof checkRequest>[1]> = {}) => checkRequest({ method: 'GET', url: '/m/x', headers: { host: '127.0.0.1:4000', ...headers } }, { ...o, ...opts });

  it('⚑ allowNullOrigin takes `Origin: null` (the sandboxed frame) and nothing else; without it, null is refused', () => {
    expect(get({ origin: 'null' }, { allowNullOrigin: true })).toMatchObject({ ok: true });
    expect(get({ origin: 'null', 'sec-fetch-site': 'cross-site' }, { allowNullOrigin: true })).toMatchObject({ ok: true });
    expect(get({}, { allowNullOrigin: true })).toMatchObject({ ok: true });
    for (const origin of ['http://127.0.0.1:4001', 'http://evil.example', 'NULL', 'null ', 'file://']) expect(get({ origin }, { allowNullOrigin: true }), origin).toMatchObject({ ok: false, status: 403 });
    expect(get({ origin: 'null' })).toMatchObject({ ok: false, status: 403, code: 'cross_origin' });
    // Host first, POST refused (405) even with a null Origin.
    expect(get({ origin: 'null', host: 'rebind.test:4000' }, { allowNullOrigin: true })).toMatchObject({ status: 421 });
    expect(checkRequest({ method: 'POST', url: '/m/x', headers: { host: '127.0.0.1:4000', origin: 'null' } }, { ...o, allowNullOrigin: true })).toMatchObject({ status: 405 });
  });

  it('⚑ the Studio CSP frames exactly the player origin, a loopback http origin only', () => {
    expect(studioCsp()).toBe(STUDIO_CSP);
    expect(studioCsp('http://127.0.0.1:4100')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src http://127.0.0.1:4100; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(securityHeaders('static', { frameSrc: 'http://127.0.0.1:4100' })['Content-Security-Policy']).toBe(studioCsp('http://127.0.0.1:4100'));
    for (const bad of ['http://localhost:4100', 'https://127.0.0.1:4100', 'http://127.0.0.1:4100/', "http://127.0.0.1:4100; script-src *", '*', 'http://example.test']) expect(() => studioCsp(bad), bad).toThrow(/frame-src/);
  });
});

describe('bootstrap codes (B9)', () => {
  it('single use, valid 60 s, at most 16 waiting', () => {
    let t = 1_000_000;
    const codes = new BootstrapCodes(60_000, () => t);
    const a = codes.mint();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codes.redeem(a)).toBe(true);
    expect(codes.redeem(a)).toBe(false);
    const b = codes.mint();
    t += 60_001;
    expect(codes.redeem(b)).toBe(false);
    expect(codes.redeem('not-a-code')).toBe(false);
    const many = Array.from({ length: BOOTSTRAP_CODES_MAX + 2 }, () => codes.mint());
    expect(codes.size).toBe(BOOTSTRAP_CODES_MAX);
    expect(codes.redeem(many[0])).toBe(false);
    expect(codes.redeem(many[many.length - 1])).toBe(true);
  });
});
