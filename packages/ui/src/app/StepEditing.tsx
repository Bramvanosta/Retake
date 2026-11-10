/**
 * Step editing on the board (L4.3 part 2, R-UI-12; L5.10b: the bar on the kit): one hook holding the screen's edit loop
 * and the bar above the board that shows it (undo / redo naming the edit, the live region, a refusal, the conflict offer).
 *
 * - Each edit is saved at once through `scenario_edit` on the version shown (`hash`); the screen then re-reads the view.
 *   Non-optimistic: the blocks change when the new view lands. From the send until then editing input is off
 *   (`busy`, critique B7) — a held Alt+↓ or a double drop never builds a second edit on a stale view.
 * - Off too while the YAML view holds an unsaved draft (critique B7) or when the view says block edits are not possible
 *   (`edit.blocks`: a file that does not parse, has errors, is shown in part, or the Studio does not write — why shown).
 * - A 409 (the file changed meanwhile): "your edit … was not applied", with **Apply it to the new version** (the same
 *   edit on the version now shown — the step's guard refuses it as stale when that place holds another step, never a
 *   neighbour moved; a form's changes go to the same step found again, each applied only while that field still holds
 *   what the form showed: critique B2) and **Leave it**.
 * - Undo / redo (step-edit.ts EditHistory): `restore` of the exact earlier bytes; a version this screen did not make
 *   clears the history, with a notice (its own words for a save from this screen's YAML view).
 * - After a 409, Apply is off (with why) when the new version turns block editing off (review B L9).
 * - Announcements: one polite status region ("Moved step 3 of request to position 1. Saved."); refusals in an alert.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ValidationIssue } from '@retake/core';
import { CallError, errorText } from './api.js';
import { scenarioEdit } from './data/scenarios.js';
import type { ScenarioEdit } from './data/scenarios.js';
import type { ScenarioEditAnswer } from './data/scenarios.js';
import { Txt, shown } from './bits.js';
import { Button, Callout, StatusMark, Toolbar } from './ui-kit/index.js';
import type { View } from './scenario-words.js';
import { SessionEnded } from './session.js';
import { anchorOf, editAgain } from './forms.js';
import type { StepAnchor } from './forms.js';
import { EditHistory, editWords, inField } from './step-edit.js';
import type { StepEditOp } from './step-edit.js';

export interface StepEditor {
  /** Block edits are possible at all now (the view allows them and no YAML draft is open). */
  enabled: boolean;
  /** Why not, when not. */
  why: string | null;
  /** An edit is on its way (or its new view not here yet): editing input is off. */
  busy: boolean;
  send: (op: StepEditOp) => void;
  undo: () => void;
  redo: () => void;
  undoLabel: string | null;
  redoLabel: string | null;
  announce: string;
  /** The step to select once the edit's view lands (the moved step, the copy, the delete's neighbour). */
  select: { key: string; hash: string } | null;
  /** A refusal; `op`: the edit refused (a form shows its issues at their fields), `field`: the field it names. */
  error: { title: string; message: string; issues: ValidationIssue[]; op?: StepEditOp; field?: string } | null;
  conflict: { op: StepEditOp; words: string; anchor: StepAnchor | null } | null;
  applyConflict: () => void;
  dismiss: () => void;
  /** Say something in the live region (a key that moves nothing: "already the first step"). */
  say: (text: string) => void;
  /** This screen's YAML view saved a version (its hash): the history is cleared in those words. */
  ownSave: (hash: string) => void;
}

/** After a form's change (L5.5's rule): what the browser does is filmed again; an edit change is a render away. */
export const CHANGE_WORDS = {
  filmed: 'What the browser does changed: a rehearsal shows it, a capture films it.',
  edit: 'Only the edit changed: a render of the last capture shows it, no new capture needed.',
} as const;

function issuesOf(e: unknown): ValidationIssue[] {
  return e instanceof CallError && Array.isArray(e.error.details?.issues) ? (e.error.details.issues as ValidationIssue[]) : [];
}

