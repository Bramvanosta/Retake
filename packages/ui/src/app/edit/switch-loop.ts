/**
 * The switch loop's parts (useSwitchEditor in TimelineInspector.tsx): its state and the history kept across views,
 * the one write on the version shown, and undo / redo with their keys and the queue behind a write in flight.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineView } from '@retake/engine';
import { CallError, errorText } from '../api.js';
import { scenarioEdit } from '../data/scenarios.js';
import type { ScenarioEdit } from '../data/scenarios.js';
import type { ScenarioEditAnswer } from '../data/scenarios.js';
import { SessionEnded } from '../session.js';
import { EditHistory, inField } from '../script/step-edit.js';
import { choiceKey, switchEditWords } from '../script/field-switch.js';
import type { SwitchEdit } from '../script/field-switch.js';

/** The parts of the timeline view the switches need (the file's text: what undo restores). */
export type SwitchView = Pick<TimelineView, 'hash' | 'editable' | 'choices'> & { text?: string };

/** A refusal said in the inspector. */
export type SwitchError = { title: string; message: string } | null;
/** A switch another writer beat (409): what it was, in words. */
export type SwitchConflict = { edit: SwitchEdit; words: string } | null;

/** The loop's state and refs; each view either lands the switch's own version or clears the history. */
export function useSwitchState(v: SwitchView) {
  const history = useRef<EditHistory>(new EditHistory());
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const waitHash = useRef<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<SwitchError>(null);
  const [conflict, setConflict] = useState<SwitchConflict>(null);
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
  return { history, bump, busy, setBusy, busyRef, waitHash, announce, setAnnounce, error, setError, conflict, setConflict, queued, vRef };
}

type SwitchState = ReturnType<typeof useSwitchState>;

/** Send one edit on the version shown; `after` runs with the answer (the history's bookkeeping) and gives the words. */
export function useSwitchRun(slug: string, name: string, reload: () => void, st: SwitchState) {
  const { history, bump, setBusy, busyRef, waitHash, setAnnounce, setError, setConflict, queued, vRef } = st;
  return useCallback(
    (edit: ScenarioEdit, after: (r: ScenarioEditAnswer, shown: SwitchView) => string, op?: SwitchEdit) => {
      const shown = vRef.current;
      if (busyRef.current || shown.hash === undefined) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      scenarioEdit({ project: slug, name, hash: shown.hash, edit }).then(
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
          // An undo / redo queued behind a write that failed or met another writer (409)
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
    [slug, name, reload, history, bump, setBusy, busyRef, waitHash, setAnnounce, setError, setConflict, queued, vRef],
  );
}

type Run = ReturnType<typeof useSwitchRun>;

/** Undo / redo (queued behind a write in flight, run once its view lands) and their keys. */
export function useUndoRedo(st: SwitchState, enabled: boolean, run: Run) {
  const { history, bump, busy, busyRef, setAnnounce, setError, queued, vRef } = st;
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
  }, [enabled, run, history, bump, busyRef, setAnnounce, setError, queued, vRef]);

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
  }, [enabled, run, history, bump, busyRef, setAnnounce, setError, queued, vRef]);

  // The write landed: an undo / redo asked meanwhile runs now (a failed write dropped it above).
  useEffect(() => {
    if (busy || queued.current === null) return;
    const q = queued.current;
    queued.current = null;
    if (q === 'undo') undo();
    else redo();
  }, [busy, undo, redo, queued]);

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
  return { undo, redo };
}
