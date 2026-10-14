import { normalizeDisplay } from './display.js';
import type { EnvironmentAccess, EnvironmentSettings, LoadedProject, ResolvedEnvironment } from './types.js';

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
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
    pages: { ...pages },
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
