/**
 * Render and the render queue in the Studio (L4.5 part E, R-UI-26; L5.12a: rebuilt on the kit, R-UI-45 / R-UI-46) — the
 * state Edit, the Review report and the scenario screen's renders card share:
 *
 * - `useRenders` — the scenario's render list (`scenario_renders`), read again on the events that concern it (at most once
 *   a second: a job it shows, a job this tab never saw, the project's renders/ folder, a reconnection); Render
 *   (`scenario_render`: the capture shown and the file's `hash` as shown — the theme and every option come from the files,
 *   the review runs after the render in the same job; a file changed since the screen read it is a 409: the screen reads
 *   it again (`onStale`) and says so; a render of the scenario already queued or running is a 409 naming it) and Cancel
 *   (`render_cancel`: a cancel during the review keeps the render). The render ids this tab queued are `mine`: their
 *   review opens by itself once written (the Review report; Edit's status bar says it).
 * - `RenderOutcome` — the last click's refusal as a kit Callout (`render-refused`, its command), or a Cancel that failed.
 * - `RenderJobs` — the queue: each unfinished render (queued with what runs before it, running with its phase,
 *   percentage and time left, then reviewing) with Cancel.
 * - `RendersList` — the newest render that failed or was cancelled (its message as untrusted text), then the renders
 *   written, newest first (a few, then Show all), each a row: its version, when, length, size and theme, whether it shows
 *   the version on screen, its review's verdict as a mark and a word; a row is a link to that render's Review report
 *   (L5.12a fixes: never a toggle; its time of day shows when another row reads the same).
 * Every value from the server is a text node (Txt / a kit slot).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScenarioRenderView, ScenarioRendersView } from '@retake/engine';
import { CallError, errorText } from '../api.js';
import type { Loaded } from '../api.js';
import { renderCancel, scenarioRender, useScenarioRenders } from '../data/renders.js';
import { Txt, When } from '../bits.js';
import { useEvents } from '../events.js';
import { hrefTo } from '../route.js';
import { usePaletteGroup } from '../shell/command-bus.js';
import { SessionEnded } from '../session.js';
import { clockWords, reportHint, sharedWhen } from './review-words.js';
import { jobVersionNote, jobWords, notShownWords, rendersEventAction, reviewBadge, shownJobsOf, sizeWords, versionNote, versionWords } from '../words/render-words.js';
import type { ReviewTone, ShownVersion } from '../words/render-words.js';
import { Button, Callout, Progress, RowCard, RowList, RowListItem, StatusMark } from '../ui-kit/index.js';
import type { MarkState } from '../ui-kit/index.js';

/** What a Render click needs: the capture and the file as shown — or why the button is off. */
export type RenderTarget = { run: string; hash: string; asCaptured?: boolean } | { why: string };

type Outcome = { kind: 'queued'; render_id: string } | { kind: 'refused'; message: string; fix?: string; changed: boolean } | { kind: 'cancel_failed'; message: string };

export interface RendersState {
  loaded: Loaded<ScenarioRendersView>;
  reload: () => void;
  sending: boolean;
  outcome: Outcome | null;
  /** Render ids this tab queued (their review opens by itself when it is written). */
  mine: ReadonlySet<string>;
  cancelling: ReadonlySet<string>;
  render: (target: { run: string; hash: string }) => void;
  cancel: (job: string) => void;
}

