/**
 * L3.5 the site extraction's CONNECT proxy (R-MCP-12), with an injected resolver and classifier (127.0.0.1 plays a
 * public address) and an upstream echo server: only `CONNECT <name>:443` of an announced host is tunnelled; every
 * address of the name must be public; the connection goes to the address that was checked (a resolver that answers
 * public then private is asked once and connected to its first answer); caps close tunnels.
 */
import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classifyAddress } from '@retake/core';
import { SiteProxy } from '../src/index.js';
import type { SiteProxyOptions } from '../src/index.js';

let upstream: Server;
let upstreamPort = 0;
let upstreamConnections = 0;
const proxies: SiteProxy[] = [];

beforeAll(async () => {
  upstream = createServer((s) => {
    upstreamConnections++;
    s.on('data', (d) => s.write(d));
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});
afterEach(async () => {
  for (const p of proxies.splice(0)) await p.close();
});

/** 127.0.0.1 counts as public here (the upstream echo server); the real classifier for everything else. */
const testClassify = (a: string) => (a === '127.0.0.1' ? ({ public: true, family: 4 } as const) : classifyAddress(a));

async function proxy(o: SiteProxyOptions = {}): Promise<{ p: SiteProxy; port: number }> {
  const p = new SiteProxy({ classify: testClassify, port: upstreamPort, resolve: async () => [{ address: '127.0.0.1', family: 4 }], ...o });
  proxies.push(p);
  return { p, port: await p.start() };
}

/** Send `head` to the proxy; the status line it answers and the open socket. */
async function ask(port: number, head: string): Promise<{ status: string; socket: Socket }> {
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('error', () => undefined);
  await new Promise<void>((r) => socket.once('connect', () => r()));
  socket.write(head);
  const status = await new Promise<string>((resolve) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n');
      if (end >= 0) {
        socket.off('data', onData);
        resolve(buf.slice(0, end));
      }
    };
    socket.on('data', onData);
    socket.once('close', () => resolve(buf.split('\r\n')[0] || 'closed'));
  });
  return { status, socket };
}

const connectLine = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

async function echo(socket: Socket, text: string): Promise<string> {
  socket.write(text);
  return new Promise((r) => socket.once('data', (d) => r(d.toString())));
}

