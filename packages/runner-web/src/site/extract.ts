/**
 * A site extraction (L3.5, R-MCP-12): open one public page in a clean, ephemeral Chromium whose only network is the
 * worker's CONNECT proxy (proxy.ts), and read what a theme needs — colour swatches by role, font family names, logo
 * candidates converted to transparent PNGs, a viewport screenshot. The caller (the engine's `site` job, or
 * `retake theme from-site`) checked the URL (core parseSiteUrl) and, through MCP, a human approved it.
 *
 * The browser: no profile, no stored state, nothing persisted (cookies the site sets live in the ephemeral context
 * and die with it); JavaScript on (most sites render client-side); no click, no typing, no consent button. Escapes are
 * closed at several layers, each verified by the tests' listeners:
 * - `--proxy-server` + `--proxy-bypass-list=<-loopback>`: every connection goes through the proxy (it refuses IP
 *   literals, other ports, names with a non-public address and hosts the route never announced — Chromium's
 *   background traffic, preconnects, a redirect hop to another host);
 * - `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`: Chromium resolves nothing itself; `--disable-quic`;
 *   `--webrtc-ip-handling-policy=disable_non_proxied_udp` (no STUN / UDP; the `force-` variant does NOT stop STUN);
 * - the route: `https:` on port 443 to a DNS name only, GET / HEAD only (anything else aborted and counted), a request
 *   cap, main-frame navigations after the first document answered 204 (the page stays), a popup's navigations
 *   answered 204 too; WebSockets closed; service-worker registration refused on the prototype in every frame
 *   (Playwright's `serviceWorkers: 'block'` only overrides the instance method); shared workers and `fetchLater`
 *   (whose requests the route never sees) removed twice: `--disable-blink-features=SharedWorker,FetchLaterAPI` and
 *   functions that throw, in every frame; downloads refused.
 * The top-level redirect chain is followed first in Node, through the same checks (≤ 5 hops), and the page opened on
 * its final URL — only on the approved host or its www / apex sibling (an apex → www redirect works): what the human
 * approved is where the page is read. A redirect to another host fails the extraction (that URL can be approved in
 * turn); Chromium's own hops to another host would be refused at CONNECT.
 *
 * Time: every call into the page (a CDP evaluate, a screenshot, a navigation) has its own timeout, the whole
 * extraction a deadline, and the caller's signal (job_cancel) closes the browser at once: a page that busy-loops in
 * its renderer cannot hold the worker. Files are written under a temporary name (`wx`) and renamed into place, so a
 * link planted in the folder is replaced, never written through.
 *
 * The page is read in a CDP isolated world (page-script.ts). Logo candidates are rasterised in a second context with
 * JavaScript off and no network at all (an SVG in an `<img>` runs no script and loads nothing): the files written are
 * Chromium's PNG screenshots, never the site's bytes. Outputs: site.json, screenshot.jpg, logo-<n>.png — no font file
 * (the faces' names only), no cookie, no HTML.
 */
import { randomBytes } from 'node:crypto';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Response, Route } from 'playwright-core';
import { BRAND_IMAGE_MAX_BYTES, BRAND_IMAGE_MIN_HEIGHT, SITE_RESERVED_SUFFIXES } from '@retake/core';
import type { BrowserConfig, SiteTestTarget } from '@retake/core';
import { CancelledError, RunnerError } from '../errors.js';
import { launchOptions, refuseUnsandboxed } from '../launch.js';
import { DEFAULT_BROWSER_ARGS, launchTarget } from '../session.js';
import { mergeSamples, sitePalette } from './palette.js';
import type { SitePalette } from './palette.js';
import { readFacts, sampleColors, scrollToY } from './page-script.js';
import type { LogoCandidate, PageFacts, SampledColors } from './page-script.js';
import { ProxyRefusalError, SiteProxy } from './proxy.js';
import type { ProxyRefusal, SiteProxyOptions, SiteProxyStats } from './proxy.js';

