/**
 * The Comments screen of a scenario (L4.6 part D1; R-UI-27, R-UI-29; plan D2–D5, D9, D10 as amended by the critique):
 * `#/p/<slug>/s/<name>/comments[/<thread> | /at/<render>/<frame>]`.
 *
 * - The list (left): the scenario's threads — Open (default) / Resolved / All, and "This render only" — as links, open
 *   first (the engine's order), each with its status, time, render, where it points, the first words of the comment
 *   (untrusted: a text node through Txt), its channel and its newest proposal's state.
 * - The viewer (centre): one render's own frames, made by the server (`render_frame`: exact, any render, any browser —
 *   no video plays in the page), a slider, ◀ / ▶ one frame, Shift one second, a typed time (the CLI's `--at` rule),
 *   the render's markers and the threads made on it as ticks (a pin opens its thread). One random session id per tab;
 *   one frame request in flight, the newest frame wins, a 429 backs off, a 409 `cancelled` is ignored (FrameRequests).
 * - The composer (under the viewer, when no thread is open): a region drawn by dragging on the frame (pointer capture,
 *   Esc cancels, a new drag replaces it; a click makes none) or typed in four % fields (the WCAG 2.5.7 alternative),
 *   rounded then clamped inside the frame (critique B11); the anchor chips the server computes with the code that
 *   stores them (`frame_anchor`, 150 ms after the frame or region settles); the text; Post (`thread_add` with the
 *   render's id and created_at as shown — the still is made after the thread: "Posting…").
 * - The thread (right): the comment, where it points, its entries (channel words, author and text as untrusted text
 *   nodes), Reply, Resolve (a note, optionally the newer render that answers it) and Reopen — each write on the
 *   thread's hash the screen showed (`if_match`); a 409 reads the thread again and says so, nothing is re-sent. A
 *   proposal entry shows its summary; the thread's newest proposal shows as its diff with the buttons the server offers
 *   (part D2, ProposalPanel.tsx: Apply, Preview change, Apply and re-render, Undo apply, Resolve with vN).
 * - Events (commentsEventAction): the list, the thread and the pins read again when this scenario's comments or file
 *   change or after a reconnection, at most once a second; the renders (useRenders) on the project's renders.
 * The page never names an author or a channel: the Studio writes `studio` under the name it was started with — a
 * channel, not a proof of a person.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { FrameCommentAnchor } from '@demo-studio/core';
import type { ScenarioRenderView } from '@demo-studio/engine';
import type { ThreadAnswer, ThreadGetAnswer, ThreadItem, ThreadsListAnswer } from '../server/comment-ops.js';
import { CallError, call, errorText, useCall } from './api.js';
import { Badge, Notice, Txt, When, plural } from './bits.js';
import { CommentsTab } from './CommentsTab.js';
import { commentsEventAction, useEvents } from './events.js';
import { useRenders } from './Renders.js';
import type { RendersState } from './Renders.js';
import { ProposalCard } from './ProposalPanel.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';
import { Jpeg } from './Thumb.js';
import { SHEET_DATA_MAX } from './thumbs.js';
import {
  CHANNEL_NOTE,
  COMMENT_TEXT_MAX,
  FrameRequests,
  anchorChips,
  channelWords,
  charactersLeft,
  entryWords,
  fieldsOf,
  frameTime,
  newSessionId,
  parseTimecode,
  pointIn,
  proposalWords,
  regionOfDrag,
  regionOfFields,
  regionWords,
  renderWords,
  sameRegion,
  statusWords,
  timeExample,
  viewerKey,
  whereWords,
} from './comment-words.js';
import type { Chip, FrameAsk, Region, RegionFields } from './comment-words.js';
import type { KeyTarget } from './timeline-words.js';

/** This tab's render_frame session: its newest request of a render wins on the server. */
const SESSION = newSessionId();

type Filter = 'open' | 'resolved' | 'all';
/** The render the viewer shows, as the page read it (a reused id is another render: created_at). */
interface Shown {
  render_id: string;
  created_at: string;
}

interface Outline {
  render_id: string;
  created_at: string;
  variant: string;
  fps: number;
  frames: number;
  width: number;
  height: number;
  duration_s: number;
  timecode: string;
  markers: Array<{ frame: number; done?: number }>;
  pins: Array<{ id: string; status: 'open' | 'resolved'; frame: number }>;
  untrusted: { markers: string[] };
}

interface FrameAnswer {
  frame: number;
  base64: string;
  width: number;
  height: number;
  timecode: string;
}

interface AnchorAnswer {
  frame: number;
  timecode: string;
  anchor: FrameCommentAnchor;
  step_now?: string | null;
  warnings: string[];
}

function keyTarget(t: EventTarget | null): KeyTarget {
  const el = t instanceof Element ? t : null;
  return {
    tag: el?.tagName ?? 'body',
    ...(el instanceof HTMLInputElement ? { type: el.type } : {}),
    ...(el instanceof HTMLElement && el.isContentEditable ? { editable: true } : {}),
    ...(el?.closest('[role="radiogroup"]') ? { inRadioGroup: true } : {}),
  };
}

/** A counter that moves at most once per `ms` (re-reads on events: never more than once a second). */
function useThrottledTick(ms: number): [number, () => void] {
  const [tick, setTick] = useState(0);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const bump = useCallback(() => {
    const wait = ms - (Date.now() - last.current);
    if (wait <= 0) {
      last.current = Date.now();
      setTick((n) => n + 1);
    } else if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        setTick((n) => n + 1);
      }, wait);
    }
  }, [ms]);
  return [tick, bump];
}

function Breadcrumb({ slug, name }: { slug: string; name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <a href={hrefTo({ name: 'projects' })}>Projects</a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'project', slug })}>
        <Txt text={slug} />
      </a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'blocks' })}>
        <Txt text={name} />
      </a>
      <span aria-hidden="true"> / </span>
      <span aria-current="page">Comments</span>
    </nav>
  );
}

