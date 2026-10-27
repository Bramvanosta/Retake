/**
 * The timeline's inspector (L4.5 part D, R-UI-23; DESIGN §4g "Inspector"): the video's switches (the caption component,
 * every scene's layout) and the selected segment's (a scene's layout, transition and speed; a card's component,
 * duration and transition; a waiting screen's component and duration; the intro / outro switch, component and
 * duration), each written in one click through `scenario_edit` `set_field`.
 *
 * - The choices are the view's (engine field-options.ts): an option the use cannot take is shown disabled with the
 *   engine's reason (critique B7) and cannot be picked; the server refuses it too.
 * - Radio groups: `role="radiogroup"` of `role="radio"` buttons (the timeline's keys leave them alone: keyAction). The
 *   arrows move the focus only and Space / Enter picks (a pick writes the file: never one write per arrow press);
 *   a disabled option stays focusable so its reason is read.
 * - One click writes at once on the version shown (`hash`), then the screen re-reads the view: the new plan loads into
 *   the same preview frame, which shows "Loading the preview…" until it is settled at the playhead. From the send until
 *   the new view lands, picks are ignored (never a second edit on a stale view: L4.3's `busy`).
 * - Undo / redo (⌘Z, Shift+⌘Z, Ctrl+Y; the buttons): L4.3's EditHistory — `restore` of the exact earlier bytes (the
 *   view's `text`), checked against their sha256 by the server; a version this screen did not make clears the history.
 * - A 409 (another writer changed the file): "Your switch … was not applied", **Apply it to the new version** (the same
 *   switch found again: a value changed meanwhile is refused as stale, never overwritten) and **Leave it**. A stale
 *   refusal re-reads the view and says why.
 * - Every switch is an edit change (L5.5's rule, said once and after each switch): a render of this take shows it, no
 *   new capture. Text from the server is a text node.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TimelineView } from '@demo-studio/engine';
import { CallError, call, errorText } from './api.js';
import { Badge, Notice, Txt } from './bits.js';
import { SessionEnded } from './session.js';
import { EditHistory, inField } from './step-edit.js';
import { choiceKey, inRange, switchAgain, switchEdit, switchEditWords, switchKind, switchLegend, switchOptions, valueWords } from './field-switch.js';
import type { Choice, SwitchEdit, SwitchValue } from './field-switch.js';
import { segmentWords } from './timeline-words.js';

type Segment = TimelineView['model']['segments'][number];

/** The parts of the timeline view the switches need (the file's text: what undo restores). */
export type SwitchView = Pick<TimelineView, 'hash' | 'editable' | 'choices'> & { text?: string };

interface EditAnswer {
  hash: string;
  label: string;
  notices: string[];
  warnings: unknown[];
  change?: 'filmed' | 'edit';
}

/** Said after a switch (L5.5's rule: every switch is an edit value). */
export const SWITCH_CHANGE_WORDS = 'Only the edit changed: a render of this take shows it, no new capture.';

export interface SwitchEditor {
  /** Switches can be written now (the view allows them and holds the file's text). */
  enabled: boolean;
  /** A switch is on its way (or its new view not here yet): picks are ignored. */
  busy: boolean;
  pick: (c: Choice, value: SwitchValue | null) => void;
  undo: () => void;
  redo: () => void;
  undoLabel: string | null;
  redoLabel: string | null;
  announce: string;
  error: { title: string; message: string } | null;
  conflict: { edit: SwitchEdit; words: string } | null;
  /** Why the conflict's switch cannot go to the new version, or null. */
  conflictOff: string | null;
  applyConflict: () => void;
  dismiss: () => void;
}

