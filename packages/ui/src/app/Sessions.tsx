/**
 * Sessions (L4.4, R-AUTH-10): the personas' saved sign-ins — on the project page (every persona of every environment,
 * `auth_status`) and on the Run screen (the personas the scenario's run signs in, `scenario_sessions`) — each with its
 * stored state in words (no browser is opened to read it) and "Sign in": a headed `auth_login` job, a browser window on
 * this computer where the PERSON signs in and then closes it. No field here ever takes a credential. The job is
 * followed until it ends ("waiting for the queue", "window open", the result), with Cancel (`sign_in_cancel`) and the
 * window's time limit said.
 *
 * `ConfirmSessions` is the capture's confirmation for a persona whose stored session is invalid and that no run signs
 * in by itself (critique B10): it says what really happens — a persona with a `check` (or never signed in) is checked
 * first and the run stops before filming if it is still invalid; one without a `check` cannot be (review A M2): its
 * saved session is used as it is and the run fails only when a page lands on the sign-in page, after its setup hooks —
 * with "Sign in first" as the first, focused button. It guards against a wasted take, not for a person's presence: the
 * server takes the persona names (`sessions_ack`). It closes before it unmounts (review B L4): focus goes back to the
 * button that opened it, or to that persona's Sign in button ("Sign in first").
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthStatusItem } from '@demo-studio/engine';
import { call, errorText, useCall } from './api.js';
import { Badge, Loading, Notice, Txt, When } from './bits.js';
import type { BadgeTone } from './bits.js';
import { useEvents, useProjectEvents } from './events.js';

/** A persona's stored state, in words. */
export const STORED_WORDS: Record<string, [string, BadgeTone]> = {
  valid: ['valid', 'success'],
  expired: ['expired', 'danger'],
  error: ['last check failed', 'danger'],
  never: ['never signed in', 'warning'],
  unchecked: ['saved, never checked', 'neutral'],
};

const BY_WORDS: Record<string, string> = { preflight: 'a run’s preflight', login: 'a sign-in', 'auth-status': 'a status check', run: 'a run' };

export function StoredState({ p }: { p: Pick<AuthStatusItem, 'status' | 'sandbox'> & { auto?: boolean } }) {
  if (p.sandbox && p.status === 'never') return <Badge tone="info">sandbox account</Badge>;
  const [word, tone] = STORED_WORDS[p.status] ?? ['unknown', 'neutral'];
  return <Badge tone={tone}>{word}</Badge>;
}

/** A job of the queue, as job_list shows it (the fields the panel reads). */
interface JobLite {
  id: string;
  kind: string;
  state: string;
  started_at?: string;
  result?: { kind?: string; signed_in?: boolean; status?: string; interrupted?: boolean; profile_kept?: boolean };
  error?: { message?: string };
  untrusted?: { error?: string };
  cancel_requested_at?: string;
}

const UNFINISHED = new Set(['queued', 'running']);
/** How often a sign-in job is read while it waits or runs (ms) — on top of the `jobs` events. */
const JOB_POLL_MS = 3000;

/**
 * "Sign in" for one persona: a headed window for the person (`auth_login`, pinned headed and no wait by the server),
 * then the job's state until it ends; `onDone` when it did (the statuses are read again).
 */
