/**
 * The timeline's inspector (L4.5 part D, R-UI-23; DESIGN §4g "Inspector"): the video's switches (the caption component,
 * every scene's layout) and the selected segment's (a scene's layout, transition and speed; a card's component,
 * duration and transition; a waiting screen's component and duration; the intro / outro switch, component and
 * duration), each written in one click through `scenario_edit` `set_field`.
 *
 * - The choices are the view's (engine field-options.ts): an option the use cannot take is shown disabled with the
 *   engine's reason (critique B7) and cannot be picked; the server refuses it too.
 * - Radio groups: the kit's ChoiceChips — `role="radiogroup"` of `role="radio"` buttons (the timeline's keys leave them
 *   alone: keyAction). The arrows move the focus only and Space / Enter picks (a pick writes the file: never one write per
 *   arrow press); a disabled option stays focusable so its reason is read.
 * - One click writes at once on the version shown (`hash`), then the screen re-reads the view: the new plan loads into
 *   the same preview frame, which shows "Loading the preview…" until it is settled at the playhead. From the send until
 *   the new view lands, picks are ignored (never a second edit on a stale view: L4.3's `busy`); L5.12a (BL-122): an undo
 *   or a redo asked meanwhile is queued and said ("Saving… Undo in a moment"), then runs once the view lands — never
 *   dropped while the write goes; a write that fails or meets another writer drops it, said once (review A-M2).
 * - L5.12a (R4-Edit, R-UI-45): in the shell's inspector — the selected segment first (its name, times and steps; said in
 *   the inspector's own polite region when it changes), then the whole video, the general hint last; Undo / Redo are
 *   Edit's status-bar actions. An empty "what was just done" line takes no room (review B-L4).
 * - Undo / redo (⌘Z, Shift+⌘Z, Ctrl+Y; the buttons): L4.3's EditHistory — `restore` of the exact earlier bytes (the
 *   view's `text`), checked against their sha256 by the server; a version this screen did not make clears the history.
 * - A 409 (another writer changed the file): "Your switch … was not applied", **Apply it to the new version** (the same
 *   switch found again: a value changed meanwhile is refused as stale, never overwritten) and **Leave it**. A stale
 *   refusal re-reads the view and says why.
 * - Every switch is an edit change (L5.5's rule, said once and after each switch): a render of this take shows it, no
 *   new capture. Text from the server is a text node.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TimelineView } from '@retake/engine';
import { CallError, call, errorText } from './api.js';
import { Txt, plural } from './bits.js';
import { SessionEnded } from './session.js';
import { EditHistory, inField } from './step-edit.js';
import { choiceKey, inRange, switchAgain, switchEdit, switchEditWords, switchKind, switchLegend, switchOptions, valueWords } from './field-switch.js';
import type { Choice, SwitchEdit, SwitchValue } from './field-switch.js';
import { segmentWords, timecode } from './timeline-words.js';
import { Button, Callout, ChoiceChips, InspectorSection, NumberField, Tag } from './ui-kit/index.js';

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
  /** An undo / redo asked while a write was in flight: it runs once the write's view lands (BL-122: never dropped). */
  const queued = useRef<'undo' | 'redo' | null>(null);
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
          // L5.12a fixes (review A-M2 = B-M2): an undo / redo queued behind a write that failed or met another writer (409)
          // is dropped and said once — it meant "undo THIS switch", never the one before it.
          const dropped = queued.current;
          queued.current = null;
          setBusy(false);
          if (dropped) setAnnounce(`${dropped === 'undo' ? 'Undo' : 'Redo'} cancelled: the switch was not saved, so there is nothing to ${dropped}.`);
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
    if (busyRef.current) {
      queued.current = 'undo';
      setAnnounce('Undo in a moment: the switch is still saving.');
      return;
    }
    const h = history.current;
    const e = h.undo.at(-1);
    if (!e || !enabled) return;
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
    if (busyRef.current) {
      queued.current = 'redo';
      setAnnounce('Redo in a moment: the switch is still saving.');
      return;
    }
    const h = history.current;
    const e = h.redo.at(-1);
    if (!e || e.after === null || !enabled) return;
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

  // The write landed: an undo / redo asked meanwhile runs now (a failed write dropped it above).
  useEffect(() => {
    if (busy || queued.current === null) return;
    const q = queued.current;
    queued.current = null;
    if (q === 'undo') undo();
    else redo();
  }, [busy, undo, redo]);

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

