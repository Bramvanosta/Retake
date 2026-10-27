/**
 * Render, the render queue and the review in the Studio (L4.5 part E, R-UI-26; DESIGN §4g "Render, queue, review"): on
 * the timeline screen (the header's Render bar, the Renders card under the tracks) and on the scenario screen (one
 * Renders card).
 *
 * - Render (`scenario_render`): the capture shown and the file's `hash` as shown — the theme and every option come from
 *   the files, the review runs after the render in the same job. A file changed since the screen read it is a 409 (the
 *   screen reads it again and says so); a render of the scenario already queued or running is a 409 naming it, and the
 *   button is off while one is (one click, one render).
 * - The queue (`scenario_renders`): each unfinished render — queued with what runs before it, running with its phase,
 *   percentage and time left, then reviewing — with Cancel (`render_cancel`: a cancel during the review keeps the
 *   render); the newest render that failed or was cancelled, its message as untrusted text; the renders written, newest
 *   first, each with its review's verdict (clean / warnings / errors / reviewing / failed) and whether it shows the
 *   version on screen.
 * - The review (`render_review`, `review_image`): verdict, counts, the findings (messages as untrusted text; "Show in the
 *   preview" seeks the timeline only when the render is of the version shown), and the contact sheets as checked
 *   data: JPEGs (Thumb.tsx's one `<img>`, under SHEET_DATA_MAX), loaded one after another, larger on click.
 * - Events (render-words rendersEventAction): the list reads again for a job it shows, a job this tab never saw, the
 *   project's renders/ folder, or a reconnection — at most once a second; nothing else.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ScenarioRenderView, ScenarioRendersView } from '@demo-studio/engine';
import type { RenderReviewAnswer, ScenarioRenderAnswer } from '../server/ops.js';
import { CallError, call, errorText, useCall } from './api.js';
import type { Loaded } from './api.js';
import { Badge, Notice, Txt, When, plural } from './bits.js';
import { useEvents } from './events.js';
import { SessionEnded } from './session.js';
import { Jpeg } from './Thumb.js';
import { SHEET_DATA_MAX } from './thumbs.js';
import {
  findingAt,
  findingFrame,
  hasReport,
  jobVersionNote,
  jobWords,
  rendersEventAction,
  reviewBadge,
  shownJobsOf,
  sizeWords,
  versionNote,
  versionWords,
} from './render-words.js';
import type { ShownVersion } from './render-words.js';

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
  const [loaded, reload] = useCall<ScenarioRendersView>('scenario_renders', { project: slug, name }, `${slug}\0${name}`);
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
      call<ScenarioRenderAnswer>('scenario_render', { project: slug, name, run: t.run, expect_edit_sha256: t.hash })
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
      call('render_cancel', { project: slug, job })
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
  return { loaded, reload, sending, outcome, mine, cancelling, render, cancel };
}

/** The Render button, the newest job's line and the outcome of the last click (the timeline header; the scenario card). */
export function RenderBar({ r, target, shown }: { r: RendersState; target: RenderTarget; shown: ShownVersion }) {
  const why = useId();
  const v = r.loaded.state === 'ready' ? r.loaded.data : null;
  const busy = v?.jobs[0];
  const latest = v?.renders[0];
  const off = 'why' in target ? target.why : busy ? `${versionWords(busy.render_id)} is ${busy.state === 'queued' ? 'queued' : 'rendering'}: one render of a scenario at a time` : null;
  const label = r.sending ? 'Starting the render…' : 'why' in target || !target.asCaptured ? 'Render' : 'Render the take as captured';
  return (
    <div className="render-bar" data-testid="render-bar">
      <p className="run-action">
        <button
          type="button"
          className={off ? 'button' : 'button primary'}
          data-testid="render"
          disabled={off !== null || r.sending}
          aria-describedby={why}
          onClick={() => {
            if (!('why' in target)) r.render(target);
          }}
        >
          {label}
        </button>{' '}
        <span id={why} className="small" role="status" aria-live="polite" data-testid="render-status">
          {busy ? (
            <>
              <Txt text={jobWords(busy)} />
              {busy.fraction !== undefined && busy.state === 'running' && !busy.reviewing && <progress max={1} value={busy.fraction} aria-label={`${versionWords(busy.render_id)} rendered`} />}
            </>
          ) : off ? (
            <span className="muted">
              <Txt text={off} />
            </span>
          ) : v?.last_failed ? (
            // The newest render ended without a video (review B): said here, not an older render's "Latest".
            <span data-testid="render-bar-failed">
              <Badge tone={v.last_failed.state === 'cancelled' ? 'warning' : 'danger'}>
                {versionWords(v.last_failed.render_id)} {failedWords(v.last_failed.state)}
              </Badge>{' '}
              why: under Renders
              {latest ? <span className="muted"> · latest video {versionWords(latest.render_id)}</span> : null}
            </span>
          ) : latest ? (
            <>
              Latest: {versionWords(latest.render_id)} · <Badge tone={reviewBadge(latest.review).tone}>{reviewBadge(latest.review).words}</Badge> · {versionNote(latest, shown).words}
            </>
          ) : (
            <span className="muted">renders this capture with the theme of the files, then reviews it</span>
          )}
        </span>
      </p>
      {r.outcome?.kind === 'refused' && (
        <Notice tone={r.outcome.changed ? 'warning' : 'danger'} role="alert" title="The render was not started">
          <p className="pre-line" data-testid="render-refused">
            <Txt text={r.outcome.message} />
          </p>
          {r.outcome.fix && (
            <p className="small">
              In a terminal: <Txt className="mono" text={r.outcome.fix} />
            </p>
          )}
        </Notice>
      )}
      {r.outcome?.kind === 'cancel_failed' && (
        <Notice tone="danger" role="alert" title="The render was not cancelled">
          <p className="pre-line">
            <Txt text={r.outcome.message} />
          </p>
        </Notice>
      )}
    </div>
  );
}

