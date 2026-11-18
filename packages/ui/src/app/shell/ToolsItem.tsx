/**
 * The Tools in the shell: the Set-up sheet's first item "Browser and render tools" (ToolsItem — its rows, the digest
 * line and the folder, Download · N MB and Terms of each tool…, then the download's bars, Pause and Cancel, the
 * offline and mismatch callouts) and the status bar's control (ToolsControl — "Downloading tools · 38 %", a stopped or
 * failed download, Tools not downloaded yet: a ghost button to the Tools page). Done closes the sheet: the download
 * goes on, its progress stays in the status bar. Words: words/tools-words.ts; parts: tools-parts.tsx.
 */
import { useState } from 'react';
import { Txt } from '../bits.js';
import { APP_NAME } from '../brand.js';
import { useTools } from '../tools-data.js';
import { ChecklistItem, LinkButton, StatusMark } from '../ui-kit/index.js';
import { TOOLS_TITLE, folderWords, toolsBarWords, toolsWord } from '../words/tools-words.js';
import { ToolRows, ToolsActions, ToolsSaid, ToolsStopped, ToolsTerms, useToolsAct } from './tools-parts.js';

/** The Set-up sheet's item (nothing in a checkout: the sheet says set-up is the installed app's). */
export function ToolsItem({ open }: { open: boolean }) {
  const s = useTools(open);
  const { busy, said, act } = useToolsAct();
  const [terms, setTerms] = useState(false);
  if (!s?.available) return null;
  const w = s.can === 'location' ? { state: 'attention' as const, word: 'Blocked: move the app first' } : toolsWord(s);
  const before = s.state === 'needed';
  return (
    <ChecklistItem
      state={w.state}
      word={w.word}
      title={TOOLS_TITLE}
      testId="setup-tools"
      actions={<ToolsActions s={s} act={act} busy={busy} terms={terms} onTerms={() => setTerms((t) => !t)} />}
    >
      {before && <p>{`${APP_NAME} films and renders with these. They are not in the disk image: the app downloads them once, from their publishers, into your ${APP_NAME} home.`}</p>}
      <ToolRows s={s} />
      {s.state === 'downloading' ? (
        <p className="sh-tools-note">Done closes this list: the download goes on, its progress stays in the status bar.</p>
      ) : (
        <p className="sh-tools-note">
          {`Each file is checked against the digest this version of ${APP_NAME} records before it is kept. `}
          <Txt className="k-mono" text={folderWords(s)} />
        </p>
      )}
      {s.state !== 'ready' && <p className="sh-tools-note">Captures and renders wait until the tools are here.</p>}
      <ToolsStopped s={s} />
      {terms && <ToolsTerms s={s} />}
      <ToolsSaid said={said} />
    </ChecklistItem>
  );
}

/** The status bar's control: the download's percent, a stop or a failure, Tools not downloaded yet — to the Tools page. */
export function ToolsControl() {
  const s = useTools();
  const w = toolsBarWords(s);
  if (!w) return null;
  return (
    <span className="sh-seg" data-testid="tools-bar">
      {' · '}
      <LinkButton size="sm" variant="ghost" to={{ name: 'setup-tools' }} testId="tools-bar-link">
        <StatusMark state={w.state} word={w.text} />
      </LinkButton>
    </span>
  );
}
