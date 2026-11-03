/**
 * The Record screen (L4.8, R-UI-20 / 21 / 22; L5.11b: « Épure » 3b, R4-Record, R-UI-44 — on the kit, in the shell): the
 * control panel of the REAL browser window the worker opens on this Mac, full size — the person clicks through the
 * product there; nothing typed or clicked here reaches the window (no input is forwarded: BL-25). Two routes:
 *
 * - `#/p/<slug>/record` — the start form in the centre (`record_options`): location, page, persona (Selects), path and
 *   name (TextFields: no unsaved mark — nobody's work), the persona's stored session with its Sign in, the window note
 *   (a full-size window: the desktop layout is what the video films), the location's warnings, the recording already
 *   open in the workspace (one window at a time). Start (`record_start`: page and path only, the check replay always
 *   on) opens the recording's route, its title focused.
 * - `#/p/<slug>/record/<rec_id>` — one recording (`record_view`, read every 700 ms while it is live and the tab is
 *   visible, every 3 s once it is over, and at once on a `workspace {records}` or `jobs` event; `since` makes an
 *   unchanged read cheap). Centre: "Recording <name>", the state in a sentence, the time left, the window callout, the
 *   draft as step rows (page text through `Txt` only). A row is a pressed button: pressing it puts the draft cursor right
 *   after it (keyed by the row's identity, never its index — it stays on its row while the draft regenerates and moves
 *   onto a hold or a wait it adds), shows the row's verified target alternatives as a radio group (`record_annotate
 *   choose`) and the Insert toolbar "Insert after step n" (Hold 2 s, Wait for…, Caption…, Mark, Zoom… up to the theme's
 *   max_zoom: `record_annotate insert`; at the end, a hold or a wait goes before the next action and the rest waits for
 *   it — critique B3 of L4.8); pressing it again (or Back to the end) moves the cursor back to the end. Inspector:
 *   Started with (its facts, the name Save uses), the selected step (its facts, Add after this step), Stop recording /
 *   Save as new scenario (with why it waits) / Discard (the kit's sheet: "Keep it" is the default, Return never
 *   discards), then the check (a replay of the recorded draft without the picks and inserts, its failing step shown on
 *   its row), the issues, the secret placeholders as `{{vars.…}}` names only (never a value), the writes with the reset
 *   advice. Browser: Shoot's, with the Recordings group (ShootBrowser). Recordings Claude or a terminal started are
 *   shown read-only (Q5).
 * - The status bar while a recording is live (queued → check): this screen's — "Recording · browser window open",
 *   "n actions · n inserts · draft updated …" — and the Scenario menu's commands at the recording's priority
 *   (command-bus.ts PRIORITY.recording, from the first paint of the route: a reload included): ⌘. stops THIS recording
 *   (never a run of the scenario in context — critique H1 / M7 of L5.11), Rehearse / Capture / Render say why they wait
 *   and send nothing (critique L2). The one Stop visible is the inspector's (shown in place when the inspector is hidden).
 *
 * Accessibility: every control is a kit button, field or radio group; the insert forms are disclosures (Enter adds,
 * Escape closes and gives focus back); the cursor is a block with words, never only a colour; the steps are a list, not
 * a live region — state changes and each change made ("Hold added after step 2 of products") are said in the status
 * bar's polite line (shell/say.ts); severities are words with a glyph; the focus is never dropped (a control that goes or
 * turns disabled under it hands the focus to its replacement, else to the title).
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FocusEvent as ReactFocusEvent, FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { DraftIssue, DraftSource, RecordAnnotationChange, RecordInsert, RecordInsertAt, StepBlock } from '@retake/core';
import type { RecordListItem, RecordState } from '@retake/engine';
import type { RecordEnvironmentOption, RecordOptionsAnswer, RecordStartAnswer, RecordViewAnswer } from '../server/record-ops.js';
import { CallError, call, errorText, useCall } from './api.js';
import { Txt, When, plural, shown, visibleControls } from './bits.js';
import { recordEventAction, useEvents } from './events.js';
import { useProjectView } from './project-data.js';
import { hrefTo } from './route.js';
import { useRunLocation } from './run-location.js';
import { SignIn, StoredState } from './Sessions.js';
import { stepWords } from './scenario-words.js';
import { PRIORITY, useScenarioGroup, useShellCommand } from './shell/command-bus.js';
import { contextWatch, scenarioInContext } from './shell/modes.js';
import { say } from './shell/say.js';
import { ShellSlot, SlotContext } from './shell/slots.js';
import { useScenarioActions } from './shoot-data.js';
import { gridMove } from './board-keys.js';
import { RECORD_MARK, ShootBrowser, recordStateWord } from './ShootBrowser.js';
import type { ShootRecordings } from './ShootBrowser.js';
import { Button, Callout, Disclosure, Facts, InspectorSection, LinkButton, RadioGroup, RowCard, RowList, RowListItem, Select, Sheet, StatusMark, TerminalCommands, TextField, Toolbar, studioShell } from './ui-kit/index.js';
import type { MarkState } from './ui-kit/index.js';
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
  saveWhyWords,
  startedByWords,
  stateSentence,
  statusLine,
  textProblem,
  timeLeft,
  writesWords,
} from './record-words.js';

/** record_start's job per recording, for this tab: the view needs it until the recording's folder exists. */
const startedJobs = new Map<string, string>();
/** A recording just started from this tab: its title takes the focus when its route opens (the Start button is gone). */
const focusOnArrival = new Set<string>();

function StateMark({ state }: { state: RecordState }) {
  return (
    <span className="rc-state-mark" data-testid="record-state" data-state={state}>
      <StatusMark state={RECORD_MARK[state] ?? 'idle'} word={recordStateWord(state)} />
    </span>
  );
}

/** A note's tone as a mark. */
const TONE_MARK: Record<'info' | 'warning' | 'danger', MarkState> = { info: 'idle', warning: 'warn', danger: 'fail' };

/** "just now", "12 s ago", "3 min ago". */
function agoWords(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  return `${Math.floor(s / 60)} min ago`;
}

/** The scenario in context on a Record route (the project's last one opened in this tab), for Shoot's browser. */
function useContextScenario(slug: string): string | null {
  useSyncExternalStore(contextWatch.subscribe, contextWatch.version);
  const project = useProjectView(slug);
  const known = project.state === 'ready' ? project.data.scenarios : undefined;
  return scenarioInContext({ name: 'record', slug }, undefined, known)?.scenario ?? null;
}

/** Shoot's browser on a Record route: Prepare and the runs of the scenario in context (the status bar's shared read), the Recordings. */
function RecordBrowser({ slug, recordings }: { slug: string; recordings: ShootRecordings }) {
  const name = useContextScenario(slug);
  const project = useProjectView(slug);
  const envs = project.state === 'ready' ? project.data.environments : null;
  const loc = useRunLocation(slug, name, envs);
  const read = useScenarioActions(name !== null && loc.ready ? slug : null, name, loc.sent);
  return (
    <ShellSlot name="browser">
      <ShootBrowser slug={slug} name={name} runs={read.state === 'ready' ? read.data.runs : null} current={null} recordings={recordings} />
    </ShellSlot>
  );
}

// ── The start form ──────────────────────────────────────────────────────────

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
    call<RecordStartAnswer>('record_start', { project: slug, env: env.name, page, path, persona, name })
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

function StartScreen({ slug }: { slug: string }) {
  const [o, reload] = useCall<RecordOptionsAnswer>('record_options', { project: slug }, slug);
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

// ── One recording ───────────────────────────────────────────────────────────

/**
 * Where the next insert goes: after the newest event (the default; it follows new actions), or right after one row —
 * by the row's identity (DraftSource.row), never its index: the line stays on that row while the draft regenerates.
 * The row the cursor is after is the selected row (its alternatives, the inspector's step).
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
  /** Open or close the Discard sheet (its answer is the screen's: the palette's Discard… opens it too). */
  confirm: (open: boolean) => void;
}