/** The screen's switch loop (L4.3's useStepEditor, for `set_field`): send, undo / redo, the 409 offer. */
export function useSwitchEditor(slug: string, name: string, v: SwitchView, reload: () => void): SwitchEditor {
  const history = useRef<EditHistory>(new EditHistory());
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const waitHash = useRef<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<SwitchEditor['error']>(null);
  const [conflict, setConflict] = useState<SwitchEditor['conflict']>(null);
  const vRef = useRef(v);
  vRef.current = v;

  const hash = v.hash ?? null;
  // Each view: the switch's own version lands (picks back on), or a version this screen did not make (history cleared).
  useEffect(() => {
    if (hash === null) return;
    const h = history.current;
    if (waitHash.current !== null) {
      if (hash !== waitHash.current && h.knows(hash)) return; // an older read: the switch's view is still coming
      waitHash.current = null;
      busyRef.current = false;
      setBusy(false);
    }
    if (h.size === 0 && !h.knows(hash)) {
      h.know(hash);
      return;
    }
    if (!h.knows(hash)) {
      h.clear();
      h.know(hash);
      setAnnounce('The file changed outside this screen: the undo history was cleared.');
      bump((n) => n + 1);
    }
  }, [hash]);

  const enabled = v.editable === true && v.hash !== undefined && v.text !== undefined;

  /** Send one edit on the version shown; `after` runs with the answer (the history's bookkeeping) and gives the words. */
  const run = useCallback(
    (edit: Record<string, unknown>, after: (r: EditAnswer, shown: SwitchView) => string, op?: SwitchEdit) => {
      const shown = vRef.current;
      if (busyRef.current || shown.hash === undefined) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      call<EditAnswer>('scenario_edit', { project: slug, name, hash: shown.hash, edit }).then(
        (r) => {
          history.current.know(r.hash);
          const words = after(r, shown);
          setAnnounce(`${words}${r.notices.length ? ` ${r.notices.join(' ')}` : ''}${r.warnings.length ? ` ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'} in the file.` : ''}`);
          waitHash.current = r.hash;
          bump((n) => n + 1);
          reload();
        },
        (e: unknown) => {
          busyRef.current = false;
          setBusy(false);
          if (e instanceof SessionEnded) return;
          if (e instanceof CallError && e.error.code === 'conflict' && e.error.details?.stale !== true && op) {
            const c = [...shown.choices.video, ...Object.values(shown.choices.segments).flat()].find((x) => choiceKey(x) === choiceKey(op));
            setConflict({ edit: op, words: switchEditWords(op, c) });
            reload();
            return;
          }
          if (e instanceof CallError && e.error.code === 'conflict') reload();
          setError({ title: 'Not saved', message: errorText(e) });
        },
      );
    },
    [slug, name, reload],
  );

  const send = useCallback(
    (edit: SwitchEdit, c?: Choice) => {
      run(
        edit as unknown as Record<string, unknown>,
        (r, shown) => {
          history.current.push({ label: r.label, before: shown.text!, hashBefore: shown.hash!, after: null, hashAfter: r.hash });
          return `${c ? `${switchEditWords(edit, c)}.` : `${r.label}.`} Saved: ⌘Z undoes. ${SWITCH_CHANGE_WORDS}`;
        },
        edit,
      );
    },
    [run],
  );

  const pick = useCallback(
    (c: Choice, value: SwitchValue | null) => {
      if (!enabled || busyRef.current || c.editable !== true) return;
      const current = c.current === undefined ? null : c.current;
      if (value === current) return;
      setConflict(null);
      send(switchEdit(c, value), c);
    },
    [enabled, send],
  );

  const undo = useCallback(() => {
    const h = history.current;
    const e = h.undo.at(-1);
    if (!e || !enabled || busyRef.current) return;
    if (vRef.current.hash !== e.hashAfter) {
      h.clear();
      bump((n) => n + 1);
      setError({ title: 'Undo is not possible', message: 'The file changed since this switch: the undo history was cleared.' });
      return;
    }
    run({ kind: 'restore', text: e.before, text_hash: e.hashBefore }, (_r, shown) => {
      h.undone(shown.text!);
      return `Undone: ${e.label}.`;
    });
  }, [enabled, run]);

  const redo = useCallback(() => {
    const h = history.current;
    const e = h.redo.at(-1);
    if (!e || e.after === null || !enabled || busyRef.current) return;
    if (vRef.current.hash !== e.hashBefore) {
      h.clear();
      bump((n) => n + 1);
      setError({ title: 'Redo is not possible', message: 'The file changed since this switch was undone: the history was cleared.' });
      return;
    }
    run({ kind: 'restore', text: e.after, text_hash: e.hashAfter }, () => {
      h.redone();
      return `Redone: ${e.label}.`;
    });
  }, [enabled, run]);

  // ⌘Z / Ctrl+Z undo, Shift+⌘Z / Ctrl+Y redo — not while typing in a field (its own undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || inField(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') {
        e.preventDefault();
        if (e.repeat) return;
        if (k === 'y' || e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const again = conflict ? switchAgain(conflict.edit, v) : null;
  const h = history.current;
  return {
    enabled,
    busy,
    pick,
    undo,
    redo,
    undoLabel: h.undo.at(-1)?.label ?? null,
    redoLabel: h.redo.at(-1)?.label ?? null,
    announce,
    error,
    conflict,
    conflictOff: again && 'why' in again ? again.why : null,
    applyConflict: () => {
      const c = conflict;
      setConflict(null);
      if (!c) return;
      const a = switchAgain(c.edit, vRef.current);
      if ('why' in a) setError({ title: 'Not applied', message: `Your switch (${c.words}) was not applied: ${a.why}.` });
      else send(a.edit);
    },
    dismiss: () => {
      setError(null);
      setConflict(null);
    },
  };
}

/** Arrow keys move the focus within a radio group (Space / Enter picks: the button's own click). */
function roveKeys(e: ReactKeyboardEvent<HTMLDivElement>): void {
  const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const d = keys[e.key] ?? (e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0);
  if (!d) return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const at = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0 || radios.length === 0) return;
  e.preventDefault();
  const next = d === -Infinity ? 0 : d === Infinity ? radios.length - 1 : (at + d + radios.length) % radios.length;
  radios[next].focus();
}

function NumberSwitch({ c, ed, off }: { c: Choice; ed: SwitchEditor; off: boolean }) {
  const kind = switchKind(c.field);
  const [draft, setDraft] = useState(typeof c.current === 'number' ? String(c.current) : '');
  const [bad, setBad] = useState<string | null>(null);
  useEffect(() => setDraft(typeof c.current === 'number' ? String(c.current) : ''), [c.current]);
  const id = useId();
  const set = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !inRange(c, n)) {
      setBad(`a number above ${c.range?.min_exclusive ?? 0} and at most ${c.range?.max ?? '∞'}`);
      return;
    }
    setBad(null);
    ed.pick(c, n);
  };
  return (
    <span className="tl-number">
      <label htmlFor={id} className="small">
        {kind === 'speed' ? 'Other speed' : 'Seconds'}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={kind === 'speed' ? 0.05 : 0.1}
        min={0}
        max={c.range?.max}
        value={draft}
        disabled={off}
        data-testid="switch-number"
        aria-invalid={bad !== null}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            set();
          }
        }}
      />
      <button type="button" className="button small" disabled={off} onClick={set}>
        Set
      </button>
      {kind === 'duration' && c.current !== undefined && (
        <button type="button" className="button small quiet" disabled={off} onClick={() => ed.pick(c, null)}>
          Default
        </button>
      )}
      {bad !== null && (
        <span className="small tl-why" role="alert">
          {bad}
        </span>
      )}
    </span>
  );
}

