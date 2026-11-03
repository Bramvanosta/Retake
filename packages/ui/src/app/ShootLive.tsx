/**
 * L5.11a: one run, live (`#/p/<slug>/s/<name>/run/<run_id>`, R4-ShootLive; R-UI-41) — any run of the scenario: the
 * Studio's, Claude's, a terminal's (the last without picture). L4.4's Run screen rebuilt on the kit, every capability
 * kept:
 *
 * - Centre: "Rehearsal of quote" / "Capture of quote" (no run id in a title: the browser and the inspector name it),
 *   the current step, when it started and on which location with its flags (`run-facts`), the live picture
 *   (LiveView.tsx), the steps done with the time elapsed (a kit Progress), the mode's note and what Pause and Stop do
 *   (`controls-why`), the one polite status line (the run's state changes only: running, paused, stopping, ended), a
 *   stream refused (another live screen holds it: run_status every few seconds), reconnecting, and once it ended the
 *   outcome with what happens next (Open in Edit, Back to the board, Rehearse again / Start capture).
 * - Inspector "Steps and log" (in place under the centre when hidden): the steps from the run's own outline with their
 *   live status — the preflight's sessions and the setup hooks first, the scenes, a `hook:` step's entries on its row,
 *   teardown, rollbacks, encoding — the current one marked (`aria-current="step"`, the selection fill and weight 600),
 *   "Follow current step"; the log (every line, or warnings and errors; Follow; the lines it dropped).
 * - Status bar: this screen's while the run is unfinished — its state, Pause / Resume (between steps; a capture does
 *   not film the pause, L5.7's clock) and Stop (run_cancel: its teardown and rollbacks still run; a terminal's run:
 *   Ctrl-C there). ⌘. stops THIS run (it outranks the status bar's defaults: command-bus.ts). Once it ended the
 *   defaults come back (Rehearse, Capture, Render).
 *
 * Every text from the run (step descriptions, messages, the filmed site's text) is a text node (Txt); the site's text
 * sits in "From the page" boxes; a run's error is "from the page" only when a step raised it (review B L9 of L4.4).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText } from './api.js';
import { Txt, plural, shown } from './bits.js';
import { envFlagWords } from './board-words.js';
import { LiveView } from './LiveView.js';
import type { LiveViewHandle } from './LiveView.js';
import { useProjectView } from './project-data.js';
import { LOG_KEEP, pauseMaxWords, stepCounts, stepKey, stepStatus, useRunLive } from './run-live.js';
import type { HookRow, LiveFrame, LogLine, OutlineStep, RunLiveState, RunStatusLite, StepRowStatus } from './run-live.js';
import { useRunLocation } from './run-location.js';
import { RUN_STATUS_WORDS, runErrorWords, seconds, stepWords } from './scenario-words.js';
import { PRIORITY, runShellCommand, useShellCommand } from './shell/command-bus.js';
import { say } from './shell/say.js';
import { ShellSlot } from './shell/slots.js';
import { capturePictureOn, reloadActions, takeLiveFocus, useScenarioActions } from './shoot-data.js';
import { ShootBrowser } from './ShootBrowser.js';
import { SHOOT_STATES, modeWord } from './shoot-words.js';
import { Button, Callout, Disclosure, InspectorSection, LinkButton, Progress, Select, Shape, StatusMark, Switch } from './ui-kit/index.js';
import type { MarkState } from './ui-kit/index.js';

const SESSION_WORDS: Record<string, [string, MarkState]> = {
  valid: ['valid · signed in', 'ok'],
  unchecked: ['saved session, not checked', 'idle'],
  none: ['missing session: starts signed out', 'idle'],
  signed_in_auto: ['valid · signed in automatically, off camera', 'ok'],
  failed: ['not signed in: the run stops before filming', 'fail'],
};

const STEP_WORDS: Record<StepRowStatus, [string, MarkState]> = {
  waiting: ['waiting', 'waiting'],
  running: ['running', 'running'],
  ok: ['done', 'ok'],
  dry: ['done', 'ok'],
  skipped: ['skipped', 'idle'],
  hook_skipped: ['skipped (hooks off)', 'idle'],
  failed: ['failed', 'fail'],
  not_reached: ['not reached', 'idle'],
  stopped: ['stopped here', 'warn'],
  interrupted: ['interrupted (its worker stopped)', 'warn'],
};

/** A step row's words: a rehearsal's skipped `hook:` step says why. */
function stepWordsOf(status: StepRowStatus, mode: string | undefined): [string, MarkState] {
  const w = STEP_WORDS[status];
  return status === 'hook_skipped' && mode === 'dry' ? ['skipped (rehearsal)', w[1]] : w;
}