function NumberSwitch({ c, ed, off }: { c: Choice; ed: SwitchEditor; off: boolean }) {
  const kind = switchKind(c.field);
  const [draft, setDraft] = useState(typeof c.current === 'number' ? String(c.current) : '');
  const [bad, setBad] = useState<string | null>(null);
  useEffect(() => setDraft(typeof c.current === 'number' ? String(c.current) : ''), [c.current]);
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
    <div className="ed-number">
      <NumberField
        label={kind === 'speed' ? 'Other speed' : 'Seconds'}
        value={draft}
        onChange={setDraft}
        step={kind === 'speed' ? 0.05 : 0.1}
        min={0}
        {...(c.range?.max !== undefined ? { max: c.range.max } : {})}
        disabled={off}
        testId="switch-number"
        {...(bad !== null ? { error: bad } : {})}
        onEnter={set}
      />
      <Button size="sm" disabled={off} onClick={set}>
        Set
      </Button>
      {kind === 'duration' && c.current !== undefined && (
        <Button size="sm" variant="ghost" disabled={off} onClick={() => ed.pick(c, null)}>
          Default
        </Button>
      )}
    </div>
  );
}

/** One switch: its legend, why it is off, its chips (and a number field for a speed or a duration). */
function Switch({ c, ed, inherited }: { c: Choice; ed: SwitchEditor; inherited?: string }) {
  const id = useId();
  const kind = switchKind(c.field);
  const off = !ed.enabled || c.editable !== true;
  const options = switchOptions(c, inherited);
  return (
    <fieldset className="ed-switch" data-testid="switch" data-key={choiceKey(c)} data-field={c.field}>
      <legend id={id} className="ed-switch-legend">
        <Txt text={switchLegend(c)} />
      </legend>
      {c.editable !== true && ed.enabled && (
        <p className="ed-quiet" data-testid="switch-off">
          <Txt text={c.editable.why} />
        </p>
      )}
      {options.length > 0 && (
        <ChoiceChips
          labelledBy={id}
          off={off}
          optionTestId="switch-option"
          whyTestId="switch-why"
          chips={options.map((o) => ({
            key: o.key,
            label: <Txt text={o.label} />,
            value: o.value === null ? '' : String(o.value),
            checked: o.checked,
            disabled: o.usable !== true || o.value === undefined,
            ...(o.usable !== true ? { why: <Txt text={o.usable.why} /> } : {}),
          }))}
          onPick={(key) => {
            const o = options.find((x) => x.key === key);
            if (!o || o.value === undefined || o.usable !== true) return;
            ed.pick(c, o.value);
          }}
        />
      )}
      {(kind === 'speed' || kind === 'duration') && <NumberSwitch c={c} ed={ed} off={off} />}
    </fieldset>
  );
}

const shortId = (id: string) => id.slice(id.lastIndexOf('/') + 1);

/** "00:41.9 – 00:53.9 · 7 steps": a segment's place in words. */
function segmentFacts(s: Segment, fps: number, steps: number): string {
  return `${timecode(s.from, fps)} – ${timecode(s.to, fps)}${s.kind === 'clip' ? ` · ${plural(steps, 'step')}` : ''}`;
}

/**
 * The inspector (the shell's pane): what was just done, a refusal or the 409 offer (on top while the switches scroll);
 * the selected segment's switches, then the video's. `fps` and `steps` say where the segment is.
 */
