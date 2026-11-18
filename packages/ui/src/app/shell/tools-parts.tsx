/**
 * The app's downloaded Tools — the parts the Set-up sheet's item, Welcome's card, the Tools page (`#/setup/tools`)
 * and the screens whose work needs them show (words/tools-words.ts; data/tools.ts): the three rows (each Tool, its
 * version and publisher, what it is for, its size or its bar and figure), the actions of each state (Download · N MB,
 * Pause, Cancel, Resume, Try again, Copy the details, Terms of each tool…), the offline and mismatch callouts, the terms,
 * and the "not downloaded yet" state of work that needs them. Every action is a click; the page never sends a path,
 * a URL or a source. What the system said is text (Txt).
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { errorText } from '../api.js';
import { Txt } from '../bits.js';
import { toolsControl, toolsInstall } from '../data/tools.js';
import { refreshTools, useTools } from '../tools-data.js';
import { Button, Callout, Facts, LinkButton, Progress } from '../ui-kit/index.js';
import {
  NEED_WORDS,
  TOOL_USE,
  cannotWords,
  downloadLabel,
  mismatchDetails,
  mismatchSentence,
  needsMissing,
  neededSentence,
  waitingSentence,
  offlineSentence,
  rowFigure,
  rowPercent,
  shortDigest,
  shortUrl,
} from '../words/tools-words.js';
import type { ToolView, ToolsView } from '../words/tools-words.js';

/** The last action's outcome under the actions (a failure is an alert). */
type Said = { state: 'ok' | 'fail'; text: string } | null;

/** The actions' state: the one in flight, its outcome, and the run (each answer reads the status again). */
export function useToolsAct() {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const act = (key: string, run: () => Promise<unknown>, ok?: string) => {
    if (busy) return;
    setBusy(key);
    setSaid(null);
    run().then(
      () => {
        setBusy(null);
        if (ok) setSaid({ state: 'ok', text: ok });
        void refreshTools();
      },
      (e: unknown) => {
        setBusy(null);
        setSaid({ state: 'fail', text: errorText(e) });
        void refreshTools();
      },
    );
  };
  return { busy, said, setSaid, act };
}

