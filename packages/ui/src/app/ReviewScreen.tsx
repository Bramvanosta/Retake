/**
 * L5.12a « Épure » 4a: the Review report (`#/p/<slug>/s/<name>/review[/<render id>]`, R4-Review; R-UI-46) — Review's
 * first view (the mode opens the one this tab used last: shell/modes.ts), a scenario's newest render or the one the
 * address names, read from the render list and the review the render wrote (`scenario_renders`, `render_review`,
 * `review_image`, `render_frame`; nothing new is read). The browser pane is hidden (the report takes the width).
 *
 * - Context (title bar): the View — Report · Comments (n open).
 * - Head: the scenario, the render's version, when, size, length and theme; what the review found in words — never
 *   "passed" (a review records what it found, not which checks ran: BL-132); the render picker (newest first).
 * - Contact sheet: the review's own sheets (the whole video, each scene, key frames) as it kept them, asked one at a time
 *   (review_image), each larger on click.
 * - Checks: one listbox of the check families that found something (review-words.ts; each family a group), their
 *   findings as options (severity as a mark and a word, the message as untrusted text, where and when); the arrows,
 *   Home and End move the selection; "Nothing else found." under them.
 * - Inspector "Selected check": the frame the finding points at (render_frame, one request in flight, the newest wins:
 *   FrameRequests), the severity, the message, where / at / check / code, and Show in Edit (Edit on the render's capture;
 *   it seeks to the finding's frame only when the render shows the version it plans — else its step, said:
 *   edit-handoff.ts). "Open the step" is cut (BL-132).
 * - Renders: the queue with Cancel, the newest failure, the renders (newest five, Show all) — a row opens its report.
 * - Export: Export video (MP4) queues the engine's export job through the Studio's own `review_export` (one format, the
 *   project's exports folder, one at a time per render; followed in the activity) and the raw capture for an editing tool
 *   is a command to copy (`retake export-capture …`, built only from ids that pass their rules). Show in Finder: BL-132.
 * - Status bar (ReviewChrome, shared with Review › Comments: review B-M3 of L5.12b): "Rendered · when · vN · n open · n
 *   resolved", Open in Edit, and Render — re-render this scenario: its latest capture with the file on disk (no file is
 *   shown here), through useRenders (the same refusals; one render at a time; a render queued from here opens its report
 *   by itself once reviewed). The screen owns ⌘B at its priority.
 * - An unknown render id (well formed, not in the list) is an honest empty state; nothing is read with it.
 * Every string from the server is a text node (Txt / a kit slot); finding messages and failures are untrusted.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ReviewFindingView, ScenarioRenderView } from '@retake/engine';
import type { RenderReviewAnswer, ReviewExportAnswer } from '../server/ops.js';
import { CallError, call, errorText, useCall } from './api.js';
import { Txt, When } from './bits.js';
import { FrameRequests, newSessionId } from './comment-words.js';
import type { FrameAsk } from './comment-words.js';
import { seekInEdit } from './edit-handoff.js';
import { commentsEventAction, useEvents } from './events.js';
import { useProjectView } from './project-data.js';
import { busyWhy, RenderJobs, RenderOutcome, RendersList, TONE_MARK, failedWords, useRenders } from './Renders.js';
import type { RenderTarget, RendersState } from './Renders.js';
import { findingFrame, hasReport, reviewBadge, versionNote, versionWords } from './render-words.js';
import { CHECK_FAMILIES, NOTHING_ELSE, agoWords, clockWords, countWords, exportReadsOn, familyOf, groupFindings, rawExportCommand, severityMark, sharedWhen, shortTime, stepKeyOf, whereWords } from './review-words.js';
import { hrefTo } from './route.js';
import { useRunLocation } from './run-location.js';
import { SessionEnded } from './session.js';
import { PRIORITY, useShellCommand } from './shell/command-bus.js';
import { say } from './shell/say.js';
import { BrowserCollapsed, ShellSlot } from './shell/slots.js';
import { useScenarioActions } from './shoot-data.js';
import { Jpeg } from './Thumb.js';
import { SHEET_DATA_MAX } from './thumbs.js';
import { Blocker, Button, Callout, ContactSheet, EmptyState, Facts, InspectorSection, LinkButton, Progress, RowCard, RowList, RowListItem, SegmentedLinks, Select, StatusMark, studioShell } from './ui-kit/index.js';
import type { ContactSheetItem } from './ui-kit/index.js';

/** This tab's render_frame session (its newest request of a render wins on the server). */
const SESSION = newSessionId();
const RENDERS_SHOWN = 5;

