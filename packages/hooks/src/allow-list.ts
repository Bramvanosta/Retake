import { LOCAL_HOSTS, allowedHosts, isHostAllowed, normalizeAllowEntry, normalizeHost } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';

/** The pure allow-list helpers live in @demo-studio/core (project validation uses them too). */
export { LOCAL_HOSTS, allowedHosts, isHostAllowed, normalizeAllowEntry, normalizeHost };
import { databaseTarget, isDatabaseUrl } from './db-url.js';
import { HookSecurityError } from './errors.js';

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
