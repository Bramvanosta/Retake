/** What a site extraction writes and takes: its report (site.json), its options, its limits and the browser's switches. */
import type { BrowserConfig } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import type { SiteTestTarget } from '@retake/core/theme';
import { DEFAULT_BROWSER_ARGS } from '../browser-args.js';
import type { SitePalette } from './palette.js';
import type { PageFacts } from './page-script.js';
import type { SiteProxyOptions, SiteProxyStats } from './proxy.js';

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
  /** What the work runs under (core WorkPolicy): which Chromium and ffmpeg, which switches, under its agent policy. */
  policy: WorkPolicy;

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
