/**
 * The page pre-flight before a take (L5.8, R-FLD-33): one GET per distinct page URL, any HTTP answer but a gateway
 * error counts, a refused connection or a timeout does not, and the refusal names each page and its URL.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preflightRefusal, probePages } from '@demo-studio/runner-web';

const servers: Server[] = [];
let ok = '';
let gateway = '';
let redirect = '';
let slow = '';
let dead = '';
let hits = 0;

async function serve(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const s = createServer(handler);
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  ok = await serve((_req, res) => {
    hits++;
    res.writeHead(404).end('not here');
  });
  gateway = await serve((_req, res) => res.writeHead(503).end());
  redirect = await serve((_req, res) => res.writeHead(302, { location: 'http://127.0.0.1:1/sign-in' }).end());
  slow = await serve(() => undefined);
  const s = createServer();
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
  dead = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  await new Promise<void>((res) => s.close(() => res()));
});
afterAll(() => {
  for (const s of servers) s.closeAllConnections?.();
  for (const s of servers) s.close();
});

describe('page pre-flight (L5.8)', () => {
  it('any answer counts (a 404 at the root, a sign-in redirect not followed), a gateway error, a refused connection or a timeout does not', async () => {
    const probes = await probePages({ console: ok, shop: ok, admin: redirect, api: gateway, app: dead, slow }, { timeoutMs: 400 });
    const byKey = Object.fromEntries(probes.map((p) => [p.keys.join('/'), { ok: p.ok, status: p.status, error: p.error }]));
    expect(byKey).toEqual({
      'console/shop': { ok: true, status: 404, error: undefined },
      admin: { ok: true, status: 302, error: undefined },
      api: { ok: false, status: 503, error: 'HTTP 503' },
      app: { ok: false, status: undefined, error: 'connection refused (nothing listens on that port)' },
      slow: { ok: false, status: undefined, error: 'no answer within 0.4 s' },
    });
    // Two page keys on one URL: asked once.
    expect(hits).toBe(1);
  });

  it('the refusal names each page and its URL, and what to do (a sandbox: start it)', async () => {
    const down = (await probePages({ console: dead, shop: gateway }, { timeoutMs: 400 })).filter((p) => !p.ok);
    expect(preflightRefusal('local', down)).toBe(
      `environment local: 2 pages do not answer — page console (${dead}): connection refused (nothing listens on that port); page shop (${gateway}): HTTP 503. Nothing was filmed: start the product (or check that its dev server still listens on that port: ports can move between two takes), then run again`,
    );
    expect(preflightRefusal('sandbox', down.slice(0, 1), { sandbox: 'studio sandbox up fx --env sandbox' })).toMatch(/^environment sandbox: a page does not answer — .* Nothing was filmed: start the sandbox \(studio sandbox up fx --env sandbox\) and check its ports$/);
  });
});
