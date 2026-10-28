/**
 * The Record screen (L4.8, R-UI-20 / 21 / 22): the control panel of the REAL browser window the worker opens on this
 * Mac, full size — the person clicks through the product there; nothing typed or clicked here reaches the window (no
 * input is forwarded: BL-25). Two routes:
 *
 * - `#/p/<slug>/record` — the start form (`record_options`): environment, page, path, persona with its stored session
 *   and Sign in, name; the window note (a full-size window: the desktop layout is what the video films), the
 *   environment's warnings, the recording already open in the workspace (one window at a time), the project's recent
 *   recordings. Start (`record_start`: page and path only, the check replay always on) opens the recording's route.
 * - `#/p/<slug>/record/<rec_id>` — one recording (`record_view`, read every 700 ms while it is live and the tab is
 *   visible, every 3 s once it is over, and at once on a `workspace {records}` or `jobs` event; `since` makes an
 *   unchanged read cheap): its state and the time left, the live draft as step rows (page text through `Txt` only),
 *   per step the verified target alternatives to pick from (`record_annotate choose`), a draft cursor ("at the end" or
 *   "after step n" — keyed by the row's identity, never its index: it stays on its row while the draft regenerates, and
 *   moves onto a hold or wait it adds) and quick inserts at it (hold 2 s, wait for, caption, mark, a zoom at most the
 *   theme's max_zoom: `record_annotate insert`, an insert "at the end" placed by the server after the newest event,
 *   critique B3), Remove for each insert, Stop and keep (`record_stop`; then the check's result — a replay of the
 *   recorded draft without the picks and inserts, its failing step shown on its row), Save as scenario (`record_save`:
 *   a new file only, the draft on screen only — a taken name or a changed draft is a 409), Discard (`record_discard`,
 *   after a confirmation; it ends on a neutral "discarded"), the secret placeholders as `{{vars.…}}` names only (never a
 *   value), the writes with the reset advice, the issues. A persona that cannot sign in by itself blocks Start and
 *   offers the Sessions panel's Sign in (so does a preflight refusal). Recordings Claude or a terminal started are shown
 *   read-only (Q5).
 *
 * Accessibility: every control is a button, a labelled field or a radio group (a step's alternatives are a fieldset
 * whose legend names the step; each row's "Insert after this step" names its step and keeps its name, its state in
 * aria-pressed); the insert forms are disclosures (Enter adds, Escape closes and gives focus back); the cursor is a line
 * with words, never only a colour; the steps are a list, not a live region — one visually hidden status line says the
 * state changes and each change made ("Hold added after step 2 of products"); severities are words with a glyph.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import type { DraftIssue, DraftSource, RecordAnnotationChange, RecordInsert, RecordInsertAt, StepBlock } from '@demo-studio/core';
import type { RecordListItem, RecordTargetOption } from '@demo-studio/engine';
import type { RecordEnvironmentOption, RecordOptionsAnswer, RecordStartAnswer, RecordViewAnswer } from '../server/record-ops.js';
import { CallError, call, errorText, useCall } from './api.js';
import { Badge, Loading, Notice, plural, Txt, visibleControls, When } from './bits.js';
import { recordEventAction, useEvents } from './events.js';
import { hrefTo } from './route.js';
import { Commands } from './ScenarioScreen.js';
import { SignIn, StoredState } from './Sessions.js';
import { stepWords } from './scenario-words.js';
import {
  CAPTION_MAX,
  CHECK_SCOPE_NOTE,
  DONE_POLL_MS,
  HOLD_DEFAULT_S,
  INSERT_KIND_WORDS,
  KICKER_MAX,
  LIVE_POLL_MS,
  LIVE_STATES,
  NAME_MAX,
  PLACEHOLDER_WORDS,
  SEVERITY_WORDS,
  STATE_WORDS,
  WAIT_TEXT_MAX,
  WINDOW_NOTE,
  annotateErrorWords,
  annotatedWords,
  checkFailedAt,
  checkWords,
  fragileWords,
  insertAnchor,
  insertText,
  insertWords,
  nameProblem,
  newerView,
  personaProblem,
  preflightSignIn,
  readOnlyWords,
  startedByWords,
  stateSentence,
  statusLine,
  textProblem,
  timeLeft,
  writesWords,
} from './record-words.js';

/** record_start's job per recording, for this tab: the view needs it until the recording's folder exists. */
const startedJobs = new Map<string, string>();

function Breadcrumb({ slug, rec }: { slug: string; rec?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <a href={hrefTo({ name: 'projects' })}>Projects</a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'project', slug })}>
        <Txt text={slug} />
      </a>
      <span aria-hidden="true"> / </span>
      {rec ? (
        <>
          <a href={hrefTo({ name: 'record', slug })}>Record</a>
          <span aria-hidden="true"> / </span>
          <Txt aria-current="page" className="mono" text={rec} />
        </>
      ) : (
        <span aria-current="page">Record</span>
      )}
    </nav>
  );
}

function StateBadge({ state }: { state: RecordListItem['state'] }) {
  const [word, tone] = STATE_WORDS[state] ?? ['unknown', 'neutral'];
  return (
    <span data-testid="record-state" data-state={state}>
      <Badge tone={tone}>{word}</Badge>
    </span>
  );
}

// ── The start form ──────────────────────────────────────────────────────────

