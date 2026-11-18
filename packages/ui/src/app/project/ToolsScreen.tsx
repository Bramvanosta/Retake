/**
 * The Tools page (`#/setup/tools`; the approved mockup's Settings › Tools: there is no app Settings) — what the
 * app downloaded next to itself for this version: each Tool's version and source, its download and its size on disk,
 * its state; the folder (and whether $RETAKE_HOME chose the home it is in), the last check; Check again, Show in
 * Finder (the desktop app's shell shows its own folder), Terms of each tool… (our notices, and each folder's own
 * licence files); while not ready, the download and its actions; the older versions and Remove… (an inline
 * confirmation: the prune keeps what another copy of the app used in the last 30 days, and says so). Reached from the
 * Set-up sheet's item and the status bar's control. Every action is a click of the app's own server (tools-ops.ts).
 */
import { useEffect, useState } from 'react';
import { APP_NAME } from '../brand.js';
import { Txt } from '../bits.js';
import { toolsCheck, toolsPrune, toolsReveal } from '../data/tools.js';
import { refreshTools, useTools } from '../tools-data.js';
import { BrowserCollapsed } from '../shell/slots.js';
import { ToolRows, ToolsActions, ToolsSaid, ToolsStopped, ToolsTerms, useToolsAct } from '../shell/tools-parts.js';
import { Button, Callout, DataTable, EmptyState, Facts, LinkButton, Progress, StatusMark } from '../ui-kit/index.js';
import { TOOL_USE, checkedWords, folderWords, megabytes, olderWords, toolsWord } from '../words/tools-words.js';
import type { ToolView, ToolsView } from '../words/tools-words.js';

/** A Tool's state on the page: its mark and its word. */
function toolState(t: ToolView): { state: 'ok' | 'running' | 'warn' | 'fail'; word: string } {
  if (t.state === 'ready') return { state: 'ok', word: 'Ready' };
  if (t.state === 'damaged' || t.state === 'mismatch' || t.state === 'failed') return { state: 'fail', word: t.state === 'damaged' ? 'Damaged' : 'Failed' };
  if (t.state === 'downloading' || t.state === 'checking' || t.state === 'extracting' || t.state === 'waiting') return { state: 'running', word: 'Downloading' };
  return { state: 'warn', word: t.state === 'paused' ? 'Paused' : 'Missing' };
}

function ToolsTable({ s }: { s: ToolsView }) {
  return (
    <DataTable
      caption="The Tools of this version"
      captionHidden
      testId="tools-table"
      columns={[
        { key: 'tool', label: 'Tool' },
        { key: 'source', label: 'Version and source' },
        { key: 'download', label: 'Download', numeric: true },
        { key: 'disk', label: 'On disk', numeric: true },
        { key: 'state', label: 'State' },
      ]}
      rows={s.tools.map((t) => {
        const st = toolState(t);
        return {
          key: t.id,
          cells: [
            <span key="t" className="tl-tool">
              <Txt text={t.label} />
              <span className="tl-use">{TOOL_USE[t.id]}</span>
            </span>,
            <span key="s" className="tl-tool">
              <Txt text={`${t.name} ${t.version}`} />
              <Txt className="tl-use" text={`${t.publisher} · ${new URL(t.url).host}`} />
            </span>,
            megabytes(t.bytes),
            megabytes(t.disk),
            <StatusMark key="m" state={st.state} word={st.word} />,
          ],
        };
      })}
    />
  );
}