interface ThreadCounts {
  scenarios: Record<string, { open: number; resolved: number }>;
}

/** A scenario's thread counts (Review's View and its status line), read again on its comments' events; null while read. */
function useThreadCounts(slug: string, name: string): { open: number; resolved: number } | null {
  const [counts, reload] = useCall<ThreadCounts>('threads_counts', { project: slug, name }, `${slug}\0${name}`);
  useEvents((e) => {
    if (commentsEventAction(e, slug, name).threads) reload();
  });
  return counts.state === 'ready' ? (counts.data.scenarios[name] ?? { open: 0, resolved: 0 }) : null;
}

/** Review's View (the title bar's context, on the report and on the comments): Report · Comments (n open). */
function ReviewViews({ slug, name, current, open }: { slug: string; name: string; current: 'report' | 'comments'; open: number | null }) {
  return (
    <SegmentedLinks
      label="View"
      items={[
        { key: 'report', label: 'Report', to: { name: 'review', slug, scenario: name }, current: current === 'report' },
        // L5.12b: the Comments segment carries the old tab's test id and its count ("Comments (1 open)") on both views.
        { key: 'comments', label: open === null ? 'Comments' : `Comments (${open} open)`, to: { name: 'comments', slug, scenario: name }, current: current === 'comments', testId: 'comments-tab' },
      ]}
    />
  );
}

/** Render from Review: the latest capture with the file on disk, through useRenders (its refusals; one at a time). */
export interface ReviewRender {
  renders: RendersState;
  /** Why Render is off, or null. */
  off: string | null;
  renderNow: () => void;
  /** The capture and file Render would use (for the queue's "shown" words). */
  shown: { run?: string; hash?: string };
}

/**
 * Review's Render (both views: the report and the comments) — the status bar's read of the scenario's actions (one shared
 * entry, no second read); the screen owns ⌘B at its priority.
 */
export function useReviewRender(slug: string, name: string, renders: RendersState): ReviewRender {
  const project = useProjectView(slug);
  const loc = useRunLocation(slug, name, project.state === 'ready' ? project.data.environments : null);
  const actions = useScenarioActions(slug, name, loc.sent);
  const a = actions.state === 'ready' ? actions.data : null;
  const target: RenderTarget = !a ? { why: 'loading the scenario' } : !a.capture ? { why: 'no finished capture yet: a capture films the take a render edits' } : { run: a.capture.id, hash: a.hash };
  const renderNow = () => {
    const off = 'why' in target ? target.why : busyWhy(renders);
    if (off !== null || 'why' in target) return say(`Render of ${name}: ${off ?? 'not ready'}`);
    if (!renders.sending) renders.render(target);
  };
  useShellCommand('render', renderNow, PRIORITY.screen);
  const off = 'why' in target ? target.why : busyWhy(renders);
  return { renders, off, renderNow, shown: { ...(a?.capture ? { run: a.capture.id } : {}), ...(a ? { hash: a.hash } : {}) } };
}

/**
 * L5.12b fixes (review B-M3): Review's chrome, one for both views — the View in the title bar and the status bar's line:
 * "Rendered · when · vN · n open · n resolved", Open in Edit, Render (the render shown: the report's, or the one the
 * comments' viewer shows). Shoot's actions never show in Review (the slot is claimed; StatusActions also stands down on
 * Review's routes).
 */
