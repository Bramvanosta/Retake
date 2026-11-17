/**
 * The driver's HTTP client (src/driver-client.ts) against a fake driver on 127.0.0.1: /status must prove the token
 * (HMAC of a fresh nonce) before any command goes out, the token goes in its header, the body carries the op and its
 * deadline, each call has its time limit and the run's cancel (a clean-up's call: not the cancel), and what goes wrong
 * is said (refused, invalid, failed, unreachable, timeout, cancelled; a command the driver dropped past its deadline:
 * timeout).
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DriverClient, DriverError, NONCE_HEADER, TOKEN_HEADER, statusProof } from '../src/driver-client.js';

const TOKEN = 'a'.repeat(64);
let server: Server;
let port: number;
const seen: Array<{ url: string; token: string | undefined; body: unknown }> = [];
/** What the fake's /status answers: the right proof, a wrong one, none (a program that only says 200). */
let proofMode: 'right' | 'wrong' | 'none' = 'right';

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === '/status') {
    seen.push({ url: '/status', token: req.headers[TOKEN_HEADER] as string | undefined, body: null });
    const nonce = String(req.headers[NONCE_HEADER] ?? '');
    if (proofMode === 'none') return reply(res, 200, { ok: true });
    return reply(res, 200, { ok: true, proof: statusProof(proofMode === 'right' ? TOKEN : 'x'.repeat(64), nonce) });
  }
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw) as { op: string };
  const token = req.headers[TOKEN_HEADER] as string | undefined;
  seen.push({ url: req.url ?? '', token, body });
  if (token !== TOKEN) return reply(res, 403, 'forbidden');
  switch (body.op) {
    case 'state':
      return reply(res, 200, { ok: true, state: 'runningForeground', t_begin: 1, t_end: 2 });
    case 'bad':
      return reply(res, 200, { ok: false, code: 'invalid', error: 'unknown op', t_begin: 1, t_end: 2 });
    case 'tap':
      return reply(res, 200, { ok: false, code: 'failed', error: 'no element matches the query', t_begin: 1, t_end: 2 });
    case 'html':
      return reply(res, 500, '<html>');
    case 'slow':
      setTimeout(() => reply(res, 200, { ok: true, t_begin: 1, t_end: 2 }), 2000);
      return;
    case 'late':
      return reply(res, 200, { ok: false, code: 'expired', error: 'dropped: it arrived past its deadline', t_begin: 1, t_end: 2 });
  }
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe('DriverClient', () => {
  it("sends the op and its deadline in the body and the run's token in its header; /status carries no token", async () => {
    const c = new DriverClient({ port, token: TOKEN });
    expect(await c.status()).toBe(true);
    expect(seen.at(-1)).toEqual({ url: '/status', token: undefined, body: null });
    const before = Date.now();
    const r = await c.cmd<{ state: string }>('state', {}, 5000);
    expect(r.state).toBe('runningForeground');
    expect(seen.at(-1)).toMatchObject({ url: '/cmd', token: TOKEN, body: { op: 'state' } });
    const deadline = (seen.at(-1)!.body as { deadline_ms: number }).deadline_ms;
    expect(deadline).toBeGreaterThanOrEqual(before + 5000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 5000);
    await c.cmd('state', { op: 'other', x: 1 });
    expect(seen.at(-1)?.body).toMatchObject({ op: 'state', x: 1 });
  });

  it('a program on the port that cannot prove the token (a wrong proof, none) is never sent the token or a command', async () => {
    for (const mode of ['wrong', 'none'] as const) {
      proofMode = mode;
      const c = new DriverClient({ port, token: TOKEN });
      expect(await c.status(), mode).toBe(false);
      const n = seen.length;
      await expect(c.cmd('state')).rejects.toMatchObject({ kind: 'refused', message: expect.stringMatching(/has not proved/) });
      expect(seen.length).toBe(n);
    }
    proofMode = 'right';
  });

  it('the driver refusing the token, saying invalid or failed, an answer that is no JSON, a command dropped past its deadline', async () => {
    const c = new DriverClient({ port, token: TOKEN });
    await c.status();
    const wrong = new DriverClient({ port, token: 'b'.repeat(64) });
    (wrong as unknown as { proven: boolean }).proven = true;
    await expect(wrong.cmd('state')).rejects.toMatchObject({ kind: 'refused', message: expect.stringMatching(/refused the run's token/) });
    await expect(c.cmd('late')).rejects.toMatchObject({ kind: 'timeout' });
    await expect(c.cmd('bad')).rejects.toMatchObject({ kind: 'invalid', message: 'bad: unknown op' });
    await expect(c.cmd('tap')).rejects.toMatchObject({ kind: 'failed', message: 'tap: no element matches the query' });
    await expect(c.cmd('html')).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('no JSON (HTTP 500)') });
  });

  it("a call past its time limit, the run's cancel and a driver gone are said apart; a clean-up's call ignores the cancel", async () => {
    const c = new DriverClient({ port, token: TOKEN });
    await c.status();
    await expect(c.cmd('slow', {}, 200)).rejects.toMatchObject({ kind: 'timeout' });
    const abort = new AbortController();
    const run = new DriverClient({ port, token: TOKEN, signal: abort.signal });
    await run.status();
    const cancelled = run.cmd('slow', {}, 5000);
    setTimeout(() => abort.abort(), 100);
    await expect(cancelled).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(run.cmd('slow', {}, 5000, { uncancelled: true })).resolves.toMatchObject({ ok: true });
    const gone = new DriverClient({ port: 1, token: TOKEN });
    (gone as unknown as { proven: boolean }).proven = true;
    await expect(gone.cmd('state', {}, 2000)).rejects.toBeInstanceOf(DriverError);
    await expect(gone.cmd('state', {}, 2000)).rejects.toMatchObject({ kind: 'unreachable' });
    expect(await gone.status(300)).toBe(false);
  });
});