export function SignIn({ slug, persona, env, onDone }: { slug: string; persona: string; env: string; onDone: () => void }) {
  const [job, setJobState] = useState<JobLite | null>(null);
  const jobRef = useRef<JobLite | null>(null);
  const setJob = (j: JobLite | null) => {
    jobRef.current = j;
    setJobState(j);
  };
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const refresh = useCallback(
    (id: string) => {
      call<{ jobs: JobLite[] }>('job_list', { project: slug, limit: 50 }).then(
        (d) => {
          const j = d.jobs.find((x) => x.id === id);
          const prev = jobRef.current;
          if (!j || prev?.id !== id) return;
          jobRef.current = j;
          setJob(j);
          if (UNFINISHED.has(prev.state) && !UNFINISHED.has(j.state)) doneRef.current();
        },
        () => undefined,
      );
    },
    [slug],
  );
  const open = job !== null && UNFINISHED.has(job.state);
  useEvents((e) => {
    if (job && open && ((e.type === 'jobs' && e.changed.includes(job.id)) || e.type === 'resync')) refresh(job.id);
  });
  useEffect(() => {
    if (!job || !open) return;
    const t = setInterval(() => refresh(job.id), JOB_POLL_MS);
    return () => clearInterval(t);
  }, [job?.id, open, refresh]);

  const start = () => {
    setSending(true);
    setError(null);
    call<JobLite>('auth_login', { project: slug, persona, env })
      .then(
        (j) => setJob(j),
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setSending(false));
  };
  const cancel = () => {
    if (!job) return;
    call<JobLite>('sign_in_cancel', { job: job.id }).then(
      (j) => {
        const prev = jobRef.current;
        if (prev?.id !== j.id) return;
        setJob({ ...prev, state: j.state, ...(j.cancel_requested_at ? { cancel_requested_at: j.cancel_requested_at } : {}) });
        if (!UNFINISHED.has(j.state)) doneRef.current();
      },
      (e: unknown) => setError(errorText(e)),
    );
  };
  const label = `Sign in ${persona}`;
  return (
    <div className="sign-in" data-testid="sign-in">
      {!open && (
        <button type="button" className="button small" aria-label={`${label} (${env})`} disabled={sending} onClick={start} data-testid="sign-in-button">
          {sending ? 'Opening…' : job ? 'Sign in again' : 'Sign in'}
        </button>
      )}
      {job && (
        <div className="sign-in-state small" data-testid="sign-in-state" data-state={job.state}>
          {job.state === 'queued' && <p>Waiting for the queue: the window opens when the job ahead of it ends (a run — a paused one too — or another sign-in).</p>}
          {job.state === 'running' && (
            <p>
              {job.cancel_requested_at
                ? 'Stopping: the window closes; the saved session is not updated.'
                : 'A browser window is open on this computer: sign in there yourself, then close it. It may be behind this window. It closes by itself after its time limit (30 min unless DEMO_STUDIO_SIGNIN_MAX_MIN says otherwise).'}
              {job.started_at && (
                <>
                  {' '}
                  <span className="muted">
                    Opened <When iso={job.started_at} />.
                  </span>
                </>
              )}
            </p>
          )}
          {job.state === 'succeeded' && <p>{job.result?.signed_in ? 'Signed in: the session works now.' : `Not signed in: the session is ${STORED_WORDS[job.result?.status ?? '']?.[0] ?? 'not valid'}.`}</p>}
          {job.state === 'cancelled' && (
            <p>
              {job.result?.profile_kept
                ? 'Stopped: the saved session was not updated, but what the window changed stays in this persona’s browser profile (the next run starts from it).'
                : job.result?.interrupted
                  ? 'Stopped: nothing was saved.'
                  : 'Stopped: the saved session was not updated.'}
            </p>
          )}
          {(job.state === 'failed' || job.state === 'interrupted') && (
            <p>
              The sign-in did not finish
              {(job.untrusted?.error ?? job.error?.message) && (
                <>
                  : <Txt text={job.untrusted?.error ?? job.error?.message ?? ''} />
                </>
              )}
            </p>
          )}
          {open && !job.cancel_requested_at && (
            <button type="button" className="button small" onClick={cancel} data-testid="sign-in-cancel" aria-label={`Cancel the sign-in of ${persona}`}>
              Cancel
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="small warn-text" role="alert">
          <Txt text={error} />
        </p>
      )}
    </div>
  );
}

/** A persona's row: what auth_status says, and for a scenario's run (scenario_sessions) what that run does with it. */
export type SessionRowData = AuthStatusItem & { auto?: boolean; has_check?: boolean; login_env_missing?: string[]; login_keychain?: number };

/** One table of personas: name, environment, stored state, last check, what a run does with it, Sign in. */
export function SessionsTable({ slug, rows, onChanged, caption }: { slug: string; rows: SessionRowData[]; onChanged: () => void; caption: string }) {
  return (
    <table className="sessions" data-testid="sessions-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Persona</th>
          <th scope="col">Environment</th>
          <th scope="col">Session</th>
          <th scope="col">Last check</th>
          <th scope="col">Sign in</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={`${p.env}/${p.persona}`} data-testid="session-row" data-persona={p.persona} data-status={p.status}>
            <th scope="row">
              <Txt text={p.persona} />
            </th>
            <td>
              <Txt text={p.env} />
            </td>
            <td>
              <StoredState p={p} />
              {p.auto && (
                <span className="muted small">
                  {' '}
                  · every run signs it in by itself, off camera{p.login_keychain ? ' (its keychain items are not looked up here: they must exist on this computer)' : ''}
                </span>
              )}
              {p.login_env_missing && p.login_env_missing.length > 0 && (
                <span className="warn-text small">
                  {' '}
                  · its login steps need <Txt className="mono" text={p.login_env_missing.join(', ')} />, not set for the worker: no run signs it in by itself
                </span>
              )}
              {p.has_check === false && <span className="muted small"> · no check: a run uses its saved session as it is, unverified</span>}
              {p.sandbox && <span className="muted small"> · a take signs it in automatically</span>}
              {p.in_use && <span className="muted small"> · in use by a browser window</span>}
            </td>
            <td className="small">
              {p.checked_at ? (
                <>
                  <When iso={p.checked_at} />
                  {p.by && <span className="muted"> by {BY_WORDS[p.by] ?? p.by}</span>}
                </>
              ) : (
                <span className="muted">—</span>
              )}
              {p.untrusted?.detail && (
                <p className="from-page small">
                  <span className="from-page-title">From the page: </span>
                  <Txt text={p.untrusted.detail} />
                </p>
              )}
            </td>
            <td>
              {p.legacy ? (
                <span className="muted small">{p.fix ? <Txt text={p.fix} /> : 'a single-account file: export it again'}</span>
              ) : (
                <SignIn slug={slug} persona={p.persona} env={p.env} onDone={onChanged} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The project page's Sessions panel: every persona × environment of the project. */
export function SessionsPanel({ slug }: { slug: string }) {
  const [s, reload] = useCall<{ personas: AuthStatusItem[] }>('auth_status', { project: slug }, slug);
  useProjectEvents(slug, reload);
  return (
    <section className="card" aria-labelledby="sessions-h" data-testid="sessions-panel">
      <h2 id="sessions-h" className="card-title">
        Sessions
      </h2>
      {s.state === 'loading' && <Loading what="the sessions" />}
      {s.state === 'error' && (
        <p className="muted">
          <Txt text={s.error} />
        </p>
      )}
      {s.state === 'ready' && s.data.personas.length === 0 && <p className="muted">No persona: this project signs in nowhere.</p>}
      {s.state === 'ready' && s.data.personas.length > 0 && (
        <>
          <p className="muted small">The last known state of each saved sign-in (no browser is opened to read it). A run checks again before it films.</p>
          <SessionsTable slug={slug} rows={s.data.personas} onChanged={reload} caption="Sessions of the project's personas" />
        </>
      )}
    </section>
  );
}

export interface SessionToConfirm {
  persona: string;
  status: string;
  /** The run checks it before filming (a `check`, or never signed in); false: it cannot (scenario_sessions `confirm`). */
  checked_first?: boolean;
}

/**
 * The capture's confirmation (B10): the personas named with their state, what the run will do, "Sign in first" first
 * (and focused), "Capture anyway" second. Escape or "Sign in first" closes it and sends nothing.
 */
export function ConfirmSessions({ sessions, onConfirm, onClose }: { sessions: SessionToConfirm[]; onConfirm: () => void; onClose: (why: 'sign-in' | 'escape') => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  // Closed first, then unmounted: the dialog gives focus back to the button that opened it (the caller may move it on).
  const close = (then: () => void) => {
    ref.current?.close();
    then();
  };
  const one = sessions.length === 1;
  const unchecked = sessions.filter((x) => x.checked_first === false).map((x) => x.persona);
  const checked = sessions.length - unchecked.length;
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-h"
      aria-describedby="confirm-what confirm-then"
      data-testid="confirm-sessions"
      onCancel={(e) => {
        e.preventDefault();
        close(() => onClose('escape'));
      }}
    >
      <h2 id="confirm-h" className="card-title">
        Capture with {one ? 'a session' : 'sessions'} that may not work?
      </h2>
      <div id="confirm-what">
        <p>{one ? 'This persona has' : 'These personas have'} no valid saved session, and no run signs {one ? 'it' : 'them'} in by itself:</p>
        <ul>
          {sessions.map((s) => (
            <li key={s.persona}>
              <Txt text={s.persona} /> — {STORED_WORDS[s.status]?.[0] ?? s.status}
              {s.checked_first === false ? ' (no check)' : ''}
            </li>
          ))}
        </ul>
      </div>
      <div id="confirm-then">
        {checked > 0 && (
          <p>
            The capture checks {unchecked.length ? (checked === 1 ? 'the other session' : 'the other sessions') : one ? 'the session' : 'each session'} first and stops before
            filming if it is still not valid: nothing is filmed then.
          </p>
        )}
        {unchecked.length > 0 && (
          <p data-testid="confirm-unchecked">
            <Txt text={unchecked.join(', ')} /> cannot be checked first ({unchecked.length === 1 ? 'it has' : 'they have'} no check): the capture uses{' '}
            {unchecked.length === 1 ? 'its saved session as it is' : 'their saved sessions as they are'} and fails only when a page lands on the sign-in page — after its
            setup hooks ran.
          </p>
        )}
        <p>Capture anyway only if you know the session works now (you signed in since its last check, for example).</p>
      </div>
      <div className="actions">
        <button type="button" className="button primary" onClick={() => close(() => onClose('sign-in'))} data-testid="confirm-sign-in-first">
          Sign in first
        </button>
        <button type="button" className="button" onClick={() => close(onConfirm)} data-testid="confirm-capture-anyway">
          Capture anyway
        </button>
      </div>
    </dialog>
  );
}
