#!/usr/bin/env node
// Northfield fixture server: ONE Node process serving the supplier console and the buyer shop
// on two ports, sharing one in-memory store and JSON API (/api on both ports).
//
//   node server.mjs [--console-port 4401] [--shop-port 4402] [--host 127.0.0.1] [--no-build]
//                   [--auth-console-port 4403] [--auth-shop-port 4404] [--no-auth] [--smtp host:port]
//   env: NORTHFIELD_CONSOLE_PORT, NORTHFIELD_SHOP_PORT, NORTHFIELD_HOST,
//        NORTHFIELD_AUTH_CONSOLE_PORT, NORTHFIELD_AUTH_SHOP_PORT, NORTHFIELD_SMTP (mails also delivered there),
//        NORTHFIELD_ENRICH_MS (default 4000), NORTHFIELD_IMPORT_MS (default 2000),
//        NORTHFIELD_REPORT_MS (default 400), NORTHFIELD_REPORT_DATA_MS (default 1200)
//
// The same two apps also run on a signed-in side (:4403 / :4404 by default, same store): every page there needs an
// account (server/auth.mjs). Also importable: `const fx = await startFixture({ consolePort: 0, shopPort: 0,
// auth: { consolePort: 0, shopPort: 0 } }); … await fx.close()` (no `auth`: no signed-in side).
// No npm package is needed at run time: esbuild is loaded only when the bundle must be built (--no-build: never), and
// playwright-core only when a PDF is printed — the fixture's Docker image (Dockerfile) runs on Node alone.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bundleState, bundleVersion, OUT_DIR } from './bundle.mjs';
import { handleApi } from './server/api.mjs';
import { Sessions, handleSignIn, redirectToSignIn, signedIn } from './server/auth.mjs';
import { renderShippingEmbed } from './server/embed.mjs';
import { renderInspectLab } from './server/inspect-lab.mjs';
import { sendError, sendJson, sendText } from './server/http.mjs';
import { Mailbox, handleMailbox } from './server/mailbox.mjs';
import { quotePdfFileName, renderNotFoundPdf, renderQuotePdf, renderQuotePrint } from './server/pdf.mjs';
import { REPORT_DATA_MS, REPORT_MS, renderReport, renderReportList, reportFragment } from './server/reports.mjs';
import { closePdfBrowser, htmlToPdf } from './server/pdfgen.mjs';
import { SmtpRelay } from './server/smtp.mjs';
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

