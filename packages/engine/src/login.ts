/**
 * Signing a persona in (`retake login`, `retake new`, the `auth_login` job), moved from the CLI (L3.1): which persona a
 * sign-in is for, and the sign-in itself under an interrupt port — a headed window a human signs in to and closes, or
 * the persona's login steps, headless. Native errors with the CLI's messages (LoginOptionError says which ones are
 * usage errors); what it tells its client goes through `SignInPorts`. Nothing here ever receives a credential.
 */
import { LEGACY_PERSONA, resolveEnvironment, resolvePersonas } from '@retake/core';
import type { LoadedProject, ResolvedEnvironment, ResolvedPersona, WorkPolicy } from '@retake/core';
import type { SignInResult } from '@retake/runner-web/types';
import { retakeHome } from '@retake/core/io';
import type { CaptureSessions } from './capture/runner.js';
import type { InterruptPort } from './interrupts.js';

/** A sign-in that cannot be made as asked (`usage`: the CLI reports it as a usage error, exit 2; else exit 1). */
export class LoginOptionError extends Error {
  constructor(
    message: string,
    readonly usage: boolean,
  ) {
    super(message);
    this.name = 'LoginOptionError';
  }
}

/** The persona a sign-in is for: `wanted`, else the environment's only one. */
function pickPersona(project: LoadedProject, envName: string, personas: ResolvedPersona[], wanted: string | undefined): ResolvedPersona {
  if (personas.length === 0) {
    const withPersonas = Object.keys(project.config.environments ?? {}).filter((e) => resolvePersonas(project, e, { home: retakeHome() }).length > 0);
    throw new LoginOptionError(
      withPersonas.length
        ? `environment "${envName}" of ${project.slug} has no personas: pick an environment that has some with --env (${withPersonas.join(', ')})`
        : `project "${project.slug}" declares no sign-in for environment "${envName}": name its accounts in auth.personas of project.yaml (docs/guide/environments.md: "Signing in: personas and sessions")`,
      false,
    );
  }
  if (wanted !== undefined) {
    const p = personas.find((x) => x.name === wanted);
    if (!p) throw new LoginOptionError(`environment "${envName}" has no persona "${wanted}" (personas: ${personas.map((x) => x.name).join(', ')})`, true);
    return p;
  }
  if (personas.length > 1) throw new LoginOptionError(`environment "${envName}" has ${personas.length} personas: pick one with --persona ${personas.map((x) => x.name).join(' | ')}`, true);
  return personas[0];
}

/**
 * The environment and the persona `retake login [--env] [--persona] [--auto]` signs in (the single-account
 * `auth.profile` form included). LoginOptionError when it cannot be signed in as asked.
 */
export function loginTarget(project: LoadedProject, opts: { env?: string; persona?: string; auto?: boolean }): { env: ResolvedEnvironment; persona: ResolvedPersona } {
  const env = resolveEnvironment(project, opts.env);
  const personas = resolvePersonas(project, env.name, { home: retakeHome() });
  const legacy = personas.find((p) => p.legacy);
  if (legacy) {
    // The single-account form (auth.profile): a window on that profile, as before personas.
    if (opts.persona !== undefined && opts.persona !== LEGACY_PERSONA) {
      throw new LoginOptionError(`environment "${env.name}" has no personas (its auth is one browser profile): leave --persona out, or name the accounts in auth.personas`, true);
    }
    if (opts.auto) throw new LoginOptionError('--auto runs a persona\'s login steps: name the account in auth.personas with `login:` steps (the single-account auth.profile has none)', true);
    if (!legacy.profileDir) {
      throw new LoginOptionError(
        `project "${project.slug}" has no browser profile for environment "${env.name}": name its accounts in auth.personas of project.yaml (docs/guide/environments.md: "Signing in: personas and sessions")`,
        false,
      );
    }
  }
  const persona = legacy ?? pickPersona(project, env.name, personas, opts.persona);
  if (opts.auto && !persona.login?.length) {
    throw new LoginOptionError(`persona "${persona.name}" declares no login steps (auth.personas.${persona.name}.login): sign in by hand — leave --auto out`, false);
  }
  return { env, persona };
}

/** What a sign-in tells its client while it runs (the CLI prints it; the worker records job events). */
export interface SignInPorts {
  /** A signal stops it: the window or the browser closes; no session file or status is written (jobs signInStoppedText). */
  interrupts: InterruptPort;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** The window (headed) or the headless browser (auto) shows its first page. */
  onOpen?(url: string): void;
  /** What signs it in: the capture runner's sessions (its composition root's). */
  sessions: Pick<CaptureSessions, 'signIn'>;
}

export type SignInOutcome = { interrupted: true } | { interrupted: false; result: SignInResult };

/**
 * Sign one persona in: a headed window a human signs in to and closes, or `auto` (its login steps, headless). The
 * check made afterwards (the way a run sees the session) is in the result. Interrupted: the window or the browser
 * closed, no session file or status written (a profile persona's existing profile keeps what the window changed).
 */
export async function signInPersona(
  project: LoadedProject,
  env: { name: string; pages: Record<string, string> },
  persona: ResolvedPersona,
  opts: { mode: 'headed' | 'auto'; page?: string; url?: string; policy: WorkPolicy },
  ports: SignInPorts,
): Promise<SignInOutcome> {
  if (opts.mode === 'headed' && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new LoginOptionError(
      `retake login opens a browser window and no display is available (DISPLAY / WAYLAND_DISPLAY are not set)${persona.login?.length ? ': add --auto to use the persona\'s login steps' : ''}`,
      false,
    );
  }
  const stop = await ports.interrupts.open();
  let result: SignInResult;
  try {
    result = await ports.sessions.signIn({
      project,
      policy: opts.policy,
      env,
      persona,
      mode: opts.mode,
      ...(opts.page !== undefined ? { page: opts.page } : {}),
      ...(opts.url !== undefined ? { url: opts.url } : {}),
      signal: stop.signal,
      log: (level, msg) => ports.log(level, msg),
      ...(ports.onOpen ? { onOpen: ports.onOpen } : {}),
    });
  } catch (e) {
    if (stop.interrupted) return { interrupted: true };
    throw e;
  } finally {
    stop.dispose();
  }
  if (stop.interrupted) return { interrupted: true };
  return { interrupted: false, result };
}
