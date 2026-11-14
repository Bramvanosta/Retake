/**
 * Sessions (L4.4, R-AUTH-10; L5.11a: on the kit — the Cast and Prepare's "Sessions this run signs in with"): the
 * personas' saved sign-ins, each with its stored state as a shape and a word (no browser is opened to read it), its last
 * check (the page's own text in a "From the page" box), what a run does with it (signs it in by itself, no check, a
 * sandbox account, in use) and "Sign in": a headed `auth_login` job, a browser window on this computer where the PERSON
 * signs in and then closes it. No field here ever takes a credential. The job is followed until it ends ("waiting for
 * the queue", "window open", the result), with Cancel (`sign_in_cancel`) and the window's time limit said.
 *
 * The capture's confirmation for personas whose session is invalid lives in the shell (StatusActions.tsx
 * `SessionsSheet`, the kit's sheet): one sheet for the status bar's Capture, ⇧⌘R and Prepare's Start capture.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { AuthStatusItem, EnvironmentView } from '@retake/engine';
import { errorText } from '../api.js';
import { authLogin, jobList, signInCancel } from '../data/shoot.js';
import type { JobLite } from '../data/ops.js';
import { Txt, When, plural, shown, visibleControls } from '../bits.js';
import { castState, envFlagWords } from '../words/board-words.js';
import { useEvents } from '../events.js';
import { reloadProject, useCast, useProjectView } from '../project-data.js';
import { STORED_WORDS } from '../words/shoot-words.js';
import { Button, Callout, StatusMark } from '../ui-kit/index.js';

export { STORED_WORDS };

const BY_WORDS: Record<string, string> = { preflight: 'a run’s preflight', login: 'a sign-in', 'auth-status': 'a status check', run: 'a run' };

/** A persona's stored state as a shape and a word (a sandbox account never signed in: ready, a take signs it in). */
export function StoredState({ p }: { p: Pick<AuthStatusItem, 'status' | 'sandbox'> & { auto?: boolean } }) {
  const c = castState(p);
  return <StatusMark state={c.state} word={c.word} />;
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
      jobList({ project: slug, limit: 50 }).then(
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
    authLogin({ project: slug, persona, env })
      .then(
        (j) => setJob(j),
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setSending(false));
  };
  const cancel = () => {
    if (!job) return;
    signInCancel({ job: job.id }).then(
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
  // The panel's job is the auth_login job it started: its result is a sign-in's.
  const signIn = job?.result?.kind === 'auth_login' ? job.result : undefined;
  return (
    <div className="sp-sign-in" data-testid="sign-in">
      {!open && (
        <Button size="sm" aria-label={visibleControls(`${label} (${env})`)} busy={sending} onClick={start} data-testid="sign-in-button">
          {sending ? 'Opening…' : job ? 'Sign in again' : 'Sign in…'}
        </Button>
      )}
      {job && (
        <div className="sp-sign-in-state" data-testid="sign-in-state" data-state={job.state}>
          {job.state === 'queued' && <p>Waiting for the queue: the window opens when the job ahead of it ends (a run — a paused one too — or another sign-in).</p>}
          {job.state === 'running' && (
            <p>
              {job.cancel_requested_at
                ? 'Stopping: the window closes; the saved session is not updated.'
                : 'A browser window is open on this computer: sign in there yourself, then close it. It may be behind this window. It closes by itself after its time limit (30 min unless RETAKE_SIGNIN_MAX_MIN says otherwise).'}
              {job.started_at && (
                <>
                  {' '}
                  <span className="sc-quiet">
                    Opened <When iso={job.started_at} />.
                  </span>
                </>
              )}
            </p>
          )}
          {job.state === 'succeeded' && (
            <p>{shown(signIn?.signed_in ? 'Signed in: the session works now.' : `Not signed in: the session is ${STORED_WORDS[signIn?.status ?? '']?.[0] ?? 'not valid'}.`)}</p>
          )}
          {job.state === 'cancelled' && (
            <p>
              {signIn?.profile_kept
                ? 'Stopped: the saved session was not updated, but what the window changed stays in this persona’s browser profile (the next run starts from it).'
                : signIn?.interrupted
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
            <Button size="sm" variant="ghost" onClick={cancel} data-testid="sign-in-cancel" aria-label={visibleControls(`Cancel the sign-in of ${persona}`)}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="sp-error" role="alert">
          <Txt text={error} />
        </p>
      )}
    </div>
  );
}

/** A persona's row: what auth_status says, and for a scenario's run (scenario_sessions) what that run does with it. */
export type SessionRowData = AuthStatusItem & { auto?: boolean; has_check?: boolean; login_env_missing?: string[]; login_keychain?: number };

/**
 * What a run does with a persona's session, in words (empty: nothing to say). `issues`: the callouts shown beside the
 * table (Prepare) — a note one of them already says is left out (review B-H1 of L5.11a).
 */
function runNotes(p: SessionRowData, issues: readonly string[]): string[] {
  const out: string[] = [];
  if (p.auto && p.login_keychain) out.push('its keychain items are not looked up here: they must exist on this computer');
  if (p.login_env_missing && p.login_env_missing.length > 0 && !issues.some((i) => i.startsWith(`persona ${p.persona}:`)))
    out.push(`its login steps need ${p.login_env_missing.join(', ')}, not set for the worker: no run signs it in by itself`);
  if (p.has_check === false) out.push('no check: a run uses its saved session as it is, unverified');
  if (p.in_use) out.push('in use by a browser window');
  return out;
}

/** Who signs a persona in when nobody does it by hand: a sandbox account (each take) or login steps (each run). */
function signedInBy(p: SessionRowData): string | null {
  if (p.sandbox) return 'A take signs it in';
  if (p.auto) return 'Each run signs it in, off camera';
  return null;
}

/**
 * One table of personas (a `<table>` of kit cells): name (and location), stored state, last check, Sign in — what a run
 * does with it on its own full-width line under the row (review B-H1 of L5.11a: the Session column takes the free width,
 * no cell squeezed to a letter; below 520 px of pane the rows stack). A sandbox account or a persona its login steps sign
 * in offers no "Sign in…": the run does it (review B-L1). Test ids kept from L4.4: sessions-table, session-row
 * (data-persona, data-status).
 */
export function SessionRows({
  slug,
  rows,
  onChanged,
  caption,
  showEnv = true,
  issues = [],
}: {
  slug: string;
  rows: SessionRowData[];
  onChanged: () => void;
  caption: string;
  showEnv?: boolean;
  issues?: readonly string[];
}) {
  const cols = showEnv ? 5 : 4;
  return (
    <div className="sp-sessions-box">
      <table className="sp-sessions" data-testid="sessions-table">
        <caption className="k-sr">{shown(caption)}</caption>
        <thead>
          <tr>
            <th scope="col" className="sp-col-persona">
              Persona
            </th>
            {showEnv && <th scope="col">Location</th>}
            <th scope="col" className="sp-col-session">
              Session
            </th>
            <th scope="col" className="sp-col-check">
              Last check
            </th>
            <th scope="col" className="sp-col-act">
              <span className="k-sr">Sign in</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const notes = runNotes(p, issues);
            const by = signedInBy(p);
            return (
              <Fragment key={`${p.env}/${p.persona}`}>
                <tr className={notes.length > 0 ? 'has-notes' : undefined} data-testid="session-row" data-persona={p.persona} data-status={p.status}>
                  <th scope="row">
                    <Txt text={p.persona} />
                  </th>
                  {showEnv && (
                    <td data-label="Location">
                      <Txt text={p.env} />
                    </td>
                  )}
                  <td data-label="Session">
                    <StoredState p={p} />
                  </td>
                  <td data-label="Last check">
                    {p.checked_at ? (
                      <span className="sc-quiet">
                        <When iso={p.checked_at} />
                        {p.by && <Txt text={` by ${BY_WORDS[p.by] ?? p.by}`} />}
                      </span>
                    ) : (
                      <span className="sc-quiet">never</span>
                    )}
                    {p.untrusted?.detail && (
                      <div className="sb-from-page">
                        <p className="sb-from-page-title">From the page</p>
                        <p className="sb-pre">
                          <Txt text={p.untrusted.detail} />
                        </p>
                      </div>
                    )}
                  </td>
                  <td className="sp-col-act">
                    {p.legacy ? (
                      <span className="sc-quiet">{p.fix ? <Txt text={p.fix} /> : 'a single-account file: export it again'}</span>
                    ) : by ? (
                      <span className="sc-quiet" data-testid="signed-in-by">
                        {shown(by)}
                      </span>
                    ) : (
                      <SignIn slug={slug} persona={p.persona} env={p.env} onDone={onChanged} />
                    )}
                  </td>
                </tr>
                {notes.length > 0 && (
                  <tr className="sp-notes-row" data-testid="session-notes" data-persona={p.persona}>
                    <td colSpan={cols}>
                      <Txt className="sp-note" text={notes.map((n) => n.charAt(0).toUpperCase() + n.slice(1)).join('. ') + '.'} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The Cast's Sessions: every persona of the project, one section per location (its name and flags in words). It reads
 * the open project's shared `auth_status` entry (project-data.ts: re-read on the events that concern it).
 */
export function SessionsPanel({ slug }: { slug: string }) {
  const s = useCast(slug);
  const project = useProjectView(slug);
  const reload = () => reloadProject('auth_status', slug);
  const envs: EnvironmentView[] = project.state === 'ready' ? project.data.environments : [];
  const defaultEnv = project.state === 'ready' ? project.data.default_env : undefined;
  const personas = s.state === 'ready' ? s.data.personas : [];
  const byEnv = new Map<string, SessionRowData[]>();
  for (const p of personas) byEnv.set(p.env, [...(byEnv.get(p.env) ?? []), p]);
  return (
    <section className="sp-cast" aria-label="Sessions" data-testid="sessions-panel">
      {s.state === 'loading' && (
        <p className="sc-quiet" role="status">
          Loading the sessions…
        </p>
      )}
      {s.state === 'error' && (
        <Callout state="fail" role="alert" title="The sessions cannot be read">
          <Txt text={s.error} />
        </Callout>
      )}
      {s.state === 'ready' && personas.length === 0 && <p className="sc-quiet">No persona: this project signs in nowhere.</p>}
      {s.state === 'ready' &&
        [...byEnv].map(([env, rows], i) => {
          const e = envs.find((x) => x.name === env);
          const flags = e ? envFlagWords(e, env === defaultEnv, env) : '';
          const id = `cast-env-${i}`;
          return (
            <section key={env} className="sp-cast-env" aria-labelledby={id}>
              <div className="sp-cast-head">
                <h2 id={id} className="sc-h2">
                  <Txt text={env} />
                </h2>
                <span className="sc-quiet">
                  <Txt text={`${plural(rows.length, 'persona')}${flags ? ` · ${flags}` : ''}`} />
                </span>
              </div>
              <SessionRows slug={slug} rows={rows} onChanged={reload} caption={`Sessions on ${env}`} showEnv={false} />
            </section>
          );
        })}
      {s.state === 'ready' && personas.length > 0 && <p className="sc-quiet">The last known state of each saved sign-in (no browser is opened to read it). A run checks again before it films.</p>}
    </section>
  );
}