/** One switch: a radio group (and a number field for a speed or a duration). */
function Switch({ c, ed, inherited }: { c: Choice; ed: SwitchEditor; inherited?: string }) {
  const id = useId();
  const kind = switchKind(c.field);
  const off = !ed.enabled || c.editable !== true;
  const options = switchOptions(c, inherited);
  const focusable = options.find((o) => o.checked)?.key ?? options[0]?.key;
  return (
    <fieldset className="tl-switch" data-testid="switch" data-key={choiceKey(c)} data-field={c.field}>
      <legend id={id}>{switchLegend(c)}</legend>
      {c.editable !== true && ed.enabled && (
        <p className="small muted" data-testid="switch-off">
          <Txt text={c.editable.why} />
        </p>
      )}
      {options.length > 0 && (
        <div className="tl-radios" role="radiogroup" aria-labelledby={id} aria-disabled={off || undefined} onKeyDown={roveKeys}>
          {options.map((o) => {
            const unusable = o.usable !== true;
            const disabled = off || unusable || o.value === undefined;
            return (
              <button
                key={o.key}
                type="button"
                role="radio"
                className={`tl-radio${o.checked ? ' is-checked' : ''}${unusable ? ' is-unusable' : ''}`}
                aria-checked={o.checked}
                aria-disabled={disabled || undefined}
                tabIndex={o.key === focusable ? 0 : -1}
                data-testid="switch-option"
                data-value={o.value === null ? '' : String(o.value)}
                onClick={() => {
                  if (disabled || o.checked || o.value === undefined) return;
                  ed.pick(c, o.value);
                }}
              >
                <span className="tl-radio-dot" aria-hidden="true" />
                <span className="tl-radio-label">
                  <Txt text={o.label} />
                  {o.usable !== true && (
                    <span className="tl-why small" data-testid="switch-why">
                      {' — '}
                      <Txt text={o.usable.why} />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {(kind === 'speed' || kind === 'duration') && <NumberSwitch c={c} ed={ed} off={off} />}
    </fieldset>
  );
}

const shortId = (id: string) => id.slice(id.lastIndexOf('/') + 1);

/** The inspector beside the preview: undo / redo, the live region, the 409 offer, the video's and the segment's switches. */
export function TimelineInspector({ v, segment, ed }: { v: SwitchView; segment: Segment | null; ed: SwitchEditor }) {
  const segChoices = segment ? (v.choices.segments[segment.id] ?? []) : [];
  const videoFrame = v.choices.video.find((c) => c.field === 'frame');
  const inheritedFrame = videoFrame?.current !== undefined ? valueWords(videoFrame, videoFrame.current) : undefined;
  return (
    <aside className="card tl-inspector" aria-labelledby="tl-inspector-h" data-testid="inspector">
      {/* Stays on top while the switches scroll: the undo buttons, what was just done, a refusal or the 409 offer. */}
      <div className="tl-inspector-top">
        <div className="tl-inspector-head">
          <h2 id="tl-inspector-h" className="card-title">
            Inspector
          </h2>
          <span className="tl-undo">
            <button type="button" className="button small" data-testid="tl-undo" disabled={!ed.enabled || ed.busy || ed.undoLabel === null} onClick={ed.undo} aria-keyshortcuts="Meta+Z Control+Z">
              Undo
            </button>
            <button type="button" className="button small" data-testid="tl-redo" disabled={!ed.enabled || ed.busy || ed.redoLabel === null} onClick={ed.redo} aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z Control+Y">
              Redo
            </button>
          </span>
        </div>
        <p className="small tl-live" role="status" aria-live="polite" data-testid="switch-live">
          {ed.busy && <Badge tone="info">Saving…</Badge>} {ed.announce}
        </p>
        {ed.conflict && (
          <Notice tone="warning" role="alert" title="The file changed on disk">
            <p data-testid="switch-conflict">
              Your switch (<Txt text={ed.conflict.words} />) was not applied. The timeline now shows the new version.
            </p>
            {ed.conflictOff !== null && (
              <p className="small" data-testid="switch-conflict-off">
                It cannot be applied to the new version: <Txt text={ed.conflictOff} />
              </p>
            )}
            <p>
              <button type="button" className={`button small${ed.conflictOff === null ? ' primary' : ''}`} disabled={ed.busy || ed.conflictOff !== null} onClick={ed.applyConflict}>
                Apply it to the new version
              </button>{' '}
              <button type="button" className="button small quiet" onClick={ed.dismiss}>
                Leave it
              </button>
            </p>
          </Notice>
        )}
        {ed.error && (
          <Notice tone="danger" role="alert" title={ed.error.title}>
            <p className="pre-line" data-testid="switch-error">
              <Txt text={ed.error.title === 'Not saved' ? ed.error.message.replace(/^not saved: /, '') : ed.error.message} />
            </p>
            <button type="button" className="button small quiet" onClick={ed.dismiss}>
              Dismiss
            </button>
          </Notice>
        )}
      </div>
      <p className="small muted">A click writes the scenario at once (⌘Z undoes). {SWITCH_CHANGE_WORDS}</p>
      <section className="tl-insp-part" aria-labelledby="tl-insp-video" data-testid="inspector-video">
        <h3 id="tl-insp-video">The whole video</h3>
        {v.choices.video.map((c) => (
          <Switch key={choiceKey(c)} c={c} ed={ed} />
        ))}
      </section>
      <section className="tl-insp-part" aria-labelledby="tl-insp-seg" data-testid="inspector-segment">
        {segment ? (
          <>
            <h3 id="tl-insp-seg">
              <Txt text={segmentWords(segment)} />
            </h3>
            <p className="small muted" data-testid="inspector-draws">
              Drawn by <Txt className="mono" text={shortId(segment.component.id)} />
              {segment.component.missing ? ' (missing: its stand-in draws)' : ''}
            </p>
            {segChoices.length === 0 && <p className="small muted">Nothing to switch here.</p>}
            {segChoices.map((c) => (
              <Switch key={choiceKey(c)} c={c} ed={ed} {...(c.field === 'frame' && c.at.entry !== 'top' && inheritedFrame ? { inherited: inheritedFrame } : {})} />
            ))}
          </>
        ) : (
          <>
            <h3 id="tl-insp-seg">A segment</h3>
            <p className="small muted" data-testid="inspector-hint">
              Select a segment on the timeline (click it, or [ / ] from the playhead) to switch its layout, component, speed or transition.
            </p>
          </>
        )}
      </section>
    </aside>
  );
}
