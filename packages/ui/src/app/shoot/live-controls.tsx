/** The live screen's controls (ShootLive.tsx): Pause / Resume and Stop in the status bar, what they do in the centre. */
import { useRef, useState } from 'react';
import { errorText } from '../api.js';
import { runCancel, runPause } from '../data/shoot.js';
import { Txt, shown } from '../bits.js';
import { pauseMaxWords } from './run-live.js';
import type { RunLiveState, RunStatusLite } from './run-live.js';
import { stepWords } from '../words/scenario-words.js';
import { PRIORITY, useShellCommand } from '../shell/command-bus.js';
import { say } from '../shell/say.js';
import { ShellSlot } from '../shell/slots.js';
import { reloadActions } from './shoot-data.js';
import { SHOOT_STATES, modeWord } from '../words/shoot-words.js';
import { Button, StatusMark } from '../ui-kit/index.js';
import { STATE_MARK, runState, stateWord } from './live-state.js';

type ControlsProps = {
  slug: string;
  name: string;
  runId: string;
  s: RunLiveState;
  fb: RunStatusLite | null;
  mode: string | undefined;
  finished: boolean;
  /** The run films an iOS environment: it cannot pause (its take runs to its end). */
  device?: boolean;
};

/** Why Pause cannot be pressed now (null: it can): a terminal's run, a queued job, a stop asked, an iOS take. Pure. */
export function pauseBlocker(o: { terminal: boolean; jobState: string | undefined; stopping: boolean; device: boolean }): string | null {
  if (o.terminal) return 'Started in a terminal: press Ctrl-C there to stop it.';
  if (o.jobState === 'queued') return 'It can pause once it runs.';
  if (o.stopping) return 'It is stopping.';
  return o.device ? 'An iOS take cannot pause: it runs to its end. Stop stops it.' : null;
}

/** The run's controls: its state, Pause / Resume and Stop (one request at a time), and ⌘. while it goes. */
function useRunControls({ slug, name, runId, s, fb, mode, finished, device }: ControlsProps) {
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
  const why = pauseBlocker({ terminal, jobState, stopping, device: device === true });
  const pause = (on: boolean) => {
    if (inFlight.current) return;
    setBusy(on ? 'pause' : 'resume');
    setSaid(null);
    runPause({ project: slug, run_id: runId, paused: on })
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
    // ⌘. always answers: a stop already asked, or a pause on its way, is said.
    const now = inFlight.current;
    if (stopping) return say(`The ${modeWord(mode ?? 'dry', true)} of ${name} is already stopping`);
    if (now) return say(`Wait: ${now === 'pause' ? 'pausing' : now === 'resume' ? 'resuming' : 'stopping'}…`);
    setBusy('stop');
    setSaid(null);
    runCancel({ project: slug, run_id: runId })
      .then(
        () => {
          setStopAsked(true);
          reloadActions(slug, name);
        },
        (e: unknown) => setSaid(errorText(e)),
      )
      .finally(() => setBusy(null));
  };
  // ⌘. stops this run while it goes (the screen's priority, whatever order the effects ran in).
  useShellCommand('stop', stop, PRIORITY.screen, !finished);
  return { busy, said, st, paused, pauseAsked, stopping, terminal, why, pause, stop };
}

/** What Pause and Stop do now, in words (the centre's `controls-why`). */
function controlsWhy({
  s,
  fb,
  mode,
  stopping,
  paused,
  pauseAsked,
  why,
}: {
  s: RunLiveState;
  fb: RunStatusLite | null;
  mode: string | undefined;
  stopping: boolean;
  paused: boolean;
  pauseAsked: boolean;
  why: string | null;
}): string {
  return stopping
    ? 'Stopping now: the step in progress is interrupted; its teardown hooks and pending rollbacks still run — their result shows in the steps.'
    : paused
      ? `Paused before ${s.paused ? stepWords(s.paused.scene, s.paused.step) : fb?.paused ? stepWords(fb.paused.scene, fb.paused.step) : 'the next step'}.${mode === 'capture' ? ' The video does not show the pause; the page keeps running, so what changes on it meanwhile shows as a jump when the capture goes on.' : ''} ${
          s.paused?.max_ms ? `A pause longer than ${pauseMaxWords(s.paused.max_ms)} stops the run` : 'A pause longer than its limit (RETAKE_PAUSE_MAX_MIN, 30 minutes by default) stops the run'
        }; its teardown runs.`
      : pauseAsked
        ? 'Pausing before the next step: the current step finishes first.'
        : (why ??
          `Pause waits for the current step to finish${mode === 'capture' ? ' (the video does not show the pause)' : ''}; Stop stops now — the step in progress is interrupted — and still runs the teardown and rollbacks.`);
}

/** Pause / Resume and Stop in the status bar (claimed while the run is unfinished), what they do in the centre. */
export function Controls(props: ControlsProps) {
  const { s, fb, mode, finished } = props;
  const { busy, said, st, paused, pauseAsked, stopping, terminal, why, pause, stop } = useRunControls(props);
  if (finished) return null;
  const holding = paused || pauseAsked;
  const m = mode ?? 'dry';
  // The state word of SHOOT_STATES ("Rehearsing", "Capture paused"…), the same as the status bar's.
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
        <Button
          size="sm"
          icon={holding ? 'play' : 'pause'}
          data-testid={holding ? 'run-resume' : 'run-pause'}
          disabled={why !== null || busy !== null}
          aria-describedby="controls-why"
          onClick={() => pause(!holding)}
        >
          {busy === 'pause' ? 'Pausing…' : busy === 'resume' ? 'Resuming…' : holding ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" icon="stop" data-testid="run-stop" disabled={terminal || stopping || busy !== null} aria-describedby="controls-why" onClick={stop}>
          {busy === 'stop' ? 'Stopping…' : stopping ? 'Stop asked' : 'Stop'}
        </Button>
      </ShellSlot>
      <p id="controls-why" className="sc-quiet" data-testid="controls-why">
        {shown(controlsWhy({ s, fb, mode, stopping, paused, pauseAsked, why }))}
      </p>
      {said && (
        <p className="sp-error" role="alert" data-testid="controls-error">
          <Txt text={said} />
        </p>
      )}
    </>
  );
}
