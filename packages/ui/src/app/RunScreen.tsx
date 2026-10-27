/**
 * The Run screen (L4.4, R-UI-16 – R-UI-19, R-AUTH-10). Two routes:
 *
 * - `#/p/<slug>/s/<name>/run` — the **preflight**, before anything starts: the sessions this scenario's run signs in
 *   (stored state, "Sign in" for each — a window where the person signs in), what would stop a run from the Studio,
 *   then Start dry run / Start capture. A capture with a persona whose session is invalid and that no run signs in by
 *   itself asks first (ConfirmSessions). A started run opens its own route.
 * - `#/p/<slug>/s/<name>/run/<run_id>` — **one run, live** (any run of the scenario: the Studio's, Claude's, a
 *   terminal's — the last without picture): the header (mode, environment, status, elapsed time, steps done), the
 *   live picture (LiveView), the steps from the run's own `outline` with their live status — the preflight's result
 *   (each persona's session) first, then setup hooks, the scenes, teardown, rollbacks, encoding — the log (capped,
 *   plain text), Pause / Resume (between steps; a capture does not film the pause) and Stop (run_cancel: its teardown and rollbacks
 *   still run, and the screen says how they went), then the outcome.
 *
 * Accessibility: every control is a button with words (Space / Enter); statuses are words with a glyph, never colour
 * alone; the step list and the log are lists, not live regions — one polite status line says only the run's state
 * changes (running, paused, stopping, ended). Every text from the run (step descriptions, messages, the filmed site's
 * text) is a text node through Txt; the site's text sits in "From the page" boxes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunBlocker, ScenarioRunChoice } from '@demo-studio/engine';
import { CallError, call, errorText, useCall } from './api.js';
import { Badge, EnvFlags, Loading, Notice, RunState, Txt, plural } from './bits.js';
import type { BadgeTone } from './bits.js';
import { useScenarioEvents } from './events.js';
import { LiveView } from './LiveView.js';
import type { LiveViewHandle } from './LiveView.js';
import { hrefTo } from './route.js';
import { LOG_KEEP, pauseMaxWords, stepCounts, stepKey, stepStatus, useRunLive } from './run-live.js';
import type { HookRow, LiveFrame, LogLine, OutlineStep, RunLiveState, RunStatusLite, StepRowStatus } from './run-live.js';
import { MODE, RUN_STATUS_WORDS, runErrorWords, seconds, stepWords } from './scenario-words.js';
import type { View } from './scenario-words.js';
import { Commands } from './ScenarioScreen.js';
import { ConfirmSessions, SessionsTable } from './Sessions.js';
import type { SessionRowData, SessionToConfirm } from './Sessions.js';

function Breadcrumb({ slug, name, run }: { slug: string; name: string; run?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <a href={hrefTo({ name: 'projects' })}>Projects</a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'project', slug })}>
        <Txt text={slug} />
      </a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'blocks' })}>
        <Txt text={name} />
      </a>
      <span aria-hidden="true"> / </span>
      {run ? (
        <>
          <a href={hrefTo({ name: 'run', slug, scenario: name })}>Run</a>
          <span aria-hidden="true"> / </span>
          <Txt aria-current="page" className="mono" text={run} />
        </>
      ) : (
        <span aria-current="page">Run</span>
      )}
    </nav>
  );
}

// ─── preflight ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface ScenarioSessionsView {
  env: string;
  personas: SessionRowData[];
  issues: string[];
  confirm: SessionToConfirm[];
}

function StartRow({ mode, list, busy, sending, onStart }: { mode: 'dry' | 'capture'; list: RunBlocker[]; busy: boolean; sending: boolean; onStart: () => void }) {
  const label = mode === 'dry' ? 'Start dry run' : 'Start capture';
  const blocked = list.length > 0;
  const id = `start-why-${mode}`;
  return (
    <div className="blocker-row">
      <p className="run-action">
        <button type="button" className={blocked ? 'button' : 'button primary'} data-testid={`start-${mode}`} disabled={blocked || busy || sending} aria-describedby={id} onClick={onStart}>
          {sending ? `Starting the ${MODE(mode)}…` : blocked ? `${label} — needs the terminal` : label}
        </button>{' '}
        <span id={id} className="muted small">
          {blocked ? 'why below' : busy ? 'waits for the run of this scenario to end' : mode === 'dry' ? 'no hooks, a screenshot per step, the live picture on' : 'its hooks, the video; the live picture off unless you show it'}
        </span>
      </p>
      {list.map((b, i) => (
        <div key={i} className="blocker">
          <p className="pre-line">
            <Txt text={b.message} />
          </p>
          <Commands {...(b.fix ? { fix: b.fix } : {})} {...(b.fix_node ? { fixNode: b.fix_node } : {})} />
        </div>
      ))}
    </div>
  );
}

function Preflight({ slug, name }: { slug: string; name: string }) {
  const [view, reloadView] = useCall<View>('scenario_blocks', { project: slug, name }, `${slug}/${name}`);
  const [sessions, reloadSessions] = useCall<ScenarioSessionsView>('scenario_sessions', { project: slug, name, mode: 'capture' }, `${slug}/${name}`);
  const reload = useCallback(() => {
    reloadView();
    reloadSessions();
  }, [reloadView, reloadSessions]);
  useScenarioEvents(slug, name, { reread: reload, progress: () => undefined, jobs: reloadView });
  const [sending, setSending] = useState<'dry' | 'capture' | null>(null);
  const [refused, setRefused] = useState<{ mode: 'dry' | 'capture'; error: string; fix?: string } | null>(null);
  const [confirm, setConfirm] = useState<SessionToConfirm[] | null>(null);
  /** Where focus goes once the dialog is gone and the buttons are enabled again (review B L4): a selector. */
  const [focusTo, setFocusTo] = useState<string | null>(null);
  useEffect(() => {
    if (!focusTo || confirm || sending) return;
    document.querySelector<HTMLElement>(focusTo)?.focus();
    setFocusTo(null);
  }, [focusTo, confirm, sending]);

  if (view.state === 'loading') return <Loading what="the scenario" />;
  if (view.state === 'error') {
    return (
      <Notice tone="danger" role="alert" title="This scenario cannot be opened">
        <p className="pre-line">
          <Txt text={view.error} />
        </p>
      </Notice>
    );
  }
  const v = view.data;
  const running: ScenarioRunChoice | null = v.running;
  const start = (mode: 'dry' | 'capture', ack?: string[]) => {
    setSending(mode);
    setRefused(null);
    setConfirm(null);
    call<{ run_id: string }>('scenario_run', { project: slug, name, mode, hash: v.hash, ...(ack ? { sessions_ack: ack } : {}) })
      .then(
        (d) => {
          location.hash = hrefTo({ name: 'run', slug, scenario: name, run: d.run_id });
        },
        (e: unknown) => {
          const listed = e instanceof CallError ? (e.error.details?.sessions as SessionToConfirm[] | undefined) : undefined;
          // The sessions changed since this screen read them: the same question, with what the server reads now.
          if (mode === 'capture' && Array.isArray(listed) && listed.length > 0) setConfirm(listed);
          else {
            setRefused({ mode, error: errorText(e), ...(e instanceof CallError && e.error.fix ? { fix: e.error.fix } : {}) });
            setFocusTo(`[data-testid="start-${mode}"]`);
          }
          reload();
        },
      )
      .finally(() => setSending(null));
  };
  const toConfirm = sessions.state === 'ready' ? sessions.data.confirm : [];
  const onCapture = () => (toConfirm.length > 0 ? setConfirm(toConfirm) : start('capture'));
  return (
    <>
      <section className="card" aria-labelledby="pre-sessions-h" data-testid="preflight-sessions">
        <h2 id="pre-sessions-h" className="card-title">
          Sessions this run signs in
        </h2>
        {sessions.state === 'loading' && <Loading what="the sessions" />}
        {sessions.state === 'error' && (
          <p className="muted">
            <Txt text={sessions.error} />
          </p>
        )}
        {sessions.state === 'ready' && (
          <>
            {sessions.data.personas.length === 0 ? (
              <p className="muted">This scenario signs in nowhere on <Txt text={sessions.data.env} />: no session to check.</p>
            ) : (
              <>
                <p className="muted small">
                  The last known state of each (no browser is opened to read it). Before it films, every run checks again each session that has a check —
                  its first rows below once it starts.
                </p>
                <SessionsTable slug={slug} rows={sessions.data.personas} onChanged={reloadSessions} caption={`Sessions ${name} signs in`} />
              </>
            )}
            {sessions.data.issues.map((i, n) => (
              <Notice key={n} tone="warning" role="note">
                <p className="pre-line">
                  <Txt text={i} />
                </p>
              </Notice>
            ))}
            {toConfirm.length > 0 && (
              <p className="small warn-text" data-testid="preflight-confirm-note">
                A capture asks first: {toConfirm.length === 1 ? 'one persona has' : `${toConfirm.length} personas have`} no valid session that a run could renew by
                itself.
              </p>
            )}
          </>
        )}
      </section>
      <section className="card run-checks" aria-labelledby="start-h">
        <h2 id="start-h" className="card-title">
          Start
        </h2>
        {running && (
          <Notice tone="info" title={`A ${MODE(running.mode)} of this scenario is ${RUN_STATUS_WORDS[running.status] ?? running.status}`}>
            <p>
              <a href={hrefTo({ name: 'run', slug, scenario: name, run: running.id })} data-testid="watch-running">
                Watch <Txt className="mono" text={running.id} /> live
              </a>
            </p>
          </Notice>
        )}
        <StartRow mode="dry" list={v.run_blockers.dry} busy={running !== null} sending={sending === 'dry'} onStart={() => start('dry')} />
        <StartRow mode="capture" list={v.run_blockers.capture} busy={running !== null} sending={sending === 'capture'} onStart={onCapture} />
        {refused && (
          <Notice tone="danger" role="alert" title={`The ${MODE(refused.mode)} was not started`}>
            <p className="pre-line" data-testid="start-refused">
              <Txt text={refused.error} />
            </p>
            <Commands {...(refused.fix ? { fix: refused.fix } : {})} />
          </Notice>
        )}
        <p className="muted small">
          {sessions.state === 'ready' ? (
            <>
              Both run on <Txt text={sessions.data.env} />.{' '}
            </>
          ) : null}
          A run can be paused and stopped from its screen; stopping still runs its teardown and rollbacks.
        </p>
      </section>
      {confirm && (
        <ConfirmSessions
          sessions={confirm}
          onClose={(why) => {
            // "Sign in first": to that persona's Sign in button; Escape: back to Start capture (the dialog's opener).
            setFocusTo(
              why === 'sign-in' && confirm[0]
                ? `[data-testid="preflight-sessions"] [data-testid="session-row"][data-persona="${CSS.escape(confirm[0].persona)}"] [data-testid="sign-in-button"]`
                : '[data-testid="start-capture"]',
            );
            setConfirm(null);
          }}
          onConfirm={() => start('capture', confirm.map((c) => c.persona))}
        />
      )}
    </>
  );
}