/**
 * One app (console or shop) of one side. On the signed-in side (`ctx.signIn`) every page needs a session of that app
 * — else 302 to /sign-in — except the API, the mailbox, the bundle and the icons (hooks and tests keep working).
 */
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
    if ((path === '/mailbox' || path.startsWith('/mailbox/')) && handleMailbox(req, res, url, ctx.mailbox)) return;
    if (ctx.signIn && (await handleSignIn(req, res, url, ctx.sessions, appKey))) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'method_not_allowed', `${req.method} is only supported under /api`);
    }
    if (path.startsWith('/build/')) return serveBuildFile(res, path);
    if (path === '/favicon.svg' || path === '/favicon.ico') return sendText(res, 200, 'image/svg+xml', FAVICON);
    if (path === '/app-icon.svg') return sendText(res, 200, 'image/svg+xml', FAVICON);
    if (ctx.signIn && !signedIn(req, ctx.sessions, appKey)) return redirectToSignIn(res, url);
    if (appKey === 'console') {
      // "Sales reports": server-rendered pages, every link a full page load (R-ISS-08).
      if (path === '/reports' || path === '/reports/') return sendText(res, 200, 'text/html; charset=utf-8', renderReportList(), { 'cache-control': 'no-store' });
      const month = /^\/reports\/([^/]+)(\/data)?\/?$/.exec(path);
      if (month) {
        const key = decodeURIComponent(month[1]);
        await new Promise((resolve) => setTimeout(resolve, month[2] ? ctx.reports.dataMs : ctx.reports.ms));
        const html = month[2] ? reportFragment(key) : renderReport(key);
        if (!html) return sendError(res, 404, 'not_found', `No sales report for ${key}`);
        if (month[2]) return sendJson(res, 200, { month: key, html });
        return sendText(res, 200, 'text/html; charset=utf-8', html, { 'cache-control': 'no-store' });
      }
    }
    if (appKey === 'shop') {
      // The inspection lab (page_inspect, L3.3): ambiguous buttons, generated ids, injection text, frames, a long table.
      if (path === '/inspect-lab') {
        const html = renderInspectLab({ dialog: url.searchParams.get('dialog') === '1', rows: Number(url.searchParams.get('rows') ?? 0), crossOrigin: ctx.urls.console });
        return sendText(res, 200, 'text/html; charset=utf-8', html, { 'cache-control': 'no-store' });
      }
      // The product page's "Shipping estimate" widget, shown in a same-origin iframe (R-ISS-07).
      if (path === '/embed/shipping') {
        let product = null;
        try {
          product = ctx.store.getProduct(url.searchParams.get('product') ?? '');
        } catch {
          /* unknown product: a generic estimate */
        }
        return sendText(res, 200, 'text/html; charset=utf-8', renderShippingEmbed(product), { 'cache-control': 'no-store' });
      }
      // A real PDF of the quote (printed by Chromium from the quote document), shown inline in a new tab.
      const real = /^\/quotes\/([^/]+)\/quote\.pdf$/.exec(path);
      if (real) {
        let quote;
        try {
          quote = ctx.store.getQuote(decodeURIComponent(real[1]));
        } catch {
          return sendError(res, 404, 'not_found', `Quote ${real[1]} was not found`);
        }
        const html = renderQuotePrint(quote);
        if (!html) return sendError(res, 404, 'no_proposal', `Quote ${quote.reference} has no proposal yet`);
        try {
          const pdf = await htmlToPdf(html);
          return sendText(res, 200, 'application/pdf', pdf, {
            'content-disposition': `inline; filename="${quotePdfFileName(quote)}"`,
            'cache-control': 'no-store',
          });
        } catch (err) {
          return sendError(res, 500, 'pdf_failed', `The PDF could not be printed: ${err instanceof Error ? err.message : err}`);
        }
      }
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
        throw new Error(`Port ${actual} (${label}) is already in use on ${host}; pick another one with --${label}-port or NORTHFIELD_${label.toUpperCase().replace(/-/g, '_')}_PORT`);
      }
      throw new Error(`Cannot listen on ${host}:${actual} (${label}): ${err.message}`);
    }
  }
  return { servers, port: actual };
}

/**
 * Starts both apps, and their signed-in side when `auth` is given. Ports may be 0 (ephemeral). A busy signed-in port
 * with `auth.optional` is reported through `log` and the open side keeps running. `smtp` ("host:port"): every mail is
 * also delivered to that SMTP server (server/smtp.mjs).
 * @param {{ consolePort?: number, shopPort?: number, host?: string, build?: boolean, enrichMs?: number, importMs?: number, reportMs?: number, reportDataMs?: number, auth?: { consolePort?: number, shopPort?: number, optional?: boolean }, smtp?: string, log?: (msg: string) => void }} [opts]
 */