export function ReviewChrome({ slug, name, current, x, rr }: { slug: string; name: string; current: 'report' | 'comments'; x: ScenarioRenderView | undefined; rr: ReviewRender }) {
  const counts = useThreadCounts(slug, name);
  const inApp = useMemo(() => studioShell() !== null, []);
  const d = rr.renders.loaded.state === 'ready' ? rr.renders.loaded.data : null;
  return (
    <>
      <ShellSlot name="context">
        <ReviewViews slug={slug} name={name} current={current} open={counts?.open ?? null} />
      </ShellSlot>
      <ShellSlot name="actions">
        <span className="sh-scenario" data-testid="review-state">
          {x && x.status === 'succeeded' ? (
            // L5.12a fixes (review B-L1): what the render did, with a neutral mark — never a verdict beside the review's.
            <StatusMark
              state="idle"
              word={
                <>
                  {'Rendered · '}
                  <When iso={x.created_at} />
                  <Txt text={` · ${versionWords(x.render_id)}`} />
                </>
              }
            />
          ) : x ? (
            <StatusMark state="fail" word={`${versionWords(x.render_id)} ${x.status}`} />
          ) : (
            <StatusMark state="idle" word={d ? 'Not rendered yet' : 'Loading the renders'} />
          )}
          {counts && (
            <span className="sh-seg" data-drop="when" data-testid="review-counts">
              <Txt text={` · ${counts.open} open · ${counts.resolved} resolved`} />
            </span>
          )}
        </span>
        {x && (
          <LinkButton size="sm" variant="ghost" to={{ name: 'timeline', slug, scenario: name, run: x.run_id }} testId="review-open-edit">
            Open in Edit
          </LinkButton>
        )}
        <span id="rv-render-why" className="k-sr">
          <Txt text={rr.off ? `Render: ${rr.off}` : `Render ${name} again: its latest capture with the file on disk, then a review`} />
        </span>
        <Button size="sm" variant="primary" data-testid="render" disabled={rr.off !== null || rr.renders.sending} aria-describedby="rv-render-why" kbd={inApp ? ['⌘', 'B'] : undefined} onClick={rr.renderNow}>
          {rr.renders.sending ? 'Starting the render…' : d && d.renders.length > 0 ? 'Render again' : 'Render'}
        </Button>
      </ShellSlot>
    </>
  );
}

/** The report's h1 for assistive technology while no render is shown: the name as text (review A-M3). */
function ReviewHeading({ name }: { name: string }) {
  return (
    <h1 className="k-sr">
      <Txt text={name} />
      {' — Review report'}
    </h1>
  );
}

export function ReviewScreen({ slug, name, render }: { slug: string; name: string; render?: string }) {
  const renders = useRenders(slug, name);
  const rr = useReviewRender(slug, name, renders);
  const { renderNow, off, shown } = rr;

  const d = renders.loaded.state === 'ready' ? renders.loaded.data : null;
  // A render queued from this screen opens its report by itself once its review is written (once).
  const opened = useRef(new Set<string>());
  useEffect(() => {
    if (!d) return;
    const done = d.renders.find((x) => renders.mine.has(x.render_id) && !opened.current.has(x.render_id) && hasReport(x.review));
    if (!done) return;
    opened.current.add(done.render_id);
    if (done.render_id !== render) location.hash = hrefTo({ name: 'review', slug, scenario: name, render: done.render_id });
  }, [d, renders.mine, render, slug, name]);

  const newest = d ? (d.renders.find((x) => x.status === 'succeeded') ?? d.renders[0]) : undefined;
  const x = d ? (render !== undefined ? d.renders.find((r) => r.render_id === render) : newest) : undefined;

  return (
    <div className="rv-screen" data-testid="review-report">
      <BrowserCollapsed />
      <ReviewChrome slug={slug} name={name} current="report" x={x} rr={rr} />
      <RenderOutcome r={renders} />
      {renders.loaded.state === 'loading' && (
        <>
          <ReviewHeading name={name} />
          <p className="rv-quiet" role="status">
            Loading the renders…
          </p>
        </>
      )}
      {renders.loaded.state === 'error' && (
        <>
          <ReviewHeading name={name} />
          <Callout state="fail" role="alert" title="The renders cannot be read">
            <p className="rv-pre">
              <Txt text={renders.loaded.error} />
            </p>
          </Callout>
        </>
      )}
      {d && d.renders.length === 0 && (
        <>
          <ReviewHeading name={name} />
          <EmptyState
            title={`No render of ${name} yet`}
            actions={
              <Button size="sm" data-testid="review-render-first" disabled={off !== null} onClick={renderNow}>
                Render
              </Button>
            }
          >
            <p data-testid="review-empty">A render edits the latest capture with the file on disk, then reviews it: its report shows here. Render from here or from the status bar.</p>
          </EmptyState>
          <RenderJobs r={renders} shown={shown} />
        </>
      )}
      {d && d.renders.length > 0 && !x && (
        <>
          <ReviewHeading name={name} />
          <EmptyState
            title="No such render"
            actions={
              <LinkButton size="sm" to={{ name: 'review', slug, scenario: name }}>
                The newest render
              </LinkButton>
            }
          >
            <p data-testid="review-unknown">
              <Txt text={`${name} has no render ${render ?? ''}: it may have been removed, or the address names another scenario's.`} />
            </p>
          </EmptyState>
        </>
      )}
      {d && x && <Report key={`${x.render_id}\0${x.created_at}`} slug={slug} name={name} x={x} renders={d.renders} r={renders} shown={shown} fileHash={shown.hash} />}
    </div>
  );
}

