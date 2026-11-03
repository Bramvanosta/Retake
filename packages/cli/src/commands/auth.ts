import { resolve } from 'node:path';
import { listProjects, loginCommand as coreLoginCommand, resolveEnvironment } from '@retake/core';
import { LoginOptionError, loginTarget, projectPersonaStates, signInPersona as signInCore, tildePath } from '@retake/engine';
import type { LoginCommandOf, PersonaState } from '@retake/engine';
import type { LoadedProject, ResolvedPersona } from '@retake/core';
import type { PersonaCheckResult } from '@retake/runner-web';
import { CliError, EXIT, UsageError, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { onInterrupt } from '../interrupt.js';
import type { Ui } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

// Moved into @retake/engine (L3.1); re-exported for the commands that import them from here.
export { personaState, projectPersonaStates, tildePath } from '@retake/engine';
export type { PersonaState } from '@retake/engine';

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `retake`, with `-C <root>` when the command line named the workspace root: the start of the commands messages print. */
export function retakeCommand(global: GlobalOptions): string {
  return global.root ? `retake -C ${shellQuote(resolve(global.root))}` : 'retake';
}

/** The `retake login` command messages print; with `-C <root>` when the command line named the workspace root. */
export function loginCommandFor(global: GlobalOptions): LoginCommandOf {
  return (p) => coreLoginCommand(p).replace(/^retake /, `${retakeCommand(global)} `);
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

// ── retake login ─────────────────────────────────────────────────────────────

export interface LoginOptions {
  env?: string;
  persona?: string;
  page?: string;
  url?: string;
  /** The persona's login steps, headless (no window). */
  auto?: boolean;
}

/** A LoginOptionError of the engine as the CLI reports it: a usage error (exit 2) or an error (exit 1), same message. */
function cliLoginError(e: unknown): unknown {
  if (e instanceof LoginOptionError) return e.usage ? new UsageError(e.message) : new CliError(e.message);
  return e;
}

/**
 * Sign one persona in and report it (shared by `retake login` and `retake new`): a headed window, or `auto` (its login
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
  const who = `${c.bold(persona.name)} ${c.dim(`(env ${env.name})`)}`;
  let outcome: Awaited<ReturnType<typeof signInCore>>;
  try {
    outcome = await signInCore(
      project,
      env,
      persona,
      { mode, ...(opts.page !== undefined ? { page: opts.page } : {}), ...(opts.url !== undefined ? { url: opts.url } : {}) },
      {
        interrupts: { open: (o) => onInterrupt(ui, o) },
        log: (level, msg) => (level === 'warn' || level === 'error' ? ui.warn(msg) : ui.debug(msg)),
        onOpen: (url) =>
          ui.line(
            mode === 'auto'
              ? `${who}: checking its saved session, else signing in with its login steps, headless ${c.dim(`(${url.split(/[?#]/)[0]})`)}`
              : `${who}: a browser window is open on ${url.split(/[?#]/)[0]} — sign in, then close the window`,
          ),
      },
    );
  } catch (e) {
    throw cliLoginError(e);
  }
  if (outcome.interrupted) return EXIT.interrupted;
  const res = outcome.result;
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

/** `retake login <project> [--env] [--persona] [--page] [--url] [--auto]`: sign one persona in and save its session. */
export async function loginCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: LoginOptions): Promise<ExitCode> {
  const project = await openProject(await openWorkspace(global), projectArg);
  let target: ReturnType<typeof loginTarget>;
  try {
    target = loginTarget(project, opts);
  } catch (e) {
    throw cliLoginError(e);
  }
  return signInPersona(ui, global, project, target.env, target.persona, opts);
}

// ── retake auth status ───────────────────────────────────────────────────────

/** "checked 2 min ago (preflight of run …)". */
export function checkedText(s: Pick<PersonaState, 'checked_at' | 'by' | 'run'>, now = Date.now()): string {
  if (!s.checked_at) return '';
  const by =
    s.by === 'preflight'
      ? `preflight of run ${s.run ?? '?'}`
      : s.by === 'run'
        ? `expired during run ${s.run ?? '?'}`
        : s.by === 'login'
          ? 'retake login'
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
 * `retake auth status [--project] [--env] [--check] [--json]`: every persona of every project (or one) — valid,
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
    const { checkSavedSession, profileLock, writeStatus, PreflightError } = await import('@retake/runner-web');
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
            // Opened meanwhile (a retake login window?).
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
  // A sandbox account signs in automatically at every take: never a reason to fail.
  const bad = rows.filter((r) => !r.state.sandbox && r.state.status !== 'valid' && r.state.status !== 'unchecked').length;
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
    rows.map((r) => ({ ...r.state, recheck: r.persona.check ? `${retakeCommand(global)} auth status --project ${r.project.slug} --check` : undefined })),
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
    const auto = s.sandbox && s.status === 'never';
    const word = auto ? c.dim('auto'.padEnd(9)) : { valid: c.green, expired: c.yellow, never: c.yellow, error: c.red, unchecked: c.dim }[s.status](s.status.padEnd(9));
    const checked = checkedText(s, now);
    const what =
      s.status === 'never'
        ? s.fix
          ? 'its auth.storage_state file does not exist'
          : auto
            ? 'sandbox account: a take signs it in automatically whenever its session is missing (its login steps, off camera)'
            : 'never signed in'
        : s.status === 'unchecked'
          ? `${s.session === 'profile' ? 'profile' : 'snapshot'} saved, never checked`
          : [checked, s.status !== 'valid' ? s.detail : undefined].filter(Boolean).join(': ');
    const busy = s.in_use ? c.yellow(` · in use by a browser${s.in_use.pid ? ` (pid ${s.in_use.pid})` : ''}`) : '';
    ui.result(`  ${s.persona.padEnd(width)}  ${word} ${what}${busy}`);
    // never: sign in once; expired, or an error of a check: sign in again; saved but not checked (or `--check` could
    // not check it now: no time of a check): check it.
    const signIn = (how: string) => (s.command ? `sign in ${how}: ${s.command}` : s.fix);
    const next = s.sandbox
      ? s.status === 'expired' || s.status === 'error'
        ? 'the next take signs it in again automatically (a sandbox reset drops the sessions the app stored)'
        : undefined
      : s.status === 'never'
        ? signIn('once')
        : s.status === 'expired' || (s.status === 'error' && s.checked_at)
          ? signIn('again')
          : s.status !== 'valid' && s.recheck
            ? `check it now: ${s.recheck}`
            : undefined;
    // A profile a browser holds: `retake login` and the check refuse it — that browser is closed first.
    if (next) ui.result(`${' '.repeat(width + 4)}${c.dim(`→ ${s.in_use ? `close that browser${s.in_use.pid ? ` (pid ${s.in_use.pid})` : ''} first, then ${next}` : next}`)}`);
  }
}
