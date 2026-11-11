import { normalizeDisplay } from './display.js';
import type { EnvironmentAccess, EnvironmentSettings, LoadedProject, ResolvedEnvironment } from './types.js';
import { GUIDE, missingOrInvalid } from './error-kind.js';
import type { ErrorKind } from './error-kind.js';

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return missingOrInvalid(this.message);
  }

  get errorDocs(): string {
    return GUIDE.environments;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether an environment value of project.yaml is the long form (`{production?, access?, pages: {…}, read_only?}`);
 * otherwise it is the short form, the page map itself (L1.7).
 */
export function isLongFormEnvironment(value: unknown): value is Record<string, unknown> & { pages: Record<string, unknown> } {
  return isObj(value) && Object.hasOwn(value, 'pages') && isObj(value.pages);
}

/** A page value as written (`url` or `{url, display}`) → its URL; other values are returned as they are. */
export function pageUrlOf(value: unknown): unknown {
  return isObj(value) && typeof value.url === 'string' ? value.url : value;
}

/**
 * The page map of every environment of project.yaml as written, in both forms (`{url, display}` reduced to its
 * url; values the schema refuses left as they are), with where each one's pages are written (`pagesPath`, relative to
 * the environment). For the checks that run on the raw value; ProjectConfig.environments is already normalised.
 */
export function rawEnvironments(environments: unknown): Record<string, { pages: Record<string, unknown>; long: boolean; pagesPath: string[] }> {
  const out: Record<string, { pages: Record<string, unknown>; long: boolean; pagesPath: string[] }> = {};
  if (!isObj(environments)) return out;
  for (const [name, value] of Object.entries(environments)) {
    const long = isLongFormEnvironment(value);
    const pagesValue = long ? value.pages : isObj(value) ? value : {};
    const pages: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pagesValue)) pages[k] = pageUrlOf(v);
    out[name] = { pages, long, pagesPath: long ? ['pages'] : [] };
  }
  return out;
}

/** Page key → URL of every environment of a raw project.yaml value (both forms). */
export function rawEnvironmentPages(environments: unknown): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(rawEnvironments(environments)).map(([k, v]) => [k, v.pages]));
}

/**
 * project.yaml environments (both forms, schema-valid) → the real page URLs every consumer uses, and the settings
 * (display URLs, production, access, read_only) of the environments that declare any.
 */
export function normalizeEnvironments(environments: Record<string, unknown> | undefined): {
  environments: Record<string, Record<string, string>>;
  settings?: Record<string, EnvironmentSettings>;
} {
  const pagesOut: Record<string, Record<string, string>> = {};
  const settings: Record<string, EnvironmentSettings> = {};
  for (const [name, value] of Object.entries(environments ?? {})) {
    const long = isLongFormEnvironment(value);
    const written = (long ? value.pages : isObj(value) ? value : {}) as Record<string, unknown>;
    const pages: Record<string, string> = {};
    const display: Record<string, string> = {};
    for (const [key, v] of Object.entries(written)) {
      const url = pageUrlOf(v);
      if (typeof url === 'string') pages[key] = url;
      if (isObj(v) && typeof v.display === 'string') display[key] = normalizeDisplay(v.display);
    }
    pagesOut[name] = pages;
    const s: EnvironmentSettings = {};
    if (long && typeof value.production === 'boolean') s.production = value.production;
    if (long && (value.access === 'read-only' || value.access === 'read-write')) s.access = value.access;
    if (Object.keys(display).length) s.display = display;
    if (long && isObj(value.read_only)) s.read_only = value.read_only as EnvironmentSettings['read_only'];
    if (Object.keys(s).length) settings[name] = s;
  }
  return Object.keys(settings).length ? { environments: pagesOut, settings } : { environments: pagesOut };
}

/** The access an environment is configured with: `access`, else read-only in production, else read-write. */
export function environmentAccess(env: { production?: boolean; access?: EnvironmentAccess }): EnvironmentAccess {
  return env.access ?? (env.production === true ? 'read-only' : 'read-write');
}

