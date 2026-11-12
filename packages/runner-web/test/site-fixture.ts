/**
 * The brand-site fixture (L3.5): an invented brand ("Quillmere") served over self-signed https on invented `.test`
 * names — brand.test (redirects to www.brand.test), www.brand.test and cdn.test on one local port — plus escape
 * listeners that must never be reached: a TCP port (esc.test and 127.0.0.1 literals, TURN over TCP, WebSockets) and a
 * UDP port (STUN). hostile.test serves pages that attack the extraction itself (a renderer busy loop, huge font names,
 * logos a create would refuse); elsewhere.test is another host a redirect may point to. The certificate is made by openssl in the test setup (a throwaway key, valid one day, never
 * committed); the fonts are the OFL files of templates/ served under invented family names; the PNG logos are drawn
 * here (no binary in the repository).
 *
 * Tests reach it through the unsafe test resolver: `testResolve` (runner-web) or RETAKE_UNSAFE_TEST_RESOLVE =
 * `resolveEnv` (a worker or a CLI process).
 */
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { SiteTestTarget } from '@retake/core';

const HERE = new URL('.', import.meta.url).pathname;
const REPO = join(HERE, '..', '..', '..');
const SITE_DIR = join(HERE, 'fixtures', 'brand-site');
export const FIXTURE_FONTS = {
  display: join(REPO, 'templates', 'editorial', 'fonts', 'InstrumentSerif-Regular.ttf'),
  text: join(REPO, 'templates', 'editorial', 'fonts', 'Inter-Regular.ttf'),
};

/** The fixture's known colours. */
export const BRAND_SITE_COLORS = { paper: '#fbfaf7', text: '#14161f', accent: '#0e7c66', dark: '#10151c' };
export const BRAND_SITE_URL = 'https://brand.test/';

/** Deterministic noise (an image that compresses badly). */
function noise(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x >>> 24;
  };
}

/** Pages of hostile.test, by path. */
const HOSTILE_PAGES: Record<string, string> = {
  // The renderer never comes back once the page is scrolled: every call into it hangs.
  '/hang':
    '<!doctype html><html><head><title>busy</title></head><body style="height:5000px"><header><h1>Busy</h1></header><p>Some text.</p><script>addEventListener("scroll", () => { for (;;) {} });</script></body></html>',
  // 40 font faces whose family names are 1 MB each.
  '/fonts':
    '<!doctype html><html><head><title>fonts</title></head><body><h1>Fonts</h1><p>Some text.</p><script>for (let i = 0; i < 40; i++) document.fonts.add(new FontFace("F" + i + "X".repeat(1000000), "local(Arial)", { weight: "400" }));</script></body></html>',
  // Font family names with a right-to-left override and a C1 control (CSS escapes): printed by the CLI.
  '/bidi':
    '<!doctype html><html><head><title>bidi</title><style>h1 { font-family: "Evil\\202E Display", serif } p { font-family: "Evil\\85 Text", serif }</style></head><body><h1>Bidi</h1><p>Some text.</p></body></html>',
  // Logos a create would refuse once drawn: too wide (under 64 px high at 2048 px wide) and too heavy (noise).
  '/wide':
    '<!doctype html><html><head><title>wide</title></head><body><header><img src="/wide.png" alt="logo wide" width="2000" height="30"><img src="/noise.png" alt="brand noise" width="400" height="400"></header><h1>Wide</h1><p>Some text.</p></body></html>',
};

/** Whether openssl is there (the tests skip without it). */
export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A PNG (8-bit RGBA) drawn by `pixel`. */
export function drawPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 4 + 1) + 1 + x * 4;
      const [r, g, b, a] = pixel(x, y);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A rounded badge in the accent colour on a transparent background. */
function badge(w: number, h: number): Buffer {
  const r = Math.min(w, h) / 2;
  return drawPng(w, h, (x, y) => {
    const cx = Math.min(Math.max(x, r), w - r);
    const cy = Math.min(Math.max(y, r), h - r);
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    return inside ? [0x0e, 0x7c, 0x66, 255] : [0, 0, 0, 0];
  });
}

export interface BrandSite {
  port: number;
  escPort: number;
  udpPort: number;
  /** The unsafe test resolver of the fixture's names. */
  testResolve: Map<string, SiteTestTarget>;
  /** RETAKE_UNSAFE_TEST_RESOLVE for a child process. */
  resolveEnv: string;
  /** Requests the site served ("GET www.brand.test/site.css"). */
  hits: string[];
  /** Requests with another method than GET / HEAD (must stay 0). */
  writes: string[];
  /** Cookie headers the site received. */
  cookies: string[];
  /** Connections / packets the escape listeners saw (must stay 0). */
  escape: { tcp: number; udp: number; upgrades: number };
  close(): Promise<void>;
}