// ─── one run, live ───────────────────────────────────────────────────────────────────────────────────────────────────

const SESSION_WORDS: Record<string, [string, BadgeTone]> = {
  valid: ['signed in', 'success'],
  unchecked: ['saved session, not checked', 'neutral'],
  none: ['no session: starts signed out', 'neutral'],
  signed_in_auto: ['signed in automatically, off camera', 'success'],
  failed: ['not signed in: the run stops before filming', 'danger'],
};

const STEP_WORDS: Record<StepRowStatus, [string, string, BadgeTone]> = {
  waiting: ['waiting', '○', 'neutral'],
  running: ['running', '●', 'info'],
  ok: ['done', '✓', 'success'],
  dry: ['done', '✓', 'success'],
  skipped: ['skipped', '↷', 'neutral'],
  hook_skipped: ['skipped (hooks off)', '↷', 'neutral'],
  failed: ['failed', '✗', 'danger'],
  not_reached: ['not reached', '–', 'neutral'],
  stopped: ['stopped here', '■', 'warning'],
  interrupted: ['interrupted (its worker stopped)', '■', 'warning'],
};

/** A step row's words: a dry run's skipped `hook:` step says why. */
function stepWordsOf(status: StepRowStatus, mode: string | undefined): [string, string, BadgeTone] {
  const w = STEP_WORDS[status];
  return status === 'hook_skipped' && mode === 'dry' ? ['skipped (dry run)', w[1], w[2]] : w;
}

