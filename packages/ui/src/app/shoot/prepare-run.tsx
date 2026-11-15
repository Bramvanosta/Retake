/**
 * Prepare's run parts (ShootPrepare.tsx): the inspector's Last take, the status bar's state with Pause / Stop, a run
 * already going or a refused start, and the row of start buttons.
 */
import type { RefObject } from 'react';
import type { BoardScenario } from '@retake/engine';
import { Txt, When, plural, shown } from '../bits.js';
import { lastTakeWords, lengthWords } from '../words/board-words.js';
import { say } from '../shell/say.js';
import { pauseRun, stopRun } from './shoot-data.js';
import type { LastStart, LiveRun, useSending } from './shoot-data.js';
import { SHOOT_STATES, modeWord } from '../words/shoot-words.js';
import { Thumb } from '../Thumb.js';
import { Button, Callout, Facts, InspectorSection, LinkButton, StatusMark, TerminalCommands } from '../ui-kit/index.js';
import { TERMINAL_WHY } from './prepare-checks.js';
import type { ActionsData, Mode, Running } from './prepare-checks.js';

export function LastTake({ slug, s }: { slug: string; s: BoardScenario | undefined }) {
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

/** The status bar's part of this screen: the scenario's state, and Pause / Stop while a run of it is unfinished. */
export function PrepareStatus({
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

/** A run of the scenario already going (Watch it), and a start that was refused with its command. */
export function RunNotices({
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
export function StartButtons({
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
