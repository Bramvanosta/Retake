import { LOCAL_HOSTS, allowedHosts, hostRefusalMessage, isHostAllowed, normalizeAllowEntry, normalizeHost, shellHostRefs } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';

/** The pure allow-list helpers live in @demo-studio/core (project validation uses them too). */
export { LOCAL_HOSTS, allowedHosts, isHostAllowed, normalizeAllowEntry, normalizeHost };
import { databaseTarget, isDatabaseUrl } from './db-url.js';
import { HookSecurityError } from './errors.js';

function refuse(host: string, project: Pick<LoadedProject, 'config'> & { slug?: string }, via?: string): HookSecurityError {
  return new HookSecurityError(hostRefusalMessage(host, project, via), 'host');
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

/**
 * Throws HookSecurityError when a shell command names a host outside the allow-list (core shellHostRefs: URLs,
 * `$VARS` expanded from `vars` — the environment sh gets —, database-client hosts and PGHOST, ssh / scp / rsync
 * destinations, the hook's own `env` values), or a host computed when it runs (`$(…)`, backticks).
 */
export function checkShellHosts(
  cmd: string,
  vars: NodeJS.ProcessEnv,
  env: Record<string, string> | undefined,
  project: Pick<LoadedProject, 'config'> & { slug?: string },
): void {
  for (const ref of shellHostRefs(cmd, { vars, env })) {
    if (ref.unresolved) {
      throw new HookSecurityError(`refusing a shell command whose host is computed at run time (${ref.via}): write the host, or use an http hook`, 'host');
    }
    if (!isHostAllowed(ref.host, project)) throw refuse(ref.host, project, `${ref.via} in the shell hook`);
  }
}
