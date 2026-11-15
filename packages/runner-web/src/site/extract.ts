/**
 * A site extraction (R-MCP-12): open one public page in a clean, ephemeral Chromium whose only network is the
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
import { lstat } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { Page, Response, Route } from 'playwright-core';
import { BRAND_IMAGE_MAX_BYTES } from '@retake/core/theme';
import type { SiteTestTarget } from '@retake/core/theme';
import { CancelledError, RunnerError } from '../errors.js';
import { launchOptions, refuseUnsandboxed } from '../launch.js';
import { launchTarget } from '../session.js';
import { mergeSamples, sitePalette } from './palette.js';
import { readFacts, sampleColors, scrollToY } from './page-script.js';
import type { PageFacts, SampledColors } from './page-script.js';
import { ProxyRefusalError, SiteProxy } from './proxy.js';
import type { ProxyRefusal } from './proxy.js';
import { errorMessage } from '@retake/core/base';
import { CANDIDATE_DATA_URL_MAX, CANDIDATE_URL_MAX, writeLogos } from './logos.js';
import { DeadlineError, block, bounded, networkQuiet, newReport, pause, stopped, writeNew } from './extraction.js';
import type { Extraction, OpenedSitePage, PageNavigation } from './extraction.js';
import { OtherHostError, followRedirects, requestUrlProblem } from './redirects.js';
import {
  SERVICE_WORKER_BLOCK,
  SITE_CALL_TIMEOUT_MS,
  SITE_CANDIDATES_MAX,
  SITE_DEADLINE_MS,
  SITE_REPORT_FILE,
  SITE_REQUESTS_MAX,
  SITE_SCREENSHOT_FILE,
  UNROUTED_APIS_BLOCK,
  siteBrowserArgs,
} from './report.js';
import type { SiteExtractOptions, SiteReport } from './report.js';

export * from './report.js';
export { imageMime } from './logos.js';
export { requestUrlProblem, sameSiteHost } from './redirects.js';

const VIEWPORT = { width: 1440, height: 900 };
const WORLD = 'retake-site';

/** Run one of page-script.ts's functions in the isolated world (`__name` shimmed: esbuild keepNames wraps inner functions). */
async function evaluateIsolated<T>(page: Page, fn: (cfg: never) => T, cfg: unknown): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false })) as { executionContextId: number };
    const r = (await cdp.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: `(() => { var __name = (f) => f; return (${fn.toString()})(${JSON.stringify(cfg)}); })()`,
      returnByValue: true,
      awaitPromise: true,
    })) as {
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

/** The context's route: GET / HEAD to a checked URL, one main document, a request cap (see the module comment). */
function routeRequest(ex: Extraction, nav: PageNavigation, requestsMax: number, route: Route): Promise<void> {
  const { report } = ex;
  const q = route.request();
  const url = q.url();
  const p = requestUrlProblem(url, ex.test);
  if (p) {
    block(ex, p.reason, url);
    return route.abort('blockedbyclient');
  }
  if (q.method() !== 'GET' && q.method() !== 'HEAD') {
    block(ex, 'method', `${q.method()} ${url}`);
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
    if (top && owner !== nav.fetcher) {
      // The page stays on the document opened: a later navigation (a script, a meta refresh) is answered 204;
      // a popup (window.open) never loads anything.
      if (owner !== nav.page || nav.mainDocument) {
        block(ex, 'navigation', url);
        return route.fulfill({ status: 204, body: '' });
      }
      nav.mainDocument = true;
    }
  }
  if (report.network.requests >= requestsMax) {
    block(ex, 'cap', url);
    return route.abort('blockedbyclient');
  }
  report.network.requests++;
  ex.proxy.announce(new URL(url).hostname);
  return route.continue();
}

/** Launches the browser on the proxy and opens the page's context, its route and listeners (nothing loaded yet). */
async function openSitePage(ex: Extraction, port: number): Promise<OpenedSitePage> {
  const { o, stop, callMs } = ex;
  ex.browser = await chromium.launch({
    ...launchTarget(o.browser, { policy: o.policy }),
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    ...launchOptions({ args: siteBrowserArgs(port), policy: o.policy }),
  });
  const launched = ex.browser;
  await refuseUnsandboxed(launched, () => launched.close(), 'The extraction browser');
  stopped(stop.signal);
  const context = await launched.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    acceptDownloads: false,
    // Only with the unsafe test resolver set (tests): it applies to every host of the context, not only the test
    // names — Playwright has no per-host switch. A real extraction never weakens Chromium's TLS.
    ignoreHTTPSErrors: ex.test.size > 0,
    permissions: [],
  });
  context.setDefaultTimeout(callMs);
  await context.addInitScript(SERVICE_WORKER_BLOCK);
  await context.addInitScript(UNROUTED_APIS_BLOCK);
  await context.routeWebSocket(/.*/, (ws) => {
    block(ex, 'websocket', ws.url());
    void ws.close();
  });
  const page = await context.newPage();
  const nav: PageNavigation = { page, fetcher: undefined, mainDocument: false };
  const requestsMax = o.requestsMax ?? SITE_REQUESTS_MAX;
  await context.route('**/*', (route: Route) => routeRequest(ex, nav, requestsMax, route));
  const inflight = { n: 0 };
  const images = new Map<string, Response>();
  page.on('request', () => inflight.n++);
  page.on('requestfinished', () => (inflight.n = Math.max(0, inflight.n - 1)));
  page.on('requestfailed', () => (inflight.n = Math.max(0, inflight.n - 1)));
  page.on('response', (r) => {
    if (r.request().resourceType() === 'image' && images.size < 300) images.set(r.url(), r);
  });
  page.on('pageerror', (e) => {
    if (ex.pageErrors.length < 10) ex.pageErrors.push(String(e.message).slice(0, 300));
  });
  page.on('download', (d) => void d.cancel().catch(() => undefined));
  return { context, nav, images, inflight };
}

