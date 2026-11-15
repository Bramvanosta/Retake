/**
 * The YAML view's panes (YamlTab.tsx holds the editor's state and its save): the toolbar lines, the text area with its
 * bar and live issues, a refused save and the hidden characters, the read-only reasons, and the File inspector.
 */
import type { ReactNode, RefObject } from 'react';
import type { ValidationIssue } from '@retake/core/base';
import { Txt, plural, shown } from '../bits.js';
import { isDirty, scenarioKey, useDirty } from '../drafts.js';
import type { Draft } from '../drafts.js';
import type { View } from '../words/scenario-words.js';
import { IssueLines } from './StepEditing.js';
import { Button, Callout, InspectorSection, Kbd, StatusMark, TextArea } from '../ui-kit/index.js';
import { HIDDEN_CHARS } from '../hidden-chars.js';

/** The largest scenario the Studio writes (core SCENARIO_EDIT_MAX_CHARS: MCP scenario_save's cap), final line break included. */
export const YAML_MAX = 500_000;

// The class of core's input rules (hidden-chars.ts HIDDEN_CHARS), a tab left out: controls, format and
// default-ignorable characters (direction controls, zero-width, soft hyphen, variation selectors, tags…), line /
// paragraph separators, the Hangul fillers and the braille blank.
const HIDDEN = new RegExp(`(?!\\t)[${HIDDEN_CHARS}]`, 'u');
const hex = (c: string) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Lines of `text` holding a hidden character, at most 20: "line 7 (U+202E)". */
export function hiddenLines(text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((l, i) => {
    if (out.length >= 20) return;
    const m = HIDDEN.exec(i === 0 ? l.replace(/^\u{feff}/u, '') : l);
    if (m) out.push(`line ${i + 1} (${hex(m[0])})`);
  });
  return out;
}

/** A save refused: why, in words, and the issues the server sent back. */
export type SaveError = { message: string; issues: ValidationIssue[] };