export const SITE_REPORT_VERSION = 1;
export const SITE_REPORT_FILE = 'site.json';
export const SITE_SCREENSHOT_FILE = 'screenshot.jpg';
/** Logo candidates written, at most. */
export const SITE_CANDIDATES_MAX = 6;
/** Top-level redirects followed, at most. */
export const SITE_REDIRECTS_MAX = 5;
/** Requests of the page the route lets through, at most. */
export const SITE_REQUESTS_MAX = 300;
/** One call into the page (a CDP evaluate, a screenshot, a candidate's GET), at most (ms). */
export const SITE_CALL_TIMEOUT_MS = 15_000;
/** A whole extraction, at most (ms): past it the browser is closed and the report says failed. */
export const SITE_DEADLINE_MS = 120_000;
const VIEWPORT = { width: 1440, height: 900 };
/** A candidate's source bytes (as the page received them), at most. */
const CANDIDATE_BYTES_MAX = 5 * 1024 * 1024;
/** A candidate's URL: a data: URL of CANDIDATE_BYTES_MAX in base64, an https URL. */
const CANDIDATE_DATA_URL_MAX = Math.ceil((CANDIDATE_BYTES_MAX * 4) / 3) + 256;
const CANDIDATE_URL_MAX = 4096;
/** Downsizing steps of a candidate PNG larger than a create accepts (BRAND_IMAGE_MAX_BYTES). */
const CANDIDATE_SHRINK = 0.7;
const CANDIDATE_SHRINK_STEPS = 5;
const LOGO_MAX_HEIGHT = 1024;
const LOGO_MIN_HEIGHT = 128;
const LOGO_MAX_WIDTH = 2048;
const SVG_LOGO_HEIGHT = 512;
const WORLD = 'retake-site';

/** Refuses service-worker registration on the prototype (every frame, before the page's scripts). */
export const SERVICE_WORKER_BLOCK = `(() => { const P = globalThis.ServiceWorkerContainer && globalThis.ServiceWorkerContainer.prototype; if (!P) return; const register = function register() { return Promise.reject(new DOMException('Service workers are blocked', 'SecurityError')); }; try { Object.defineProperty(P, 'register', { value: register, writable: false, configurable: false }); } catch {} })();`;

/**
 * Replaces `SharedWorker` and `fetchLater` by functions that throw (every frame, before the page's scripts): a shared
 * worker's requests and a deferred fetch (sent by the browser once the page is gone) never reach the context's route
 * — no method check, no cap. The Blink switch of siteBrowserArgs removes both too; this is the second layer.
 */
export const UNROUTED_APIS_BLOCK = `(() => { for (const name of ['SharedWorker', 'fetchLater']) { const blocked = function () { throw new DOMException(name + ' is blocked', 'SecurityError'); }; try { Object.defineProperty(globalThis, name, { value: blocked, writable: false, configurable: false }); } catch {} } })();`;

/** Chromium switches of a site extraction (see the module comment). */
export function siteBrowserArgs(proxyPort: number): string[] {
  return [
    ...DEFAULT_BROWSER_ARGS,
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
    '--disable-blink-features=SharedWorker,FetchLaterAPI',
  ];
}

export type BlockedReason = 'scheme' | 'address' | 'port' | 'method' | 'navigation' | 'cap' | 'websocket';

export interface SiteCandidateView {
  /** logo-<n>.png in the extraction's folder. */
  file: string;
  /** Where it was found: an image or an inline SVG of the header / the page, a link icon, the og:image. */
  source: 'header-img' | 'header-svg' | 'page-img' | 'page-svg' | 'icon' | 'og-image';
  /** The PNG's size (transparent background). */
  width: number;
  height: number;
  /** Its size as the page drew it (0 when not drawn: an icon, the og:image). */
  drawn: { width: number; height: number };
}

