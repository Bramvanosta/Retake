/**
 * `auth_login` jobs (L3.1, R-AUTH-09): `retake login` submitted by a client outside the CLI (the MCP server) and run by
 * the jobs worker with the same engine code (login.ts). `headed` opens a visible browser window on the machine the
 * worker runs on, for a HUMAN to sign in and close — the job waits for that window; `auto` plays the persona's
 * `login:` steps of project.yaml, headless. No input carries a credential, and no result carries a session's path,
 * cookies or a secret: the session goes to the worker's ~/.retake, as with `retake login`.
 *
 * L4.4: a headed window run by the worker closes after AUTH_HEADED_MAX_ENV minutes (default 30) — the single worker is
 * held while it is open, and a click in the Studio opens it — and `cancelSignIn` stops one (an `auth_login` job only).
 */
import { readdir } from 'node:fs/promises';
import { JOB_INPUT_VERSION, SLUG_RE, resolveEnvironment } from '@retake/core';
import type { AuthLoginJobInput } from '@retake/core';
import { EngineError, toEngineError } from '../errors.js';
import type { InterruptPort } from '../interrupts.js';
import type { JobQueueView } from './job-queue.js';
import { LoginOptionError, loginTarget, signInPersona } from '../login.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug } from '../refs.js';
import { checkEnvName } from './hooks-job.js';
import type { SubmitContext } from './run-job.js';
import type { AuthLoginJobResult, JobEventBody, JobRecord } from './types.js';
import type { OpenedWorkspace } from '../workspace.js';
import type { EnginePorts } from '../ports.js';

/** The environment variable that changes how long a headed sign-in window of a job may stay open (minutes). */
export const AUTH_HEADED_MAX_ENV = 'RETAKE_SIGNIN_MAX_MIN';
/** How long a headed sign-in window of a job stays open by default (ms): 30 min. */
export const AUTH_HEADED_MAX_MS = 30 * 60_000;

/** The longest headed sign-in of a job (ms): RETAKE_SIGNIN_MAX_MIN (minutes, more than 0 to 1440), else 30 min. */
export function headedSignInMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AUTH_HEADED_MAX_ENV];
  if (raw === undefined || raw.trim() === '') return AUTH_HEADED_MAX_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) throw new EngineError('invalid', `${AUTH_HEADED_MAX_ENV} must be a number of minutes from more than 0 to 1440, got "${raw}"`);
  return Math.round(n * 60_000);
}

/** An interrupt port whose scopes also end after `ms` (`onLimit` says so first). */
export function withTimeLimit(port: InterruptPort, ms: number, onLimit: () => void): InterruptPort {
  return {
    open: async (opts) => {
      const inner = await port.open(opts);
      const limit = new AbortController();
      const timer = setTimeout(() => {
        onLimit();
        limit.abort(new Error('time limit'));
      }, ms);
      const signal = AbortSignal.any([inner.signal, limit.signal]);
      return {
        signal,
        get interrupted() {
          return signal.aborted;
        },
        dispose: () => {
          clearTimeout(timer);
          inner.dispose();
        },
      };
    },
  };
}

/**
 * What a stopped sign-in left (review A L5): its session file and status are never written — but a profile persona that
 * already had a browser profile signs in ON it, so what the window changed there (cookies, storage) stays; a first
 * sign-in removes its new profile, and a `storage_state` persona's window ran on a throwaway profile.
 */
export function signInStoppedText(r: { timed_out?: boolean; profile_kept?: boolean }): string {
  return `${r.timed_out ? 'the window stayed open longer than its time limit and was closed' : 'the window was closed'}${stoppedLeft(r.profile_kept === true)}`;
}

const stoppedLeft = (profileKept: boolean) =>
  profileKept
    ? "; the saved session and its status were not updated, but what the window changed stays in the persona's browser profile (the next run starts from it)"
    : ', nothing was saved';

/** Stop a sign-in (its window closes; signInStoppedText says what stays): an `auth_login` job only — never a run or any other job. */
export async function cancelSignIn(queue: JobQueueView, jobId: string, by: string): Promise<JobRecord> {
  const rec = await queue.get(jobId);
  if (!rec) throw new EngineError('not_found', `job ${jobId} not found (job_list names the jobs)`);
  if (rec.kind !== 'auth_login') throw new EngineError('refused', `job ${jobId} is not a sign-in (it is a ${rec.kind} job): only a sign-in is stopped here`);
  return queue.cancel(jobId, by);
}

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

/** The `retake login` command a human runs for the same sign-in. */
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

/** What the job runs with; its ports (`clock`, `stores`) are its composition root's, handed on by the job runner. */
export interface AuthLoginJobContext extends EnginePorts {
  ws: OpenedWorkspace;
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
  // A profile persona that already has a browser profile signs in on it: a stop leaves what the window changed there.
  const dir = target.persona.session === 'profile' ? target.persona.profileDir : undefined;
  const profileKept = dir !== undefined && (await readdir(dir).then((l) => l.length > 0, () => false));
  // A headed window holds the single worker while it is open: it closes at its time limit.
  let timedOut = false;
  let maxMs = AUTH_HEADED_MAX_MS;
  if (input.mode === 'headed') {
    try {
      maxMs = headedSignInMaxMs();
    } catch (e) {
      ctx.event({ type: 'log', level: 'warn', message: `${(e as Error).message}: the default (30 min) applies` });
    }
  }
  const interrupts = input.mode === 'headed' ? withTimeLimit(ctx.interrupts, maxMs, () => (timedOut = true)) : ctx.interrupts;
  const outcome = await signInPersona(project, env, target.persona, { mode: input.mode, policy: ctx.ws.policy }, {
    interrupts,
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
            : `${target.persona.name}: a browser window is open on this machine — the user signs in, then closes the window (it closes by itself after ${formatLimit(maxMs)})`,
      }),
  });
  if (outcome.interrupted) {
    if (timedOut) ctx.event({ type: 'log', level: 'warn', message: `${target.persona.name}: the sign-in window stayed open longer than ${formatLimit(maxMs)}: it was closed${stoppedLeft(profileKept)}` });
    return { ...base, status: 'never', signed_in: false, cookies: 0, interrupted: true, ...(timedOut ? { timed_out: true as const } : {}), ...(profileKept ? { profile_kept: true as const } : {}) };
  }
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

function formatLimit(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}