/** The report of one render: its head, sheets, checks (with the inspector), renders and export. */
function Report({ slug, name, x, renders, r, shown, fileHash }: { slug: string; name: string; x: ScenarioRenderView; renders: ScenarioRenderView[]; r: ReturnType<typeof useRenders>; shown: { run?: string; hash?: string }; fileHash: string | undefined }) {
  const [loaded] = useCall<RenderReviewAnswer>('render_review', { project: slug, render_id: x.render_id }, `${slug}\0${x.render_id}\0${x.review.state}`);
  const review = loaded.state === 'ready' ? loaded.data : null;
  const findings = review?.findings ?? [];
  const groups = useMemo(() => groupFindings(findings), [findings]);
  const order = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.index)), [groups]);
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked !== null && order.includes(picked) ? picked : (order[0] ?? null);
  const b = reviewBadge(x.review);
  // Two renders on one date (or one hour) read the same: those show their time of day (review B-L2).
  const clash = useMemo(() => sharedWhen(renders.map((o) => ({ id: o.render_id, at: o.created_at }))), [renders]);
  const sheetsH = useId();
  const checksH = useId();
  const rendersH = useId();
  const exportH = useId();
  const job = r.loaded.state === 'ready' ? r.loaded.data.jobs.find((j) => j.render_id === x.render_id) : undefined;
  return (
    <>
      <header className="rv-head">
        <div className="rv-head-text">
          <h1 className="rv-h1">
            <Txt text={name} />
            <Txt className="rv-h1-version" text={` · ${versionWords(x.render_id)}`} />
          </h1>
          <p className="rv-facts">
            {x.status === 'succeeded' ? (
              <>
                {'rendered '}
                <When iso={x.created_at} />
                <Txt text={` · ${x.width}×${x.height} · ${shortTime(x.duration_s)} · ${x.fps} fps · theme `} />
                <Txt text={x.theme} />
                <Txt text={` · ${versionNote(x, shown).words}`} />
              </>
            ) : (
              <StatusMark state="fail" word={`${versionWords(x.render_id)} ${x.status}: no video`} />
            )}
          </p>
          <p className="rv-verdict" data-testid="review-verdict">
            <StatusMark state={TONE_MARK[b.tone]} word={review?.counts ? countWords(review.counts) : b.words} />
            {review?.fps ? <Txt text={` · contact sheets at ${review.fps} fps`} /> : null}
          </p>
        </div>
        <Select
          layout="inline"
          label="Render"
          testId="review-render-picker"
          value={x.render_id}
          options={renders.map((o) => ({ value: o.render_id, label: `${versionWords(o.render_id)} · ${agoWords(o.created_at)}${clash.has(o.render_id) ? ` ${clockWords(o.created_at)}` : ''}${o.status !== 'succeeded' ? ` · ${o.status}` : ''}` }))}
          onChange={(id) => {
            location.hash = hrefTo({ name: 'review', slug, scenario: name, render: id });
          }}
        />
      </header>

      {loaded.state === 'loading' && (
        <p className="rv-quiet" role="status">
          Loading the review…
        </p>
      )}
      {loaded.state === 'error' && (
        <Callout state="fail" role="alert" title="This review cannot be read">
          <p className="rv-pre">
            <Txt text={loaded.error} />
          </p>
        </Callout>
      )}
      {review && !review.counts && (
        <ReviewPending review={review} reviewing={job?.reviewing ? (job.fraction ?? undefined) : undefined} />
      )}

      {review && review.images.length > 0 && (
        <section className="rv-section" aria-labelledby={sheetsH}>
          <h2 id={sheetsH} className="rv-h2">
            Contact sheet
          </h2>
          <Sheets slug={slug} renderId={x.render_id} images={review.images} labelledBy={sheetsH} />
        </section>
      )}
      {review?.counts && review.images.length === 0 && <p className="rv-quiet">This review kept no contact sheet.</p>}

      {review?.counts && (
        <section className="rv-section" aria-labelledby={checksH}>
          <h2 id={checksH} className="rv-h2">
            Checks
          </h2>
          {groups.length > 0 ? (
            <Checks groups={groups} messages={review.untrusted.messages ?? []} fps={x.fps} labelledBy={checksH} selected={selected} onSelect={setPicked} />
          ) : (
            <p className="rv-quiet" data-testid="review-nothing">
              The review found nothing to change.
            </p>
          )}
          {groups.length > 0 && (
            <p className="rv-quiet" data-testid="review-nothing-else">
              <Txt text={NOTHING_ELSE} />
            </p>
          )}
        </section>
      )}
      {review?.counts && (
        <ShellSlot name="inspector" inline="Selected check">
          <SelectedCheck slug={slug} name={name} x={x} finding={selected !== null ? (findings[selected] ?? null) : null} message={selected !== null ? review.untrusted.messages?.[selected] : undefined} fileHash={fileHash} />
        </ShellSlot>
      )}

      <section className="rv-section" aria-labelledby={rendersH}>
        <h2 id={rendersH} className="rv-h2">
          Renders
        </h2>
        <RenderJobs r={r} shown={shown} />
        <RendersList r={r} slug={slug} name={name} shown={shown} limit={RENDERS_SHOWN} current={x.render_id} />
      </section>

      {x.status === 'succeeded' && (
        <section className="rv-section" aria-labelledby={exportH}>
          <h2 id={exportH} className="rv-h2">
            Export
          </h2>
          <ExportPart slug={slug} x={x} />
        </section>
      )}
    </>
  );
}