const RENDERS_SHOWN = 5;

/** "failed", "was cancelled", "was interrupted". */
function failedWords(state: 'failed' | 'cancelled' | 'interrupted'): string {
  return state === 'cancelled' ? 'was cancelled' : state === 'interrupted' ? 'was interrupted' : 'failed';
}

/** The queue, the newest failure, the renders and the review of one (the card). */
export function RendersPanel({ r, slug, shown, onSeek, fps }: { r: RendersState; slug: string; shown: ShownVersion; onSeek?: (frame: number) => void; fps?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const opened = useRef(new Set<string>());
  const v = r.loaded.state === 'ready' ? r.loaded.data : null;
  // A render this tab queued: its review opens by itself once written (once).
  useEffect(() => {
    if (!v) return;
    const done = v.renders.find((x) => r.mine.has(x.render_id) && !opened.current.has(x.render_id) && hasReport(x.review));
    if (done) {
      opened.current.add(done.render_id);
      setOpen(done.render_id);
    }
  }, [v, r.mine]);
  if (r.loaded.state === 'loading') {
    return (
      <p className="muted" role="status">
        Loading the renders…
      </p>
    );
  }
  if (r.loaded.state === 'error') {
    return (
      <Notice tone="danger" role="alert" title="The renders cannot be read">
        <p className="pre-line">
          <Txt text={r.loaded.error} />
        </p>
      </Notice>
    );
  }
  const d = r.loaded.data;
  const list = all ? d.renders : d.renders.slice(0, RENDERS_SHOWN);
  const openRender = open ? d.renders.find((x) => x.render_id === open) : undefined;
  return (
    <div className="renders" data-testid="renders">
      {d.jobs.length > 0 && (
        <ul className="render-jobs" aria-label="Renders queued or running">
          {d.jobs.map((j) => (
            <li key={j.id} className="render-job" data-testid="render-job" data-state={j.reviewing ? 'reviewing' : j.state} data-id={j.render_id}>
              <span>
                <Txt text={jobWords(j)} /> <span className="muted small">· renders {jobVersionNote(j, shown)}</span>
              </span>
              {j.state === 'running' && !j.reviewing && <progress max={1} value={j.fraction ?? 0} aria-label={`${versionWords(j.render_id)} rendered`} data-testid="render-progress" />}
              <button type="button" className="button small" data-testid="render-cancel" disabled={j.cancel_requested || r.cancelling.has(j.id)} onClick={() => r.cancel(j.id)}>
                {j.cancel_requested || r.cancelling.has(j.id) ? 'Stopping…' : j.reviewing ? 'Stop the review' : 'Cancel'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {d.last_failed && (
        <Notice tone={d.last_failed.state === 'cancelled' ? 'warning' : 'danger'} role="note" title={`${versionWords(d.last_failed.render_id)} ${d.last_failed.state === 'cancelled' ? 'was cancelled' : d.last_failed.state === 'interrupted' ? 'was interrupted' : 'failed'}`}>
          <div data-testid="render-failed">
            {d.untrusted.error && (
              <p className="pre-line">
                <Txt text={d.untrusted.error} />
              </p>
            )}
            <p className="small muted">Nothing was written under its name: the next render takes it.</p>
          </div>
        </Notice>
      )}
      {d.renders.length === 0 ? (
        <p className="muted small" data-testid="no-renders">
          No render of this scenario yet.
        </p>
      ) : (
        <ul className="render-list" aria-label="Renders, newest first">
          {list.map((x) => (
            <RenderRow key={x.render_id} x={x} shown={shown} open={open === x.render_id} onToggle={() => setOpen(open === x.render_id ? null : x.render_id)} />
          ))}
        </ul>
      )}
      {d.renders.length > RENDERS_SHOWN && (
        <button type="button" className="button quiet small" onClick={() => setAll(!all)}>
          {all ? 'Show the newest only' : `Show all ${d.renders.length} renders`}
        </button>
      )}
      {openRender && (
        <ReviewPanel
          key={`${openRender.render_id}\0${openRender.review.state}`}
          slug={slug}
          x={openRender}
          same={versionNote(openRender, shown).same}
          {...(onSeek ? { onSeek } : {})}
          fps={fps ?? 30}
        />
      )}
    </div>
  );
}

function RenderRow({ x, shown, open, onToggle }: { x: ScenarioRenderView; shown: ShownVersion; open: boolean; onToggle: () => void }) {
  const b = reviewBadge(x.review);
  const note = versionNote(x, shown);
  const canOpen = hasReport(x.review) || x.review.state === 'failed';
  return (
    <li className={`render-row${open ? ' is-open' : ''}`} data-testid="render-row" data-id={x.render_id} data-review={x.review.state}>
      <span className="render-id mono">{versionWords(x.render_id)}</span>
      <span className="small">
        {x.status === 'succeeded' ? (
          <>
            <When iso={x.created_at} /> · {x.duration_s.toFixed(1)} s · {x.width}×{x.height} · {sizeWords(x.size_bytes)} · theme <Txt text={x.theme} />
          </>
        ) : (
          <Badge tone="danger">{x.status}</Badge>
        )}
      </span>
      <Badge tone={note.same ? 'success' : 'neutral'}>{note.words}</Badge>
      <Badge tone={b.tone}>{b.words}</Badge>
      {canOpen && (
        <button type="button" className="button quiet small" aria-expanded={open} data-testid="render-open-review" onClick={onToggle}>
          {open ? 'Hide the review' : 'Show the review'}
        </button>
      )}
    </li>
  );
}

/** A render's review: verdict, findings, contact sheets. */
function ReviewPanel({ slug, x, same, onSeek, fps }: { slug: string; x: ScenarioRenderView; same: boolean; onSeek?: (frame: number) => void; fps: number }) {
  const [loaded] = useCall<RenderReviewAnswer>('render_review', { project: slug, render_id: x.render_id }, `${slug}\0${x.render_id}\0${x.review.state}`);
  const [next, setNext] = useState(1);
  const v = versionWords(x.render_id);
  const head = useId();
  return (
    <section className="review-panel" aria-labelledby={head} data-testid="review-panel" data-id={x.render_id}>
      <h3 id={head} className="card-title">
        Review of {v}
      </h3>
      {loaded.state === 'loading' && (
        <p className="muted" role="status">
          Loading the review…
        </p>
      )}
      {loaded.state === 'error' && (
        <Notice tone="danger" role="alert" title="This review cannot be read">
          <p className="pre-line">
            <Txt text={loaded.error} />
          </p>
        </Notice>
      )}
      {loaded.state === 'ready' && <ReviewBody a={loaded.data} x={x} same={same} fps={fps} slug={slug} next={next} setNext={setNext} {...(onSeek ? { onSeek } : {})} />}
    </section>
  );
}

function ReviewBody({ a, x, same, onSeek, fps, slug, next, setNext }: { a: RenderReviewAnswer; x: ScenarioRenderView; same: boolean; onSeek?: (frame: number) => void; fps: number; slug: string; next: number; setNext: (f: (n: number) => number) => void }) {
  const b = reviewBadge(x.review);
  const findings = a.findings ?? [];
  return (
    <>
      <p data-testid="review-verdict">
        <Badge tone={b.tone}>{b.words}</Badge>{' '}
        {a.counts ? (
          <>
            {plural(a.counts.error, 'error')}, {plural(a.counts.warning, 'warning')}, {plural(a.counts.info, 'note')}
            {a.fps ? ` · contact sheets at ${a.fps} fps` : ''}
            {a.created_at && (
              <>
                {' '}
                · reviewed <When iso={a.created_at} />
              </>
            )}
          </>
        ) : (
          <span className="muted">no report yet ({a.status})</span>
        )}
      </p>
      {a.untrusted.error && (
        <p className="pre-line small" data-testid="review-error">
          <Txt text={a.untrusted.error} />
        </p>
      )}
      {findings.length > 0 && (
        <>
          {!same && onSeek && <p className="muted small">Made from another version of the edit: its findings are not shown on this preview.</p>}
          <ol className="review-findings" data-testid="review-findings">
            {findings.map((f, i) => {
              const frame = findingFrame(f.at, fps);
              return (
                <li key={i} data-testid="review-finding" data-severity={f.severity}>
                  <Badge tone={f.severity === 'error' ? 'danger' : f.severity === 'warning' ? 'warning' : 'neutral'}>{f.severity}</Badge> <code className="mono">{f.code}</code>{' '}
                  <span className="muted small">{findingAt(f.at, fps)}</span>
                  {a.untrusted.messages?.[i] && (
                    <>
                      {' '}
                      — <Txt text={a.untrusted.messages[i]} />
                    </>
                  )}
                  {same && onSeek && frame !== undefined && (
                    <>
                      {' '}
                      <button type="button" className="button quiet small" data-testid="finding-seek" onClick={() => onSeek(frame)}>
                        Show in the preview
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {a.images.length > 0 ? (
        <div className="review-sheets">
          {a.images.map((img, i) => (
            <SheetImage key={img.image} slug={slug} renderId={x.render_id} image={img.image} label={img.label} go={i < next} onDone={() => setNext((n) => Math.max(n, i + 2))} />
          ))}
        </div>
      ) : (
        a.counts && <p className="muted small">This review kept no contact sheet.</p>
      )}
    </>
  );
}

interface SheetAnswer {
  base64: string;
  width: number;
  height: number;
}

/** One contact sheet: asked when its turn comes (one at a time), shown as a checked data: JPEG; larger on click. */
function SheetImage({ slug, renderId, image, label, go, onDone }: { slug: string; renderId: string; image: string; label: string; go: boolean; onDone: () => void }) {
  const [state, setState] = useState<{ s: 'waiting' } | { s: 'ok'; a: SheetAnswer } | { s: 'error'; message: string }>({ s: 'waiting' });
  const [large, setLarge] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!go) return;
    const ac = new AbortController();
    call<SheetAnswer>('review_image', { project: slug, render_id: renderId, image }, { signal: ac.signal }).then(
      (a) => {
        setState({ s: 'ok', a });
        done.current();
      },
      (e: unknown) => {
        if (ac.signal.aborted || e instanceof SessionEnded) return;
        setState({ s: 'error', message: errorText(e) });
        done.current();
      },
    );
    return () => ac.abort();
  }, [go, slug, renderId, image]);
  return (
    <figure className={`review-sheet${large ? ' is-large' : ''}`} data-testid="review-sheet" data-state={state.s}>
      {state.s === 'ok' ? (
        <button type="button" className="sheet-button" aria-pressed={large} aria-label={`${label}: ${large ? 'smaller' : 'larger'}`} onClick={() => setLarge(!large)}>
          <Jpeg base64={state.a.base64} max={SHEET_DATA_MAX} width={state.a.width} height={state.a.height} alt={`${label} of ${versionWords(renderId)}`} />
        </button>
      ) : (
        <p className="muted small sheet-words">{state.s === 'error' ? <Txt text={state.message} /> : 'Loading the contact sheet…'}</p>
      )}
      <figcaption className="small">
        <Txt text={label} />
      </figcaption>
    </figure>
  );
}
