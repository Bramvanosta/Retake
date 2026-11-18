/**
 * One run, live (`#/p/<slug>/s/<name>/run/<run_id>`, R4-ShootLive; R-UI-41) — any run of the scenario: the
 * Studio's, Claude's, a terminal's (the last without picture), on the kit:
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
 *   not film the pause) and Stop (run_cancel: its teardown and rollbacks still run; a terminal's run:
 *   Ctrl-C there). ⌘. stops THIS run (it outranks the status bar's defaults: command-bus.ts). Once it ended the
 *   defaults come back (Rehearse, Capture, Render).
 *
 * Every text from the run (step descriptions, messages, the filmed site's text) is a text node (Txt); the site's text
 * sits in "From the page" boxes; a run's error is "from the page" only when a step raised it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Txt, contentKeys, plural, shown } from '../bits.js';
import { envFlagWords } from '../words/board-words.js';
import { LiveView } from './LiveView.js';
import type { LiveViewHandle } from './LiveView.js';
import { useProjectView } from '../project-data.js';
import { stepCounts, stepKey, stepStatus, useRunLive } from './run-live.js';
import type { HookRow, LiveFrame, OutlineStep, RunLiveState, RunStatusLite, StepRowStatus } from './run-live.js';
import { useRunLocation } from './run-location.js';
import { RUN_STATUS_WORDS, runErrorWords, seconds, stepWords } from '../words/scenario-words.js';
import { ShellSlot } from '../shell/slots.js';
import { ToolsNeeded } from '../shell/tools-parts.js';
import { capturePictureOn, takeLiveFocus, useScenarioActions } from './shoot-data.js';
import { ShootBrowser } from './ShootBrowser.js';
import { modeWord } from '../words/shoot-words.js';
import { Callout, InspectorSection, LinkButton, Progress, Shape, StatusMark, Switch } from '../ui-kit/index.js';
import type { MarkState } from '../ui-kit/index.js';
import { STATE_MARK, clock, endedWords, runState, stateWord, stepRows } from './live-state.js';
import { Controls } from './live-controls.js';
import { HookItem, LogPanel, Outcome } from './live-panels.js';

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

/** A hook row is its phase, name and outcome (a phase's marker row is replaced by the hook's own result). */
const hookKey = (h: HookRow) => `${h.phase}:${h.name}:${h.marker ? 'marker' : h.status}`;

