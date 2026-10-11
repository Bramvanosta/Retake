import { environmentHosts } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';
import { databaseTarget, isDatabaseUrl } from './db-url.js';
import { HookSecurityError } from './errors.js';

/** Always allowed. */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/** Lower-case, without IPv6 brackets or a trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * An `allow_hosts` entry as a host pattern. Accepts "api.example.com", "*.example.com" (any subdomain),
 * "https://api.example.com/x", "db.example.com:5432", "[::1]:5432".
 */
export function normalizeAllowEntry(entry: string): string {
  const e = entry.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e)) {
    try {
      const host = new URL(e).hostname;
      if (host) return normalizeHost(host);
    } catch {
      /* fall through: treated as a plain host */
    }
  }
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(e);
  if (bracketed) return normalizeHost(bracketed[1]);
  const hostPort = /^([^:]+):\d+$/.exec(e);
  if (hostPort) return normalizeHost(hostPort[1]);
  return normalizeHost(e);
}

/** Hosts hooks may contact: localhost, the hosts of every project environment, project.allow_hosts. */
export function allowedHosts(project: Pick<LoadedProject, 'config'>): string[] {
  const out = new Set<string>(LOCAL_HOSTS);
  for (const h of environmentHosts(project)) out.add(normalizeHost(h));
  for (const e of project.config.allow_hosts ?? []) out.add(normalizeAllowEntry(e));
  return [...out];
}

export function isHostAllowed(host: string, project: Pick<LoadedProject, 'config'>): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return allowedHosts(project).some((p) =>
    p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p,
  );
}

function refuse(host: string, project: Pick<LoadedProject, 'config'> & { slug?: string }): HookSecurityError {
  const name = project.slug ?? project.config.name;
  return new HookSecurityError(
    `refusing to contact ${host}: it is not in the allow-list of project "${name}" ` +
      `(allowed: ${allowedHosts(project).join(', ')}); add it to allow_hosts in project.yaml if it is a staging host`,
    'host',
  );
}

/**
 * Throws HookSecurityError unless the URL's host is allowed for the project. Accepts http(s) URLs and
 * database connection strings (postgres://, postgresql://, socket:); unix-socket connections are local.
 * Error messages name the host only, never the URL (it may carry credentials).
 */
export function checkHostAllowed(url: string, project: Pick<LoadedProject, 'config'> & { slug?: string }): void {
  if (isDatabaseUrl(url)) {
    let target;
    try {
      target = databaseTarget(url);
    } catch {
      throw new HookSecurityError('refusing a malformed database connection URL (its host cannot be checked)', 'host');
    }
    if (target.socket) return;
    if (!isHostAllowed(target.host, project)) throw refuse(normalizeHost(target.host), project);
    return;
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new HookSecurityError('refusing a malformed URL (its host cannot be checked)', 'host');
  }
  if (!host) throw new HookSecurityError('refusing a URL without a host', 'host');
  if (!isHostAllowed(host, project)) throw refuse(normalizeHost(host), project);
}