/** Loads the page on the redirect chain's final URL (a slow load is read as it was), then waits for it to settle. */
async function loadSitePage(ex: Extraction, opened: OpenedSitePage, final: string): Promise<void> {
  const { report, stop } = ex;
  const { page } = opened.nav;
  ex.proxy.announce(new URL(final).hostname);
  let resp: Response | null = null;
  try {
    resp = await bounded(page.goto(final, { waitUntil: 'load', timeout: 20_000 }), 25_000, 'the page load', stop.signal);
  } catch (e) {
    if (stop.signal.aborted) throw e;
    const m = errorMessage(e).split('\n')[0];
    if (!/Timeout|did not answer/i.test(m) || page.url() === 'about:blank') throw new RunnerError(m.replace(/^page\.goto: /, ''));
    report.warnings.push('the page did not finish loading in 20 s: read as it was');
  }
  report.http_status = resp?.status() ?? null;
  report.untrusted.final_url = page.url();
  await networkQuiet(() => opened.inflight.n, 8_000, stop.signal);
  await pause(1000, stop.signal);
}

/** The screenshot, the colours (top, one screen down) and the page's facts: the palette and fonts in the report. */
async function readSitePage(ex: Extraction, page: Page): Promise<PageFacts> {
  const { o, report, stop, callMs, call } = ex;
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
    faces: facts.faces
      .slice(0, 40)
      .map((f) => ({ family: String(f.family).slice(0, 200), weight: String(f.weight).slice(0, 40), style: String(f.style).slice(0, 40), status: String(f.status).slice(0, 20) })),
  };
  return facts;
}

/** A failed extraction in the report; a cancel is thrown (the browser and proxy closed first). */
async function extractionFailed(ex: Extraction, e: unknown, deadline: NodeJS.Timeout, log: (message: string) => void): Promise<void> {
  const { o, report, stop } = ex;
  // A stop wins over the error it caused (a call rejected because the browser was closed).
  const why = stop.signal.aborted && stop.signal.reason instanceof Error ? stop.signal.reason : e;
  if (why instanceof CancelledError) {
    clearTimeout(deadline);
    await ex.browser?.close().catch(() => undefined);
    await ex.proxy.close();
    throw why;
  }
  report.status = 'failed';
  if (why instanceof OtherHostError) {
    report.warnings.push(
      `the page redirects to another host (its URL is the last of untrusted.redirect_chain): only ${o.host} and its www / apex sibling are read — that URL is extracted only once the user approves it (template_from_site with it)`,
    );
  }
  report.untrusted.error = (why instanceof ProxyRefusalError ? why.message : errorMessage(why)).split('\n')[0].slice(0, 500);
  log(`site extraction of ${o.host} failed: ${report.untrusted.error}`);
}

