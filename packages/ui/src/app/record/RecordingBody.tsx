/** One recording as the view tells it: the head, the notes, the draft list; the inspector in its slot. */
import { useContext, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { RecordState } from '@retake/engine';
import type { RecordViewAnswer } from '../../server/record-ops.js';
import { Txt, plural, shown } from '../bits.js';
import { hrefTo } from '../route.js';
import { SignIn } from '../project/Sessions.js';
import { stepWords } from '../words/scenario-words.js';
import { ShellSlot, SlotContext } from '../shell/slots.js';
import { RECORD_MARK, recordStateWord } from '../shoot/ShootBrowser.js';
import { Callout, Disclosure, LinkButton, Sheet, StatusMark, TerminalCommands } from '../ui-kit/index.js';
import { LIVE_STATES, preflightSignIn, readOnlyWords, stateSentence, timeLeft } from '../words/record-words.js';
import { DraftList } from './DraftList.js';
import { NO_INSERT_FORM } from './Inserts.js';
import type { InsertFormState } from './Inserts.js';
import { StopControl, RecordingInspector } from './RecordingInspector.js';
import { TONE_MARK } from './draft.js';
import type { Cursor, RecordingActions, RecordingUi } from './draft.js';

function StateMark({ state }: { state: RecordState }) {
  return (
    <span className="rc-state-mark" data-testid="record-state" data-state={state}>
      <StatusMark state={RECORD_MARK[state] ?? 'idle'} word={recordStateWord(state)} />
    </span>
  );
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
