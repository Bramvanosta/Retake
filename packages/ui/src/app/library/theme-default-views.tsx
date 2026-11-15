/** The views of "Set as theme default": the theme's line, the write's state, its outcome and the two sheets. */
import type { ThemeEditResult, ThemeEditView } from '@retake/engine';
import type { LibraryItem } from '../../server/library-ops.js';
import { Txt } from '../bits.js';
import { NEW_THEME_NAME_MAX } from '../id-words.js';
import { NEW_THEME_NAME_HINT, okTheme, setDefaultWords } from '../words/library-words.js';
import type { SetDefaultPlan } from '../words/library-words.js';
import { Button, LinkButton, Sheet, TextField } from '../ui-kit/index.js';

export type SetState =
  | { s: 'idle' }
  | { s: 'busy'; what: string }
  | { s: 'plan'; view: ThemeEditView; plan: SetDefaultPlan; kind: string }
  | { s: 'done'; theme: string; before: ThemeEditView; result: ThemeEditResult; copied?: string }
  | { s: 'undone'; theme: string }
  | { s: 'error'; message: string };

/** Whether the theme shown already uses the component by default. */
export function DefaultLine({ item, theme }: { item: LibraryItem; theme: string }) {
  return (
    <p className="lb-line">
      {item.theme_default.length > 0 ? (
        <>
          <Txt text={theme} />
          <Txt text={` uses it by default as its ${item.theme_default.join(', ')}.`} />
        </>
      ) : (
        <>
          <Txt text={theme} />
          {' does not use it by default.'}
        </>
      )}
    </p>
  );
}

/** The write's progress, its undo, its error or its outcome (a live region). */
export function SetDefaultState({ st }: { st: SetState }) {
  return (
    <div role="status" className="lb-line" data-testid="lib-set-state">
      {st.s === 'busy' && <Txt text={st.what} />}
      {st.s === 'undone' && (
        <>
          {'Undone: '}
          <Txt text={st.theme} />
          {' is back to the version before.'}
        </>
      )}
      {st.s === 'error' && (
        <span className="lb-failure">
          <Txt text={st.message} />
        </span>
      )}
      {st.s === 'done' && (
        <>
          <Txt text={st.result.label} />
          {st.result.removed.length > 0 && <Txt text={` — removed ${st.result.removed.join(', ')} (they contradicted it)`} />}
          {'.'}
          {st.copied && (
            <>
              {' The copy '}
              <Txt text={st.copied} />
              {' is a new theme: the project still uses its own until '}
              <code className="k-mono">template:</code>
              {' names the copy (in project.yaml, or per scenario).'}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** After the write: Undo, the copy's next step and the write's warnings. */
export function SetDefaultDone({ st, slug, onUndo }: { st: Extract<SetState, { s: 'done' }>; slug: string; onUndo: () => void }) {
  return (
    <div className="lb-actions">
      {st.before.yaml !== null ? (
        <Button size="sm" onClick={onUndo} data-testid="lib-set-undo">
          Undo
        </Button>
      ) : (
        <span className="lb-quiet">No undo: the theme's file was not shown whole.</span>
      )}
      {st.copied && okTheme(st.copied) && (
        // The next step: the copy is used once a scenario or the project names it.
        <LinkButton size="sm" variant="primary" to={{ name: 'themes', slug, theme: st.copied }} testId="lib-set-next">
          Open the copy: use it in a scenario
        </LinkButton>
      )}
      {st.result.warnings.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one answer's warnings, fixed once said, text only: the index is the identity
        <span key={i} className="lb-quiet">
          <Txt text={w} />
        </span>
      ))}
    </div>
  );
}

/** The two sheets: confirm the write; copy a read-only theme first (the copy's name). */
export function SetDefaultSheets({
  theme,
  component,
  confirming,
  copying,
  copyAs,
  setCopyAs,
  copyProblem,
  onSet,
  onCopy,
  onCancel,
}: {
  theme: string;
  component: string;
  confirming: Extract<SetState, { s: 'plan' }> | null;
  copying: Extract<SetDefaultPlan, { copy: string }> | null;
  copyAs: string;
  setCopyAs: (name: string) => void;
  copyProblem: string | null;
  onSet: (view: ThemeEditView) => void;
  onCopy: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Sheet
        open={confirming !== null}
        testId="lib-set-confirm"
        title={`Set the default of ${theme}?`}
        actions={[
          { id: 'set', label: 'Set as default', variant: 'primary', isDefault: true, testId: 'lib-set-confirm-yes' },
          { id: 'cancel', label: 'Cancel', isCancel: true },
        ]}
        onAction={(id) => {
          if (!confirming) return;
          if (id === 'set') onSet(confirming.view);
          else onCancel();
        }}
      >
        {confirming && 'edit' in confirming.plan ? <Txt text={setDefaultWords(theme, confirming.kind, component, confirming.plan)} /> : null}
      </Sheet>
      <Sheet
        open={copying !== null}
        testId="lib-set-copy"
        title={`Copy ${theme} first?`}
        actions={[
          { id: 'copy', label: `Copy as ${copyAs || '…'} and set`, variant: 'primary', isDefault: true, disabled: copyProblem !== null, testId: 'lib-set-copy-yes' },
          { id: 'cancel', label: 'Cancel', isCancel: true },
        ]}
        onAction={(id) => {
          if (id === 'copy') onCopy();
          else onCancel();
        }}
        content={
          <TextField
            label="Name of the copy"
            value={copyAs}
            onChange={(v) => setCopyAs(v.trim())}
            unsaved={null}
            mono
            maxLength={NEW_THEME_NAME_MAX}
            hint={NEW_THEME_NAME_HINT}
            autoComplete="off"
            spellCheck={false}
            testId="lib-set-copy-name"
            error={copyProblem ?? undefined}
          />
        }
      >
        {copying ? (
          <>
            <Txt text={theme} />
            {' cannot be changed here ('}
            <Txt text={copying.copy} />
            {'). Copy it to a theme of this workspace, then set the default there.'}
          </>
        ) : null}
      </Sheet>
    </>
  );
}
