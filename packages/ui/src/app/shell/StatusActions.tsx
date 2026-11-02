/**
 * L5.11a: the status bar's actions (DESIGN §4m; B32-Projet / B32-Scenario footers) for the scenario in context, on every
 * screen that has one — its state in a NON-live span ("Rehearsing · step 12 of 25 · Watch", "Capture paused", "Last take
 * succeeded · 2 h ago", "Idle"; its name first off its own routes; the location when the tab chose one: critique M2),
 * then Rehearse, Capture (the record variant) and Render, with Pause and Stop while a run of it is queued or running.
 * A disabled action says why in its description; one blocker line shows at a time (Capture's first, else Rehearse's) in
 * the gate's own short words (shoot-words.ts, critique H3) with its one action: Copy command, Open the YAML.
 *
 * It is the default owner (priority 0) of the Scenario menu's commands (command-bus.ts): ⌘R / ⇧⌘R / ⌘B / ⌘. in the app,
 * the palette's Scenario group in a browser tab (critique M3). A command that cannot act says why in the polite line and
 * sends nothing; it never acts before the project is read (critique M2). Starts stay where they are (the status bar
 * follows the run); Stop and Pause reach the run's job — a terminal's run has none: "press Ctrl-C there" (critique M4).
 * A screen may claim the actions slot (Prepare, the live screen, a live recording): the buttons then hide, the commands
 * stay (the screen's own outrank them where it registers some). On the Scenario screen the screen feeds what it read
 * (no second read: critique H2); on the Project screen a selection is read once it settled for 300 ms. The one
 * confirmation sheet of a capture with sessions to confirm lives here (`SessionsSheet`).
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunBlocker } from '@demo-studio/engine';
import { Txt, When, shown } from '../bits.js';
import { scenarioEventAction, useEvents } from '../events.js';
import { useProjectView } from '../project-data.js';
import type { Route } from '../route.js';
import { droppedLocation, takeDropped, useRunLocation } from '../run-location.js';
import {
  askSignIn,
  closeSheet,
  focusLiveOnArrival,
  pauseRun,
  reloadActions,
  shownFile,
  startRender,
  startRun,
  stopRun,
  useFedActions,
  usePendingRun,
  useRunProgress,
  useScenarioActions,
  useSending,
  useSheet,
  useShootEvents,
} from '../shoot-data.js';
import type { LiveRun, SheetAsk } from '../shoot-data.js';
import { SHOOT_STATES, blockerShort, modeWord, shootState } from '../shoot-words.js';
import { Blocker, Button, LinkButton, Sheet, StatusMark } from '../ui-kit/index.js';
import { PRIORITY, useShellCommand } from './command-bus.js';
import type { ScenarioContext } from './modes.js';

const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
/** The Project screen's routes: a selection there is read once it settled (critique H2). */
const SETTLE_ROUTES = new Set<Route['name']>(['project', 'group', 'location']);
const SETTLE_MS = 300;

/** A persona's stored state in words (the sheet's list). */
const STORED: Record<string, string> = { expired: 'expired', error: 'last check failed', never: 'never signed in', valid: 'valid', unchecked: 'saved, never checked' };