export interface RecordingUi {
  busy: boolean;
  /** The last action's refusal or result, in words. */
  note: { tone: 'info' | 'warning' | 'danger'; text: string; issues?: DraftIssue[]; fix?: string } | null;
  /** Save's refusal for a taken name. */
  taken: string | null;
  discarding: boolean;
  /** The Discard sheet is open. */
  confirming: boolean;
  now: number;
  /** In the desktop app: the key caps shown (⌘.). */
  inApp?: boolean;
}

/** The row the cursor is on (by its identity), with its words and the anchor an insert there gets; null at the end. */
export function cursorRow(u: Untrusted | null, cursor: Cursor): { label: string; at: RecordInsertAt } | null {
  if (cursor.at !== 'after' || !u) return null;
  for (const s of draftRows(u)) {
    for (const r of s.rows) if (r.source && r.id === cursor.row) return { label: stepWords(s.scene, r.step.index), at: insertAnchor(r.source) };
  }
  return null;
}

/** The selected row itself (the inspector's step), or null. */
function selectedRow(u: Untrusted | null, cursor: Cursor): { row: DraftRow; scene: { scene: string; page?: string; open?: string } } | null {
  if (cursor.at !== 'after' || !u) return null;
  for (const s of draftRows(u)) for (const r of s.rows) if (r.source && r.id === cursor.row) return { row: r, scene: s };
  return null;
}

/** Which target a row shows as chosen (critique B1 of L4.8: a pick made on an earlier press of the same target is the one in effect). */
function chosenOf(row: DraftRow): { checked: number; picked: boolean } {
  const alt = row.alt!;
  const earlier = row.source?.chosen !== undefined && row.source.chosen.seq !== alt.seq && row.source.chosen.index > 0;
  const checked = alt.chosen > 0 || !earlier ? alt.chosen : (alt.options.find((o) => o.words === row.step.target)?.index ?? -1);
  return { checked, picked: alt.chosen > 0 || earlier };
}

/** The recording's header: its name, the state in a sentence, the time left. */
function RecordingHead({ v, now, titleRef, stop }: { v: RecordViewAnswer; now: number; titleRef?: RefObject<HTMLHeadingElement | null>; /** The one Stop, here while the inspector is hidden (review B-L4). */ stop?: ReactNode }) {
  const left = v.state === 'recording' ? timeLeft(v.ends_at, now) : null;
  return (
    <header className="rc-head">
      <div className="rc-head-text">
        <h1 className="sc-h1" tabIndex={-1} ref={titleRef} data-testid="record-title">
          Recording{v.name ? ' ' : ''}
          {v.name && <Txt className="k-mono" text={v.name} />}
        </h1>
        {v.state === 'recording' ? (
          <p className="sc-quiet">Every click in the browser window becomes a step here.</p>
        ) : (
          <p className="sc-quiet" data-testid="record-sentence">
            {shown(stateSentence(v.state))}
          </p>
        )}
      </div>
      {(left || stop) && (
        <div className="rc-head-side">
          {left && (
            <span className="rc-time k-mono" data-testid="record-time-left" title="Stops by itself then">
              {shown(left)}
            </span>
          )}
          {shown(stop)}
        </div>
      )}
    </header>
  );
}

function InsertChip({ i, can, onRemove, where }: { i: RecordInsert; can: boolean; onRemove: (id: string) => void; where: string }) {
  const text = insertText(i);
  return (
    <span className="rc-chip" data-testid="record-insert-chip" data-kind={i.kind}>
      <span className="rc-chip-text">
        <span className="rc-by">added by you</span> {shown(insertWords(i))}
        {text !== null && (
          <>
            {': '}
            <Txt text={text} />
          </>
        )}
      </span>
      {can && (
        <Button size="sm" variant="ghost" aria-label={visibleControls(`Remove the ${INSERT_KIND_WORDS[i.kind].toLowerCase()} ${where}`)} data-testid="record-insert-remove" onClick={() => onRemove(i.id)}>
          Remove
        </Button>
      )}
    </span>
  );
}

/** A row's words: the step's own label and target, what made it, its alternatives. */
function rowParts(r: DraftRow, can: boolean): { title: ReactNode; meta: ReactNode; aside: ReactNode } {
  const role = r.source?.role;
  const title = (
    <>
      <Txt className="rc-row-label" text={r.step.label} />
      {r.step.target && (
        <>
          {' '}
          <Txt className="rc-row-target" text={r.step.target} />
        </>
      )}
    </>
  );
  const notes: ReactNode[] = [];
  if (role === 'helper') notes.push(<span key="by">added by the recorder</span>);
  if (role === 'insert') notes.push(<span key="by">added by you</span>);
  if (r.step.summary) notes.push(<Txt key="sum" text={r.step.summary} />);
  for (const [i, c] of r.step.chips.entries()) notes.push(<Txt key={`c${i}`} text={c.label} />);
  const meta = notes.length ? notes.flatMap((n, i) => (i ? [<span key={`s${i}`}>{' · '}</span>, n] : [n])) : null;
  let aside: ReactNode = null;
  if (can && r.alt && r.alt.options.length > 1) {
    const c = chosenOf(r);
    aside = c.picked ? 'Target picked by you' : plural(r.alt.options.length - 1, 'alternative');
  }
  return { title, meta, aside };
}

/**
 * The selected row's verified target alternatives as a radio group (index 0: the recorder's suggestion). L5.11b fixes
 * (review A-M1): the radio shows the choice asked for at once (`want`) while it is saved — an arrow press checks the
 * radio it lands on, and the screen sends the newest pick when the one in flight ends (never two in flight, never
 * refused) —, then the view's choice again once it says the same or nothing is pending any more (a refusal).
 */
function Alternatives({ row, n, onChoose, pending }: { row: DraftRow; n: number; onChoose: (seq: number, index: number) => void; pending: boolean }) {
  const alt = row.alt!;
  const c = chosenOf(row);
  const [want, setWant] = useState<number | null>(null);
  useEffect(() => {
    if (want !== null && (c.checked === want || !pending)) setWant(null);
  }, [want, c.checked, pending]);
  return (
    <div className="rc-alts" data-testid="record-alternatives">
      <p className="rc-alts-state" data-testid="record-alt-state">
        {shown(c.picked ? 'Target picked by you' : `The recorder’s suggestion · ${plural(alt.options.length - 1, 'other target')} verified on the page`)}
      </p>
      <RadioGroup
        legend={`Ways to find step ${n}`}
        value={String(want ?? c.checked)}
        onChange={(v) => {
          setWant(Number(v));
          onChoose(alt.seq, Number(v));
        }}
        options={alt.options.map((o) => ({
          value: String(o.index),
          label: <Txt className="rc-alt-words" text={o.words} />,
          ...(o.index === 0 ? { aside: 'Suggested' } : {}),
          ...(o.fragile.length > 0 ? { detail: fragileWords(o.fragile).join('; ') } : {}),
          testId: 'record-alternative',
        }))}
      />
      {c.checked === -1 && want === null && <p className="sc-quiet">Picked on an earlier press of this target; choose here to change it.</p>}
    </div>
  );
}

type InsertForm = 'wait' | 'caption' | 'zoom';

/**
 * The open insert form and what is typed in it. L5.11b fixes (review A-L7 / B-L3): held by the recording's body, not by
 * the cursor block — the block moves (the first row arrives, a new scene starts, a row before it changes) and the form
 * keeps its text; the focus keeper puts the focus back on the field by its test id. `focus`: the form was just opened
 * (its first field takes the focus once; a block mounted again never takes it).
 */
export interface InsertFormState {
  open: InsertForm | null;
  until: 'next_target' | 'idle' | 'text';
  waitText: string;
  caption: string;
  kicker: string;
  /** The zoom factor chosen (null: the theme's default). */
  factor: string | null;
  problem: string | null;
  focus: boolean;
}