export function CommentsScreen({ slug, name, thread, at }: { slug: string; name: string; thread?: string; at?: { render: string; frame: number } }) {
  const renders = useRenders(slug, name);
  const succeeded = useMemo(() => (renders.loaded.state === 'ready' ? renders.loaded.data.renders.filter((r) => r.status === 'succeeded') : []), [renders.loaded]);
  const [filter, setFilter] = useState<Filter>('open');
  const [onlyRender, setOnlyRender] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [frame, setFrame] = useState(0);
  const [region, setRegion] = useState<Region | null>(null);
  const [opened, setOpened] = useState<ThreadAnswer | null>(null);
  const [posted, setPosted] = useState<{ id: string; warnings: string[] } | null>(null);
  const [tick, bump] = useThrottledTick(1000);
  useEvents((e) => {
    const a = commentsEventAction(e, slug, name);
    if (a.threads || a.scenario) bump();
  });

  // Where the viewer starts, once per address: a thread's render and frame, a render's frame, else the newest render.
  const target = thread !== undefined ? `t\0${thread}` : at ? `a\0${at.render}\0${at.frame}` : 'list';
  const placed = useRef<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    if (placed.current === target || renders.loaded.state !== 'ready') return;
    if (thread !== undefined) {
      if (!opened || opened.id !== thread) return;
      placed.current = target;
      if (opened.render_present) {
        setShown({ render_id: opened.render_id, created_at: opened.render_created_at });
        setFrame(opened.frame);
        setMissing(null);
      } else {
        setMissing(`${renderWords(opened.render_id)}, the render this comment was made on, is gone: its still is shown with the thread`);
        if (!shown && succeeded[0]) setShown({ render_id: succeeded[0].render_id, created_at: succeeded[0].created_at });
      }
      return;
    }
    placed.current = target;
    if (at) {
      const r = succeeded.find((x) => x.render_id === at.render);
      if (r) {
        setShown({ render_id: r.render_id, created_at: r.created_at });
        setFrame(at.frame);
        setMissing(null);
      } else setMissing(`There is no finished render ${renderWords(at.render)} of this scenario`);
      return;
    }
    setMissing(null);
    if (!shown && succeeded[0]) setShown({ render_id: succeeded[0].render_id, created_at: succeeded[0].created_at });
  }, [target, thread, at, opened, renders.loaded.state, succeeded, shown]);
  // The render shown was removed (renders/ cleaned): back to the newest.
  useEffect(() => {
    if (shown && renders.loaded.state === 'ready' && !succeeded.some((r) => r.render_id === shown.render_id && r.created_at === shown.created_at)) {
      setShown(succeeded[0] ? { render_id: succeeded[0].render_id, created_at: succeeded[0].created_at } : null);
    }
  }, [shown, succeeded, renders.loaded.state]);
  useEffect(() => {
    if (thread === undefined) setOpened(null);
  }, [thread]);
  // "Comment posted" belongs to the thread just posted: gone once the page shows another place.
  useEffect(() => {
    setPosted((p) => (p && p.id === thread ? p : null));
  }, [thread, at?.render, at?.frame]);
  // A new place for the viewer: no region carried over.
  useEffect(() => setRegion(null), [shown?.render_id, shown?.created_at]);

  const composing = thread === undefined;
  const threadRegion = opened && shown && opened.render_id === shown.render_id && opened.render_created_at === shown.created_at && opened.frame === frame ? (opened.region ?? null) : null;

  return (
    <div className="screen comments-screen" data-testid="comments-screen">
      <Breadcrumb slug={slug} name={name} />
      <header className="screen-head">
        <h1>
          <Txt text={name} /> <span className="muted">· comments</span>
        </h1>
        <p className="muted small">Comment a frame of a render: Claude reads the thread with the exact frame, where it points and your words.</p>
        <nav aria-label="Scenario views" className="tabs">
          <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'blocks' })} className="tab">
            Blocks
          </a>
          <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'yaml' })} className="tab">
            YAML
          </a>
          <a href={hrefTo({ name: 'timeline', slug, scenario: name })} className="tab">
            Timeline
          </a>
          <CommentsTab slug={slug} name={name} current />
        </nav>
      </header>
      {posted && (
        <Notice tone={posted.warnings.length ? 'warning' : 'info'} role="status" title="Comment posted">
          {posted.warnings.map((w, i) => (
            <p key={i} className="pre-line small" data-testid="posted-warning">
              <Txt text={w} />
            </p>
          ))}
        </Notice>
      )}
      <div className={`comments-layout${opened && opened.id === thread && opened.entries.some((e) => e.proposal) ? ' has-proposal' : ''}`}>
        <ThreadList slug={slug} name={name} filter={filter} setFilter={setFilter} onlyRender={onlyRender} setOnlyRender={setOnlyRender} render={shown?.render_id ?? null} current={thread} tick={tick} />
        <section className="card comments-viewer" aria-labelledby="viewer-h">
          <div className="card-head">
            <h2 id="viewer-h" className="card-title">
              {shown ? `Frames of ${renderWords(shown.render_id)}` : 'Frames'}
            </h2>
            <RenderPicker renders={succeeded} shown={shown} onPick={(r) => setShown({ render_id: r.render_id, created_at: r.created_at })} />
          </div>
          {missing && (
            <Notice tone="info" role="note">
              <p data-testid="viewer-missing">
                <Txt text={missing} />.
              </p>
            </Notice>
          )}
          {renders.loaded.state === 'loading' && (
            <p className="muted" role="status">
              Loading the renders…
            </p>
          )}
          {renders.loaded.state === 'error' && (
            <Notice tone="danger" role="alert" title="The renders cannot be read">
              <p className="pre-line">
                <Txt text={renders.loaded.error} />
              </p>
            </Notice>
          )}
          {renders.loaded.state === 'ready' && succeeded.length === 0 && (
            <p className="muted" data-testid="no-render">
              No finished render of this scenario yet: render it from the <a href={hrefTo({ name: 'timeline', slug, scenario: name })}>timeline</a>, then comment its frames here.
            </p>
          )}
          {shown && (
            <Viewer
              key={`${shown.render_id}\0${shown.created_at}`}
              slug={slug}
              name={name}
              shown={shown}
              frame={frame}
              setFrame={setFrame}
              drawing={composing}
              region={composing ? region : threadRegion}
              setRegion={setRegion}
              regionLabel={composing ? 'Region' : "The comment's region"}
              tick={tick}
              onReplaced={renders.reload}
            />
          )}
          {shown && composing && (
            <Composer
              slug={slug}
              name={name}
              shown={shown}
              frame={frame}
              region={region}
              setRegion={setRegion}
              onPosted={(id, warnings) => {
                setPosted({ id, warnings });
                setRegion(null);
                location.hash = hrefTo({ name: 'comments', slug, scenario: name, thread: id });
              }}
              onReplaced={renders.reload}
            />
          )}
          {shown && !composing && (
            <p className="small">
              <a href={hrefTo({ name: 'comments', slug, scenario: name, at: { render: shown.render_id, frame } })} data-testid="comment-this-frame">
                Comment this frame
              </a>{' '}
              <span className="muted">(a new thread at {renderWords(shown.render_id)}, frame {frame.toLocaleString('en')})</span>
            </p>
          )}
        </section>
        {thread !== undefined ? (
          <ThreadPanel key={thread} slug={slug} name={name} id={thread} tick={tick} onThread={setOpened} renders={succeeded} rs={renders} />
        ) : (
          <aside className="card comments-thread comments-help" aria-label="About comments">
            <h2 className="card-title">How it works</h2>
            <ol className="small">
              <li>Pick a render and a frame (the slider, the arrow keys, or a time).</li>
              <li>Optionally drag a region on the frame, or type it in the four fields.</li>
              <li>Write what should change and post: the thread keeps the exact frame, its still and where it points.</li>
            </ol>
            <p className="muted small">{CHANNEL_NOTE}</p>
          </aside>
        )}
      </div>
    </div>
  );
}

