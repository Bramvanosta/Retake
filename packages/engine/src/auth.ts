/**
 * What is known of personas' saved sessions, without opening a browser (`retake auth status`, `retake doctor`, the MCP
 * `auth_status` tool). Moved from the CLI (L3.1); `check` (a live, headless check) stays in the CLI: it opens Chromium.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { collectSecretRefs } from '@retake/core/base';
import { planPersonas, resolveEnvironment, resolvePersonas } from '@retake/core/environment';
import { sandboxOf } from '@retake/core/sandbox';
import type { LoadedProject, Scenario } from '@retake/core/model';
import type { ResolvedPersona } from '@retake/core/environment';
import { retakeHome } from '@retake/core/io';
import type { CaptureSessions } from './capture/runner.js';

/** The `retake login` command for a persona (messages print it). */
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
  /** Who checked it last: the preflight of a run, `retake login`, `retake auth status --check`. */
  by?: 'preflight' | 'login' | 'auth-status' | 'run';
  run?: string;
  /** Where the check ended (origin + path). */
  at?: string;
  detail?: string;
  /** The master profile is held by a running browser (a `retake login` window?). */
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

/** What a persona's state is read through: the capture runner's sessions (its lock and its last status; no browser). */
export type PersonaStateReads = Pick<CaptureSessions, 'lock' | 'status'>;

/** The state of one persona's saved session: its files, its lock and its last status (no browser). */
export async function personaState(project: LoadedProject, persona: ResolvedPersona, command: LoginCommandOf, sessions: PersonaStateReads): Promise<PersonaState> {
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
    // The legacy auth.storage_state file is the user's export: `retake login` has no window for it (it refuses).
    ...(persona.legacy && persona.session === 'storage_state'
      ? { fix: `export ${tildePath(persona.snapshot ?? 'its auth.storage_state file')} again (or name the account in auth.personas, then retake login)` }
      : { command: command({ project: project.slug, env: persona.env, ...(persona.legacy ? {} : { persona: persona.name }) }) }),
  };
  if (hasMaster && persona.profileDir) {
    const lock = await sessions.lock(persona.profileDir);
    if (lock.state === 'live') out.in_use = lock.pid ? { pid: lock.pid } : {};
  }
  if (!hasMaster && !hasSnapshot) return out;
  const st = await sessions.status(persona.statusFile);
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
  sessions: PersonaStateReads,
  env?: string,
  home?: string,
): Promise<Array<{ persona: ResolvedPersona; state: PersonaState }>> {
  const envs = env !== undefined ? [resolveEnvironment(project, env).name] : Object.keys(project.config.environments ?? {});
  const out: Array<{ persona: ResolvedPersona; state: PersonaState }> = [];
  for (const e of envs) {
    for (const persona of resolvePersonas(project, e, { home: home ?? retakeHome() })) out.push({ persona, state: await personaState(project, persona, command, sessions) });
  }
  return out;
}

/** What a scenario's run does with one persona's session (scenarioPersonaStates). */
export interface ScenarioPersona {
  persona: ResolvedPersona;
  state: PersonaState;
  /**
   * Every run's preflight signs it in by itself, off camera, when its session is not valid: it has `login:` steps and
   * each `{{env:…}}` they use is set in the worker's environment (review B M3: a missing one fails the run instead).
   */
  auto: boolean;
  /** It has a `check`: the preflight checks its session before anything is filmed. */
  has_check: boolean;
  /** The environment variables its login steps use that the worker's environment lacks (names, never values). */
  login_env_missing?: string[];
  /** Keychain items its login steps read: never looked up here (no keychain prompt, no value read) — taken as there. */
  login_keychain?: number;
}

/**
 * The personas a run of scenario `sc` signs in on an environment (L4.4, the Run screen's preflight panel), the way the
 * run plans them (core planPersonas: its pages, `open: {page}`, tabs, multi-page scenes; the hooks' tabs when `hooks`),
 * each with what is known of its session (no browser), whether every run signs it in by itself, off camera (its
 * `login:` steps, their `{{env:…}}` set in `workerEnv` — the environment of the worker that runs it), and whether the
 * preflight checks it (`check`).
 */
export async function scenarioPersonaStates(
  project: LoadedProject,
  sc: Scenario,
  command: LoginCommandOf,
  sessions: PersonaStateReads,
  opts: { env?: string; hooks: boolean; workerEnv?: NodeJS.ProcessEnv },
): Promise<{ env: string; personas: ScenarioPersona[]; issues: string[] }> {
  const env = resolveEnvironment(project, opts.env ?? sc.env);
  const personas = resolvePersonas(project, env.name, { home: retakeHome() });
  const plan = planPersonas(sc, { env: env.name, envPages: env.pages, personas, until: null, hooks: opts.hooks, ...(project.config.hooks ? { projectHooks: project.config.hooks } : {}) });
  const workerEnv = opts.workerEnv ?? process.env;
  const out: ScenarioPersona[] = [];
  const issues = plan.issues.map((i) => i.message);
  for (const name of plan.used) {
    const persona = personas.find((p) => p.name === name);
    if (!persona) continue;
    const refs = [...collectSecretRefs(persona.login ?? [])];
    const missing = [...new Set(refs.filter((r) => r.startsWith('env:')).map((r) => r.slice(4)).filter((v) => workerEnv[v] === undefined))].sort();
    const keychain = refs.filter((r) => r.startsWith('keychain:')).length;
    const hasLogin = (persona.login?.length ?? 0) > 0;
    if (hasLogin && missing.length) {
      issues.push(
        `persona ${persona.name}: its login steps use ${missing.join(', ')}, not set in the environment of the worker that runs it: a run cannot sign it in by itself (set ${missing.length === 1 ? 'it' : 'them'} where the worker starts, or sign in from here)`,
      );
    }
    out.push({
      persona,
      state: await personaState(project, persona, command, sessions),
      auto: hasLogin && missing.length === 0,
      has_check: persona.check !== undefined,
      ...(missing.length ? { login_env_missing: missing } : {}),
      ...(hasLogin && keychain ? { login_keychain: keychain } : {}),
    });
  }
  return { env: env.name, personas: out, issues };
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