/** The three Tools: before a download their sizes, during and after it a bar and a figure each. */
export function ToolRows({ s, testId = 'tools-parts' }: { s: ToolsView; testId?: string }) {
  return (
    <ul className="sh-tools-parts" aria-label="The Tools" data-testid={testId}>
      {s.tools.map((t) => {
        const pct = rowPercent(t, s.state);
        const fig = rowFigure(t, s.state);
        const name = `${t.label} · ${t.name} ${t.version}`;
        return (
          <li key={t.id} className="sh-tools-part" data-testid={`tools-part-${t.id}`} data-state={t.state}>
            {pct === null ? (
              <>
                <span className="sh-tools-name">
                  <Txt text={t.label} />
                  <Txt className="sh-tools-v" text={` ${t.name} ${t.version} · ${t.publisher}`} />
                </span>
                <span className="sh-tools-use">{TOOL_USE[t.id]}</span>
                <span className="sh-tools-num">{fig.text}</span>
              </>
            ) : (
              <Progress label={<Txt text={name} />} value={pct} valueText={fig.text} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The mismatch: which Tool was refused, its expected and received digests, where it came from. */
function MismatchCallout({ t }: { t: ToolView }) {
  return (
    <Callout state="fail" role="alert" title="A file does not match its digest" testId="tools-mismatch">
      <p>
        <Txt text={mismatchSentence(t)} />
      </p>
      <Facts
        label="The file refused"
        rows={[
          { key: 'expected', label: 'Expected', value: <Txt className="k-mono" text={shortDigest(t.expected)} title={t.expected ?? ''} /> },
          { key: 'got', label: 'Received', value: <Txt className="k-mono" text={shortDigest(t.got)} title={t.got ?? ''} /> },
          { key: 'from', label: 'From', value: <Txt className="k-mono" text={shortUrl(t.url)} title={t.url} /> },
        ]}
      />
    </Callout>
  );
}

/** What stopped the download (offline, mismatch, failed), as a callout; null otherwise. */
export function ToolsStopped({ s }: { s: ToolsView }) {
  const why = s.untrusted?.message;
  if (s.state === 'offline')
    return (
      <Callout state="warn" role="status" title="The download stopped: no connection" testId="tools-offline">
        <p>{offlineSentence(s)}</p>
        {why && <Txt className="sh-tools-why" text={why} />}
      </Callout>
    );
  if (s.state === 'mismatch') {
    const t = s.tools.find((x) => x.state === 'mismatch');
    return t ? <MismatchCallout t={t} /> : null;
  }
  if (s.state === 'failed' || s.state === 'damaged')
    return (
      <Callout state="fail" role="alert" title={s.state === 'damaged' ? 'A Tool changed on disk' : 'The download stopped'} testId="tools-failed">
        <p>{s.state === 'damaged' ? 'Check again, then download it again: nothing runs it meanwhile.' : 'Try again: what arrived is kept.'}</p>
        {why && <Txt className="sh-tools-why" text={why} />}
      </Callout>
    );
  return null;
}

/** Our own short notices: each Tool's publisher, licence, where it comes from, and that the app does not redistribute it. */
export function ToolsTerms({ s }: { s: ToolsView }) {
  return (
    <ul className="sh-tools-terms" aria-label="Terms of each tool" data-testid="tools-terms">
      {s.tools.map((t) => (
        <li key={t.id}>
          <Txt className="sh-tools-term-name" text={`${t.name} ${t.version}`} />
          <Txt
            text={` — by ${t.publisher}, under ${t.licence}. Downloaded from ${new URL(t.url).host}, its publisher's, the first time it is needed; the app does not redistribute it.`}
          />
          {t.licences.length > 0 && <Txt className="sh-tools-licences k-mono" text={`Its own terms, in its folder: ${t.licences.join(', ')}`} />}
        </li>
      ))}
    </ul>
  );
}

/** The copied state of "Copy the details". */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return [copied, copy];
}

/** The state's actions: the primary one first (Download, Resume, Try again), then Pause / Cancel, the details, the terms. */
export function ToolsActions({ s, act, busy, details = true, terms, onTerms }: { s: ToolsView; act: ReturnType<typeof useToolsAct>['act']; busy: string | null; details?: boolean; terms?: boolean; onTerms?: () => void }) {
  const [copied, copy] = useCopied();
  const off = s.can !== 'ok' || !!busy;
  const why = cannotWords(s) ?? undefined;
  const install = (label: string, key: string): ReactNode => (
    <Button variant="primary" disabled={off} busy={busy === key} why={why} data-testid={`tools-${key}`} onClick={() => act(key, () => toolsInstall())}>
      {label}
    </Button>
  );
  const control = (action: 'pause' | 'cancel', label: string): ReactNode => (
    <Button variant={action === 'pause' ? 'secondary' : 'ghost'} disabled={s.can !== 'ok' || !!busy} busy={busy === action} data-testid={`tools-${action}`} onClick={() => act(action, () => toolsControl({ action }))}>
      {label}
    </Button>
  );
  const mismatch = s.tools.find((t) => t.state === 'mismatch');
  return (
    <>
      {s.state === 'needed' && install(downloadLabel(s), 'download')}
      {(s.state === 'paused' || s.state === 'offline') && install('Resume', 'resume')}
      {(s.state === 'mismatch' || s.state === 'failed') && install('Try again', 'retry')}
      {s.state === 'damaged' && install('Download again', 'download')}
      {s.state === 'downloading' && control('pause', 'Pause')}
      {(s.state === 'downloading' || s.state === 'paused' || s.state === 'offline' || s.state === 'failed') && control('cancel', 'Cancel')}
      {mismatch && (
        <Button variant="ghost" data-testid="tools-copy" onClick={() => copy(mismatchDetails(mismatch))}>
          {copied ? 'Copied' : 'Copy the details'}
        </Button>
      )}
      {onTerms && (
        <Button variant="ghost" aria-expanded={terms === true} data-testid="tools-terms-toggle" onClick={onTerms}>
          Terms of each tool…
        </Button>
      )}
      {details && (
        <LinkButton variant="ghost" to={{ name: 'setup-tools' }} testId="tools-details">
          Show details
        </LinkButton>
      )}
    </>
  );
}

/** The last action's outcome (an alert when it failed). */
export function ToolsSaid({ said }: { said: Said }) {
  if (!said) return null;
  return said.state === 'fail' ? (
    <Callout state="fail" role="alert" title={<Txt text={said.text} />} testId="tools-said" />
  ) : (
    <Callout state="ok" role="status" title={<Txt text={said.text} />} testId="tools-said" />
  );
}

/**
 * Work outside the queue that needs the Tools (a component's or a theme's preview, a still, a comment's frame) while
 * they are not downloaded: one sentence and the way to them — Download here (the app's own server), else Show details.
 * Nothing while they are ready, in a checkout, or before the status is known.
 */
export function ToolsNeeded({ need, what, queued, testId = 'tools-needed' }: { need: 'browser' | 'render'; what: string; queued?: boolean; testId?: string }) {
  const s = useTools();
  const { busy, said, act } = useToolsAct();
  if (!s || !needsMissing(s, need)) return null;
  const downloading = s.state === 'downloading';
  // A queued job: it waits in the queue and starts by itself; other work says it cannot run yet.
  const title = queued ? `Waiting for ${NEED_WORDS[need]}` : downloading ? `Downloading ${NEED_WORDS[need]}` : 'Not downloaded yet';
  const text = queued ? waitingSentence(s, need, what) : downloading ? `${what} can run once the download is checked.` : neededSentence(need, what);
  return (
    <Callout state={downloading || queued ? 'running' : 'warn'} role="status" title={title} testId={testId}>
      <p>{text}</p>
      <div className="sh-tools-needed-actions">
        {s.state === 'needed' && s.can === 'ok' ? (
          <Button variant="primary" busy={busy === 'download'} data-testid={`${testId}-download`} onClick={() => act('download', () => toolsInstall())}>
            {downloadLabel(s)}
          </Button>
        ) : null}
        <LinkButton variant="ghost" to={{ name: 'setup-tools' }} testId={`${testId}-details`}>
          Show the download
        </LinkButton>
      </div>
      <ToolsSaid said={said} />
    </Callout>
  );
}
