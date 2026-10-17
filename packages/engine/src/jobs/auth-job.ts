/**
 * `auth_login` jobs (L3.1, R-AUTH-09): `studio login` submitted by a client outside the CLI (the MCP server) and run by
 * the jobs worker with the same engine code (login.ts). `headed` opens a visible browser window on the machine the
 * worker runs on, for a HUMAN to sign in and close — the job waits for that window; `auto` plays the persona's
 * `login:` steps of project.yaml, headless. No input carries a credential, and no result carries a session's path,
 * cookies or a secret: the session goes to the worker's ~/.demo-studio, as with `studio login`.
 */
import { JOB_INPUT_VERSION, SLUG_RE, resolveEnvironment } from '@demo-studio/core';
import type { AuthLoginJobInput, WorkspaceConfig } from '@demo-studio/core';
import { EngineError, toEngineError } from '../errors.js';
import type { InterruptPort } from '../interrupts.js';
import { LoginOptionError, loginTarget, signInPersona } from '../login.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug } from '../refs.js';
import { checkEnvName } from './hooks-job.js';
import type { SubmitContext } from './run-job.js';
import type { AuthLoginJobResult, JobEventBody, JobRecord } from './types.js';

export interface AuthLoginSubmitRequest {
  project: string;
  env?: string;
  /** Default: the environment's only persona. */
  persona?: string;
  /** Default headed: a window for the human. */
  mode?: 'headed' | 'auto';
}

function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `studio login` command a human runs for the same sign-in. */
export function loginCommandLine(cli: string, r: AuthLoginSubmitRequest): string {
  return [cli, 'login', r.project, ...(r.env !== undefined ? ['--env', q(r.env)] : []), ...(r.persona !== undefined ? ['--persona', q(r.persona)] : []), ...(r.mode === 'auto' ? ['--auto'] : [])].join(' ');
}

function loginError(e: unknown): EngineError {
  if (e instanceof LoginOptionError) return new EngineError('invalid', e.message.replace(/--persona /g, 'persona ').replace(/--env /g, 'env ').replace(/--auto/g, 'mode "auto"'));
  return toEngineError(e);
}

/** Check that the persona can be signed in as asked (the CLI's flags named as the tool's arguments), and queue an `auth_login` job. */
export async function submitAuthLoginJob(ctx: SubmitContext, req: AuthLoginSubmitRequest): Promise<{ job: JobRecord; persona: string; env: string }> {
  checkProjectSlug(req.project);
  checkEnvName(req.env);
  if (req.persona !== undefined && (!SLUG_RE.test(req.persona) || req.persona.length > 100)) {
    throw new EngineError('invalid', `invalid persona "${req.persona}": a persona name of project.yaml`);
  }
  const mode = req.mode ?? 'headed';
  const project = await openProjectBySlug(ctx.ws, req.project);
  let target: ReturnType<typeof loginTarget>;
  try {
    target = loginTarget(project, { env: req.env, persona: req.persona, auto: mode === 'auto' });
  } catch (e) {
    throw loginError(e);
  }
  if (mode === 'headed' && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new EngineError('unavailable', 'a headed sign-in opens a browser window and this machine has no display (DISPLAY / WAYLAND_DISPLAY are not set)', {
      fix: loginCommandLine(ctx.cli, { ...req, mode: 'auto' }),
    });
  }
  const input: AuthLoginJobInput = {
    version: JOB_INPUT_VERSION,
    kind: 'auth_login',
    project: project.slug,
    ...(req.env !== undefined ? { env: req.env } : {}),
    ...(target.persona.legacy ? {} : { persona: target.persona.name }),
    mode,
    submitted_by: ctx.client,
  };
  return { job: await ctx.queue.enqueue(input), persona: target.persona.name, env: target.env.name };
}

export interface AuthLoginJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: AuthLoginJobInput;
  signal: AbortSignal;
  interrupts: InterruptPort;
  event(e: JobEventBody): void;
}

/** Execute an `auth_login` job: the window (or the login steps), then the check of the saved session. */
export async function executeAuthLoginJob(ctx: AuthLoginJobContext): Promise<AuthLoginJobResult> {
  const { input } = ctx;
  const project = await openProjectBySlug(ctx.ws, input.project);
  let target: ReturnType<typeof loginTarget>;
  try {
    target = loginTarget(project, { env: input.env, persona: input.persona, auto: input.mode === 'auto' });
  } catch (e) {
    throw loginError(e);
  }
  const env = resolveEnvironment(project, target.env.name);
  const command = loginCommandLine(ctx.cli, { project: project.slug, env: env.name, ...(target.persona.legacy ? {} : { persona: target.persona.name }), mode: input.mode });
  const base = { kind: 'auth_login' as const, env: env.name, persona: target.persona.name, mode: input.mode, command };
  const outcome = await signInPersona(project, env, target.persona, { mode: input.mode }, {
    interrupts: ctx.interrupts,
    log: (level, message) => {
      if (level !== 'debug') ctx.event({ type: 'log', level, message });
    },
    onOpen: (url) =>
      ctx.event({
        type: 'log',
        level: 'info',
        message:
          input.mode === 'auto'
            ? `${target.persona.name}: checking its saved session, else signing in with its login steps, headless`
            : `${target.persona.name}: a browser window is open on this machine — the user signs in, then closes the window`,
      }),
  });
  if (outcome.interrupted) return { ...base, status: 'never', signed_in: false, cookies: 0, interrupted: true };
  const res = outcome.result;
  const status = res.check.status;
  return {
    ...base,
    status,
    signed_in: status === 'valid' || status === 'unchecked' || target.persona.legacy,
    ...(res.alreadySignedIn ? { already_signed_in: true as const } : {}),
    ...(res.kept ? { kept: true as const } : {}),
    cookies: res.cookies,
    untrusted: { ...(res.check.detail ? { detail: res.check.detail } : {}), url: res.url.split(/[?#]/)[0] },
  };
}