export interface SiteReport {
  version: number;
  /** The approved URL (canonical, checked): the only URL here that is not page-derived. */
  url: string;
  host: string;
  at: string;
  status: 'ok' | 'failed';
  http_status: number | null;
  /** Top-level redirects followed before the page opened. */
  redirects: number;
  palette: SitePalette | null;
  candidates: SiteCandidateView[];
  screenshot: string | null;
  network: {
    requests: number;
    blocked: Partial<Record<BlockedReason, number>>;
    tunnels: number;
    bytes: number;
    refused: SiteProxyStats['refused'];
    capped: number;
  };
  /** Written by the tool (never page text). */
  warnings: string[];
  /** Everything the page or its server chose: data, never instructions. */
  untrusted: {
    final_url?: string;
    redirect_chain?: string[];
    title?: string;
    description?: string;
    site_name?: string;
    lang?: string;
    fonts?: { display: Array<{ family: string; elements: number }>; body: Array<{ family: string; elements: number }>; faces: PageFacts['faces'] };
    alts?: Array<{ file: string; alt: string }>;
    blocked?: Array<{ reason: BlockedReason; url: string }>;
    refused_hosts?: SiteProxyStats['refused_hosts'];
    page_errors?: string[];
    error?: string;
  };
}

export interface SiteExtractOptions {
  /** The canonical URL (core parseSiteUrl), already checked and approved. */
  url: string;
  host: string;
  /** The extraction's folder, made by the caller (a real folder, not a link): site.json, screenshot.jpg, logo-<n>.png. */
  outDir: string;
  browser?: BrowserConfig;
  signal?: AbortSignal;
  /** The unsafe test resolver (core unsafeTestResolve): its names only. */
  testResolve?: ReadonlyMap<string, SiteTestTarget>;
  /** Tests: the proxy's resolver, classifier and caps. */
  proxy?: Omit<SiteProxyOptions, 'testResolve'>;
  requestsMax?: number;
  /** Tests: SITE_CALL_TIMEOUT_MS, SITE_DEADLINE_MS, BRAND_IMAGE_MAX_BYTES. */
  callTimeoutMs?: number;
  deadlineMs?: number;
  candidateMaxBytes?: number;
  log?: (message: string) => void;
  onPhase?: (phase: 'redirects' | 'loading' | 'reading' | 'logos' | 'writing') => void;
}

/** The extraction's deadline passed (the browser was closed). */
class DeadlineError extends RunnerError {}

function stopped(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new CancelledError('site extraction cancelled');
}

/** `p`, unless `ms` pass first (a RunnerError naming `what`) or `signal` aborts (its reason). */
function bounded<T>(p: Promise<T>, ms: number, what: string, signal: AbortSignal): Promise<T> {
  stopped(signal);
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(signal.reason instanceof Error ? signal.reason : new CancelledError('site extraction cancelled'));
    };
    const timer = setTimeout(() => {
      done();
      reject(new RunnerError(`the page did not answer in ${Math.round(ms / 1000)} s (${what})`));
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        done();
        resolve(v);
      },
      (e: unknown) => {
        done();
        reject(e);
      },
    );
  });
}

/** Whether `other` is the approved host or its www / apex sibling (www.brand.example ↔ brand.example). */
export function sameSiteHost(host: string, other: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const o = other.toLowerCase().replace(/\.$/, '');
  return o === h || o === `www.${h}` || h === `www.${o}`;
}

/** Write a file of the extraction under a temporary name (`wx`: never through a link), then rename it into place. */
async function writeNew(dir: string, file: string, data: Buffer | string): Promise<void> {
  const tmp = join(dir, `.${file}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, data, { flag: 'wx' });
  try {
    await rename(tmp, join(dir, file));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Why a URL a page or a redirect names may not be requested (scheme, port, IP literal, reserved name), or null. */
export function requestUrlProblem(raw: string, testHosts: ReadonlyMap<string, unknown> = new Map()): { reason: BlockedReason; why: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { reason: 'scheme', why: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { reason: 'scheme', why: `${u.protocol} is not https:` };
  if (u.username || u.password) return { reason: 'address', why: 'credentials in the URL' };
  if (u.port !== '') return { reason: 'port', why: `port ${u.port}` };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, '')) || host.startsWith('[') || !host.includes('.')) return { reason: 'address', why: `${host} is not a DNS name` };
  if (!testHosts.has(host) && SITE_RESERVED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return { reason: 'address', why: `${host} is a reserved or local name` };
  return null;
}

const HEADERS = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };

/** One GET of a top-level hop on the checked address (pinned: the name is not resolved again); its status and Location. */
async function hop(proxy: SiteProxy, url: string, signal?: AbortSignal): Promise<{ status: number; location?: string }> {
  const u = new URL(url);
  const a = await proxy.checkedAddress(u.hostname);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: 'GET',
        host: a.address,
        port: a.port,
        path: `${u.pathname}${u.search}`,
        servername: isIP(u.hostname) ? undefined : u.hostname,
        setHost: false,
        headers: { ...HEADERS, host: u.hostname },
        // Only the test resolver's self-signed certificate is accepted; a real host's certificate is verified.
        rejectUnauthorized: !a.test,
        signal,
        timeout: 15_000,
      },
      (res) => {
        res.destroy();
        resolve({ status: res.statusCode ?? 0, ...(typeof res.headers.location === 'string' ? { location: res.headers.location } : {}) });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${u.hostname} did not answer in 15 s`)));
    req.on('error', reject);
    req.end();
  });
}