/** The scenario's render list, read again on the events that concern it (at most once a second), with Render / Cancel. */
export function useRenders(slug: string, name: string, onStale?: () => void): RendersState {
  const [loaded, reload] = useScenarioRenders({ project: slug, name }, `${slug}\0${name}`);
  const seen = useRef(new Set<string>());
  const shown = useRef<ReadonlySet<string>>(new Set());
  shown.current = loaded.state === 'ready' ? shownJobsOf(loaded.data) : new Set();
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    const wait = 1000 - (Date.now() - last.current);
    if (wait <= 0) {
      last.current = Date.now();
      reload();
    } else if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        reload();
      }, wait);
    }
  }, [reload]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useEvents((e) => {
    if (rendersEventAction(e, slug, shown.current, seen.current)) soon();
  });
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [mine, setMine] = useState<ReadonlySet<string>>(new Set());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const staleRef = useRef(onStale);
  staleRef.current = onStale;
  const render = useCallback(
    (t: { run: string; hash: string }) => {
      setSending(true);
      setOutcome(null);
      scenarioRender({ project: slug, name, run: t.run, expect_edit_sha256: t.hash })
        .then(
          (d) => {
            setOutcome({ kind: 'queued', render_id: d.render_id });
            setMine((m) => new Set([...m, d.render_id]));
          },
          (e: unknown) => {
            if (e instanceof SessionEnded) return;
            const changed = e instanceof CallError && e.error.code === 'conflict' && e.error.details?.render_id === undefined;
            setOutcome({ kind: 'refused', message: errorText(e), ...(e instanceof CallError && e.error.fix ? { fix: e.error.fix } : {}), changed });
            // The file changed since the screen read it: read it again (the button then renders the new version).
            if (changed) staleRef.current?.();
          },
        )
        .finally(() => {
          setSending(false);
          reload();
        });
    },
    [slug, name, reload],
  );
  const cancel = useCallback(
    (job: string) => {
      setCancelling((c) => new Set([...c, job]));
      renderCancel({ project: slug, job })
        .catch((e: unknown) => {
          if (!(e instanceof SessionEnded)) setOutcome({ kind: 'cancel_failed', message: errorText(e) });
        })
        .finally(() => {
          setCancelling((c) => new Set([...c].filter((j) => j !== job)));
          reload();
        });
    },
    [slug, reload],
  );
  // One object while nothing in it changes (review A-L2: a memoised consumer — the thread panel — keeps its props).
  return useMemo(() => ({ loaded, reload, sending, outcome, mine, cancelling, render, cancel }), [loaded, reload, sending, outcome, mine, cancelling, render, cancel]);
}

/** "failed", "was cancelled", "was interrupted". */
export function failedWords(state: 'failed' | 'cancelled' | 'interrupted'): string {
  return state === 'cancelled' ? 'was cancelled' : state === 'interrupted' ? 'was interrupted' : 'failed';
}

/** A review verdict's tone as a mark state (the word beside it says the verdict). */
export const TONE_MARK: Record<ReviewTone, MarkState> = { success: 'ok', warning: 'warn', danger: 'fail', info: 'running', neutral: 'idle' };

/** Why Render is off while a render of the scenario is queued or running, or null. */
export function busyWhy(r: RendersState): string | null {
  const busy = r.loaded.state === 'ready' ? r.loaded.data.jobs[0] : undefined;
  return busy ? `${versionWords(busy.render_id)} is ${busy.state === 'queued' ? 'queued' : 'rendering'}: one render of a scenario at a time` : null;
}

/** The last Render click's refusal (its command), or a Cancel that failed: a kit Callout. */
export function RenderOutcome({ r }: { r: RendersState }) {
  if (r.outcome?.kind === 'refused') {
    return (
      <Callout state={r.outcome.changed ? 'warn' : 'fail'} role="alert" title="The render was not started">
        <p className="ed-pre" data-testid="render-refused">
          <Txt text={r.outcome.message} />
        </p>
        {r.outcome.fix && (
          <p className="ed-quiet">
            {'In a terminal: '}
            <Txt className="k-mono" text={r.outcome.fix} />
          </p>
        )}
      </Callout>
    );
  }
  if (r.outcome?.kind === 'cancel_failed') {
    return (
      <Callout state="fail" role="alert" title="The render was not cancelled">
        <p className="ed-pre">
          <Txt text={r.outcome.message} />
        </p>
      </Callout>
    );
  }
  return null;
}