describe('the site CONNECT proxy', () => {
  it('tunnels an announced name whose addresses are public, to the checked address', async () => {
    const { p, port } = await proxy();
    p.announce('brand.example.net');
    const before = upstreamConnections;
    const { status, socket } = await ask(port, connectLine('brand.example.net:443'));
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    expect(await echo(socket, 'ping')).toBe('ping');
    expect(upstreamConnections).toBe(before + 1);
    expect(p.stats.tunnels).toBe(1);
    socket.destroy();
  });

  it('DNS rebinding: the name is resolved once per tunnel, the connection goes to that first (public) answer', async () => {
    const answers = [[{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.9', family: 4 }]];
    let calls = 0;
    const { p, port } = await proxy({ resolve: async () => answers[Math.min(calls++, 1)] });
    p.announce('rebind.example.net');
    const { status, socket } = await ask(port, connectLine('rebind.example.net:443'));
    expect(status).toMatch(/ 200 /);
    expect(await echo(socket, 'still the first address')).toBe('still the first address');
    expect(calls).toBe(1);
    socket.destroy();
    // The next tunnel resolves again and is refused (private now).
    const second = await ask(port, connectLine('rebind.example.net:443'));
    expect(second.status).toMatch(/ 403 /);
    expect(p.stats.refused.not_public).toBe(1);
  });

  it('a name with one non-public address among public ones is refused', async () => {
    const { p, port } = await proxy({ resolve: async () => [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }] });
    p.announce('mixed.example.net');
    const before = upstreamConnections;
    const { status } = await ask(port, connectLine('mixed.example.net:443'));
    expect(status).toMatch(/ 403 /);
    expect(upstreamConnections).toBe(before);
    expect(p.stats.refused_hosts[0]).toMatchObject({ host: 'mixed.example.net', reason: 'not_public' });
    expect(p.stats.refused_hosts[0].detail).toMatch(/169\.254\.169\.254, link-local/);
  });

  it('with the real classifier, loopback and private answers are refused', async () => {
    const { p, port } = await proxy({ classify: undefined, resolve: async (h) => [{ address: h.startsWith('lo') ? '127.0.0.1' : '::ffff:192.168.1.1', family: h.startsWith('lo') ? 4 : 6 }] });
    for (const h of ['loop.example.net', 'mapped.example.net']) {
      p.announce(h);
      expect((await ask(port, connectLine(`${h}:443`))).status, h).toMatch(/ 403 /);
    }
    expect(p.stats.refused.not_public).toBe(2);
  });

  it('IP literals, other ports, absolute-form requests and unannounced hosts are refused', async () => {
    const { p, port } = await proxy();
    p.announce('brand.example.net');
    const before = upstreamConnections;
    for (const [head, reason] of [
      [connectLine('127.0.0.1:443'), 'ip_literal'],
      [connectLine('[::1]:443'), 'ip_literal'],
      [connectLine('2130706433:443'), 'ip_literal'],
      [connectLine('brand.example.net:8443'), 'port'],
      [connectLine('brand.example.net:80'), 'port'],
      ['GET http://brand.example.net/ HTTP/1.1\r\nHost: brand.example.net\r\n\r\n', 'request'],
      [connectLine('other.example.net:443'), 'not_announced'],
    ] as const) {
      const before2 = p.stats.refused[reason] ?? 0;
      expect((await ask(port, head)).status, head).toMatch(/ 403 /);
      expect(p.stats.refused[reason], head).toBe(before2 + 1);
    }
    expect(upstreamConnections).toBe(before);
    expect(p.stats.tunnels).toBe(0);
  });

  it('caps: bytes per tunnel (closed at once, long before its idle time)', async () => {
    const { p, port } = await proxy({ caps: { tunnelBytes: 64, tunnelIdleMs: 10_000 } });
    p.announce('brand.example.net');
    const a = await ask(port, connectLine('brand.example.net:443'));
    expect(a.status).toMatch(/ 200 /);
    const t0 = Date.now();
    const closed = new Promise<void>((r) => a.socket.once('close', () => r()));
    a.socket.write('x'.repeat(200));
    await closed;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(p.stats.capped).toBe(1);
  });

  it('caps: bytes per tunnel, tunnels per job, idle time', async () => {
    const { p, port } = await proxy({ caps: { tunnelBytes: 64, tunnels: 2, tunnelIdleMs: 300 } });
    p.announce('brand.example.net');
    const a = await ask(port, connectLine('brand.example.net:443'));
    expect(a.status).toMatch(/ 200 /);
    const closed = new Promise<void>((r) => a.socket.once('close', () => r()));
    a.socket.write('x'.repeat(200));
    await closed;
    expect(p.stats.capped).toBe(1);
    const b = await ask(port, connectLine('brand.example.net:443'));
    expect(b.status).toMatch(/ 200 /);
    const t0 = Date.now();
    await new Promise<void>((r) => b.socket.once('close', () => r()));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(p.stats.capped).toBe(2);
    expect((await ask(port, connectLine('brand.example.net:443'))).status).toMatch(/ 403 /);
    expect(p.stats.refused.cap).toBe(1);
  });

  it('caps: concurrent CONNECTs cannot all pass the tunnel cap while their names resolve', async () => {
    const { p, port } = await proxy({ caps: { tunnels: 2 }, resolve: async () => new Promise((r) => setTimeout(() => r([{ address: '127.0.0.1', family: 4 }]), 300)) });
    p.announce('slow.example.net');
    const before = upstreamConnections;
    const answers = await Promise.all(Array.from({ length: 12 }, () => ask(port, connectLine('slow.example.net:443'))));
    expect(answers.filter((a) => / 200 /.test(a.status))).toHaveLength(2);
    expect(answers.filter((a) => / 403 /.test(a.status))).toHaveLength(10);
    expect(p.stats.tunnels).toBe(2);
    expect(p.stats.refused.cap).toBe(10);
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamConnections - before).toBe(2);
    for (const a of answers) a.socket.destroy();
  });

  it('caps: a CONNECT refused after it reserved a slot gives the slot back', async () => {
    let calls = 0;
    const { p, port } = await proxy({ caps: { tunnels: 1 }, resolve: async () => (calls++ === 0 ? Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })) : [{ address: '127.0.0.1', family: 4 }]) });
    p.announce('flaky.example.net');
    expect((await ask(port, connectLine('flaky.example.net:443'))).status).toMatch(/ 403 /);
    const ok = await ask(port, connectLine('flaky.example.net:443'));
    expect(ok.status).toMatch(/ 200 /);
    ok.socket.destroy();
  });

  it('the unsafe test resolver serves its own names only, without classification', async () => {
    const { p } = await proxy({ classify: undefined, resolve: async () => [{ address: '127.0.0.1', family: 4 }], testResolve: new Map([['brand.test', { address: '127.0.0.1', port: 4430 }]]) });
    expect(await p.checkedAddress('brand.test')).toEqual({ address: '127.0.0.1', family: 4, port: 4430, test: true });
    await expect(p.checkedAddress('other.test')).rejects.toThrow(/only public addresses/);
  });
});
