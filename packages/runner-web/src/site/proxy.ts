/**
 * The only network of a site extraction's browser (L3.5, R-MCP-12): a local CONNECT proxy in the worker. Chromium is
 * launched with `--proxy-server=http://127.0.0.1:<this port>` and `--proxy-bypass-list=<-loopback>`, so every
 * connection it makes — the page, its subresources, redirect hops, preconnects, a service worker's script, its own
 * background traffic — reaches this proxy first. It:
 *
 * - accepts only `CONNECT <dns-name>:443` (absolute-form `GET http://…`, an IP literal, another port → 403);
 * - tunnels only hosts the context's route announced (a request the route allowed), so Chromium's own background
 *   traffic and hops the route never saw (a cross-host redirect, a preconnect, a link's prefetch) are refused;
 * - resolves the name once (`dns.lookup`, all addresses) and refuses it unless EVERY address is public (core
 *   ip-class.ts), then connects to the address it checked — Chromium never resolves a proxied name, so there is no
 *   window for DNS rebinding between the check and the connection;
 * - caps every tunnel (bytes, idle time, life time) and the job (bytes and tunnels together).
 *
 * Chromium does TLS itself (its certificate checks against the name, SNI), HTTP/2, compression and caching: the proxy
 * sees only encrypted bytes. The test resolver (`RETAKE_UNSAFE_TEST_RESOLVE`, core site.ts) maps invented
 * `.test` names to loopback ports for the tests; it never applies to any other name.
 */
import { lookup } from 'node:dns/promises';
import { createServer, connect, isIP } from 'node:net';
import type { Server, Socket } from 'node:net';
import { classifyAddress } from '@retake/core';
import type { AddressClass, SiteTestTarget } from '@retake/core';

export interface SiteProxyCaps {
  /** Bytes one tunnel carries (both ways). */
  tunnelBytes: number;
  /** A tunnel with no byte this long is closed (ms). */
  tunnelIdleMs: number;
  /** A tunnel lives at most this long (ms). */
  tunnelLifeMs: number;
  /** Bytes of every tunnel of the job together. */
  totalBytes: number;
  /** Tunnels of the job, at most. */
  tunnels: number;
}

export const SITE_PROXY_CAPS: SiteProxyCaps = { tunnelBytes: 15 * 1024 * 1024, tunnelIdleMs: 15_000, tunnelLifeMs: 60_000, totalBytes: 40 * 1024 * 1024, tunnels: 200 };

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SiteProxyOptions {
  caps?: Partial<SiteProxyCaps>;
  /** How a name resolves (default `dns.lookup(host, {all: true})`): tests inject one. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** Whether an address may be connected to (default core classifyAddress): tests inject one. */
  classify?: (address: string) => AddressClass;
  /** The port connected to on a checked public address (443; tests only change it). */
  port?: number;
  /** The unsafe test resolver: `.test` names → a loopback port, connected without classification. */
  testResolve?: ReadonlyMap<string, SiteTestTarget>;
}

export type ProxyRefusal = 'request' | 'port' | 'ip_literal' | 'not_announced' | 'dns' | 'not_public' | 'cap' | 'connect';

export interface SiteProxyStats {
  tunnels: number;
  bytes: number;
  /** Refused CONNECTs by reason (Chromium's own background requests count as not_announced). */
  refused: Partial<Record<ProxyRefusal, number>>;
  /** Hosts refused (names a page or Chromium asked for: untrusted), at most 30. */
  refused_hosts: Array<{ host: string; reason: ProxyRefusal; detail?: string }>;
  /** Tunnels closed by a cap. */
  capped: number;
}

