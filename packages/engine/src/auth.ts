/**
 * What is known of personas' saved sessions, without opening a browser (`studio auth status`, `studio doctor`, the MCP
 * `auth_status` tool). Moved from the CLI (L3.1); `check` (a live, headless check) stays in the CLI: it opens Chromium.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolveEnvironment, resolvePersonas, sandboxOf } from '@demo-studio/core';
import type { LoadedProject, ResolvedPersona } from '@demo-studio/core';

/** The `studio login` command for a persona (messages print it). */
export type LoginCommandOf = (p: { project: string; env: string; persona?: string }) => string;

/** A path under the home folder as ~/… (messages). */
export function tildePath(p: string): string {
  const h = homedir();
  return p === h ? '~' : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** What is known of one persona's session, without opening a browser (`auth status`, `doctor`). */
export interface PersonaState {
  project: string;
  env: string;
  persona: string;
  session: 'profile' | 'storage_state';
  legacy: boolean;
  /** never: no saved session at all; unchecked: saved, never checked; else the status of the last check. */
  status: 'valid' | 'expired' | 'error' | 'never' | 'unchecked';
  checked_at?: string;
  /** Who checked it last: the preflight of a run, `studio login`, `studio auth status --check`. */
  by?: 'preflight' | 'login' | 'auth-status' | 'run';
  run?: string;
  /** Where the check ended (origin + path). */
  at?: string;
  detail?: string;
  /** The master profile is held by a running browser (a `studio login` window?). */
  in_use?: { pid?: number };
  profile?: string;
  snapshot?: string;
  /** The command that signs it in (none for the legacy `auth.storage_state` file: it is exported again, `fix` says how). */
  command?: string;
  /** What to do when it is not valid and no command signs it in. */
  fix?: string;
  /**
   * An account of a sandbox (L1.8): signed in automatically, off camera, by every take that finds no valid session (a
   * reset drops the sessions the app stored) — never signing it in is normal.
   */
  sandbox?: boolean;
}

async function nonEmptyDir(dir: string | undefined): Promise<boolean> {
  if (!dir) return false;
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/** The state of one persona's saved session: its files, its lock and its last status (no browser). */
export async function personaState(project: LoadedProject, persona: ResolvedPersona, command: LoginCommandOf): Promise<PersonaState> {
  const { profileLock, readStatus } = await import('@demo-studio/runner-web');
  const hasMaster = persona.session === 'profile' && (await nonEmptyDir(persona.profileDir));
  const hasSnapshot = persona.snapshot !== undefined && existsSync(persona.snapshot);
  const out: PersonaState = {
    project: project.slug,
    env: persona.env,
    persona: persona.name,
    session: persona.session,
    legacy: persona.legacy,
    status: 'never',
    ...(sandboxOf(project, persona.env) ? { sandbox: true } : {}),
    ...(persona.profileDir ? { profile: persona.profileDir } : {}),
    ...(persona.snapshot ? { snapshot: persona.snapshot } : {}),
    // The legacy auth.storage_state file is the user's export: `studio login` has no window for it (it refuses).
    ...(persona.legacy && persona.session === 'storage_state'
      ? { fix: `export ${tildePath(persona.snapshot ?? 'its auth.storage_state file')} again (or name the account in auth.personas, then studio login)` }
      : { command: command({ project: project.slug, env: persona.env, ...(persona.legacy ? {} : { persona: persona.name }) }) }),
  };
  if (hasMaster && persona.profileDir) {
    const lock = await profileLock(persona.profileDir);
    if (lock.state === 'live') out.in_use = lock.pid ? { pid: lock.pid } : {};
  }
  if (!hasMaster && !hasSnapshot) return out;
  const st = await readStatus(persona.statusFile);
  if (!st) {
    out.status = 'unchecked';
    return out;
  }
  out.status = st.status;
  out.checked_at = st.checked_at;
  out.by = st.by;
  if (st.run) out.run = st.run;
  if (st.at) out.at = st.at;
  if (st.detail) out.detail = st.detail;
  return out;
}

/** Every persona of a project (every environment, or one), with its state. */
export async function projectPersonaStates(
  project: LoadedProject,
  command: LoginCommandOf,
  env?: string,
  home?: string,
): Promise<Array<{ persona: ResolvedPersona; state: PersonaState }>> {
  const envs = env !== undefined ? [resolveEnvironment(project, env).name] : Object.keys(project.config.environments ?? {});
  const out: Array<{ persona: ResolvedPersona; state: PersonaState }> = [];
  for (const e of envs) {
    for (const persona of resolvePersonas(project, e, home !== undefined ? { home } : {})) out.push({ persona, state: await personaState(project, persona, command) });
  }
  return out;
}

/**
 * A persona's state as a client outside this machine's shell may see it (the MCP `auth_status` tool): no profile or
 * snapshot path, ever. `detail` and `at` come from the filmed site (the last check's page): the caller keeps them apart
 * as untrusted text.
 */
export type PersonaStateView = Omit<PersonaState, 'profile' | 'snapshot'>;

export function personaStateView(s: PersonaState): PersonaStateView {
  const { profile: _profile, snapshot: _snapshot, ...rest } = s;
  return rest;
}
