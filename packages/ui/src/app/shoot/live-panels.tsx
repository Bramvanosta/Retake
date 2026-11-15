/** The live screen's panels (ShootLive.tsx): a hook's row, the log, and the outcome once the run ended. */
import { useEffect, useRef, useState } from 'react';
import { Txt, plural, shown } from '../bits.js';
import { LOG_KEEP, stepCounts } from './run-live.js';
import type { HookRow, LogLine, RunLiveState } from './run-live.js';
import { runErrorWords, stepWords } from '../words/scenario-words.js';
import { runShellCommand } from '../shell/command-bus.js';
import { Button, Callout, Disclosure, InspectorSection, LinkButton, Select, Shape, Switch } from '../ui-kit/index.js';
import { HOOK_WORDS, PHASE_WORDS, clock, endedWords, stepRows } from './live-state.js';

const LEVEL_WORDS: Record<string, string> = { debug: 'debug', info: 'info', warn: 'warning', error: 'error' };

export function HookItem({ h }: { h: HookRow }) {
  const [word, mark] = HOOK_WORDS[h.status] ?? ['unknown', 'idle'];
  if (h.marker) {
    return (
      <li className="sp-row" data-testid="run-hook-phase" data-phase={h.phase}>
        <span className="sp-row-mark" data-state="running">
          <Shape state="running" />
        </span>
        <span className="sp-row-text">
          <Txt text={`${PHASE_WORDS[h.phase] ?? h.phase}s${h.message ? ` — ${h.message}` : ''}`} />
        </span>
        <span className="sp-row-state">running</span>
      </li>
    );
  }
  return (
    <li className="sp-row" data-testid="run-hook" data-phase={h.phase} data-status={h.status}>
      <span className="sp-row-mark" data-state={mark}>
        <Shape state={mark} />
      </span>
      <span className="sp-row-text">
        <Txt text={`${PHASE_WORDS[h.phase] ?? h.phase} ${h.name}`} />
      </span>
      <span className="sp-row-state">{shown(word)}</span>
      {h.message && (
        <div className="sb-from-page sp-row-more">
          <p className="sb-from-page-title">Its message</p>
          <p className="sb-pre">
            <Txt text={h.message} />
          </p>
        </div>
      )}
    </li>
  );
}

export function LogPanel({ log, dropped, truncated }: { log: LogLine[]; dropped: number; truncated: boolean }) {
  const [filter, setFilter] = useState<'all' | 'warn'>('all');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLOListElement>(null);
  const lines = filter === 'all' ? log : log.filter((l) => l.level === 'warn' || l.level === 'error');
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line shown is the trigger to follow the log's end
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [follow, lines.length]);
  return (
    <InspectorSection title="Log" testId="log-section">
      <div className="sp-log-tools">
        <Select
          layout="inline"
          label="Show"
          value={filter}
          options={[
            { value: 'all', label: 'every line' },
            { value: 'warn', label: 'warnings and errors' },
          ]}
          onChange={(v) => setFilter(v as 'all' | 'warn')}
        />
        <Switch label="Follow" checked={follow} onChange={setFollow} testId="log-follow" />
      </div>
      {(dropped > 0 || truncated) && (
        <p className="sc-quiet">
          {truncated ? 'A long log: read from its end. ' : ''}
          {shown(dropped > 0 ? `${plural(dropped, 'earlier line')} not shown (the screen keeps the last ${LOG_KEEP}).` : '')}
        </p>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls on its own: its tab stop lets a keyboard scroll it */}
      <ol className="sp-log" ref={box} data-testid="run-log" tabIndex={0} aria-label="Log lines">
        {lines.map((l) => (
          <li key={l.key} data-level={l.level} data-testid="log-line" className="sp-log-line">
            {l.ts && (
              <time className="sc-quiet k-mono" dateTime={l.ts}>
                {shown(clock(l.ts, true))}
              </time>
            )}
            <span className="sp-log-level" data-level={l.level}>
              {shown(LEVEL_WORDS[l.level] ?? 'info')}
            </span>
            {l.from !== 'run' && <span className="sc-quiet">{l.from === 'worker' ? 'worker:' : 'Studio:'}</span>}
            <Txt className="sp-log-text" text={l.text} />
          </li>
        ))}
        {lines.length === 0 && <li className="sc-quiet">No line yet.</li>}
      </ol>
    </InspectorSection>
  );
}

