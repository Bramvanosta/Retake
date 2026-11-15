/** One site extraction in progress (extract.ts): its state, its bounded calls and pauses, and how it writes a file. */
import { SITE_REPORT_VERSION } from './report.js';
import type { BlockedReason, SiteExtractOptions, SiteReport } from './report.js';
import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Response } from 'playwright-core';
import type { SiteTestTarget } from '@retake/core/theme';
import { CancelledError, RunnerError } from '../errors.js';
import type { SiteProxy } from './proxy.js';

/** The extraction's deadline passed (the browser was closed). */
export class DeadlineError extends RunnerError {}

export function stopped(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new CancelledError('site extraction cancelled');
}

/** `p`, unless `ms` pass first (a RunnerError naming `what`) or `signal` aborts (its reason). */
export function bounded<T>(p: Promise<T>, ms: number, what: string, signal: AbortSignal): Promise<T> {
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

/** Write a file of the extraction under a temporary name (`wx`: never through a link), then rename it into place. */
export async function writeNew(dir: string, file: string, data: Buffer | string): Promise<void> {
  const tmp = join(dir, `.${file}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, data, { flag: 'wx' });
  try {
    await rename(tmp, join(dir, file));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** A pause of `ms` that the stop signal ends at once. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return bounded(new Promise<void>((r) => setTimeout(r, ms)), ms + 1000, 'a pause', signal);
}

/** Wait until no request of the page is in flight for 500 ms, at most `maxMs`. */
export async function networkQuiet(inflight: () => number, maxMs: number, signal: AbortSignal): Promise<void> {
  const end = Date.now() + maxMs;
  let quietSince = Date.now();
  while (Date.now() < end) {
    if (inflight() > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) return;
    await pause(100, signal);
  }
}

/** One extraction in progress: its report, the stop (cancel or deadline), the proxy and what the route counts. */
export interface Extraction {
  o: SiteExtractOptions;
  report: SiteReport;
  test: ReadonlyMap<string, SiteTestTarget>;
  callMs: number;
  candidateMax: number;
  stop: AbortController;
  proxy: SiteProxy;
  /** Set once launched: the stop closes it. */
  browser: Browser | undefined;
  blockedUrls: Array<{ reason: BlockedReason; url: string }>;
  pageErrors: string[];
  /** One call into the page, bounded by the call timeout and the stop. */
  call: <T>(p: Promise<T>, what: string) => Promise<T>;
}

/** The report before anything is read: failed until the page has been read. */
export function newReport(o: SiteExtractOptions, test: ReadonlyMap<string, SiteTestTarget>): SiteReport {
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
  return report;
}

export function block(ex: Extraction, reason: BlockedReason, url: string): void {
  ex.report.network.blocked[reason] = (ex.report.network.blocked[reason] ?? 0) + 1;
  if (ex.blockedUrls.length < 30) ex.blockedUrls.push({ reason, url: url.slice(0, 300) });
}

/** The main page's navigations: the first document opened, and the page that fetches the logo candidates. */
export interface PageNavigation {
  page: Page;
  fetcher: Page | undefined;
  mainDocument: boolean;
}

/** The opened page, with what its listeners keep: the images it received and the requests in flight. */
export interface OpenedSitePage {
  context: BrowserContext;
  nav: PageNavigation;
  images: Map<string, Response>;
  inflight: { n: number };
}
