/**
 * L5.12c « Épure » 4c: the Library's "Create with Claude" (R4-Library; was LibraryScreen.tsx's native `<dialog>`) — a
 * kit Sheet, not destructive: a prompt for Claude Code's component skill and the scaffold command, both built from the
 * kind, a checked id and the person's words (library-words.ts `createPrompt`: no manifest text, ever). The Studio writes
 * no code and calls no model.
 * - Copy the prompt is the sheet's default (off until there is a prompt: the focus then starts on the first field);
 *   Close / Escape closes.
 * - The person's words are the screen's (`brief`, LibraryScreen.tsx): closing keeps them, reopening shows them again; the
 *   desktop app's quit question names them (`component_brief`) while they are not empty.
 */
import { useId, useRef, useState } from 'react';
import { APP_NAME } from '../brand.js';
import { Txt } from '../bits.js';
import { KIND_ORDER, createPrompt, idProblem, kindHeading } from '../words/library-words.js';
import { ChoiceChips, Sheet, TextArea, TextField } from '../ui-kit/index.js';

/** What the person typed: kept by the screen across a close and a reopen. */
export interface Brief {
  kind: string;
  id: string;
  words: string;
  /** A component to start from ("A new one like it"). */
  like?: string;
}

export function CreateSheet({
  open,
  slug,
  theme,
  taken,
  brief,
  setBrief,
  onClose,
}: {
  open: boolean;
  slug: string;
  theme: string;
  taken: string[];
  brief: Brief;
  setBrief: (b: Brief) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const prompt = useRef<HTMLTextAreaElement>(null);
  const ids = useId();
  const problem = brief.id ? idProblem(brief.id, taken) : null;
  const made = !problem && brief.id ? createPrompt({ kind: brief.kind, id: brief.id, project: slug, theme, description: brief.words, ...(brief.like ? { like: brief.like } : {}) }) : null;
  const copy = () => {
    if (!made) return;
    const fail = () => {
      setCopied('failed');
      prompt.current?.select();
    };
    try {
      navigator.clipboard.writeText(made.prompt).then(() => setCopied('yes'), fail);
    } catch {
      fail();
    }
  };
  return (
    <Sheet
      open={open}
      testId="lib-create"
      title="Create a component with Claude"
      actions={[
        { id: 'copy', label: 'Copy the prompt', variant: 'primary', isDefault: true, disabled: !made, testId: 'lib-create-copy' },
        { id: 'close', label: 'Close', isCancel: true },
      ]}
      onAction={(id) => {
        if (id === 'copy') copy();
        else {
          setCopied('no');
          onClose();
        }
      }}
      content={
        <>
          <div className="lb-create-kind">
            <span id={`${ids}-kind`} className="lb-label">
              Kind
            </span>
            <ChoiceChips
              labelledBy={`${ids}-kind`}
              chips={KIND_ORDER.map((k) => ({ key: k, label: kindHeading(k, 1), value: k, checked: brief.kind === k }))}
              onPick={(k) => setBrief({ ...brief, kind: k })}
            />
          </div>
          <TextField
            label="Id (namespace/name)"
            value={brief.id}
            onChange={(v) => setBrief({ ...brief, id: v.trim() })}
            unsaved={null}
            mono
            maxLength={120}
            placeholder="acme/intro-split"
            autoComplete="off"
            spellCheck={false}
            testId="lib-create-id"
            error={problem ?? undefined}
          />
          <TextArea
            label="What it should do (your words; kept in this tab only)"
            value={brief.words}
            onChange={(v) => setBrief({ ...brief, words: v })}
            // The screen owns the mark (the words outlive the sheet: closing keeps them).
            unsaved={null}
            rows={3}
            maxLength={2000}
            testId="lib-create-words"
          />
          {made ? (
            <>
              <TextArea label="The prompt" value={made.prompt} onChange={() => undefined} unsaved={null} readOnly rows={6} inputRef={prompt} testId="lib-create-prompt" />
              <p className="lb-sheet-line">
                {'Or scaffold it yourself in a terminal, in the workspace folder: '}
                <code className="k-mono lb-code" data-testid="lib-create-command">
                  <Txt text={made.command} />
                </code>
              </p>
            </>
          ) : (
            <p className="lb-sheet-line lb-quiet">Give it a kind and an id: the prompt shows here.</p>
          )}
          <p className="lb-sheet-line" role="status" data-testid="lib-create-copied">
            {copied === 'yes' ? 'Copied.' : copied === 'failed' ? 'Copying was refused: the prompt is selected — copy it with ⌘C.' : ''}
          </p>
        </>
      }
    >
      <Txt
        text={`The Studio writes no code and calls no model: copy this prompt into Claude Code (with the ${APP_NAME} plugin). The new component appears in the Library when its folder is written.`}
      />
    </Sheet>
  );
}