/** A review not written yet (queued, running with its progress), failed (its message), or never asked (its job's state). */
function ReviewPending({ review, reviewing }: { review: RenderReviewAnswer; reviewing: number | undefined }) {
  const state = review.status;
  if (state === 'queued' || state === 'running' || reviewing !== undefined) {
    const f = review.job?.progress?.fraction ?? reviewing;
    return (
      <div className="rv-pending" data-testid="review-running">
        <Progress label="Reviewing the render" {...(f !== undefined ? { value: Math.round(f * 100) } : {})} />
      </div>
    );
  }
  if (state === 'failed' || state === 'cancelled' || state === 'interrupted') {
    return (
      <Callout state="fail" role="note" title={state === 'cancelled' ? 'The review was cancelled' : state === 'interrupted' ? 'The review was interrupted' : 'The review failed'} testId="review-failed">
        {review.untrusted.error && (
          <p className="rv-pre">
            <Txt text={review.untrusted.error} />
          </p>
        )}
      </Callout>
    );
  }
  return (
    <Callout state="idle" role="note" title="Note: this render has no review" testId="review-none">
      A render from the Studio reviews itself; one rendered elsewhere is reviewed with retake review.
    </Callout>
  );
}

interface SheetAnswer {
  base64: string;
  width: number;
  height: number;
}
type SheetState = { s: 'waiting' } | { s: 'ok'; a: SheetAnswer } | { s: 'error'; message: string };

