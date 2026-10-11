#!/usr/bin/env node
// Northfield fixture server: ONE Node process serving the supplier console and the buyer shop
// on two ports, sharing one in-memory store and JSON API (/api on both ports).
//
//   node server.mjs [--console-port 4401] [--shop-port 4402] [--host 127.0.0.1] [--no-build]
//   env: NORTHFIELD_CONSOLE_PORT, NORTHFIELD_SHOP_PORT, NORTHFIELD_HOST,
//        NORTHFIELD_ENRICH_MS (default 4000), NORTHFIELD_IMPORT_MS (default 2000)
//
// Also importable: `const fx = await startFixture({ consolePort: 0, shopPort: 0 }); … await fx.close()`.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build, bundleState, bundleVersion, OUT_DIR } from './build.mjs';
import { handleApi } from './server/api.mjs';
import { sendError, sendText } from './server/http.mjs';
import { renderNotFoundPdf, renderQuotePdf } from './server/pdf.mjs';
import { Store } from './server/store.mjs';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const APPS = {
  console: { title: 'Northfield · Supplier console', bundle: 'console' },
  shop: { title: 'Northfield · Specialty coffee for cafés', bundle: 'shop' },
};

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6e1f2b"/><path d="M16 6c5.2 0 8.5 4.3 8.5 10S21 26 16 26s-8.5-4.3-8.5-10S10.8 6 16 6Z" fill="#f6e7d8"/><path d="M16.8 7.6c-3.2 3.3-3.3 6.6-.7 9.8 2.4 3 2.2 6.1-.8 9.2" fill="none" stroke="#6e1f2b" stroke-width="2" stroke-linecap="round"/></svg>`;

const escAttr = (s) => s.replace(/</g, '\\u003c');