export function TimelineInspector({ v, segment, ed, fps, stepsOf }: { v: SwitchView; segment: Segment | null; ed: SwitchEditor; fps: number; stepsOf: (segmentId: string) => number }) {
  const segChoices = segment ? (v.choices.segments[segment.id] ?? []) : [];
  const videoFrame = v.choices.video.find((c) => c.field === 'frame');
  const inheritedFrame = videoFrame?.current !== undefined ? valueWords(videoFrame, videoFrame.current) : undefined;
  // The selected segment, said once in the inspector's own polite region (BL-122: the selection is announced).
  const [selectedWords, setSelectedWords] = useState('');
  const segKey = segment ? `${segment.id}\0${segment.from}\0${segment.to}` : '';
  useEffect(() => {
    setSelectedWords(segment ? `Selected ${segmentWords(segment)}: ${segmentFacts(segment, fps, stepsOf(segment.id))}.` : '');
  }, [segKey]);
  return (
    <div className="ed-inspector" data-testid="inspector">
      {/* Stays on top while the switches scroll: what was just done, a refusal or the 409 offer. */}
      <div className="ed-inspector-top">
        <p className="ed-live" role="status" aria-live="polite" data-testid="switch-live">
          {ed.busy || ed.announce ? (
            <>
              {ed.busy && <Tag>Saving…</Tag>}
              {ed.busy && ed.announce ? ' ' : null}
              <Txt text={ed.announce} />
            </>
          ) : null}
        </p>
        {ed.conflict && (
          <Callout state="warn" role="alert" title="The file changed on disk">
            <p data-testid="switch-conflict">
              {'Your switch ('}
              <Txt text={ed.conflict.words} />
              {') was not applied. The timeline now shows the new version.'}
            </p>
            {ed.conflictOff !== null && (
              <p className="ed-quiet" data-testid="switch-conflict-off">
                {'It cannot be applied to the new version: '}
                <Txt text={ed.conflictOff} />
              </p>
            )}
            <p className="ed-actions">
              <Button size="sm" variant={ed.conflictOff === null ? 'primary' : 'secondary'} disabled={ed.busy || ed.conflictOff !== null} onClick={ed.applyConflict}>
                Apply it to the new version
              </Button>
              <Button size="sm" variant="ghost" onClick={ed.dismiss}>
                Leave it
              </Button>
            </p>
          </Callout>
        )}
        {ed.error && (
          <Callout state="fail" role="alert" title={ed.error.title}>
            <p className="ed-pre" data-testid="switch-error">
              <Txt text={ed.error.title === 'Not saved' ? ed.error.message.replace(/^not saved: /, '') : ed.error.message} />
            </p>
            <Button size="sm" variant="ghost" onClick={ed.dismiss}>
              Dismiss
            </Button>
          </Callout>
        )}
      </div>
      <p className="k-sr" role="status" aria-live="polite" data-testid="inspector-selected">
        <Txt text={selectedWords} />
      </p>
      <InspectorSection
        testId="inspector-segment"
        title={
          segment ? (
            <span id="tl-insp-seg">
              <Txt text={segmentWords(segment)} />
            </span>
          ) : (
            <span id="tl-insp-seg">A segment</span>
          )
        }
      >
        {segment ? (
          <>
            <p className="ed-quiet ed-seg-facts">
              <Txt className="k-mono" text={segmentFacts(segment, fps, stepsOf(segment.id))} />
            </p>
            <p className="ed-quiet" data-testid="inspector-draws">
              {'Drawn by '}
              <Txt className="k-mono" text={shortId(segment.component.id)} />
              {segment.component.missing ? ' (missing: its stand-in draws)' : ''}
            </p>
            {segChoices.length === 0 && <p className="ed-quiet">Nothing to switch here.</p>}
            {segChoices.map((c) => (
              <Switch key={choiceKey(c)} c={c} ed={ed} {...(c.field === 'frame' && c.at.entry !== 'top' && inheritedFrame ? { inherited: inheritedFrame } : {})} />
            ))}
          </>
        ) : (
          <p className="ed-quiet" data-testid="inspector-hint">
            Select a segment on the timeline (click it, or [ / ] from the playhead) to switch its layout, component, speed or transition.
          </p>
        )}
      </InspectorSection>
      <InspectorSection title="The whole video" testId="inspector-video">
        {v.choices.video.map((c) => (
          <Switch key={choiceKey(c)} c={c} ed={ed} />
        ))}
        {v.choices.video.some((c) => c.field === 'template') && (
          <p className="ed-quiet" data-testid="inspector-theme-note">
            The theme re-dresses every take of this scenario at its next render; the cursor style is filmed: existing takes keep theirs.
          </p>
        )}
      </InspectorSection>
      {/* The general hint last (R4-Edit: the selected segment first; review B-L4). */}
      <p className="ed-quiet" data-testid="inspector-general">
        {'A click writes the scenario at once; ⌘Z undoes it. '}
        <Txt text={SWITCH_CHANGE_WORDS} />
      </p>
    </div>
  );
}