function useSettled(key: string | null, settle: boolean): string | null {
  const [v, set] = useState(key);
  useEffect(() => {
    if (!settle) {
      set(key);
      return;
    }
    const t = window.setTimeout(() => set(key), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [key, settle]);
  return settle ? v : key;
}

export interface StatusActionsProps {
  route: Route;
  ctx: ScenarioContext | null;
  say: (s: string) => void;
  /** A screen holds the actions slot: the buttons hide (the commands stay). */
  claimed: boolean;
  inApp: boolean;
}

/** The status bar's scenario: its state (info), its actions, and the confirmation sheet. */
export function useStatusActions({ route, ctx, say, claimed, inApp }: StatusActionsProps): { info: ReactNode; actions: ReactNode; overlay: ReactNode } {
  const slug = ctx?.slug ?? null;
  const name = ctx?.scenario ?? null;
  useShootEvents();
  const project = useProjectView(slug);
  const envs = project.state === 'ready' ? project.data.environments : null;
  const loc = useRunLocation(slug, name, envs);
  const onScenario = route.name === 'scenario';
  const onRun = route.name === 'run';
  const ctxKey = slug !== null && name !== null ? `${slug}\0${name}` : null;
  const settled = useSettled(ctxKey, SETTLE_ROUTES.has(route.name));
  const reading = !onScenario && ctxKey !== null && settled === ctxKey;
  const read = useScenarioActions(reading ? slug : null, reading ? name : null, loc.sent);
  const fed = useFedActions(onScenario ? slug : null, onScenario ? name : null);
  const data = onScenario ? fed : read.state === 'ready' && reading ? read.data : null;
  const sending = useSending(slug, name);
  const running = data?.running ?? null;
  const pend = usePendingRun(slug, name, data?.runs);
  // The progress line: run_status off the Scenario screen (it feeds its own) and off the run routes (they claim the bar).
  const progressId = !onScenario && !onRun && running ? running.id : null;
  const [prog, progress] = useRunProgress(slug, progressId, () => {
    if (slug && name) reloadActions(slug, name);
  });
  useEvents((e) => {
    if (!progressId || !slug || !name) return;
    const a = scenarioEventAction(e, slug, name);
    if (a.progress.length) progress(a.progress);
    else if (a.jobs) progress([]);
  });
  const live: LiveRun | null = onScenario ? (fed?.live ?? null) : prog;
  const runLive = live && running && live.id === running.id && !live.finished ? live : null;

  // A remembered location dropped on a route whose screen does not say so: said here, once (critique M2).
  const dropped = slug && name ? droppedLocation(slug, name) : undefined;
  useEffect(() => {
    if (!slug || !name || dropped === undefined || onScenario || onRun) return;
    takeDropped(slug, name);
    say(`The location ${dropped} chosen earlier for ${name} is gone from project.yaml: its runs use the file's own`);
  }, [slug, name, dropped, onScenario, onRun, say]);

  const busyRun = running ?? (pend ? { id: pend.id, mode: pend.mode, status: 'queued' as const, job: undefined } : null);
  const busyWords = busyRun ? `waits for the ${modeWord(busyRun.mode, true)} to end` : null;
  const why = (mode: 'dry' | 'capture'): { text: string; blocker?: RunBlocker } | null => {
    if (!ctx) return { text: 'no scenario' };
    if (!loc.ready || !data) return { text: 'loading the scenario' };
    // While a start is being sent the buttons stay enabled (a disabled one would drop the focus the sheet gives back);
    // the store ignores a second start of the scenario meanwhile.
    if (busyWords) return { text: busyWords };
    const b = data.run_blockers[mode][0];
    return b ? { text: blockerShort(b).words, blocker: b } : null;
  };
  const renderRun = route.name === 'timeline' && route.run && route.scenario === name ? route.run : slug && name ? (shownFile(slug, name)?.run ?? data?.capture?.id) : undefined;
  const renderWhy = (): string | null => {
    if (!ctx) return 'no scenario';
    if (!loc.ready || !data) return 'loading the scenario';
    if (data.render_job) return `a render is ${data.render_job.state}${data.render_job.fraction !== undefined ? ` · ${Math.round(data.render_job.fraction * 100)} %` : ''}`;
    if (!renderRun) return 'no finished capture yet: a capture films the take a render edits';
    return null;
  };

  const onPrepare = onRun && !(route.name === 'run' && route.run);
  const act = (mode: 'dry' | 'capture') => {
    if (!ctx || !slug || !name) return say('Open a scenario first');
    if (!loc.ready || !data) return say(`Wait: ${name} is still loading`);
    if (busyRun) return say(`A ${modeWord(busyRun.mode, true)} of ${name} is ${busyRun.status}: wait for it to end, or stop it`);
    const w = why(mode);
    if (w?.blocker) return say(`${modeWord(mode)} of ${name} is blocked: ${w.text}`);
    if (w) return say(`${modeWord(mode)} of ${name}: ${w.text}`);
    startRun({
      slug,
      name,
      mode,
      hash: shownFile(slug, name)?.hash ?? data.hash,
      ...(loc.sent ? { env: loc.sent } : {}),
      say,
      // From Shoot (Prepare, a run's live screen — its outcome's Rehearse again / Start capture): the new run's live screen
      // opens (review B-L4 of L5.11a), its title focused.
      ...(onRun
        ? {
            onStarted: (id: string) => {
              focusLiveOnArrival(id);
              location.hash = `#/p/${encodeURIComponent(slug)}/s/${encodeURIComponent(name)}/run/${encodeURIComponent(id)}`;
            },
          }
        : {}),
    });
  };
  const render = () => {
    if (!ctx || !slug || !name) return say('Open a scenario first');
    const w = renderWhy();
    if (w || !renderRun || !data) return say(`Render of ${name}: ${w ?? 'not ready'}`);
    startRender({ slug, name, run: renderRun, hash: shownFile(slug, name)?.hash ?? data.hash, say });
  };
  const stop = () => {
    if (!ctx || !slug || !name) return say('Open a scenario first');
    if (!running) return say(pend ? `The ${modeWord(pend.mode, true)} of ${name} is being queued: Stop once it shows` : `Nothing of ${name} is running`);
    if (running.job === null) return say('Started in a terminal: press Ctrl-C there to stop it');
    stopRun({ slug, name, run: running.id, mode: running.mode, say });
  };
  useShellCommand('rehearse', () => act('dry'), PRIORITY.defaults);
  useShellCommand('capture', () => act('capture'), PRIORITY.defaults);
  useShellCommand('render', render, PRIORITY.defaults);
  useShellCommand('stop', stop, PRIORITY.defaults);

  // ── what it shows ──
  const runInfo = running ? { status: running.status, mode: running.mode, paused: Boolean(runLive?.paused), stopping: Boolean(runLive?.stopping) } : pend ? { status: 'queued', mode: pend.mode } : null;
  const lastTake = data?.runs.find((r) => FINISHED.has(r.status));
  const state = runInfo ? shootState(runInfo) : lastTake ? shootState(lastTake) : 'idle';
  const word = SHOOT_STATES[state].word(runInfo?.mode ?? lastTake?.mode ?? 'dry');
  const detail = runLive
    ? runLive.paused
      ? ` · before step ${runLive.paused.step + 1} of ${runLive.paused.scene}`
      : runLive.steps_total > 0
        ? ` · step ${Math.min(runLive.steps_done + 1, runLive.steps_total)} of ${runLive.steps_total}`
        : ''
    : '';
  // On the run routes the screen's own status bar says the state (Prepare, the live screen): not twice. In a narrow
  // window whole segments go, by priority (review A-L1 of L5.11a: never a word cut in half) — the last take's time
  // first, then the scenario's name and the last take itself (shell.css `data-drop`); a run going, the location and
  // the blocker's words stay.
  const markNode = <StatusMark state={SHOOT_STATES[state].mark} word={<Txt text={`${word}${detail}`} />} />;
  const info: ReactNode =
    ctx && slug && name && !onPrepare && !(onRun && claimed) ? (
      <span className="sh-scenario" data-testid="status-scenario" data-state={state}>
        {!('scenario' in route) && (
          <span className="sh-seg" data-drop="name">
            <Txt text={name} />
            {' · '}
          </span>
        )}
        {!runInfo && lastTake ? (
          <span className="sh-seg" data-drop="last">
            {shown(markNode)}
            <span className="sh-seg" data-drop="when">
              {' · '}
              <When iso={lastTake.finished_at ?? lastTake.started_at} />
            </span>
          </span>
        ) : (
          shown(markNode)
        )}
        {loc.sent && <Txt className="sh-scenario-env" text={` · on ${loc.sent}`} />}
        {running && !onRun && (
          <LinkButton size="sm" variant="ghost" to={{ name: 'run', slug, scenario: name, run: running.id }} testId="status-watch">
            Watch
          </LinkButton>
        )}
      </span>
    ) : null;

  const dryWhy = why('dry');
  const capWhy = why('capture');
  const rWhy = renderWhy();
  const line = capWhy?.blocker ? { mode: 'capture' as const, b: capWhy.blocker } : dryWhy?.blocker ? { mode: 'dry' as const, b: dryWhy.blocker } : null;
  const ids = { dry: 'sh-why-dry', capture: 'sh-why-capture', render: 'sh-why-render', stop: 'sh-why-stop' };
  const paused = Boolean(runLive?.paused || runLive?.pausing);
  const terminal = running?.job === null;
  // Prepare's buttons are on screen (its status bar is its own); a live run's screen claims the bar until the run ends.
  const showButtons = !claimed && !onPrepare && ctx !== null && slug !== null && name !== null;
  const actions: ReactNode = showButtons ? (
    <div className="sh-actions" role="group" aria-label={`Actions for ${name}`} data-testid="status-actions">
      {line && <ShortBlocker b={line.b} slug={slug} name={name} mode={line.mode} testId={line.mode === 'capture' ? 'blockers-capture' : 'blockers-dry-run'} />}
      {running && (
        <>
          <Button size="sm" data-testid={paused ? 'run-resume' : 'run-pause'} disabled={terminal || running.status !== 'running' || Boolean(runLive?.stopping)} aria-describedby={ids.stop} onClick={() => pauseRun({ slug, name, run: running.id, paused: !paused, say, onDone: () => progress([running.id]) })}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" data-testid="run-stop" icon="stop" disabled={terminal || Boolean(runLive?.stopping)} aria-describedby={ids.stop} kbd={inApp ? ['⌘', '.'] : undefined} onClick={stop}>
            {runLive?.stopping ? 'Stopping…' : 'Stop'}
          </Button>
        </>
      )}
      <Button size="sm" data-testid="run-dry" disabled={dryWhy !== null} aria-describedby={ids.dry} kbd={inApp ? ['⌘', 'R'] : undefined} onClick={() => act('dry')}>
        {sending === 'dry' ? 'Starting…' : 'Rehearse'}
      </Button>
      <Button size="sm" variant="record" data-testid="run-capture" disabled={capWhy !== null} aria-describedby={ids.capture} kbd={inApp ? ['⇧', '⌘', 'R'] : undefined} onClick={() => act('capture')}>
        {sending === 'capture' ? 'Starting…' : 'Capture'}
      </Button>
      <Button size="sm" data-testid="run-render" disabled={rWhy !== null} aria-describedby={ids.render} kbd={inApp ? ['⌘', 'B'] : undefined} onClick={render}>
        {sending === 'render' ? 'Queueing…' : 'Render'}
      </Button>
      <span className="k-sr">
        <span id={ids.dry}>
          <Txt text={dryWhy ? `Rehearse: ${dryWhy.blocker ? dryWhy.blocker.message : dryWhy.text}` : `Rehearse ${name}: no hooks, a screenshot per step${loc.sent ? `, on ${loc.sent}` : ''}`} />
        </span>
        <span id={ids.capture}>
          <Txt text={capWhy ? `Capture: ${capWhy.blocker ? capWhy.blocker.message : capWhy.text}` : `Capture ${name}: its hooks, the video${loc.sent ? `, on ${loc.sent}` : ''}`} />
        </span>
        <span id={ids.render}>
          <Txt text={rWhy ? `Render: ${rWhy}` : `Render the capture ${renderRun ?? ''} of ${name} with the file as shown`} />
        </span>
        {running && (
          <span id={ids.stop}>
            <Txt text={terminal ? 'Started in a terminal: press Ctrl-C there to stop it.' : 'Pause waits for the current step to finish; Stop stops now and still runs the teardown and rollbacks.'} />
          </span>
        )}
      </span>
    </div>
  ) : null;

  return { info, actions, overlay: <SessionsSheet say={say} route={route} /> };
}

/** A blocker in the status bar's one line: the gate's short words and its one action. */
function ShortBlocker({ b, slug, name, testId, mode }: { b: RunBlocker; slug: string; name: string; testId: string; mode: 'dry' | 'capture' }) {
  const s0 = blockerShort(b);
  // The state word first ("Capture blocked: …": the colour-only rule wants one beside the mark), then the gate's words.
  const s = { ...s0, words: `${modeWord(mode)} blocked: ${s0.words}` };
  if (s.action === 'yaml') return <Blocker compact word={s.words} fix={{ label: 'Open the YAML', to: { name: 'scenario', slug, scenario: name, tab: 'yaml' } }} testId={testId} />;
  if (s.action === 'copy' && b.fix) return <Blocker compact word={s.words} fix={{ copy: b.fix }} testId={testId} />;
  return <Blocker compact word={s.words} testId={testId} />;
}

/**
 * The capture's confirmation (B10 of L4.4) on the kit's sheet: the personas with their state and what the capture does
 * with each (checked first → it stops before filming; no check → its saved session is used as it is and the take fails
 * only at a sign-in page, after its setup hooks ran). Cancel (Escape) · "Sign in <persona> first…" — the default, and
 * the focus (critique Q4: the canvas put Return on Capture anyway; a known-bad session would run the hooks) · Capture
 * anyway (sends `sessions_ack` once). "Sign in first" opens Prepare and focuses that persona's Sign in; the sheet opens
 * no window. A page `<dialog>`, not a native sheet: it is the page's own question (DESIGN §4m, critique L7).
 */
function SessionsSheet({ say, route }: { say: (s: string) => void; route: Route }) {
  const ask = useSheet();
  const last = useRef<SheetAsk | null>(null);
  if (ask) last.current = ask;
  const a = ask ?? last.current;
  const sessions = a?.sessions ?? [];
  const one = sessions.length === 1;
  const unchecked = sessions.filter((x) => x.checked_first === false).map((x) => x.persona);
  const checked = sessions.length - unchecked.length;
  const first = sessions[0]?.persona ?? '';
  const expired = sessions.some((x) => x.status === 'expired');
  const onAction = (id: string) => {
    const cur = ask;
    closeSheet();
    if (!cur) return;
    if (id === 'sign-in') {
      askSignIn({ slug: cur.slug, name: cur.name, persona: first });
      if (!(route.name === 'run' && !route.run && route.slug === cur.slug && route.scenario === cur.name)) location.hash = `#/p/${encodeURIComponent(cur.slug)}/s/${encodeURIComponent(cur.name)}/run`;
    } else if (id === 'anyway') {
      startRun({ slug: cur.slug, name: cur.name, mode: 'capture', ...(cur.hash ? { hash: cur.hash } : {}), ...(cur.env ? { env: cur.env } : {}), ack: cur.sessions.map((s) => s.persona), say, ...(cur.onStarted ? { onStarted: cur.onStarted } : {}) });
    }
  };
  return (
    <Sheet
      open={ask !== null}
      alert
      testId="confirm-sessions"
      title={expired && one ? 'Capture with an expired session?' : `Capture with ${one ? 'a session' : 'sessions'} that may not work?`}
      actions={[
        { id: 'cancel', label: 'Cancel', isCancel: true, testId: 'confirm-cancel' },
        { id: 'sign-in', label: `Sign in ${first} first…`, variant: 'primary', isDefault: true, testId: 'confirm-sign-in-first' },
        { id: 'anyway', label: 'Capture anyway', variant: 'record', testId: 'confirm-capture-anyway' },
      ]}
      onAction={onAction}
    >
      <p>
        {one ? 'This persona has' : 'These personas have'} no valid saved session, and no run signs {one ? 'it' : 'them'} in by itself:
      </p>
      <ul aria-label="Personas" className="sh-sheet-list">
        {sessions.map((s) => (
          <li key={s.persona}>
            <Txt text={`${s.persona} — ${STORED[s.status] ?? s.status} · ${s.checked_first === false ? 'not checked (no check)' : 'checked before filming'}`} />
          </li>
        ))}
      </ul>
      {checked > 0 && (
        <p>
          The capture checks {unchecked.length ? (checked === 1 ? 'the other session' : 'the other sessions') : one ? 'the session' : 'each session'} first and stops before filming if it is
          still not valid: nothing is filmed then.
        </p>
      )}
      {unchecked.length > 0 && (
        <p data-testid="confirm-unchecked">
          <Txt text={unchecked.join(', ')} /> cannot be checked first ({unchecked.length === 1 ? 'it has' : 'they have'} no check): the capture uses{' '}
          {unchecked.length === 1 ? 'its saved session as it is' : 'their saved sessions as they are'} and fails only when a page lands on the sign-in page — after its setup hooks
          ran.
        </p>
      )}
      <p>Capture anyway only if you know the session works now (you signed in since its last check, for example).</p>
    </Sheet>
  );
}
