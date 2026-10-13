import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { LEGACY_PERSONA, listProjects, loginCommand as coreLoginCommand, resolveEnvironment, resolvePersonas } from '@demo-studio/core';
import type { LoadedProject, ResolvedPersona } from '@demo-studio/core';
import type { PersonaCheckResult } from '@demo-studio/runner-web';
import { CliError, EXIT, UsageError, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { onInterrupt } from '../interrupt.js';
import type { Ui } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

type LoginCommandOf = (p: { project: string; env: string; persona?: string }) => string;

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `studio`, with `-C <root>` when the command line named the workspace root: the start of the commands messages print. */
export function studioCommand(global: GlobalOptions): string {
  return global.root ? `studio -C ${shellQuote(resolve(global.root))}` : 'studio';
}

/** The `studio login` command messages print; with `-C <root>` when the command line named the workspace root. */
export function loginCommandFor(global: GlobalOptions): LoginCommandOf {
  return (p) => coreLoginCommand(p).replace(/^studio /, `${studioCommand(global)} `);
}

/** A path under the home folder as ~/… (messages). */
export function tildePath(p: string): string {
  const h = homedir();
  return p === h ? '~' : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** "just now", "42 s ago", "3 min ago", "5 h ago", "2 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return iso;
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ── studio login ─────────────────────────────────────────────────────────────

export interface LoginOptions {
  env?: string;
  persona?: string;
  page?: string;
  url?: string;
  /** The persona's login steps, headless (no window). */
  auto?: boolean;
}

/** The persona `studio login` signs in: `--persona`, else the environment's only one. */
function pickPersona(project: LoadedProject, envName: string, personas: ResolvedPersona[], wanted: string | undefined): ResolvedPersona {
  if (personas.length === 0) {
    const withPersonas = Object.keys(project.config.environments ?? {}).filter((e) => resolvePersonas(project, e).length > 0);
    throw new CliError(
      withPersonas.length
        ? `environment "${envName}" of ${project.slug} has no personas: pick an environment that has some with --env (${withPersonas.join(', ')})`
        : `project "${project.slug}" declares no sign-in for environment "${envName}": name its accounts in auth.personas of project.yaml (README: "Signing in: personas and sessions")`,
    );
  }
  if (wanted !== undefined) {
    const p = personas.find((x) => x.name === wanted);
    if (!p) throw new UsageError(`environment "${envName}" has no persona "${wanted}" (personas: ${personas.map((x) => x.name).join(', ')})`);
    return p;
  }
  if (personas.length > 1) throw new UsageError(`environment "${envName}" has ${personas.length} personas: pick one with --persona ${personas.map((x) => x.name).join(' | ')}`);
  return personas[0];
}

/**
 * Sign one persona in and report it (shared by `studio login` and `studio new`): a headed window, or `auto` (its login
 * steps, headless). Exit 1 when the check made afterwards (the way a run sees the session) still fails; Ctrl-C closes
 * the window or the browser, saves nothing and exits 130.
 */
export async function signInPersona(
  ui: Ui,
  global: GlobalOptions,
  project: LoadedProject,
  env: { name: string; pages: Record<string, string> },
  persona: ResolvedPersona,
  opts: { auto?: boolean; page?: string; url?: string },
): Promise<ExitCode> {
  const c = ui.c;
  const mode = opts.auto ? 'auto' : 'headed';
  if (mode === 'headed' && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new CliError(`studio login opens a browser window and no display is available (DISPLAY / WAYLAND_DISPLAY are not set)${persona.login?.length ? ': add --auto to use the persona\'s login steps' : ''}`);
  }
  const who = `${c.bold(persona.name)} ${c.dim(`(env ${env.name})`)}`;
  const { signIn } = await import('@demo-studio/runner-web');
  const stop = await onInterrupt(ui);
  let res: Awaited<ReturnType<typeof signIn>>;
  try {
    res = await signIn({
      project,
      env,
      persona,
      mode,
      ...(opts.page !== undefined ? { page: opts.page } : {}),
      ...(opts.url !== undefined ? { url: opts.url } : {}),
      signal: stop.signal,
      log: (level, msg) => (level === 'warn' || level === 'error' ? ui.warn(msg) : ui.debug(msg)),
      onOpen: (url) =>
        ui.line(
          mode === 'auto'
            ? `${who}: checking its saved session, else signing in with its login steps, headless ${c.dim(`(${url.split(/[?#]/)[0]})`)}`
            : `${who}: a browser window is open on ${url.split(/[?#]/)[0]} — sign in, then close the window`,
        ),
    });
  } catch (e) {
    if (stop.interrupted) return EXIT.interrupted;
    throw e;
  } finally {
    stop.dispose();
  }
  if (stop.interrupted) return EXIT.interrupted;
  if (persona.legacy) {
    ui.ok(`profile saved: ${ui.path(res.profileDir ?? '')} (runs of ${project.slug} use a copy of it)`);
    return EXIT.ok;
  }
  const files = [
    res.profileDir ? `  ${c.dim('profile ')}  ${tildePath(res.profileDir)}` : null,
    res.snapshot ? `  ${c.dim('snapshot')}  ${tildePath(res.snapshot)} ${c.dim(`(${res.cookies} cookie${res.cookies === 1 ? '' : 's'})`)}` : null,
  ].filter((l): l is string => l !== null);
  const command = loginCommandFor(global)({ project: project.slug, env: env.name, persona: persona.name });
  switch (res.check.status) {
    case 'valid':
      if (res.kept) ui.warn(`${persona.name}: the window ended signed out — the session saved before still works and is kept`);
      ui.ok(`${who} signed in${res.alreadySignedIn ? ' (its session was still valid, kept as it is)' : ''}: ${res.check.detail} — runs use a copy of this session`);
      for (const l of files) ui.line(l);
      return EXIT.ok;
    case 'unchecked':
      ui.warn(`${persona.name}: session saved, not verified — the persona has no check (add check: {url, expect_text} to tell a signed-in page)`);
      for (const l of files) ui.line(l);
      return EXIT.ok;
    case 'error':
      ui.error(`${persona.name}: session saved, but it could not be checked — ${res.check.detail}`);
      return EXIT.failure;
    default:
      ui.error(`${persona.name} is still signed out: ${res.check.detail} — did the sign-in finish? Try again: ${command}`);
      return EXIT.failure;
  }
}

/** `studio login <project> [--env] [--persona] [--page] [--url] [--auto]`: sign one persona in and save its session. */
export async function loginCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: LoginOptions): Promise<ExitCode> {
  const project = await openProject(await openWorkspace(global), projectArg);
  const env = resolveEnvironment(project, opts.env);
  const personas = resolvePersonas(project, env.name);
  const legacy = personas.find((p) => p.legacy);
  if (legacy) {
    // The single-account form (auth.profile): a window on that profile, as before personas.
    if (opts.persona !== undefined && opts.persona !== LEGACY_PERSONA) {
      throw new UsageError(`environment "${env.name}" has no personas (its auth is one browser profile): leave --persona out, or name the accounts in auth.personas`);
    }
    if (opts.auto) throw new UsageError('--auto runs a persona\'s login steps: name the account in auth.personas with `login:` steps (the single-account auth.profile has none)');
    if (!legacy.profileDir) {
      throw new CliError(
        `project "${project.slug}" has no browser profile for environment "${env.name}": name its accounts in auth.personas of project.yaml (README: "Signing in: personas and sessions")`,
      );
    }
  }
  const persona = legacy ?? pickPersona(project, env.name, personas, opts.persona);
  if (opts.auto && !persona.login?.length) {
    throw new CliError(`persona "${persona.name}" declares no login steps (auth.personas.${persona.name}.login): sign in by hand — leave --auto out`);
  }
  return signInPersona(ui, global, project, env, persona, opts);
}

// ── studio auth status ───────────────────────────────────────────────────────

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

/** "checked 2 min ago (preflight of run …)". */
export function checkedText(s: Pick<PersonaState, 'checked_at' | 'by' | 'run'>, now = Date.now()): string {
  if (!s.checked_at) return '';
  const by =
    s.by === 'preflight'
      ? `preflight of run ${s.run ?? '?'}`
      : s.by === 'run'
        ? `expired during run ${s.run ?? '?'}`
        : s.by === 'login'
          ? 'studio login'
          : s.by === 'auth-status'
            ? 'auth status --check'
            : (s.by ?? '');
  return `checked ${ago(s.checked_at, now)}${by ? ` (${by})` : ''}`;
}

export interface AuthStatusOptions {
  project?: string;
  env?: string;
  /** Check every saved session now (headless, one after the other) instead of showing the last check. */
  check?: boolean;
  json?: boolean;
}

/**
 * `studio auth status [--project] [--env] [--check] [--json]`: every persona of every project (or one) — valid,
 * expired, never signed in, saved but unchecked, could not be checked — with the time of the last check and the command
 * that signs it in. `--check` re-checks each saved session live (the way a run would, without signing in) and saves
 * the result; exit 1 then when one is not valid.
 */
export async function authStatusCommand(ui: Ui, global: GlobalOptions, opts: AuthStatusOptions): Promise<ExitCode> {
  if (opts.env !== undefined && opts.project === undefined) throw new UsageError('--env needs --project (environments belong to a project)');
  const ws = await openWorkspace(global);
  const command = loginCommandFor(global);
  const projects: LoadedProject[] = [];
  if (opts.project !== undefined) projects.push(await openProject(ws, opts.project));
  else {
    for (const p of await listProjects(ws.root)) {
      try {
        projects.push(await openProject(ws, p.dir));
      } catch (e) {
        ui.warn(`${p.slug}: ${errorMessage(e).split('\n')[0]}`);
      }
    }
  }
  const rows: Array<{ persona: ResolvedPersona; state: PersonaState; project: LoadedProject }> = [];
  for (const project of projects) {
    for (const r of await projectPersonaStates(project, command, opts.env)) rows.push({ ...r, project });
  }
  if (opts.check) {
    const { checkSavedSession, profileLock, writeStatus, PreflightError } = await import('@demo-studio/runner-web');
    /** Not checked now: nothing of the last check is shown with it. */
    const unchecked = (s: PersonaState, detail: string) => {
      Object.assign(s, { status: 'error', detail });
      for (const k of ['checked_at', 'by', 'run', 'at'] as const) delete s[k];
    };
    const stop = await onInterrupt(ui);
    try {
      for (const r of rows) {
        if (r.state.status === 'never') continue;
        if (r.state.in_use) {
          unchecked(r.state, 'not checked');
          continue;
        }
        if (!opts.json) ui.setStatus(ui.c.dim(`  … checking ${r.project.slug} · ${r.state.env} · ${r.state.persona}`));
        let res: PersonaCheckResult;
        try {
          res = await checkSavedSession({
            project: r.project,
            env: resolveEnvironment(r.project, r.state.env),
            persona: r.persona,
            signal: stop.signal,
            log: (level, msg) => ui.debug(msg),
          });
        } catch (e) {
          if (stop.interrupted) return EXIT.interrupted;
          if (e instanceof PreflightError && r.persona.profileDir) {
            // Opened meanwhile (a studio login window?).
            const lock = await profileLock(r.persona.profileDir);
            r.state.in_use = lock.pid ? { pid: lock.pid } : {};
            unchecked(r.state, 'not checked');
          } else {
            unchecked(r.state, `not checked: ${errorMessage(e).split('\n')[0]}`);
          }
          continue;
        }
        ui.clearStatus();
        if (res.status === 'unchecked') continue;
        await writeStatus(r.persona.statusFile, { status: res.status, by: 'auth-status', ...(res.at ? { at: res.at } : {}), detail: res.detail });
        Object.assign(r.state, { status: res.status, checked_at: new Date().toISOString(), by: 'auth-status', detail: res.detail });
        delete r.state.run;
        delete r.state.at;
        if (res.at) r.state.at = res.at;
      }
    } finally {
      stop.dispose();
      ui.clearStatus();
    }
    if (stop.interrupted) return EXIT.interrupted;
  }
  const bad = rows.filter((r) => r.state.status !== 'valid' && r.state.status !== 'unchecked').length;
  if (opts.json) {
    ui.result(JSON.stringify({ personas: rows.map((r) => r.state) }, null, 2));
    return opts.check && bad ? EXIT.failure : EXIT.ok;
  }
  if (rows.length === 0) {
    ui.line(`no personas${opts.project !== undefined ? ` in ${opts.project}` : ' in this workspace'}: name the accounts a project films in auth.personas of its project.yaml (README: "Signing in: personas and sessions")`);
    return EXIT.ok;
  }
  printStates(
    ui,
    rows.map((r) => ({ ...r.state, recheck: r.persona.check ? `${studioCommand(global)} auth status --project ${r.project.slug} --check` : undefined })),
  );
  return opts.check && bad ? EXIT.failure : EXIT.ok;
}

function printStates(ui: Ui, states: Array<PersonaState & { recheck?: string }>): void {
  const c = ui.c;
  const width = Math.max(...states.map((s) => s.persona.length));
  const now = Date.now();
  let group = '';
  for (const s of states) {
    const g = `${s.project} · env ${s.env}`;
    if (g !== group) {
      ui.result(c.bold(g));
      group = g;
    }
    const word = { valid: c.green, expired: c.yellow, never: c.yellow, error: c.red, unchecked: c.dim }[s.status](s.status.padEnd(9));
    const checked = checkedText(s, now);
    const what =
      s.status === 'never'
        ? s.fix
          ? 'its auth.storage_state file does not exist'
          : 'never signed in'
        : s.status === 'unchecked'
          ? `${s.session === 'profile' ? 'profile' : 'snapshot'} saved, never checked`
          : [checked, s.status !== 'valid' ? s.detail : undefined].filter(Boolean).join(': ');
    const busy = s.in_use ? c.yellow(` · in use by a browser${s.in_use.pid ? ` (pid ${s.in_use.pid})` : ''}`) : '';
    ui.result(`  ${s.persona.padEnd(width)}  ${word} ${what}${busy}`);
    // never: sign in once; expired, or an error of a check: sign in again; saved but not checked (or `--check` could
    // not check it now: no time of a check): check it.
    const signIn = (how: string) => (s.command ? `sign in ${how}: ${s.command}` : s.fix);
    const next =
      s.status === 'never'
        ? signIn('once')
        : s.status === 'expired' || (s.status === 'error' && s.checked_at)
          ? signIn('again')
          : s.status !== 'valid' && s.recheck
            ? `check it now: ${s.recheck}`
            : undefined;
    // A profile a browser holds: `studio login` and the check refuse it — that browser is closed first.
    if (next) ui.result(`${' '.repeat(width + 4)}${c.dim(`→ ${s.in_use ? `close that browser${s.in_use.pid ? ` (pid ${s.in_use.pid})` : ''} first, then ${next}` : next}`)}`);
  }
}
