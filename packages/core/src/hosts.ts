/**
 * The host allow-list (pure helpers): hooks, the mailbox of `wait_for_email` and other outbound requests of a run may
 * only contact localhost, the hosts of the project's environments and `project.allow_hosts` entries. Shared by core
 * validation (project.yaml `mailbox`) and @demo-studio/hooks (which re-exports them and adds the refusals).
 */
import { environmentHosts } from './env.js';
import type { LoadedProject } from './types.js';

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

/** Hosts a project may contact: localhost, the hosts of every project environment, project.allow_hosts. */
export function allowedHosts(project: Pick<LoadedProject, 'config'>): string[] {
  const out = new Set<string>(LOCAL_HOSTS);
  for (const h of environmentHosts(project)) out.add(normalizeHost(h));
  for (const e of project.config.allow_hosts ?? []) out.add(normalizeAllowEntry(e));
  return [...out];
}

export function isHostAllowed(host: string, project: Pick<LoadedProject, 'config'>): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return allowedHosts(project).some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

/**
 * Why a host is refused (hooks of every kind, R-SEC-06). Names the host, never a URL (it may carry credentials).
 * `via` says how the host was reached ("URL in the shell hook", "blocked while the js hook ran"…).
 */
export function hostRefusalMessage(host: string, project: Pick<LoadedProject, 'config'> & { slug?: string }, via?: string): string {
  const name = project.slug ?? project.config.name;
  return (
    `refusing to contact ${host}${via ? ` (${via})` : ''}: it is not in the allow-list of project "${name}" ` +
    `(allowed: ${allowedHosts(project).join(', ')}); add it to allow_hosts in project.yaml if it is a staging host`
  );
}

/**
 * A host outside the allow-list was refused by the runner's guarded js hook tab (runner-web hook-page.ts).
 * @demo-studio/hooks turns it into a `HookSecurityError` (status `refused`). `detail` is appended to the message.
 */
export class HostRefusedError extends Error {
  readonly hosts: string[];
  constructor(
    hosts: readonly string[],
    project: Pick<LoadedProject, 'config'> & { slug?: string },
    via?: string,
    options?: { cause?: unknown; detail?: string },
  ) {
    const detail = options?.detail ? `; ${options.detail}` : '';
    super(`${hostRefusalMessage(hosts.join(', '), project, via)}${detail}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HostRefusedError';
    this.hosts = [...hosts];
  }
}

/** Whether an error is a `HostRefusedError` (also across module copies: checked by name). */
export function isHostRefusedError(e: unknown): e is HostRefusedError {
  return e instanceof HostRefusedError || (e instanceof Error && e.name === 'HostRefusedError');
}

/**
 * The network host a browser request to `url` contacts (lower-case, no brackets), or null for URLs that reach no
 * host: data:, blob:, about:, javascript:, file:, chrome-internal pages.
 */
export function networkHost(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(https?|wss?|ftp):$/.test(u.protocol)) return null;
  return u.hostname ? normalizeHost(u.hostname) : null;
}
