/**
 * L5.10b: the take strip above the board (plan §1.4, critique H2: kept minimal) — where the pictures come from
 * ("Pictures from": the scenario's runs; the source run as a shape, words and when), the open comments, the location
 * the runs use, what the last start came to (queued, its outcome with the first line of its error, or the server's
 * refusal with its command) and what the pictures may not show (the scenario changed since the run, only the edit
 * changed, cannot tell, newer runs stopped early, the run's error from the page). A run of this scenario queued or
 * running (`Running`: its progress from `run_status`, Watch live) is the screen's, above both views (review B M1).
 * L5.11a: Rehearse, Capture and Render moved to the status bar (StatusActions.tsx: the buttons, their blockers, Stop ⌘.,
 * the sessions sheet); the last start shown here is the store's (shoot-data.ts `useLastStart`), whoever started it — the
 * status bar, ⌘R, Prepare (review B H1 of L5.10b: its outcome still lands here). Open timeline went with them (the Edit
 * mode opens the same capture).
 */
import { useEffect, useState } from 'react';
import type { ScenarioRunChoice } from '@demo-studio/engine';
import { call, useCall } from './api.js';
import { Txt, When, shown, visibleControls } from './bits.js';
import { commentsEventAction, useEvents } from './events.js';
import { RUN_STATUS_WORDS, partialWords, runErrorWords, stepWords } from './scenario-words.js';
import type { View } from './scenario-words.js';
import { useLastStart } from './shoot-data.js';
import type { LiveRun } from './shoot-data.js';
import { modeWord } from './shoot-words.js';
import { Button, Callout, LinkButton, Progress, Select, StatusMark, TerminalCommands } from './ui-kit/index.js';
import type { MarkState } from './ui-kit/index.js';

export type { LiveRun };

/** The location the runs use: its name and flags in words; `chosen` when it is not the file's own (sent as `env`). */
export interface RunLocation {
  name: string;
  flags: string;
  chosen: boolean;
  fileDefault?: string;
}

const FINISHED_RUN = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
const RUN_MARK: Record<string, MarkState> = { succeeded: 'ok', failed: 'fail', interrupted: 'fail', cancelled: 'warn', running: 'running', queued: 'waiting' };

/** What run_status says of a finished run (its error is text the site controls). */
interface RunOutcome {
  id: string;
  status: string;
  untrusted?: { error_message?: string };
}

/** The first line of a run's error, at most 300 characters. */
function firstLine(s: string): string {
  const l = s.split('\n')[0];
  return l.length > 300 ? `${l.slice(0, 300)}…` : l;
}

/** An option's text (no element can isolate it): run.json's words only through known statuses, controls made visible (review A #4). */
export function runLabel(r: ScenarioRunChoice): string {
  const what = `${modeWord(r.mode)} ${r.id}`;
  const status = RUN_STATUS_WORDS[r.status] ?? 'unknown';
  const state = r.status === 'running' || r.status === 'queued' ? status : r.partial ? partialWords(r.partial) : status;
  return visibleControls(`${what} · ${state}${r.pictures ? '' : ' · no pictures'}`);
}

/**
 * The outcome of the run this screen started, once it ends (review B H1): its status and, from run_status, the first
 * line of its error — a run that failed before its first step (the site down) leaves no picture and would otherwise
 * vanish without a word.
 */