/** Start the fixture site and its escape listeners. */
export async function startBrandSite(): Promise<BrandSite> {
  const dir = mkdtempSync(join(tmpdir(), 'brand-site-cert-'));
  const names = ['brand.test', 'www.brand.test', 'cdn.test', 'esc.test', 'hostile.test', 'elsewhere.test'];
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'k.pem'),
      '-out',
      join(dir, 'c.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=brand.test',
      '-addext',
      `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`,
    ],
    { stdio: 'ignore' },
  );
  const key = readFileSync(join(dir, 'k.pem'));
  const cert = readFileSync(join(dir, 'c.pem'));
  rmSync(dir, { recursive: true, force: true });

  const escape = { tcp: 0, udp: 0, upgrades: 0 };
  const esc = createTcpServer((s) => {
    escape.tcp++;
    s.destroy();
  });
  await new Promise<void>((r) => esc.listen(0, '127.0.0.1', () => r()));
  const udp = createSocket('udp4');
  udp.on('message', () => escape.udp++);
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  const escPort = (esc.address() as { port: number }).port;
  const udpPort = udp.address().port;

  const html = readFileSync(join(SITE_DIR, 'index.html'), 'utf8').replaceAll('{{ESC}}', String(escPort)).replaceAll('{{UDP}}', String(udpPort));
  const css = readFileSync(join(SITE_DIR, 'site.css'));
  const logo = badge(96, 48);
  const favicon = badge(64, 64);
  const og = drawPng(600, 315, () => [0x10, 0x15, 0x1c, 255]);
  const wide = drawPng(2000, 30, () => [0x0e, 0x7c, 0x66, 255]);
  const rnd = noise(7);
  const noisy = drawPng(400, 400, () => [rnd(), rnd(), rnd(), 255]);
  const hits: string[] = [];
  const writes: string[] = [];
  const cookies: string[] = [];
  const site = createHttpsServer({ key, cert }, (q, s) => {
    const host = String(q.headers.host ?? '').replace(/:\d+$/, '');
    const path = (q.url ?? '/').split('?')[0];
    hits.push(`${q.method} ${host}${path}`);
    if (q.headers.cookie) cookies.push(String(q.headers.cookie));
    if (q.method !== 'GET' && q.method !== 'HEAD') {
      writes.push(`${q.method} ${host}${path}`);
      s.writeHead(204).end();
      return;
    }
    const send = (type: string, body: Buffer | string, extra: Record<string, string> = {}) => s.writeHead(200, { 'content-type': type, ...extra }).end(body);
    const redirect = (to: string) => s.writeHead(302, { location: to }).end();
    if (host === 'brand.test') {
      // Top-level redirects the extraction must refuse before any browser opens.
      if (path === '/to-literal') return redirect(`https://127.0.0.1:${escPort}/`);
      if (path === '/to-http') return redirect('http://www.brand.test/');
      if (path === '/loop') return redirect('/loop');
      // Another host: the approval of brand.test does not cover it.
      if (path === '/to-other') return redirect('https://elsewhere.test/');
      return redirect('https://www.brand.test/');
    }
    if (host === 'hostile.test') {
      if (path === '/wide.png') return send('image/png', wide);
      if (path === '/noise.png') return send('image/png', noisy);
      const page = HOSTILE_PAGES[path];
      return page ? send('text/html; charset=utf-8', page) : s.writeHead(404).end();
    }
    if (host === 'cdn.test') {
      if (path === '/fonts/text.ttf') return send('font/ttf', readFileSync(FIXTURE_FONTS.text), { 'access-control-allow-origin': '*' });
      if (path === '/og.png') return send('image/png', og);
      if (path === '/redirect-esc') return redirect('https://esc.test/pixel.png');
      if (path === '/redirect-literal') return redirect(`https://127.0.0.1:${escPort}/pixel.png`);
      return s.writeHead(404).end();
    }
    if (path === '/') return send('text/html; charset=utf-8', html, { 'set-cookie': 'sid=fixture; Path=/; Secure' });
    if (path === '/site.css') return send('text/css', css);
    if (path === '/fonts/display.ttf') return send('font/ttf', readFileSync(FIXTURE_FONTS.display));
    if (path === '/logo.png') return send('image/png', logo);
    if (path === '/favicon.png') return send('image/png', favicon);
    if (path === '/redirect-same') return redirect('/redirect-same-done');
    if (path === '/redirect-same-done') return send('text/plain', 'same-host redirect followed');
    if (path === '/sw.js') return send('text/javascript', "self.addEventListener('install', () => fetch('https://esc.test/from-sw', { method: 'POST' }));");
    if (path === '/shared.js') return send('text/javascript', "fetch('https://www.brand.test/api/shared-file', { method: 'POST', body: 'x' }); onconnect = () => {};");
    s.writeHead(404).end();
  });
  site.on('upgrade', (_q, sock) => {
    escape.upgrades++;
    sock.destroy();
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = (site.address() as { port: number }).port;
  const testResolve = new Map<string, SiteTestTarget>([
    ['brand.test', { address: '127.0.0.1', port }],
    ['www.brand.test', { address: '127.0.0.1', port }],
    ['cdn.test', { address: '127.0.0.1', port }],
    // An escape: tunnelled only if something announced it (nothing should).
    ['esc.test', { address: '127.0.0.1', port: escPort }],
    ['hostile.test', { address: '127.0.0.1', port }],
    ['elsewhere.test', { address: '127.0.0.1', port }],
  ]);
  return {
    port,
    escPort,
    udpPort,
    testResolve,
    resolveEnv: [...testResolve].map(([n, t]) => `${n}=${t.address}:${t.port}`).join(','),
    hits,
    writes,
    cookies,
    escape,
    async close() {
      site.closeAllConnections();
      await new Promise<void>((r) => site.close(() => r()));
      await new Promise<void>((r) => esc.close(() => r()));
      await new Promise<void>((r) => udp.close(() => r()));
    },
  };
}
