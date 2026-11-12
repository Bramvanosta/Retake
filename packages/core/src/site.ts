/**
 * The URL a site extraction opens (L3.5, R-MCP-12: template_from_site / `retake theme from-site`). Pure: checked at
 * submit and again by the worker, before a human is asked and before anything connects.
 *
 * `https:` only, the default port, no user name or password, no query and no fragment (an agent cannot smuggle data
 * to a host it names in a query string; what the human approves is exactly what opens), a path of at most 200
 * characters, and a DNS name with a dot — never an IP literal in any notation (the WHATWG URL parser canonicalises
 * decimal, octal, hex and short forms to dotted IPv4 first) nor a reserved or local suffix (localhost, .local,
 * .internal, .lan, .home.arpa, .test, .invalid, .example, .onion, .alt…). One trailing dot is ignored (`localhost.`). Where the
 * name resolves is checked by the worker's CONNECT proxy, for every address (ip-class.ts).
 *
 * The environment pages of the workspace's projects and the protected hosts are checked by the engine (they need the
 * workspace): an environment is filmed through runs and page_inspect, with its access rules, never extracted.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToUnicode } from 'node:url';

export const SITE_URL_MAX = 300;
export const SITE_PATH_MAX = 200;

/** Suffixes that never name a public site (special-use and de facto private names). */
export const SITE_RESERVED_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'arpa', 'test', 'invalid', 'example', 'onion', 'alt'] as const;

export interface SiteUrl {
  /** The canonical URL opened and approved: `https://<punycode host><percent-encoded path>`. */
  href: string;
  /** The host as DNS knows it (punycode, lower-case, no trailing dot). */
  host: string;
  /** The same host in Unicode (what a person reads; shown next to the href, never instead of it). */
  unicode_host: string;
}

/**
 * The UNSAFE test resolver (tests only): `RETAKE_UNSAFE_TEST_RESOLVE=brand.test=127.0.0.1:4430,cdn.test=…` maps
 * invented `.test` names to a loopback port, so the tests film a local https site through the production path
 * (CONNECT proxy, route policy, https on 443 as Chromium sees it). It relaxes three rules for those names only: the
 * `.test` suffix is accepted, the address is not classified (loopback), and the browser accepts the test site's
 * self-signed certificate. Entries that are not `<name>.test=<127.0.0.1 or ::1>:<port>` are ignored (`ignored`).
 * `retake doctor` warns when it is set; the worker logs it; a result made with it carries a warning.
 */
export const UNSAFE_TEST_RESOLVE_ENV = 'RETAKE_UNSAFE_TEST_RESOLVE';

export interface SiteTestTarget {
  address: string;
  port: number;
}

export function unsafeTestResolve(env: NodeJS.ProcessEnv = process.env): { map: Map<string, SiteTestTarget>; ignored: string[] } {
  const map = new Map<string, SiteTestTarget>();
  const ignored: string[] = [];
  for (const entry of (env[UNSAFE_TEST_RESOLVE_ENV] ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.test)=(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(entry);
    const port = m ? Number(m[3]) : 0;
    if (!m || port < 1 || port > 65535) {
      ignored.push(entry);
      continue;
    }
    map.set(m[1], { address: m[2] === '[::1]' ? '::1' : m[2], port });
  }
  return { map, ignored };
}

/** The canonical site URL, or why it is refused. `testHosts`: names of the unsafe test resolver (their .test allowed). */
export function parseSiteUrl(raw: string, testHosts: ReadonlySet<string> | ReadonlyMap<string, unknown> = unsafeTestResolve().map): { ok: true; url: SiteUrl } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem });
  if (typeof raw !== 'string' || !raw.trim()) return bad('an empty URL');
  if (raw.length > SITE_URL_MAX) return bad(`a URL longer than ${SITE_URL_MAX} characters`);
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return bad('a URL with a control character or a backslash');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return bad('not an absolute URL (give https://<site>/)');
  }
  if (u.protocol !== 'https:') return bad(`only https:// sites are opened (not ${u.protocol})`);
  if (u.username || u.password || /^https:\/\/[^/]*@/i.test(raw.trim())) return bad('a URL with a user name or password is never opened');
  if (u.port !== '') return bad(`only the default https port is used (not :${u.port})`);
  if (u.href.includes('?')) return bad('a URL with a query string (?…) is not opened: give the page without it');
  if (u.href.includes('#')) return bad('a URL with a fragment (#…) is not opened: give the page without it');
  if (u.pathname.length > SITE_PATH_MAX) return bad(`a path longer than ${SITE_PATH_MAX} characters`);
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (isIP(bare) || host.startsWith('[')) return bad(`${host} is an IP address: give the site's name`);
  if (!host.includes('.')) return bad(`${host} is not a public DNS name (no dot)`);
  if (host.split('.').some((l) => l === '')) return bad(`${host}: an empty label`);
  const suffix = testHosts.has(host) ? undefined : SITE_RESERVED_SUFFIXES.find((s) => host === s || host.endsWith(`.${s}`));
  if (suffix) return bad(`${host} is a reserved or local name (.${suffix}): it never names a public site`);
  if (/^\d+$/.test(host.split('.').at(-1)!)) return bad(`${host} ends with a number: not a DNS name`);
  return { ok: true, url: { href: `https://${host}${u.pathname}`, host, unicode_host: domainToUnicode(host) || host } };
}

/** Why a site URL is refused, or null. */
export function siteUrlProblem(raw: string, testHosts?: ReadonlySet<string> | ReadonlyMap<string, unknown>): string | null {
  const r = parseSiteUrl(raw, testHosts);
  return r.ok ? null : r.problem;
}

/** The fingerprint a human approves for one site URL: sha256("site\n" + canonical href). */
export function siteApprovalFingerprint(href: string): string {
  return createHash('sha256').update(`site\n${href}`).digest('hex');
}

/** A theme name proposed for a site: its registrable-looking label ("www.brand.example" → "brand"), lower-case. */
export function siteThemeName(host: string): string {
  const labels = host.split('.').filter((l) => l && l !== 'www');
  const label = (labels.length >= 2 ? labels[labels.length - 2] : (labels[0] ?? 'site')).replace(/^xn--/, '');
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return /^[a-z0-9]/.test(slug) ? slug : `site-${slug || 'theme'}`.slice(0, 50);
}
