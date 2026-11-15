/**
 * Prepare a take (`#/p/<slug>/s/<name>/run`, R4-ShootPrep; R-UI-40) — Shoot's first screen: what a rehearsal or a
 * capture of the scenario would do, before anything runs. Nothing here runs anything; no page is probed.
 *
 * - Title bar context: the Location (run-location.ts: ONE choice per scenario in this tab, shared with the Scenario
 *   screen and the status bar; sent only when it is not the file's own). Browser: ShootBrowser (Prepare, the runs,
 *   Record a scenario). Inspector: the Last take (the board's poster, its facts, Open in Edit, Open its run).
 * - Centre: a checklist — the Location (its flags in words, its pages and what the video shows instead); the Sessions
 *   this run signs in with (Sessions.tsx SessionRows: state, last check, Sign in… for each; the issues; "a capture asks
 *   first" when one must be confirmed); what would stop a run (one kit Blocker per refusal, in the gate's words with its
 *   message and its command to copy — the command through node for a person without `retake` on their PATH in a
 *   disclosure; a rehearsal that is not affected said so); the live picture during a capture (a per-tab switch, off by
 *   default). Then Start rehearsal and ● Start capture, each with what stops it beside a disabled one, the mapping line
 *   "Rehearse = a dry run", a run of the scenario already going (Watch), a refusal with its command.
 * - A start opens the run's live route. A capture with sessions to confirm asks first (the shell's one sheet: Sign in
 *   first… is its default). ⌘R and ⇧⌘R act here as the buttons do (priority: the screen's own, command-bus.ts).
 * - The status bar is this screen's (no Start buttons there: they are on screen) — its state, and Pause / Stop while a
 *   run of the scenario is unfinished (one Stop, visible).
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { BoardScenario, RunBlocker } from '@retake/engine';
import type { Loaded, OpResult } from '../api.js';
import { runThumbs } from '../data/scenarios.js';
import { useScenarioSessions } from '../data/shoot.js';
import { Txt, When, plural, shown } from '../bits.js';
import { envFlagWords, lastTakeWords, lengthWords } from '../words/board-words.js';
import { useScenarioEvents } from '../events.js';
import { reloadProject, useBoard, useProjectView } from '../project-data.js';
import { hrefTo } from '../route.js';
import { chooseLocation, useRunLocation } from './run-location.js';
import { SessionRows } from '../project/Sessions.js';
import { PRIORITY, useShellCommand } from '../shell/command-bus.js';
import { say } from '../shell/say.js';
import { ShellSlot } from '../shell/slots.js';
import {
  askSignIn,
  focusLiveOnArrival,
  openSheet,
  pauseRun,
  reloadActions,
  startRun,
  stopRun,
  useCapturePicture,
  useLastStart,
  usePendingRun,
  useRunProgress,
  useScenarioActions,
  useSending,
  useSignInAsk,
} from './shoot-data.js';
import type { LastStart, LiveRun } from './shoot-data.js';
import { ShootBrowser } from './ShootBrowser.js';
import { REHEARSE_MAPPING, SHOOT_STATES, blockerShort, modeWord } from '../words/shoot-words.js';
import { Thumb, ThumbsProvider } from '../Thumb.js';
import { Blocker, Button, Callout, Checklist, ChecklistItem, Disclosure, Facts, InspectorSection, LinkButton, Select, StatusMark, Switch, TerminalCommands } from '../ui-kit/index.js';

/** The blockers of one mode, each a kit Blocker: the gate's words, the message, its command to copy. */
function BlockerList({ list, testId, slug, name }: { list: RunBlocker[]; testId: string; slug: string; name: string }) {
  return (
    <div className="sp-blockers" data-testid={testId}>
      {list.map((b, i) => {
        const s0 = blockerShort(b);
        // A state word beside the mark (the colour-only rule): "Blocked: 1 hook to approve".
        const s = { ...s0, words: `Blocked: ${s0.words}` };
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the blockers, replaced whole on each read and holding no state: the index is the identity
          <div key={i} className="sp-blocker">
            {s.action === 'copy' && b.fix ? (
              <Blocker word={s.words} fix={{ copy: b.fix }}>
                <Txt text={b.message} />
              </Blocker>
            ) : s.action === 'yaml' ? (
              <Blocker word={s.words} fix={{ label: 'Open the YAML', to: { name: 'scenario', slug, scenario: name, tab: 'yaml' } }}>
                <Txt text={b.message} />
              </Blocker>
            ) : (
              <Callout state="attention" title={s.words}>
                <Txt text={b.message} />
              </Callout>
            )}
            {b.fix_node && (
              <Disclosure summary="Without retake on your PATH">
                <TerminalCommands fix={b.fix ?? ''} fixNode={b.fix_node} />
              </Disclosure>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LastTake({ slug, s }: { slug: string; s: BoardScenario | undefined }) {
  const r = s?.last_run;
  if (!s || !r) {
    return (
      <InspectorSection title="Last take">
        <p className="sc-quiet">No take of this scenario yet.</p>
      </InspectorSection>
    );
  }
  const w = lastTakeWords(r);
  return (
    <InspectorSection title="Last take" testId="last-take">
      {s.poster && <Thumb run={s.poster.run} runKey={s.poster.key} size="inspector" alt={`The last pictured step of ${s.name}`} />}
      <p className="sc-quiet">
        <Txt text={`${modeWord(r.mode)} of ${s.name}${s.env ? ` on ${s.env}` : ''}`} />
      </p>
      <Facts
        rows={[
          { key: 'outcome', label: 'Outcome', value: <StatusMark state={w.state} word={w.words} /> },
          { key: 'when', label: 'When', value: <When iso={r.finished_at ?? r.started_at} /> },
          ...(s.length ? [{ key: 'length', label: 'Length', value: <span className="k-mono">{shown(lengthWords(s.length.seconds))}</span> }] : []),
          { key: 'steps', label: 'Steps', value: <span className="k-mono">{shown(`${r.steps_done} / ${r.steps_total}`)}</span> },
          { key: 'run', label: 'Run', value: <Txt className="k-mono" text={r.id} /> },
        ]}
      />
      <div className="pr-actions">
        {s.capture && (
          <LinkButton size="sm" variant="primary" to={{ name: 'timeline', slug, scenario: s.name, run: s.capture.id }}>
            Open in Edit
          </LinkButton>
        )}
        <LinkButton size="sm" to={{ name: 'run', slug, scenario: s.name, run: r.id }} testId="open-last-run">
          Open its run
        </LinkButton>
      </div>
    </InspectorSection>
  );
}

type ProjectRead = ReturnType<typeof useProjectView>;
type ActionsRead = ReturnType<typeof useScenarioActions>;
type ActionsData = Extract<ActionsRead, { state: 'ready' }>['data'];
type Running = NonNullable<ActionsData['running']>;
type Env = Extract<ProjectRead, { state: 'ready' }>['data']['environments'][number];
type SessionsRead = Loaded<OpResult<'scenario_sessions'>>;
type ToConfirm = Extract<SessionsRead, { state: 'ready' }>['data']['confirm'];
type Mode = 'dry' | 'capture';
const TERMINAL_WHY = 'Started in a terminal: press Ctrl-C there to stop it.';

/** "Sign in <persona> first…" from the sheet: that persona's Sign in button takes the focus here. */
function useSignInFocus(slug: string, name: string, sessionsReady: boolean) {
  const ask = useSignInAsk();
  useEffect(() => {
    if (!ask || ask.slug !== slug || ask.name !== name || !sessionsReady) return;
    const t = window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-testid="preflight-sessions"] [data-testid="session-row"][data-persona="${CSS.escape(ask.persona)}"] [data-testid="sign-in-button"]`)?.focus();
      askSignIn(null);
    }, 60);
    return () => window.clearTimeout(t);
  }, [ask, slug, name, sessionsReady]);
}

/** A refusal of a start from this screen takes the focus (never left on <body>). */
function useRefusalFocus(last: LastStart | undefined) {
  const startedHere = useRef(false);
  const refusedBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!last || !('error' in last) || !startedHere.current) return;
    startedHere.current = false;
    refusedBox.current?.focus();
  }, [last]);
  return { startedHere, refusedBox };
}

/** Why a start of `mode` is off, in words beside its button (null: it is on). */
function startWhy(
  mode: Mode,
  { failed, data, ready, sending, busy, goingMode }: { failed: string | null; data: ActionsData | null; ready: boolean; sending: ReturnType<typeof useSending>; busy: boolean; goingMode: Mode },
): string | null {
  if (failed) return `${failed}: see above`;
  if (!data || !ready) return 'Loading…';
  if (sending) return null;
  if (busy) return `Waits for the ${modeWord(goingMode, true)} of this scenario to end`;
  const b = data.run_blockers[mode][0];
  if (!b) return null;
  const w = blockerShort(b);
  return w.action === 'copy' ? `${w.words}: copy the command above` : w.words;
}

/** The Sessions item's state and word. */
function sessionsStep(sessions: SessionsRead, toConfirm: ToConfirm): { state: 'ok' | 'attention' | 'idle'; word: string } {
  return sessions.state !== 'ready'
    ? { state: 'idle', word: 'Pending' }
    : sessions.data.personas.length === 0
      ? { state: 'ok', word: 'Ready: none needed' }
      : toConfirm.length > 0 || sessions.data.issues.length > 0
        ? { state: 'attention', word: 'Pending: a capture asks first' }
        : { state: 'ok', word: 'Ready' };
}

export function ShootPrepare({ slug, name }: { slug: string; name: string }) {
  const project = useProjectView(slug);
  const p = project.state === 'ready' ? project.data : null;
  const loc = useRunLocation(slug, name, p?.environments ?? null);
  const actions = useScenarioActions(slug, name, loc.sent);
  const data = actions.state === 'ready' ? actions.data : null;
  const boardState = useBoard(slug);
  const s = boardState.state === 'ready' ? boardState.data.scenarios.find((x) => x.name === name) : undefined;
  const [sessions, reloadSessions] = useScenarioSessions({ project: slug, name, mode: 'capture', ...(loc.sent ? { env: loc.sent } : {}) }, `${slug}\0${name}\0${loc.sent ?? ''}`);
  const last = useLastStart(slug, name);
  const sending = useSending(slug, name);
  const pend = usePendingRun(slug, name, data?.runs);
  const [picture, setPicture] = useCapturePicture();
  const running = data?.running ?? null;
  const [live, progress] = useRunProgress(running ? slug : null, running?.id ?? null, () => reloadActions(slug, name));
  useScenarioEvents(slug, name, { reread: reloadSessions, progress: (runs) => progress(runs), jobs: () => progress([]) });
  const fetchThumbs = (run: string, keys: string[], signal: AbortSignal) => runThumbs({ project: slug, run, keys }, { signal });
  useSignInFocus(slug, name, sessions.state === 'ready');

  const fileDefault = s?.env ?? p?.default_env ?? p?.environments[0]?.name;
  const envName = data?.environment?.name ?? loc.sent ?? fileDefault;
  const env = p?.environments.find((e) => e.name === envName);
  const toConfirm = sessions.state === 'ready' ? sessions.data.confirm : [];
  const busy = running !== null || pend !== null;
  // What does not load says so wherever it would wait: the project, or the scenario's actions.
  const failed = project.state === 'error' ? 'The project cannot be read' : actions.state === 'error' ? 'The scenario cannot be read' : null;
  const openLive = (id: string) => {
    focusLiveOnArrival(id);
    location.hash = hrefTo({ name: 'run', slug, scenario: name, run: id });
  };
  const { startedHere, refusedBox } = useRefusalFocus(last);
  const start = (mode: Mode) => {
    if (failed) return say(`${failed}: nothing to start`);
    if (!data || !loc.ready) return say(`Wait: ${name} is still loading`);
    // The buttons stay enabled while a start is sent (a disabled one drops the focus); a repeat sends nothing.
    if (sending) return say(`Wait: the ${modeWord(sending === 'render' ? 'capture' : sending, true)} of ${name} is being started`);
    if (busy) return say(`A ${modeWord(running?.mode ?? pend?.mode ?? 'dry', true)} of ${name} is going: wait for it to end, or stop it`);
    if (data.run_blockers[mode].length > 0) return say(`${modeWord(mode)} of ${name} is blocked: ${blockerShort(data.run_blockers[mode][0]).words}`);
    if (mode === 'capture' && toConfirm.length > 0) {
      openSheet({ slug, name, ...(loc.sent ? { env: loc.sent } : {}), hash: data.hash, sessions: toConfirm, onStarted: openLive });
      return;
    }
    startedHere.current = true;
    startRun({ slug, name, mode, hash: data.hash, ...(loc.sent ? { env: loc.sent } : {}), say, onStarted: openLive });
  };
  useShellCommand('rehearse', () => start('dry'), PRIORITY.screen);
  useShellCommand('capture', () => start('capture'), PRIORITY.screen);

  const whyOf = { failed, data, ready: loc.ready, sending, busy, goingMode: running?.mode ?? pend?.mode ?? 'dry' };
  const dry = data?.run_blockers.dry ?? [];
  const cap = data?.run_blockers.capture ?? [];
  const refusedFixNode = last && 'error' in last && last.fix ? [...dry, ...cap].find((b) => b.fix === last.fix)?.fix_node : undefined;
  const runLive = live && running && live.id === running.id && !live.finished ? live : null;
  const paused = Boolean(runLive?.paused || runLive?.pausing);
  const terminal = running !== null && running.job === null;

  return (
    <div className="sc-screen sp-screen">
      <ShellSlot name="context">
        {p && p.environments.length > 0 && envName && <LocationSelect slug={slug} name={name} environments={p.environments} value={envName} fileDefault={fileDefault} />}
      </ShellSlot>
      <ShellSlot name="browser">
        <ShootBrowser slug={slug} name={name} runs={data?.runs ?? null} current={null} />
      </ShellSlot>
      <ShellSlot name="inspector" inline="Last take">
        <ThumbsProvider fetch={fetchThumbs}>
          <LastTake slug={slug} s={s} />
        </ThumbsProvider>
      </ShellSlot>
      <ShellSlot name="actions">
        <PrepareStatus slug={slug} name={name} failed={failed} data={data} running={running} runLive={runLive} paused={paused} terminal={terminal} progress={progress} />
      </ShellSlot>

      <header className="sp-head">
        <h1 className="sc-h1">
          Prepare a take of <Txt text={name} />
        </h1>
        <p className="sc-quiet">Four checks before the browser opens. Nothing here runs anything.</p>
      </header>
      <LoadNotices dropped={loc.dropped} fileDefault={fileDefault} project={project} actions={actions} />
      <Checklist label={`Before a take of ${name}`}>
        <LocationItem env={env} fileDefault={fileDefault} sent={loc.sent} projectFailed={project.state === 'error'} />
        <SessionsItem slug={slug} name={name} sessions={sessions} toConfirm={toConfirm} reloadSessions={reloadSessions} />
        <BlockersItem slug={slug} name={name} data={data} failed={failed} dry={dry} cap={cap} />
        <PictureItem picture={picture} setPicture={setPicture} />
      </Checklist>

      <RunNotices slug={slug} name={name} running={running} terminal={terminal} last={last} refusedFixNode={refusedFixNode} boxRef={refusedBox} />
      <p className="sc-quiet">{shown(`${REHEARSE_MAPPING} A run can be paused and stopped from the status bar or its screen; stopping still runs its teardown and rollbacks.`)}</p>
      <StartButtons dryWhy={startWhy('dry', whyOf)} capWhy={startWhy('capture', whyOf)} sending={sending} picture={picture} confirmCount={toConfirm.length} start={start} />
    </div>
  );
}

/** The title bar's Location choice: one per scenario in this tab, sent only when it is not the file's own. */
function LocationSelect({ slug, name, environments, value, fileDefault }: { slug: string; name: string; environments: Env[]; value: string; fileDefault: string | undefined }) {
  return (
    <Select
      layout="inline"
      label="Location"
      testId="location-select"
      value={value}
      options={environments.map((e) => {
        const flags = envFlagWords(e, e.name === fileDefault, e.name);
        return { value: e.name, label: `${e.name}${flags ? ` · ${flags}` : ''}` };
      })}
      onChange={(next) => chooseLocation(slug, name, next === fileDefault ? undefined : next)}
    />
  );
}

/** The status bar's part of this screen: the scenario's state, and Pause / Stop while a run of it is unfinished. */
function PrepareStatus({
  slug,
  name,
  failed,
  data,
  running,
  runLive,
  paused,
  terminal,
  progress,
}: {
  slug: string;
  name: string;
  failed: string | null;
  data: ActionsData | null;
  running: Running | null;
  runLive: LiveRun | null;
  paused: boolean;
  terminal: boolean;
  progress: (runs: string[]) => void;
}) {
  const runWord = running
    ? paused
      ? SHOOT_STATES.paused.word(running.mode)
      : runLive?.stopping
        ? SHOOT_STATES.stopping.word(running.mode)
        : running.status === 'queued'
          ? SHOOT_STATES.queued.word(running.mode)
          : SHOOT_STATES.running.word(running.mode)
    : '';
  return (
    <>
      <span className="sh-scenario" data-testid="status-scenario" data-state={failed ? 'failed' : running ? 'running' : 'idle'}>
        {failed && !running ? (
          <StatusMark state="fail" word={<Txt text={`${failed} · ${name}`} />} />
        ) : running ? (
          <StatusMark state={paused || runLive?.stopping ? 'warn' : running.status === 'queued' ? 'waiting' : 'running'} word={<Txt text={runWord} />} />
        ) : (
          <StatusMark state="idle" word={<Txt text={`Idle · ${name}${data ? ` · ${plural(data.content.scenes, 'scene')} · ${plural(data.content.steps, 'step')}` : ''}`} />} />
        )}
      </span>
      {running && (
        <>
          <Button
            size="sm"
            data-testid={paused ? 'run-resume' : 'run-pause'}
            disabled={terminal || running.status !== 'running'}
            aria-describedby="prep-why-run"
            onClick={() => pauseRun({ slug, name, run: running.id, paused: !paused, say, onDone: () => progress([running.id]) })}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            size="sm"
            icon="stop"
            data-testid="run-stop"
            disabled={terminal || Boolean(runLive?.stopping)}
            aria-describedby="prep-why-run"
            onClick={() => stopRun({ slug, name, run: running.id, mode: running.mode, say })}
          >
            Stop
          </Button>
          <span id="prep-why-run" className="k-sr">
            {shown(
              terminal
                ? TERMINAL_WHY
                : running.status === 'queued'
                  ? 'Pause waits until it runs; Stop stops it now.'
                  : 'Pause waits for the current step to finish; Stop stops now and still runs the teardown and rollbacks.',
            )}
          </span>
        </>
      )}
    </>
  );
}

/** What does not load, or a location chosen earlier that is gone. */
function LoadNotices({ dropped, fileDefault, project, actions }: { dropped: string | undefined; fileDefault: string | undefined; project: ProjectRead; actions: ActionsRead }) {
  return (
    <>
      {dropped !== undefined && (
        <Callout state="warn" title="A location chosen earlier is gone" testId="location-dropped">
          <Txt text={`The location ${dropped} chosen earlier is no longer in project.yaml: the runs use the file's own${fileDefault ? `, ${fileDefault}` : ''}.`} />
        </Callout>
      )}
      {project.state === 'error' && (
        <Callout state="fail" role="alert" title="This project cannot be read" testId="prepare-failed">
          <p className="sb-pre">
            <Txt text={project.error} />
          </p>
        </Callout>
      )}
      {project.state !== 'error' && actions.state === 'error' && (
        <Callout state="fail" role="alert" title="This scenario cannot be read" testId="prepare-failed">
          <p className="sb-pre">
            <Txt text={actions.error} />
          </p>
        </Callout>
      )}
    </>
  );
}

/** The Location check: its flags in words, its pages and what the video shows instead. */
function LocationItem({ env, fileDefault, sent, projectFailed }: { env: Env | undefined; fileDefault: string | undefined; sent: string | undefined; projectFailed: boolean }) {
  return (
    <ChecklistItem
      state={env ? (env.production || env.access === 'read-only' ? 'warn' : 'ok') : projectFailed ? 'fail' : 'idle'}
      word={env ? (env.access === 'read-only' ? 'Ready · read-only' : env.production ? 'Ready · production' : 'Ready') : projectFailed ? 'Cannot be read' : 'Pending'}
      title="Location"
      testId="preflight-location"
      level={2}
    >
      {env ? (
        <>
          <p>
            <Txt text={`${env.name}${envFlagWords(env, env.name === fileDefault, env.name) ? ` · ${envFlagWords(env, env.name === fileDefault, env.name)}` : ''}`} />
            {sent ? <Txt text=" — chosen in this tab (the file's own is " /> : null}
            {sent && fileDefault ? <Txt text={`${fileDefault}).`} /> : null}
          </p>
          <ul className="sp-pages">
            {Object.entries(env.pages).map(([k, url]) => (
              <li key={k}>
                <Txt className="k-mono" text={k} />
                {' · '}
                <Txt className="k-mono" text={url} />
                {env.display?.[k] && <Txt className="sc-quiet" text={` · shown as ${env.display[k]}`} />}
              </li>
            ))}
          </ul>
          <p className="sc-quiet">Change it in the title bar.</p>
        </>
      ) : projectFailed ? (
        <p className="sc-quiet">The project does not load: see above.</p>
      ) : (
        <p className="sc-quiet">Reading the project…</p>
      )}
    </ChecklistItem>
  );
}

/** The Sessions check: each persona's last known state with Sign in…, the issues, and "a capture asks first". */
function SessionsItem({ slug, name, sessions, toConfirm, reloadSessions }: { slug: string; name: string; sessions: SessionsRead; toConfirm: ToConfirm; reloadSessions: () => void }) {
  const sessionsState = sessionsStep(sessions, toConfirm);
  return (
    <ChecklistItem state={sessionsState.state} word={sessionsState.word} title="Sessions this run signs in with" testId="preflight-sessions" level={2}>
      {sessions.state === 'loading' && <p className="sc-quiet">Reading the sessions…</p>}
      {sessions.state === 'error' && <Txt text={sessions.error} />}
      {sessions.state === 'ready' && (
        <>
          {sessions.data.personas.length === 0 ? (
            <p>
              <Txt text={`None needed on ${sessions.data.env}: the run opens the pages signed out.`} />
            </p>
          ) : (
            <>
              <p className="sc-quiet">The last known state of each (no browser is opened to read it). Before it films, every run checks again each session that has a check.</p>
              <SessionRows
                slug={slug}
                rows={sessions.data.personas}
                showEnv={false}
                issues={sessions.data.issues}
                onChanged={() => {
                  reloadSessions();
                  reloadProject('auth_status', slug);
                }}
                caption={`Sessions ${name} signs in`}
              />
            </>
          )}
          {sessions.data.issues.map((i, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the sessions read's issues, replaced whole on each read, text only: the index is the identity
            <Callout key={n} state="warn" role="note" title="A page has no persona a run could use">
              <p className="sb-pre">
                <Txt text={i} />
              </p>
            </Callout>
          ))}
          {toConfirm.length > 0 && (
            <p data-testid="preflight-confirm-note">
              {shown(`A capture asks first: ${toConfirm.length === 1 ? 'one persona has' : `${toConfirm.length} personas have`} no valid session that a run could renew by itself.`)}
            </p>
          )}
        </>
      )}
    </ChecklistItem>
  );
}

/** What would stop a run: the blockers of both modes, then a capture's own. */
function BlockersItem({ slug, name, data, failed, dry, cap }: { slug: string; name: string; data: ActionsData | null; failed: string | null; dry: RunBlocker[]; cap: RunBlocker[] }) {
  const capOnly = cap.filter((b) => !dry.some((d) => d.message === b.message));
  const blockedNow = dry.length + cap.length > 0;
  return (
    <ChecklistItem
      state={!data ? (failed ? 'fail' : 'idle') : cap.length > 0 ? 'attention' : dry.length > 0 ? 'attention' : 'ok'}
      word={!data ? (failed ? 'Cannot be read' : 'Pending') : blockedNow ? 'Blocked: needs the terminal' : 'Ready: nothing'}
      title="What would stop a run"
      testId="preflight-blockers"
      level={2}
    >
      {data && !blockedNow && <p>Nothing: no hook to approve, nothing refused.</p>}
      {data && dry.length > 0 && (
        <>
          <p>Both a rehearsal and a capture:</p>
          <BlockerList list={dry} testId="blockers-dry" slug={slug} name={name} />
        </>
      )}
      {data && capOnly.length > 0 && (
        <>
          {dry.length > 0 && <p>A capture, also:</p>}
          <BlockerList list={capOnly} testId="blockers-capture-list" slug={slug} name={name} />
          {dry.length === 0 && <p className="sc-quiet">A rehearsal skips the hooks, so it is not affected.</p>}
        </>
      )}
    </ChecklistItem>
  );
}

/** The live picture check: a per-tab switch, off by default. */
function PictureItem({ picture, setPicture }: { picture: boolean; setPicture: (on: boolean) => void }) {
  return (
    <ChecklistItem state={picture ? 'ok' : 'idle'} word={picture ? 'On · ready' : 'Off'} title="Live picture during a capture" level={2}>
      <Switch
        label="Show the live picture from the capture's start"
        hint="Off by default: drawing it costs Chromium CPU during the take (about 15 % more)."
        checked={picture}
        onChange={setPicture}
        testId="prep-picture"
      />
    </ChecklistItem>
  );
}

/** A run of the scenario already going (Watch it), and a start that was refused with its command. */
function RunNotices({
  slug,
  name,
  running,
  terminal,
  last,
  refusedFixNode,
  boxRef,
}: {
  slug: string;
  name: string;
  running: Running | null;
  terminal: boolean;
  last: LastStart | undefined;
  refusedFixNode: string | undefined;
  boxRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {running && (
        <Callout state="running" title={`A ${modeWord(running.mode, true)} of this scenario is ${running.status}`}>
          {terminal && <p data-testid="watch-terminal">{shown(TERMINAL_WHY)}</p>}
          <p>
            <LinkButton size="sm" variant="ghost" to={{ name: 'run', slug, scenario: name, run: running.id }} testId="watch-running">
              Watch it
            </LinkButton>
          </p>
        </Callout>
      )}
      {last && 'error' in last && (
        <div ref={boxRef} tabIndex={-1} className="sp-refused" data-testid="start-refused-box">
          <Callout state="fail" role="alert" title={`The ${modeWord(last.mode, true)} was not started`}>
            <p className="sb-pre" data-testid="start-refused">
              <Txt text={last.error} />
            </p>
            <TerminalCommands {...(last.fix ? { fix: last.fix } : {})} {...(refusedFixNode ? { fixNode: refusedFixNode } : {})} />
          </Callout>
        </div>
      )}
    </>
  );
}

/** The sticky row of start buttons: Start rehearsal and Start capture, each with what stops it. */
function StartButtons({
  dryWhy,
  capWhy,
  sending,
  picture,
  confirmCount,
  start,
}: {
  dryWhy: string | null;
  capWhy: string | null;
  sending: ReturnType<typeof useSending>;
  picture: boolean;
  confirmCount: number;
  start: (mode: Mode) => void;
}) {
  // Sticky at the foot of the centre pane (reachable at 900 px without scrolling past the checks).
  return (
    // biome-ignore lint/a11y/useSemanticElements: the sticky row of start buttons; <fieldset> would bring its own border, padding and min-width
    <div className="sp-starts" role="group" aria-label="Start a take">
      <div className="sp-start">
        <div className="sp-start-text">
          <h2 className="sc-h2">Rehearsal</h2>
          <p className="sc-quiet">No hooks, a screenshot per step, the live picture on.</p>
        </div>
        <div className="sp-start-act">
          <Button variant="primary" data-testid="start-dry" disabled={dryWhy !== null} aria-describedby="start-why-dry" onClick={() => start('dry')}>
            {sending === 'dry' ? 'Starting the rehearsal…' : 'Start rehearsal'}
          </Button>
          <span id="start-why-dry" className="sc-quiet">
            {shown(dryWhy ?? 'Ready: nothing stops it.')}
          </span>
        </div>
      </div>
      <div className="sp-start">
        <div className="sp-start-text">
          <h2 className="sc-h2">Capture</h2>
          <p className="sc-quiet">Runs the hooks and films the video{picture ? ', the live picture on.' : '; the live picture off unless you show it.'}</p>
        </div>
        <div className="sp-start-act">
          <Button variant="record" data-testid="start-capture" disabled={capWhy !== null} aria-describedby="start-why-capture" onClick={() => start('capture')}>
            {sending === 'capture' ? 'Starting the capture…' : 'Start capture'}
          </Button>
          <span id="start-why-capture" className="sc-quiet">
            {shown(capWhy ?? (confirmCount > 0 ? 'Asks first: a session to confirm.' : 'Ready: nothing stops it.'))}
          </span>
        </div>
      </div>
    </div>
  );
}
