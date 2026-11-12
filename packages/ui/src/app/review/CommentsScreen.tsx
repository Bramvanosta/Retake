/**
 * Review › Comments (L4.6 part D1, R-UI-27 / R-UI-29; L5.12b « Épure » 4b, R4-Comments, R-UI-47):
 * `#/p/<slug>/s/<name>/comments[/<thread> | /at/<render>/<frame>]` — frame comments in the shell's panes:
 *
 * - Context (title bar): Review's View — Report · Comments (n open) (the Comments segment keeps `comments-tab`); the status
 *   bar: Review's own line (ReviewChrome, shared with the report: "Rendered · when · vN · n open · n resolved", Open in
 *   Edit, Render) on the render shown — never Shoot's actions.
 * - Browser pane: the threads (ThreadList.tsx — Open · Resolved · All, "This render only", counts; rows link to threads).
 * - Centre: the render shown (its version, size and when; the render picker), its frames (FrameViewer.tsx: the frame
 *   with the region, the slider, the steps, the typed time, markers and pins) and, while no thread is open, the composer
 *   (Composer.tsx); with a thread open, "Comment this frame" opens a new one at the frame shown.
 * - Inspector: the thread (ThreadPanel.tsx: its entries, Claude's proposal with its diff and the offered buttons —
 *   ProposalCard.tsx —, Reply, Resolve, Reopen), or how comments work while none is open.
 * - ⌘K: "Comment at this frame" (the palette's Review group, shell/command-bus.ts paletteGroup) while a render is shown;
 *   its words name the render only (review A-L1: a frame in them would rebuild the shell's palette on every step — the
 *   frame is read when it runs).
 * - Arriving to comment a frame (an `at` address: Comment this frame, the timeline's Comment or C), the composer's text
 *   box and Post are brought into view and the text focused once the frame is laid out (review B-L4).
 * Where the viewer starts, once per address: a thread's render and frame, a render's frame, else the newest render; a
 * render gone says so (the thread's still is shown with it). Events (commentsEventAction): the list, the thread and the
 * pins read again when this scenario's comments or file change or after a reconnection, at most once a second; the
 * renders (useRenders) on the project's renders. The page never names an author or a channel: the Studio writes `studio`
 * under the name it was started with — a channel, not a proof of a person.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadAnswer } from '../../server/comment-ops.js';
import { Txt, When } from '../bits.js';
import { CHANNEL_NOTE, renderWords } from '../words/comment-words.js';
import type { Region } from '../words/comment-words.js';
import { Composer } from './Composer.js';
import { commentsEventAction, useEvents } from '../events.js';
import { FrameViewer } from './FrameViewer.js';
import type { Shown } from './FrameViewer.js';
import { useRenders, useReportEntry } from './Renders.js';
import { ReviewChrome, useReviewRender } from './ReviewScreen.js';
import { hrefTo } from '../route.js';
import { usePaletteGroup } from '../shell/command-bus.js';
import { ShellSlot } from '../shell/slots.js';
import { ThreadList } from './ThreadList.js';
import type { Filter } from './ThreadList.js';
import { ThreadPanel } from './ThreadPanel.js';
import { Callout, EmptyState, InspectorSection, LinkButton, Select } from '../ui-kit/index.js';

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

const renderKey = (r: { render_id: string; created_at: string }) => `${r.render_id}\0${r.created_at}`;

export function CommentsScreen({ slug, name, thread, at }: { slug: string; name: string; thread?: string; at?: { render: string; frame: number } }) {
  const renders = useRenders(slug, name);
  useReportEntry(slug, name, renders);
  const rr = useReviewRender(slug, name, renders);
  const succeeded = useMemo(() => (renders.loaded.state === 'ready' ? renders.loaded.data.renders.filter((r) => r.status === 'succeeded') : []), [renders.loaded]);
  const [filter, setFilter] = useState<Filter>('open');
  const [onlyRender, setOnlyRender] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [frame, setFrame] = useState(0);
  const [region, setRegion] = useState<Region | null>(null);
  const [opened, setOpened] = useState<ThreadAnswer | null>(null);
  const [posted, setPosted] = useState<{ id: string; warnings: string[] } | null>(null);
  const [tick, bump] = useThrottledTick(1000);
  // The render whose frame is laid out (its outline read: the frame's box has its size) — the composer's focus waits for it.
  const [laidOut, setLaidOut] = useState<string | null>(null);
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
  const shownRender = shown ? succeeded.find((r) => r.render_id === shown.render_id && r.created_at === shown.created_at) : undefined;

  // ⌘K: "Comment at this frame" — the composer's text (no thread open), else a new thread at the frame shown: a place or
  // a focus, never a write.
  usePaletteGroup(
    'review',
    shown
      ? [
          {
            id: 'comment-at-frame',
            label: 'Comment at this frame',
            hint: `${renderWords(shown.render_id)}, the frame shown`,
            icon: 'plus',
            run: () => {
              // The text is focused once the palette has closed and given the focus back (behind its modal the page is
              // inert: a focus asked while it is open is lost — L5.12b fixes, found by the palette's op-counter test).
              if (composing) setTimeout(() => document.querySelector<HTMLElement>('[data-testid="comment-text"]')?.focus(), 0);
              else location.hash = hrefTo({ name: 'comments', slug, scenario: name, at: { render: shown.render_id, frame } });
            },
          },
        ]
      : null,
  );

  return (
    <div className="cm-screen" data-testid="comments-screen">
      <ReviewChrome slug={slug} name={name} current="comments" x={shownRender} rr={rr} />
      <ShellSlot name="browser">
        <ThreadList slug={slug} name={name} filter={filter} setFilter={setFilter} onlyRender={onlyRender} setOnlyRender={setOnlyRender} render={shown?.render_id ?? null} current={thread} tick={tick} />
      </ShellSlot>
      <h1 className="k-sr">
        <Txt text={name} />
        {' — Comments'}
      </h1>
      {posted && (
        <Callout state={posted.warnings.length ? 'warn' : 'ok'} role="status" title={posted.warnings.length ? 'Comment posted, with a warning' : 'Comment posted'}>
          {posted.warnings.map((w, i) => (
            <p key={i} className="cm-pre" data-testid="posted-warning">
              <Txt text={w} />
            </p>
          ))}
        </Callout>
      )}
      <header className="cm-head">
        <p className="cm-head-line">
          {shown ? (
            <>
              <span className="cm-head-frame">
                {'Frame '}
                <Txt className="k-mono" text={frame.toLocaleString('en')} />
              </span>
              <Txt text={` · ${renderWords(shown.render_id)}`} />
              {shownRender && (
                <>
                  {' · rendered '}
                  <When iso={shownRender.created_at} />
                  <Txt text={` · theme ${shownRender.theme}`} />
                </>
              )}
            </>
          ) : (
            'Frames'
          )}
        </p>
        {succeeded.length > 0 && (
          <Select
            layout="inline"
            label="Render"
            testId="render-picker"
            value={shown ? renderKey(shown) : ''}
            options={[
              ...(shown && !succeeded.some((r) => renderKey(r) === renderKey(shown)) ? [{ value: renderKey(shown), label: renderWords(shown.render_id) }] : []),
              ...succeeded.map((r) => ({ value: renderKey(r), label: `${renderWords(r.render_id)} · ${r.width}×${r.height} · ${new Date(r.created_at).toLocaleString('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` })),
            ]}
            onChange={(v) => {
              const r = succeeded.find((x) => renderKey(x) === v);
              if (r) setShown({ render_id: r.render_id, created_at: r.created_at });
            }}
          />
        )}
      </header>
      {missing && (
        <Callout state="idle" role="note" title="Note: render not shown">
          <p data-testid="viewer-missing">
            <Txt text={`${missing}.`} />
          </p>
        </Callout>
      )}
      {renders.loaded.state === 'loading' && (
        <p className="cm-quiet" role="status">
          Loading the renders…
        </p>
      )}
      {renders.loaded.state === 'error' && (
        <Callout state="fail" role="alert" title="The renders cannot be read">
          <p className="cm-pre">
            <Txt text={renders.loaded.error} />
          </p>
        </Callout>
      )}
      {renders.loaded.state === 'ready' && succeeded.length === 0 && (
        <EmptyState title="No finished render yet" actions={<LinkButton size="sm" to={{ name: 'timeline', slug, scenario: name }}>Open in Edit</LinkButton>}>
          <p data-testid="no-render">No finished render of this scenario yet: render it from Edit (or the status bar's Render), then comment its frames here.</p>
        </EmptyState>
      )}
      {shown && (
        <FrameViewer
          key={renderKey(shown)}
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
          onLaidOut={() => setLaidOut(renderKey(shown))}
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
          focusText={at !== undefined && laidOut === renderKey(shown)}
          onPosted={(id, warnings) => {
            setPosted({ id, warnings });
            setRegion(null);
            location.hash = hrefTo({ name: 'comments', slug, scenario: name, thread: id });
          }}
          onReplaced={renders.reload}
        />
      )}
      {shown && !composing && (
        <p className="cm-line">
          <LinkButton size="sm" icon="plus" to={{ name: 'comments', slug, scenario: name, at: { render: shown.render_id, frame } }} testId="comment-this-frame">
            Comment this frame
          </LinkButton>
          <Txt className="cm-quiet-inline" text={` a new thread at ${renderWords(shown.render_id)}, frame ${frame.toLocaleString('en')}`} />
        </p>
      )}
      <ShellSlot name="inspector" inline={thread !== undefined ? 'Thread' : 'About comments'}>
        {thread !== undefined ? (
          <div className="cm-inspector">
            <ThreadPanel key={thread} slug={slug} name={name} id={thread} tick={tick} onThread={setOpened} renders={succeeded} rs={renders} />
          </div>
        ) : (
          <InspectorSection title="How it works">
            <ol className="cm-help">
              <li>Pick a render and a frame (the slider, the arrow keys, or a time).</li>
              <li>Optionally drag a region on the frame, or type it in the four fields.</li>
              <li>Write what should change and post: the thread keeps the exact frame, its still and where it points.</li>
            </ol>
            <p className="cm-quiet">
              <Txt text={CHANNEL_NOTE} />
            </p>
            <p className="cm-quiet">The Studio calls no model itself: Claude reads open comments and proposes changes through MCP when you ask it to.</p>
          </InspectorSection>
        )}
      </ShellSlot>
    </div>
  );
}