export const NO_INSERT_FORM: InsertFormState = { open: null, until: 'next_target', waitText: '', caption: '', kicker: '', factor: null, problem: null, focus: false };

/** The Insert toolbar at the cursor (`where`: the cursor's row, null at the end) and the open insert form. */
function Inserts({
  where,
  zoom,
  setCursor,
  act,
  live,
  form,
  setForm,
}: {
  where: { label: string; at: RecordInsertAt } | null;
  zoom: RecordViewAnswer['zoom'];
  setCursor: (c: Cursor) => void;
  act: RecordingActions;
  live: boolean;
  form: InsertFormState;
  setForm: (f: (was: InsertFormState) => InsertFormState) => void;
}) {
  const at: RecordInsertAt = where ? where.at : 'end';
  const add = (insert: Extract<RecordAnnotationChange, { op: 'insert' }>['insert']) => act.annotate({ op: 'insert', at, insert });
  const open = form.open;
  const set = (patch: Partial<InsertFormState>) => setForm((f) => ({ ...f, ...patch }));
  const formRef = useRef<HTMLFormElement>(null);
  const opener = (f: InsertForm) => document.querySelector<HTMLElement>(`[data-testid="record-insert-${f}"]`);
  const close = () => {
    const was = open;
    set({ open: null, problem: null, focus: false });
    if (was) opener(was)?.focus();
  };
  useEffect(() => {
    if (!open || !form.focus) return;
    formRef.current?.querySelector<HTMLElement>('input:checked, input[type="text"], input, textarea')?.focus();
    set({ focus: false });
  }, [open, form.focus]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const factor = form.factor ?? String(zoom?.default ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (open === 'wait') {
      const p = form.until === 'text' ? textProblem(form.waitText, WAIT_TEXT_MAX) : null;
      set({ problem: p });
      if (p) return;
      add(form.until === 'text' ? { kind: 'wait_for', until: form.until, text: form.waitText } : { kind: 'wait_for', until: form.until });
      set({ waitText: '' });
    } else if (open === 'caption') {
      const p = textProblem(form.caption, CAPTION_MAX) ?? (form.kicker ? textProblem(form.kicker, KICKER_MAX) : null);
      set({ problem: p });
      if (p) return;
      add({ kind: 'caption', text: form.caption, ...(form.kicker ? { kicker: form.kicker } : {}) });
      set({ caption: '', kicker: '' });
    } else if (open === 'zoom' && zoom) {
      add({ kind: 'camera', zoom: Number(factor), until: 'scene_end' });
    }
    close();
  };
  const label = where ? `Insert after ${where.label}` : 'Insert at the end';
  const toggle = (f: InsertForm) => setForm((was) => ({ ...was, problem: null, open: was.open === f ? null : f, focus: was.open !== f }));
  return (
    <div className="rc-insert" data-testid="record-inserts">
      <p className="rc-insert-where" data-testid="record-cursor-where">
        {where ? (
          <>
            {'Insert after '}
            <Txt text={where.label} />
          </>
        ) : (
          shown(live ? 'Insert at the end — a hold or a wait goes before your next action; a caption, a mark or a zoom goes on it.' : 'Insert at the end — a hold or a wait goes after the last step; a caption, a mark or a zoom goes on it.')
        )}
      </p>
      <Toolbar label={visibleControls(label)}>
        <Button size="sm" data-testid="record-insert-hold" onClick={() => add({ kind: 'hold', seconds: HOLD_DEFAULT_S })}>
          {shown(`Hold ${HOLD_DEFAULT_S} s`)}
        </Button>
        <Button size="sm" data-testid="record-insert-wait" aria-expanded={open === 'wait'} onClick={() => toggle('wait')}>
          Wait for…
        </Button>
        <Button size="sm" data-testid="record-insert-caption" aria-expanded={open === 'caption'} onClick={() => toggle('caption')}>
          Caption…
        </Button>
        <Button size="sm" data-testid="record-insert-mark" onClick={() => add({ kind: 'mark' })}>
          Mark
        </Button>
        {zoom && (
          <Button size="sm" data-testid="record-insert-zoom" aria-expanded={open === 'zoom'} onClick={() => toggle('zoom')}>
            Zoom…
          </Button>
        )}
        {where && (
          <Button size="sm" variant="ghost" data-testid="record-cursor-end" onClick={() => setCursor({ at: 'end' })}>
            Back to the end
          </Button>
        )}
      </Toolbar>
      {open && (
        <form ref={formRef} className="rc-insert-form" onKeyDown={onKey} onSubmit={submit} aria-label={open === 'wait' ? 'Wait for' : open === 'caption' ? 'Caption' : 'Zoom'}>
          {open === 'wait' && (
            <>
              <RadioGroup
                legend="Wait until"
                value={form.until}
                onChange={(v) => set({ until: v as InsertFormState['until'] })}
                options={[
                  { value: 'next_target', label: 'the next target shows', testId: 'record-wait-until' },
                  { value: 'idle', label: 'the page is idle', testId: 'record-wait-until' },
                  { value: 'text', label: 'a text shows', testId: 'record-wait-until' },
                ]}
              />
              {form.until === 'text' && <TextField label="Text" testId="record-wait-text" value={form.waitText} onChange={(t) => set({ waitText: t })} unsaved={null} maxLength={WAIT_TEXT_MAX} />}
            </>
          )}
          {open === 'caption' && (
            <>
              <TextField label="Caption" testId="record-caption-text" value={form.caption} onChange={(t) => set({ caption: t })} unsaved={null} maxLength={CAPTION_MAX} />
              <TextField label="Kicker (optional)" testId="record-caption-kicker" value={form.kicker} onChange={(t) => set({ kicker: t })} unsaved={null} maxLength={KICKER_MAX} />
            </>
          )}
          {open === 'zoom' && zoom && (
            <>
              <RadioGroup
                legend="Zoom factor"
                value={factor}
                onChange={(f) => set({ factor: f })}
                options={zoom.options.map((f) => ({ value: String(f), label: `${f}×`, ...(f === zoom.max ? { aside: 'the theme’s maximum' } : {}), testId: 'record-zoom-factor' }))}
              />
              <p className="sc-quiet">{shown(`Zoom goes up to the theme’s maximum, ${zoom.max}×; it holds until the scene ends.`)}</p>
            </>
          )}
          {form.problem && (
            <p className="rc-error" role="alert">
              {shown(form.problem)}
            </p>
          )}
          <div className="rc-form-act">
            <Button size="sm" variant="primary" submit data-testid={open === 'wait' ? 'record-wait-add' : open === 'caption' ? 'record-caption-add' : 'record-zoom-add'}>
              {open === 'wait' ? 'Add the wait' : open === 'caption' ? 'Add the caption' : 'Add the zoom'}
            </Button>
            <Button size="sm" variant="ghost" data-testid="record-insert-close" onClick={close}>
              Close
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** The words of a row's modifiers (a caption, a mark, a zoom on it): text in the row; their Remove is in the cursor block. */
function modifierChips(r: DraftRow): ReactNode[] {
  return r.modifiers.map((m) => <InsertChip key={m.id} i={m} can={false} onRemove={() => undefined} where="" />);
}

/**
 * One draft row. Editable (L5.11b fixes, review A-M2): an option of its scene's listbox — the list holds the tab stop and
 * the keys; pressing a row (a click, Enter or Space on the active one) puts the cursor after it. Read-only: a list item.
 */
function Row({ r, n, here, option, onPress }: { r: DraftRow; n: number; here: boolean; option: { id: string; active: boolean } | null; onPress: () => void }) {
  const role = r.source?.role;
  const parts = rowParts(r, option !== null);
  const chips = modifierChips(r);
  const meta = chips.length ? (
    <>
      {shown(parts.meta)}
      {parts.meta ? ' · ' : null}
      {shown(chips)}
    </>
  ) : (
    parts.meta
  );
  return (
    <RowListItem className={['rc-row', role === 'insert' ? 'is-insert' : '', role === 'helper' ? 'is-helper' : ''].filter(Boolean).join(' ')} testId="record-step" data={{ key: r.key, row: r.id, role: role ?? '', helper: r.source?.helper ?? '' }}>
      {option ? (
        <RowCard compact option={option} tile={String(n)} title={parts.title} meta={meta} aside={parts.aside} selected={here} onSelect={onPress} testId="record-insert-after" />
      ) : (
        <div className="rc-row-static">
          <span className="rc-row-n">{shown(String(n))}</span>
          <span className="rc-row-text">
            <span className="rc-row-title">{shown(parts.title)}</span>
            {meta && <span className="rc-row-meta">{shown(meta)}</span>}
          </span>
        </div>
      )}
    </RowListItem>
  );
}

/** The selected row's own inserts, each with its Remove (an insert row, the modifiers on a row). */
function RowRemoves({ r, where, onRemove }: { r: DraftRow; where: string; onRemove: (id: string) => void }) {
  if (!r.insert && r.modifiers.length === 0) return null;
  return (
    <p className="rc-chips rc-removes" data-testid="record-removes">
      {r.insert && (
        <Button size="sm" variant="ghost" aria-label={visibleControls(`Remove the ${INSERT_KIND_WORDS[r.insert.kind].toLowerCase()} at ${where}`)} data-testid="record-insert-remove" onClick={() => onRemove(r.insert!.id)}>
          {shown(`Remove the ${INSERT_KIND_WORDS[r.insert.kind].toLowerCase()}`)}
        </Button>
      )}
      {r.modifiers.map((m) => (
        <InsertChip key={m.id} i={m} can onRemove={onRemove} where={`on ${where}`} />
      ))}
    </p>
  );
}

/** The flat order of the draft's rows (the listboxes' keys walk it across scenes). */
interface FlatRow {
  r: DraftRow;
  si: number;
  ri: number;
}

/**
 * The draft's step rows with the cursor block (the selected row's inserts, alternatives and Insert toolbar) among them.
 * L5.11b fixes (review A-M2 / A-L3 / A-L7): editable, each scene's rows are a listbox and the draft is ONE tab stop (the
 * list holding the active row; `aria-activedescendant`): ↑ / ↓ the row before / after (across scenes), Home / End the
 * first / last, Page Up / Page Down three rows (board-keys' `gridMove`, one column), Enter / Space selects the active row
 * (= moves the cursor after it; again: back to the end). The cursor block is not an option (a group inside the list,
 * after its row); at the end it is after every scene, in one place — new rows never move it.
 */
function DraftList({
  v,
  cursor,
  setCursor,
  act,
  busy,
  form,
  setForm,
}: {
  v: RecordViewAnswer;
  cursor: Cursor;
  setCursor: (c: Cursor) => void;
  act: RecordingActions;
  busy: boolean;
  form: InsertFormState;
  setForm: (f: (was: InsertFormState) => InsertFormState) => void;
}) {
  const u = v.untrusted!;
  const scenes = draftRows(u);
  const can = v.can.annotate;
  const live = LIVE_STATES.has(v.state);
  const inserts = new Map(u.inserts.map((i) => [i.id, i]));
  const remove = (id: string) => act.annotate({ op: 'remove', id });
  const choose = (seq: number, index: number) => act.annotate({ op: 'choose', seq, index });
  const where = cursorRow(u, cursor);
  const flat: FlatRow[] = scenes.flatMap((s, si) => s.rows.map((r, ri) => ({ r, si, ri })));
  const selected = cursor.at === 'after' ? cursor.row : null;
  const [activeId, setActiveId] = useState<string | null>(null);
  const found = (id: string | null) => (id === null ? -1 : flat.findIndex((f) => f.r.id === id));
  const activeAt = found(activeId) >= 0 ? found(activeId) : found(selected) >= 0 ? found(selected) : flat.length ? 0 : -1;
  const active = activeAt >= 0 ? flat[activeAt] : undefined;
  const optId = (i: number) => `rec-opt-${i}`;
  // A key moved the active row: its list takes the focus (it may be another scene's) and the row shows.
  const follow = useRef(false);
  useLayoutEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    const opt = document.getElementById(optId(activeAt));
    const list = opt?.closest<HTMLElement>('[role="listbox"]');
    if (list && document.activeElement !== list) list.focus({ preventScroll: true });
    opt?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  });
  const press = (r: DraftRow) => {
    if (!r.source) return;
    setActiveId(r.id);
    setCursor(selected === r.id ? { at: 'end' } : { at: 'after', row: r.id });
  };
  const counts = scenes.map((s) => s.rows.length);
  const onKey = (e: KeyboardEvent<HTMLOListElement>) => {
    // Keys of the cursor block's own controls (inside the list) are theirs.
    if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey || !active) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) press(active.r);
      return;
    }
    const to = gridMove(counts, { scene: active.si, index: active.ri }, e.key, 1);
    if (!to) return;
    e.preventDefault();
    const next = scenes[to.scene]?.rows[to.index];
    if (!next) return;
    follow.current = true;
    setActiveId(next.id);
  };
  // A list taking the focus with the active row elsewhere (a click in its gaps): its first row is the active one.
  const onListFocus = (e: ReactFocusEvent<HTMLOListElement>, si: number) => {
    if (e.target !== e.currentTarget || !active || active.si === si) return;
    const first = scenes[si]?.rows[0];
    if (first) setActiveId(first.id);
  };
  const block = (row: DraftRow | null, n: number, scene: string) => (
    <div className="rc-here" role="group" aria-label={row ? `Inserts go after step ${n}` : 'Inserts go here: at the end'} data-testid="record-cursor">
      {row && <RowRemoves r={row} where={stepWords(scene, row.step.index)} onRemove={remove} />}
      {row && row.alt && row.alt.options.length > 1 && <Alternatives row={row} n={n} onChoose={choose} pending={busy} />}
      <Inserts where={where} zoom={v.zoom} setCursor={setCursor} act={act} live={live} form={form} setForm={setForm} />
    </div>
  );
  const waiting = v.state === 'recording' && (
    <p className="rc-waiting" data-testid="record-waiting">
      <StatusMark state="recording" word="Waiting for your next action in the browser…" />
    </p>
  );
  const empty = flat.length === 0;
  let i = -1;
  return (
    <div className="rc-draft" data-testid={empty ? 'record-draft-empty' : 'record-draft'}>
      {empty && (
        <p className="sc-quiet" data-testid="record-no-steps">
          {shown(live ? 'No step yet: click in the window — each action becomes a step here.' : 'The draft has no step.')}
        </p>
      )}
      {scenes.map((s, si) =>
        s.rows.length === 0 ? null : (
          <section key={`${s.scene}-${si}`} className="rc-scene" aria-labelledby={`rec-scene-${si}`}>
            <h3 id={`rec-scene-${si}`} className="rc-scene-title">
              {shown(`Scene ${si + 1}: `)}
              <Txt className="k-mono" text={s.scene} />
              {s.page && (
                <span className="rc-quiet">
                  {' · '}
                  <Txt text={s.page} />
                  {s.open && (
                    <>
                      {' '}
                      <Txt className="k-mono" text={s.open} />
                    </>
                  )}
                </span>
              )}
            </h3>
            {can ? (
              <RowList
                className="rc-rows"
                labelledBy={`rec-scene-${si}`}
                testId="record-rows"
                listbox={{ ...(active?.si === si ? { activeId: optId(activeAt) } : {}), tabbable: active?.si === si, onKeyDown: onKey, onFocus: (e) => onListFocus(e, si) }}
              >
                {s.rows.map((r) => {
                  i++;
                  const n = r.step.index + 1;
                  const here = selected !== null && !!r.source && selected === r.id;
                  return (
                    <RowPair key={r.id} here={here} block={<RowListItem>{shown(block(r, n, s.scene))}</RowListItem>}>
                      <Row r={r} n={n} here={here} option={{ id: optId(i), active: i === activeAt }} onPress={() => press(r)} />
                    </RowPair>
                  );
                })}
              </RowList>
            ) : (
              <RowList className="rc-rows" labelledBy={`rec-scene-${si}`}>
                {s.rows.map((r) => (
                  <Row key={r.id} r={r} n={r.step.index + 1} here={false} option={null} onPress={() => undefined} />
                ))}
              </RowList>
            )}
          </section>
        ),
      )}
      {can && cursor.at === 'end' && shown(block(null, 0, ''))}
      {u.pending.length > 0 && (
        <div className="rc-pending" data-testid="record-pending">
          <p>Applies to your next action:</p>
          <p className="rc-chips">
            {u.pending.flatMap((id) => (inserts.has(id) ? [inserts.get(id)!] : [])).map((ins) => (
              <InsertChip key={ins.id} i={ins} can={can} onRemove={remove} where="waiting for your next action" />
            ))}
          </p>
        </div>
      )}
      {shown(waiting)}
    </div>
  );
}

