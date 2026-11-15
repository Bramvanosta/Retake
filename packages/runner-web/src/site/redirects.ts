/** The approved host, the URLs a page may request, and the top-level redirect chain followed in Node (extract.ts). */
import { SITE_REDIRECTS_MAX } from './report.js';
import type { BlockedReason } from './report.js';
import { stopped } from './extraction.js';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { SITE_RESERVED_SUFFIXES } from '@retake/core/theme';
import { RunnerError } from '../errors.js';
import type { SiteProxy } from './proxy.js';

/** Whether `other` is the approved host or its www / apex sibling (www.brand.example ↔ brand.example). */
export function sameSiteHost(host: string, other: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const o = other.toLowerCase().replace(/\.$/, '');
  return o === h || o === `www.${h}` || h === `www.${o}`;
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

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
};

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
export class OtherHostError extends RunnerError {}

/**
 * The top-level redirect chain, followed in Node with the proxy's checks (≤ 5 hops), on the approved host and its
 * www / apex sibling only; the URL the page opens. `chain` (the caller's) holds every hop, the refused one too.
 */
export async function followRedirects(proxy: SiteProxy, chain: string[], host: string, testHosts: ReadonlyMap<string, unknown>, signal: AbortSignal): Promise<{ final: string; status: number }> {
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