function SubmittedOutcome({ choice, mode, slug, isSource }: { choice: ScenarioRunChoice; mode: 'dry' | 'capture'; slug: string; isSource: boolean }) {
  const [out, setOut] = useState<RunOutcome | null>(null);
  useEffect(() => {
    let live = true;
    call<RunOutcome>('run_status', { project: slug, run_id: choice.id }).then(
      (d) => live && setOut({ id: d.id, status: d.status, ...(d.untrusted ? { untrusted: d.untrusted } : {}) }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [slug, choice.id, choice.status]);
  const status = RUN_STATUS_WORDS[choice.status] ?? 'unknown';
  const ok = choice.status === 'succeeded' && choice.pictures !== null;
  const error = out?.id === choice.id ? out.untrusted?.error_message : undefined;
  const words = choice.partial && choice.status !== 'cancelled' && choice.status !== 'interrupted' ? choice.partial : status;
  return (
    <Callout state={ok ? 'ok' : choice.status === 'cancelled' ? 'warn' : 'fail'} title={`The ${modeWord(mode, true)} ${choice.id} ${words}`}>
      <div data-testid="run-outcome">
        {ok ? <p>{isSource ? 'Its pictures are shown below.' : 'Pick it in “Pictures from” to see its pictures.'}</p> : choice.pictures === null ? <p>It left no picture.</p> : null}
        {error !== undefined && (
          <div className="sb-from-page" data-testid="run-outcome-error">
            <p className="sb-from-page-title">Its error, from the page (text the site controls)</p>
            <p className="sb-pre">
              <Txt text={runErrorWords(firstLine(error))} />
            </p>
          </div>
        )}
      </div>
    </Callout>
  );
}

/** A run of this scenario queued or running: its progress and Watch live (Stop and Pause are the status bar's: one Stop). */
export function Running({ run, live, slug, name }: { run: ScenarioRunChoice | null; live: LiveRun | null; slug: string; name: string }) {
  const r = live && !live.finished ? live : run;
  if (!r) return null;
  const cur = live && !live.finished ? live.current : undefined;
  return (
    <Callout state="running" title={`A ${modeWord(r.mode, true)} of this scenario is ${RUN_STATUS_WORDS[r.status] ?? 'running'}`}>
      <p data-testid="running">
        <Txt className="k-mono" text={r.id} />
        {shown(` · ${r.steps_done}/${r.steps_total} steps`)}
        {cur && <Txt text={` · current ${stepWords(cur.scene, cur.step)} · ${cur.action}`} />}
      </p>
      <Progress label="Steps done" value={r.steps_done} max={Math.max(1, r.steps_total)} valueText={`${r.steps_done} of ${r.steps_total}`} />
      <div className="sb-actions">
        <LinkButton size="sm" to={{ name: 'run', slug, scenario: name, run: r.id }} testId="watch-live">
          Watch live
        </LinkButton>
        <span className="sc-quiet">Pause and Stop are in the status bar (Stop runs the teardown and rollbacks).</span>
      </div>
    </Callout>
  );
}

/** threads_counts' answer: each scenario's open and resolved threads. */
type ThreadCounts = { scenarios: Record<string, { open: number; resolved: number }> };

/** The scenario's open comments (Review mode's threads), as a link (critique M4: the count kept a home). */
export function CommentsCount({ slug, name }: { slug: string; name: string }) {
  const [counts, reload] = useCall<ThreadCounts>('threads_counts', { project: slug, name }, `${slug}\0${name}`);
  useEvents((e) => {
    if (commentsEventAction(e, slug, name).threads) reload();
  });
  const open = counts.state === 'ready' ? (counts.data.scenarios[name]?.open ?? 0) : null;
  return (
    <LinkButton size="sm" variant="ghost" to={{ name: 'comments', slug, scenario: name }} testId="comments-count">
      {shown(open === null ? 'Comments' : `Comments · ${open} open`)}
    </LinkButton>
  );
}

/** The pictures' source: the picker, the source run's mark and words, what the pictures may not show. */
function Pictures({ v, pick, onPick }: { v: View; pick: string | undefined; onPick: (run: string | undefined) => void }) {
  const s = v.source;
  return (
    <>
      {!s && v.runs.length === 0 && <Callout title="Note: no run of this scenario yet">A rehearsal or a capture shows each step's picture here.</Callout>}
      {!s && v.runs.length > 0 && <Callout title="Note: no run of this scenario has pictures yet">Steps show their words only.</Callout>}
      {s?.notice === 'changed' && (
        <Callout state="warn" role="note" title="What the browser does changed since this run" testId="notice-changed">
          {s.filmed_changes && s.filmed_changes.length > 0 && <Txt text={`Changed: ${s.filmed_changes.join('; ')}.`} />}
          <p data-testid="changed-since">
            A render of this run shows the take as it was captured: capture again to film the change. The pictures show the run as it was: steps changed or added since have no picture, and a moved step shows its old place.
          </p>
        </Callout>
      )}
      {s?.notice === 'edit_changed' && (
        <Callout state="idle" role="note" title="Only the edit changed since this run">
          Captions, cards, durations, overlays or the title changed: a render re-plans them on this take, no new capture needed.
        </Callout>
      )}
      {s?.notice === 'cannot_tell' && (
        <Callout state="warn" role="note" title="Cannot tell whether the scenario changed since this run">
          This run kept no copy of the scenario: steps are matched by position, so a picture may belong to a step that changed.
        </Callout>
      )}
      {s && s.newer_partial.length > 0 && !s.picked && (
        <Callout state="warn" role="note" title="Newer runs stopped early" testId="newer-partial">
          <ul>
            {s.newer_partial.map((r) => (
              <li key={r.id} className="sb-line">
                <Txt text={`${modeWord(r.mode)} ${r.id} (${partialWords(r.partial)}${r.pictures === null && r.partial !== 'no pictures' ? ', no pictures' : ''})`} />
                <Button size="sm" variant="ghost" onClick={() => onPick(r.id)}>
                  {r.pictures ? 'Show its pictures' : 'Show this run'}
                </Button>
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {v.untrusted.run_error !== undefined && (
        <div className="sb-from-page" data-testid="run-error">
          <p className="sb-from-page-title">This run's error, from the page (text the site controls)</p>
          <p className="sb-pre">
            <Txt text={runErrorWords(v.untrusted.run_error)} />
          </p>
        </div>
      )}
    </>
  );
}

export function TakeStrip({ v, slug, name, pick, onPick, location }: { v: View; slug: string; name: string; pick: string | undefined; onPick: (run: string | undefined) => void; location: RunLocation | null }) {
  const last = useLastStart(slug, name);
  const submitted = last && 'run_id' in last ? v.runs.find((r) => r.id === last.run_id) : undefined;
  const ended = submitted && FINISHED_RUN.has(submitted.status) && v.running?.id !== submitted.id ? submitted : undefined;
  const refusedFixNode = last && 'error' in last && last.fix ? [...v.run_blockers.dry, ...v.run_blockers.capture].find((b) => b.fix === last.fix)?.fix_node : undefined;
  const s = v.source;
  return (
    <section className="sb-take" aria-label="The take">
      <div className="sb-take-line">
        <Select
          layout="inline"
          label="Pictures from"
          testId="run-picker"
          value={pick ?? ''}
          options={[{ value: '', label: 'The newest complete run (default)' }, ...v.runs.map((r) => ({ value: r.id, label: runLabel(r), disabled: r.status === 'running' || r.status === 'queued' }))]}
          onChange={(x) => onPick(x || undefined)}
        />
        {s && (
          <p className="sb-source" data-testid="source-line">
            <StatusMark state={RUN_MARK[s.status] ?? 'idle'} word={`${modeWord(s.mode)} ${s.run} · ${RUN_STATUS_WORDS[s.status] ?? 'unknown'}`} />{' '}
            <When iso={s.finished_at} />
            {s.hooks && <span className="sc-quiet">{shown(` · hooks: setup ${s.hooks.setup}, teardown ${s.hooks.teardown}`)}</span>}
          </p>
        )}
        <span className="sb-spacer" />
        <CommentsCount slug={slug} name={name} />
      </div>
      <p className="sc-quiet" data-testid="run-location">
        {location && <Txt text={`Rehearse and Capture use the location ${location.name}${location.flags ? ` (${location.flags})` : ''}${location.chosen ? ', chosen in this tab' : ''}. `} />}
        {'A rehearsal skips the hooks and takes a screenshot per step; a capture runs them and films the video. Both start from the status bar.'}
      </p>
      {/* Until the run it queued has ended: then its outcome (and the picker, the pictures) say the rest. */}
      {last && 'run_id' in last && !ended && (
        <p className="sb-line" role="status" data-testid="run-submitted">
          <Txt text={`${modeWord(last.mode)} ${last.run_id} queued: its progress shows above, its pictures here when it ends.`} />
          <LinkButton size="sm" variant="ghost" to={{ name: 'run', slug, scenario: name, run: last.run_id }} testId="watch-submitted">
            Watch it live
          </LinkButton>
        </p>
      )}
      {last && 'run_id' in last && ended && <SubmittedOutcome choice={ended} mode={last.mode} slug={slug} isSource={v.source?.run === ended.id} />}
      {last && 'error' in last && (
        <Callout state="fail" role="alert" title={`Blocked: the ${modeWord(last.mode, true)} was not started`}>
          <p className="sb-pre" data-testid="run-refused">
            <Txt text={last.error} />
          </p>
          <TerminalCommands {...(last.fix ? { fix: last.fix } : {})} {...(refusedFixNode ? { fixNode: refusedFixNode } : {})} />
        </Callout>
      )}
      <Pictures v={v} pick={pick} onPick={onPick} />
    </section>
  );
}
