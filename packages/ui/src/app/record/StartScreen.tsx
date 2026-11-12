/** The Record screen's start route (`#/p/<slug>/record`): the start form. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { RecordEnvironmentOption, RecordOptionsAnswer, RecordStartAnswer } from '../../server/record-ops.js';
import { CallError, errorText } from '../api.js';
import { recordStart, useRecordOptions } from '../data/record.js';
import { Txt, shown } from '../bits.js';
import { recordEventAction, useEvents } from '../events.js';
import { hrefTo } from '../route.js';
import { SignIn, StoredState } from '../Sessions.js';
import { say } from '../shell/say.js';
import { Button, Callout, Select, TerminalCommands, TextField } from '../ui-kit/index.js';
import { NAME_MAX, WINDOW_NOTE, nameProblem, personaProblem } from '../record-words.js';
import { RecordBrowser } from './RecordBrowser.js';
import { startedJobs, focusOnArrival } from './started.js';

/** What record_start refused, in words: the open recording (409), a command to type (403 with a fix), or the message. */
type StartRefusal = { kind: 'open'; project: string; rec_id: string } | { kind: 'error'; message: string; fix?: string };

/** The start form for one set of options (the screen reads them; a test renders it with any). */
export function StartForm({ slug, o, onStarted, onChanged }: { slug: string; o: RecordOptionsAnswer; onStarted: (s: RecordStartAnswer) => void; onChanged: () => void }) {
  const [envName, setEnvName] = useState(() => o.default_env ?? o.environments[0]?.name ?? '');
  const env: RecordEnvironmentOption | undefined = o.environments.find((e) => e.name === envName) ?? o.environments[0];
  const [page, setPage] = useState(env?.default?.page ?? env?.pages[0] ?? '');
  const [path, setPath] = useState(env?.default?.path ?? '/');
  const [persona, setPersona] = useState(env?.default?.persona ?? 'none');
  const [name, setName] = useState(o.default_name);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
  const refusedBox = useRef<HTMLDivElement>(null);
  const pickEnv = (n: string) => {
    setEnvName(n);
    const e = o.environments.find((x) => x.name === n);
    setPage(e?.default?.page ?? e?.pages[0] ?? '');
    setPath(e?.default?.path ?? '/');
    setPersona(e?.default?.persona ?? 'none');
  };
  const p = env?.personas.find((x) => x.name === persona);
  const signInFirst = personaProblem(p);
  const pathProblem = !path.startsWith('/') ? 'A path under the page, starting with "/".' : /\s/.test(path) || path.includes('{{') ? 'No space and no "{{" in a path.' : null;
  const problem = nameProblem(name);
  const blocked = !env || !env.default || !o.display || o.open !== null || signInFirst !== null;
  // A refusal takes the focus (the Start button stays where it was: a disabled one would drop the focus while sending) —
  // said once, by the focus: its callout is a note, not an alert as well (L5.11b fixes, review A-L5).
  useEffect(() => {
    if (refusal?.kind === 'error') refusedBox.current?.focus();
  }, [refusal]);
  const start = (ev: FormEvent) => {
    ev.preventDefault();
    if (!env || pathProblem || problem || blocked) return;
    if (sendingRef.current) return say('The recording is being started');
    sendingRef.current = true;
    setSending(true);
    setRefusal(null);
    recordStart({ project: slug, env: env.name, page, path, persona, name })
      .then(onStarted, (e: unknown) => {
        if (e instanceof CallError && e.status === 409 && typeof e.error.details?.rec_id === 'string') {
          setRefusal({ kind: 'open', project: String(e.error.details.project ?? slug), rec_id: e.error.details.rec_id });
          onChanged();
        } else setRefusal({ kind: 'error', message: errorText(e), ...(e instanceof CallError && e.error.fix ? { fix: e.error.fix } : {}) });
      })
      .finally(() => {
        sendingRef.current = false;
        setSending(false);
      });
  };
  const open = refusal?.kind === 'open' ? refusal : o.open ? { project: o.open.project, rec_id: o.open.rec_id } : null;
  const startWhy = blocked ? (signInFirst ?? (open ? 'One window at a time: a recording is already open.' : !o.display ? 'No window can open on this machine.' : 'This location cannot be recorded.')) : (pathProblem ?? problem);
  return (
    <form className="rc-start" onSubmit={start} aria-labelledby="rec-start-h" data-testid="record-start-form">
      <h2 id="rec-start-h" className="sc-h2">
        Record a new scenario
      </h2>
      <Callout state="idle" role="note" title="Note: a real browser window">
        <p data-testid="record-window-note">{shown(WINDOW_NOTE)}</p>
        {o.notes.length > 0 && (
          <ul className="rc-list">
            {o.notes.map((n, i) => (
              <li key={i}>
                <Txt text={n} />
              </li>
            ))}
          </ul>
        )}
      </Callout>
      {!o.display && (
        <Callout state="warn" role="note" title="Blocked: no screen on this machine">
          No window can open here (a Linux machine without a display): record on a machine with a screen.
        </Callout>
      )}
      {open && (
        <Callout state="warn" role="note" title="Blocked: a recording is already open">
          <p data-testid="record-open-elsewhere">
            One window at a time: <Txt className="k-mono" text={open.rec_id} /> is {shown(o.open?.state === 'queued' ? 'waiting for the worker' : 'open')}.{' '}
            <a className="rc-link" href={hrefTo({ name: 'record', slug: open.project, rec: open.rec_id })}>
              Open it
            </a>
          </p>
        </Callout>
      )}
      <div className="rc-fields">
        <Select
          label="Location"
          testId="record-env"
          value={env?.name ?? ''}
          onChange={pickEnv}
          options={o.environments.map((e) => ({ value: e.name, label: `${e.name}${e.production ? ' (production)' : e.access === 'read-only' ? ' (read-only)' : ''}` }))}
        />
        <Select label="Page" testId="record-page" value={page} onChange={setPage} options={(env?.pages ?? []).map((k) => ({ value: k, label: k }))} />
        <TextField label="Path" testId="record-path" value={path} onChange={setPath} unsaved={null} mono maxLength={2048} spellCheck={false} autoComplete="off" {...(pathProblem ? { error: pathProblem } : {})} />
        <Select label="Persona" testId="record-persona" value={persona} onChange={setPersona} options={[{ value: 'none', label: 'Signed out' }, ...(env?.personas ?? []).map((x) => ({ value: x.name, label: x.name }))]} />
        <TextField
          label="Name"
          testId="record-name"
          value={name}
          onChange={setName}
          unsaved={null}
          mono
          maxLength={NAME_MAX}
          spellCheck={false}
          autoComplete="off"
          {...(problem ? { error: problem } : { hint: 'The draft is made for this name; Save may choose another.' })}
        />
      </div>
      {p && (
        <div className="rc-persona" data-testid="record-persona-state">
          <p>
            <Txt text={p.name} />
            {': '}
            <StoredState p={{ status: p.status ?? 'unchecked', sandbox: p.sandbox }} />{' '}
            {shown(
              p.status === 'valid'
                ? 'the window opens signed in.'
                : p.login_steps
                  ? 'its login steps sign it in first (headless, off camera).'
                  : p.sandbox
                    ? 'a sandbox account.'
                    : 'not signed in: the recording is refused until it is — sign it in first.',
            )}
          </p>
          {p.status !== 'valid' && !p.login_steps && !p.sandbox && env && <SignIn slug={slug} persona={p.name} env={env.name} onDone={onChanged} />}
        </div>
      )}
      {env?.problem && (
        <Callout state="warn" role="note" title="Blocked: this location cannot be recorded">
          <p className="rc-pre">
            <Txt text={env.problem} />
          </p>
        </Callout>
      )}
      {env && env.warnings.length > 0 && (
        <ul className="rc-list rc-quiet" data-testid="record-env-warnings">
          {env.warnings.map((w, i) => (
            <li key={i}>
              <Txt text={w} />
            </li>
          ))}
        </ul>
      )}
      <div className="rc-start-act">
        <Button variant="record" submit data-testid="record-start" disabled={startWhy !== null} aria-describedby="rec-start-why">
          {sending ? 'Opening the window…' : 'Start recording'}
        </Button>
        {signInFirst ? (
          <span id="rec-start-why" className="rc-error" data-testid="record-start-blocked">
            {shown(signInFirst)}
          </span>
        ) : (
          <span id="rec-start-why" className="sc-quiet">
            {shown(startWhy ?? `At most ${o.max_minutes} min; closing the window stops it too.`)}
          </span>
        )}
      </div>
      {refusal?.kind === 'error' && (
        <div ref={refusedBox} tabIndex={-1} className="rc-refused" data-testid="record-start-refused">
          <Callout state="fail" role="note" title="Failed: the recording did not start">
            <p className="rc-pre">
              <Txt text={refusal.message} />
            </p>
            <TerminalCommands {...(refusal.fix ? { fix: refusal.fix } : {})} />
          </Callout>
        </div>
      )}
    </form>
  );
}