function RowPair({ here, block, children }: { here: boolean; block: ReactNode; children: ReactNode }) {
  return (
    <>
      {shown(children)}
      {here && shown(block)}
    </>
  );
}

/** The job's error: a preflight refusal (a persona not signed in) offers Sign in; anything else says it with its command. */
function JobError({ v, slug, onSignedIn }: { v: RecordViewAnswer; slug: string; onSignedIn: () => void }) {
  const e = v.job?.error;
  // A cancel the Studio asked for (Stop before the window, Discard) is not an error: the state says it.
  if (!e || (v.state !== 'failed' && v.state !== 'cancelled') || e.code === 'cancelled') return null;
  const sign = preflightSignIn(v);
  return (
    <Callout state="fail" role="note" title={sign ? 'Failed: the persona is not signed in' : 'Failed: the recording did not finish'}>
      <p className="rc-pre" data-testid="record-job-error" data-code={e.code}>
        <Txt text={e.message} />
      </p>
      {sign ? (
        <div className="rc-sign-in" data-testid="record-sign-in">
          <p>
            Sign <Txt text={sign.persona} /> in (a window where you sign in yourself), then record again.
          </p>
          <SignIn slug={slug} persona={sign.persona} env={sign.env} onDone={onSignedIn} />
          <p>
            <LinkButton size="sm" variant="ghost" to={{ name: 'record', slug }}>
              Record again
            </LinkButton>
          </p>
        </div>
      ) : (
        <TerminalCommands {...(e.fix ? { fix: e.fix } : {})} />
      )}
    </Callout>
  );
}

