/**
 * L5.10b: the take strip above the board (plan §1.4, critique H2: kept minimal — L5.11 moves Dry run / Capture to the
 * status bar's actions) — where the pictures come from ("Pictures from": the scenario's runs; the source run as a shape,
 * words and when), the open comments, the runs from the Studio (a Dry run and a Capture button, each with what would
 * stop it said before any click: a blocked one is disabled, says "needs the terminal" with the reason and the exact
 * `studio run …` command to type there), the location they use (critique M1), Open timeline, what the last click came to (queued, its
 * outcome with the first line of its error, or the server's refusal) and what the pictures may not show (the scenario
 * changed since the run, only the edit changed, cannot tell, newer runs stopped early, the run's error from the page).
 * A run of this scenario queued or running (`Running`: its progress from `run_status`, Watch live, Cancel) is the
 * screen's, above both views (review B M1: the YAML view shows it too).
 *
 * A click asks `scenario_run` with pinned arguments (the scenario, the mode, the file as shown — and the location only
 * when it is not the file's own: critique M1); the server checks again and its refusal is shown the same way. A capture
 * refused for sessions to confirm asks the person (ConfirmSessions, the Sessions panel's own dialog).
 */
import { useEffect, useState } from 'react';
import type { ScenarioRunChoice, RunBlocker } from '@demo-studio/engine';
import { CallError, call, errorText, useCall } from './api.js';
import { Txt, When, shown, visibleControls } from './bits.js';
import { commentsEventAction, useEvents } from './events.js';
import { hrefTo } from './route.js';
import { ConfirmSessions } from './Sessions.js';
import type { SessionToConfirm } from './Sessions.js';
import { MODE, RUN_STATUS_WORDS, runErrorWords, stepWords, timelineRun } from './scenario-words.js';
import type { View } from './scenario-words.js';
import { Button, Callout, Disclosure, LinkButton, Progress, Select, StatusMark, TerminalCommands } from './ui-kit/index.js';
import type { MarkState } from './ui-kit/index.js';

/** A running run as `run_status` tells it. */
export interface LiveRun {
  id: string;
  mode: string;
  status: string;
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  finished: boolean;
}

/** The location the runs use: its name and flags in words; `chosen` when it is not the file's own (sent as `env`). */
export interface RunLocation {
  name: string;
  flags: string;
  chosen: boolean;
  fileDefault?: string;
}

/** What the last Dry run / Capture click came to: queued (its run id), or the server's refusal and its command. */
type Submitted = { mode: 'dry' | 'capture'; run_id: string } | { mode: 'dry' | 'capture'; error: string; fix?: string };

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
  const what = `${r.mode === 'dry' ? 'Dry run' : 'Capture'} ${r.id}`;
  const status = RUN_STATUS_WORDS[r.status] ?? 'unknown';
  const state = r.status === 'running' || r.status === 'queued' ? status : (r.partial ?? status);
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
    <Callout state={ok ? 'ok' : choice.status === 'cancelled' ? 'warn' : 'fail'} title={`The ${MODE(mode)} ${choice.id} ${words}`}>
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