export function useStepEditor(slug: string, name: string, v: View | null, yamlDraft: boolean, reload: () => void, active: boolean): StepEditor {
  const history = useRef<EditHistory>(new EditHistory());
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const waitHash = useRef<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [select, setSelect] = useState<StepEditor['select']>(null);
  const [error, setError] = useState<StepEditor['error']>(null);
  const [conflict, setConflict] = useState<StepEditor['conflict']>(null);
  const vRef = useRef(v);
  vRef.current = v;
  const ownSaves = useRef(new Set<string>());

  const hash = v?.hash ?? null;
  // Each view: the edit's own version lands (input back on), or a version this screen did not make (history cleared).
  useEffect(() => {
    if (hash === null) return;
    const h = history.current;
    if (waitHash.current !== null) {
      if (hash !== waitHash.current && h.knows(hash)) return; // an older read: the edit's view is still coming
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
      setAnnounce(
        ownSaves.current.has(hash)
          ? 'Saved from the YAML view: the undo history of block edits was cleared.'
          : 'The file changed outside this screen: the undo history was cleared.',
      );
      ownSaves.current.clear();
      bump((n) => n + 1);
    }
  }, [hash]);

  const enabled = !!v && v.edit.blocks.ok && !yamlDraft;
  const why = !v ? null : !v.edit.blocks.ok ? v.edit.blocks.why : yamlDraft ? 'Save or discard your changes in the YAML view first.' : null;

  /** Send one edit on the version shown; `after` runs with the answer (the history's bookkeeping). */
  const run = useCallback(
    (edit: ScenarioEdit, after: (r: ScenarioEditAnswer, shown: View) => string) => {
      const shown = vRef.current;
      if (busyRef.current || !shown) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      scenarioEdit({ project: slug, name, hash: shown.hash, edit }).then(
        (r) => {
          history.current.know(r.hash);
          const words = after(r, shown);
          setAnnounce(`${words}${r.notices.length ? ` ${r.notices.join(' ')}` : ''}${r.warnings.length ? ` ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'} in the file.` : ''}`);
          if (r.select) setSelect({ key: r.select, hash: r.hash });
          waitHash.current = r.hash;
          bump((n) => n + 1);
          reload();
        },
        (e: unknown) => {
          busyRef.current = false;
          setBusy(false);
          if (e instanceof SessionEnded) return;
          const op = 'kind' in edit && edit.kind !== 'restore' ? (edit as unknown as StepEditOp) : undefined;
          if (e instanceof CallError && e.error.code === 'conflict' && e.error.details?.stale !== true && op) {
            // Where a form's step is, to find it again in the new version (Apply it to the new version).
            const anchor = op.kind === 'set_step' ? anchorOf(shown, op.at.scene, op.at.index) : null;
            setConflict({ op, words: editWords(op), anchor });
            reload();
            return;
          }
          if (e instanceof CallError && e.error.code === 'conflict') reload();
          const issues = issuesOf(e);
          const field = e instanceof CallError && typeof e.error.details?.field === 'string' ? e.error.details.field : undefined;
          setError({ title: 'Not saved', message: errorText(e), issues, ...(op ? { op } : {}), ...(field !== undefined ? { field } : {}) });
        },
      );
    },
    [slug, name, reload],
  );

  const send = useCallback(
    (op: StepEditOp) => {
      if (!enabled) return;
      setConflict(null);
      run(op, (r, shown) => {
        history.current.push({ label: r.label, before: shown.text, hashBefore: shown.hash, after: null, hashAfter: r.hash });
        // A form's change says which kind it is (L5.5): a move, a delete, a copy or a new step is always filmed.
        return `${r.label}. Saved.${op.kind === 'set_step' ? ` ${CHANGE_WORDS[r.change ?? 'filmed']}` : ''}`;
      });
    },
    [enabled, run],
  );

  const undo = useCallback(() => {
    const h = history.current;
    const e = h.undo.at(-1);
    if (!e || !enabled || busyRef.current) return;
    if (vRef.current?.hash !== e.hashAfter) {
      h.clear();
      bump((n) => n + 1);
      setError({ title: 'Undo is not possible', message: 'The file changed since this edit: the undo history was cleared.', issues: [] });
      return;
    }
    run({ kind: 'restore', text: e.before, text_hash: e.hashBefore }, (_r, shown) => {
      h.undone(shown.text);
      return `Undone: ${e.label}.`;
    });
  }, [enabled, run]);

  const redo = useCallback(() => {
    const h = history.current;
    const e = h.redo.at(-1);
    if (!e || e.after === null || !enabled || busyRef.current) return;
    if (vRef.current?.hash !== e.hashBefore) {
      h.clear();
      bump((n) => n + 1);
      setError({ title: 'Redo is not possible', message: 'The file changed since this edit was undone: the history was cleared.', issues: [] });
      return;
    }
    run({ kind: 'restore', text: e.after, text_hash: e.hashAfter }, () => {
      h.redone();
      return `Redone: ${e.label}.`;
    });
  }, [enabled, run]);

  // Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (and Ctrl+Y) on the Blocks tab, when focus is not in a field.
  useEffect(() => {
    if (!active) return;
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
  }, [undo, redo, active]);

  const h = history.current;
  return {
    enabled,
    why,
    busy,
    send,
    undo,
    redo,
    undoLabel: h.undo.at(-1)?.label ?? null,
    redoLabel: h.redo.at(-1)?.label ?? null,
    announce,
    select,
    error,
    conflict,
    applyConflict: () => {
      const c = conflict;
      setConflict(null);
      const shown = vRef.current;
      if (!c || !shown) return;
      const again = editAgain(c.op, c.anchor, shown);
      if ('why' in again) setError({ title: 'Not applied', message: `Your edit (${c.words}) was not applied: ${again.why}.`, issues: [], op: c.op });
      else send(again.op);
    },
    dismiss: () => {
      setError(null);
      setConflict(null);
    },
    say: setAnnounce,
    ownSave: (h: string) => {
      ownSaves.current.add(h);
    },
  };
}

/**
 * The line above the board (L5.10b: on the kit): undo / redo naming the edit, Add a step, the saving mark, the live
 * region; then why editing is off, the conflict offer, a refusal (each a callout: its state as a shape and words).
 */
export function EditBar({ ed, add }: { ed: StepEditor; /** The board's "Add a step…" (the palette). */ add?: ReactNode }) {
  return (
    <div className="sb-editbar" data-testid="edit-bar">
      <div className="sb-editbar-line">
        <Toolbar label="Edits">
          <Button size="sm" icon="undo" data-testid="undo" disabled={!ed.enabled || ed.busy || ed.undoLabel === null} onClick={ed.undo} aria-keyshortcuts="Meta+Z Control+Z">
            {ed.undoLabel ? <span>{'Undo: '}<Txt text={ed.undoLabel} /></span> : 'Undo'}
          </Button>
          <Button size="sm" icon="redo" data-testid="redo" disabled={!ed.enabled || ed.busy || ed.redoLabel === null} onClick={ed.redo} aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z">
            {ed.redoLabel ? <span>{'Redo: '}<Txt text={ed.redoLabel} /></span> : 'Redo'}
          </Button>
          {shown(add)}
        </Toolbar>
        {ed.busy && <StatusMark state="running" word="Busy: saving…" />}
        <p className="sb-live" role="status" aria-live="polite" data-testid="edit-live">
          {shown(ed.announce)}
        </p>
      </div>
      {ed.why !== null && (
        <p className="sc-quiet" data-testid="blocks-edit-off">
          {'Editing the board is off (moves, copies, deletes, forms and new steps): '}
          <Txt text={ed.why} />
        </p>
      )}
      {ed.conflict && (
        <Callout state="warn" role="alert" title="The file changed on disk">
          <p data-testid="edit-conflict">
            {'Your edit ('}
            <Txt text={ed.conflict.words} />
            {') was not applied. The board now shows the new version.'}
          </p>
          {!ed.enabled && ed.why !== null && (
            <p data-testid="edit-conflict-off">
              {'It cannot be applied to the new version: '}
              <Txt text={ed.why} />
            </p>
          )}
          <div className="sb-actions">
            <Button size="sm" variant={ed.enabled ? 'primary' : 'secondary'} disabled={ed.busy || !ed.enabled} onClick={ed.applyConflict}>
              Apply it to the new version
            </Button>
            <Button size="sm" variant="ghost" onClick={ed.dismiss}>
              Leave it
            </Button>
          </div>
        </Callout>
      )}
      {ed.error && (
        <Callout state="fail" role="alert" title={ed.error.title}>
          <p className="sb-pre" data-testid="edit-error">
            <Txt text={ed.error.message} />
          </p>
          {ed.error.issues.length > 0 && <IssueLines issues={ed.error.issues} />}
          <div>
            <Button size="sm" variant="ghost" onClick={ed.dismiss}>
              Dismiss
            </Button>
          </div>
        </Callout>
      )}
    </div>
  );
}

/** A file's issues, each with its severity as a shape and a word, its line and its message (text). */
export function IssueLines({ issues, testId }: { issues: ValidationIssue[]; testId?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="sb-issues" data-testid={testId}>
      {issues.map((i, n) => (
        <li key={n} className="sb-issue">
          <StatusMark state={i.severity === 'error' ? 'fail' : 'warn'} word={i.severity === 'error' ? 'error' : 'warning'} />
          {i.line !== undefined && <span className="k-mono sc-quiet">{shown(`line ${i.line}${i.col !== undefined ? `:${i.col}` : ''}`)}</span>}
          <Txt text={i.message} />
        </li>
      ))}
    </ul>
  );
}
