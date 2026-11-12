/** One recording's inspector: Started with, the selected step, Stop / Save / Discard, the check, issues, placeholders, writes. */
import type { RecordViewAnswer } from '../../server/record-ops.js';
import { Txt, When, plural, shown } from '../bits.js';
import { stepWords } from '../words/scenario-words.js';
import { say } from '../shell/say.js';
import { Button, Callout, Facts, InspectorSection, TextField } from '../ui-kit/index.js';
import { CHECK_SCOPE_NOTE, NAME_MAX, PLACEHOLDER_WORDS, SEVERITY_WORDS, checkFailedAt, checkWords, nameProblem, saveWhyWords, startedByWords, writesWords } from '../words/record-words.js';
import { TONE_MARK, selectedRow, chosenOf } from './draft.js';
import type { Cursor, RecordingActions, RecordingUi } from './draft.js';

/** Stop recording (Cancel recording before the window opens): the inspector's, or the head's while it is hidden. */
export function StopControl({ v, ui, act, compact }: { v: RecordViewAnswer; ui: RecordingUi; act: RecordingActions; compact?: boolean }) {
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
export function RecordingInspector({
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