/** The queue: each unfinished render with its words, its progress and Cancel (Stop the review while it reviews). */
export function RenderJobs({ r, shown }: { r: RendersState; shown: ShownVersion }) {
  const v = r.loaded.state === 'ready' ? r.loaded.data : null;
  if (!v || v.jobs.length === 0) return null;
  return (
    <ul className="ed-jobs" aria-label="Renders queued or running">
      {v.jobs.map((j) => {
        const stopping = j.cancel_requested || r.cancelling.has(j.id);
        return (
          <li key={j.id} className="ed-job" data-testid="render-job" data-state={j.reviewing ? 'reviewing' : j.state} data-id={j.render_id}>
            <span className="ed-job-words">
              <Txt text={jobWords(j)} /> <Txt className="ed-quiet" text={`· renders ${jobVersionNote(j, shown)}`} />
            </span>
            {j.state === 'running' && !j.reviewing && <Progress label={`${versionWords(j.render_id)} rendered`} value={Math.round((j.fraction ?? 0) * 100)} testId="render-progress" />}
            <Button size="sm" data-testid="render-cancel" disabled={stopping} onClick={() => r.cancel(j.id)}>
              {stopping ? 'Stopping…' : j.reviewing ? 'Stop the review' : 'Cancel'}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One render's row: when (its time of day too when another row reads the same), length, size, theme (or its status), the
 * version note and the verdict — a link to its report.
 */
function RenderRow({ x, shown, current, clock, slug, name }: { x: ScenarioRenderView; shown: ShownVersion; current: boolean; clock: boolean; slug: string; name: string }) {
  const b = reviewBadge(x.review);
  const note = versionNote(x, shown);
  return (
    <RowCard
      compact
      tile={<Txt className="k-mono" text={versionWords(x.render_id)} />}
      title={
        x.status === 'succeeded' ? (
          <>
            <When iso={x.created_at} />
            <Txt text={`${clock ? ` ${clockWords(x.created_at)}` : ''} · ${x.duration_s.toFixed(1)} s · ${x.width}×${x.height} · ${sizeWords(x.size_bytes)} · theme `} />
            <Txt text={x.theme} />
          </>
        ) : (
          <StatusMark state="fail" word={x.status} />
        )
      }
      meta={note.words}
      aside={<StatusMark state={TONE_MARK[b.tone]} word={b.words} />}
      selected={current}
      to={{ name: 'review', slug, scenario: name, render: x.render_id }}
    />
  );
}

/**
 * The newest failure, then the renders (the newest `limit`, then Show all): each row opens its Review report. `current`:
 * the render the report shows (its row selected).
 */
export function RendersList({ r, slug, name, shown, limit, current }: { r: RendersState; slug: string; name: string; shown: ShownVersion; limit: number; current?: string }) {
  const [all, setAll] = useState(false);
  if (r.loaded.state === 'loading') {
    return (
      <p className="ed-quiet" role="status">
        Loading the renders…
      </p>
    );
  }
  if (r.loaded.state === 'error') {
    return (
      <Callout state="fail" role="alert" title="The renders cannot be read">
        <p className="ed-pre">
          <Txt text={r.loaded.error} />
        </p>
      </Callout>
    );
  }
  const d = r.loaded.data;
  const list = all ? d.renders : d.renders.slice(0, limit);
  const clash = sharedWhen(d.renders.map((x) => ({ id: x.render_id, at: x.created_at })));
  return (
    <div className="ed-renders" data-testid="renders">
      {d.last_failed && (
        <Callout state={d.last_failed.state === 'cancelled' ? 'warn' : 'fail'} role="note" title={`${versionWords(d.last_failed.render_id)} ${failedWords(d.last_failed.state)}`} testId="render-failed">
          {d.untrusted.error && (
            <p className="ed-pre">
              <Txt text={d.untrusted.error} />
            </p>
          )}
          <p className="ed-quiet">Nothing was written under its name: the next render takes it.</p>
        </Callout>
      )}
      {d.renders.length === 0 ? (
        <p className="ed-quiet" data-testid="no-renders">
          No render of this scenario yet.
        </p>
      ) : (
        <RowList className="ed-render-list" testId="render-list">
          {list.map((x) => (
            <RowListItem key={x.render_id} testId="render-row" data={{ id: x.render_id, review: x.review.state }}>
              <RenderRow x={x} shown={shown} current={current === x.render_id} clock={clash.has(x.render_id)} slug={slug} name={name} />
            </RowListItem>
          ))}
        </RowList>
      )}
      {d.renders.length > limit && (
        <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
          <Txt text={all ? 'Show the newest only' : `Show all ${d.renders.length} renders`} />
        </Button>
      )}
      {notShownWords(d.not_shown).map((line) => (
        <p key={line} className="ed-quiet" data-testid="renders-not-shown">
          <Txt text={line} />
        </p>
      ))}
    </div>
  );
}

/**
 * L5.12b (R4-Palette): the ⌘K palette's "Review report" entry while a screen holds the scenario's renders — the newest
 * render's review in words ("last render v2 · 2 warnings"; never "passed": review-words reportHint), opening its report.
 */
export function useReportEntry(slug: string, name: string, r: RendersState): void {
  const d = r.loaded.state === 'ready' ? r.loaded.data : null;
  const newest = d?.renders.find((x) => x.status === 'succeeded');
  usePaletteGroup('report', d ? [{ id: 'report', label: 'Review report', hint: reportHint(newest, d.renders.length), icon: 'report', run: () => (location.hash = hrefTo({ name: 'review', slug, scenario: name, ...(newest ? { render: newest.render_id } : {}) })) }] : null);
}
