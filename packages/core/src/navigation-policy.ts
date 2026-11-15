/** The navigation rules of agent-policy.ts: the URLs a scenario opens, the one origin comparison, the server a URL reaches. */
import { confinementWords } from './confinement.js';
import type { Confinement } from './confinement.js';
import type { IssuePath } from './issues.js';
import { scenePageEntries, splitPageOpen } from './pages.js';
import { showHiddenChars } from './printable.js';
import { normalizeStep, stepActionKeys } from './steps.js';
import { suggestion } from './validation/suggest.js';

// ── Navigation ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The origin of an http(s) URL as a browser compares origins (`scheme://host[:port]`: lower case, the default port
 * left out, a trailing dot of the host kept), parsed as WHATWG URL does (leading spaces and tabs ignored); null for any
 * other scheme and for text that is not a URL. The one origin every rule compares (environment pages, inspections,
 * recordings, an agent's navigations).
 */
export function canonicalOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
}

/** An IPv4-mapped IPv6 address as WHATWG URL writes it (`::ffff:7f00:1`): its two last groups are the IPv4 address. */
const MAPPED_IPV6 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * An IP literal in the one form addresses are compared in, or null when the host is a name: an IPv4 address dotted
 * (`127.1`, `0x7f000001` read as WHATWG URL reads them), an IPv6 one compressed in lower case without brackets, and an
 * IPv4-mapped IPv6 address (`[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`) as its IPv4 form — the same server, which a
 * browser still counts as another origin. For guards that ask whether two URLs reach one server (another project's
 * production hosts); origins stay canonicalOrigin's, allow-lists and IP classes their own normalisation.
 */