/** A run of this scenario queued or running: its progress, Watch live, Cancel (the screen shows it above both views). */
export function Running({ run, live, slug, name, onCancelled }: { run: ScenarioRunChoice | null; live: LiveRun | null; slug: string; name: string; onCancelled: () => void }) {
  const [cancel, setCancel] = useState<{ id: string; state: 'sending' | 'asked' | string } | null>(null);
  const r = live && !live.finished ? live : run;
  if (!r) return null;
  const cur = live && !live.finished ? live.current : undefined;
  const mine = cancel && cancel.id === r.id ? cancel : null;
  const stop = () => {
    setCancel({ id: r.id, state: 'sending' });
    call('run_cancel', { project: slug, run_id: r.id }).then(
      () => {
        setCancel({ id: r.id, state: 'asked' });
        // A queued run is cancelled at once (its run.json is finalised later by a worker, if one runs): read again now.
        onCancelled();
      },
      (e: unknown) => setCancel({ id: r.id, state: errorText(e) }),
    );
  };
  return (
    <Callout state="running" title={`A ${MODE(r.mode)} of this scenario is ${RUN_STATUS_WORDS[r.status] ?? 'running'}`}>
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
        <Button size="sm" data-testid="run-cancel" disabled={mine?.state === 'sending' || mine?.state === 'asked'} onClick={stop}>
          {mine?.state === 'sending' ? 'Cancelling…' : mine?.state === 'asked' ? 'Cancel asked' : 'Cancel this run'}
        </Button>
        {mine?.state === 'asked' && <span className="sc-quiet">A running run stops at its next step; its teardown and rollbacks still run.</span>}
        {mine && mine.state !== 'sending' && mine.state !== 'asked' && (
          <span role="alert">
            <Txt text={mine.state} />
          </span>
        )}
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
      {!s && v.runs.length === 0 && <Callout title="Note: no run of this scenario yet">A dry run or a capture shows each step's picture here.</Callout>}
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
                <Txt text={`${MODE(r.mode)} ${r.id} (${r.partial}${r.pictures === null && r.partial !== 'no pictures' ? ', no pictures' : ''})`} />
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

export function TakeStrip({
  v,
  slug,
  name,
  pick,
  onPick,
  live,
  location,
  onSubmitted,
}: {
  v: View;
  slug: string;
  name: string;
  pick: string | undefined;
  onPick: (run: string | undefined) => void;
  live: LiveRun | null;
  location: RunLocation | null;
  onSubmitted: () => void;
}) {
  const busy = v.running !== null || (live !== null && !live.finished);
  const [sending, setSending] = useState<'dry' | 'capture' | null>(null);
  const [last, setLast] = useState<Submitted | null>(null);
  // L4.4: a capture refused for sessions to confirm (409 `details.sessions`) asks the person (ConfirmSessions).
  const [confirm, setConfirm] = useState<SessionToConfirm[] | null>(null);
  const start = (mode: 'dry' | 'capture', ack?: string[]) => {
    setSending(mode);
    setLast(null);
    setConfirm(null);
    // The file as this screen shows it (review A #6): a file changed since is refused (409) and the screen reads it again.
    // The location only when it is not the file's own (critique M1: the bodies of a default run are unchanged).
    call<{ run_id: string }>('scenario_run', { project: slug, name, mode, hash: v.hash, ...(location?.chosen ? { env: location.name } : {}), ...(ack ? { sessions_ack: ack } : {}) })
      .then(
        (d) => {
          setLast({ mode, run_id: d.run_id });
          onSubmitted();
        },
        (e: unknown) => {
          const listed = e instanceof CallError ? (e.error.details?.sessions as SessionToConfirm[] | undefined) : undefined;
          if (mode === 'capture' && Array.isArray(listed) && listed.length > 0) {
            setConfirm(listed);
            return;
          }
          setLast({ mode, error: errorText(e), ...(e instanceof CallError && e.error.fix ? { fix: e.error.fix } : {}) });
          if (e instanceof CallError && e.error.code === 'conflict') onSubmitted();
        },
      )
      .finally(() => setSending(null));
  };
  const runRow = (mode: 'dry' | 'capture', label: string, list: RunBlocker[]) => {
    const id = `blockers-${mode}`;
    const blocked = list.length > 0;
    // A file with errors: no command helps — the terminal refuses it too (review B M6).
    const fileFirst = list.some((b) => b.fix_file);
    return (
      // Its pieces sit in the strip's one line (the wrapper draws no box); the reasons fold under it (critique H2).
      <div className="sb-run" data-testid={`blockers-${label.toLowerCase().replace(' ', '-')}`}>
        <Button
          size="sm"
          variant={blocked ? 'secondary' : mode === 'capture' ? 'record' : 'primary'}
          data-testid={`run-${mode}`}
          disabled={blocked || busy || sending !== null}
          aria-describedby={id}
          onClick={() => start(mode)}
        >
          {shown(sending === mode ? `Starting the ${MODE(mode)}…` : fileFirst ? `${label} — fix the file first` : blocked ? `${label} — needs the terminal` : label)}
        </Button>
        <span id={id} className="sc-quiet sb-run-why">
          {blocked ? (
            shown(fileFirst ? 'the file has errors' : list.some((b) => b.fix) ? 'why, and the command to type, below' : 'why below')
          ) : busy ? (
            shown('waits for the run of this scenario to finish')
          ) : (
            <StatusMark state="ok" word="ready · nothing stops it" />
          )}
        </span>
        {blocked && (
          <div className="sb-run-reasons">
            <Disclosure summary={`${label}: the reason${list.some((b) => b.fix) ? ' and the command' : ''}`}>
              {list.map((b, i) => (
                <div key={i} className="sb-blocker">
                  <p className="sb-pre">
                    <Txt text={b.message} />
                  </p>
                  <TerminalCommands {...(b.fix ? { fix: b.fix } : {})} {...(b.fix_node ? { fixNode: b.fix_node } : {})} />
                </div>
              ))}
            </Disclosure>
          </div>
        )}
      </div>
    );
  };
  const submitted = last && 'run_id' in last ? v.runs.find((r) => r.id === last.run_id) : undefined;
  const ended = submitted && FINISHED_RUN.has(submitted.status) && v.running?.id !== submitted.id ? submitted : undefined;
  const refusedFixNode = last && 'error' in last && last.fix ? [...v.run_blockers.dry, ...v.run_blockers.capture].find((b) => b.fix === last.fix)?.fix_node : undefined;
  const run = timelineRun(v);
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
            <StatusMark state={RUN_MARK[s.status] ?? 'idle'} word={`${MODE(s.mode)} ${s.run} · ${RUN_STATUS_WORDS[s.status] ?? 'unknown'}`} />{' '}
            <When iso={s.finished_at} />
            {s.hooks && <span className="sc-quiet">{shown(` · hooks: setup ${s.hooks.setup}, teardown ${s.hooks.teardown}`)}</span>}
          </p>
        )}
        <span className="sb-spacer" />
        <CommentsCount slug={slug} name={name} />
      </div>
      <div className="sb-runs">
        {shown(runRow('dry', 'Dry run', v.run_blockers.dry))}
        {shown(runRow('capture', 'Capture', v.run_blockers.capture))}
        {run ? (
          <span className="sb-run-item">
            <LinkButton size="sm" variant="ghost" to={{ name: 'timeline', slug, scenario: name, run }} testId="open-timeline">
              Open timeline
            </LinkButton>
            <span className="sc-quiet">
              {'capture '}
              <Txt className="k-mono" text={run} />
            </span>
          </span>
        ) : (
          <span className="sb-run-item">
            <Button size="sm" variant="ghost" disabled why="no finished capture yet: a capture films the take the timeline edits" data-testid="open-timeline-off">
              Open timeline
            </Button>
          </span>
        )}
      </div>
      <p className="sc-quiet" data-testid="run-location">
        {location && <Txt text={`Dry run and Capture use the location ${location.name}${location.flags ? ` (${location.flags})` : ''}. `} />}
        {location?.chosen && <Txt text={`Shoot (the Run screen) uses the file's own location${location.fileDefault ? `, ${location.fileDefault}` : ''}. `} />}
        {'A dry run skips the hooks and takes a screenshot per step; a capture runs them and films the video. The '}
        <a href={hrefTo({ name: 'run', slug, scenario: name })} data-testid="run-screen-link">
          Run screen
        </a>
        {' shows the sessions first and follows a run live.'}
      </p>
      {/* Until the run it queued has ended: then its outcome (and the picker, the pictures) say the rest. */}
      {last && 'run_id' in last && !ended && (
        <p className="sb-line" role="status" data-testid="run-submitted">
          <Txt text={`${last.mode === 'dry' ? 'Dry run' : 'Capture'} ${last.run_id} queued: its progress shows above, its pictures here when it ends.`} />
          <LinkButton size="sm" variant="ghost" to={{ name: 'run', slug, scenario: name, run: last.run_id }} testId="watch-submitted">
            Watch it live
          </LinkButton>
        </p>
      )}
      {last && 'run_id' in last && ended && <SubmittedOutcome choice={ended} mode={last.mode} slug={slug} isSource={v.source?.run === ended.id} />}
      {last && 'error' in last && (
        <Callout state="fail" role="alert" title={`Blocked: the ${MODE(last.mode)} was not started`}>
          <p className="sb-pre" data-testid="run-refused">
            <Txt text={last.error} />
          </p>
          <TerminalCommands {...(last.fix ? { fix: last.fix } : {})} {...(refusedFixNode ? { fixNode: refusedFixNode } : {})} />
        </Callout>
      )}
      <Pictures v={v} pick={pick} onPick={onPick} />
      {confirm && <ConfirmSessions sessions={confirm} onClose={() => setConfirm(null)} onConfirm={() => start('capture', confirm.map((c) => c.persona))} />}
    </section>
  );
}
