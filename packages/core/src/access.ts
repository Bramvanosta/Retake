/**
 * The access of a run (L1.7, R-ENV-02 / R-ENV-04): what project.yaml allows on an environment and what the command
 * line confirms. A production environment is read-only unless project.yaml sets `access: read-write` AND the run is
 * given `--allow-writes`; without the flag it runs read-only, with a notice. Pure helpers.
 */
import { environmentAccess, resolveEnvironment } from './env.js';
import { hostMatches, networkHost, normalizeAllowEntry, normalizeHost } from './hosts.js';
import type { EnvironmentAccess, LoadedProject, ResolvedEnvironment } from './types.js';

/** `--allow-writes` given where it cannot apply (a read-only environment): a usage error. */
export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}

/** Whether an error is an `AccessError` (also across module copies: checked by name). */
export function isAccessError(e: unknown): e is AccessError {
  return e instanceof AccessError || (e instanceof Error && e.name === 'AccessError');
}

export interface RunAccess {
  env: string;
  production: boolean;
  /** What project.yaml allows (environmentAccess). */
  configured: EnvironmentAccess;
  /** The run's effective access. */
  mode: EnvironmentAccess;
  /** `--allow-writes` made a production run read-write. */
  allow_writes: boolean;
  /** Said once when the run starts: a production environment that allows writes runs read-only without the flag. */
  notice?: string;
  /** Said once when the run starts: this run writes to production. */
  warning?: string;
  /**
   * Hosts of the project's other environments that this run must not write to (crossEnvironmentHosts; set when the
   * project is given): a hook that writes to one is refused, the browser stops writes to them — in every run.
   */
  protected?: ProtectedHost[];
  /** Page hosts of the environments this run may write to: never protected (crossEnvironmentHosts). */
  writable?: string[];
}

/** A host of a read-only environment (production, `access: read-only`) that a run on another environment must not write to. */
export interface ProtectedHost {
  /** Host pattern: a page's host or a `read_only.hosts` entry (`*.example.com`). */
  host: string;
  /** The environment it belongs to. */
  env: string;
  production: boolean;
  configured: EnvironmentAccess;
}

type AccessEnv = Pick<ResolvedEnvironment, 'name' | 'production' | 'access'>;

/**
 * The hosts of the project's other environments a run on `runEnv` must not write to (L1.7): the pages' hosts and
 * `read_only.hosts` entries of every environment such a run would be read-only on (production, `access: read-only`) —
 * unless that environment's own access applies (production with `access: read-write`, and `--allow-writes`). A host
 * shared with an environment this run may write to (`writable`: the page hosts of read-write environments, the run's
 * own included) is never protected — hosts, ports aside. A project without such environments protects nothing.
 */
export function crossEnvironmentHosts(project: Pick<LoadedProject, 'config'>, runEnv: string, allowWrites = false): { protected: ProtectedHost[]; writable: string[] } {
  const writable = new Set<string>();
  const candidates: ProtectedHost[] = [];
  for (const name of Object.keys(project.config.environments ?? {})) {
    const env = resolveEnvironment(project, name);
    const access = runAccess(env, allowWrites);
    const pageHosts = Object.values(env.pages).flatMap((u) => networkHost(u) ?? []);
    if (access.mode === 'read-write') {
      for (const h of pageHosts) writable.add(h);
      continue;
    }
    // The run's own read-only environment is its write policy's (compileWritePolicy), not a protected one.
    if (name === runEnv) continue;
    const listed = (env.read_only?.hosts ?? []).filter((h) => h.trim() !== '*').map(normalizeAllowEntry);
    for (const host of [...pageHosts, ...listed]) {
      if (!candidates.some((c) => c.host === host)) candidates.push({ host, env: name, production: access.production, configured: access.configured });
    }
  }
  return { protected: candidates.filter((c) => !writable.has(c.host)), writable: [...writable] };
}

