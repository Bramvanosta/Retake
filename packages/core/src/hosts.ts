/**
 * The host allow-list (pure helpers): hooks, the mailbox of `wait_for_email` and other outbound requests of a run may
 * only contact localhost, the hosts of the project's environments and `project.allow_hosts` entries. Shared by core
 * validation (project.yaml `mailbox`) and @demo-studio/hooks (which re-exports them and adds the refusals).
 */
import { environmentHosts } from './env.js';
import type { LoadedProject } from './types.js';

/** Always allowed. */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/**
 * A loopback host: localhost, `*.localhost`, 127.0.0.0/8 or ::1 (brackets, case and a trailing dot aside). The only
 * hosts a sandbox URL may name (L1.8): a sandbox is reset — its databases dropped and recreated — before every take.
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((n) => Number(n) <= 255);
}

/** Lower-case, without IPv6 brackets or a trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** A host in its ASCII form (an internationalised name in punycode, as URLs carry it); unchanged when not a valid one. */
function asciiHost(host: string): string {
  if (/^[\x21-\x7e]*$/.test(host)) return host;
  try {
    return new URL(`http://${host}`).hostname || host;
  } catch {
    return host;
  }
}

/**
 * An `allow_hosts` / `read_only.hosts` entry as a host pattern. Accepts "api.example.com", "*.example.com" (any
 * subdomain), "https://api.example.com/x", "db.example.com:5432", "[::1]:5432"; an internationalised name is matched in
 * its punycode form (the one URLs carry).
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
  const h = normalizeHost(hostPort ? hostPort[1] : e);
  return h.startsWith('*.') ? `*.${asciiHost(h.slice(2))}` : asciiHost(h);
}

const HOST_HINT = 'write a host ("api.example.com", "api.example.com:8443"), "*.example.com" for its subdomains, "*" for every host, or a URL';

/**
 * Why a `read_only.hosts` entry is not a host pattern, or null: a host (an internationalised one too), `host:port`,
 * `[ipv6]`, `*.domain`, `"*"`, or an http(s) URL (its host). A path, a leading dot or a wildcard elsewhere would
 * guard nothing.
 */
export function hostPatternError(entry: string): string | null {
  const e = entry.trim();
  if (e === '*') return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e)) {
    try {
      if (new URL(e).hostname) return null;
    } catch {
      /* refused below */
    }
    return `"${entry}" is not a URL with a host: ${HOST_HINT}`;
  }
  if (/^\[[0-9a-f:.]+\](?::\d{1,5})?$/i.test(e)) return null;
  const m = /^(\*\.)?([^\s:/?#*[\]@]+)(?::\d{1,5})?$/.exec(e);
  const label = /^(?!-)[a-z0-9_-]+(?<!-)$/i;
  const labels = m ? asciiHost(m[2]).replace(/\.$/, '').split('.') : [];
  if (!m || !labels.every((l) => label.test(l))) return `"${entry}" is not a host: ${HOST_HINT} (no path, no leading dot)`;
  return null;
}

/** Whether a normalised host matches a host pattern: exact, `*.suffix` (subdomains only), or `"*"` (every host). */
export function hostMatches(host: string, pattern: string): boolean {
  return pattern === '*' || (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern);
}

/**
 * Hosts a project may contact: localhost, the hosts of every project environment, project.allow_hosts, and the
 * loopback hosts of its sandboxes' mailboxes and databases (L1.8: `db.localhost`, `127.0.0.2`… — validated loopback).
 */
export function allowedHosts(project: Pick<LoadedProject, 'config'>): string[] {
  const out = new Set<string>(LOCAL_HOSTS);
  for (const h of environmentHosts(project)) out.add(normalizeHost(h));
  for (const e of project.config.allow_hosts ?? []) out.add(normalizeAllowEntry(e));
  for (const s of Object.values(project.config.environment_settings ?? {})) {
    if (!s.sandbox) continue;
    for (const url of [s.mailbox?.url, ...Object.values(s.databases ?? {}).map((d) => d.url)]) {
      if (url === undefined) continue;
      try {
        const host = normalizeHost(new URL(url).hostname);
        if (host && isLoopbackHost(host)) out.add(host);
      } catch {
        /* validation reports it */
      }
    }
  }
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