const HOOK_WORDS: Record<string, [string, MarkState]> = { start: ['running', 'running'], ok: ['ok', 'ok'], failed: ['failed', 'fail'], skipped: ['skipped', 'idle'] };
/** "The run …" once it ended. */
const ENDED_WORDS: Record<string, string> = { succeeded: 'succeeded', failed: 'failed', cancelled: 'was stopped', interrupted: 'was interrupted (its worker stopped)' };
const endedWords = (status: string) => `The run ${ENDED_WORDS[status] ?? RUN_STATUS_WORDS[status] ?? status}`;
/** A run's state in a word on this screen: a stopped run says "stopped" (one word for it across Shoot, review B-L2). */
const stateWord = (w: string) => RUN_STATUS_WORDS[w] ?? w;
const PHASE_WORDS: Record<string, string> = { setup: 'Setup hook', teardown: 'Teardown hook', rollback: 'Rollback', step: 'Hook' };
const LEVEL_WORDS: Record<string, string> = { debug: 'debug', info: 'info', warn: 'warning', error: 'error' };

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

const STATE_MARK: Record<string, MarkState> = { running: 'running', queued: 'waiting', starting: 'waiting', connecting: 'waiting', paused: 'warn', stopping: 'warn', succeeded: 'ok', failed: 'fail', cancelled: 'warn', interrupted: 'fail' };

/** "00:23" / "1:05:00" elapsed, ticking while the run goes. */
function useElapsed(from: string | undefined, to: string | undefined): string | null {
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
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The steps the run executes: its outline, else (a run older than L4.4) the steps it reported, in order. */
function stepRows(s: RunLiveState): OutlineStep[] {
  if (s.outline) return s.outline;
  return Object.keys(s.steps).map((k) => {
    const i = k.lastIndexOf('.');
    return { scene: k.slice(0, i), step: Number(k.slice(i + 1)), action: '', desc: '' };
  });
}

/** "14:03" local time, from an ISO time. */
function clock(iso: string, withSeconds = false): string {
  const t = new Date(iso);
  return Number.isFinite(t.getTime()) ? t.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) }) : '';
}