function shellHtml(appKey, ctx, version) {
  const app = APPS[appKey];
  const boot = { app: appKey, urls: ctx.urls, session: ctx.store.session() };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${app.title}</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/build/${app.bundle}.css?v=${version}">
<style>html,body{background:#f7f3ee;margin:0}</style>
<script>window.__NORTHFIELD__=${escAttr(JSON.stringify(boot))};</script>
</head>
<body>
<div id="root"></div>
<script type="module" src="/build/${app.bundle}.js?v=${version}"></script>
</body>
</html>`;
}

async function serveBuildFile(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname.slice('/build/'.length)));
  const file = join(OUT_DIR, rel);
  if (!file.startsWith(OUT_DIR + sep)) return sendError(res, 400, 'bad_path', 'Invalid asset path');
  try {
    const body = await readFile(file);
    sendText(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', body, { 'cache-control': 'no-cache' });
  } catch {
    sendError(res, 404, 'not_found', `No build asset ${pathname} (run "node build.mjs")`);
  }
}

function appHandler(appKey, ctx) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://fixture.local');
    } catch {
      return sendError(res, 400, 'bad_url', 'Malformed request URL');
    }
    const path = url.pathname;
    if (path === '/api' || path.startsWith('/api/')) return handleApi(req, res, url, ctx);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'method_not_allowed', `${req.method} is only supported under /api`);
    }
    if (path.startsWith('/build/')) return serveBuildFile(res, path);
    if (path === '/favicon.svg' || path === '/favicon.ico') return sendText(res, 200, 'image/svg+xml', FAVICON);
    if (appKey === 'shop') {
      const pdf = /^\/quotes\/([^/]+)\/pdf\/?$/.exec(path);
      if (pdf) {
        try {
          return sendText(res, 200, 'text/html; charset=utf-8', renderQuotePdf(ctx.store.getQuote(decodeURIComponent(pdf[1]))));
        } catch {
          return sendText(res, 404, 'text/html; charset=utf-8', renderNotFoundPdf(decodeURIComponent(pdf[1])));
        }
      }
    }
    // SPA fallback: every other path renders the app shell (deep links work on full page loads).
    sendText(res, 200, 'text/html; charset=utf-8', shellHtml(appKey, ctx, ctx.version), { 'cache-control': 'no-store' });
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Listens on every host (default: IPv4 + IPv6 loopback, so "localhost" works either way). */
async function listenAll(handler, port, hosts, label) {
  const servers = [];
  let actual = port;
  for (const [i, host] of hosts.entries()) {
    const server = http.createServer(handler);
    server.keepAliveTimeout = 5000;
    try {
      actual = await listen(server, actual, host);
      servers.push(server);
    } catch (err) {
      const optionalV6 = i > 0 && host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code);
      if (optionalV6) continue;
      for (const s of servers) s.close();
      if (err.code === 'EADDRINUSE') {
        throw new Error(`Port ${actual} (${label}) is already in use on ${host}; pick another one with --${label}-port or NORTHFIELD_${label.toUpperCase()}_PORT`);
      }
      throw new Error(`Cannot listen on ${host}:${actual} (${label}): ${err.message}`);
    }
  }
  return { servers, port: actual };
}

/**
 * Starts both apps. Ports may be 0 (ephemeral).
 * @param {{ consolePort?: number, shopPort?: number, host?: string, build?: boolean, enrichMs?: number, importMs?: number, log?: (msg: string) => void }} [opts]
 */
export async function startFixture(opts = {}) {
  const log = opts.log ?? (() => {});
  if (opts.build !== false) {
    const state = await bundleState();
    if (!state.fresh) {
      log(`Building the UI bundle (${state.reason})…`);
      const { ms } = await build();
      log(`Built in ${ms} ms`);
    }
  }
  const hosts = opts.host ? [opts.host] : ['127.0.0.1', '::1'];
  const urlHost = !opts.host || opts.host === '127.0.0.1' || opts.host === '::1' || opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
  const store = new Store({ enrichMs: opts.enrichMs, importMs: opts.importMs });
  const ctx = { store, urls: { console: '', shop: '' }, version: await bundleVersion() };
  const consoleSide = await listenAll(appHandler('console', ctx), opts.consolePort ?? 4401, hosts, 'console');
  let shopSide;
  try {
    shopSide = await listenAll(appHandler('shop', ctx), opts.shopPort ?? 4402, hosts, 'shop');
  } catch (err) {
    for (const s of consoleSide.servers) s.close();
    throw err;
  }
  ctx.urls.console = `http://${urlHost}:${consoleSide.port}`;
  ctx.urls.shop = `http://${urlHost}:${shopSide.port}`;
  const servers = [...consoleSide.servers, ...shopSide.servers];
  let closing;
  return {
    urls: ctx.urls,
    store,
    close() {
      closing ??= Promise.all(
        servers.map(
          (s) =>
            new Promise((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
      ).then(() => undefined);
      return closing;
    },
  };
}

function portOption(value, name) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number (0-65535), got "${value}"`);
  return n;
}

function msOption(value, name) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of milliseconds, got "${value}"`);
  return n;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'console-port': { type: 'string' },
      'shop-port': { type: 'string' },
      host: { type: 'string' },
      'no-build': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: node server.mjs [--console-port 4401] [--shop-port 4402] [--host 127.0.0.1] [--no-build]');
    return;
  }
  const fixture = await startFixture({
    consolePort: portOption(values['console-port'] ?? process.env.NORTHFIELD_CONSOLE_PORT, 'console port') ?? 4401,
    shopPort: portOption(values['shop-port'] ?? process.env.NORTHFIELD_SHOP_PORT, 'shop port') ?? 4402,
    host: values.host ?? (process.env.NORTHFIELD_HOST || undefined),
    build: !values['no-build'],
    enrichMs: msOption(process.env.NORTHFIELD_ENRICH_MS, 'NORTHFIELD_ENRICH_MS'),
    importMs: msOption(process.env.NORTHFIELD_IMPORT_MS, 'NORTHFIELD_IMPORT_MS'),
    log: (m) => console.log(m),
  });
  console.log('Northfield fixture is running');
  console.log(`  Console  ${fixture.urls.console}`);
  console.log(`  Shop     ${fixture.urls.shop}`);
  console.log(`  API      ${fixture.urls.console}/api  (same store on both ports; POST /api/reset restores the seed)`);
  const stop = (signal) => {
    console.log(`Received ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(0), 2000);
    force.unref();
    fixture.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`Northfield fixture failed to start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