const HEAD_MAX = 8192;
/** A DNS name in a CONNECT line: letters, digits, "-" and dots (Chromium sends names in punycode). */
const CONNECT_RE = /^CONNECT ([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|\[[0-9A-Fa-f:.]+\]|[^\s:]+):(\d+) HTTP\/1\.[01]$/;

async function defaultResolve(host: string): Promise<ResolvedAddress[]> {
  return lookup(host, { all: true, verbatim: true });
}

export class SiteProxy {
  private server: Server | undefined;
  private readonly announced = new Set<string>();
  private readonly sockets = new Set<Socket>();
  private readonly caps: SiteProxyCaps;
  private readonly resolver: (host: string) => Promise<ResolvedAddress[]>;
  private readonly classifier: (address: string) => AddressClass;
  private readonly upstreamPort: number;
  private readonly test: ReadonlyMap<string, SiteTestTarget>;
  private closed = false;
  /** CONNECTs past the cap check that wait for their name to resolve: they hold a tunnel slot meanwhile. */
  private pending = 0;
  readonly stats: SiteProxyStats = { tunnels: 0, bytes: 0, refused: {}, refused_hosts: [], capped: 0 };

  constructor(o: SiteProxyOptions = {}) {
    this.caps = { ...SITE_PROXY_CAPS, ...o.caps };
    this.resolver = o.resolve ?? defaultResolve;
    this.classifier = o.classify ?? classifyAddress;
    this.upstreamPort = o.port ?? 443;
    this.test = o.testResolve ?? new Map();
  }

  /** Start listening on 127.0.0.1 (an ephemeral port). */
  async start(): Promise<number> {
    const server = createServer((c) => this.onClient(c));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const a = server.address();
    if (!a || typeof a === 'string') throw new Error('the site proxy has no port');
    return a.port;
  }

  /** A host the context's route allowed a request to: from now on it may be tunnelled. */
  announce(host: string): void {
    this.announced.add(host.toLowerCase().replace(/\.$/, ''));
  }

  isAnnounced(host: string): boolean {
    return this.announced.has(host.toLowerCase().replace(/\.$/, ''));
  }

  /**
   * The address a name may be connected to, after the checks (every address public; the test resolver for its own
   * names). Used by the tunnels and by the top-level redirect pre-follow (extract.ts). Throws with a reason.
   */
  async checkedAddress(host: string): Promise<{ address: string; family: number; port: number; test: boolean }> {
    const h = host.toLowerCase().replace(/\.$/, '');
    const t = this.test.get(h);
    if (t) return { address: t.address, family: isIP(t.address), port: t.port, test: true };
    let all: ResolvedAddress[];
    try {
      all = await this.resolver(h);
    } catch (e) {
      throw new ProxyRefusalError('dns', `${h} does not resolve (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    if (!all.length) throw new ProxyRefusalError('dns', `${h} has no address`);
    for (const a of all) {
      const c = this.classifier(a.address);
      if (!c.public) throw new ProxyRefusalError('not_public', `${h} resolves to ${a.address}, ${c.reason}: only public addresses are opened`);
    }
    return { address: all[0].address, family: all[0].family, port: this.upstreamPort, test: false };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private refuse(c: Socket, reason: ProxyRefusal, host: string | undefined, detail?: string): void {
    this.stats.refused[reason] = (this.stats.refused[reason] ?? 0) + 1;
    if (host !== undefined && this.stats.refused_hosts.length < 30 && !this.stats.refused_hosts.some((r) => r.host === host && r.reason === reason)) {
      this.stats.refused_hosts.push({ host: host.slice(0, 200), reason, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
    }
    c.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }

  private onClient(c: Socket): void {
    this.sockets.add(c);
    c.on('close', () => this.sockets.delete(c));
    c.on('error', () => undefined);
    c.setTimeout(this.caps.tunnelIdleMs, () => c.destroy());
    let head = Buffer.alloc(0);
    const onData = (buf: Buffer) => {
      head = Buffer.concat([head, buf]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > HEAD_MAX) c.destroy();
        return;
      }
      c.off('data', onData);
      c.pause();
      void this.onRequest(c, head.subarray(0, end).toString('latin1'), head.subarray(end + 4));
    };
    c.on('data', onData);
  }

  private async onRequest(c: Socket, head: string, rest: Buffer): Promise<void> {
    const line = head.split('\r\n')[0] ?? '';
    const m = CONNECT_RE.exec(line);
    if (!m) {
      // Absolute-form requests (`GET http://…`), anything else: never forwarded.
      const target = /^[A-Z]+ (\S+)/.exec(line)?.[1];
      let host: string | undefined;
      try {
        host = target ? new URL(target).hostname : undefined;
      } catch {
        host = undefined;
      }
      this.refuse(c, 'request', host, 'not a CONNECT to a name');
      return;
    }
    const host = m[1].toLowerCase().replace(/^\[|\]$/g, '');
    if (isIP(host) || m[1].startsWith('[') || !host.includes('.') || /^\d+(?:\.\d+)*$/.test(host)) return this.refuse(c, 'ip_literal', host);
    if (m[2] !== '443') return this.refuse(c, 'port', host, `port ${m[2]}`);
    if (!this.announced.has(host)) return this.refuse(c, 'not_announced', host);
    // The slot is reserved before the name resolves: concurrent CONNECTs cannot all pass the check meanwhile.
    if (this.stats.tunnels + this.pending >= this.caps.tunnels || this.stats.bytes >= this.caps.totalBytes) return this.refuse(c, 'cap', host, 'the job\'s tunnels or bytes are used up');
    this.pending++;
    let target: Awaited<ReturnType<SiteProxy['checkedAddress']>>;
    try {
      target = await this.checkedAddress(host);
    } catch (e) {
      if (e instanceof ProxyRefusalError) return this.refuse(c, e.reason, host, e.message);
      return this.refuse(c, 'dns', host, (e as Error).message);
    } finally {
      this.pending--;
    }
    if (this.closed || c.destroyed) return;
    this.stats.tunnels++;
    this.tunnel(c, target, rest);
  }

  private tunnel(c: Socket, target: { address: string; port: number }, rest: Buffer): void {
    const up = connect({ host: target.address, port: target.port });
    this.sockets.add(up);
    let bytes = 0;
    let open = true;
    let connected = false;
    const close = (capped: boolean) => {
      if (!open) return;
      open = false;
      if (capped) this.stats.capped++;
      clearTimeout(life);
      c.destroy();
      up.destroy();
    };
    const life = setTimeout(() => close(true), this.caps.tunnelLifeMs);
    life.unref();
    const count = (n: number) => {
      bytes += n;
      this.stats.bytes += n;
      if (bytes > this.caps.tunnelBytes || this.stats.bytes > this.caps.totalBytes) close(true);
    };
    up.on('close', () => {
      this.sockets.delete(up);
      close(false);
    });
    c.on('close', () => close(false));
    up.on('error', () => {
      if (!connected) this.stats.refused.connect = (this.stats.refused.connect ?? 0) + 1;
      close(false);
    });
    up.setTimeout(this.caps.tunnelIdleMs, () => close(true));
    c.setTimeout(this.caps.tunnelIdleMs, () => close(true));
    up.once('connect', () => {
      connected = true;
      if (!open) return;
      c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) {
        count(rest.length);
        up.write(rest);
      }
      up.on('data', (d: Buffer) => count(d.length));
      c.on('data', (d: Buffer) => count(d.length));
      up.pipe(c);
      c.pipe(up);
      c.resume();
    });
  }
}

export class ProxyRefusalError extends Error {
  constructor(
    readonly reason: ProxyRefusal,
    message: string,
  ) {
    super(message);
  }
}