/** Pause / Resume and Stop in the status bar (claimed while the run is unfinished), what they do in the centre. */
function Controls({ slug, name, runId, s, fb, mode, finished }: { slug: string; name: string; runId: string; s: RunLiveState; fb: RunStatusLite | null; mode: string | undefined; finished: boolean }) {
  const [busy, setBusyState] = useState<'pause' | 'resume' | 'stop' | null>(null);
  // Held in a ref too: two ⌘. in one tick see the first one's request (one call, the second said).
  const inFlight = useRef<'pause' | 'resume' | 'stop' | null>(null);
  const setBusy = (v: 'pause' | 'resume' | 'stop' | null) => {
    inFlight.current = v;
    setBusyState(v);
  };
  const [said, setSaid] = useState<string | null>(null);
  const [stopAsked, setStopAsked] = useState(false);
  const st = runState(s, fb);
  const jobId = s.hello?.job ?? fb?.job?.id ?? null;
  const jobState = s.job?.state ?? fb?.job?.state;
  const paused = s.paused !== null || Boolean(fb?.paused && !s.hello);
  const pauseAsked = Boolean(s.job?.pause_requested ?? fb?.job?.pause_requested_at);
  const stopping = stopAsked || Boolean(s.job?.cancel_requested ?? fb?.job?.cancel_requested_at);
  // A terminal's run: the stream's hello names no job — or, the stream refused, run_status shows none (Stop cannot reach it).
  const terminal = jobId === null && (s.hello !== null || (fb !== null && !fb.finished));
  const why = terminal ? 'Started in a terminal: press Ctrl-C there to stop it.' : jobState === 'queued' ? 'It can pause once it runs.' : stopping ? 'It is stopping.' : null;
  const pause = (on: boolean) => {
    if (inFlight.current) return;
    setBusy(on ? 'pause' : 'resume');
    setSaid(null);
    call('run_pause', { project: slug, run_id: runId, paused: on })
      .then(
        () => undefined,
        (e: unknown) => setSaid(errorText(e)),
      )
      .finally(() => setBusy(null));
  };
  const stop = () => {
    // Whose run it is comes with the stream's hello (or run_status): until then nothing is sent, and it is said.
    if (s.hello === null && fb === null) return say('Wait: the run is still being read');
    if (terminal) return say('Started in a terminal: press Ctrl-C there to stop it');
    // ⌘. always answers (review A-L3 of L5.11a): a stop already asked, or a pause on its way, is said.
    const now = inFlight.current;
    if (stopping) return say(`The ${modeWord(mode ?? 'dry', true)} of ${name} is already stopping`);
    if (now) return say(`Wait: ${now === 'pause' ? 'pausing' : now === 'resume' ? 'resuming' : 'stopping'}…`);
    setBusy('stop');
    setSaid(null);
    call('run_cancel', { project: slug, run_id: runId })
      .then(
        () => {
          setStopAsked(true);
          reloadActions(slug, name);
        },
        (e: unknown) => setSaid(errorText(e)),
      )
      .finally(() => setBusy(null));
  };
  // ⌘. stops this run while it goes (critique H1: the screen's priority, whatever order the effects ran in).
  useShellCommand('stop', stop, PRIORITY.screen, !finished);
  if (finished) return null;
  const holding = paused || pauseAsked;
  const m = mode ?? 'dry';
  // The state word of SHOOT_STATES (review A-L6 / B-L3: "Rehearsing", "Capture paused"…), the same as the status bar's.
  const word =
    st.word === 'running'
      ? `${SHOOT_STATES.running.word(m)}${pauseAsked ? ' · pausing after this step' : ''}`
      : st.word === 'paused' || st.word === 'stopping' || st.word === 'queued'
        ? SHOOT_STATES[st.word].word(m)
        : `${modeWord(m)} ${stateWord(st.word)}`;
  return (
    <>
      <ShellSlot name="actions">
        <span className="sh-scenario" data-testid="live-state">
          <StatusMark state={STATE_MARK[st.word] ?? 'running'} word={<Txt text={word} />} />
        </span>
        <Button size="sm" icon={holding ? 'play' : 'pause'} data-testid={holding ? 'run-resume' : 'run-pause'} disabled={why !== null || busy !== null} aria-describedby="controls-why" onClick={() => pause(!holding)}>
          {busy === 'pause' ? 'Pausing…' : busy === 'resume' ? 'Resuming…' : holding ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" icon="stop" data-testid="run-stop" disabled={terminal || stopping || busy !== null} aria-describedby="controls-why" onClick={stop}>
          {busy === 'stop' ? 'Stopping…' : stopping ? 'Stop asked' : 'Stop'}
        </Button>
      </ShellSlot>
      <p id="controls-why" className="sc-quiet" data-testid="controls-why">
        {shown(stopping
          ? 'Stopping now: the step in progress is interrupted; its teardown hooks and pending rollbacks still run — their result shows in the steps.'
          : paused
            ? `Paused before ${s.paused ? stepWords(s.paused.scene, s.paused.step) : fb?.paused ? stepWords(fb.paused.scene, fb.paused.step) : 'the next step'}.${mode === 'capture' ? ' The video does not show the pause; the page keeps running, so what changes on it meanwhile shows as a jump when the capture goes on.' : ''} ${
                s.paused?.max_ms ? `A pause longer than ${pauseMaxWords(s.paused.max_ms)} stops the run` : 'A pause longer than its limit (RETAKE_PAUSE_MAX_MIN, 30 minutes by default) stops the run'
              }; its teardown runs.`
            : pauseAsked
              ? 'Pausing before the next step: the current step finishes first.'
              : (why ?? `Pause waits for the current step to finish${mode === 'capture' ? ' (the video does not show the pause)' : ''}; Stop stops now — the step in progress is interrupted — and still runs the teardown and rollbacks.`))}
      </p>
      {said && (
        <p className="sp-error" role="alert" data-testid="controls-error">
          <Txt text={said} />
        </p>
      )}
    </>
  );
}

function HookItem({ h }: { h: HookRow }) {
  const [word, mark] = HOOK_WORDS[h.status] ?? ['unknown', 'idle'];
  if (h.marker) {
    return (
      <li className="sp-row" data-testid="run-hook-phase" data-phase={h.phase}>
        <span className="sp-row-mark" data-state="running">
          <Shape state="running" />
        </span>
        <span className="sp-row-text">
          <Txt text={`${PHASE_WORDS[h.phase] ?? h.phase}s${h.message ? ` — ${h.message}` : ''}`} />
        </span>
        <span className="sp-row-state">running</span>
      </li>
    );
  }
  return (
    <li className="sp-row" data-testid="run-hook" data-phase={h.phase} data-status={h.status}>
      <span className="sp-row-mark" data-state={mark}>
        <Shape state={mark} />
      </span>
      <span className="sp-row-text">
        <Txt text={`${PHASE_WORDS[h.phase] ?? h.phase} ${h.name}`} />
      </span>
      <span className="sp-row-state">{shown(word)}</span>
      {h.message && (
        <div className="sb-from-page sp-row-more">
          <p className="sb-from-page-title">Its message</p>
          <p className="sb-pre">
            <Txt text={h.message} />
          </p>
        </div>
      )}
    </li>
  );
}

function StepList({ s, fb, finished, mode }: { s: RunLiveState; fb: RunStatusLite | null; finished: boolean; mode: string | undefined }) {
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLOListElement>(null);
  const rows = stepRows(s);
  const cur = s.paused ?? s.current;
  const curKey = cur ? stepKey(cur.scene, cur.step) : null;
  useEffect(() => {
    if (!follow || !curKey || !box.current) return;
    // The inspector pane is the scroller: the current row is brought into view there (nothing moves when it is visible).
    box.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(curKey)}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
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
    <InspectorSection title="Steps" testId="steps-section">
      <Switch label="Follow current step" checked={follow} onChange={setFollow} testId="steps-follow" />
      <ol className="sp-steps" ref={box} data-testid="run-steps" tabIndex={0} aria-label="Steps of the run">
        {(s.sessions.length > 0 || before.length > 0) && (
          <li className="sp-group">
            <p className="sp-group-head">Before filming</p>
            <ol className="sp-group-rows">
              {s.sessions.map((p) => {
                const [word, mark] = SESSION_WORDS[p.status] ?? ['unknown', 'idle'];
                return (
                  <li key={p.persona} className="sp-row" data-testid="run-session" data-persona={p.persona} data-status={p.status}>
                    <span className="sp-row-mark" data-state={mark}>
                      <Shape state={mark} />
                    </span>
                    <span className="sp-row-text">
                      <Txt text={`Session of ${p.persona}`} />
                    </span>
                    <span className="sp-row-state">{shown(word)}</span>
                    {p.detail && (
                      <div className="sb-from-page sp-row-more">
                        <p className="sb-from-page-title">From the page</p>
                        <p className="sb-pre">
                          <Txt text={p.detail} />
                        </p>
                      </div>
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
        {scenes.map((g, gi) => {
          const ms = g.steps.reduce((t, r) => t + (s.steps[stepKey(r.scene, r.step)]?.ms ?? 0), 0);
          return (
            <li key={`${g.scene}-${gi}`} className="sp-group">
              <p className="sp-group-head">
                <Txt text={g.scene} />
                {g.steps.some((r) => r.offscreen) && <span className="sc-quiet"> · off camera</span>}
                {ms > 0 && <span className="sp-row-state k-mono">{shown(seconds(ms))}</span>}
              </p>
              <ol className="sp-group-rows">
                {g.steps.map((r) => {
                  const k = stepKey(r.scene, r.step);
                  const st = s.steps[k];
                  // The step a stop interrupted says "stopped here", not a failure of the step; a skipped hook says so.
                  const status = stepStatus(s, r, finished);
                  const stopped = status === 'stopped';
                  const [word, mark] = stepWordsOf(status, mode);
                  const hooks = s.stepHooks[k] ?? [];
                  const pausedHere = s.paused !== null && s.paused.scene === r.scene && s.paused.step === r.step;
                  const current = k === curKey;
                  return (
                    <li key={k} className="sp-row sp-step" data-testid="run-step" data-key={k} data-status={status} aria-current={current ? 'step' : undefined}>
                      <span className="sp-row-mark" data-state={pausedHere ? 'warn' : mark}>
                        <Shape state={pausedHere ? 'warn' : mark} />
                      </span>
                      <span className="sp-row-n k-mono">{shown(r.step + 1)}</span>
                      <span className="sp-row-text">
                        {r.action && <Txt className="k-mono sp-row-action" text={r.action} />} {r.desc && <Txt text={r.desc} />}
                      </span>
                      <span className="sp-row-state">{shown(pausedHere ? 'paused before this step' : st?.ms !== undefined ? `${word} · ${seconds(st.ms)}` : word)}</span>
                      {st?.message && !stopped && (
                        <div className="sb-from-page sp-row-more">
                          <p className="sb-from-page-title">Its message (it may quote the page)</p>
                          <p className="sb-pre">
                            <Txt text={runErrorWords(st.message)} />
                          </p>
                        </div>
                      )}
                      {hooks.length > 0 && (
                        <ol className="sp-group-rows sp-row-more" data-testid="run-step-hooks">
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
          );
        })}
        {rows.length === 0 && fb && (
          <li className="sp-row" data-testid="run-fallback-step">
            <span className="sp-row-text">
              {fb.current && !fb.paused ? <Txt text={`Now: ${stepWords(fb.current.scene, fb.current.step)} (${fb.current.action}).`} /> : <Txt text={fb.paused ? `Paused before ${stepWords(fb.paused.scene, fb.paused.step)}.` : `${RUN_STATUS_WORDS[fb.status] ?? 'unknown'}.`} />}{' '}
              <span className="sc-quiet">The step list and the log are on the other screen following this run.</span>
            </span>
          </li>
        )}
        {rows.length === 0 && !fb && (
          <li className="sp-row">
            <span className="sp-row-text sc-quiet">{finished ? 'No step ran.' : 'The steps show when the run starts (a queued run waits for the worker).'}</span>
          </li>
        )}
        {(after.length > 0 || s.encode) && (
          <li className="sp-group">
            <p className="sp-group-head">After the scenes</p>
            <ol className="sp-group-rows">
              {after.map((h, i) => (
                <HookItem key={`a${i}`} h={h} />
              ))}
              {s.encode && (
                <li className="sp-row" data-testid="run-encode">
                  <span className="sp-row-mark" data-state={s.encode === 'done' ? 'ok' : 'running'}>
                    <Shape state={s.encode === 'done' ? 'ok' : 'running'} />
                  </span>
                  <span className="sp-row-text">Encoding the video</span>
                  <span className="sp-row-state">{s.encode === 'done' ? 'done' : 'running'}</span>
                </li>
              )}
            </ol>
          </li>
        )}
      </ol>
      {s.outlineTruncated && <p className="sc-quiet">The run has more steps than the list shows.</p>}
    </InspectorSection>
  );
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
    <InspectorSection title="Log" testId="log-section">
      <div className="sp-log-tools">
        <Select
          layout="inline"
          label="Show"
          value={filter}
          options={[
            { value: 'all', label: 'every line' },
            { value: 'warn', label: 'warnings and errors' },
          ]}
          onChange={(v) => setFilter(v as 'all' | 'warn')}
        />
        <Switch label="Follow" checked={follow} onChange={setFollow} testId="log-follow" />
      </div>
      {(dropped > 0 || truncated) && (
        <p className="sc-quiet">
          {truncated ? 'A long log: read from its end. ' : ''}
          {shown(dropped > 0 ? `${plural(dropped, 'earlier line')} not shown (the screen keeps the last ${LOG_KEEP}).` : '')}
        </p>
      )}
      <ol className="sp-log" ref={box} data-testid="run-log" tabIndex={0} aria-label="Log lines">
        {lines.map((l) => (
          <li key={l.key} data-level={l.level} data-testid="log-line" className="sp-log-line">
            {l.ts && (
              <time className="sc-quiet k-mono" dateTime={l.ts}>
                {shown(clock(l.ts, true))}
              </time>
            )}
            <span className="sp-log-level" data-level={l.level}>
              {shown(LEVEL_WORDS[l.level] ?? 'info')}
            </span>
            {l.from !== 'run' && <span className="sc-quiet">{l.from === 'worker' ? 'worker:' : 'Studio:'}</span>}
            <Txt className="sp-log-text" text={l.text} />
          </li>
        ))}
        {lines.length === 0 && <li className="sc-quiet">No line yet.</li>}
      </ol>
    </InspectorSection>
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
  const fromStep = e?.error?.step !== undefined;
  const counts = stepCounts(s, stepRows(s), true);
  return (
    <Callout state={ok ? 'ok' : status === 'cancelled' ? 'warn' : 'fail'} role="note" title={endedWords(status)}>
      <div className="sp-outcome" data-testid="run-outcome" data-status={status}>
        {e && (
          <p>
            <Txt
              text={`${s.outline ? counts.done : (e.steps_done ?? 0)}/${plural(e.steps_total, 'step')} done${s.outline && counts.skipped > 0 ? ` (${counts.skipped} skipped)` : ''}${e.stopped_at ? ` · stopped before ${stepWords(e.stopped_at.scene, e.stopped_at.step)} (${e.stopped_at.reason === 'until' ? 'until' : 'an irreversible step'})` : ''}${e.warnings > 0 ? ` · ${plural(e.warnings, 'warning')}` : ''}${e.optional_failures ? ` · ${plural(e.optional_failures, 'optional step')} failed` : ''}`}
            />
          </p>
        )}
        {e?.hooks && noHook(e.hooks.setup) && noHook(e.hooks.teardown) && rollbacks.length === 0 && <p data-testid="outcome-hooks">{mode === 'dry' ? 'No hook ran (a rehearsal skips them).' : 'No hook ran.'}</p>}
        {e?.hooks && !(noHook(e.hooks.setup) && noHook(e.hooks.teardown) && rollbacks.length === 0) && (
          <p data-testid="outcome-hooks">
            <Txt text={`Setup: ${e.hooks.setup}${setup.length > 0 ? ` (${hookLine(setup)})` : ''} · Teardown: ${e.hooks.teardown}${teardown.length > 0 ? ` (${hookLine(teardown)})` : ''}${rollbacks.length > 0 ? ` · Rollbacks: ${hookLine(rollbacks)}` : ''}`} />
          </p>
        )}
        {status === 'cancelled' && (
          <p data-testid="outcome-stopped">
            <Txt
              text={`Stopped from the Studio or by Claude. ${teardown.length > 0 ? `Its teardown ran: ${hookLine(teardown)}.` : e?.hooks?.teardown === 'skipped' || e?.hooks?.teardown === 'none' ? 'It had no teardown to run.' : ''} ${rollbacks.length > 0 ? `Rollbacks: ${hookLine(rollbacks)}.` : 'No rollback was pending.'}`}
            />
          </p>
        )}
        {pauseLate && <p data-testid="outcome-pause-late">The pause came too late: the run ended before its next step.</p>}
        {e?.untrusted?.error && status !== 'cancelled' && fromStep && (
          <div className="sb-from-page" data-testid="outcome-error" data-from="step">
            <p className="sb-from-page-title">
              <Txt text={`Its error${where ? ` (${where})` : ''} — it may quote the page (text the site controls)`} />
            </p>
            <p className="sb-pre">
              <Txt text={runErrorWords(e.untrusted.error)} />
            </p>
          </div>
        )}
        {e?.untrusted?.error && status !== 'cancelled' && !fromStep && (
          <div data-testid="outcome-error" data-from="run">
            <p>
              <Txt text={`Its error${where ? ` (${where})` : ''}:`} />
            </p>
            <p className="sb-pre">
              <Txt text={runErrorWords(e.untrusted.error)} />
            </p>
          </div>
        )}
        {e?.untrusted?.warnings && e.untrusted.warnings.length > 0 && (
          <Disclosure summary="Warnings">
            <ul>
              {e.untrusted.warnings.map((w, i) => (
                <li key={i}>
                  <Txt text={w} />
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        <div className="pr-actions">
          {ok && mode === 'capture' && (
            <LinkButton size="sm" variant="primary" to={{ name: 'timeline', slug, scenario: name, run: runId }} testId="outcome-timeline">
              Open in Edit
            </LinkButton>
          )}
          {ok && mode === 'dry' && (
            <Button size="sm" variant="record" data-testid="outcome-capture" onClick={() => runShellCommand('capture')}>
              Start capture
            </Button>
          )}
          {!ok && (
            <Button size="sm" data-testid="outcome-rehearse" onClick={() => runShellCommand('rehearse')}>
              Rehearse again
            </Button>
          )}
          <LinkButton size="sm" variant="ghost" to={{ name: 'scenario', slug, scenario: name, tab: 'blocks' }} testId="outcome-board">
            Back to the board
          </LinkButton>
        </div>
      </div>
    </Callout>
  );
}

export function ShootLive({ slug, name, runId }: { slug: string; name: string; runId: string }) {
  const view = useRef<LiveViewHandle>(null);
  // Prepare's "Live picture during a capture": on from the start; else the mode's default (a rehearsal on, a capture off).
  const [frames, setFrames] = useState<boolean | null>(() => (capturePictureOn() ? true : null));
  const onFrame = useCallback((f: LiveFrame) => view.current?.draw(f), []);
  const { state: s, conn, error, fallback } = useRunLive(slug, runId, frames, onFrame);
  const project = useProjectView(slug);
  const p = project.state === 'ready' ? project.data : null;
  const loc = useRunLocation(slug, name, p?.environments ?? null);
  const actions = useScenarioActions(slug, name, loc.sent);
  const st = runState(s, fallback);
  // A pause still asked (not yet taken) when the run ended: it came too late (B15). The last value seen while running.
  const pauseWaiting = useRef(false);
  if (!st.finished) pauseWaiting.current = Boolean(s.job?.pause_requested) && s.paused === null;
  const mode = s.start?.mode ?? s.hello?.mode ?? fallback?.mode;
  const pictureShown = frames ?? mode === 'dry';
  const terminal = s.hello !== null && s.hello.job === null;
  const canToggle = conn !== 'busy' && !terminal && !st.finished && mode !== undefined;
  const pauseLate = st.finished && pauseWaiting.current;
  const toggle = () => {
    if (pictureShown) view.current?.clear();
    setFrames(!pictureShown);
  };
  // The one polite status line: the run's state in words, only when it changes.
  const statusLine = st.finished ? `${endedWords(st.word)}.` : st.word === 'paused' ? 'Paused.' : st.word === 'stopping' ? 'Stopping.' : st.word === 'queued' ? 'Queued.' : st.word === 'running' ? 'Running.' : '';
  const rows = stepRows(s);
  const total = s.start?.steps_total ?? (rows.length || fallback?.steps_total || 0);
  // Done means its row says done: a failed step is not counted (run_status's steps_done counts every step that ended).
  const counts = s.start ? stepCounts(s, rows, st.finished) : null;
  const done = counts ? counts.done : (fallback?.steps_done ?? 0);
  // A run that ended without its run_end (its worker killed): the clock stops at its last event.
  const to = s.end?.ts ?? (st.finished ? (s.lastTs ?? undefined) : undefined);
  const elapsed = useElapsed(s.start?.ts, to);
  const cur = s.paused ?? s.current;
  const curRow = cur ? rows.find((r) => r.scene === cur.scene && r.step === cur.step) : undefined;
  const envFlags = s.start ? envFlagWords({ production: s.start.production ?? false, access: s.start.access === 'read-only' ? 'read-only' : 'read-write', sandbox: false }, false) : '';
  const title = mode ? `${modeWord(mode)} of ${name}` : `Run of ${name}`;
  // Opened by a start from this tab: the title takes the focus (review A-M2 of L5.11a: the start button went with
  // Prepare; the focus is never left on <body>).
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (takeLiveFocus(runId)) h1.current?.focus({ preventScroll: true });
  }, [runId]);

  if (error) {
    return (
      <div className="sc-screen sp-screen">
        <h1 className="sc-h1">
          <Txt text={`Run of ${name}`} />
        </h1>
        <Callout state="fail" role="alert" title="This run cannot be followed">
          <p className="sb-pre" data-testid="run-error">
            <Txt text={error.message} />
          </p>
          <p>
            <LinkButton size="sm" to={{ name: 'run', slug, scenario: name }}>
              Back to Prepare
            </LinkButton>
          </p>
        </Callout>
      </div>
    );
  }
  return (
    <div className="sc-screen sp-screen sp-live-screen" data-read={s.hello !== null || fallback !== null ? 'yes' : 'no'}>
      <ShellSlot name="context">
        <span className="sc-quiet" data-testid="live-location">
          <Txt text={s.start?.env ? `Location ${s.start.env}${envFlags ? ` · ${envFlags}` : ''}` : ''} />
        </span>
      </ShellSlot>
      <ShellSlot name="browser">
        <ShootBrowser slug={slug} name={name} runs={actions.state === 'ready' ? actions.data.runs : null} current={runId} />
      </ShellSlot>
      <ShellSlot name="inspector" inline="Steps and log">
        <StepList s={s} fb={conn === 'busy' ? fallback : null} finished={st.finished} mode={mode} />
        <LogPanel log={s.log} dropped={s.logDropped} truncated={s.truncated} />
      </ShellSlot>
      <header className="sp-head">
        <h1 className="sc-h1" ref={h1} tabIndex={-1} data-testid="live-title">
          <Txt text={title} />
        </h1>
        {cur && !st.finished && (
          <p data-testid="live-step">
            <Txt text={`${cur.scene} · step ${cur.step + 1}${curRow?.desc ? ` · ${curRow.desc}` : curRow?.action ? ` · ${curRow.action}` : ''}`} />
          </p>
        )}
        <p className="sc-quiet" data-testid="run-facts">
          <StatusMark state={STATE_MARK[st.word] ?? 'idle'} word={<Txt text={stateWord(st.word)} />} />
          {s.start?.ts && <Txt text={` · Started ${clock(s.start.ts)}`} />}
          {s.start?.env && <Txt text={` · ${s.start.env}${envFlags ? ` (${envFlags})` : ''}`} />}
          {s.start?.until && <Txt text={` · until ${s.start.until}`} />}
          <Txt className="k-mono sp-run-id" text={` · ${runId}`} />
        </p>
      </header>
      <p className="k-sr" role="status" data-testid="run-status-line">
        {shown(statusLine)}
      </p>
      {conn === 'busy' && (
        <Callout state="idle" role="note" title="Followed without its stream">
          <p data-testid="run-busy">
            This Studio streams two live runs at a time and both streams are taken (another tab?): this screen reads the run's status every few seconds, without the picture, steps or log.
            Close the other live screen to see them here.
          </p>
        </Callout>
      )}
      {conn === 'retrying' && (
        <p className="sc-quiet" data-testid="run-retrying">
          The run's stream dropped: reconnecting…
        </p>
      )}
      {(st.finished || s.ended) && <Outcome slug={slug} name={name} runId={runId} s={s} mode={mode} pauseLate={pauseLate} />}
      <LiveView
        ref={view}
        picture={conn === 'busy' ? { state: 'busy' } : st.finished ? { state: 'ended' } : terminal ? (s.picture ?? { state: 'none' }) : s.picture}
        shown={pictureShown}
        capture={mode === 'capture'}
        onToggle={canToggle ? toggle : null}
        {...(conn === 'busy' ? { note: 'No live picture in this tab (another live screen holds the stream).' } : conn === 'hidden' ? { note: 'The picture stops while this tab is hidden.' } : {})}
      />
      {total > 0 && (
        <div className="sp-progress">
          <Progress label="Steps done" value={Math.min(done, total)} max={total} valueText={`${done} of ${total}`} />
          <p className="sc-quiet" data-testid="run-steps-done">
            <Txt text={`${done} / ${plural(total, 'step')} done${counts && counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ''}${elapsed ? ` · ${elapsed} elapsed` : ''}`} />
          </p>
        </div>
      )}
      {!st.finished && mode && <p className="sc-quiet">{mode === 'dry' ? 'A rehearsal takes a screenshot per step and runs no hooks.' : 'A capture runs its hooks and films the video.'}</p>}
      <Controls slug={slug} name={name} runId={runId} s={s} fb={fallback} mode={mode} finished={st.finished} />
    </div>
  );
}