const HOOK_WORDS: Record<string, [string, string, BadgeTone]> = {
  start: ['running', '●', 'info'],
  ok: ['ok', '✓', 'success'],
  failed: ['failed', '✗', 'danger'],
  skipped: ['skipped', '↷', 'neutral'],
};

/** "The run …" once it ended. */
const ENDED_WORDS: Record<string, string> = { succeeded: 'succeeded', failed: 'failed', cancelled: 'was stopped', interrupted: 'was interrupted (its worker stopped)' };
const endedWords = (status: string) => `The run ${ENDED_WORDS[status] ?? RUN_STATUS_WORDS[status] ?? status}`;

const PHASE_WORDS: Record<string, string> = { setup: 'Setup hook', teardown: 'Teardown hook', rollback: 'Rollback', step: 'Hook' };

const LEVEL_WORDS: Record<string, [string, BadgeTone]> = { debug: ['debug', 'neutral'], info: ['info', 'neutral'], warn: ['warning', 'warning'], error: ['error', 'danger'] };

/** The run's state in a word, from the stream (or run_status while the stream is refused). */
function runState(s: RunLiveState, fb: RunStatusLite | null): { word: string; finished: boolean } {
  if (s.ended || s.end) return { word: s.end?.status ?? s.ended?.status ?? 'ended', finished: true };
  if (s.paused) return { word: 'paused', finished: false };
  if (s.job?.cancel_requested) return { word: 'stopping', finished: false };
  if (s.job && s.job.state !== 'running' && s.job.state !== 'queued') return { word: s.job.state, finished: true };
  if (s.start) return { word: 'running', finished: false };
  if (s.job?.state === 'queued') return { word: 'queued', finished: false };
  if (fb) return { word: fb.paused ? 'paused' : fb.job?.cancel_requested_at && !fb.finished ? 'stopping' : fb.status, finished: fb.finished };
  return { word: s.hello ? 'starting' : 'connecting', finished: false };
}

const STATE_TONE: Record<string, BadgeTone> = { paused: 'warning', stopping: 'warning' };

