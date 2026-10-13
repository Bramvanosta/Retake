/**
 * Display URLs (L1.7, R-ENV-01): an environment page may declare the URL a video shows instead of its real one
 * (`{url: http://localhost:4402, display: shop.example.com}`). The runner navigates the real URL; what the video shows
 * (address bars, captions, notification apps) maps it through the run's display table. Pure helpers.
 */
import type { ResolvedEnvironment } from './types.js';

/**
 * One row of a display table: a page's real base URL and the base the video shows instead. A page without a display
 * URL (`display` absent) still claims the URLs under its base: they keep their real URL (hidden when local).
 */
export interface DisplayEntry {
  page: string;
  /** Real base URL (no trailing slash). */
  url: string;
  /** Display base (`https://host[:port][/path]`, no trailing slash); absent: the page has none. */
  display?: string;
}

const HOST_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::\d{1,5})?$/i;

function stripSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path === '/' ? '' : path;
}

/**
 * Why a `display:` value is not usable, or null. Accepted: `host[:port][/path]` (https implied: the address bar shows
 * the lock) or an `http(s)://…` URL of a public host; no query, fragment, credentials or `{{…}}` (it is burnt into the
 * video as is), no local host (localhost, a private address… — the video would show it).
 */
export function displayError(value: string): string | null {
  const v = value.trim();
  const hint = 'e.g. "shop.example.com" or "https://shop.example.com/app"';
  if (!v) return `display must not be empty (${hint})`;
  if (v.includes('{{')) return `display is shown as written: no {{…}} (${hint})`;
  if (/[?#\s]/.test(v)) return `display is a base URL: no query, fragment or spaces (${hint})`;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v);
  if (scheme && !/^https?$/i.test(scheme[1])) return `display must be an http(s) URL or a host (${hint})`;
  const rest = scheme ? v.slice(scheme[0].length) : v;
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  if (host.includes('@')) return `display must not carry credentials (${hint})`;
  if (!HOST_RE.test(host)) return `display "${v}" does not start with a host name (${hint})`;
  let url: URL;
  try {
    url = new URL(scheme ? v : `https://${v}`);
  } catch {
    return `display "${v}" is not a valid URL (a port is 1–65535; ${hint})`;
  }
  if (isLocalHost(url.hostname)) return `display "${v}" is a local host: the video would show it — give the public address (${hint})`;
  return null;
}

/** The display base as the video shows it: `https://host[:port][/path]` (an explicit http:// stays), no trailing slash. */
export function normalizeDisplay(value: string): string {
  const v = value.trim();
  const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  return `${url.protocol}//${url.host}${stripSlash(url.pathname)}`;
}

function realBase(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${stripSlash(u.pathname)}`;
}

/** Every page of an environment as a display row: its real base, and its display base when it declares one. */
export function displayRows(env: Pick<ResolvedEnvironment, 'pages' | 'display'>): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (const [page, url] of Object.entries(env.pages)) {
    const display = env.display?.[page];
    try {
      out.push({ page, url: realBase(url), ...(display !== undefined ? { display: normalizeDisplay(display) } : {}) });
    } catch {
      /* validated in project.yaml: a malformed entry is simply not mapped */
    }
  }
  return out;
}

/** The display table of an environment as a run records it: its pages that declare a display URL, in page order. */
export function displayTable(env: Pick<ResolvedEnvironment, 'pages' | 'display'>): Array<Required<DisplayEntry>> {
  return displayRows(env).filter((r): r is Required<DisplayEntry> => r.display !== undefined);
}

/**
 * The display table an edit uses (L1.7, R-ENV-01). Display URLs are edit-time data: the rows of the pages the project
 * declares now for the run's environment (`displayRows`; each with its display URL or none) come first, so a display
 * URL added after the capture applies on the next render — runs captured before L1.7 included; the rows the run
 * recorded (`timeline.environment.display`) whose real base the project no longer declares are kept.
 */
export function editDisplayTable(recorded: readonly DisplayEntry[] | undefined, current: readonly DisplayEntry[] | undefined): DisplayEntry[] {
  const out = [...(current ?? [])];
  for (const r of recorded ?? []) if (!out.some((c) => c.url === r.url)) out.push(r);
  return out;
}

/**
 * Page key → the base URL the video shows: its display base, else its real URL. The `pages` of the edit-text template
 * context (`{{shop}}` in a caption, a card, a label, the title or the outro reads the display URL; steps keep the real
 * one).
 */
export function displayPages(env: Pick<ResolvedEnvironment, 'pages' | 'display'>): Record<string, string> {
  const out: Record<string, string> = { ...env.pages };
  for (const row of displayTable(env)) out[row.page] = row.display;
  return out;
}

/** `blob:` and `filesystem:` URLs wrap the URL of the document that made them: its scheme prefix and inner URL. */
function wrapped(url: string): { prefix: string; inner: string } | null {
  const m = /^(blob|filesystem):/i.exec(url);
  return m ? { prefix: url.slice(0, m[0].length), inner: url.slice(m[0].length) } : null;
}

/**
 * The URL a video shows for a real URL: the page whose real base is the longest prefix of it (at a path-segment
 * boundary) → its display base + the rest (a page without a display URL: the URL unchanged); a URL no page claims, on
 * the origin of pages with a display URL → that origin's display host (the page whose base path is "/" first) + the
 * path; else the URL unchanged. Query and fragment are kept. Only http(s) URLs are mapped; a `blob:` / `filesystem:`
 * URL maps the URL it wraps.
 */
export function displayUrl(url: string, table: readonly DisplayEntry[]): string {
  if (table.length === 0) return url;
  const w = wrapped(url);
  if (w) return `${w.prefix}${displayUrl(w.inner, table)}`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
  const tail = `${u.search}${u.hash}`;
  let best: { entry: DisplayEntry; basePath: string } | null = null;
  const sameOrigin: Array<{ entry: DisplayEntry; basePath: string }> = [];
  for (const entry of table) {
    let b: URL;
    try {
      b = new URL(entry.url);
    } catch {
      continue;
    }
    if (b.origin !== u.origin) continue;
    const basePath = stripSlash(b.pathname);
    if (entry.display !== undefined) sameOrigin.push({ entry, basePath });
    if (basePath === '' || u.pathname === basePath || u.pathname.startsWith(`${basePath}/`)) {
      if (!best || basePath.length > best.basePath.length) best = { entry, basePath };
    }
  }
  if (best) return best.entry.display !== undefined ? `${best.entry.display}${u.pathname.slice(best.basePath.length)}${tail}` : url;
  if (sameOrigin.length === 0) return url;
  const pick = sameOrigin.find((s) => s.basePath === '') ?? sameOrigin[0];
  const d = new URL(pick.entry.display!);
  return `${d.protocol}//${d.host}${u.pathname}${tail}`;
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Name suffixes that only resolve on a machine or a home / office network. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'test', 'internal', 'lan', 'home.arpa', 'localdomain', 'intranet', 'corp', 'home'];

/**
 * A host that only means something on this machine or network, never in a video: localhost, a name without a dot
 * (`devbox`, `web`), `*.localhost`, `*.local`, `*.test`, `*.internal`, `*.lan`, `*.home.arpa` and kin, loopback,
 * private, shared (100.64/10) and link-local addresses, 0.0.0.0, IPv6 ::1, fc00::/7, fe80::/10 and IPv4-mapped ones.
 * Written forms are read like a browser does (`127.1`, `2130706433`, `[0:0:0:0:0:0:0:1]`).
 */
export function isLocalHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (!h) return false;
  if (!h.startsWith('[') && (h.match(/:/g)?.length ?? 0) > 1) h = `[${h}]`;
  try {
    h = new URL(`http://${h}/`).hostname;
  } catch {
    return false;
  }
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return false;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return isLocalHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  }
  if (!h.includes('.')) return true;
  return LOCAL_SUFFIXES.some((x) => h === x || h.endsWith(`.${x}`));
}