/** The editor's toolbar line: Save, Discard changes, Close the editor. */
export function EditorHead({
  file,
  saving,
  dirty,
  conflict,
  onSave,
  onDiscard,
  onClose,
}: {
  file: string;
  saving: boolean;
  dirty: boolean;
  conflict: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  return (
    <Head file={file}>
      <Button size="sm" variant="primary" disabled={saving || !dirty || conflict} onClick={onSave} aria-keyshortcuts="Meta+S Control+S">
        {saving ? 'Saving…' : 'Save'}
      </Button>
      <Button size="sm" variant="ghost" disabled={saving || !dirty || conflict} onClick={onDiscard}>
        Discard changes
      </Button>
      <Button size="sm" variant="ghost" disabled={saving || dirty} why={dirty ? 'Save or discard your changes first' : undefined} onClick={onClose}>
        Close the editor
      </Button>
    </Head>
  );
}

/** A save refused (its message and issues) and the draft's lines that hold hidden characters. */
export function EditorWarnings({ error, hidden }: { error: SaveError | null; hidden: string[] }) {
  return (
    <>
      {error && (
        <Callout state="fail" role="alert" title="Not saved">
          <p className="sb-pre" data-testid="yaml-save-error">
            <Txt text={error.message} />
          </p>
          <IssueLines issues={error.issues} testId="yaml-save-issues" />
        </Callout>
      )}
      {hidden.length > 0 && (
        <Callout state="warn" role="note" title="Warning: hidden characters">
          <p data-testid="yaml-hidden">
            {shown(
              `${hidden.join(', ')} hold a direction control or an invisible character: they can make a line read differently from what it does. The Studio saves only those the file already had.`,
            )}
          </p>
        </Callout>
      )}
    </>
  );
}

/** The text area, its bar (the save state, the counter, the keys) and the live issues. */
export function EditPane({
  name,
  draft,
  area,
  conflict,
  state,
  liveIssues,
  shownIssues,
  onChange,
}: {
  name: string;
  draft: Draft;
  area: RefObject<HTMLTextAreaElement | null>;
  conflict: boolean;
  state: string;
  liveIssues: ValidationIssue[] | null;
  shownIssues: ValidationIssue[] | null;
  onChange: (text: string) => void;
}) {
  return (
    <div className="yv-edit" hidden={conflict}>
      <TextArea
        id="yaml-text"
        label={`YAML of ${name}`}
        labelHidden
        mono
        tall
        rows={24}
        value={draft.text}
        inputRef={area}
        maxLength={YAML_MAX}
        readOnly={conflict}
        spellCheck={false}
        autoCorrect={false}
        describedBy="yaml-count yaml-state"
        // The draft's mark is drafts.ts's (scenario:<slug>/<name>): the quit question lists it once.
        unsaved={null}
        onChange={onChange}
      />
      <div className="yv-bar">
        <span id="yaml-state" className="yv-state" role="status" aria-live="polite" data-testid="yaml-state">
          {shown(state)}
        </span>
        <span className="sb-spacer" />
        <span id="yaml-count" className={draft.text.length >= YAML_MAX ? 'yv-count is-full' : 'yv-count'}>
          {shown(`${draft.text.length.toLocaleString('en')} / ${YAML_MAX.toLocaleString('en')} characters`)}
        </span>
        <Kbd keys={['⌘S', 'Ctrl+S']} />
      </div>
      {shownIssues !== null && (
        <div className="yv-live" aria-live="polite" data-testid="yaml-live">
          {liveIssues === null ? (
            <p className="sc-quiet">Checking…</p>
          ) : liveIssues.length === 0 ? (
            <p className="sc-quiet">No issue in this text.</p>
          ) : (
            <IssueLines issues={liveIssues} testId="yaml-live-issues" />
          )}
        </div>
      )}
    </div>
  );
}

/** The view's toolbar line (R4-Source): the file, what the board keeps, then the view's actions. */
export function Head({ file, children }: { file: string; children: ReactNode }) {
  return (
    <div className="yv-head">
      <Txt className="k-mono" text={file} />
      <span className="sc-quiet">Comments and layout are kept when you edit the board.</span>
      <span className="sb-spacer" />
      <div className="sb-actions">{shown(children)}</div>
    </div>
  );
}

/** Why the Studio does not save this file, with each problem's line, and any unsaved text to copy. */
export function Blocked({ why, problems, draft }: { why: string; problems: Array<{ line?: number; message: string }>; draft: Draft | undefined }) {
  return (
    <div className="sb-stack" data-testid="yaml-readonly">
      <Callout state="warn" role="alert" title="Read-only: the Studio does not save this file">
        <p className="sb-pre">
          <Txt text={why} />
        </p>
        {problems.length > 0 && (
          <ul data-testid="yaml-readonly-problems">
            {problems.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the file's problems, replaced whole on each read, text only: the index is the identity
              <li key={i}>
                {p.line !== undefined && <span className="k-mono">{shown(`line ${p.line} `)}</span>}
                <Txt text={p.message} />
              </li>
            ))}
          </ul>
        )}
      </Callout>
      {draft && isDirty(draft) && (
        <Callout state="idle" title="Your unsaved text">
          <p>Not saved anywhere: copy it before you leave.</p>
          <TextArea label="Your unsaved text" labelHidden value={draft.text} onChange={() => undefined} unsaved={null} readOnly mono rows={6} />
        </Callout>
      )}
    </div>
  );
}

/**
 * The File inspector (R4-Source): valid or how many errors, in words; the warnings (hints); when the file holds hidden
 * characters, their lines; the size against the Studio's cap; the sentence that says a save from here passes the same
 * checks as Claude's edits; unsaved text in the editor, said.
 */
export function FileInspector({ v, slug, name, issues }: { v: View; slug: string; name: string; issues: ValidationIssue[] }) {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  const hidden = hiddenLines(v.text);
  const dirty = useDirty(scenarioKey(slug, name));
  return (
    <div data-testid="file-inspector">
      <InspectorSection title="File">
        <Txt className="k-mono" text={v.file} />
        <StatusMark state={!v.blocks.parsed ? 'fail' : errors > 0 ? 'fail' : 'ok'} word={!v.blocks.parsed ? 'Not valid YAML' : errors > 0 ? `${plural(errors, 'error')}` : 'Valid'} />
        {warnings > 0 && <StatusMark state="warn" word={plural(warnings, 'warning')} />}
        {dirty && <StatusMark state="waiting" word="Unsaved changes in the editor" />}
        <p className="sc-quiet">Saved with the same checks as Claude's edits: the schema, hooks left unchanged, no hidden characters it did not already have.</p>
        {hidden.length > 0 && <StatusMark state="attention" word={`Hidden characters: ${hidden.join(', ')}`} />}
        <p className="sc-quiet">
          {shown(`${plural(v.text.split('\n').length, 'line')} · ${v.text.length.toLocaleString('en')} of ${YAML_MAX.toLocaleString('en')} characters · ${plural(v.blocks.step_count, 'step')}`)}
        </p>
        {!v.edit.yaml.ok && <StatusMark state="warn" word="Read-only here" />}
      </InspectorSection>
    </div>
  );
}