/** Pick an environment: explicit name → project.default_env → the first one declared. */
export function resolveEnvironment(project: Pick<LoadedProject, 'config'>, env?: string): ResolvedEnvironment {
  const envs = project.config.environments ?? {};
  const names = Object.keys(envs);
  const name = env ?? project.config.default_env ?? names[0];
  if (!name) throw new EnvironmentError('project has no environments');
  const pages = Object.hasOwn(envs, name) ? envs[name] : undefined;
  if (!pages) throw new EnvironmentError(`unknown environment "${name}" (available: ${names.join(', ') || 'none'})`);
  const settings = project.config.environment_settings;
  const s = settings && Object.hasOwn(settings, name) ? settings[name] : undefined;
  return {
    name,
    // Sign-in details written in a page URL are given to the browser as HTTP credentials (environmentHttpCredentials),
    // never kept in the URL every other consumer sees (logs, the timeline, the video, the hooks' {{pages.…}}).
    pages: Object.fromEntries(Object.entries(pages).map(([k, url]) => [k, withoutCredentials(url).url])),
    ...(s?.display ? { display: { ...s.display } } : {}),
    ...(s?.production !== undefined ? { production: s.production } : {}),
    ...(s?.access ? { access: s.access } : {}),
    ...(s?.read_only ? { read_only: s.read_only } : {}),
    ...(s?.sandbox ? { sandbox: { ...s.sandbox } } : {}),
  };
}

/** Hosts declared by every environment of the project (lower-case hostnames). */
export function environmentHosts(project: Pick<LoadedProject, 'config'>): string[] {
  const hosts = new Set<string>();
  for (const pages of Object.values(project.config.environments ?? {})) {
    for (const url of Object.values(pages)) {
      try {
        hosts.add(new URL(url).hostname.toLowerCase());
      } catch {
        /* ignore malformed */
      }
    }
  }
  return [...hosts];
}

/** HTTP authentication details an environment page URL carries (`https://user:password@host/`), decoded. */
export interface PageHttpCredentials {
  /** The page's origin (canonical: `scheme://host[:port]`): the only one they are given to. */
  origin: string;
  username: string;
  password: string;
}

/**
 * A URL without its sign-in details (`user:password@`) and those details, decoded, when it has any (http(s) only).
 * The rest of the URL is kept as written. Any other URL is returned as it is.
 */
export function withoutCredentials(url: string): { url: string; credentials?: PageHttpCredentials } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url };
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || (!u.username && !u.password)) return { url };
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const credentials = { origin: u.origin, username: decode(u.username), password: decode(u.password) };
  // The authority's last `@` ends the details; what follows it is kept as written (a base path, no trailing slash added).
  let clean = url.replace(/^([\u0000-\u0020]*[a-z][a-z0-9+.-]*:[\\/]{2})[^/\\?#]*@/i, '$1');
  try {
    const c = new URL(clean);
    if (c.username || c.password || c.origin !== u.origin) throw new Error('not cleaned');
  } catch {
    u.username = '';
    u.password = '';
    clean = u.href;
  }
  return { url: clean, credentials };
}

/**
 * The HTTP credentials the browser of a run on environment `envName` answers an authentication challenge with: those
 * written in its page URLs (`https://user:password@host/`), for that page's origin only — never sent to another origin.
 * One origin at most (a browser has one set of credentials): pages on several origins with details, or two different
 * details for one origin, are a `problem` (the run is refused). None: `{}`.
 */
export function environmentHttpCredentials(project: Pick<LoadedProject, 'config'>, envName: string): { credentials?: PageHttpCredentials; problem?: string } {
  const envs = project.config.environments ?? {};
  const pages = Object.hasOwn(envs, envName) ? envs[envName] : {};
  const found = new Map<string, PageHttpCredentials>();
  for (const url of Object.values(pages ?? {})) {
    const c = withoutCredentials(url).credentials;
    if (!c) continue;
    const seen = found.get(c.origin);
    if (seen && (seen.username !== c.username || seen.password !== c.password)) {
      return { problem: `environment ${envName} gives ${c.origin} two different sign-in details in its page URLs: write the same \`user:password@\` in each, or only once` };
    }
    found.set(c.origin, c);
  }
  if (found.size > 1) {
    return {
      problem:
        `environment ${envName} has sign-in details (\`user:password@\`) in page URLs of ${found.size} origins (${[...found.keys()].join(', ')}): ` +
        'the browser answers one origin with them — keep them in the pages of one origin, and sign in to the others with a persona',
    };
  }
  const [only] = found.values();
  return only ? { credentials: only } : {};
}