function Elapsed({ from, to }: { from?: string; to?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!from || to) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [from, to]);
  if (!from) return null;
  const a = Date.parse(from);
  const b = to ? Date.parse(to) : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const s = Math.max(0, Math.round((b - a) / 1000));
  return <span data-testid="elapsed">{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`}</span>;
}

/** The steps the run executes: its outline, else (a run older than L4.4) the steps it reported, in order. */
function stepRows(s: RunLiveState): OutlineStep[] {
  if (s.outline) return s.outline;
  return Object.keys(s.steps).map((k) => {
    const i = k.lastIndexOf('.');
    return { scene: k.slice(0, i), step: Number(k.slice(i + 1)), action: '', desc: '' };
  });
}

function RunHeader({ s, fb, runId }: { s: RunLiveState; fb: RunStatusLite | null; runId: string }) {
  const st = runState(s, fb);
  const rows = stepRows(s);
  const total = s.start?.steps_total ?? (rows.length || fb?.steps_total || 0);
  // Done means its row says done: a failed step is not counted (run_status's steps_done counts every step that ended).
  const counts = s.start ? stepCounts(s, rows, st.finished) : null;
  const done = counts ? counts.done : (fb?.steps_done ?? 0);
  // A run that ended without its run_end (its worker killed): the clock stops at its last event.
  const to = s.end?.ts ?? (st.finished ? (s.lastTs ?? undefined) : undefined);
  const mode = s.start?.mode ?? s.hello?.mode ?? fb?.mode;
  const word = RUN_STATUS_WORDS[st.word] ?? st.word;
  return (
    <header className="screen-head run-head">
      <h1>
        {mode ? (mode === 'dry' ? 'Dry run' : 'Capture') : 'Run'} <Txt className="mono run-id" text={runId} />
      </h1>
      <p className="run-facts" data-testid="run-facts">
        {STATE_TONE[st.word] ? <Badge tone={STATE_TONE[st.word]}>{word}</Badge> : <RunState status={word} />}
        {s.start?.env && (
          <span>
            {' '}
            on <Txt text={s.start.env} />
          </span>
        )}{' '}
        <EnvFlags env={{ production: s.start?.production ?? false, access: s.start?.access === 'read-only' ? 'read-only' : 'read-write', sandbox: false }} />
        {s.start?.until && (
          <span className="muted small">
            {' '}
            · until <Txt text={s.start.until} />
          </span>
        )}
        {s.start?.ts && (
          <span className="muted small">
            {' '}
            · <Elapsed from={s.start.ts} {...(to ? { to } : {})} />
          </span>
        )}
      </p>
      {total > 0 && (
        <p className="run-progress">
          <progress max={total} value={Math.min(done, total)} aria-label="Steps done" />{' '}
          <span data-testid="run-steps-done">
            {done}/{plural(total, 'step')} done{counts && counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ''}
          </span>
        </p>
      )}
    </header>
  );
}

function Controls({ slug, runId, s, fb, mode }: { slug: string; runId: string; s: RunLiveState; fb: RunStatusLite | null; mode: string | undefined }) {
  const [busy, setBusy] = useState<'pause' | 'resume' | 'stop' | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [stopAsked, setStopAsked] = useState(false);
  const st = runState(s, fb);
  if (st.finished) return null;
  const jobId = s.hello?.job ?? fb?.job?.id ?? null;
  const jobState = s.job?.state ?? fb?.job?.state;
  const paused = s.paused !== null || Boolean(fb?.paused && !s.hello);
  const pauseAsked = Boolean(s.job?.pause_requested ?? fb?.job?.pause_requested_at);
  const stopping = stopAsked || Boolean(s.job?.cancel_requested ?? fb?.job?.cancel_requested_at);
  const terminal = s.hello !== null && jobId === null;
  const why = terminal
    ? 'Started in a terminal: press Ctrl-C there to stop it.'
    : jobState === 'queued'
      ? 'It can pause once it runs.'
      : stopping
        ? 'It is stopping.'
        : null;
  const pause = (on: boolean) => {
    setBusy(on ? 'pause' : 'resume');
    setSaid(null);
    call('run_pause', { project: slug, run_id: runId, paused: on }).then(
      () => undefined,
      (e: unknown) => setSaid(errorText(e)),
    ).finally(() => setBusy(null));
  };
  const stop = () => {
    setBusy('stop');
    setSaid(null);
    call('run_cancel', { project: slug, run_id: runId }).then(
      () => setStopAsked(true),
      (e: unknown) => setSaid(errorText(e)),
    ).finally(() => setBusy(null));
  };
  const holding = paused || pauseAsked;
  return (
    <section className="card run-controls" aria-labelledby="controls-h">
      <h2 id="controls-h" className="sr-only">
        Controls
      </h2>
      <div className="actions">
        <button type="button" className="button" data-testid={holding ? 'run-resume' : 'run-pause'} disabled={why !== null || busy !== null} aria-describedby="controls-why" onClick={() => pause(!holding)}>
          {busy === 'pause' ? 'Pausing…' : busy === 'resume' ? 'Resuming…' : holding ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="button" data-testid="run-stop" disabled={terminal || stopping || busy !== null} aria-describedby="controls-why" onClick={stop}>
          {busy === 'stop' ? 'Stopping…' : stopping ? 'Stop asked' : 'Stop'}
        </button>
      </div>
      <p id="controls-why" className="small" data-testid="controls-why">
        {stopping
          ? 'Stopping now: the step in progress is interrupted; its teardown hooks and pending rollbacks still run — their result shows below.'
          : paused
            ? `Paused before ${s.paused ? stepWords(s.paused.scene, s.paused.step) : fb?.paused ? stepWords(fb.paused.scene, fb.paused.step) : 'the next step'}.${mode === 'capture' ? ' The video does not show the pause; the page keeps running, so what changes on it meanwhile shows as a jump when the capture goes on.' : ''} ${
                s.paused?.max_ms ? `A pause longer than ${pauseMaxWords(s.paused.max_ms)} stops the run` : 'A pause longer than its limit (DEMO_STUDIO_PAUSE_MAX_MIN, 30 minutes by default) stops the run'
              }; its teardown runs.`
            : pauseAsked
              ? 'Pausing before the next step: the current step finishes first.'
              : (why ?? `Pause waits for the current step to finish${mode === 'capture' ? ' (the video does not show the pause)' : ''}; Stop stops now — the step in progress is interrupted — and still runs the teardown and rollbacks.`)}
      </p>
      {said && (
        <p className="small warn-text" role="alert" data-testid="controls-error">
          <Txt text={said} />
        </p>
      )}
    </section>
  );
}

function Glyph({ g }: { g: string }) {
  return (
    <span className="run-glyph" aria-hidden="true">
      {g}
    </span>
  );
}

function HookItem({ h }: { h: HookRow }) {
  const [word, g, tone] = HOOK_WORDS[h.status] ?? ['unknown', '?', 'neutral'];
  if (h.marker) {
    return (
      <li className="run-row" data-testid="run-hook-phase" data-phase={h.phase}>
        <Glyph g="●" />
        <span className="run-row-what">
          {PHASE_WORDS[h.phase] ?? h.phase}s{h.message && <> — <Txt text={h.message} /></>}
        </span>
        <Badge tone="info">running</Badge>
      </li>
    );
  }
  return (
    <li className="run-row" data-testid="run-hook" data-phase={h.phase} data-status={h.status}>
      <Glyph g={g} />
      <span className="run-row-what">
        {PHASE_WORDS[h.phase] ?? h.phase} <Txt className="mono" text={h.name} />
      </span>
      <Badge tone={tone}>{word}</Badge>
      {h.message && (
        <p className="from-page small">
          <span className="from-page-title">Its message: </span>
          <Txt text={h.message} />
        </p>
      )}
    </li>
  );
}

function StepList({ s, fb, finished, mode, follow, setFollow }: { s: RunLiveState; fb: RunStatusLite | null; finished: boolean; mode: string | undefined; follow: boolean; setFollow: (f: boolean) => void }) {
  const box = useRef<HTMLOListElement>(null);
  const rows = stepRows(s);
  const cur = s.paused ?? s.current;
  const curKey = cur ? stepKey(cur.scene, cur.step) : null;
  useEffect(() => {
    if (!follow || !curKey || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(curKey)}"]`);
    if (!el) return;
    const b = box.current;
    const top = el.offsetTop - b.offsetTop;
    if (top < b.scrollTop || top + el.offsetHeight > b.scrollTop + b.clientHeight) b.scrollTop = Math.max(0, top - b.clientHeight / 3);
  }, [follow, curKey]);
  const scenes: Array<{ scene: string; steps: OutlineStep[] }> = [];
  for (const r of rows) {
    const last = scenes[scenes.length - 1];
    if (last && last.scene === r.scene) last.steps.push(r);
    else scenes.push({ scene: r.scene, steps: [r] });
  }
  const before = s.hooks.filter((h) => h.phase === 'setup');
  // A `hook:` step's entries (phase `step`, L5.8) are on its step row (s.stepHooks), not "after the scenes".
  const after = s.hooks.filter((h) => h.phase !== 'setup' && h.phase !== 'step');
  return (
    <section className="card run-steps" aria-labelledby="steps-h">
      <div className="card-head">
        <h2 id="steps-h" className="card-title">
          Steps
        </h2>
        <label className="small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow the current step
        </label>
      </div>
      <ol className="run-list" ref={box} data-testid="run-steps" tabIndex={0} aria-labelledby="steps-h">
        {(s.sessions.length > 0 || before.length > 0) && (
          <li className="run-group">
            <p className="run-group-title">Before filming</p>
            <ol>
              {s.sessions.map((p) => {
                const [word, tone] = SESSION_WORDS[p.status] ?? ['unknown', 'neutral'];
                return (
                  <li key={p.persona} className="run-row" data-testid="run-session" data-persona={p.persona} data-status={p.status}>
                    <Glyph g={p.status === 'failed' ? '✗' : '✓'} />
                    <span className="run-row-what">
                      Session of <Txt text={p.persona} />
                    </span>
                    <Badge tone={tone}>{word}</Badge>
                    {p.detail && (
                      <p className="from-page small">
                        <span className="from-page-title">From the page: </span>
                        <Txt text={p.detail} />
                      </p>
                    )}
                  </li>
                );
              })}
              {before.map((h, i) => (
                <HookItem key={`s${i}`} h={h} />
              ))}
            </ol>
          </li>
        )}
        {scenes.map((g, gi) => (
          <li key={`${g.scene}-${gi}`} className="run-group">
            <p className="run-group-title">
              Scene <Txt className="mono" text={g.scene} />
              {g.steps.some((r) => r.offscreen) && <> <Badge>off camera</Badge></>}
            </p>
            <ol>
              {g.steps.map((r) => {
                const k = stepKey(r.scene, r.step);
                const st = s.steps[k];
                // The step a stop interrupted says "stopped here", not a failure of the step; a skipped hook says so.
                const status = stepStatus(s, r, finished);
                const stopped = status === 'stopped';
                const [word, glyph, tone] = stepWordsOf(status, mode);
                const hooks = s.stepHooks[k] ?? [];
                const pausedHere = s.paused !== null && s.paused.scene === r.scene && s.paused.step === r.step;
                return (
                  <li key={k} className={`run-row run-step${k === curKey ? ' is-current' : ''}`} data-testid="run-step" data-key={k} data-status={status} aria-current={k === curKey ? 'step' : undefined}>
                    <Glyph g={pausedHere ? '‖' : glyph} />
                    <span className="step-n">{r.step + 1}</span>
                    <span className="run-row-what">
                      {r.action && <span className="mono small">{r.action}</span>} {r.desc && <Txt text={r.desc} />}
                    </span>
                    {pausedHere ? <Badge tone="warning">paused before this step</Badge> : <Badge tone={tone}>{word}</Badge>}
                    {st?.ms !== undefined && <span className="muted small">{seconds(st.ms)}</span>}
                    {st?.message && !stopped && (
                      <p className="from-page small">
                        <span className="from-page-title">Its message (it may quote the page): </span>
                        <Txt text={runErrorWords(st.message)} />
                      </p>
                    )}
                    {hooks.length > 0 && (
                      <ol className="run-substeps" data-testid="run-step-hooks">
                        {hooks.map((h, i) => (
                          <HookItem key={i} h={h} />
                        ))}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
        {rows.length === 0 && fb && (
          <li className="small run-row" data-testid="run-fallback-step">
            {fb.paused ? `Paused before ${stepWords(fb.paused.scene, fb.paused.step)}.` : fb.current ? `Now: ${stepWords(fb.current.scene, fb.current.step)} (${fb.current.action}).` : `${RUN_STATUS_WORDS[fb.status] ?? fb.status}.`}{' '}
            <span className="muted">The step list and the log are in the other Run screen.</span>
          </li>
        )}
        {rows.length === 0 && !fb && (
          <li className="muted small run-row">{finished ? 'No step ran.' : 'The steps show when the run starts (a queued run waits for the worker).'}</li>
        )}
        {(after.length > 0 || s.encode) && (
          <li className="run-group">
            <p className="run-group-title">After the scenes</p>
            <ol>
              {after.map((h, i) => (
                <HookItem key={`a${i}`} h={h} />
              ))}
              {s.encode && (
                <li className="run-row" data-testid="run-encode">
                  <Glyph g={s.encode === 'done' ? '✓' : '●'} />
                  <span className="run-row-what">Encoding the video</span>
                  <Badge tone={s.encode === 'done' ? 'success' : 'info'}>{s.encode === 'done' ? 'done' : 'running'}</Badge>
                </li>
              )}
            </ol>
          </li>
        )}
      </ol>
      {s.outlineTruncated && <p className="muted small">The run has more steps than the list shows.</p>}
    </section>
  );
}

/** "14:03:07", local time, from an ISO time. */
function clock(iso: string): string {
  const t = new Date(iso);
  return Number.isFinite(t.getTime()) ? t.toLocaleTimeString('en-GB', { hour12: false }) : '';
}

function LogPanel({ log, dropped, truncated }: { log: LogLine[]; dropped: number; truncated: boolean }) {
  const [filter, setFilter] = useState<'all' | 'warn'>('all');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLOListElement>(null);
  const lines = filter === 'all' ? log : log.filter((l) => l.level === 'warn' || l.level === 'error');
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [follow, lines.length]);
  return (
    <section className="card run-log-card" aria-labelledby="log-h">
      <div className="card-head">
        <h2 id="log-h" className="card-title">
          Log
        </h2>
        <span className="actions small">
          <label>
            Show{' '}
            <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'warn')}>
              <option value="all">every line</option>
              <option value="warn">warnings and errors</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
        </span>
      </div>
      {(dropped > 0 || truncated) && (
        <p className="muted small">
          {truncated ? 'A long log: read from its end. ' : ''}
          {dropped > 0 ? `${plural(dropped, 'earlier line')} not shown (the screen keeps the last ${LOG_KEEP}).` : ''}
        </p>
      )}
      <ol className="run-log" ref={box} data-testid="run-log" tabIndex={0} aria-label="Log lines">
        {lines.map((l) => {
          const [word, tone] = LEVEL_WORDS[l.level] ?? [l.level, 'neutral'];
          return (
            <li key={l.key} data-level={l.level} data-testid="log-line">
              {l.ts && <time className="muted mono" dateTime={l.ts}>{clock(l.ts)}</time>} <Badge tone={tone}>{word}</Badge>
              {l.from !== 'run' && <span className="muted small"> {l.from === 'worker' ? 'worker' : 'Studio'}:</span>} <Txt className="log-text" text={l.text} />
            </li>
          );
        })}
        {lines.length === 0 && <li className="muted small">No line yet.</li>}
      </ol>
    </section>
  );
}

function Outcome({ slug, name, runId, s, mode, pauseLate }: { slug: string; name: string; runId: string; s: RunLiveState; mode: string | undefined; pauseLate: boolean }) {
  const e = s.end;
  const status = e?.status ?? s.ended?.status ?? s.ended?.job_state ?? 'ended';
  const setup = s.hooks.filter((h) => h.phase === 'setup' && !h.marker);
  const teardown = s.hooks.filter((h) => h.phase === 'teardown' && !h.marker);
  const rollbacks = s.hooks.filter((h) => h.phase === 'rollback' && !h.marker);
  const noHook = (st: string | undefined) => st === undefined || st === 'none' || st === 'skipped';
  const hookLine = (list: HookRow[]) => list.map((h) => `${h.name} ${HOOK_WORDS[h.status]?.[0] ?? h.status}`).join(', ');
  const ok = status === 'succeeded';
  const where = e?.error ? [e.error.scene !== undefined && e.error.step !== undefined ? stepWords(e.error.scene, e.error.step) : e.error.scene, e.error.action].filter(Boolean).join(' · ') : '';
  // Only a step's error may quote the page (review B L9): a run that failed before its steps (a missing variable, the
  // app not reachable) failed on the tool's side — its error is said plainly.
  const fromStep = e?.error?.step !== undefined;
  const counts = stepCounts(s, stepRows(s), true);
  return (
    <Notice tone={ok ? 'info' : status === 'cancelled' ? 'warning' : 'danger'} role="note" title={endedWords(status)}>
      <div data-testid="run-outcome" data-status={status}>
        {e && (
          <p>
            {s.outline ? counts.done : (e.steps_done ?? 0)}/{plural(e.steps_total, 'step')} done{s.outline && counts.skipped > 0 ? ` (${counts.skipped} skipped)` : ''}
            {e.stopped_at && <> · stopped before <Txt text={stepWords(e.stopped_at.scene, e.stopped_at.step)} /> ({e.stopped_at.reason === 'until' ? 'until' : 'an irreversible step'})</>}
            {e.warnings > 0 && <> · {plural(e.warnings, 'warning')}</>}
            {e.optional_failures ? <> · {plural(e.optional_failures, 'optional step')} failed</> : null}
          </p>
        )}
        {e?.hooks && noHook(e.hooks.setup) && noHook(e.hooks.teardown) && rollbacks.length === 0 && (
          <p data-testid="outcome-hooks">{mode === 'dry' ? 'No hook ran (a dry run skips them).' : 'No hook ran.'}</p>
        )}
        {e?.hooks && !(noHook(e.hooks.setup) && noHook(e.hooks.teardown) && rollbacks.length === 0) && (
          <p data-testid="outcome-hooks">
            Setup: {e.hooks.setup}
            {setup.length > 0 ? ` (${hookLine(setup)})` : ''} · Teardown: {e.hooks.teardown}
            {teardown.length > 0 ? ` (${hookLine(teardown)})` : ''}
            {rollbacks.length > 0 ? ` · Rollbacks: ${hookLine(rollbacks)}` : ''}
          </p>
        )}
        {status === 'cancelled' && (
          <p data-testid="outcome-stopped">
            Stopped from the Studio or by Claude.{' '}
            {teardown.length > 0 ? `Its teardown ran: ${hookLine(teardown)}.` : e?.hooks?.teardown === 'skipped' || e?.hooks?.teardown === 'none' ? 'It had no teardown to run.' : ''}{' '}
            {rollbacks.length > 0 ? `Rollbacks: ${hookLine(rollbacks)}.` : 'No rollback was pending.'}
          </p>
        )}
        {pauseLate && <p data-testid="outcome-pause-late">The pause came too late: the run ended before its next step.</p>}
        {e?.untrusted?.error && status !== 'cancelled' && fromStep && (
          <div className="from-page" data-testid="outcome-error" data-from="step">
            <p className="from-page-title">Its error{where ? ` (${where})` : ''} — it may quote the page (text the site controls)</p>
            <p className="pre-line">
              <Txt text={runErrorWords(e.untrusted.error)} />
            </p>
          </div>
        )}
        {e?.untrusted?.error && status !== 'cancelled' && !fromStep && (
          <div data-testid="outcome-error" data-from="run">
            <p>Its error{where ? ` (${where})` : ''}:</p>
            <p className="pre-line">
              <Txt text={runErrorWords(e.untrusted.error)} />
            </p>
          </div>
        )}
        {e?.untrusted?.warnings && e.untrusted.warnings.length > 0 && (
          <details>
            <summary>Warnings</summary>
            <ul>
              {e.untrusted.warnings.map((w, i) => (
                <li key={i}>
                  <Txt text={w} />
                </li>
              ))}
            </ul>
          </details>
        )}
        <p>
          <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'blocks' })}>Back to the scenario and its pictures</a>
          {ok && mode === 'capture' && (
            <>
              {' · '}
              <a href={hrefTo({ name: 'timeline', slug, scenario: name, run: runId })} data-testid="outcome-timeline">
                Open its timeline
              </a>
            </>
          )}
        </p>
      </div>
    </Notice>
  );
}

function Watch({ slug, name, runId }: { slug: string; name: string; runId: string }) {
  const view = useRef<LiveViewHandle>(null);
  const [frames, setFrames] = useState<boolean | null>(null);
  const [follow, setFollow] = useState(true);
  const onFrame = useCallback((f: LiveFrame) => view.current?.draw(f), []);
  const { state: s, conn, error, fallback } = useRunLive(slug, runId, frames, onFrame);
  const st = runState(s, fallback);
  // A pause still asked (not yet taken) when the run ended: it came too late (B15). The last value seen while running.
  const pauseWaiting = useRef(false);
  if (!st.finished) pauseWaiting.current = Boolean(s.job?.pause_requested) && s.paused === null;
  const mode = s.start?.mode ?? s.hello?.mode ?? fallback?.mode;
  const shown = frames ?? mode === 'dry';
  const terminal = s.hello !== null && s.hello.job === null;
  const canToggle = conn !== 'busy' && !terminal && !st.finished && mode !== undefined;
  const pauseLate = st.finished && pauseWaiting.current;
  const toggle = () => {
    if (shown) view.current?.clear();
    setFrames(!shown);
  };
  // The one polite status line: the run's state in words, only when it changes.
  const statusLine = st.finished ? `${endedWords(st.word)}.` : st.word === 'paused' ? 'Paused.' : st.word === 'stopping' ? 'Stopping.' : st.word === 'queued' ? 'Queued.' : st.word === 'running' ? 'Running.' : '';
  if (error) {
    return (
      <Notice tone="danger" role="alert" title="This run cannot be followed">
        <p className="pre-line" data-testid="run-error">
          <Txt text={error.message} />
        </p>
        <p>
          <a href={hrefTo({ name: 'run', slug, scenario: name })}>Back to the Run screen</a>
        </p>
      </Notice>
    );
  }
  return (
    <>
      <RunHeader s={s} fb={fallback} runId={runId} />
      <p className="sr-only" role="status" data-testid="run-status-line">
        {statusLine}
      </p>
      {conn === 'busy' && (
        <Notice tone="info" role="note" title="Followed without its stream">
          <p data-testid="run-busy">
            This Studio serves two Run screens at a time and both are open (another tab?): this one reads the run's status every few seconds, without the
            picture, steps or log. Close the other Run screen to see them here.
          </p>
        </Notice>
      )}
      {conn === 'retrying' && (
        <p className="muted small" data-testid="run-retrying">
          The run's stream dropped: reconnecting…
        </p>
      )}
      {(st.finished || s.ended) && <Outcome slug={slug} name={name} runId={runId} s={s} mode={mode} pauseLate={pauseLate} />}
      <Controls slug={slug} runId={runId} s={s} fb={fallback} mode={mode} />
      <div className="run-grid">
        <LiveView
          ref={view}
          picture={conn === 'busy' ? { state: 'busy' } : st.finished ? { state: 'ended' } : terminal ? (s.picture ?? { state: 'none' }) : s.picture}
          shown={shown}
          capture={mode === 'capture'}
          onToggle={canToggle ? toggle : null}
          {...(conn === 'busy' ? { note: 'No live picture in this tab (another Run screen holds the stream).' } : conn === 'hidden' ? { note: 'The picture stops while this tab is hidden.' } : {})}
        />
        <StepList s={s} fb={conn === 'busy' ? fallback : null} finished={st.finished} mode={mode} follow={follow} setFollow={setFollow} />
      </div>
      <LogPanel log={s.log} dropped={s.logDropped} truncated={s.truncated} />
    </>
  );
}

export function RunScreen({ slug, name, run }: { slug: string; name: string; run?: string }) {
  return (
    <div className="screen run-screen">
      <Breadcrumb slug={slug} name={name} {...(run ? { run } : {})} />
      {run ? (
        <Watch key={run} slug={slug} name={name} runId={run} />
      ) : (
        <>
          <header className="screen-head">
            <h1>
              Run <Txt text={name} />
            </h1>
            <p className="muted">Check the sessions, then start a dry run or a capture: this screen then follows it live.</p>
          </header>
          <Preflight slug={slug} name={name} />
        </>
      )}
    </div>
  );
}