export function StartScreen({ slug }: { slug: string }) {
  const [o, reload] = useRecordOptions({ project: slug }, slug);
  useEvents((e) => {
    if (recordEventAction(e, slug, undefined)) reload();
  });
  const started = useCallback(
    (s: RecordStartAnswer) => {
      startedJobs.set(s.rec_id, s.job);
      focusOnArrival.add(s.rec_id);
      location.hash = hrefTo({ name: 'record', slug, rec: s.rec_id });
    },
    [slug],
  );
  return (
    <div className="sc-screen rc-screen">
      <RecordBrowser slug={slug} recordings={{ items: o.state === 'ready' ? o.data.recent : null, current: null }} />
      <header className="rc-head">
        <div className="rc-head-text">
          <h1 className="sc-h1">Record a scenario</h1>
          <p className="sc-quiet">Click through the product in a real browser window; the Studio shows the draft as you go, then saves it as a scenario.</p>
        </div>
      </header>
      {o.state === 'loading' && <p className="sc-quiet">Reading the recording options…</p>}
      {o.state === 'error' && (
        <Callout state="fail" role="alert" title="Failed: the Record screen cannot open">
          <p className="rc-pre">
            <Txt text={o.error} />
          </p>
        </Callout>
      )}
      {o.state === 'ready' && <StartForm key={slug} slug={slug} o={o.data} onStarted={started} onChanged={reload} />}
    </div>
  );
}