export async function startFixture(opts = {}) {
  const log = opts.log ?? (() => {});
  if (opts.build !== false) {
    const state = await bundleState();
    if (!state.fresh) {
      log(`Building the UI bundle (${state.reason})…`);
      const { build } = await import('./build.mjs');
      const { ms } = await build();
      log(`Built in ${ms} ms`);
    }
  }
  const hosts = opts.host ? [opts.host] : ['127.0.0.1', '::1'];
  const urlHost = !opts.host || opts.host === '127.0.0.1' || opts.host === '::1' || opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
  const store = new Store({ enrichMs: opts.enrichMs, importMs: opts.importMs });
  const sessions = new Sessions();
  const relay = opts.smtp ? new SmtpRelay(opts.smtp, { log }) : null;
  const ctx = {
    store,
    mailbox: new Mailbox({ relay }),
    sessions,
    urls: { console: '', shop: '' },
    version: await bundleVersion(),
    reports: { ms: opts.reportMs ?? REPORT_MS, dataMs: opts.reportDataMs ?? REPORT_DATA_MS },
  };
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
  // The signed-in side: same store, mailbox and API; its own URLs (the shop's "Supplier console" link, e-mail links).
  let signedIn = null;
  if (opts.auth) {
    const side = { ...ctx, urls: { console: '', shop: '' }, signIn: true };
    const started = [];
    try {
      const c = await listenAll(appHandler('console', side), opts.auth.consolePort ?? 4403, hosts, 'auth-console');
      started.push(...c.servers);
      const sh = await listenAll(appHandler('shop', side), opts.auth.shopPort ?? 4404, hosts, 'auth-shop');
      started.push(...sh.servers);
      side.urls.console = `http://${urlHost}:${c.port}`;
      side.urls.shop = `http://${urlHost}:${sh.port}`;
      signedIn = side.urls;
      servers.push(...started);
    } catch (err) {
      for (const s of started) s.close();
      if (!opts.auth.optional) {
        for (const s of servers) s.close();
        throw err;
      }
      log(`Signed-in side not started: ${err instanceof Error ? err.message : err}`);
    }
  }
  let closing;
  return {
    urls: { ...ctx.urls, ...(signedIn ? { signedIn } : {}) },
    smtp: relay?.label ?? null,
    store,
    mailbox: ctx.mailbox,
    sessions,
    /** End every session of the signed-in side, or one persona's (supplier, buyer); returns how many ended. */
    expireSessions: (persona) => sessions.expire(persona),
    close() {
      closing ??= Promise.all([
        closePdfBrowser(),
        ctx.mailbox.flush(),
        ...
        servers.map(
          (s) =>
            new Promise((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
      ]).then(() => undefined);
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
      'auth-console-port': { type: 'string' },
      'auth-shop-port': { type: 'string' },
      'no-auth': { type: 'boolean' },
      host: { type: 'string' },
      'no-build': { type: 'boolean' },
      smtp: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: node server.mjs [--console-port 4401] [--shop-port 4402] [--auth-console-port 4403] [--auth-shop-port 4404] [--no-auth] [--host 127.0.0.1] [--no-build] [--smtp host:port]');
    return;
  }
  const fixture = await startFixture({
    consolePort: portOption(values['console-port'] ?? process.env.NORTHFIELD_CONSOLE_PORT, 'console port') ?? 4401,
    shopPort: portOption(values['shop-port'] ?? process.env.NORTHFIELD_SHOP_PORT, 'shop port') ?? 4402,
    host: values.host ?? (process.env.NORTHFIELD_HOST || undefined),
    build: !values['no-build'],
    enrichMs: msOption(process.env.NORTHFIELD_ENRICH_MS, 'NORTHFIELD_ENRICH_MS'),
    importMs: msOption(process.env.NORTHFIELD_IMPORT_MS, 'NORTHFIELD_IMPORT_MS'),
    reportMs: msOption(process.env.NORTHFIELD_REPORT_MS, 'NORTHFIELD_REPORT_MS'),
    reportDataMs: msOption(process.env.NORTHFIELD_REPORT_DATA_MS, 'NORTHFIELD_REPORT_DATA_MS'),
    // The signed-in side is on by default; a busy port only skips it (the open side keeps working).
    auth: values['no-auth']
      ? undefined
      : {
          consolePort: portOption(values['auth-console-port'] ?? process.env.NORTHFIELD_AUTH_CONSOLE_PORT, 'auth console port') ?? 4403,
          shopPort: portOption(values['auth-shop-port'] ?? process.env.NORTHFIELD_AUTH_SHOP_PORT, 'auth shop port') ?? 4404,
          optional: true,
        },
    smtp: values.smtp ?? (process.env.NORTHFIELD_SMTP || undefined),
    log: (m) => console.log(m),
  });
  console.log('Northfield fixture is running');
  console.log(`  Console  ${fixture.urls.console}`);
  console.log(`  Shop     ${fixture.urls.shop}`);
  if (fixture.urls.signedIn) {
    console.log(`  Signed in: console ${fixture.urls.signedIn.console}, shop ${fixture.urls.signedIn.shop}  (accounts: fixtures/wholesale/README.md; POST /api/auth/expire signs everyone out)`);
  }
  console.log(`  API      ${fixture.urls.console}/api  (same store on both ports; POST /api/reset restores the seed)`);
  console.log(`  Mailbox  ${fixture.urls.console}/mailbox  (Mailpit-compatible API: /mailbox/api/v1/messages)`);
  if (fixture.smtp) console.log(`  SMTP     every mail is also delivered to ${fixture.smtp}`);
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