/** The last action's refusal or result: an info note is a status (polite), a warning or a failure an alert (L5.11b fixes, review A-L5). */
function NoteCallout({ note }: { note: NonNullable<RecordingUi['note']> }) {
  const body = (
    <>
      <p className="rc-pre" data-testid="record-note">
        <Txt text={note.text} />
      </p>
      {note.issues && note.issues.length > 0 && (
        <ul className="rc-list">
          {note.issues.map((i, n) => (
            <li key={n}>
              {i.scene !== undefined && <Txt text={`${i.step !== undefined ? stepWords(i.scene, i.step) : `scene ${i.scene}`}: `} />}
              <Txt text={i.message} />
            </li>
          ))}
        </ul>
      )}
      <TerminalCommands {...(note.fix ? { fix: note.fix } : {})} />
    </>
  );
  return note.tone === 'info' ? (
    <Callout state={TONE_MARK.info} role="status" title="Note">
      {shown(body)}
    </Callout>
  ) : (
    <Callout state={TONE_MARK[note.tone]} role="alert" title={note.tone === 'warning' ? 'Warning: not done' : 'Failed'}>
      {shown(body)}
    </Callout>
  );
}

/** One recording as the view tells it — the centre, and the inspector in its slot (a test renders it with any view). */
export function RecordingBody({ slug, v, cursor, setCursor, ui, act, titleRef }: { slug: string; v: RecordViewAnswer; cursor: Cursor; setCursor: (c: Cursor) => void; ui: RecordingUi; act: RecordingActions; titleRef?: RefObject<HTMLHeadingElement | null> }) {
  const u = v.untrusted;
  const live = LIVE_STATES.has(v.state);
  const readOnly = v.started_by !== 'ui' && v.started_by !== null && v.state !== 'missing';
  // Held here, not in the inspector or the cursor block (L5.11b fixes, review B-L4 / A-L7): hiding or showing the
  // inspector (it moves between its pane and the centre: React mounts it again) and a cursor block that moves keep what
  // was typed — the Name Save uses (the view's until it is edited), the open insert form.
  const [edited, setName] = useState<string | null>(null);
  const name = edited ?? v.name ?? '';
  const [form, setForm] = useState<InsertFormState>(NO_INSERT_FORM);
  // L5.11b fixes (review B-L4): with the inspector hidden, the one Stop is at the top of the centre, beside the time.
  const inspectorHidden = Boolean(useContext(SlotContext)?.hidden?.inspector);
  const stopAtHead = inspectorHidden && v.can.stop;
  return (
    <>
      <RecordingHead v={v} now={ui.now} {...(titleRef ? { titleRef } : {})} {...(stopAtHead ? { stop: <StopControl v={v} ui={ui} act={act} compact /> } : {})} />
      <p className="rc-state">
        <StateMark state={v.state} />
        <span className="rc-quiet" data-testid="record-counts">
          {shown(
            `${plural(v.counts.actions, 'action')}${u ? ` · ${plural(u.inserts.length, 'insert')}` : ''}${v.stats ? ` · ${plural(v.stats.steps, 'step')}` : ''}${v.counts.dropped_lines > 0 ? ` · ${plural(v.counts.dropped_lines, 'unreadable line')} left out` : ''}`,
          )}
        </span>
      </p>
      {v.state === 'recording' && (
        <Callout state="recording" role="note" title="Recording in the browser window" testId="record-window">
          <p data-testid="record-sentence">{shown(stateSentence(v.state))}</p>
        </Callout>
      )}
      {readOnly ? (
        <Callout state="idle" role="note" title="Read-only">
          <p data-testid="record-read-only">{v.problem ? <Txt text={v.problem} /> : shown(readOnlyWords(v.started_by))}</p>
        </Callout>
      ) : (
        v.problem && (
          <Callout state="warn" role="note" title="Note: about this draft">
            <p className="rc-pre" data-testid="record-problem">
              <Txt text={v.problem} />
            </p>
          </Callout>
        )
      )}
      {v.saved && (
        <Callout state="ok" role="note" title="Saved as a scenario">
          <p data-testid="record-saved">
            <Txt className="k-mono" text={v.saved.file} />
            {' — '}
            <a className="rc-link" href={hrefTo({ name: 'scenario', slug, scenario: v.saved.name, tab: 'blocks' })}>
              Open the scenario
            </a>
            {' · '}
            <a className="rc-link" href={hrefTo({ name: 'run', slug, scenario: v.saved.name })}>
              Rehearse it
            </a>
          </p>
        </Callout>
      )}
      {v.state === 'discarded' && (
        <p>
          <LinkButton to={{ name: 'record', slug }} testId="record-another">
            Record another scenario
          </LinkButton>
        </p>
      )}
      <JobError v={v} slug={slug} onSignedIn={act.onSignedIn} />
      {ui.note && <NoteCallout note={ui.note} />}
      {(u || live) && (
        <section className="rc-draft-section" aria-labelledby="rec-draft-h" data-testid="record-draft-section">
          <h2 id="rec-draft-h" className="sc-h2">
            The draft
          </h2>
          {u ? <DraftList v={v} cursor={cursor} setCursor={setCursor} act={act} busy={ui.busy} form={form} setForm={setForm} /> : <p className="sc-quiet">{shown(live ? 'The draft shows here once the window is open.' : 'No draft.')}</p>}
          {u && u.yaml_lines.length > 0 && (
            <Disclosure summary="The draft as YAML">
              <pre className="rc-yaml" data-testid="record-yaml">
                {u.yaml_lines.map((l, i) => (
                  <span key={i}>
                    <Txt text={l} />
                    {'\n'}
                  </span>
                ))}
              </pre>
            </Disclosure>
          )}
        </section>
      )}
      <ShellSlot name="inspector" inline="Recording">
        <RecordingInspector v={v} cursor={cursor} ui={ui} act={act} stopHere={!stopAtHead} name={name} setName={setName} />
      </ShellSlot>
      {/* The Discard sheet (outside the inspector: a modal dialog never moves with it). */}
      <Sheet
        open={ui.confirming && v.can.discard}
        destructive
        testId="record-discard-confirm"
        title="Discard this recording?"
        actions={[
          { id: 'keep', label: 'Keep it', isCancel: true, isDefault: true, testId: 'record-discard-keep' },
          { id: 'discard', label: 'Discard', variant: 'destructive', testId: 'record-discard-yes' },
        ]}
        onAction={(id) => {
          act.confirm(false);
          if (id === 'discard') act.discard();
        }}
      >
        {shown(`${live ? 'The window closes (or the check stops) and the recording' : 'The recording'} is removed: its events, its draft, your picks and inserts. A scenario saved from it is never touched.`)}
      </Sheet>
    </>
  );
}