/** A redirect to another host than the approved one (or its www / apex sibling). */
class OtherHostError extends RunnerError {}

/**
 * The top-level redirect chain, followed in Node with the proxy's checks (≤ 5 hops), on the approved host and its
 * www / apex sibling only; the URL the page opens. `chain` (the caller's) holds every hop, the refused one too.
 */
async function followRedirects(proxy: SiteProxy, chain: string[], host: string, testHosts: ReadonlyMap<string, unknown>, signal: AbortSignal): Promise<{ final: string; status: number }> {
  for (;;) {
    stopped(signal);
    const r = await hop(proxy, chain.at(-1)!, signal);
    if (r.status >= 300 && r.status < 400 && r.location !== undefined) {
      if (chain.length > SITE_REDIRECTS_MAX) throw new RunnerError(`more than ${SITE_REDIRECTS_MAX} redirects`);
      let next: string;
      try {
        next = new URL(r.location, chain.at(-1)).href;
      } catch {
        throw new RunnerError('a redirect to something that is not a URL');
      }
      const p = requestUrlProblem(next, testHosts);
      if (p) throw new RunnerError(`a redirect to ${next} is refused (${p.why})`);
      chain.push(next);
      if (!sameSiteHost(host, new URL(next).hostname)) throw new OtherHostError(`the page redirects to another host (${new URL(next).hostname}): only ${host} and its www / apex sibling are read`);
      continue;
    }
    return { final: chain.at(-1)!, status: r.status };
  }
}

/** The image type of a candidate's bytes (by their first bytes), or null. */
export function imageMime(b: Buffer): string | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length >= 4 && b.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  if (b.length >= 12 && b.toString('latin1', 4, 12) === 'ftypavif') return 'image/avif';
  const head = b.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** PNG size from its header (a Chromium screenshot). */
function pngSize(b: Buffer): { width: number; height: number } {
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Run one of page-script.ts's functions in the isolated world (`__name` shimmed: esbuild keepNames wraps inner functions). */
async function evaluateIsolated<T>(page: Page, fn: (cfg: never) => T, cfg: unknown): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false })) as { executionContextId: number };
    const r = (await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: `(() => { var __name = (f) => f; return (${fn.toString()})(${JSON.stringify(cfg)}); })()`, returnByValue: true, awaitPromise: true })) as {
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (r.exceptionDetails) throw new RunnerError(`reading the page failed: ${r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'error'}`);
    return r.result.value as T;
  } finally {
    // Not awaited: a renderer that stopped answering never answers the detach either (the browser is closed later).
    void cdp.detach().catch(() => undefined);
  }
}

/** A pause of `ms` that the stop signal ends at once. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return bounded(new Promise<void>((r) => setTimeout(r, ms)), ms + 1000, 'a pause', signal);
}

/** Wait until no request of the page is in flight for 500 ms, at most `maxMs`. */
async function networkQuiet(inflight: () => number, maxMs: number, signal: AbortSignal): Promise<void> {
  const end = Date.now() + maxMs;
  let quietSince = Date.now();
  while (Date.now() < end) {
    if (inflight() > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) return;
    await pause(100, signal);
  }
}