/** A persona's session before filming: its state in words, and what the page said. */
function SessionRow({ p }: { p: RunLiveState['sessions'][number] }) {
  const [word, mark] = SESSION_WORDS[p.status] ?? ['unknown', 'idle'];
  return (
    <li className="sp-row" data-testid="run-session" data-persona={p.persona} data-status={p.status}>
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
}

/** One step of a scene: its live status (the current one marked), its message and its `hook:` entries. */
function StepRow({ s, r, finished, mode, curKey }: { s: RunLiveState; r: OutlineStep; finished: boolean; mode: string | undefined; curKey: string | null }) {
  const k = stepKey(r.scene, r.step);
  const st = s.steps[k];
  // The step a stop interrupted says "stopped here", not a failure of the step; a skipped hook says so.
  const status = stepStatus(s, r, finished);
  const stopped = status === 'stopped';
  const [word, mark] = stepWordsOf(status, mode);
  const hooks = s.stepHooks[k] ?? [];
  const hookKeys = contentKeys(hooks, hookKey);
  const pausedHere = s.paused !== null && s.paused.scene === r.scene && s.paused.step === r.step;
  const current = k === curKey;
  return (
    <li className="sp-row sp-step" data-testid="run-step" data-key={k} data-status={status} aria-current={current ? 'step' : undefined}>
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
            <HookItem key={hookKeys[i]} h={h} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** After the scenes: the teardown hooks, the rollbacks and the encoding. */
function AfterScenes({ after, encode }: { after: HookRow[]; encode: RunLiveState['encode'] }) {
  const afterKeys = contentKeys(after, hookKey);
  return (
    <li className="sp-group">
      <p className="sp-group-head">After the scenes</p>
      <ol className="sp-group-rows">
        {after.map((h, i) => (
          <HookItem key={afterKeys[i]} h={h} />
        ))}
        {encode && (
          <li className="sp-row" data-testid="run-encode">
            <span className="sp-row-mark" data-state={encode === 'done' ? 'ok' : 'running'}>
              <Shape state={encode === 'done' ? 'ok' : 'running'} />
            </span>
            <span className="sp-row-text">Encoding the video</span>
            <span className="sp-row-state">{encode === 'done' ? 'done' : 'running'}</span>
          </li>
        )}
      </ol>
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
  // A `hook:` step's entries (phase `step`) are on its step row (s.stepHooks), not "after the scenes".
  const after = s.hooks.filter((h) => h.phase !== 'setup' && h.phase !== 'step');
  // A group is its scene.
  const beforeKeys = contentKeys(before, hookKey);
  const sceneKeys = contentKeys(scenes, (g) => g.scene);
  return (
    <InspectorSection title="Steps" testId="steps-section">
      <Switch label="Follow current step" checked={follow} onChange={setFollow} testId="steps-follow" />
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the steps list scrolls on its own: its tab stop lets a keyboard scroll it */}
      <ol className="sp-steps" ref={box} data-testid="run-steps" tabIndex={0} aria-label="Steps of the run">
        {(s.sessions.length > 0 || before.length > 0) && (
          <li className="sp-group">
            <p className="sp-group-head">Before filming</p>
            <ol className="sp-group-rows">
              {s.sessions.map((p) => (
                <SessionRow key={p.persona} p={p} />
              ))}
              {before.map((h, i) => (
                <HookItem key={beforeKeys[i]} h={h} />
              ))}
            </ol>
          </li>
        )}
        {scenes.map((g, gi) => {
          const ms = g.steps.reduce((t, r) => t + (s.steps[stepKey(r.scene, r.step)]?.ms ?? 0), 0);
          return (
            <li key={sceneKeys[gi]} className="sp-group">
              <p className="sp-group-head">
                <Txt text={g.scene} />
                {g.steps.some((r) => r.offscreen) && <span className="sc-quiet"> · off camera</span>}
                {ms > 0 && <span className="sp-row-state k-mono">{shown(seconds(ms))}</span>}
              </p>
              <ol className="sp-group-rows">
                {g.steps.map((r) => (
                  <StepRow key={stepKey(r.scene, r.step)} s={s} r={r} finished={finished} mode={mode} curKey={curKey} />
                ))}
              </ol>
            </li>
          );
        })}
        {rows.length === 0 && fb && (
          <li className="sp-row" data-testid="run-fallback-step">
            <span className="sp-row-text">
              {fb.current && !fb.paused ? (
                <Txt text={`Now: ${stepWords(fb.current.scene, fb.current.step)} (${fb.current.action}).`} />
              ) : (
                <Txt text={fb.paused ? `Paused before ${stepWords(fb.paused.scene, fb.paused.step)}.` : `${RUN_STATUS_WORDS[fb.status] ?? 'unknown'}.`} />
              )}{' '}
              <span className="sc-quiet">The step list and the log are on the other screen following this run.</span>
            </span>
          </li>
        )}
        {rows.length === 0 && !fb && (
          <li className="sp-row">
            <span className="sp-row-text sc-quiet">{finished ? 'No step ran.' : 'The steps show when the run starts (a queued run waits for the worker).'}</span>
          </li>
        )}
        {(after.length > 0 || s.encode) && <AfterScenes after={after} encode={s.encode} />}
      </ol>
      {s.outlineTruncated && <p className="sc-quiet">The run has more steps than the list shows.</p>}
    </InspectorSection>
  );
}

/** The one polite status line: the run's state in words. */
function statusLineOf(st: { word: string; finished: boolean }): string {
  return st.finished ? `${endedWords(st.word)}.` : st.word === 'paused' ? 'Paused.' : st.word === 'stopping' ? 'Stopping.' : st.word === 'queued' ? 'Queued.' : st.word === 'running' ? 'Running.' : '';
}

/** A run that cannot be followed: its error and the way back to Prepare. */
function RunUnfollowed({ slug, name, message }: { slug: string; name: string; message: string }) {
  return (
    <div className="sc-screen sp-screen">
      <h1 className="sc-h1">
        <Txt text={`Run of ${name}`} />
      </h1>
      <Callout state="fail" role="alert" title="This run cannot be followed">
        <p className="sb-pre" data-testid="run-error">
          <Txt text={message} />
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

/** The centre's head: the title (focused when a start from this tab opened it), the current step, the run's facts. */
function LiveHead({
  h1,
  title,
  s,
  st,
  curRow,
  envFlags,
  runId,
}: {
  h1: RefObject<HTMLHeadingElement | null>;
  title: string;
  s: RunLiveState;
  st: { word: string; finished: boolean };
  curRow: OutlineStep | undefined;
  envFlags: string;
  runId: string;
}) {
  const cur = s.paused ?? s.current;
  return (
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
  );
}

/** The stream refused (another live screen holds it), or reconnecting. */
function StreamNotices({ conn }: { conn: string }) {
  return (
    <>
      {conn === 'busy' && (
        <Callout state="idle" role="note" title="Followed without its stream">
          <p data-testid="run-busy">
            This Studio streams two live runs at a time and both streams are taken (another tab?): this screen reads the run's status every few seconds, without the picture, steps or log. Close the
            other live screen to see them here.
          </p>
        </Callout>
      )}
      {conn === 'retrying' && (
        <p className="sc-quiet" data-testid="run-retrying">
          The run's stream dropped: reconnecting…
        </p>
      )}
    </>
  );
}

/** The live screen's note of an iOS take. */
export const DEVICE_PICTURE_NOTE = 'No live picture of an iOS take: the simulator is filmed, not streamed.';

/** Whether the run's environment (`env`, from its start) is an iOS one of the project. Pure. */
export function deviceRun(envs: ReadonlyArray<{ name: string; ios?: unknown }> | null, env: string | undefined): boolean {
  return env !== undefined && (envs ?? []).some((e) => e.name === env && e.ios !== undefined);
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
  // A pause still asked (not yet taken) when the run ended: it came too late. The last value seen while running.
  const pauseWaiting = useRef(false);
  if (!st.finished) pauseWaiting.current = Boolean(s.job?.pause_requested) && s.paused === null;
  const mode = s.start?.mode ?? s.hello?.mode ?? fallback?.mode;
  // An iOS take: no pause, no live picture (the simulator's screen is not streamed).
  const device = deviceRun(p?.environments ?? null, s.start?.env);
  const pictureShown = !device && (frames ?? mode === 'dry');
  const terminal = s.hello !== null && s.hello.job === null;
  const canToggle = conn !== 'busy' && !terminal && !st.finished && mode !== undefined && !device;
  const pauseLate = st.finished && pauseWaiting.current;
  const toggle = () => {
    if (pictureShown) view.current?.clear();
    setFrames(!pictureShown);
  };
  // The one polite status line: the run's state in words, only when it changes.
  const statusLine = statusLineOf(st);
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
  // Opened by a start from this tab: the title takes the focus (the start button went with Prepare; the focus is
  // never left on <body>).
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (takeLiveFocus(runId)) h1.current?.focus({ preventScroll: true });
  }, [runId]);

  if (error) return <RunUnfollowed slug={slug} name={name} message={error.message} />;
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
      <LiveHead h1={h1} title={title} s={s} st={st} curRow={curRow} envFlags={envFlags} runId={runId} />
      <p className="k-sr" role="status" data-testid="run-status-line">
        {shown(statusLine)}
      </p>
      <StreamNotices conn={conn} />
      {/* Only while the queue holds it for the Tools (a project on a browser of its own waits for none). */}
      {st.word === 'queued' && !st.finished && s.job?.waits_for && <ToolsNeeded need={s.job.waits_for} what={mode === 'dry' ? 'This rehearsal' : 'This capture'} queued testId="live-tools" />}
      {(st.finished || s.ended) && <Outcome slug={slug} name={name} runId={runId} s={s} mode={mode} pauseLate={pauseLate} />}
      <LiveView
        ref={view}
        picture={conn === 'busy' ? { state: 'busy' } : st.finished ? { state: 'ended' } : terminal ? (s.picture ?? { state: 'none' }) : s.picture}
        shown={pictureShown}
        capture={mode === 'capture'}
        onToggle={canToggle ? toggle : null}
        {...(device
          ? { note: DEVICE_PICTURE_NOTE }
          : conn === 'busy'
            ? { note: 'No live picture in this tab (another live screen holds the stream).' }
            : conn === 'hidden'
              ? { note: 'The picture stops while this tab is hidden.' }
              : {})}
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
      <Controls slug={slug} name={name} runId={runId} s={s} fb={fallback} mode={mode} finished={st.finished} device={device} />
      {/* The run ended but the scenario's actions, read before, still say it runs until their reload lands: the bar
          stays claimed (empty) meanwhile, so the status bar never offers Pause or Stop for an ended run. */}
      {st.finished && actions.state === 'ready' && actions.data.running?.id === runId && <ShellSlot name="actions">{null}</ShellSlot>}
    </div>
  );
}