/** Stop recording (Cancel recording before the window opens): the inspector's, or the head's while it is hidden. */
function StopControl({ v, ui, act, compact }: { v: RecordViewAnswer; ui: RecordingUi; act: RecordingActions; compact?: boolean }) {
  const beforeWindow = v.state === 'queued' || v.state === 'preflight';
  const stopping = Boolean(v.job?.stop_requested || v.job?.cancel_requested);
  const button = (
    <Button variant="record" recording data-testid="record-stop" disabled={stopping} kbd={ui.inApp ? ['⌘', '.'] : undefined} onClick={act.stop}>
      {stopping ? 'Stopping…' : beforeWindow ? 'Cancel recording' : 'Stop recording'}
    </Button>
  );
  if (compact) return button;
  return (
    <div className="rc-control">
      {shown(button)}
      <span className="sc-quiet">{shown(beforeWindow ? 'Nothing is recorded yet.' : 'The window closes as if you closed it; the draft is made, then checked.')}</span>
    </div>
  );
}

/** The inspector: Started with, the selected step, Stop / Save / Discard, the check, issues, placeholders, writes. */
function RecordingInspector({
  v,
  cursor,
  ui,
  act,
  stopHere,
  name,
  setName,
}: {
  v: RecordViewAnswer;
  cursor: Cursor;
  ui: RecordingUi;
  act: RecordingActions;
  /** The Stop is here (not at the head: the inspector shown). */
  stopHere: boolean;
  name: string;
  setName: (name: string) => void;
}) {
  const u = v.untrusted;
  const problem = nameProblem(name);
  const sel = selectedRow(u, cursor);
  const saveWhy = saveWhyWords(v, name, problem);
  // Enter in Name while Save cannot go says why (L5.11b fixes, review A-L4).
  const save = () => {
    if (saveWhy === null) act.save(name);
    else say(saveWhy);
  };
  const w = v.check ? checkWords(v.check) : null;
  const c = u?.check;
  const failedAt = checkFailedAt(c);
  const writes = writesWords(v.writes, v.access);
  const labels = u?.writes ?? [];
  const facts = [
    ...(v.env ? [{ key: 'env', label: 'Location', value: <Txt text={`${v.env}${v.access === 'read-only' ? ' · read-only' : ''}`} /> }] : []),
    ...(v.page ? [{ key: 'page', label: 'Page', value: <Txt text={v.page} /> }] : []),
    ...(v.page ? [{ key: 'path', label: 'Path', value: <Txt className="k-mono" text={v.path ?? '/'} /> }] : []),
    ...(v.persona !== null || v.started_at !== null ? [{ key: 'persona', label: 'Persona', value: v.persona ? <Txt text={v.persona} /> : 'Signed out' }] : []),
    { key: 'by', label: 'Started by', value: startedByWords(v.started_by) },
    ...(v.started_at ? [{ key: 'at', label: 'Started', value: <When iso={v.started_at} /> }] : []),
  ];
  return (
    <>
      <InspectorSection title="Started with" testId="record-started-with">
        <Facts rows={facts} label="Started with" />
        {v.can.annotate ? (
          <TextField
            label="Name"
            layout="row"
            mono
            testId="record-save-name"
            value={name}
            onChange={setName}
            unsaved={null}
            maxLength={NAME_MAX}
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
            {...(problem
              ? { error: problem }
              : ui.taken === name
                ? {
                    error: (
                      <span data-testid="record-save-taken" role="alert">
                        <Txt text={`scenarios/${name}.yaml exists: choose another name (a scenario is never overwritten from here).`} />
                      </span>
                    ),
                  }
                : { hint: 'Save writes a new file, scenarios/<name>.yaml — never an existing one.' })}
          />
        ) : (
          v.name && <Facts rows={[{ key: 'name', label: 'Name', value: <Txt className="k-mono" text={v.name} /> }]} />
        )}
      </InspectorSection>
      {sel && (
        <InspectorSection
          title={
            <>
              {shown(`Step ${sel.row.step.index + 1} · `)}
              <Txt text={sel.row.step.label} />
            </>
          }
          testId="record-step-inspector"
        >
          <Facts
            rows={[
              { key: 'scene', label: 'Scene', value: <Txt className="k-mono" text={sel.scene.scene} /> },
              ...(sel.row.step.target ? [{ key: 'target', label: 'Target', value: <Txt text={sel.row.step.target} /> }] : []),
              ...(sel.scene.page ? [{ key: 'page', label: 'Page', value: <Txt text={`${sel.scene.page}${sel.scene.open ? ` ${sel.scene.open}` : ''}`} /> }] : []),
              { key: 'made', label: 'Made by', value: sel.row.source?.role === 'insert' ? 'you (an insert)' : sel.row.source?.role === 'helper' ? 'the recorder' : 'your action in the window' },
              ...(sel.row.alt && sel.row.alt.options.length > 1 ? [{ key: 'pick', label: 'Way to find', value: chosenOf(sel.row).picked ? 'picked by you' : 'the recorder’s suggestion' }] : []),
            ]}
          />
          {v.can.annotate && (
            <p>
              <Button size="sm" data-testid="record-add-after" onClick={() => document.querySelector<HTMLElement>('[data-testid="record-inserts"] [role="toolbar"] button[tabindex="0"]')?.focus()}>
                Add after this step
              </Button>
            </p>
          )}
        </InspectorSection>
      )}
      {((v.can.stop && stopHere) || v.can.annotate || v.can.discard) && (
        <InspectorSection title={v.can.stop ? 'The window' : 'This recording'} testId="record-controls">
          {v.can.stop && stopHere && <StopControl v={v} ui={ui} act={act} />}
          {v.can.annotate && !v.saved && (
            <div className="rc-control">
              <Button variant="primary" data-testid="record-save" disabled={saveWhy !== null} aria-describedby="rec-save-why" onClick={save}>
                Save as new scenario
              </Button>
              <span id="rec-save-why" className="sc-quiet" data-testid="record-save-why">
                {shown(saveWhy ?? `It writes a new file, scenarios/${name}.yaml, then opens it.`)}
              </span>
            </div>
          )}
          {v.can.discard && (
            <div className="rc-control">
              <Button variant="destructive" data-testid="record-discard" disabled={ui.discarding} onClick={() => act.confirm(true)}>
                {ui.discarding ? 'Discarding…' : 'Discard'}
              </Button>
            </div>
          )}
        </InspectorSection>
      )}
      {v.check && w && (
        <InspectorSection title="Check" testId="record-check-section">
          <Callout state={v.check.status === 'passed' && w.tone === 'info' ? 'ok' : TONE_MARK[w.tone]} role="note" title={v.check.events_changed ? `Stale: ${w.title.charAt(0).toLowerCase()}${w.title.slice(1)}` : w.title}>
            <p data-testid="record-check" data-status={v.check.status}>
              {shown(w.detail)}
            </p>
            {failedAt && c?.failed_at && (
              <p data-testid="record-check-at" data-recorded={failedAt.recorded ? 'true' : 'false'}>
                {shown(failedAt.recorded ? 'At recorded ' : 'At ')}
                <Txt text={stepWords(failedAt.scene, failedAt.step)} />
                {' ('}
                <Txt text={c.failed_at.action} />
                {shown(failedAt.recorded ? ') — not a row on screen any more' : ')')}
              </p>
            )}
            {c?.error && (
              <p className="rc-pre rc-from-page">
                <span className="rc-quiet">From the page: </span>
                <Txt text={c.error} />
              </p>
            )}
          </Callout>
          <p className="sc-quiet">{shown(CHECK_SCOPE_NOTE)}</p>
        </InspectorSection>
      )}
      {u && u.issues.length > 0 && (
        <InspectorSection title={`To look at (${u.issues.length})`} testId="record-issues-section">
          <ul className="rc-list rc-issues" data-testid="record-issues">
            {u.issues.map((i, n) => (
              <li key={n} data-code={i.code}>
                <span className="rc-sev">{shown(SEVERITY_WORDS[i.severity][0])}</span>{' '}
                {i.scene !== undefined && (
                  <span className="rc-quiet">
                    <Txt text={i.step !== undefined ? stepWords(i.scene, i.step) : `scene ${i.scene}`} />
                    {': '}
                  </span>
                )}
                <Txt text={i.message} />
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {u && u.placeholders.length > 0 && (
        <InspectorSection title="Secret fields" testId="record-placeholders">
          <p>What was typed there is never kept or shown: the draft types a placeholder instead.</p>
          <ul className="rc-list">
            {u.placeholders.map((p, i) => (
              <li key={`${p.name}-${i}`}>
                <Txt className="k-mono" text={`{{vars.${p.name}}}`} /> {shown(PLACEHOLDER_WORDS[p.kind] ?? 'a secret')}
                {', '}
                <Txt text={stepWords(p.scene, p.step)} />
                {shown(p.project_var ? ' — project.yaml’s var of that name is used.' : ' — CHANGE-ME in the draft.')}
              </li>
            ))}
          </ul>
          <p className="sc-quiet">
            Put a showable demo value under <code className="k-mono">vars:</code> in project.yaml with that name (it is used at once), never the real one; or, once saved, put an{' '}
            <code className="k-mono">{'{{env:…}}'}</code> reference in the scenario in your editor (that scenario then runs from a terminal only).
          </p>
        </InspectorSection>
      )}
      {writes && (
        <InspectorSection title="Writes" testId="record-writes">
          <p>{shown(writes)}</p>
          {labels.length > 0 && (
            <>
              <p className="rc-quiet">From the page:</p>
              <ul className="rc-list">
                {labels.slice(0, 20).map((wr, i) => (
                  <li key={i}>
                    <Txt className="k-mono" text={wr.label} />
                    <span className="rc-quiet">{shown(` — ${wr.outcome}`)}</span>
                  </li>
                ))}
              </ul>
              {labels.length > 20 && <p className="sc-quiet">{shown(plural(labels.length - 20, 'more write'))}</p>}
            </>
          )}
        </InspectorSection>
      )}
      {v.warnings.length > 0 && (
        <InspectorSection title="Warnings">
          <ul className="rc-list">
            {v.warnings.map((wa, i) => (
              <li key={i}>
                <Txt text={wa} />
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
    </>
  );
}

/** A recording's view, read live: the poll (700 ms live / 3 s after, never while the tab is hidden) and the events. */
function useRecordView(slug: string, rec: string): [RecordViewAnswer | null, string | null, () => void, (v: RecordViewAnswer, fresh?: boolean) => void, () => void, () => RecordViewAnswer | null] {
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
  // The newest view accepted (a change queued behind another one reads its revision when it is sent).
  const latest = useCallback(() => viewRef.current, []);
  return [view, error, load, accept, resync, latest];
}

/** A focused control that went (or turned disabled) under the person: its replacement by test id, else the title. */
function useFocusKeeper(title: RefObject<HTMLHeadingElement | null>): void {
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onIn = (e: FocusEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.closest('#main, .sh-inspector, .sh-statusbar-wrap') && !t.closest('dialog')) last.current = t;
    };
    document.addEventListener('focusin', onIn);
    return () => document.removeEventListener('focusin', onIn);
  }, []);
  useLayoutEffect(() => {
    const was = last.current;
    if (!was) return;
    const active = document.activeElement;
    const gone = !was.isConnected || (was as HTMLButtonElement).disabled === true;
    const dropped = !active || active === document.body || active === was;
    if (!gone || !dropped) return;
    // Let a dialog that is opening or closing place the focus itself.
    if (document.querySelector('dialog[open]')) return;
    const id = was.dataset.testid;
    // A radio among its group's (one test id each group): the one of the same value.
    const value = was instanceof HTMLInputElement ? was.value : null;
    const twins = id ? [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)].filter((el) => !(el as HTMLButtonElement).disabled && (value === null || (el as HTMLInputElement).value === value)) : [];
    const next = twins.length === 1 ? twins[0] : title.current;
    last.current = next;
    next?.focus({ preventScroll: next === title.current });
  });
}

function RecordingScreen({ slug, rec }: { slug: string; rec: string }) {
  const [v, error, reload, accept, resync, latest] = useRecordView(slug, rec);
  const [cursor, setCursor] = useState<Cursor>({ at: 'end' });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<RecordingUi['note']>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [changedAt, setChangedAt] = useState(() => Date.now());
  const title = useRef<HTMLHeadingElement>(null);
  const said = useRef<string | null>(null);
  const inApp = useMemo(() => studioShell() !== null, []);
  const state = v?.state;
  const live = v ? LIVE_STATES.has(v.state) : error === null;
  useFocusKeeper(title);
  // A recording opens at the top of the centre pane (the start form shares the screen's key: no scroll back by the shell).
  useEffect(() => document.getElementById('main')?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' }), []);
  // The clock ticks while the recording goes (the time left, "draft updated …").
  useEffect(() => {
    if (!state || !LIVE_STATES.has(state)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);
  // When the draft last changed (the status bar's "draft updated …").
  const version = v?.version;
  useEffect(() => {
    if (version) setChangedAt(Date.now());
  }, [version]);
  // A recording just started here: its title takes the focus (the start form and its button are gone).
  useEffect(() => {
    if (v && focusOnArrival.delete(rec)) title.current?.focus({ preventScroll: true });
  }, [v, rec]);
  // The polite line: a state change (or the save) — not the state the screen opened on.
  useEffect(() => {
    if (!v) return;
    const line = statusLine(v.state, v.saved !== null);
    if (said.current !== null && line !== said.current) say(line);
    said.current = line;
  }, [v]);
  // A cursor on a row that is gone (an insert removed, a click folded into its typing): back to the end.
  const rows = useMemo(() => new Set(v?.untrusted ? draftRows(v.untrusted).flatMap((s) => s.rows.map((r) => r.id)) : []), [v]);
  useEffect(() => {
    if (cursor.at === 'after' && v?.untrusted && !rows.has(cursor.row)) setCursor({ at: 'end' });
  }, [cursor, rows, v]);
  // A discard that is over: the screen says "discarded" — the note about it goes (review B-M5 of L4.8).
  useEffect(() => {
    if (discarding && state && !LIVE_STATES.has(state)) {
      setDiscarding(false);
      setNote(null);
    }
  }, [discarding, state]);
  // Shoot's browser: the project's recordings, read again when this one changes state or is saved.
  const [opts, reloadOpts] = useCall<RecordOptionsAnswer>('record_options', { project: slug }, slug);
  const savedName = v?.saved?.name;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (state) reloadOpts();
  }, [state, savedName, reloadOpts]);
  const job = () => {
    const j = startedJobs.get(rec) ?? latest()?.job?.id;
    return j ? { job: j } : {};
  };
  /**
   * One change in flight at a time (L5.11b fixes, review A-M1 / A-L6). Asked while one is being written: a pick waits
   * for it (the newest pick of the same step replaces an older one waiting), Stop and Discard wait for it (said, sent
   * right after); an insert, a Remove or Save is refused and said (a second press of Hold is not a second hold). A change
   * that waited reads the newest view (its revision) when it is sent.
   */
  const queue = useRef<Array<{ kind: string; f: () => Promise<void> }>>([]);
  const exec = async (j: { kind: string; f: () => Promise<void> }) => {
    busyRef.current = true;
    setBusy(true);
    setNote(null);
    try {
      await j.f();
    } finally {
      const next = queue.current.shift();
      if (next) void exec(next);
      else {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const run = (kind: string, f: () => Promise<void>) => {
    if (!busyRef.current) return void exec({ kind, f });
    if (!kind.startsWith('choose') && kind !== 'stop' && kind !== 'discard') return say('A change is being written: try again in a moment');
    queue.current = [...queue.current.filter((j) => j.kind !== kind), { kind, f }];
    if (kind === 'stop') say('Stopping once the change being written is saved');
    else if (kind === 'discard') say('Discarding once the change being written is saved');
  };
  const act: RecordingActions = {
    annotate: (change) =>
      run(change.op === 'choose' ? `choose:${change.seq}` : 'change', async () => {
        const cur = latest();
        if (!cur) return;
        try {
          const where = cursorRow(cur.untrusted, cursor);
          const r = await call<{ rev: number; insert_id?: string; view: RecordViewAnswer }>('record_annotate', { project: slug, rec_id: rec, rev: cur.rev, change });
          accept(r.view, true);
          say(annotatedWords(change, change.op === 'insert' ? (where?.label ?? null) : null));
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
      run('stop', async () => {
        try {
          const r = await call<{ action: string; view: RecordViewAnswer }>('record_stop', { project: slug, rec_id: rec, ...job() });
          accept(r.view, true);
          reload();
        } catch (e) {
          setNote({ tone: 'danger', text: errorText(e) });
        }
      }),
    discard: () =>
      run('discard', async () => {
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
      run('save', async () => {
        const cur = latest();
        if (!cur) return;
        try {
          const r = await call<{ name: string; file: string }>('record_save', { project: slug, rec_id: rec, name, rev: cur.rev, draft: cur.draft_sha256 ?? '' });
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
    confirm: setConfirming,
  };
  // L5.11b (critiques H1, M7, L2 of L5.11): while the recording goes — and from the route's first paint, before its view
  // is read (a reload) — the Scenario menu's commands are this screen's, above every other owner: ⌘. stops THIS
  // recording (or says why it cannot), never a run of the scenario in context; Rehearse / Capture / Render send nothing
  // and say why. Once it is over they go back to the status bar's defaults (which name their scenario).
  const stopCommand = () => {
    if (!v) return say('Wait: the recording is still being read');
    if (v.can.stop) return act.stop();
    if (v.job?.stop_requested || v.job?.cancel_requested) return say('The recording is already stopping');
    if (v.started_by === 'cli') return say('This recording was started in a terminal: stop it there');
    say(`Nothing to stop: the recording is ${STATE_WORDS[v.state]?.[0] ?? 'over'}`);
  };
  const waits = (what: string) => () => {
    const open = !v || v.state === 'queued' || v.state === 'preflight' || v.state === 'recording';
    say(open ? `${what} waits while a recording window is open: stop the recording first` : `${what} waits while the recording’s draft is made and checked`);
  };
  useShellCommand('stop', stopCommand, PRIORITY.recording, live);
  useShellCommand('rehearse', waits('Rehearse'), PRIORITY.recording, live);
  useShellCommand('capture', waits('Capture'), PRIORITY.recording, live);
  useShellCommand('render', waits('Render'), PRIORITY.recording, live);
  // The palette's Scenario group is this recording's while it goes (review A-M2 / A-L1): Stop recording (Cancel before the
  // window opens) and Discard…, named after the recording — never the scenario remembered in context.
  const recName = v?.name ?? undefined;
  useScenarioGroup(
    live
      ? [
          { id: 'record-stop', label: v && (v.state === 'queued' || v.state === 'preflight') ? 'Cancel recording' : 'Stop recording', ...(recName ? { hint: recName } : {}), run: stopCommand },
          ...(v?.can.discard ? [{ id: 'record-discard', label: 'Discard…', ...(recName ? { hint: recName } : {}), run: () => setConfirming(true) }] : []),
        ]
      : null,
  );
  const statusWords = !v ? 'Recording · reading it' : v.state === 'recording' ? 'Recording · browser window open' : `Recording · ${STATE_WORDS[v.state]?.[0] ?? v.state}`;
  const u = v?.untrusted;
  const counts = v ? `${plural(v.counts.actions, 'action')}${u ? ` · ${plural(u.inserts.length, 'insert')} · draft updated ${agoWords(changedAt, Math.max(now, changedAt))}` : ''}` : '';
  return (
    <div className="sc-screen rc-screen">
      <RecordBrowser slug={slug} recordings={{ items: opts.state === 'ready' ? opts.data.recent : null, current: rec, live: v ? ({ rec_id: rec, state: v.state, actions: v.counts.actions } as Pick<RecordListItem, 'rec_id' | 'state' | 'actions'>) : null }} />
      {live && (
        <ShellSlot name="actions">
          <span className="sh-scenario" data-testid="status-recording" data-state={v?.state ?? 'loading'}>
            <StatusMark state={v ? (RECORD_MARK[v.state] ?? 'recording') : 'running'} word={<Txt text={statusWords} />} />
            {counts && (
              <span className="sh-seg" data-drop="last" data-testid="status-recording-counts">
                <Txt text={` · ${counts}`} />
              </span>
            )}
          </span>
        </ShellSlot>
      )}
      {!v && !error && (
        <header className="rc-head">
          <div className="rc-head-text">
            <h1 className="sc-h1" tabIndex={-1} ref={title} data-testid="record-title">
              Recording
            </h1>
            <p className="sc-quiet">Reading the recording…</p>
          </div>
        </header>
      )}
      {error && !v && (
        <>
          <header className="rc-head">
            <div className="rc-head-text">
              <h1 className="sc-h1" tabIndex={-1} ref={title}>
                Recording
              </h1>
            </div>
          </header>
          <Callout state="fail" role="alert" title="Failed: this recording cannot be read">
            <p className="rc-pre">
              <Txt text={error} />
            </p>
          </Callout>
        </>
      )}
      {v && <RecordingBody slug={slug} v={v} cursor={cursor} setCursor={setCursor} ui={{ busy, note, taken, discarding: discarding && v.state !== 'discarded', confirming, now, inApp }} act={act} titleRef={title} />}
    </div>
  );
}

export function RecordScreen({ slug, rec }: { slug: string; rec?: string }) {
  return rec ? <RecordingScreen key={rec} slug={slug} rec={rec} /> : <StartScreen slug={slug} />;
}