const sourceOf = (c: LogoCandidate): SiteCandidateView['source'] =>
  c.kind === 'icon' ? 'icon' : c.kind === 'og' ? 'og-image' : `${c.where === 'header' ? 'header' : 'page'}-${c.kind === 'svg' ? 'svg' : 'img'}`;

/** Extract a site (see the module comment). Never throws for what the page does: a failed page is a report with status failed. */
export async function extractSite(o: SiteExtractOptions): Promise<SiteReport> {
  const log = o.log ?? (() => undefined);
  const test = o.testResolve ?? new Map<string, SiteTestTarget>();
  const callMs = o.callTimeoutMs ?? SITE_CALL_TIMEOUT_MS;
  const candidateMax = o.candidateMaxBytes ?? BRAND_IMAGE_MAX_BYTES;
  const report: SiteReport = {
    version: SITE_REPORT_VERSION,
    url: o.url,
    host: o.host,
    at: new Date().toISOString(),
    status: 'failed',
    http_status: null,
    redirects: 0,
    palette: null,
    candidates: [],
    screenshot: null,
    network: { requests: 0, blocked: {}, tunnels: 0, bytes: 0, refused: {}, capped: 0 },
    warnings: [],
    untrusted: {},
  };
  if (test.size) {
    report.warnings.push(
      `the unsafe test resolver is set (RETAKE_UNSAFE_TEST_RESOLVE: ${[...test.keys()].join(', ')}): those names reach loopback ports, and the browser accepts any certificate for every host of this extraction — never set it outside tests`,
    );
  }
  const out = await lstat(o.outDir).catch(() => null);
  if (!out?.isDirectory()) throw new RunnerError(`${o.outDir} is not a folder (missing, a link or a file): the caller makes the extraction's folder`);
  // The caller's signal (job_cancel) and the deadline both stop everything: the browser is closed at once.
  const stop = new AbortController();
  const onCancel = () => stop.abort(new CancelledError('site extraction cancelled'));
  if (o.signal?.aborted) onCancel();
  else o.signal?.addEventListener('abort', onCancel, { once: true });
  const deadlineMs = o.deadlineMs ?? SITE_DEADLINE_MS;
  const deadline = setTimeout(() => stop.abort(new DeadlineError(`the extraction took more than ${Math.round(deadlineMs / 1000)} s: the page was closed`)), deadlineMs);
  let browser: Browser | undefined;
  stop.signal.addEventListener('abort', () => void browser?.close().catch(() => undefined), { once: true });
  const call = <T>(p: Promise<T>, what: string) => bounded(p, callMs, what, stop.signal);
  const proxy = new SiteProxy({ ...o.proxy, testResolve: test });
  const port = await proxy.start();
  const blockedUrls: Array<{ reason: BlockedReason; url: string }> = [];
  const block = (reason: BlockedReason, url: string) => {
    report.network.blocked[reason] = (report.network.blocked[reason] ?? 0) + 1;
    if (blockedUrls.length < 30) blockedUrls.push({ reason, url: url.slice(0, 300) });
  };
  const pageErrors: string[] = [];
  const chain = [o.url];
  try {
    o.onPhase?.('redirects');
    const pre = await followRedirects(proxy, chain, o.host, test, stop.signal);
    report.redirects = chain.length - 1;
    stopped(stop.signal);

    o.onPhase?.('loading');
    browser = await chromium.launch({ ...launchTarget(o.browser), headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, ...launchOptions({ args: siteBrowserArgs(port) }) });
    const launched = browser;
    await refuseUnsandboxed(launched, () => launched.close(), 'The extraction browser');
    stopped(stop.signal);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      acceptDownloads: false,
      // Only with the unsafe test resolver set (tests): it applies to every host of the context, not only the test
      // names — Playwright has no per-host switch. A real extraction never weakens Chromium's TLS.
      ignoreHTTPSErrors: test.size > 0,
      permissions: [],
    });
    context.setDefaultTimeout(callMs);
    await context.addInitScript(SERVICE_WORKER_BLOCK);
    await context.addInitScript(UNROUTED_APIS_BLOCK);
    await context.routeWebSocket(/.*/, (ws) => {
      block('websocket', ws.url());
      void ws.close();
    });
    const page = await context.newPage();
    let fetcher: Page | undefined;
    let mainDocument = false;
    const requestsMax = o.requestsMax ?? SITE_REQUESTS_MAX;
    await context.route('**/*', (route: Route) => {
      const q = route.request();
      const url = q.url();
      const p = requestUrlProblem(url, test);
      if (p) {
        block(p.reason, url);
        return route.abort('blockedbyclient');
      }
      if (q.method() !== 'GET' && q.method() !== 'HEAD') {
        block('method', `${q.method()} ${url}`);
        return route.abort('blockedbyclient');
      }
      if (q.isNavigationRequest()) {
        let owner: Page | null = null;
        let top = false;
        try {
          top = q.frame().parentFrame() === null;
          owner = q.frame().page();
        } catch {
          // No frame yet: a popup's first navigation (window.open) — never one of ours.
          top = true;
          owner = null;
        }
        if (top && owner !== fetcher) {
          // The page stays on the document opened: a later navigation (a script, a meta refresh) is answered 204;
          // a popup (window.open) never loads anything.
          if (owner !== page || mainDocument) {
            block('navigation', url);
            return route.fulfill({ status: 204, body: '' });
          }
          mainDocument = true;
        }
      }
      if (report.network.requests >= requestsMax) {
        block('cap', url);
        return route.abort('blockedbyclient');
      }
      report.network.requests++;
      proxy.announce(new URL(url).hostname);
      return route.continue();
    });
    let inflight = 0;
    const images = new Map<string, Response>();
    page.on('request', () => inflight++);
    page.on('requestfinished', () => (inflight = Math.max(0, inflight - 1)));
    page.on('requestfailed', () => (inflight = Math.max(0, inflight - 1)));
    page.on('response', (r) => {
      if (r.request().resourceType() === 'image' && images.size < 300) images.set(r.url(), r);
    });
    page.on('pageerror', (e) => {
      if (pageErrors.length < 10) pageErrors.push(String(e.message).slice(0, 300));
    });
    page.on('download', (d) => void d.cancel().catch(() => undefined));
    proxy.announce(new URL(pre.final).hostname);
    let resp: Response | null = null;
    try {
      resp = await bounded(page.goto(pre.final, { waitUntil: 'load', timeout: 20_000 }), 25_000, 'the page load', stop.signal);
    } catch (e) {
      if (stop.signal.aborted) throw e;
      const m = (e as Error).message.split('\n')[0];
      if (!/Timeout|did not answer/i.test(m) || page.url() === 'about:blank') throw new RunnerError(m.replace(/^page\.goto: /, ''));
      report.warnings.push('the page did not finish loading in 20 s: read as it was');
    }
    report.http_status = resp?.status() ?? null;
    report.untrusted.final_url = page.url();
    await networkQuiet(() => inflight, 8_000, stop.signal);
    await pause(1000, stop.signal);

    o.onPhase?.('reading');
    const shot = await call(page.screenshot({ type: 'jpeg', quality: 80, timeout: callMs }), 'the screenshot');
    await writeNew(o.outDir, SITE_SCREENSHOT_FILE, shot);
    report.screenshot = SITE_SCREENSHOT_FILE;
    const step = 24;
    const read = <T>(fn: (cfg: never) => T, cfg: unknown, what: string) => call(evaluateIsolated(page, fn, cfg), what);
    const factsCfg = { maxCandidates: SITE_CANDIDATES_MAX, svgMax: 400_000, urlMax: CANDIDATE_URL_MAX, dataUrlMax: CANDIDATE_DATA_URL_MAX };
    const samples: SampledColors[] = [await read(sampleColors as (cfg: never) => SampledColors, { step }, 'reading the colours')];
    await read(scrollToY as (cfg: never) => number, VIEWPORT.height, 'scrolling');
    await pause(500, stop.signal);
    samples.push(await read(sampleColors as (cfg: never) => SampledColors, { step }, 'reading the colours'));
    const height = (await read(readFacts as (cfg: never) => PageFacts, factsCfg, 'reading the page')).scroll_height;
    if (height > 2 * VIEWPORT.height) {
      await read(scrollToY as (cfg: never) => number, height, 'scrolling');
      await pause(600, stop.signal);
    }
    await read(scrollToY as (cfg: never) => number, 0, 'scrolling');
    await pause(300, stop.signal);
    const facts = await read(readFacts as (cfg: never) => PageFacts, factsCfg, 'reading the page');
    report.palette = sitePalette(mergeSamples(samples));
    const families = (rec: Record<string, number>) =>
      Object.entries(rec)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([family, elements]) => ({ family: family.slice(0, 200), elements }));
    report.untrusted.title = facts.title;
    report.untrusted.description = facts.description;
    report.untrusted.site_name = facts.site_name;
    report.untrusted.lang = facts.lang;
    report.untrusted.fonts = {
      display: families(facts.fonts.display),
      body: families(facts.fonts.body),
      faces: facts.faces.slice(0, 40).map((f) => ({ family: String(f.family).slice(0, 200), weight: String(f.weight).slice(0, 40), style: String(f.style).slice(0, 40), status: String(f.status).slice(0, 20) })),
    };
    stopped(stop.signal);

    o.onPhase?.('logos');
    // The candidates' bytes: as the page received them, else one GET through the same route and proxy.
    fetcher = await context.newPage();
    const fetchPage = fetcher;
    const bytesOf = async (c: LogoCandidate): Promise<Buffer | null> => {
      if (c.kind === 'svg') return Buffer.from(c.markup, 'utf8');
      if (c.url.startsWith('data:')) {
        if (c.url.length > CANDIDATE_DATA_URL_MAX) return null;
        const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(c.url);
        if (!m) return null;
        let b: Buffer;
        try {
          b = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
        } catch {
          return null;
        }
        return b.length <= CANDIDATE_BYTES_MAX ? b : null;
      }
      if (c.url.length > CANDIDATE_URL_MAX) return null;
      try {
        const seen = images.get(c.url);
        const r = seen ?? (await call(fetchPage.goto(c.url, { timeout: 10_000 }), 'a logo candidate'));
        if (!r || r.status() >= 400) return null;
        const len = Number(r.headers()['content-length'] ?? 0);
        if (len > CANDIDATE_BYTES_MAX) return null;
        const b = await call(r.body(), 'a logo candidate');
        return b.length <= CANDIDATE_BYTES_MAX ? b : null;
      } catch (e) {
        if (stop.signal.aborted) throw e;
        return null;
      }
    };
    // Rasterised with JavaScript off and no network: Chromium decodes the image, the PNG is its screenshot.
    const raster: BrowserContext = await browser.newContext({ javaScriptEnabled: false, offline: true, viewport: { width: LOGO_MAX_WIDTH + 16, height: LOGO_MAX_HEIGHT + 16 }, deviceScaleFactor: 1 });
    raster.setDefaultTimeout(callMs);
    await raster.route('**/*', (r) => r.abort());
    const rp = await raster.newPage();
    const alts: Array<{ file: string; alt: string }> = [];
    /** The candidate drawn at w × h, as a PNG (transparent background), or null. */
    const shoot = async (w: number, h: number): Promise<Buffer | null> => {
      await call(
        rp.evaluate(
          ({ w, h }: { w: number; h: number }) => {
            const i = document.getElementById('i') as HTMLImageElement;
            i.style.width = `${w}px`;
            i.style.height = `${h}px`;
          },
          { w, h },
        ),
        'drawing a logo candidate',
      );
      return call(rp.locator('#i').screenshot({ omitBackground: true, type: 'png', timeout: callMs }), 'drawing a logo candidate').catch((e: unknown) => {
        if (stop.signal.aborted) throw e;
        return null;
      });
    };
    for (const c of facts.candidates) {
      if (report.candidates.length >= SITE_CANDIDATES_MAX) break;
      stopped(stop.signal);
      const b = await bytesOf(c);
      const mime = b ? imageMime(b) : null;
      if (!b || !mime) continue;
      const src = `data:${mime};base64,${b.toString('base64')}`;
      await call(rp.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block}</style></head><body><img id="i" alt=""></body></html>`), 'drawing a logo candidate');
      const loaded = await call(
        rp.evaluate(async (s: string) => {
          const i = document.getElementById('i') as HTMLImageElement;
          i.src = s;
          try {
            await i.decode();
          } catch {
            return null;
          }
          return { w: i.naturalWidth, h: i.naturalHeight };
        }, src),
        'decoding a logo candidate',
      ).catch((e: unknown) => {
        if (stop.signal.aborted) throw e;
        return null;
      });
      if (!loaded || loaded.w < 1 || loaded.h < 1) continue;
      let h = mime === 'image/svg+xml' ? SVG_LOGO_HEIGHT : Math.min(LOGO_MAX_HEIGHT, Math.max(LOGO_MIN_HEIGHT, loaded.h));
      let w = Math.round((loaded.w * h) / loaded.h);
      if (w > LOGO_MAX_WIDTH) {
        w = LOGO_MAX_WIDTH;
        h = Math.max(1, Math.round((loaded.h * w) / loaded.w));
      }
      // What a create would refuse (template_create_from_brand: 64 px high at least, 2 MB at most) is never made:
      // too low is dropped, too heavy is drawn smaller while it stays high enough.
      if (w < 1 || h < BRAND_IMAGE_MIN_HEIGHT) continue;
      let png = await shoot(w, h);
      for (let i = 0; png && png.length > candidateMax && i < CANDIDATE_SHRINK_STEPS; i++) {
        const nh = Math.round(h * CANDIDATE_SHRINK);
        if (nh < BRAND_IMAGE_MIN_HEIGHT) {
          png = null;
          break;
        }
        w = Math.max(1, Math.round(w * CANDIDATE_SHRINK));
        h = nh;
        png = await shoot(w, h);
      }
      if (!png || png.length > candidateMax) continue;
      const size = pngSize(png);
      if (size.height < BRAND_IMAGE_MIN_HEIGHT) continue;
      const n = report.candidates.length + 1;
      const file = `logo-${n}.png`;
      await writeNew(o.outDir, file, png);
      report.candidates.push({ file, source: sourceOf(c), width: size.width, height: size.height, drawn: { width: c.width, height: c.height } });
      if (c.alt) alts.push({ file, alt: c.alt });
    }
    await raster.close().catch(() => undefined);
    if (alts.length) report.untrusted.alts = alts;
    if (!report.candidates.length) report.warnings.push('no logo candidate could be made: give the logo as a file (brand/)');
    report.status = 'ok';
  } catch (e) {
    // A stop wins over the error it caused (a call rejected because the browser was closed).
    const why = stop.signal.aborted && stop.signal.reason instanceof Error ? stop.signal.reason : e;
    if (why instanceof CancelledError) {
      clearTimeout(deadline);
      await browser?.close().catch(() => undefined);
      await proxy.close();
      throw why;
    }
    report.status = 'failed';
    if (why instanceof OtherHostError) {
      report.warnings.push(
        `the page redirects to another host (its URL is the last of untrusted.redirect_chain): only ${o.host} and its www / apex sibling are read — that URL is extracted only once the user approves it (template_from_site with it)`,
      );
    }
    report.untrusted.error = (why instanceof ProxyRefusalError ? why.message : (why as Error).message ?? String(why)).split('\n')[0].slice(0, 500);
    log(`site extraction of ${o.host} failed: ${report.untrusted.error}`);
  } finally {
    clearTimeout(deadline);
    o.signal?.removeEventListener('abort', onCancel);
    await browser?.close().catch(() => undefined);
    await proxy.close();
  }
  if (chain.length > 1) report.untrusted.redirect_chain = chain;
  o.onPhase?.('writing');
  const s = proxy.stats;
  report.network.tunnels = s.tunnels;
  report.network.bytes = s.bytes;
  report.network.refused = s.refused;
  report.network.capped = s.capped;
  if (s.refused_hosts.length) report.untrusted.refused_hosts = s.refused_hosts;
  if (blockedUrls.length) report.untrusted.blocked = blockedUrls;
  if (pageErrors.length) report.untrusted.page_errors = pageErrors;
  if (s.capped) report.warnings.push(`${s.capped} connection(s) closed by a cap (bytes, idle or life time)`);
  await writeNew(o.outDir, SITE_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export type { ProxyRefusal };