/** The network figures, what was blocked and the page's errors in the report, written as site.json. */
async function writeReport(ex: Extraction, chain: string[]): Promise<void> {
  const { o, report } = ex;
  if (chain.length > 1) report.untrusted.redirect_chain = chain;
  o.onPhase?.('writing');
  const s = ex.proxy.stats;
  report.network.tunnels = s.tunnels;
  report.network.bytes = s.bytes;
  report.network.refused = s.refused;
  report.network.capped = s.capped;
  if (s.refused_hosts.length) report.untrusted.refused_hosts = s.refused_hosts;
  if (ex.blockedUrls.length) report.untrusted.blocked = ex.blockedUrls;
  if (ex.pageErrors.length) report.untrusted.page_errors = ex.pageErrors;
  if (s.capped) report.warnings.push(`${s.capped} connection(s) closed by a cap (bytes, idle or life time)`);
  await writeNew(o.outDir, SITE_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
}

/** Extract a site (see the module comment). Never throws for what the page does: a failed page is a report with status failed. */
export async function extractSite(o: SiteExtractOptions): Promise<SiteReport> {
  const log = o.log ?? (() => undefined);
  const test = o.testResolve ?? new Map<string, SiteTestTarget>();
  const callMs = o.callTimeoutMs ?? SITE_CALL_TIMEOUT_MS;
  const candidateMax = o.candidateMaxBytes ?? BRAND_IMAGE_MAX_BYTES;
  const report = newReport(o, test);
  const out = await lstat(o.outDir).catch(() => null);
  if (!out?.isDirectory()) throw new RunnerError(`${o.outDir} is not a folder (missing, a link or a file): the caller makes the extraction's folder`);
  // The caller's signal (job_cancel) and the deadline both stop everything: the browser is closed at once.
  const stop = new AbortController();
  const onCancel = () => stop.abort(new CancelledError('site extraction cancelled'));
  if (o.signal?.aborted) onCancel();
  else o.signal?.addEventListener('abort', onCancel, { once: true });
  const deadlineMs = o.deadlineMs ?? SITE_DEADLINE_MS;
  const deadline = setTimeout(() => stop.abort(new DeadlineError(`the extraction took more than ${Math.round(deadlineMs / 1000)} s: the page was closed`)), deadlineMs);
  const ex: Extraction = {
    o,
    report,
    test,
    callMs,
    candidateMax,
    stop,
    proxy: new SiteProxy({ ...o.proxy, testResolve: test }),
    browser: undefined,
    blockedUrls: [],
    pageErrors: [],
    call: (p, what) => bounded(p, callMs, what, stop.signal),
  };
  stop.signal.addEventListener('abort', () => void ex.browser?.close().catch(() => undefined), { once: true });
  const port = await ex.proxy.start();
  const chain = [o.url];
  try {
    o.onPhase?.('redirects');
    const pre = await followRedirects(ex.proxy, chain, o.host, test, stop.signal);
    report.redirects = chain.length - 1;
    stopped(stop.signal);

    o.onPhase?.('loading');
    const opened = await openSitePage(ex, port);
    await loadSitePage(ex, opened, pre.final);

    o.onPhase?.('reading');
    const facts = await readSitePage(ex, opened.nav.page);
    stopped(stop.signal);

    o.onPhase?.('logos');
    await writeLogos(ex, opened, facts);
    if (!report.candidates.length) report.warnings.push('no logo candidate could be made: give the logo as a file (brand/)');
    report.status = 'ok';
  } catch (e) {
    await extractionFailed(ex, e, deadline, log);
  } finally {
    clearTimeout(deadline);
    o.signal?.removeEventListener('abort', onCancel);
    await ex.browser?.close().catch(() => undefined);
    await ex.proxy.close();
  }
  await writeReport(ex, chain);
  return report;
}

export type { ProxyRefusal };