/** The project's recordings, newest first: each opens its route. */
export function RecentRecordings({ slug, recent }: { slug: string; recent: RecordListItem[] }) {
  if (recent.length === 0) return <p className="muted">No recording yet.</p>;
  return (
    <ul className="rec-recent" data-testid="record-recent">
      {recent.map((r) => (
        <li key={r.rec_id} data-testid="record-recent-item">
          <a href={hrefTo({ name: 'record', slug, rec: r.rec_id })}>{r.name ? <Txt className="mono" text={r.name} /> : <Txt className="mono" text={r.rec_id} />}</a>
          <StateBadge state={r.state} />
          <span className="muted small">
            {r.steps !== null ? `${plural(r.steps, 'step')} · ` : ''}by {startedByWords(r.started_by)}
            {r.started_at && (
              <>
                {' '}
                · <When iso={r.started_at} />
              </>
            )}
            {r.env && (
              <>
                {' '}
                · <Txt text={r.env} />
              </>
            )}
          </span>
          {r.saved ? (
            <span className="small">
              saved as{' '}
              <a href={hrefTo({ name: 'scenario', slug, scenario: r.saved.name, tab: 'blocks' })}>
                <Txt className="mono" text={r.saved.name} />
              </a>
            </span>
          ) : (
            r.studio && <Badge tone="info">not saved yet</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

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
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
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
  const start = (ev: FormEvent) => {
    ev.preventDefault();
    if (!env || pathProblem || problem || blocked) return;
    setSending(true);
    setRefusal(null);
    call<RecordStartAnswer>('record_start', { project: slug, env: env.name, page, path, persona, name })
      .then(onStarted, (e: unknown) => {
        if (e instanceof CallError && e.status === 409 && typeof e.error.details?.rec_id === 'string') {
          setRefusal({ kind: 'open', project: String(e.error.details.project ?? slug), rec_id: e.error.details.rec_id });
          onChanged();
        } else setRefusal({ kind: 'error', message: errorText(e), ...(e instanceof CallError && e.error.fix ? { fix: e.error.fix } : {}) });
      })
      .finally(() => setSending(false));
  };
  const open = refusal?.kind === 'open' ? refusal : o.open ? { project: o.open.project, rec_id: o.open.rec_id } : null;
  return (
    <form className="card rec-start" onSubmit={start} aria-labelledby="rec-start-h" data-testid="record-start-form">
      <h2 id="rec-start-h" className="card-title">
        Record a new scenario
      </h2>
      <Notice tone="info" role="note" title="A real browser window">
        <p data-testid="record-window-note">{WINDOW_NOTE}</p>
        <ul>
          {o.notes.map((n, i) => (
            <li key={i}>
              <Txt text={n} />
            </li>
          ))}
        </ul>
      </Notice>
      {!o.display && (
        <Notice tone="warning" role="note" title="No screen on this machine">
          <p>No window can open here (a Linux machine without a display): record on a machine with a screen.</p>
        </Notice>
      )}
      {open && (
        <Notice tone="warning" role="note" title="A recording is already open">
          <p data-testid="record-open-elsewhere">
            One window at a time: <Txt className="mono" text={open.rec_id} /> is {o.open?.state === 'queued' ? 'waiting for the worker' : 'open'}.{' '}
            <a href={hrefTo({ name: 'record', slug: open.project, rec: open.rec_id })}>Open it</a>
          </p>
        </Notice>
      )}
      <div className="rec-fields">
        <label className="field">
          <span className="label">Environment</span>
          <select value={env?.name ?? ''} onChange={(e) => pickEnv(e.target.value)} data-testid="record-env">
            {o.environments.map((e) => (
              <option key={e.name} value={e.name}>
                {visibleControls(e.name)}
                {e.production ? ' (production)' : e.access === 'read-only' ? ' (read-only)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Page</span>
          <select value={page} onChange={(e) => setPage(e.target.value)} data-testid="record-page">
            {(env?.pages ?? []).map((k) => (
              <option key={k} value={k}>
                {visibleControls(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Path</span>
          <input type="text" value={path} maxLength={2048} onChange={(e) => setPath(e.target.value)} aria-invalid={pathProblem !== null} spellCheck={false} data-testid="record-path" />
          {pathProblem && <span className="field-error">{pathProblem}</span>}
        </label>
        <label className="field">
          <span className="label">Persona</span>
          <select value={persona} onChange={(e) => setPersona(e.target.value)} data-testid="record-persona">
            <option value="none">Signed out</option>
            {(env?.personas ?? []).map((x) => (
              <option key={x.name} value={x.name}>
                {visibleControls(x.name)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Name</span>
          <input type="text" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} aria-invalid={problem !== null} spellCheck={false} data-testid="record-name" />
          {problem ? <span className="field-error">{problem}</span> : <span className="muted small">The draft is made for this name; Save may choose another.</span>}
        </label>
      </div>
      {p && (
        <div className="rec-persona" data-testid="record-persona-state">
          <p className="small">
            <Txt text={p.name} />: <StoredState p={{ status: p.status ?? 'unchecked', sandbox: p.sandbox }} />{' '}
            {p.status === 'valid'
              ? 'the window opens signed in.'
              : p.login_steps
                ? 'its login steps sign it in first (headless, off camera).'
                : p.sandbox
                  ? 'a sandbox account.'
                  : 'not signed in: the recording is refused until it is — sign it in first.'}
          </p>
          {p.status !== 'valid' && !p.login_steps && !p.sandbox && env && <SignIn slug={slug} persona={p.name} env={env.name} onDone={onChanged} />}
        </div>
      )}
      {env?.problem && (
        <Notice tone="warning" role="note" title="This environment cannot be recorded">
          <p className="pre-line">
            <Txt text={env.problem} />
          </p>
        </Notice>
      )}
      {env && env.warnings.length > 0 && (
        <ul className="rec-warnings small" data-testid="record-env-warnings">
          {env.warnings.map((w, i) => (
            <li key={i}>
              <Txt text={w} />
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="submit" className="button primary" disabled={sending || blocked || pathProblem !== null || problem !== null} data-testid="record-start">
          {sending ? 'Opening…' : 'Start recording'}
        </button>
        {signInFirst ? (
          <span className="field-error" data-testid="record-start-blocked">
            {signInFirst}
          </span>
        ) : (
          <span className="muted small">At most {o.max_minutes} min; closing the window stops it too.</span>
        )}
      </div>
      {refusal?.kind === 'error' && (
        <Notice tone="danger" role="alert" title="The recording did not start">
          <p className="pre-line">
            <Txt text={refusal.message} />
          </p>
          <Commands {...(refusal.fix ? { fix: refusal.fix } : {})} />
        </Notice>
      )}
    </form>
  );
}

function StartScreen({ slug }: { slug: string }) {
  const [o, reload] = useCall<RecordOptionsAnswer>('record_options', { project: slug }, slug);
  useEvents((e) => {
    if (recordEventAction(e, slug, undefined)) reload();
  });
  const started = useCallback(
    (s: RecordStartAnswer) => {
      startedJobs.set(s.rec_id, s.job);
      location.hash = hrefTo({ name: 'record', slug, rec: s.rec_id });
    },
    [slug],
  );
  return (
    <div className="screen rec-screen">
      <Breadcrumb slug={slug} />
      <header className="screen-head">
        <h1>Record a scenario</h1>
        <p className="muted">Click through the product in a real browser window; the Studio shows the draft as you go, then saves it as a scenario.</p>
      </header>
      {o.state === 'loading' && <Loading what="the recording options" />}
      {o.state === 'error' && (
        <Notice tone="danger" role="alert" title="The Record screen cannot open">
          <p className="pre-line">
            <Txt text={o.error} />
          </p>
        </Notice>
      )}
      {o.state === 'ready' && (
        <div className="rec-start-grid">
          <StartForm key={slug} slug={slug} o={o.data} onStarted={started} onChanged={reload} />
          <section className="card" aria-labelledby="rec-recent-h">
            <h2 id="rec-recent-h" className="card-title">
              Recent recordings
            </h2>
            <RecentRecordings slug={slug} recent={o.data.recent} />
          </section>
        </div>
      )}
    </div>
  );
}

// ── One recording ───────────────────────────────────────────────────────────

/**
 * Where the next insert goes: after the newest event (the default; it follows new actions), or right after one row —
 * by the row's identity (DraftSource.row), never its index: the line stays on that row while the draft regenerates.
 */
export type Cursor = { at: 'end' } | { at: 'after'; row: string };

type Untrusted = NonNullable<RecordViewAnswer['untrusted']>;
type Alt = Untrusted['alternatives'][number];

/** The rows of the draft, scene by scene: each step with where it came from and its alternatives. */
interface DraftRow {
  key: string;
  /** The row's identity (its source's `row`; its key when it has no source). */
  id: string;
  scene: string;
  step: StepBlock;
  source?: DraftSource;
  alt?: Alt;
  insert?: RecordInsert;
  modifiers: RecordInsert[];
}

export function draftRows(u: Untrusted): Array<{ scene: string; page?: string; open?: string; rows: DraftRow[] }> {
  const inserts = new Map(u.inserts.map((i) => [i.id, i]));
  const sources = new Map(u.sources.map((s) => [`${s.scene}\u0000${s.step}`, s]));
  const alts = new Map(u.alternatives.map((a) => [`${a.scene}\u0000${a.step}`, a]));
  const out: Array<{ scene: string; page?: string; open?: string; rows: DraftRow[] }> = [];
  for (const e of u.blocks.entries) {
    if (e.type !== 'scene') continue;
    out.push({
      scene: e.id,
      ...(e.page !== undefined ? { page: e.page } : {}),
      ...(e.open !== undefined ? { open: e.open } : {}),
      rows: e.steps.map((step) => {
        const k = `${e.id}\u0000${step.index}`;
        const source = sources.get(k);
        const insert = source?.insert !== undefined ? inserts.get(source.insert) : undefined;
        const alt = alts.get(k);
        return {
          key: step.key,
          id: source?.row ?? step.key,
          scene: e.id,
          step,
          ...(source ? { source } : {}),
          ...(alt ? { alt } : {}),
          ...(insert ? { insert } : {}),
          modifiers: (source?.modifiers ?? []).flatMap((id) => (inserts.has(id) ? [inserts.get(id)!] : [])),
        };
      }),
    });
  }
  return out;
}

/** The handlers a recording's body calls (the screen sends the ops; a test renders the body with none). */
export interface RecordingActions {
  annotate: (change: RecordAnnotationChange) => void;
  stop: () => void;
  discard: () => void;
  save: (name: string) => void;
  onSignedIn: () => void;
}

export interface RecordingUi {
  busy: boolean;
  /** The last action's refusal or result, in words. */
  note: { tone: 'info' | 'warning' | 'danger'; text: string; issues?: DraftIssue[]; fix?: string } | null;
  /** Save's refusal for a taken name. */
  taken: string | null;
  discarding: boolean;
  now: number;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="rec-fact">
      <span className="muted">{label}</span> {children}
    </span>
  );
}

/** The recording's header: name, state, facts, time left. */
function RecordingHead({ v, now }: { v: RecordViewAnswer; now: number }) {
  const left = v.state === 'recording' ? timeLeft(v.ends_at, now) : null;
  return (
    <header className="screen-head">
      <h1>
        Recording{' '}
        {v.name && (
          <>
            <Txt className="mono" text={v.name} />
          </>
        )}
      </h1>
      <p className="rec-facts">
        <StateBadge state={v.state} />
        {v.env && (
          <Fact label="environment">
            <Txt text={v.env} />
            {v.access === 'read-only' && <Badge tone="warning">read-only</Badge>}
          </Fact>
        )}
        {v.page && (
          <Fact label="opened at">
            <Txt className="mono" text={`${v.page} ${v.path ?? '/'}`} />
          </Fact>
        )}
        {(v.persona !== null || v.started_at !== null) && <Fact label="as">{v.persona ? <Txt text={v.persona} /> : 'signed out'}</Fact>}
        <Fact label="started by">{startedByWords(v.started_by)}</Fact>
        {v.started_at && (
          <Fact label="started">
            <When iso={v.started_at} />
          </Fact>
        )}
        {left && (
          <Fact label="stops by itself in">
            <span data-testid="record-time-left">{left}</span>
          </Fact>
        )}
      </p>
      <p className="rec-sentence" data-testid="record-sentence">
        {stateSentence(v.state)}
      </p>
    </header>
  );
}

/** A step's verified target alternatives as a radio group (index 0: the recorder's suggestion). */
function Alternatives({ row, n, can, busy, onChoose }: { row: DraftRow; n: number; can: boolean; busy: boolean; onChoose: (seq: number, index: number) => void }) {
  const alt = row.alt!;
  const others = alt.options.length - 1;
  // A pick made on an earlier press of the same target (a click the typing folded in) is the one in effect while this
  // press has none (critique B1): its option is the one whose words are the step's target.
  const earlier = row.source?.chosen !== undefined && row.source.chosen.seq !== alt.seq && row.source.chosen.index > 0;
  const checked = alt.chosen > 0 || !earlier ? alt.chosen : (alt.options.find((o) => o.words === row.step.target)?.index ?? -1);
  const picked = alt.chosen > 0 || earlier;
  return (
    <details className="rec-alts" data-testid="record-alternatives">
      <summary>
        {picked ? 'Target picked by you' : `Other targets: ${others} verified`}
        {picked && <Badge tone="info">picked</Badge>}
      </summary>
      <fieldset disabled={!can || busy}>
        <legend>Target of step {n}</legend>
        {alt.options.map((o: RecordTargetOption) => (
          <label key={o.index} className="rec-alt">
            <input type="radio" name={`alt-${row.key}`} checked={checked === o.index} onChange={() => onChoose(alt.seq, o.index)} data-testid="record-alternative" />
            <span>
              <Txt className="step-target" text={o.words} /> {o.index === 0 && <span className="muted small">(the recorder’s suggestion)</span>}
              {o.fragile.length > 0 && <span className="muted small"> — {fragileWords(o.fragile).join('; ')}</span>}
            </span>
          </label>
        ))}
        {checked === -1 && <p className="muted small">Picked on an earlier press of this target; choose here to change it.</p>}
      </fieldset>
    </details>
  );
}

function InsertChip({ i, can, busy, onRemove, where }: { i: RecordInsert; can: boolean; busy: boolean; onRemove: (id: string) => void; where: string }) {
  const text = insertText(i);
  return (
    <span className="rec-chip" data-testid="record-insert-chip" data-kind={i.kind}>
      <span className="rec-by">added by you</span> {insertWords(i)}
      {text !== null && (
        <>
          {': '}
          <Txt text={text} />
        </>
      )}
      {can && (
        <button type="button" className="button quiet small" disabled={busy} onClick={() => onRemove(i.id)} aria-label={visibleControls(`Remove the ${INSERT_KIND_WORDS[i.kind].toLowerCase()} ${where}`)} data-testid="record-insert-remove">
          Remove
        </button>
      )}
    </span>
  );
}

function CursorLine({ cursor, live, onEnd }: { cursor: Cursor; live: boolean; onEnd?: () => void }) {
  return (
    <li className="rec-cursor" data-testid="record-cursor" aria-label={cursor.at === 'end' ? 'Inserts go here: at the end' : 'Inserts go here'}>
      <span className="rec-cursor-words">▸ Insert here{cursor.at === 'end' ? (live ? ' — at the end (follows your next actions)' : ' — at the end') : ''}</span>
      {cursor.at === 'after' && onEnd && (
        <button type="button" className="button quiet small" onClick={onEnd} data-testid="record-cursor-end">
          Back to the end
        </button>
      )}
    </li>
  );
}

/** The row the cursor is on (by its identity), with its words and the anchor an insert there gets; null at the end. */
export function cursorRow(u: Untrusted | null, cursor: Cursor): { label: string; at: RecordInsertAt } | null {
  if (cursor.at !== 'after' || !u) return null;
  for (const s of draftRows(u)) {
    for (const r of s.rows) if (r.source && r.id === cursor.row) return { label: stepWords(s.scene, r.step.index), at: insertAnchor(r.source) };
  }
  return null;
}

/** The draft's step rows with the cursor among them. */
function DraftList({ v, cursor, setCursor, ui, act }: { v: RecordViewAnswer; cursor: Cursor; setCursor: (c: Cursor) => void; ui: RecordingUi; act: RecordingActions }) {
  const u = v.untrusted!;
  const scenes = draftRows(u);
  const can = v.can.annotate;
  const inserts = new Map(u.inserts.map((i) => [i.id, i]));
  const remove = (id: string) => act.annotate({ op: 'remove', id });
  const choose = (seq: number, index: number) => act.annotate({ op: 'choose', seq, index });
  const end = () => setCursor({ at: 'end' });
  if (scenes.every((s) => s.rows.length === 0)) {
    return (
      <>
        <p className="muted" data-testid="record-no-steps">
          {LIVE_STATES.has(v.state) ? 'No step yet: click in the window — each action becomes a step here.' : 'The draft has no step.'}
        </p>
        {can && (
          <ol className="rec-steps">
            <CursorLine cursor={{ at: 'end' }} live={LIVE_STATES.has(v.state)} />
          </ol>
        )}
      </>
    );
  }
  return (
    <div className="rec-draft" data-testid="record-draft">
      {scenes.map((s, si) => (
        <section key={`${s.scene}-${si}`} className="rec-scene" aria-label={`Scene ${si + 1}`}>
          <h3 className="rec-scene-title">
            Scene {si + 1}: <Txt className="mono" text={s.scene} />
            {s.page && (
              <span className="muted small">
                {' '}
                · <Txt text={s.page} />
                {s.open && (
                  <>
                    {' '}
                    <Txt className="mono" text={s.open} />
                  </>
                )}
              </span>
            )}
          </h3>
          <ol className="rec-steps">
            {s.rows.map((r) => {
              const n = r.step.index + 1;
              const where = stepWords(s.scene, r.step.index);
              const here = cursor.at === 'after' && !!r.source && cursor.row === r.id;
              const role = r.source?.role;
              return (
                <RowWithCursor key={r.key} here={here} cursor={cursor} live={LIVE_STATES.has(v.state)} onEnd={end}>
                  <li
                    className={['rec-step', role === 'insert' ? 'is-insert' : '', role === 'helper' ? 'is-helper' : ''].filter(Boolean).join(' ')}
                    data-testid="record-step"
                    data-key={r.key}
                    data-row={r.id}
                    data-role={role ?? ''}
                    data-helper={r.source?.helper ?? ''}
                  >
                    <p className="step-head">
                      <span className="step-n">{n}</span>
                      <span className={`action action-${r.step.category}`}>{r.step.category === 'unknown' ? 'unknown' : r.step.category.replace('_', ' ')}</span>
                      <Txt className="step-label" text={r.step.label} />
                      {r.step.target && <Txt className="step-target" text={r.step.target} />}
                      {role === 'helper' && <span className="muted small">added by the recorder</span>}
                    </p>
                    {r.step.summary && (
                      <p className="step-summary muted">
                        <Txt text={r.step.summary} />
                      </p>
                    )}
                    {r.step.chips.length > 0 && (
                      <p className="chips">
                        {r.step.chips.map((c, i) => (
                          <span key={i} className={`chip chip-${c.kind}`} data-chip={c.kind}>
                            <Txt text={c.label} />
                          </span>
                        ))}
                      </p>
                    )}
                    {(r.insert || r.modifiers.length > 0) && (
                      <p className="rec-chips">
                        {r.insert && <InsertChip i={r.insert} can={can} busy={ui.busy} onRemove={remove} where={`at ${where}`} />}
                        {r.modifiers.map((m) => (
                          <InsertChip key={m.id} i={m} can={can} busy={ui.busy} onRemove={remove} where={`on ${where}`} />
                        ))}
                      </p>
                    )}
                    {can && r.alt && r.alt.options.length > 1 && <Alternatives row={r} n={n} can={can} busy={ui.busy} onChoose={choose} />}
                    {can && (
                      <p className="rec-step-actions">
                        <button
                          type="button"
                          className="button quiet small"
                          aria-pressed={here}
                          aria-label={visibleControls(`Insert after ${where}`)}
                          onClick={() => (here ? end() : r.source && setCursor({ at: 'after', row: r.id }))}
                          disabled={!r.source}
                          data-testid="record-insert-after"
                        >
                          Insert after this step
                        </button>
                      </p>
                    )}
                  </li>
                </RowWithCursor>
              );
            })}
            {si === scenes.length - 1 && can && cursor.at === 'end' && <CursorLine cursor={cursor} live={LIVE_STATES.has(v.state)} />}
          </ol>
        </section>
      ))}
      {u.pending.length > 0 && (
        <div className="rec-pending" data-testid="record-pending">
          <p className="small">Applies to your next action:</p>
          <p className="rec-chips">
            {u.pending.flatMap((id) => (inserts.has(id) ? [inserts.get(id)!] : [])).map((i) => (
              <InsertChip key={i.id} i={i} can={can} busy={ui.busy} onRemove={remove} where="waiting for your next action" />
            ))}
          </p>
        </div>
      )}
    </div>
  );
}

function RowWithCursor({ here, cursor, live, onEnd, children }: { here: boolean; cursor: Cursor; live: boolean; onEnd: () => void; children: ReactNode }) {
  return (
    <>
      {children}
      {here && <CursorLine cursor={cursor} live={live} onEnd={onEnd} />}
    </>
  );
}

/** A disclosure for an insert's form: Enter adds (the form's submit), Escape closes and gives focus back to its button. */
function Disclosure({ label, testid, children, onSubmit, disabled }: { label: string; testid: string; children: (close: () => void) => ReactNode; onSubmit: (close: () => void) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  useEffect(() => {
    if (open) formRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  return (
    <div className="rec-disclosure">
      <button ref={btn} type="button" className="button small" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={disabled} data-testid={testid}>
        {label}
      </button>
      {open && (
        <form
          ref={formRef}
          className="rec-insert-form"
          onKeyDown={onKey}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(close);
          }}
        >
          {children(close)}
        </form>
      )}
    </div>
  );
}

/** The quick inserts at the cursor (`where`: the cursor's row, null at the end). */
function Inserts({ where, zoom, setCursor, ui, act, live }: { where: { label: string; at: RecordInsertAt } | null; zoom: RecordViewAnswer['zoom']; setCursor: (c: Cursor) => void; ui: RecordingUi; act: RecordingActions; live: boolean }) {
  const at: RecordInsertAt = where ? where.at : 'end';
  const add = (insert: Extract<RecordAnnotationChange, { op: 'insert' }>['insert']) => act.annotate({ op: 'insert', at, insert });
  const [until, setUntil] = useState<'next_target' | 'idle' | 'text'>('next_target');
  const [waitText, setWaitText] = useState('');
  const [caption, setCaption] = useState('');
  const [kicker, setKicker] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="card rec-inserts" aria-labelledby="rec-ins-h" data-testid="record-inserts">
      <h2 id="rec-ins-h" className="card-title">
        Quick inserts
      </h2>
      <p className="small" data-testid="record-cursor-where">
        Where:{' '}
        {where === null ? (
          live ? (
            'at the end — a hold or a wait goes before your next action; a caption, a mark or a zoom goes on it.'
          ) : (
            'at the end — a hold or a wait goes after the last step; a caption, a mark or a zoom goes on it.'
          )
        ) : (
          <>
            after <Txt text={where.label} />.{' '}
            <button type="button" className="button quiet small" onClick={() => setCursor({ at: 'end' })}>
              Back to the end
            </button>
          </>
        )}
      </p>
      <div className="actions rec-insert-buttons">
        <button type="button" className="button small" disabled={ui.busy} onClick={() => add({ kind: 'hold', seconds: HOLD_DEFAULT_S })} data-testid="record-insert-hold">
          Hold {HOLD_DEFAULT_S} s
        </button>
        <button type="button" className="button small" disabled={ui.busy} onClick={() => add({ kind: 'mark' })} data-testid="record-insert-mark">
          Mark
        </button>
        {zoom && (
          <button type="button" className="button small" disabled={ui.busy} onClick={() => add({ kind: 'camera', zoom: zoom.default, until: 'scene_end' })} data-testid="record-insert-zoom">
            Zoom {zoom.default}×
          </button>
        )}
        <Disclosure
          label="Wait for…"
          testid="record-insert-wait"
          disabled={ui.busy}
          onSubmit={(close) => {
            const p = until === 'text' ? textProblem(waitText, WAIT_TEXT_MAX) : null;
            setProblem(p);
            if (p) return;
            add(until === 'text' ? { kind: 'wait_for', until, text: waitText } : { kind: 'wait_for', until });
            setWaitText('');
            close();
          }}
        >
          {(close) => (
            <>
              <fieldset className="rec-radios">
                <legend>Wait until</legend>
                {(
                  [
                    ['next_target', 'the next target shows'],
                    ['idle', 'the page is idle'],
                    ['text', 'a text shows'],
                  ] as const
                ).map(([k, w]) => (
                  <label key={k}>
                    <input type="radio" name="rec-wait-until" checked={until === k} onChange={() => setUntil(k)} /> {w}
                  </label>
                ))}
              </fieldset>
              {until === 'text' && (
                <label className="field">
                  <span className="label">Text</span>
                  <input type="text" value={waitText} maxLength={WAIT_TEXT_MAX} onChange={(e) => setWaitText(e.target.value)} data-testid="record-wait-text" />
                </label>
              )}
              <div className="actions">
                <button type="submit" className="button small primary" data-testid="record-wait-add">
                  Add the wait
                </button>
                <button type="button" className="button small quiet" onClick={close}>
                  Close
                </button>
              </div>
            </>
          )}
        </Disclosure>
        <Disclosure
          label="Caption…"
          testid="record-insert-caption"
          disabled={ui.busy}
          onSubmit={(close) => {
            const p = textProblem(caption, CAPTION_MAX) ?? (kicker ? textProblem(kicker, KICKER_MAX) : null);
            setProblem(p);
            if (p) return;
            add({ kind: 'caption', text: caption, ...(kicker ? { kicker } : {}) });
            setCaption('');
            setKicker('');
            close();
          }}
        >
          {(close) => (
            <>
              <label className="field">
                <span className="label">Caption</span>
                <input type="text" value={caption} maxLength={CAPTION_MAX} onChange={(e) => setCaption(e.target.value)} data-testid="record-caption-text" />
              </label>
              <label className="field">
                <span className="label">Kicker (optional)</span>
                <input type="text" value={kicker} maxLength={KICKER_MAX} onChange={(e) => setKicker(e.target.value)} data-testid="record-caption-kicker" />
              </label>
              <div className="actions">
                <button type="submit" className="button small primary" data-testid="record-caption-add">
                  Add the caption
                </button>
                <button type="button" className="button small quiet" onClick={close}>
                  Close
                </button>
              </div>
            </>
          )}
        </Disclosure>
      </div>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/** Stop and keep, Discard (after a confirmation), Save as scenario. */
function Controls({ v, ui, act }: { v: RecordViewAnswer; ui: RecordingUi; act: RecordingActions }) {
  const [name, setName] = useState(v.name ?? '');
  const [confirming, setConfirming] = useState(false);
  const problem = nameProblem(name);
  const beforeWindow = v.state === 'queued' || v.state === 'preflight';
  const stopping = v.job?.stop_requested || v.job?.cancel_requested;
  if (!v.can.stop && !v.can.discard && !v.can.save) return null;
  return (
    <section className="card rec-controls" aria-labelledby="rec-ctl-h">
      <h2 id="rec-ctl-h" className="card-title">
        {v.can.stop ? 'The window' : v.can.save ? 'Save' : 'Discard'}
      </h2>
      {v.can.stop && (
        <div className="actions">
          <button type="button" className="button primary" disabled={ui.busy || !!stopping} onClick={act.stop} data-testid="record-stop">
            {stopping ? 'Stopping…' : beforeWindow ? 'Cancel' : 'Stop and keep'}
          </button>
          <span className="muted small">{beforeWindow ? 'Nothing is recorded yet.' : 'The window closes as if you closed it; the draft is made, then checked.'}</span>
        </div>
      )}
      {v.can.save && (
        <form
          className="rec-save"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) act.save(name);
          }}
        >
          <label className="field">
            <span className="label">Save as scenario</span>
            <input type="text" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} aria-invalid={problem !== null || ui.taken === name} spellCheck={false} data-testid="record-save-name" />
            {problem ? (
              <span className="field-error">{problem}</span>
            ) : ui.taken === name ? (
              <span className="field-error" role="alert" data-testid="record-save-taken">
                scenarios/<Txt text={name} />
                .yaml exists: choose another name (a scenario is never overwritten from here).
              </span>
            ) : (
              <span className="muted small">A new file, scenarios/&lt;name&gt;.yaml — never an existing one.</span>
            )}
          </label>
          <div className="actions">
            <button type="submit" className="button primary" disabled={ui.busy || problem !== null || !v.draft_sha256} data-testid="record-save">
              Save as scenario
            </button>
          </div>
        </form>
      )}
      {v.can.discard && (
        <div className="actions">
          <button type="button" className="button danger" disabled={ui.busy || ui.discarding} onClick={() => setConfirming(true)} data-testid="record-discard">
            {ui.discarding ? 'Discarding…' : 'Discard'}
          </button>
        </div>
      )}
      {confirming && (
        <ConfirmDiscard
          live={LIVE_STATES.has(v.state)}
          onClose={(yes) => {
            setConfirming(false);
            if (yes) act.discard();
          }}
        />
      )}
    </section>
  );
}

function ConfirmDiscard({ live, onClose }: { live: boolean; onClose: (yes: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    keep.current?.focus();
    return () => d?.close();
  }, []);
  const close = (yes: boolean) => {
    ref.current?.close();
    onClose(yes);
  };
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="discard-h"
      aria-describedby="discard-what"
      data-testid="record-discard-confirm"
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
    >
      <h2 id="discard-h" className="card-title">
        Discard this recording?
      </h2>
      <p id="discard-what">
        {live ? 'The window closes (or the check stops) and the recording' : 'The recording'} is removed: its events, its draft, your picks and inserts. A scenario saved from it is never touched.
      </p>
      <div className="actions">
        <button ref={keep} type="button" className="button" onClick={() => close(false)} data-testid="record-discard-keep">
          Keep it
        </button>
        <button type="button" className="button danger" onClick={() => close(true)} data-testid="record-discard-yes">
          Discard
        </button>
      </div>
    </dialog>
  );
}

function IssuesCard({ issues }: { issues: DraftIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <section className="card" aria-labelledby="rec-issues-h">
      <h2 id="rec-issues-h" className="card-title">
        To look at <span className="muted">({issues.length})</span>
      </h2>
      <ul className="rec-issues" data-testid="record-issues">
        {issues.map((i, n) => {
          const [word, tone] = SEVERITY_WORDS[i.severity];
          return (
            <li key={n} data-code={i.code}>
              <Badge tone={tone}>{word}</Badge>{' '}
              {i.scene !== undefined && (
                <span className="muted small">
                  <Txt text={i.step !== undefined ? stepWords(i.scene, i.step) : `scene ${i.scene}`} />:{' '}
                </span>
              )}
              <Txt text={i.message} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PlaceholdersCard({ u }: { u: Untrusted }) {
  if (u.placeholders.length === 0) return null;
  return (
    <section className="card" aria-labelledby="rec-secrets-h" data-testid="record-placeholders">
      <h2 id="rec-secrets-h" className="card-title">
        Secret fields
      </h2>
      <p className="small">What was typed there is never kept or shown: the draft types a placeholder instead.</p>
      <ul className="rec-secrets">
        {u.placeholders.map((p, i) => (
          <li key={`${p.name}-${i}`}>
            <code className="mono">
              <Txt text={`{{vars.${p.name}}}`} />
            </code>{' '}
            {PLACEHOLDER_WORDS[p.kind] ?? 'a secret'}, <Txt text={stepWords(p.scene, p.step)} />
            {p.project_var ? <span className="muted small"> — project.yaml’s var of that name is used.</span> : <Badge tone="warning">CHANGE-ME in the draft</Badge>}
          </li>
        ))}
      </ul>
      <p className="muted small">
        Put a showable demo value under <code>vars:</code> in project.yaml with that name (it is used at once), never the real one; or, once saved, put an{' '}
        <code>{'{{env:…}}'}</code> reference in the scenario in your editor (that scenario then runs from a terminal only).
      </p>
    </section>
  );
}

function WritesCard({ v }: { v: RecordViewAnswer }) {
  const words = writesWords(v.writes, v.access);
  if (!words) return null;
  const labels = v.untrusted?.writes ?? [];
  return (
    <section className="card" aria-labelledby="rec-writes-h" data-testid="record-writes">
      <h2 id="rec-writes-h" className="card-title">
        Writes
      </h2>
      <p className="small">{words}</p>
      {labels.length > 0 && (
        <div className="from-page small">
          <p className="from-page-title">From the page</p>
          <ul>
            {labels.slice(0, 20).map((w, i) => (
              <li key={i}>
                <Txt className="mono" text={w.label} /> <span className="muted">— {w.outcome}</span>
              </li>
            ))}
          </ul>
          {labels.length > 20 && <p className="muted">{plural(labels.length - 20, 'more write')}</p>}
        </div>
      )}
    </section>
  );
}

function CheckCard({ v }: { v: RecordViewAnswer }) {
  if (!v.check) return null;
  const w = checkWords(v.check);
  const c = v.untrusted?.check;
  const at = checkFailedAt(c);
  return (
    <Notice tone={w.tone} role="note" title={w.title}>
      <p data-testid="record-check" data-status={v.check.status}>
        {w.detail}
      </p>
      {at && c?.failed_at && (
        <p className="small" data-testid="record-check-at" data-recorded={at.recorded ? 'true' : 'false'}>
          {at.recorded ? 'At recorded ' : 'At '}
          <Txt text={stepWords(at.scene, at.step)} /> (<Txt text={c.failed_at.action} />){at.recorded ? ' — not a row on screen any more' : ''}
        </p>
      )}
      {c?.error && (
        <div className="from-page small">
          <p className="from-page-title">From the page</p>
          <p className="pre-line">
            <Txt text={c.error} />
          </p>
        </div>
      )}
      <p className="muted small">{CHECK_SCOPE_NOTE}</p>
    </Notice>
  );
}

/** The job's error: a preflight refusal (a persona not signed in) offers Sign in; anything else says it with its command. */
function JobError({ v, slug, onSignedIn }: { v: RecordViewAnswer; slug: string; onSignedIn: () => void }) {
  const e = v.job?.error;
  // A cancel the Studio asked for (Stop before the window, Discard) is not an error: the state says it.
  if (!e || (v.state !== 'failed' && v.state !== 'cancelled') || e.code === 'cancelled') return null;
  const sign = preflightSignIn(v);
  return (
    <Notice tone="danger" role="note" title={sign ? 'The persona is not signed in' : 'The recording did not finish'}>
      <p className="pre-line" data-testid="record-job-error" data-code={e.code}>
        <Txt text={e.message} />
      </p>
      {sign ? (
        <div className="rec-sign-in" data-testid="record-sign-in">
          <p className="small">
            Sign <Txt text={sign.persona} /> in (a window where you sign in yourself), then record again.
          </p>
          <SignIn slug={slug} persona={sign.persona} env={sign.env} onDone={onSignedIn} />
          <p className="small">
            <a href={hrefTo({ name: 'record', slug })}>Record again</a>
          </p>
        </div>
      ) : (
        <Commands {...(e.fix ? { fix: e.fix } : {})} />
      )}
    </Notice>
  );
}

/** One recording as the view tells it (the screen reads it; a test renders it with any view). */
export function RecordingBody({ slug, v, cursor, setCursor, ui, act }: { slug: string; v: RecordViewAnswer; cursor: Cursor; setCursor: (c: Cursor) => void; ui: RecordingUi; act: RecordingActions }) {
  const u = v.untrusted;
  const live = LIVE_STATES.has(v.state);
  const readOnly = v.started_by !== 'ui' && v.started_by !== null && v.state !== 'missing';
  const where = cursorRow(u, cursor);
  return (
    <>
      <RecordingHead v={v} now={ui.now} />
      {readOnly ? (
        <Notice tone="info" role="note" title="Read-only">
          <p data-testid="record-read-only">{v.problem ? <Txt text={v.problem} /> : readOnlyWords(v.started_by)}</p>
        </Notice>
      ) : (
        v.problem && (
          <Notice tone="warning" role="note" title="About this draft">
            <p className="pre-line" data-testid="record-problem">
              <Txt text={v.problem} />
            </p>
          </Notice>
        )
      )}
      {v.saved && (
        <Notice tone="info" role="note" title="Saved as a scenario">
          <p data-testid="record-saved">
            <Txt className="mono" text={v.saved.file} /> —{' '}
            <a href={hrefTo({ name: 'scenario', slug, scenario: v.saved.name, tab: 'blocks' })}>Open the scenario</a> ·{' '}
            <a href={hrefTo({ name: 'run', slug, scenario: v.saved.name })}>Dry run it</a>
          </p>
        </Notice>
      )}
      {v.state === 'discarded' && (
        <p>
          <a className="button" href={hrefTo({ name: 'record', slug })}>
            Record another scenario
          </a>
        </p>
      )}
      <JobError v={v} slug={slug} onSignedIn={act.onSignedIn} />
      {ui.note && (
        <Notice tone={ui.note.tone} role="alert">
          <p className="pre-line" data-testid="record-note">
            <Txt text={ui.note.text} />
          </p>
          {ui.note.issues && ui.note.issues.length > 0 && (
            <ul className="small">
              {ui.note.issues.map((i, n) => (
                <li key={n}>
                  {i.scene !== undefined && <Txt text={`${i.step !== undefined ? stepWords(i.scene, i.step) : `scene ${i.scene}`}: `} />}
                  <Txt text={i.message} />
                </li>
              ))}
            </ul>
          )}
          <Commands {...(ui.note.fix ? { fix: ui.note.fix } : {})} />
        </Notice>
      )}
      <div className="rec-grid">
        {(u || live) && (
        <section className="card rec-draft-card" aria-labelledby="rec-draft-h">
          <div className="card-head">
            <h2 id="rec-draft-h" className="card-title">
              The draft
            </h2>
            <span className="muted small" data-testid="record-counts">
              {plural(v.counts.actions, 'action')}
              {v.stats ? ` · ${plural(v.stats.steps, 'step')}` : ''}
              {v.counts.dropped_lines > 0 ? ` · ${plural(v.counts.dropped_lines, 'unreadable line')} left out` : ''}
            </span>
          </div>
          {u ? <DraftList v={v} cursor={cursor} setCursor={setCursor} ui={ui} act={act} /> : <p className="muted">{live ? 'The draft shows here once the window is open.' : 'No draft.'}</p>}
          {u && u.yaml_lines.length > 0 && (
            <details className="rec-yaml">
              <summary>The draft as YAML</summary>
              <pre className="readme-text" data-testid="record-yaml">
                {u.yaml_lines.map((l, i) => (
                  <span key={i}>
                    <Txt text={l} />
                    {'\n'}
                  </span>
                ))}
              </pre>
            </details>
          )}
        </section>
        )}
        <div className="stack">
          <Controls key={`${v.rec_id}-${v.name ?? ''}`} v={v} ui={ui} act={act} />
          <CheckCard v={v} />
          {v.can.annotate && u && <Inserts where={where} zoom={v.zoom} setCursor={setCursor} ui={ui} act={act} live={live} />}
          {u && <PlaceholdersCard u={u} />}
          <WritesCard v={v} />
          {u && <IssuesCard issues={u.issues} />}
          {v.warnings.length > 0 && (
            <section className="card" aria-labelledby="rec-warn-h">
              <h2 id="rec-warn-h" className="card-title">
                Warnings
              </h2>
              <ul className="small">
                {v.warnings.map((w, i) => (
                  <li key={i}>
                    <Txt text={w} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/** A recording's view, read live: the poll (700 ms live / 3 s after, never while the tab is hidden) and the events. */
function useRecordView(slug: string, rec: string): [RecordViewAnswer | null, string | null, () => void, (v: RecordViewAnswer, fresh?: boolean) => void, () => void] {
  const [view, setView] = useState<RecordViewAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef<string | null>(null);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const again = useRef(false);
  const viewRef = useRef<RecordViewAnswer | null>(null);
  const looked = useRef(false);
  /** The next full view is shown whatever its revision (the server said the screen's revision is not the current one). */
  const force = useRef(false);
  /** A view to show — never an older revision over a newer one (a poll sent before an annotate came back after it). */
  const accept = useCallback((v: RecordViewAnswer, fresh = false) => {
    if (!(force.current && !v.unchanged) && !newerView(viewRef.current, v)) return;
    if (!v.unchanged) force.current = false;
    // An answer to the person's own change: any poll still on its way is older.
    if (fresh) seq.current++;
    viewRef.current = v;
    version.current = v.version;
    setView(v);
  }, []);
  const load = useCallback(() => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    const n = ++seq.current;
    // The job (until the folder exists, and once a discard removed it): record_start's in this tab, else the last view's.
    const job = startedJobs.get(rec) ?? viewRef.current?.job?.id;
    call<RecordViewAnswer>('record_view', { project: slug, rec_id: rec, ...(job ? { job } : {}), ...(version.current && viewRef.current ? { since: version.current } : {}) })
      .then(
        async (v) => {
          if (n !== seq.current) return;
          setError(null);
          // No folder and no job known to this tab (a reload before the window opened): the workspace's open recording.
          if (v.state === 'missing' && !job && !looked.current) {
            looked.current = true;
            const o = await call<RecordOptionsAnswer>('record_options', { project: slug }).catch(() => null);
            if (o?.open && o.open.rec_id === rec) {
              startedJobs.set(rec, o.open.job);
              again.current = true;
              return;
            }
          }
          accept(v);
        },
        (e: unknown) => {
          if (n === seq.current && !(e instanceof CallError && e.error.code === 'cancelled')) setError(errorText(e));
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (again.current) {
          again.current = false;
          load();
        }
      });
  }, [slug, rec, accept]);
  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [load]);
  useEvents((e) => {
    if (recordEventAction(e, slug, rec)) load();
  });
  const state = view?.state;
  useEffect(() => {
    const every = state && LIVE_STATES.has(state) ? LIVE_POLL_MS : DONE_POLL_MS;
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, every);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state, load]);
  const resync = useCallback(() => {
    force.current = true;
    load();
  }, [load]);
  return [view, error, load, accept, resync];
}

function RecordingScreen({ slug, rec }: { slug: string; rec: string }) {
  const [v, error, reload, accept, resync] = useRecordView(slug, rec);
  const [cursor, setCursor] = useState<Cursor>({ at: 'end' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<RecordingUi['note']>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [status, setStatus] = useState('');
  const said = useRef<string>('');
  const state = v?.state;
  // The time left ticks while the window is open.
  useEffect(() => {
    if (state !== 'recording') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);
  // The one status line: said only when the state (or saved) changes.
  useEffect(() => {
    if (!v) return;
    const line = statusLine(v.state, v.saved !== null);
    if (line !== said.current) {
      said.current = line;
      setStatus(line);
    }
  }, [v]);
  // A cursor on a row that is gone (an insert removed, a click folded into its typing): back to the end.
  const rows = useMemo(() => new Set(v?.untrusted ? draftRows(v.untrusted).flatMap((s) => s.rows.map((r) => r.id)) : []), [v]);
  useEffect(() => {
    if (cursor.at === 'after' && v?.untrusted && !rows.has(cursor.row)) setCursor({ at: 'end' });
  }, [cursor, rows, v]);
  // A discard that is over: the screen says "discarded" — the note about it goes (review B-M5).
  useEffect(() => {
    if (discarding && state && !LIVE_STATES.has(state)) {
      setDiscarding(false);
      setNote(null);
    }
  }, [discarding, state]);
  const job = () => {
    const j = startedJobs.get(rec) ?? v?.job?.id;
    return j ? { job: j } : {};
  };
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const act: RecordingActions = {
    annotate: (change) =>
      void run(async () => {
        if (!v) return;
        try {
          const where = cursorRow(v.untrusted, cursor);
          const r = await call<{ rev: number; insert_id?: string; view: RecordViewAnswer }>('record_annotate', { project: slug, rec_id: rec, rev: v.rev, change });
          accept(r.view, true);
          setStatus(annotatedWords(change, change.op === 'insert' ? (where?.label ?? null) : null));
          // A hold or a wait added after a row: the cursor moves onto it (the next one goes right after it).
          if (change.op === 'insert' && cursor.at === 'after' && r.insert_id && (change.insert.kind === 'hold' || change.insert.kind === 'wait_for')) setCursor({ at: 'after', row: `i:${r.insert_id}` });
        } catch (e) {
          if (e instanceof CallError) setNote({ tone: 'warning', text: annotateErrorWords(e.status, e.error.code, e.error.message) });
          else setNote({ tone: 'danger', text: errorText(e) });
          // A stale revision: the server's view wins, whatever its revision.
          if (e instanceof CallError && e.status === 409) resync();
          else reload();
        }
      }),
    stop: () =>
      void run(async () => {
        try {
          const r = await call<{ action: string; view: RecordViewAnswer }>('record_stop', { project: slug, rec_id: rec, ...job() });
          accept(r.view, true);
          reload();
        } catch (e) {
          setNote({ tone: 'danger', text: errorText(e) });
        }
      }),
    discard: () =>
      void run(async () => {
        try {
          const r = await call<{ rec_id: string; state: 'discarded' | 'discarding' }>('record_discard', { project: slug, rec_id: rec, ...job() });
          if (r.state === 'discarding') {
            setDiscarding(true);
            setNote({ tone: 'info', text: 'Being discarded: the job is cancelled, and the recording is removed once it is over.' });
          }
          reload();
        } catch (e) {
          setNote({ tone: 'danger', text: errorText(e) });
        }
      }),
    save: (name) =>
      void run(async () => {
        if (!v) return;
        try {
          const r = await call<{ name: string; file: string }>('record_save', { project: slug, rec_id: rec, name, rev: v.rev, draft: v.draft_sha256 ?? '' });
          location.hash = hrefTo({ name: 'scenario', slug, scenario: r.name, tab: 'blocks' });
        } catch (e) {
          if (e instanceof CallError && e.status === 409 && /choose another name/.test(`${e.error.message} ${e.error.fix ?? ''}`)) {
            setTaken(name);
            return;
          }
          const issues = e instanceof CallError && Array.isArray(e.error.details?.issues) ? (e.error.details.issues as DraftIssue[]) : undefined;
          setNote({ tone: 'danger', text: e instanceof CallError ? annotateErrorWords(e.status, e.error.code, e.error.message) : errorText(e), ...(issues ? { issues } : {}) });
          reload();
        }
      }),
    onSignedIn: reload,
  };
  return (
    <div className="screen rec-screen">
      <Breadcrumb slug={slug} rec={rec} />
      <p className="sr-only" role="status" data-testid="record-status">
        {status}
      </p>
      {!v && !error && <Loading what="the recording" />}
      {error && !v && (
        <Notice tone="danger" role="alert" title="This recording cannot be read">
          <p className="pre-line">
            <Txt text={error} />
          </p>
        </Notice>
      )}
      {v && <RecordingBody slug={slug} v={v} cursor={cursor} setCursor={setCursor} ui={{ busy, note, taken, discarding: discarding && v.state !== 'discarded', now }} act={act} />}
    </div>
  );
}

export function RecordScreen({ slug, rec }: { slug: string; rec?: string }) {
  return rec ? <RecordingScreen key={rec} slug={slug} rec={rec} /> : <StartScreen slug={slug} />;
}
