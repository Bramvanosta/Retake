/**
 * The Review report (`#/p/<slug>/s/<name>/review[/<render id>]`, R4-Review; R-UI-46) — Review's
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
 * - Status bar (ReviewChrome, shared with Review › Comments): "Rendered · when · vN · n open · n
 *   resolved", Open in Edit, and Render — re-render this scenario: its latest capture with the file on disk (no file is
 *   shown here), through useRenders (the same refusals; one render at a time; a render queued from here opens its report
 *   by itself once reviewed). The screen owns ⌘B at its priority.
 * - An unknown render id (well formed, not in the list) is an honest empty state; nothing is read with it.
 * Every string from the server is a text node (Txt / a kit slot); finding messages and failures are untrusted.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReviewFindingView, ScenarioRenderView } from '@retake/engine';
import { useRenderReview } from '../data/renders.js';
import { Txt } from '../bits.js';
import { seekInEdit } from '../edit/edit-handoff.js';
import { RenderJobs, RenderOutcome, RendersList, useRenders } from './Renders.js';
import { findingFrame, hasReport, versionNote, versionWords } from '../words/render-words.js';
import { CHECK_FAMILIES, familyOf, groupFindings, severityMark, sharedWhen, shortTime, stepKeyOf, whereWords } from './review-words.js';
import { hrefTo } from '../route.js';
import { BrowserCollapsed, ShellSlot } from '../shell/slots.js';
import { Button, Callout, EmptyState, Facts, InspectorSection, LinkButton, StatusMark } from '../ui-kit/index.js';
import { ReviewChrome, useReviewRender } from './review-chrome.js';
import { ChecksSection, FindingFrame } from './report-checks.js';
import { ExportPart } from './report-export.js';
import { ReportHead, ReviewPending, Sheets } from './report-head.js';

export { ReviewChrome, useReviewRender } from './review-chrome.js';
export type { ReviewRender } from './review-chrome.js';

const RENDERS_SHOWN = 5;

/** The report's h1 for assistive technology while no render is shown: the name as text. */
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
function Report({
  slug,
  name,
  x,
  renders,
  r,
  shown,
  fileHash,
}: {
  slug: string;
  name: string;
  x: ScenarioRenderView;
  renders: ScenarioRenderView[];
  r: ReturnType<typeof useRenders>;
  shown: { run?: string; hash?: string };
  fileHash: string | undefined;
}) {
  const [loaded] = useRenderReview({ project: slug, render_id: x.render_id }, `${slug}\0${x.render_id}\0${x.review.state}`);
  const review = loaded.state === 'ready' ? loaded.data : null;
  const findings = review?.findings ?? [];
  const groups = useMemo(() => groupFindings(findings), [findings]);
  const order = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.index)), [groups]);
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked !== null && order.includes(picked) ? picked : (order[0] ?? null);
  // Two renders on one date (or one hour) read the same: those show their time of day.
  const clash = useMemo(() => sharedWhen(renders.map((o) => ({ id: o.render_id, at: o.created_at }))), [renders]);
  const sheetsH = useId();
  const checksH = useId();
  const rendersH = useId();
  const exportH = useId();
  const job = r.loaded.state === 'ready' ? r.loaded.data.jobs.find((j) => j.render_id === x.render_id) : undefined;
  return (
    <>
      <ReportHead slug={slug} name={name} x={x} renders={renders} review={review} shown={shown} clash={clash} />

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
      {review && !review.counts && <ReviewPending review={review} reviewing={job?.reviewing ? (job.fraction ?? undefined) : undefined} />}

      {review && review.images.length > 0 && (
        <section className="rv-section" aria-labelledby={sheetsH}>
          <h2 id={sheetsH} className="rv-h2">
            Contact sheet
          </h2>
          <Sheets slug={slug} renderId={x.render_id} images={review.images} labelledBy={sheetsH} />
        </section>
      )}
      {review?.counts && review.images.length === 0 && <p className="rv-quiet">This review kept no contact sheet.</p>}

      {review?.counts && <ChecksSection groups={groups} messages={review.untrusted.messages ?? []} fps={x.fps} labelledBy={checksH} selected={selected} onSelect={setPicked} />}
      {review?.counts && (
        <ShellSlot name="inspector" inline="Selected check">
          <SelectedCheck
            slug={slug}
            name={name}
            x={x}
            finding={selected !== null ? (findings[selected] ?? null) : null}
            message={selected !== null ? review.untrusted.messages?.[selected] : undefined}
            fileHash={fileHash}
          />
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

/** The inspector: the selected finding — its frame, severity, message, where / at / check / code, Show in Edit. */
function SelectedCheck({
  slug,
  name,
  x,
  finding,
  message,
  fileHash,
}: {
  slug: string;
  name: string;
  x: ScenarioRenderView;
  finding: ReviewFindingView | null;
  message: string | undefined;
  fileHash: string | undefined;
}) {
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
  // only once the file is read and the render differs.
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