function RenderPicker({ renders, shown, onPick }: { renders: ScenarioRenderView[]; shown: Shown | null; onPick: (r: ScenarioRenderView) => void }) {
  if (renders.length === 0) return null;
  const value = shown ? `${shown.render_id}\0${shown.created_at}` : '';
  return (
    <label className="cv-pick">
      <span className="label">Render</span>
      <select
        data-testid="render-picker"
        value={value}
        onChange={(e) => {
          const r = renders.find((x) => `${x.render_id}\0${x.created_at}` === e.target.value);
          if (r) onPick(r);
        }}
      >
        {shown && !renders.some((r) => `${r.render_id}\0${r.created_at}` === value) && <option value={value}>{renderWords(shown.render_id)}</option>}
        {renders.map((r) => (
          <option key={`${r.render_id}\0${r.created_at}`} value={`${r.render_id}\0${r.created_at}`}>
            {renderWords(r.render_id)} · {r.width}×{r.height} · {new Date(r.created_at).toLocaleString('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

function ThreadList(p: {
  slug: string;
  name: string;
  filter: Filter;
  setFilter: (f: Filter) => void;
  onlyRender: boolean;
  setOnlyRender: (b: boolean) => void;
  render: string | null;
  current?: string;
  tick: number;
}) {
  const only = p.onlyRender && p.render !== null;
  const args = { project: p.slug, name: p.name, status: p.filter, ...(only ? { render: p.render } : {}) };
  const [loaded, reload] = useCall<ThreadsListAnswer>('threads_list', args, `${p.slug}\0${p.name}\0${p.filter}\0${only ? p.render : ''}`);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [p.tick, reload]);
  const group = useId();
  return (
    <section className="card comments-list" aria-labelledby={`${group}-h`} data-testid="thread-list">
      <h2 id={`${group}-h`} className="card-title">
        Threads
        {loaded.state === 'ready' && (
          <span className="muted small" data-testid="thread-counts">
            {' '}
            · {loaded.data.counts.open} open · {loaded.data.counts.resolved} resolved
          </span>
        )}
      </h2>
      <fieldset className="cl-filter">
        <legend className="label">Show</legend>
        <div className="cl-radios">
          {(['open', 'resolved', 'all'] as const).map((f) => (
            <label key={f} className="cl-radio">
              <input type="radio" name={`${group}-filter`} value={f} checked={p.filter === f} onChange={() => p.setFilter(f)} data-testid={`filter-${f}`} /> {f === 'open' ? 'Open' : f === 'resolved' ? 'Resolved' : 'All'}
            </label>
          ))}
        </div>
        <label className="cl-only small">
          <input type="checkbox" checked={p.onlyRender} disabled={p.render === null} onChange={(e) => p.setOnlyRender(e.target.checked)} data-testid="filter-render" /> This render only
        </label>
      </fieldset>
      {loaded.state === 'loading' && (
        <p className="muted small" role="status">
          Loading the threads…
        </p>
      )}
      {loaded.state === 'error' && (
        <Notice tone="danger" role="alert" title="The threads cannot be read">
          <p className="pre-line small">
            <Txt text={loaded.error} />
          </p>
        </Notice>
      )}
      {loaded.state === 'ready' && (
        <>
          {loaded.data.threads.length === 0 ? (
            <p className="muted small" data-testid="no-threads">
              {p.filter === 'open' ? 'No open comment' : p.filter === 'resolved' ? 'No resolved comment' : 'No comment'}
              {only ? ` on ${renderWords(p.render!)}` : ' on this scenario'} yet.
            </p>
          ) : (
            <ul className="cl-items">
              {loaded.data.threads.map((t) => (
                <ThreadRow key={t.id} t={t} slug={p.slug} name={p.name} current={p.current === t.id} />
              ))}
            </ul>
          )}
          {loaded.data.total > loaded.data.threads.length && <p className="muted small">The first {loaded.data.threads.length} of {loaded.data.total} are listed.</p>}
          {loaded.data.problems > 0 && <p className="muted small">{plural(loaded.data.problems, 'thread file')} could not be read (a hand-edited file, or one from a newer Studio).</p>}
        </>
      )}
    </section>
  );
}

/** The first line of a text (a list item shows one). */
const firstLine = (s: string) => s.split('\n', 1)[0] ?? '';

function ThreadRow({ t, slug, name, current }: { t: ThreadItem; slug: string; name: string; current: boolean }) {
  return (
    <li className={`cl-item${current ? ' is-current' : ''}`} data-testid="thread-item" data-id={t.id} data-status={t.status}>
      <a href={hrefTo({ name: 'comments', slug, scenario: name, thread: t.id })} aria-current={current ? 'page' : undefined}>
        <span className="cl-line">
          <Badge tone={t.status === 'open' ? 'info' : 'neutral'}>{statusWords(t.status)}</Badge> <span className="mono small">{t.timecode}</span>{' '}
          <span className="small muted">{t.render_present ? `on ${renderWords(t.render_id)}` : 'render gone'}</span>
        </span>
        <span className="cl-text">
          <Txt text={firstLine(t.untrusted.text)} />
        </span>
        <span className="cl-line small muted">
          {whereWords(t.anchor)} · {channelWords(t.via)}
          {t.entries_total > 0 ? ` · ${plural(t.entries_total, 'entry', 'entries')}` : ''}
        </span>
        {t.proposal && (
          <span className="cl-line">
            <Badge tone={t.proposal.actionable ? 'warning' : 'neutral'}>{proposalWords(t.proposal.state)}</Badge>
          </span>
        )}
      </a>
    </li>
  );
}

// ── The viewer ──────────────────────────────────────────────────────────────

function Viewer(p: {
  slug: string;
  name: string;
  shown: Shown;
  frame: number;
  setFrame: (f: number) => void;
  drawing: boolean;
  region: Region | null;
  setRegion: (r: Region | null) => void;
  regionLabel: string;
  tick: number;
  onReplaced: () => void;
}) {
  const { slug, shown, frame, setFrame } = p;
  const [outline, reloadOutline] = useCall<Outline>('render_outline', { project: slug, render_id: shown.render_id, created_at: shown.created_at }, `${slug}\0${shown.render_id}\0${shown.created_at}`);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reloadOutline();
  }, [p.tick, reloadOutline]);
  const o = outline.state === 'ready' ? outline.data : null;
  const last = o ? Math.max(0, o.frames - 1) : 0;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const go = useCallback((f: number) => setFrame(Math.min(last, Math.max(0, Math.round(f)))), [last, setFrame]);
  // Inside the render once its length is known.
  useEffect(() => {
    if (o && frame > last) setFrame(last);
  }, [o, frame, last, setFrame]);

  // The frames: one request in flight, the newest wins (FrameRequests).
  const [image, setImage] = useState<FrameAnswer | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const requests = useRef<FrameRequests<FrameAnswer> | null>(null);
  const replaced = useRef(p.onReplaced);
  replaced.current = p.onReplaced;
  useEffect(() => {
    const r = new FrameRequests<FrameAnswer>({
      fetch: (ask: FrameAsk, signal) => call<FrameAnswer>('render_frame', { project: slug, render_id: ask.render_id, created_at: ask.created_at, frame: ask.frame, session: SESSION }, { signal }),
      onResult: (res) => {
        if (res.ok) {
          setImage(res.data);
          setFrameError(null);
        } else if (res.error.code !== 'cancelled') {
          setFrameError(res.error.message);
          if (res.error.status === 409) replaced.current();
        }
      },
    });
    requests.current = r;
    return () => {
      r.close();
      requests.current = null;
    };
  }, [slug]);
  useEffect(() => {
    if (!o || frame > last) return;
    requests.current?.want({ render_id: shown.render_id, created_at: shown.created_at, frame });
  }, [o, frame, last, shown.render_id, shown.created_at]);

  // ← / → one frame, Shift one second (never while typing, never doubling the slider's own arrows).
  useEffect(() => {
    if (!o) return;
    const onKey = (e: KeyboardEvent) => {
      const by = viewerKey(e, keyTarget(e.target), o.fps);
      if (by === null) return;
      e.preventDefault();
      go(frameRef.current + by);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [o, go]);

  const [time, setTime] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);
  const timeId = useId();

  if (outline.state === 'loading') {
    return (
      <p className="muted" role="status">
        Loading the render…
      </p>
    );
  }
  if (outline.state === 'error') {
    return (
      <Notice tone="danger" role="alert" title="This render cannot be shown">
        <p className="pre-line" data-testid="outline-error">
          <Txt text={outline.error} />
        </p>
      </Notice>
    );
  }
  const d = outline.data;
  const at = (f: number) => `${(Math.min(Math.max(0, f), d.frames) / Math.max(1, d.frames)) * 100}%`;
  return (
    <div className="cv" data-testid="viewer" data-render={d.render_id} data-variant={d.variant} data-frame={frame} data-shown={image ? image.frame : ''}>
      <FrameView
        o={d}
        image={image}
        frame={frame}
        drawing={p.drawing}
        region={p.region}
        setRegion={p.setRegion}
        regionLabel={p.regionLabel}
        alt={`Frame ${frame.toLocaleString('en')} of ${renderWords(d.render_id)} (${frameTime(frame, d.fps)})`}
      />
      {frameError && (
        <p className="pre-line small" role="alert" data-testid="frame-error">
          <Txt text={frameError} />
        </p>
      )}
      <div className="cv-scrub">
        <input
          type="range"
          className="cv-slider"
          data-testid="frame-slider"
          min={0}
          max={last}
          step={1}
          value={Math.min(frame, last)}
          aria-label="Frame"
          aria-valuetext={`frame ${frame.toLocaleString('en')}, ${frameTime(frame, d.fps)}`}
          onChange={(e) => go(Number(e.target.value))}
        />
        <ul className="cv-ticks" aria-label={`Markers and comments on ${renderWords(d.render_id)}`}>
          {d.markers.map((k, i) => {
            const words = `Marker ${d.untrusted.markers[i] ?? ''} at ${frameTime(k.frame, d.fps)}`;
            return (
              <li key={`m${i}`} className="cv-tick cv-marker" style={{ left: at(k.frame) }}>
                <button type="button" aria-label={words} title={words} data-testid="viewer-marker" onClick={() => go(k.frame)}>
                  <span aria-hidden="true">◆</span>
                </button>
              </li>
            );
          })}
          {d.pins.map((pin) => {
            const words = `Comment, ${pin.status}, at ${frameTime(pin.frame, d.fps)}: open the thread`;
            return (
              <li key={pin.id} className={`cv-tick cv-pin is-${pin.status}`} style={{ left: at(pin.frame) }}>
                <a href={hrefTo({ name: 'comments', slug, scenario: p.name, thread: pin.id })} aria-label={words} title={words} data-testid="viewer-pin" data-id={pin.id}>
                  <span aria-hidden="true">{pin.status === 'open' ? '●' : '○'}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="cv-controls" role="group" aria-label="Frame controls">
        <button type="button" className="button small" aria-label="Back one second" onClick={() => go(frame - Math.round(d.fps))}>
          −1 s
        </button>
        <button type="button" className="button small" aria-label="Previous frame" data-testid="viewer-prev" onClick={() => go(frame - 1)}>
          ◀︎ Frame
        </button>
        <button type="button" className="button small" aria-label="Next frame" data-testid="viewer-next" onClick={() => go(frame + 1)}>
          Frame ▶︎
        </button>
        <button type="button" className="button small" aria-label="Forward one second" onClick={() => go(frame + Math.round(d.fps))}>
          +1 s
        </button>
        <output className="mono small" data-testid="viewer-time" aria-live="off">
          {frameTime(frame, d.fps)} / {frameTime(d.frames, d.fps)} · frame {frame.toLocaleString('en')} of {d.frames.toLocaleString('en')}
        </output>
        <form
          className="cv-time"
          onSubmit={(e) => {
            e.preventDefault();
            const r = parseTimecode(time, d.fps, d.frames);
            if ('error' in r) setTimeError(r.error);
            else {
              setTimeError(null);
              go(r.frame);
            }
          }}
        >
          <label htmlFor={timeId} className="sr-only">
            Go to a time
          </label>
          <input id={timeId} type="text" inputMode="decimal" placeholder={timeExample(d.frames, d.fps)} value={time} onChange={(e) => setTime(e.target.value)} aria-describedby={timeError ? `${timeId}-e` : undefined} data-testid="viewer-time-input" size={8} />
          <button type="submit" className="button small">
            Go
          </button>
          {timeError && (
            <span id={`${timeId}-e`} className="small field-error" role="alert">
              {timeError}
            </span>
          )}
        </form>
      </div>
      <p className="muted small cv-keys">
        ← → one frame · Shift + ← → one second · {d.width}×{d.height}, {d.fps} fps{d.variant !== 'landscape' ? `, ${d.variant}` : ''}
      </p>
    </div>
  );
}

/**
 * The frame, sized by the render's own aspect ratio (critique B11: the pointer maths use this box — the picture itself,
 * no letterbox), with the region drawn over it; a drag draws a new region when `drawing`.
 */
function FrameView(p: { o: Outline; image: FrameAnswer | null; frame: number; drawing: boolean; region: Region | null; setRegion: (r: Region | null) => void; regionLabel: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; from: { x: number; y: number }; before: Region | null } | null>(null);
  const [draft, setDraft] = useState<Region | null>(null);
  const [dragging, setDragging] = useState(false);
  const { setRegion } = p;
  // Esc cancels a drag (the region before it stays).
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault();
      const el = box.current;
      if (el?.hasPointerCapture(drag.current.id)) el.releasePointerCapture(drag.current.id);
      drag.current = null;
      setDraft(null);
      setDragging(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);
  const rect = () => box.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!p.drawing || !p.image || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, from: pointIn(rect(), e.clientX, e.clientY), before: p.region };
    setDraft(null);
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setDraft(regionOfDrag(d.from, pointIn(rect(), e.clientX, e.clientY)));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    setDraft(null);
    // A click (no drag) makes no region: the one before stays.
    const r = regionOfDrag(d.from, pointIn(rect(), e.clientX, e.clientY));
    if (r) setRegion(r);
  };
  const shownRegion = draft ?? p.region;
  const { width: w, height: h } = p.o;
  return (
    <div
      ref={box}
      className={`cv-frame${p.drawing ? ' is-drawing' : ''}`}
      data-testid="viewer-frame"
      style={{ aspectRatio: `${w} / ${h}`, width: `min(100%, calc(62vh * ${w} / ${h}))` }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {p.image ? (
        <Jpeg base64={p.image.base64} max={SHEET_DATA_MAX} width={p.image.width} height={p.image.height} alt={p.alt} />
      ) : (
        <span className="cv-loading muted small" role="status">
          Loading the frame…
        </span>
      )}
      {p.image && p.image.frame !== p.frame && (
        <span className="cv-stale small" role="status">
          Loading frame {p.frame.toLocaleString('en')}…
        </span>
      )}
      {shownRegion && (
        <span
          className={`cv-region${draft ? ' is-draft' : ''}`}
          data-testid="viewer-region"
          aria-hidden="true"
          style={{ left: `${shownRegion.x * 100}%`, top: `${shownRegion.y * 100}%`, width: `${shownRegion.w * 100}%`, height: `${shownRegion.h * 100}%` }}
        >
          <span className="cv-region-label">{p.regionLabel}</span>
        </span>
      )}
    </div>
  );
}

// ── The composer ────────────────────────────────────────────────────────────

function ChipList({ chips, label }: { chips: Chip[]; label: string }) {
  return (
    <ul className="anchor-chips" aria-label={label} data-testid="chips">
      {chips.map((c) => (
        <li key={c.kind} className="anchor-chip" data-testid={`chip-${c.kind}`}>
          <span className="chip-label">{c.label}</span> <Txt text={c.words} />
          {c.note && (
            <span className="chip-note small">
              {' '}
              (<Txt text={c.note} />)
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Composer(p: { slug: string; name: string; shown: Shown; frame: number; region: Region | null; setRegion: (r: Region | null) => void; onPosted: (id: string, warnings: string[]) => void; onReplaced: () => void }) {
  const { slug, shown, frame, region, setRegion } = p;
  const [fields, setFields] = useState<RegionFields>(() => fieldsOf(region));
  // A drag (or Clear) sets the region: the fields follow — unless they already say it (the person is typing them).
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  useEffect(() => {
    if (!sameRegion(regionOfFields(fieldsRef.current), region)) setFields(fieldsOf(region));
  }, [region]);
  const setField = (k: keyof RegionFields, v: string) => {
    const next = { ...fields, [k]: v };
    setFields(next);
    setRegion(regionOfFields(next));
  };

  // The chips: the anchor the server would store (frame_anchor), 150 ms after the frame or region settles.
  const [anchor, setAnchor] = useState<{ state: 'loading' } | { state: 'ok'; a: AnchorAnswer } | { state: 'error'; message: string }>({ state: 'loading' });
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setAnchor((a) => (a.state === 'ok' ? a : { state: 'loading' }));
    const t = setTimeout(() => {
      call<AnchorAnswer>('frame_anchor', { project: slug, render_id: shown.render_id, created_at: shown.created_at, frame, ...(region ? { region } : {}) }).then(
        (a) => n === seq.current && setAnchor({ state: 'ok', a }),
        (e: unknown) => {
          if (n !== seq.current || e instanceof SessionEnded) return;
          setAnchor({ state: 'error', message: errorText(e) });
        },
      );
    }, 150);
    return () => clearTimeout(t);
  }, [slug, shown.render_id, shown.created_at, frame, region]);
  const chips = anchor.state === 'ok' ? anchorChips(anchor.a) : [];
  const fresh = anchor.state === 'ok' && anchor.a.frame === frame;

  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const post = () => {
    if (posting || text.trim() === '') return;
    setPosting(true);
    setError(null);
    call<{ thread: ThreadAnswer; warnings: string[] }>('thread_add', { project: slug, render_id: shown.render_id, created_at: shown.created_at, frame, ...(region ? { region } : {}), text })
      .then(
        (r) => {
          setText('');
          p.onPosted(r.thread.id, r.warnings);
        },
        (e: unknown) => {
          if (e instanceof SessionEnded) return;
          setError(errorText(e));
          if (e instanceof CallError && e.status === 409) p.onReplaced();
        },
      )
      .finally(() => setPosting(false));
  };
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      post();
    }
  };
  const fieldDefs: Array<[keyof RegionFields, string]> = [
    ['x', 'Left'],
    ['y', 'Top'],
    ['w', 'Width'],
    ['h', 'Height'],
  ];
  return (
    <form
      className="composer"
      aria-labelledby={`${ids}-h`}
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        post();
      }}
    >
      <h3 id={`${ids}-h`} className="card-title">
        Comment frame {frame.toLocaleString('en')} of {renderWords(shown.render_id)}
      </h3>
      <fieldset className="region-fields">
        <legend className="label">Region (optional) — drag on the frame, or type it in % of the frame</legend>
        <div className="region-row">
          {fieldDefs.map(([k, label]) => (
            <label key={k} className="field region-field">
              <span className="small">{label} %</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={fields[k]}
                data-testid={`region-${k}`}
                onChange={(e) => setField(k, e.target.value)}
                onBlur={() => {
                  if (region) setFields(fieldsOf(region));
                }}
              />
            </label>
          ))}
          <button type="button" className="button small" data-testid="region-clear" disabled={region === null && fields.x === '' && fields.y === '' && fields.w === '' && fields.h === ''} onClick={() => setRegion(null)}>
            Clear region
          </button>
        </div>
        <p className="small muted" aria-live="polite" data-testid="region-words">
          {region ? `Region ${regionWords(region)}` : 'No region: the comment is about the whole frame.'}
        </p>
      </fieldset>
      <div className="composer-chips" aria-busy={!fresh}>
        <p className="label">Where it points</p>
        {anchor.state === 'error' ? (
          <p className="pre-line small" role="alert" data-testid="anchor-error">
            <Txt text={anchor.message} />
          </p>
        ) : chips.length ? (
          <ChipList chips={chips} label="Where this comment points" />
        ) : (
          <p className="muted small" role="status">
            Reading where the frame points…
          </p>
        )}
        {anchor.state === 'ok' && anchor.a.warnings.length > 0 && (
          <ul className="small muted">
            {anchor.a.warnings.map((w, i) => (
              <li key={i}>
                <Txt text={w} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="field">
        <span className="label">Comment</span>
        <textarea
          rows={4}
          value={text}
          maxLength={COMMENT_TEXT_MAX}
          data-testid="comment-text"
          aria-describedby={`${ids}-left ${ids}-how`}
          placeholder="What should change at this frame?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
      </label>
      <p className="small muted" id={`${ids}-left`} aria-live="polite">
        {charactersLeft(text)}
      </p>
      <div className="actions">
        <button type="submit" className="button primary" data-testid="post-comment" disabled={posting || text.trim() === ''}>
          {posting ? 'Posting…' : 'Post the comment'}
        </button>
        <span className="small muted" id={`${ids}-how`} role="status">
          {posting ? 'Posting… the thread is written, then its still is made.' : '⌘↩ posts. Written as the channel Studio, under the name this Studio was started with.'}
        </span>
      </div>
      {error && (
        <Notice tone="danger" role="alert" title="The comment was not posted">
          <p className="pre-line" data-testid="post-error">
            <Txt text={error} />
          </p>
        </Notice>
      )}
    </form>
  );
}

// ── The thread ──────────────────────────────────────────────────────────────

function ThreadPanel({ slug, name, id, tick, onThread, renders, rs }: { slug: string; name: string; id: string; tick: number; onThread: (t: ThreadAnswer | null) => void; renders: ScenarioRenderView[]; rs: RendersState }) {
  const [loaded, reload] = useCall<ThreadGetAnswer>('thread_get', { project: slug, comment_id: id }, `${slug}\0${id}`);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [tick, reload]);
  const t = loaded.state === 'ready' ? loaded.data.thread : null;
  useEffect(() => {
    if (t) onThread(t);
  }, [t, onThread]);
  const head = useId();
  if (loaded.state === 'loading') {
    return (
      <aside className="card comments-thread" aria-label="Thread">
        <p className="muted" role="status">
          Loading the thread…
        </p>
      </aside>
    );
  }
  if (loaded.state === 'error') {
    return (
      <aside className="card comments-thread" aria-label="Thread">
        <Notice tone={loaded.code === 'not_found' ? 'info' : 'danger'} role="alert" title={loaded.code === 'not_found' ? 'No such thread' : 'This thread cannot be read'}>
          <p className="pre-line" data-testid="thread-error">
            <Txt text={loaded.error} />
          </p>
          <p>
            <a href={hrefTo({ name: 'comments', slug, scenario: name })}>Back to the threads</a>
          </p>
        </Notice>
      </aside>
    );
  }
  const th = loaded.data.thread;
  const texts = new Map(th.untrusted.entries.map((e) => [e.id, e]));
  const chips = anchorChips({ frame: th.frame, timecode: th.timecode, anchor: th.anchor, ...(th.step_now !== undefined ? { step_now: th.step_now } : {}) });
  return (
    <article className="card comments-thread" aria-labelledby={head} data-testid="thread" data-id={th.id} data-status={th.status} data-hash={th.hash}>
      <h2 id={head} className="card-title">
        Comment at {th.timecode} on {renderWords(th.render_id)}
      </h2>
      <p className="th-meta">
        <Badge tone={th.status === 'open' ? 'info' : 'neutral'}>{statusWords(th.status)}</Badge> <Txt text={th.untrusted.author} /> <span className="muted small">({channelWords(th.via)})</span> · <When iso={th.created_at} />
      </p>
      <p className="th-text pre-line" data-testid="thread-text">
        <Txt text={th.untrusted.text} />
      </p>
      <ChipList chips={chips} label="Where it points" />
      <p className="small muted" data-testid="thread-region">
        {th.region ? `Region ${regionWords(th.region)}` : 'About the whole frame'} · frame {th.frame.toLocaleString('en')}
        {th.variant !== 'landscape' ? ` · ${th.variant}` : ''}
      </p>
      {th.newer_renders.length > 0 && (
        <p className="small" data-testid="newer-renders">
          Newer renders: {th.newer_renders.map(renderWords).join(', ')} — the frame may already be fixed there.
        </p>
      )}
      {!th.render_present && th.still && <ThreadStill slug={slug} id={th.id} renderId={th.render_id} />}
      {th.entries.length > 0 && (
        <>
          <h3 className="card-title th-entries-h">{plural(th.entries_total, 'entry', 'entries')}</h3>
          {th.entries_total > th.entries.length && <p className="muted small">The newest {th.entries.length} are shown.</p>}
          <ol className="th-entries" data-testid="thread-entries">
            {th.entries.map((e) => {
              const u = texts.get(e.id);
              return (
                <li key={e.id} className="th-entry" data-testid="thread-entry" data-kind={e.kind} data-via={e.via}>
                  <p className="th-entry-head small">
                    <Badge tone={e.via === 'mcp' ? 'warning' : 'neutral'}>{channelWords(e.via)}</Badge> {u && e.via !== 'mcp' && <Txt text={u.author} />} {entryWords(e.kind)}
                    {e.render_id ? ` with ${renderWords(e.render_id)}` : ''} · <When iso={e.created_at} />
                  </p>
                  {u && u.text !== '' && (
                    <p className="pre-line th-entry-text">
                      <Txt text={u.text} />
                    </p>
                  )}
                  {e.proposal && (
                    <p className="small th-proposal" data-testid="entry-proposal" data-state={e.proposal.state}>
                      <Badge tone={e.proposal.actionable ? 'warning' : 'neutral'}>{proposalWords(e.proposal.state)}</Badge> A change to scenarios/<Txt text={name} />
                      .yaml: {plural(e.proposal.added, 'line')} added, {e.proposal.removed} removed, in {plural(e.proposal.hunks, 'place')}.
                    </p>
                  )}
                  {e.applies && <p className="small muted">Applied the proposal of {e.applies}.</p>}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {loaded.data.proposal && <ProposalCard slug={slug} name={name} th={th} p={loaded.data.proposal} rs={rs} reload={reload} />}
      <ThreadActions slug={slug} th={th} renders={renders} reload={reload} />
      <p className="muted small th-channels">{CHANNEL_NOTE}</p>
    </article>
  );
}

/** A thread's still (its render is gone): asked once, a checked data: JPEG. */
function ThreadStill({ slug, id, renderId }: { slug: string; id: string; renderId: string }) {
  const [loaded] = useCall<{ base64: string; width: number; height: number }>('thread_still', { project: slug, comment_id: id }, `${slug}\0${id}`);
  return (
    <figure className="th-still" data-testid="thread-still">
      {loaded.state === 'ready' ? (
        <Jpeg base64={loaded.data.base64} max={SHEET_DATA_MAX} width={loaded.data.width} height={loaded.data.height} alt={`The still of this comment, made on ${renderWords(renderId)} (its region outlined)`} />
      ) : (
        <p className="muted small">{loaded.state === 'error' ? <Txt text={loaded.error} /> : 'Loading the still…'}</p>
      )}
      <figcaption className="small muted">The still kept with the thread: {renderWords(renderId)} is gone.</figcaption>
    </figure>
  );
}

type Write = { kind: 'idle' } | { kind: 'sending'; what: string } | { kind: 'done'; words: string } | { kind: 'conflict'; words: string } | { kind: 'error'; words: string };

function ThreadActions({ slug, th, renders, reload }: { slug: string; th: ThreadAnswer; renders: ScenarioRenderView[]; reload: () => void }) {
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const newer = th.newer_renders.filter((r) => renders.some((x) => x.render_id === r));
  const [answer, setAnswer] = useState<string>(newer[0] ?? '');
  const [write, setWrite] = useState<Write>({ kind: 'idle' });
  const ids = useId();
  const send = (what: string, op: string, args: Record<string, unknown>, done: string, clear: () => void) => {
    setWrite({ kind: 'sending', what });
    call(op, { project: slug, comment_id: th.id, ...args })
      .then(
        () => {
          clear();
          setWrite({ kind: 'done', words: done });
        },
        (e: unknown) => {
          if (e instanceof SessionEnded) return;
          // The thread changed since the screen showed it (Claude replied, another tab): read it again, send nothing.
          if (e instanceof CallError && e.status === 409) setWrite({ kind: 'conflict', words: `The thread changed since you opened it: read it again, then ${what.toLowerCase()} — nothing was written. (${errorText(e)})` });
          else setWrite({ kind: 'error', words: errorText(e) });
        },
      )
      .finally(reload);
  };
  const sending = write.kind === 'sending';
  return (
    <div className="th-actions">
      <form
        className="th-form"
        aria-labelledby={`${ids}-r`}
        onSubmit={(e) => {
          e.preventDefault();
          if (reply.trim()) send('Reply', 'thread_reply', { text: reply }, 'Reply posted', () => setReply(''));
        }}
      >
        <label className="field">
          <span className="label" id={`${ids}-r`}>
            Reply
          </span>
          <textarea rows={3} value={reply} maxLength={COMMENT_TEXT_MAX} onChange={(e) => setReply(e.target.value)} data-testid="reply-text" />
        </label>
        <button type="submit" className="button" data-testid="reply" disabled={sending || reply.trim() === ''}>
          Reply
        </button>
      </form>
      {th.status === 'open' ? (
        <form
          className="th-form"
          aria-labelledby={`${ids}-s`}
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) send('Resolve', 'thread_resolve', { note, if_match: th.hash, ...(answer ? { render_id: answer } : {}) }, 'Resolved', () => setNote(''));
          }}
        >
          <label className="field">
            <span className="label" id={`${ids}-s`}>
              Resolve — what was changed
            </span>
            <textarea rows={2} value={note} maxLength={COMMENT_TEXT_MAX} onChange={(e) => setNote(e.target.value)} data-testid="resolve-note" />
          </label>
          {newer.length > 0 && (
            <label className="field">
              <span className="small">Answered by</span>
              <select value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="resolve-render">
                {newer.map((r) => (
                  <option key={r} value={r}>
                    {renderWords(r)}
                  </option>
                ))}
                <option value="">no render</option>
              </select>
            </label>
          )}
          <button type="submit" className="button" data-testid="resolve" disabled={sending || note.trim() === ''}>
            Resolve
          </button>
        </form>
      ) : (
        <form
          className="th-form"
          aria-labelledby={`${ids}-o`}
          onSubmit={(e) => {
            e.preventDefault();
            send('Reopen', 'thread_reopen', { if_match: th.hash, ...(note.trim() ? { note } : {}) }, 'Reopened', () => setNote(''));
          }}
        >
          <label className="field">
            <span className="label" id={`${ids}-o`}>
              Reopen — why (optional)
            </span>
            <textarea rows={2} value={note} maxLength={COMMENT_TEXT_MAX} onChange={(e) => setNote(e.target.value)} data-testid="reopen-note" />
          </label>
          <button type="submit" className="button" data-testid="reopen" disabled={sending}>
            Reopen
          </button>
        </form>
      )}
      <p className="small" aria-live="polite" data-testid="thread-write">
        {write.kind === 'sending' ? `${write.what}…` : write.kind === 'done' ? write.words : ''}
      </p>
      {(write.kind === 'conflict' || write.kind === 'error') && (
        <Notice tone={write.kind === 'conflict' ? 'warning' : 'danger'} role="alert">
          <p className="pre-line small" data-testid="thread-write-error">
            <Txt text={write.words} />
          </p>
        </Notice>
      )}
    </div>
  );
}