/** The review's sheets, asked one at a time (the next once the one before answered), each a figure of the ContactSheet. */
function Sheets({ slug, renderId, images, labelledBy }: { slug: string; renderId: string; images: RenderReviewAnswer['images']; labelledBy: string }) {
  const [states, setStates] = useState<Record<string, SheetState>>({});
  const [next, setNext] = useState(0);
  useEffect(() => {
    if (next >= images.length) return;
    const img = images[next];
    const ac = new AbortController();
    call<SheetAnswer>('review_image', { project: slug, render_id: renderId, image: img.image }, { signal: ac.signal }).then(
      (a) => {
        setStates((s) => ({ ...s, [img.image]: { s: 'ok', a } }));
        setNext((n) => n + 1);
      },
      (e: unknown) => {
        if (ac.signal.aborted || e instanceof SessionEnded) return;
        setStates((s) => ({ ...s, [img.image]: { s: 'error', message: errorText(e) } }));
        setNext((n) => n + 1);
      },
    );
    return () => ac.abort();
  }, [next, images, slug, renderId]);
  const items: ContactSheetItem[] = images.map((img) => {
    const st = states[img.image] ?? { s: 'waiting' };
    return {
      key: img.image,
      name: img.label,
      label: <Txt text={img.label} />,
      state: st.s,
      testId: 'review-sheet',
      picture: st.s === 'ok' ? <Jpeg base64={st.a.base64} max={SHEET_DATA_MAX} width={st.a.width} height={st.a.height} alt={`${img.label} of ${versionWords(renderId)}`} /> : null,
      words: st.s === 'error' ? <Txt text={st.message} /> : 'Loading the contact sheet…',
    };
  });
  return <ContactSheet labelledBy={labelledBy} items={items} testId="review-sheets" />;
}

const optionId = (i: number) => `rv-finding-${i}`;

/** The families that found something, one listbox (each family a group); the selection follows the arrows. */
function Checks({ groups, messages, fps, labelledBy, selected, onSelect }: { groups: ReturnType<typeof groupFindings>; messages: string[]; fps: number; labelledBy: string; selected: number | null; onSelect: (i: number) => void }) {
  const order = groups.flatMap((g) => g.items.map((i) => i.index));
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || order.length === 0) return;
    const at = selected !== null ? order.indexOf(selected) : -1;
    const to = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? Math.min(order.length - 1, at + 1) : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? Math.max(0, at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    onSelect(order[to]);
    listRef.current?.querySelector(`#${optionId(order[to])}`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  };
  return (
    <div ref={listRef}>
      <RowList
        labelledBy={labelledBy}
        className="rv-checks"
        testId="review-findings"
        listbox={{ ...(selected !== null ? { activeId: optionId(selected) } : {}), tabbable: true, onKeyDown, onFocus: () => selected === null && order.length > 0 && onSelect(order[0]) }}
      >
        {groups.map((g) => (
          <RowListItem key={g.family.id} className="rv-family" testId="review-family" data={{ key: g.family.id }}>
            <div role="group" aria-labelledby={`rv-fam-${g.family.id}`} className="rv-family-group">
              <span id={`rv-fam-${g.family.id}`} className="rv-family-name">
                <Txt text={`${g.family.label} · ${g.items.length}`} />
              </span>
              {g.items.map(({ index, finding }) => {
                const sev = severityMark(finding.severity);
                const t = finding.at?.time ?? (finding.at?.frame !== undefined ? finding.at.frame / fps : undefined);
                return (
                  <RowCard
                    key={index}
                    compact
                    option={{ id: optionId(index), active: selected === index }}
                    testId="review-finding"
                    tile={<StatusMark state={sev.state} word={sev.word} />}
                    title={messages[index] ? <Txt text={messages[index]} /> : <Txt className="k-mono" text={finding.code} />}
                    meta={[whereWords(finding.at), t !== undefined ? shortTime(t) : ''].filter(Boolean).join(' · ')}
                    selected={selected === index}
                    onSelect={() => onSelect(index)}
                  />
                );
              })}
            </div>
          </RowListItem>
        ))}
      </RowList>
    </div>
  );
}

interface FrameAnswer {
  frame: number;
  base64: string;
  width: number;
  height: number;
  timecode: string;
}