/**
 * Whether a URL points at a local place (see isLocalHost): an http(s) URL on a local host, a `file:` URL, a `blob:` /
 * `filesystem:` URL made by a local page; false for URLs without a host (`about:blank`, `data:`, `mailto:`).
 */
export function isLocalUrl(url: string): boolean {
  const w = wrapped(url);
  if (w) return isLocalUrl(w.inner);
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return true;
    return u.hostname !== '' && isLocalHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * A real URL as a video, a report or a raw export may name it: its display URL, else — still local — its path and
 * query only (a `file:` URL: its file name), never the local host; '' when nothing of it can be named.
 */
export function shownUrl(url: string, table: readonly DisplayEntry[]): string {
  const d = displayUrl(url, table);
  if (!isLocalUrl(d)) return d;
  const w = wrapped(d);
  try {
    const u = new URL(w ? w.inner : d);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() ?? '');
    return `${u.pathname}${u.search}`;
  } catch {
    return '';
  }
}

const URL_IN_TEXT = /\b(?:https?|file|blob:https?):\/\/[^\s"'<>`]+/gi;
/** `host:port[/path]` or `host/path` without a scheme, where the host is a name with a dot, an IPv4 address, [IPv6] or localhost. */
const BARE_IN_TEXT =
  /(?<![\w/.@:-])(\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|localhost|(?=[a-z0-9.-]*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)((?::\d{1,5})(?:\/[^\s"'<>`]*)?|\/[^\s"'<>`]*)/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * Local URLs written in a text (`http://localhost:4402/x`, `127.0.0.1:8080`, `shop.localhost:4402`, `app.test:3000/x`,
 * `[::1]:4402`, `localhost/admin`), in order, deduplicated. A host without a dot counts only in a full URL
 * (`http://devbox:3000`) or as `localhost`: "16:9" is not an address.
 */
export function findLocalUrls(text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const clean = m[0].replace(TRAILING, '');
    if (isLocalUrl(clean)) add(clean);
  }
  for (const m of text.matchAll(BARE_IN_TEXT)) {
    const clean = m[0].replace(TRAILING, '');
    if (out.some((u) => u.includes(clean))) continue;
    if (isLocalHost(m[1])) add(clean);
  }
  return out;
}

/**
 * A text with the URLs it names as shown (shownUrl): an http(s) URL through the display table, a local one (also
 * written without a scheme) reduced to its path. For texts recorded at capture with real URLs (a step's target).
 */
export function shownText(text: string, table: readonly DisplayEntry[]): string {
  let out = text.replace(URL_IN_TEXT, (m) => {
    const clean = m.replace(TRAILING, '');
    const shown = shownUrl(clean, table);
    return `${shown === '' && isLocalUrl(clean) ? '/' : shown}${m.slice(clean.length)}`;
  });
  out = out.replace(BARE_IN_TEXT, (m, host: string, rest: string) => {
    if (!isLocalHost(host)) return m;
    const path = rest.replace(/^:\d{1,5}/, '');
    return path === '' ? '/' : path;
  });
  return out;
}