/** The protected host (crossEnvironmentHosts) a host belongs to, or null: never one of the run's writable hosts. */
export function protectedBy(host: string, access: { protected?: readonly ProtectedHost[]; writable?: readonly string[] }): ProtectedHost | null {
  const h = normalizeHost(host);
  if (!h || !access.protected?.length || access.writable?.includes(h)) return null;
  return access.protected.find((p) => hostMatches(h, p.host)) ?? null;
}

/**
 * The access of a run on `env`, never throwing: `--allow-writes` only counts where project.yaml sets
 * `access: read-write` on a production environment (journal replays use it for each entry's own environment).
 */
export function runAccess(env: AccessEnv, allowWrites = false, project?: Pick<LoadedProject, 'config'>): RunAccess {
  const production = env.production === true;
  const configured = environmentAccess(env);
  const base = { env: env.name, production, configured, ...(project ? crossEnvironmentHosts(project, env.name, allowWrites) : {}) };
  if (configured === 'read-only') return { ...base, mode: 'read-only', allow_writes: false };
  if (!production) return { ...base, mode: 'read-write', allow_writes: false };
  if (!allowWrites) {
    return {
      ...base,
      mode: 'read-only',
      allow_writes: false,
      notice: `environment ${env.name} is production and project.yaml allows writes (access: read-write), but this run is read-only: pass --allow-writes to write`,
    };
  }
  return { ...base, mode: 'read-write', allow_writes: true, warning: `writes go to production: environment ${env.name} runs read-write (--allow-writes)` };
}

/**
 * The access of a run, from the environment and `--allow-writes` (see the matrix in docs/DESIGN.md §1). Throws
 * AccessError when the flag is given on a read-only environment: it confirms writes, it never grants them. With the
 * project: the hosts of its other environments the run must not write to (`protected`, crossEnvironmentHosts).
 */
export function resolveRunAccess(env: AccessEnv, opts: { allowWrites?: boolean; project?: Pick<LoadedProject, 'config'> } = {}): RunAccess {
  const access = runAccess(env, opts.allowWrites === true, opts.project);
  if (opts.allowWrites && access.configured === 'read-only') {
    throw new AccessError(
      `environment ${env.name} is read-only in project.yaml${access.production && env.access === undefined ? ' (production: true)' : ' (access: read-only)'}: ` +
        '--allow-writes only confirms writes on a production environment whose project.yaml sets access: read-write',
    );
  }
  return access;
}

/** The part of a run's access a hook refusal names (RunAccess satisfies it). */
export interface HookAccess {
  env: string;
  mode: EnvironmentAccess;
  production?: boolean;
  configured?: EnvironmentAccess;
  /** Hosts of other environments the run must not write to (RunAccess.protected). */
  protected?: readonly ProtectedHost[];
  writable?: readonly string[];
}

/** What to do about a writing hook on a read-only run: where it may run instead. */
export function readOnlyHookAdvice(access: HookAccess): string {
  return access.production && access.configured === 'read-write'
    ? 'pass --allow-writes to let it write to production'
    : `hooks that write run on a read-write environment only (environment ${access.env} is ${access.production ? 'production, ' : ''}read-only in project.yaml)`;
}

/** The refusal of one hook that writes, on a read-only run (hooks' HookSecurityError reason `read-only`). */
export function readOnlyHookMessage(reason: string, access: HookAccess): string {
  return `refusing a hook that writes (${reason}) on read-only environment ${access.env}: ${readOnlyHookAdvice(access)}; \`optional: true\` does not skip a refusal`;
}

/** The refusal of a hook that writes (`reason`) to a host (`host`, else named by the reason) of another, read-only environment. */
export function protectedHostMessage(reason: string, hit: ProtectedHost, access: Pick<HookAccess, 'env'>, host?: string): string {
  const advice =
    hit.production && hit.configured === 'read-write'
      ? 'pass --allow-writes to let it write to production'
      : `environment ${hit.env} is ${hit.production ? 'production, ' : ''}read-only in project.yaml`;
  return (
    `refusing a hook that writes (${reason}) to ${host ? `${host}, ` : ''}a host of environment ${hit.env} — this run is on environment ${access.env}: ` +
    `${advice}; \`optional: true\` does not skip a refusal`
  );
}
