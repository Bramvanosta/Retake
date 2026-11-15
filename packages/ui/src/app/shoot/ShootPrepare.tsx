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
import type { RunBlocker } from '@retake/engine';
import { runThumbs } from '../data/scenarios.js';
import { useScenarioSessions } from '../data/shoot.js';
import { Txt, shown } from '../bits.js';
import { useScenarioEvents } from '../events.js';
import { useBoard, useProjectView } from '../project-data.js';
import { hrefTo } from '../route.js';
import { useRunLocation } from './run-location.js';
import { PRIORITY, useShellCommand } from '../shell/command-bus.js';
import { say } from '../shell/say.js';
import { ShellSlot } from '../shell/slots.js';
import {
  askSignIn,
  focusLiveOnArrival,
  openSheet,
  reloadActions,
  startRun,
  useCapturePicture,
  useLastStart,
  usePendingRun,
  useRunProgress,
  useScenarioActions,
  useSending,
  useSignInAsk,
} from './shoot-data.js';
import type { LastStart } from './shoot-data.js';
import { ShootBrowser } from './ShootBrowser.js';
import { REHEARSE_MAPPING, blockerShort, modeWord } from '../words/shoot-words.js';
import { ThumbsProvider } from '../Thumb.js';
import { Blocker, Callout, Checklist, ChecklistItem, Disclosure, TerminalCommands } from '../ui-kit/index.js';
import { LoadNotices, LocationItem, LocationSelect, PictureItem, SessionsItem } from './prepare-checks.js';
import type { ActionsData, Mode } from './prepare-checks.js';
import { LastTake, PrepareStatus, RunNotices, StartButtons } from './prepare-run.js';

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