/** The frame a finding points at (render_frame: one request in flight, the newest wins). */
function FindingFrame({ slug, x, frame }: { slug: string; x: ScenarioRenderView; frame: number }) {
  const [image, setImage] = useState<FrameAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef<FrameRequests<FrameAnswer> | null>(null);
  useEffect(() => {
    const r = new FrameRequests<FrameAnswer>({
      fetch: (ask: FrameAsk, signal) => call<FrameAnswer>('render_frame', { project: slug, render_id: ask.render_id, created_at: ask.created_at, frame: ask.frame, session: SESSION }, { signal }),
      onResult: (res) => {
        if (res.ok) {
          setImage(res.data);
          setError(null);
        } else if (res.error.code !== 'cancelled') setError(res.error.message);
      },
    });
    requests.current = r;
    return () => {
      r.close();
      requests.current = null;
    };
  }, [slug]);
  useEffect(() => {
    requests.current?.want({ render_id: x.render_id, created_at: x.created_at, frame });
  }, [x.render_id, x.created_at, frame]);
  return (
    <div className="rv-frame" data-testid="review-frame" data-frame={image?.frame ?? ''} data-state={error ? 'error' : image && image.frame === frame ? 'ok' : 'waiting'}>
      {image ? (
        <Jpeg base64={image.base64} max={SHEET_DATA_MAX} width={image.width} height={image.height} alt={`Frame ${image.frame.toLocaleString('en')} of ${versionWords(x.render_id)}, at ${image.timecode}`} />
      ) : (
        <p className="rv-quiet">{error ? <Txt text={error} /> : 'Loading the frame…'}</p>
      )}
    </div>
  );
}

/** The inspector: the selected finding — its frame, severity, message, where / at / check / code, Show in Edit. */
function SelectedCheck({ slug, name, x, finding, message, fileHash }: { slug: string; name: string; x: ScenarioRenderView; finding: ReviewFindingView | null; message: string | undefined; fileHash: string | undefined }) {
  if (!finding) {
    return (
      <InspectorSection title="Selected check">
        <p className="rv-quiet" data-testid="review-no-check">
          The review found nothing here to select.
        </p>
      </InspectorSection>
    );
  }
  const sev = severityMark(finding.severity);
  const frame = findingFrame(finding.at, x.fps);
  const step = stepKeyOf(finding.at);
  const family = CHECK_FAMILIES.find((f) => f.id === familyOf(finding.code))?.label ?? 'Other';
  // The file as it is now and the render's edit (a screen without a plan: the same capture, file bytes, landscape) — said
  // only once the file is read and the render differs (L5.12a fixes, review B-M1).
  const differs = fileHash !== undefined && !versionNote(x, { run: x.run_id, hash: fileHash }).same;
  const t = finding.at?.time ?? (frame !== undefined ? frame / x.fps : undefined);
  return (
    <InspectorSection title="Selected check" testId="review-check">
      {x.status === 'succeeded' && frame !== undefined && <FindingFrame slug={slug} x={x} frame={frame} />}
      <p className="rv-check-head">
        <StatusMark state={sev.state} word={sev.word} />
      </p>
      {message !== undefined && (
        <p className="rv-check-message" data-testid="review-check-message">
          <Txt text={message} />
        </p>
      )}
      <Facts
        label="Where the check points"
        rows={[
          ...(finding.at && whereWords(finding.at) ? [{ key: 'where', label: 'Where', value: <Txt text={whereWords(finding.at)} /> }] : []),
          ...(t !== undefined ? [{ key: 'at', label: 'At', value: <Txt className="k-mono" text={`${shortTime(t)}${frame !== undefined ? ` · frame ${frame.toLocaleString('en')}` : ''}`} /> }] : []),
          { key: 'check', label: 'Check', value: family },
          { key: 'code', label: 'Code', value: <Txt className="k-mono" text={finding.code} /> },
        ]}
      />
      <p className="rv-actions">
        <Button
          size="sm"
          data-testid="review-show-in-edit"
          onClick={() => {
            seekInEdit({ slug, scenario: name, render_id: x.render_id, ...(frame !== undefined ? { frame } : {}), ...(step ? { step } : {}) });
            location.hash = hrefTo({ name: 'timeline', slug, scenario: name, run: x.run_id });
          }}
        >
          Show in Edit
        </Button>
      </p>
      {differs && (
        <p className="rv-quiet" data-testid="review-other-version">
          <Txt text={`${versionWords(x.render_id)} was made from another version of the edit: Edit shows the take as the file plans it now${step ? ', at the step this check points at' : ''}.`} />
        </p>
      )}
    </InspectorSection>
  );
}

interface ActivityItem {
  source: 'queue' | 'history';
  at: string;
  kind: string;
  state: string;
  job?: string;
  render?: { id: string };
  progress?: { fraction?: number };
}

type ExportState = { s: 'idle' } | { s: 'sending' } | { s: 'refused'; message: string } | { s: 'job'; job: string; state: string; fraction?: number; at?: string };