export function Outcome({ slug, name, runId, s, mode, pauseLate }: { slug: string; name: string; runId: string; s: RunLiveState; mode: string | undefined; pauseLate: boolean }) {
  const e = s.end;
  const status = e?.status ?? s.ended?.status ?? s.ended?.job_state ?? 'ended';
  const setup = s.hooks.filter((h) => h.phase === 'setup' && !h.marker);
  const teardown = s.hooks.filter((h) => h.phase === 'teardown' && !h.marker);
  const rollbacks = s.hooks.filter((h) => h.phase === 'rollback' && !h.marker);
  const noHook = (st: string | undefined) => st === undefined || st === 'none' || st === 'skipped';
  const hookLine = (list: HookRow[]) => list.map((h) => `${h.name} ${HOOK_WORDS[h.status]?.[0] ?? h.status}`).join(', ');
  const ok = status === 'succeeded';
  const where = e?.error ? [e.error.scene !== undefined && e.error.step !== undefined ? stepWords(e.error.scene, e.error.step) : e.error.scene, e.error.action].filter(Boolean).join(' · ') : '';
  const fromStep = e?.error?.step !== undefined;
  const counts = stepCounts(s, stepRows(s), true);
  return (
    <Callout state={ok ? 'ok' : status === 'cancelled' ? 'warn' : 'fail'} role="note" title={endedWords(status)}>
      <div className="sp-outcome" data-testid="run-outcome" data-status={status}>
        {e && (
          <p>
            <Txt
              text={`${s.outline ? counts.done : (e.steps_done ?? 0)}/${plural(e.steps_total, 'step')} done${s.outline && counts.skipped > 0 ? ` (${counts.skipped} skipped)` : ''}${e.stopped_at ? ` · stopped before ${stepWords(e.stopped_at.scene, e.stopped_at.step)} (${e.stopped_at.reason === 'until' ? 'until' : 'an irreversible step'})` : ''}${e.warnings > 0 ? ` · ${plural(e.warnings, 'warning')}` : ''}${e.optional_failures ? ` · ${plural(e.optional_failures, 'optional step')} failed` : ''}`}
            />
          </p>
        )}
        {e?.hooks && noHook(e.hooks.setup) && noHook(e.hooks.teardown) && rollbacks.length === 0 && (
          <p data-testid="outcome-hooks">{mode === 'dry' ? 'No hook ran (a rehearsal skips them).' : 'No hook ran.'}</p>
        )}
        {e?.hooks && !(noHook(e.hooks.setup) && noHook(e.hooks.teardown) && rollbacks.length === 0) && (
          <p data-testid="outcome-hooks">
            <Txt
              text={`Setup: ${e.hooks.setup}${setup.length > 0 ? ` (${hookLine(setup)})` : ''} · Teardown: ${e.hooks.teardown}${teardown.length > 0 ? ` (${hookLine(teardown)})` : ''}${rollbacks.length > 0 ? ` · Rollbacks: ${hookLine(rollbacks)}` : ''}`}
            />
          </p>
        )}
        {status === 'cancelled' && (
          <p data-testid="outcome-stopped">
            <Txt
              text={`Stopped from the Studio or by Claude. ${teardown.length > 0 ? `Its teardown ran: ${hookLine(teardown)}.` : e?.hooks?.teardown === 'skipped' || e?.hooks?.teardown === 'none' ? 'It had no teardown to run.' : ''} ${rollbacks.length > 0 ? `Rollbacks: ${hookLine(rollbacks)}.` : 'No rollback was pending.'}`}
            />
          </p>
        )}
        {pauseLate && <p data-testid="outcome-pause-late">The pause came too late: the run ended before its next step.</p>}
        {e?.untrusted?.error && status !== 'cancelled' && fromStep && (
          <div className="sb-from-page" data-testid="outcome-error" data-from="step">
            <p className="sb-from-page-title">
              <Txt text={`Its error${where ? ` (${where})` : ''} — it may quote the page (text the site controls)`} />
            </p>
            <p className="sb-pre">
              <Txt text={runErrorWords(e.untrusted.error)} />
            </p>
          </div>
        )}
        {e?.untrusted?.error && status !== 'cancelled' && !fromStep && (
          <div data-testid="outcome-error" data-from="run">
            <p>
              <Txt text={`Its error${where ? ` (${where})` : ''}:`} />
            </p>
            <p className="sb-pre">
              <Txt text={runErrorWords(e.untrusted.error)} />
            </p>
          </div>
        )}
        {e?.untrusted?.warnings && e.untrusted.warnings.length > 0 && (
          <Disclosure summary="Warnings">
            <ul>
              {e.untrusted.warnings.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the run's final warnings, fixed once it ended, text only: the index is the identity
                <li key={i}>
                  <Txt text={w} />
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        <div className="pr-actions">
          {ok && mode === 'capture' && (
            <LinkButton size="sm" variant="primary" to={{ name: 'timeline', slug, scenario: name, run: runId }} testId="outcome-timeline">
              Open in Edit
            </LinkButton>
          )}
          {ok && mode === 'dry' && (
            <Button size="sm" variant="record" data-testid="outcome-capture" onClick={() => runShellCommand('capture')}>
              Start capture
            </Button>
          )}
          {!ok && (
            <Button size="sm" data-testid="outcome-rehearse" onClick={() => runShellCommand('rehearse')}>
              Rehearse again
            </Button>
          )}
          <LinkButton size="sm" variant="ghost" to={{ name: 'scenario', slug, scenario: name, tab: 'blocks' }} testId="outcome-board">
            Back to the board
          </LinkButton>
        </div>
      </div>
    </Callout>
  );
}