export function canonicalIp(host: string): string | null {
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h || /[\s/?#@[\]\\]/.test(h)) return null;
  let parsed: string;
  try {
    parsed = new URL(`http://${h.includes(':') ? `[${h}]` : h}/`).hostname;
  } catch {
    return null;
  }
  if (parsed.startsWith('[')) {
    const v6 = parsed.slice(1, -1);
    const m = MAPPED_IPV6.exec(v6);
    if (!m) return v6;
    const [hi, lo] = [parseInt(m[1], 16), parseInt(m[2], 16)];
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed) ? parsed : null;
}

/**
 * The server an http(s) URL reaches, from its canonicalOrigin: the host lower case without a trailing dot, an IP
 * literal in canonicalIp form (`ip`), and the port (the scheme's default when the URL leaves it out); null for any other
 * scheme and for text that is not a URL.
 */
export function canonicalAddress(url: string): { host: string; port: string; ip: boolean } | null {
  const origin = canonicalOrigin(url);
  if (origin === null) return null;
  const u = new URL(origin);
  const ip = canonicalIp(u.hostname);
  const host = ip ?? (u.hostname.endsWith('.') ? u.hostname.slice(0, -1) : u.hostname);
  return { host, port: u.port || (u.protocol === 'https:' ? '443' : '80'), ip: ip !== null };
}

/** A host no URL names: the base a reference without a scheme is resolved against, to tell a path from `//host/…`. */
const PROBE_BASE = 'http://navigation-probe.invalid/';

/** A URL as a message shows it: without its `user:password@`, hidden characters written out, a long one cut. */
function shownUrl(url: string, parsed?: URL): string {
  let v: string;
  if (parsed && (parsed.username || parsed.password)) {
    const copy = new URL(parsed.href);
    copy.username = '';
    copy.password = '';
    v = copy.href;
  } else v = parsed ? url.trim() : url;
  v = showHiddenChars(v.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1')).replace(/[\n\r\t]/g, ' ');
  return v.length > 120 ? `${v.slice(0, 117)}…` : v;
}

/** A scheme at the start of a URL as WHATWG URL reads one (leading spaces and control characters ignored). */
const SCHEME_PREFIX = /^[\u0000-\u0020]*([a-z][a-z0-9+.-]*):/i;

/** How a scenario names the page it means instead, said by every scheme refusal. */
const NAVIGATION_FIX = 'write the http(s) URL of the page, or a path of an environment page (`/…`)';

export interface NavigationOptions {
  /**
   * The origins of the run's environment pages (canonicalOrigin; core pageOrigins): an absolute URL must have one of
   * them exactly, and a reference without a scheme (`//host/…`) is refused (trust `mcp`: work an agent wrote).
   * Undefined: the scheme rule only.
   */
  origins?: readonly string[];
  /** The environment's name, for the message. */
  envName?: string;
  /** The words of the work's confinement (agent work: "through MCP"; AGENT_CONFINEMENT when absent). */
  via?: Confinement;
}

/**
 * Why a scenario may not open `url` (null when it may), read as WHATWG URL parses it — as the browser will: leading
 * spaces and control characters ignored, tabs and line breaks dropped, the scheme in any case. Every scenario opens
 * only `http:`, `https:` or exactly `about:blank`, never with sign-in details (`user@`) in the URL. With `o.origins`
 * (work an agent wrote), an absolute URL must have the exact origin of one of the environment's pages — another port of
 * localhost is another app — and `//host/…` is refused. A path (`/x`, `x`, `?q`) is resolved against a page of the
 * environment (or the current page) when it runs: accepted here. Text that is not a URL is not judged (nothing opens).
 * Templated text (`{{…}}`) is judged once rendered, when it runs.
 */
export function navigationProblem(url: string, o: NavigationOptions = {}): string | null {
  let u: URL | undefined;
  try {
    u = new URL(url);
  } catch {
    /* not an absolute URL: a path, resolved when it runs */
  }
  if (!u) {
    let r: URL;
    try {
      r = new URL(url, PROBE_BASE);
    } catch {
      // A scheme no browser can read the rest of (`http://exa mple/`, `file://%zz`) is not opened: refused, not left to
      // the run. Other text that is not a URL is not judged here (the run cannot resolve it either).
      const scheme = SCHEME_PREFIX.exec(url.replace(/[\t\n\r]/g, ''))?.[1];
      return scheme ? `${shownUrl(url)} is not a URL a browser can read (${scheme.toLowerCase()}: then text that does not parse) — ${NAVIGATION_FIX}` : null;
    }
    if (r.host === new URL(PROBE_BASE).host) return null;
    if (r.username || r.password) return credentialsProblem(shownUrl(url, r));
    if (!o.origins) return null;
    return `${shownUrl(url, r)} names a host without a scheme (\`//host/…\`): write the full http(s) URL of an environment page, or a path that starts with a single \`/\``;
  }
  const shown = shownUrl(url, u);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    if (u.protocol === 'about:' && u.href === 'about:blank') return null;
    const what = u.protocol === 'about:' ? `${u.href.slice(0, 40)}` : `${/^[aeiou]/.test(u.protocol) ? 'an' : 'a'} ${u.protocol} URL`;
    return `${shown} opens ${what}: a scenario opens only http: and https: pages (or about:blank) — ${NAVIGATION_FIX}`;
  }
  if (u.username || u.password) return credentialsProblem(shown);
  if (o.origins && !o.origins.includes(u.origin)) {
    const env = o.envName !== undefined ? `environment ${o.envName}` : 'the environment';
    return (
      `${shown} is on ${u.origin}, not an origin of ${env}'s pages (${o.origins.join(', ') || 'none'}): ${confinementWords(o.via)} a scenario opens ` +
      `only its environment's own origins (another port of localhost is another app) — to film this site, add its origin as a page of ${env} in project.yaml (a person edits it)`
    );
  }
  return null;
}

function credentialsProblem(shown: string): string {
  return `${shown} holds sign-in details (\`user@\`): a scenario's URL never does — remove them (a persona signs in: personas in project.yaml)`;
}

/** A URL a scenario opens: where it is written, its text, and whether `<page>:/path` (a page of the environment) is a form of it. */
export interface NavigationRef {
  path: IssuePath;
  url: string;
  /** A multi-page scene's `pages.<id>.open`: `<page>:/path` names a page of the environment. */
  pagePrefix: boolean;
}

/**
 * Every URL a scenario writes for the browser to open, as written (tolerant: any parsed value): a scene's `open`, each
 * `open` of a multi-page scene's `pages`, an `open` step (`open: …` or `open: {url}`), a `new_tab` step's href
 * (`new_tab: {href}`, or `new_tab: "/…"`) — skipped scenes included.
 */
export function scenarioNavigationRefs(sc: unknown): NavigationRef[] {
  const out: NavigationRef[] = [];
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const scenes = obj(sc) && Array.isArray(sc.scenes) ? sc.scenes : [];
  scenes.forEach((entry: unknown, i) => {
    if (!obj(entry) || 'card' in entry || 'interstitial' in entry) return;
    const p: IssuePath = ['scenes', i];
    if (typeof entry.open === 'string') out.push({ path: [...p, 'open'], url: entry.open, pagePrefix: false });
    if (obj(entry.pages) || Array.isArray(entry.pages)) {
      for (const e of scenePageEntries(entry.pages as never)) {
        if (obj(e.spec) && typeof e.spec.open === 'string') out.push({ path: [...p, ...e.path, 'open'], url: e.spec.open, pagePrefix: true });
      }
    }
    (Array.isArray(entry.steps) ? entry.steps : []).forEach((raw: unknown, j) => {
      if (!obj(raw)) return;
      const sp: IssuePath = [...p, 'steps', j];
      const keys = stepActionKeys(raw);
      if (keys.includes('open')) {
        const v = raw.open;
        if (typeof v === 'string') out.push({ path: [...sp, 'open'], url: v, pagePrefix: false });
        else if (obj(v) && typeof v.url === 'string') out.push({ path: [...sp, 'open', 'url'], url: v.url, pagePrefix: false });
      }
      if (keys.includes('new_tab')) {
        const v = raw.new_tab;
        if (typeof v === 'string' && typeof (normalizeStep({ new_tab: v } as never, 0).args as { href?: unknown }).href === 'string') {
          out.push({ path: [...sp, 'new_tab'], url: v, pagePrefix: false });
        } else if (obj(v) && typeof v.href === 'string') out.push({ path: [...sp, 'new_tab', 'href'], url: v.href, pagePrefix: false });
      }
    });
  });
  return out;
}

/** A `<page>:` prefix as a multi-page scene writes it (core splitPageOpen). */
const PAGE_PREFIX = /^([A-Za-z_][A-Za-z0-9_-]*):/;

/** Schemes that never name a page of an environment: refused in `pages[].open` even when no environment is known. */
const NEVER_A_PAGE = /^(?:file|data|javascript|blob|view-source|chrome|chrome-extension|devtools|filesystem)$/i;

/**
 * navigationProblem for every URL of a scenario (scenarioNavigationRefs), with where it is: templated text (`{{…}}`) is
 * left to the run, `<page>:/path` of a page of `o.pageKeys` is a path. Without `o.pageKeys` (no environment known), a
 * `<page>:` prefix that is not http, https or about is left to the run too — it may name a page —, unless it is a scheme
 * that never does (`file:`, `data:`, `javascript:`, `blob:`, `view-source:`, `chrome:`…). With `o.pageKeys`, a prefix
 * that names no page is refused, whatever it would open.
 */
export function scenarioNavigationProblems(sc: unknown, o: NavigationOptions & { pageKeys?: readonly string[] } = {}): Array<{ path: IssuePath; message: string }> {
  const out: Array<{ path: IssuePath; message: string }> = [];
  for (const ref of scenarioNavigationRefs(sc)) {
    if (ref.url.includes('{{')) continue;
    let hint = '';
    let notAPage: string | null = null;
    if (ref.pagePrefix) {
      const prefix = PAGE_PREFIX.exec(ref.url)?.[1];
      if (prefix !== undefined && !/^(?:https?|about)$/i.test(prefix)) {
        if (!o.pageKeys) {
          if (!NEVER_A_PAGE.test(prefix)) continue;
        } else {
          if (splitPageOpen(ref.url, o.pageKeys)) continue;
          const pages = `${o.envName !== undefined ? `environment "${o.envName}"` : 'the environment'}${suggestion(prefix, o.pageKeys)} (available: ${o.pageKeys.join(', ') || 'none'})`;
          hint = `; "${prefix}:" is not a page of ${o.envName !== undefined ? `environment "${o.envName}"` : 'the environment'} either${suggestion(prefix, o.pageKeys)} (available: ${o.pageKeys.join(', ') || 'none'})`;
          notAPage = `${shownUrl(ref.url)}: "${prefix}:" is not a page of ${pages} — write \`<page>:/path\` with a page of the environment`;
        }
      }
    }
    const message = navigationProblem(ref.url, o);
    if (message) out.push({ path: ref.path, message: message + hint });
    else if (notAPage) out.push({ path: ref.path, message: notAPage });
  }
  return out;
}