/** The newest export of a render in the activity (path-free: ids, kinds, states, times), or null. */
function useExport(slug: string, renderId: string): [ExportState, () => void] {
  const [st, setSt] = useState<ExportState>({ s: 'idle' });
  const mine = useRef<string | null>(null);
  const read = useCallback(() => {
    call<{ items: ActivityItem[] }>('activity_list', { project: slug, limit: 50 }).then(
      (d) => {
        const it = d.items.find((i) => i.kind === 'export' && i.render?.id === renderId && i.job !== undefined && (mine.current === null || i.job === mine.current)) ?? d.items.find((i) => i.kind === 'export' && i.render?.id === renderId && i.job !== undefined);
        if (it?.job) setSt({ s: 'job', job: it.job, state: it.state, ...(it.progress?.fraction !== undefined ? { fraction: it.progress.fraction } : {}), at: it.at });
      },
      () => undefined,
    );
  }, [slug, renderId]);
  useEffect(() => read(), [read]);
  // (review A-L1): a jobs event of another project reads nothing.
  useEvents((e) => {
    if (exportReadsOn(e, slug)) read();
  });
  const start = useCallback(() => {
    setSt({ s: 'sending' });
    call<ReviewExportAnswer>('review_export', { project: slug, render_id: renderId }).then(
      (a) => {
        mine.current = a.job;
        setSt({ s: 'job', job: a.job, state: a.state });
        read();
      },
      (e: unknown) => {
        if (e instanceof SessionEnded) return;
        setSt({ s: 'refused', message: errorText(e) });
        if (e instanceof CallError && e.error.code === 'conflict') read();
      },
    );
  }, [slug, renderId, read]);
  return [st, start];
}

/** Export: the MP4 as a queued job (one at a time per render), the raw capture as a command to copy. */
function ExportPart({ slug, x }: { slug: string; x: ScenarioRenderView }) {
  const [st, start] = useExport(slug, x.render_id);
  const running = st.s === 'sending' || (st.s === 'job' && (st.state === 'queued' || st.state === 'running'));
  const raw = rawExportCommand(slug, x.run_id);
  return (
    <div className="rv-export" data-testid="review-export-part">
      <p className="rv-actions">
        <Button variant="primary" size="sm" icon="export" data-testid="review-export" disabled={running} onClick={start}>
          {st.s === 'sending' ? 'Queueing the export…' : 'Export video (MP4)'}
        </Button>
      </p>
      <p className="rv-quiet" role="status" data-testid="review-export-state">
        {st.s === 'job' && st.state === 'queued' && <Txt text={`Export of ${versionWords(x.render_id)} queued (job ${st.job}): MP4 1080p, into the project's exports folder.`} />}
        {st.s === 'job' && st.state === 'running' && <Txt text={`Exporting ${versionWords(x.render_id)}${st.fraction !== undefined ? ` · ${Math.round(st.fraction * 100)} %` : ''} (job ${st.job}).`} />}
        {st.s === 'job' && st.state === 'succeeded' && (
          <>
            <Txt text={`Exported ${versionWords(x.render_id)} as MP4 `} />
            <When iso={st.at} />
            <Txt text={`: in the project's exports folder, under ${x.render_id}.`} />
          </>
        )}
        {st.s === 'job' && (st.state === 'failed' || st.state === 'cancelled' || st.state === 'interrupted') && <Txt text={`The export ${st.state === 'failed' ? failedWords('failed') : failedWords(st.state as 'cancelled' | 'interrupted')} (job ${st.job}): the Activity has its message.`} />}
      </p>
      {st.s === 'refused' && (
        <Callout state="fail" role="alert" title="The export was not queued">
          <p className="rv-pre" data-testid="review-export-refused">
            <Txt text={st.message} />
          </p>
        </Callout>
      )}
      {raw !== null ? (
        <Blocker fix={{ copy: raw }} testId="review-export-raw">
          The raw capture for an editing tool (an OTIO package: the capture, the cursor track and the timeline) — in a terminal:
        </Blocker>
      ) : (
        <p className="rv-quiet" data-testid="review-export-raw-off">
          The raw capture of this render cannot be named in a command here: export it with retake export-capture in a terminal.
        </p>
      )}
    </div>
  );
}