/** The older versions' card: what this version does not name, and Remove… with its confirmation. */
function OlderCard({ s, act, busy }: { s: ToolsView; act: ReturnType<typeof useToolsAct>['act']; busy: string | null }) {
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const words = olderWords(s);
  if (!words && !result) return null;
  const remove = () => {
    setConfirm(false);
    act('prune', async () => {
      const r = await toolsPrune();
      const gone = r.removed.reduce((n, x) => n + x.bytes, 0);
      setResult(
        r.busy
          ? 'A download holds the Tools folder now: nothing was removed.'
          : `${r.removed.length === 0 ? 'Nothing was removed' : `Removed ${r.removed.length} folder${r.removed.length === 1 ? '' : 's'} (${megabytes(gone)})`}${r.kept.length ? `; kept ${r.kept.map((k) => `${k.folder} (${k.why})`).join(', ')}` : ''}.`,
      );
    });
  };
  return (
    <section className="wl-panel" aria-labelledby="tl-older-h" data-testid="tools-older">
      <h2 id="tl-older-h" className="sc-h2">
        <Txt text={words ?? 'Older versions'} />
      </h2>
      {words && <Txt className="k-mono tl-folders" text={s.older.folders.join(', ')} />}
      <p>{`Folders this version does not name. Remove… takes away those no copy of ${APP_NAME} on this Mac used in the last 30 days, nor an update waits for.`}</p>
      {result && <Callout state="ok" role="status" title={<Txt text={result} />} testId="tools-pruned" />}
      {words && !confirm && (
        <div className="tl-actions">
          <Button disabled={s.can !== 'ok' || !!busy} busy={busy === 'prune'} data-testid="tools-remove" onClick={() => setConfirm(true)}>
            Remove…
          </Button>
        </div>
      )}
      {confirm && (
        // biome-ignore lint/a11y/useSemanticElements: an inline confirmation (text and two buttons); <fieldset> would bring its own border, padding and min-width
        <div className="tl-confirm" role="group" aria-label="Remove the older Tools">
          <p>{`Remove ${s.older.folders.length} folder${s.older.folders.length === 1 ? '' : 's'} (${megabytes(s.older.bytes)})? They are downloaded again if a version needs them.`}</p>
          <div className="tl-actions">
            <Button variant="destructive" data-testid="tools-remove-confirm" onClick={remove}>
              Remove
            </Button>
            <Button variant="ghost" data-testid="tools-remove-keep" onClick={() => setConfirm(false)}>
              Keep them
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function ToolsScreen() {
  const s = useTools(true);
  const { busy, said, act } = useToolsAct();
  const [terms, setTerms] = useState(false);
  useEffect(() => void refreshTools(), []);
  if (!s) {
    return (
      <div className="sc-screen">
        <BrowserCollapsed />
        <Progress label="Reading the Tools…" />
      </div>
    );
  }
  if (!s.available) {
    return (
      <div className="sc-screen">
        <BrowserCollapsed />
        <EmptyState level={1} title="Tools" actions={<LinkButton to={{ name: 'projects' }}>Back to the projects</LinkButton>}>
          {`This ${APP_NAME} runs from a repository checkout: it uses Playwright's cache and node_modules, there is nothing to download.`}
        </EmptyState>
      </div>
    );
  }
  const w = toolsWord(s);
  const checked = checkedWords(s);
  return (
    <div className="sc-screen" data-testid="tools-screen">
      <BrowserCollapsed />
      <header className="tl-head">
        <h1 className="sc-h1">
          Tools
        </h1>
        <p className="sc-quiet">{`What ${APP_NAME} downloaded next to the app, for this version. Each was checked against its digest when it arrived.`}</p>
      </header>
      <section className="tl-state" aria-label="State" data-testid="tools-state">
        <StatusMark state={w.state} word={w.word} />
        {s.state !== 'ready' && <ToolRows s={s} testId="tools-page-parts" />}
        <ToolsStopped s={s} />
      </section>
      <ToolsTable s={s} />
      <Facts
        label="Where"
        rows={[
          { key: 'folder', label: 'Folder', value: <Txt className="k-mono" text={folderWords(s)} /> },
          { key: 'checked', label: 'Checked', value: s.checking ? 'Checking every file…' : (checked ?? 'when each arrived (Check again reads every file)') },
        ]}
      />
      <div className="tl-actions">
        {s.state !== 'ready' && <ToolsActions s={s} act={act} busy={busy} details={false} />}
        <Button disabled={s.can !== 'ok' || !!busy || s.checking || s.state === 'downloading'} busy={busy === 'check' || s.checking} data-testid="tools-check" onClick={() => act('check', () => toolsCheck())}>
          Check again
        </Button>
        <Button variant="ghost" disabled={s.can !== 'ok' || !!busy} data-testid="tools-reveal" onClick={() => act('reveal', () => toolsReveal())}>
          Show in Finder
        </Button>
        <Button variant="ghost" aria-expanded={terms} data-testid="tools-terms-toggle" onClick={() => setTerms((t) => !t)}>
          Terms of each tool…
        </Button>
      </div>
      {terms && <ToolsTerms s={s} />}
      <ToolsSaid said={said} />
      <OlderCard s={s} act={act} busy={busy} />
    </div>
  );
}
