/**
 * The timeline screen (L4.5 part C; R-UI-15 "Open timeline", R-UI-24, R-UI-25; DESIGN §4g): one capture of a scenario
 * as the edit plans it — the preview (the Remotion Player in the sandboxed frame of the player origin: PreviewFrame),
 * the transport, the scrubber and the tracks (TimelineTracks), with the take's warnings and notes.
 *
 * - One read, `timeline_view` (the engine's path-free view and the preview's capability URLs), again when this
 *   scenario's file or runs change and after a reconnection; the engine's memo makes a re-read of an unchanged take
 *   free, and a new plan URL loads into the same frame (no reload).
 * - The preview starts muted (the frame's first `state` says so; "Unmute" asks it), shows "Loading the preview…" until
 *   the frame is `settled` at the frame asked (critique B8), seeks exactly when paused (a seek pauses), and a scrub
 *   sends at most one seek per animation frame. A browser that cannot play the capture's codec (Playwright's Chromium
 *   and H.264) gets the message only (critique Q5) — the tracks and the scrubber still work. A stopped preview (a
 *   flood, an invalid message: parent.ts) says why and can be restarted.
 * - Keys (timeline-words keyAction): Space, ← / →, Shift+← / →, Home / End, [ / ] — never while typing or in a radio
 *   group, and not doubling the scrubber's own arrows. Zoom: fit, or about ten seconds per screen with scroll; the
 *   playhead follows while playing.
 * - The inspector (part D, TimelineInspector.tsx) beside the preview: a segment is selected by a click on the segments
 *   track or by [ / ] (the segment the playhead lands on); the video's and that segment's switches write in one click,
 *   the view is read again and its new plan loads into the same frame — "Loading the preview…" until it is settled at
 *   the playhead, which stays where it was. Undo / redo restore the exact bytes. Every string from the server is a text
 *   node.
 * - Render (part E, Renders.tsx): the header's Render bar renders the capture shown on the version shown (a file changed
 *   since is refused and the view read again) and says what the newest render is doing; the Renders card under the
 *   tracks holds the queue (Cancel), the renders with their review's verdict, and a render's review — its findings seek
 *   the preview only when the render is of the version shown (the same plan signature and theme files), its images.
 * - L4.6: Comment (key C) opens the Comments screen at the playhead's frame of the newest render of the version shown
 *   (its frame f is the preview's frame f); a pin's tooltip and the other-take card open the thread; the pins are read
 *   again when the scenario's threads change.
 * - L4.6 part D2: Preview change (`#/p/<slug>/s/<name>/proposal/<comment>/<entry>`) shows the take planned from the
 *   text Claude proposed on a thread (`timeline_view {proposal}`: in memory, nothing written, switches and Render off),
 *   under a banner (ProposalBanner: which comment, whether the plan shows the change, Back to the comment — the thread,
 *   scrolled to its proposal: Apply is offered only there, under the whole diff) and seeks to that comment's pin.
 * - Review A (fixes): the page holds a lease on its project's preview capability (timeline_view `lease`) and gives it
 *   back when it leaves (`timeline_leave`): the project's preview URLs are revoked once no page holds one. A workspace
 *   component the take uses is not run in the preview until the person allows it here (`preview_allow`, by id and
 *   folder hash, for this Studio session): its stand-in draws, a notice names it with an Allow button.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TimelineView } from '@demo-studio/engine';
import type { TimelineViewAnswer } from '../server/ops.js';
import type { PreviewConnection } from '../player/parent.js';
import type { FrameMessage } from '../player/protocol.js';
import { call, errorText, useCall } from './api.js';
import { Badge, Loading, Notice, Txt, plural } from './bits.js';
import { commentsEventAction, useEvents, useScenarioEvents } from './events.js';
import { commentKey } from './comment-words.js';
import { CommentsTab } from './CommentsTab.js';
import { PreviewFrame } from './PreviewFrame.js';
import { ProposalBanner } from './ProposalPanel.js';
import { RenderBar, RendersPanel, useRenders } from './Renders.js';
import { versionNote } from './render-words.js';
import type { RenderTarget } from './Renders.js';
import { hrefTo } from './route.js';
import { TerminalCommands as Commands } from './ui-kit/index.js';
import { TimelineInspector, useSwitchEditor } from './TimelineInspector.js';
import { Tracks } from './TimelineTracks.js';
import { canPlay, cannotPlayWords, codecWords, frameWords, keyAction, landingOf, previewUrls, targetFrame, timecode, zoomFactor } from './timeline-words.js';
import type { CodecProbe, KeyTarget } from './timeline-words.js';

type Ready = Extract<TimelineViewAnswer, { run_id: string; model: unknown }>;
/** Frame notes kept (warnings and errors the frame posted). */
const NOTES_MAX = 20;

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
      <span aria-current="page">Timeline</span>
    </nav>
  );
}

/** What the browser can say about a codec (no element made: MediaSource, else Media Capabilities). */
function codecProbe(): CodecProbe {
  const w = window as unknown as { MediaSource?: { isTypeSupported?(t: string): boolean }; ManagedMediaSource?: { isTypeSupported?(t: string): boolean } };
  const ms = w.MediaSource ?? w.ManagedMediaSource;
  const mc = navigator.mediaCapabilities;
  return {
    ...(ms?.isTypeSupported ? { isTypeSupported: (t: string) => ms.isTypeSupported!(t) } : {}),
    ...(mc ? { decodingInfo: (cfg: Parameters<NonNullable<CodecProbe['decodingInfo']>>[0]) => mc.decodingInfo(cfg) } : {}),
  };
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

/** A random lease id (22 base64url characters) for timeline_view / timeline_leave. */
function newLease(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The proposal a timeline previews (the thread and the reply holding it). */
export interface PreviewedProposal {
  comment_id: string;
  entry_id: string;
}

export function TimelineScreen({ slug, name, run, step, proposal }: { slug: string; name: string; run?: string; step?: string; proposal?: PreviewedProposal }) {
  // The page's lease on its project's preview URLs: given back when it leaves the project or the screen.
  const [lease] = useState(newLease);
  useEffect(
    () => () => {
      void call('timeline_leave', { project: slug, lease }).catch(() => undefined);
    },
    [slug, lease],
  );
  const pc = proposal?.comment_id;
  const pe = proposal?.entry_id;
  const args = useMemo(
    () => ({ project: slug, name, lease, ...(run ? { run } : {}), ...(pc !== undefined && pe !== undefined ? { proposal: { comment_id: pc, entry_id: pe } } : {}) }),
    [slug, name, run, lease, pc, pe],
  );
  const [loaded, reload] = useCall<TimelineViewAnswer>('timeline_view', args, `${slug}\0${name}\0${run ?? ''}\0${pc ?? ''}\0${pe ?? ''}`);
  useScenarioEvents(slug, name, { reread: reload, progress: () => undefined });
  // L4.6: this scenario's threads changed (a comment posted, resolved): the pins are read again.
  useEvents((e) => {
    if (e.type !== 'resync' && commentsEventAction(e, slug, name).threads) reload();
  });

  if (loaded.state === 'loading') {
    return (
      <div className="screen timeline-screen">
        <Breadcrumb slug={slug} name={name} />
        <Loading what="the timeline" />
      </div>
    );
  }
  if (loaded.state === 'error') {
    return (
      <div className="screen timeline-screen">
        <Breadcrumb slug={slug} name={name} />
        <Notice tone={loaded.code === 'not_found' ? 'info' : 'danger'} role="alert" title={loaded.code === 'not_found' ? 'No capture to show' : 'This timeline cannot be opened'}>
          <p className="pre-line" data-testid="timeline-error">
            <Txt text={loaded.error} />
          </p>
          <p>
            <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'blocks' })}>Back to the scenario</a>: a capture there films the take this screen shows.
          </p>
          {proposal && (
            <p>
              <a href={hrefTo({ name: 'comments', slug, scenario: name, thread: proposal.comment_id })} data-testid="banner-back">
                Back to the comment
              </a>
              : a proposal is previewed while it is the thread's newest, not yet applied, and the scenario is still the file it was proposed on.
            </p>
          )}
        </Notice>
      </div>
    );
  }
  const d = loaded.data;
  if ('blocked' in d) {
    return (
      <div className="screen timeline-screen">
        <Breadcrumb slug={slug} name={name} />
        <header className="screen-head">
          <h1>
            <Txt text={name} />
          </h1>
        </header>
        <Notice tone="warning" role="alert" title="The Studio does not preview this take">
          <div data-testid="timeline-blocked">
            {d.blocked.problems.map((p, i) => (
              <p key={i} className="pre-line">
                <Txt text={p} />
              </p>
            ))}
            <Commands {...(d.blocked.command ? { fix: d.blocked.command } : {})} />
          </div>
        </Notice>
      </div>
    );
  }
  return <Timeline key={d.run_id} slug={slug} name={name} v={d as Ready} step={step} reload={reload} {...(proposal ? { proposal } : {})} />;
}

function Timeline({ slug, name, v, step, reload, proposal }: { slug: string; name: string; v: Ready; step?: string; reload: () => void; proposal?: PreviewedProposal }) {
  const m = v.model;
  const last = Math.max(0, m.frames - 1);
  const urls = 'frame_url' in v ? previewUrls(v.frame_url, v.plan_url) : null;

  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);
  /** The frame whose `settled` the loading state waits for ('any': after a pause), or null. */
  const [waiting, setWaiting] = useState<number | 'any' | null>(0);
  const waitingRef = useRef<number | 'any' | null>(0);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [muted, setMuted] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [rate, setRate] = useState<0.5 | 1 | 2>(1);
  const [missing, setMissing] = useState<string[]>([]);
  const [notes, setNotes] = useState<Array<{ type: 'warning' | 'error'; message: string }>>([]);
  const [stopped, setStopped] = useState<string | null>(null);
  const [restart, setRestart] = useState(0);
  const [zoom, setZoom] = useState<'fit' | 'zoom'>('fit');
  const [playable, setPlayable] = useState<boolean | null>(null);
  const conn = useRef<PreviewConnection | null>(null);
  /** The sound the person asked for: a new load remounts the Player muted, so an unmuted preview is unmuted again. */
  const wantSound = useRef(false);
  const pending = useRef<number | null>(null);
  const raf = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  /** The segment the inspector shows (its id), or null. */
  const [selected, setSelected] = useState<string | null>(null);
  const ed = useSwitchEditor(slug, name, v, reload);
  // Part E: the scenario's renders (a Render refused because the file changed reads the view again).
  const renders = useRenders(slug, name, reload);
  const shownVersion = useMemo(
    () => ({ run: v.run_id, theme: v.theme, plan_sha256: v.plan_sha256, theme_sha256: v.theme_sha256, ...(v.hash ? { hash: v.hash } : {}) }),
    [v.run_id, v.theme, v.hash, v.plan_sha256, v.theme_sha256],
  );
  // Workspace components the take uses that the preview does not run yet (review A H1 c), and the Allow clicks.
  const held = v.preview_held ?? [];
  const [allowing, setAllowing] = useState<string | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  const allow = (c: { id: string; hash: string }) => {
    setAllowing(c.id);
    setAllowError(null);
    call('preview_allow', { id: c.id, hash: c.hash })
      .then(
        () => {
          // A new frame document: its bundle now holds the component.
          setRestart((n) => n + 1);
          reload();
        },
        (e: unknown) => {
          setAllowError(errorText(e));
          reload();
        },
      )
      .finally(() => setAllowing(null));
  };
  // L4.6: Comment at the playhead — a render of the version shown (the same plan and theme files: its frame f is the
  // preview's frame f), the newest; without one the button is off, with why.
  const commentOn = renders.loaded.state === 'ready' ? renders.loaded.data.renders.find((x) => x.status === 'succeeded' && versionNote(x, shownVersion).same) : undefined;
  const tracksAt = useMemo(() => ({ slug, scenario: name }), [slug, name]);
  const renderTarget: RenderTarget = proposal
    ? { why: 'Previewing a proposal: apply it (Apply and re-render renders it)' }
    : v.hash === undefined
      ? { why: `scenarios/${name}.yaml is not there: nothing to render` }
      : { run: v.run_id, hash: v.hash, asCaptured: v.source.edit === 'run' };

  const wait = (w: number | 'any' | null) => {
    waitingRef.current = w;
    setWaiting(w);
  };
  const show = (f: number) => {
    frameRef.current = f;
    setFrame(f);
  };

  // The capture's codec: a browser that cannot play it gets the message, no frame.
  useEffect(() => {
    let live = true;
    setPlayable(null);
    void canPlay(v.capture.codec, codecProbe(), { width: m.width, height: m.height, fps: m.fps }).then((ok) => live && setPlayable(ok));
    return () => {
      live = false;
    };
  }, [v.capture.codec, m.width, m.height, m.fps]);

  // A shorter plan (a switch, a file changed): the playhead stays inside it.
  useEffect(() => {
    if (frameRef.current > last) show(last);
  }, [last]);

  const flush = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const f = pending.current;
    pending.current = null;
    if (f !== null) conn.current?.send({ type: 'seek', frame: f });
  }, []);

  const seek = useCallback(
    (to: number) => {
      const f = Math.min(last, Math.max(0, Math.round(to)));
      show(f);
      // A seek pauses the preview and shows that exact frame once settled.
      if (conn.current?.connected) wait(f);
      pending.current = f;
      if (!raf.current) raf.current = requestAnimationFrame(flush);
    },
    [last, flush],
  );
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const play = useCallback(() => {
    const c = conn.current;
    if (!c?.connected) return;
    // A seek still waiting for its animation frame goes first (it pauses: after the play, it would stop it).
    flush();
    if (frameRef.current >= last) {
      show(0);
      c.send({ type: 'seek', frame: 0 });
    }
    wait(null);
    c.send({ type: 'play' });
  }, [last, flush]);
  const pause = useCallback(() => {
    const c = conn.current;
    if (!c?.connected) return;
    flush();
    wait('any');
    c.send({ type: 'pause' });
  }, [flush]);
  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [play, pause]);

  const onMessage = useCallback((msg: FrameMessage) => {
    switch (msg.type) {
      case 'loaded':
        if (wantSound.current) conn.current?.send({ type: 'mute', muted: false });
        setMissing(msg.missing);
        if (msg.warnings.length) setNotes((n) => [...n, ...msg.warnings.map((message) => ({ type: 'warning' as const, message }))].slice(-NOTES_MAX));
        return;
      case 'frame':
        if (playingRef.current || waitingRef.current === 'any') show(msg.frame);
        return;
      case 'settled': {
        const w = waitingRef.current;
        if (w === 'any') show(msg.frame);
        if (w === 'any' || w === msg.frame) wait(null);
        return;
      }
      case 'state':
        playingRef.current = msg.playing;
        setPlaying(msg.playing);
        setBuffering(msg.buffering);
        setMuted(msg.muted);
        return;
      case 'ended':
        playingRef.current = false;
        setPlaying(false);
        return;
      case 'warning':
      case 'error':
        setNotes((n) => [...n, { type: msg.type, message: msg.message }].slice(-NOTES_MAX));
        return;
    }
  }, []);
  const onHello = useCallback(() => {
    // A load is on its way (PreviewFrame sent it): loading until the frame asked is settled.
    setMissing([]);
    playingRef.current = false;
    setPlaying(false);
    wait(frameRef.current);
  }, []);
  const onStop = useCallback((reason: string) => {
    playingRef.current = false;
    setPlaying(false);
    wait(null);
    setStopped(reason);
  }, []);
  const onConnection = useCallback((c: PreviewConnection | null) => {
    conn.current = c;
  }, []);

  // A new plan (a switch, the file changed) loads into the same frame (PreviewFrame sends it): loading until settled.
  // (A layout effect: no paint shows the new view as already settled.)
  const planSeen = useRef(urls?.plan);
  useLayoutEffect(() => {
    if (urls?.plan === planSeen.current) return;
    planSeen.current = urls?.plan;
    if (!conn.current?.connected) return;
    playingRef.current = false;
    setPlaying(false);
    wait(frameRef.current);
  }, [urls?.plan]);

  // Show in timeline (a step of the scenario screen): its first frame, once.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!step || shown.current === step) return;
    shown.current = step;
    const first = m.steps.filter((s) => s.key === step).sort((a, b) => a.from - b.from)[0];
    if (first) seek(first.from);
  }, [step, m.steps, seek]);

  // Preview change: the proposal's comment pin, once (where the change was asked).
  const pinned = useRef(false);
  useEffect(() => {
    if (!proposal || pinned.current) return;
    const pin = v.pins.placed.find((p) => p.id === proposal.comment_id);
    if (!pin) return;
    pinned.current = true;
    seek(pin.frame);
  }, [proposal, v.pins.placed, seek]);

  // Keys.
  const commentRef = useRef<string | null>(null);
  commentRef.current = commentOn ? commentOn.render_id : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // C: comment the frame at the playhead on the render of this version (when there is one).
      if (commentKey(e, keyTarget(e.target))) {
        if (commentRef.current === null) return;
        e.preventDefault();
        location.hash = hrefTo({ name: 'comments', slug, scenario: name, at: { render: commentRef.current, frame: frameRef.current } });
        return;
      }
      const a = keyAction(e, keyTarget(e.target));
      if (!a) return;
      e.preventDefault();
      if (a.kind === 'toggle') return toggle();
      const to = targetFrame(a, frameRef.current, m);
      seek(to);
      // [ / ]: the segment the playhead lands on is the inspector's.
      if (a.kind === 'segment') {
        const at = m.segments.filter((s) => landingOf(s) === to).at(-1);
        if (at) setSelected(at.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seek, m, slug, name]);

  // The zoomed level: the playhead stays on screen while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom !== 'zoom' || !playing) return;
    const lane = el.scrollWidth - LABEL_W;
    const x = LABEL_W + (frame / Math.max(1, m.frames)) * lane;
    if (x < el.scrollLeft + LABEL_W || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, x - LABEL_W - 40);
  }, [frame, zoom, playing, m.frames]);

  const onSelect = useCallback(
    (id: string, from: number) => {
      setSelected(id);
      seek(from);
    },
    [seek],
  );
  // A segment gone from the new version (renamed, deleted): nothing selected.
  const segment = m.segments.find((s) => s.id === selected) ?? null;

  const previewOn = urls !== null && playable === true && stopped === null;
  // Loading: the codec not asked yet, or the frame asked not settled.
  const loading = urls !== null && stopped === null && (playable === null || (previewOn && waiting !== null && !playing));
  const words = frameWords(frame, m, v.untrusted.steps);
  const width = zoom === 'fit' ? '100%' : `${zoomFactor(m.frames, m.fps) * 100}%`;
  const capture = v.capture;
  const duration = timecode(m.frames, m.fps);

  return (
    <div className="screen timeline-screen" data-testid="timeline" data-hash={v.hash ?? ''}>
      <Breadcrumb slug={slug} name={name} />
      <header className="screen-head">
        <h1>
          <Txt text={name} />
        </h1>
        <p className="muted tl-facts" data-testid="timeline-facts">
          Capture <Txt className="mono" text={v.run_id} /> · theme <Txt text={v.theme} /> · {duration} · {plural(m.frames, 'frame')} at {m.fps} fps · {m.width}×{m.height}
          {capture.codec && (
            <span data-testid="capture-codec">
              {' '}
              · {codecWords(capture.codec)}
              {capture.keyframe_interval_s !== undefined && `, keyframes ${capture.at_least ? 'at least ' : ''}every ${capture.keyframe_interval_s.toFixed(1)} s`}
              {capture.b_frames ? ', B-frames' : ''}
            </span>
          )}
        </p>
        <nav aria-label="Scenario views" className="tabs">
          <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'blocks' })} className="tab">
            Board
          </a>
          <a href={hrefTo({ name: 'scenario', slug, scenario: name, tab: 'yaml' })} className="tab">
            YAML
          </a>
          <a href={hrefTo({ name: 'timeline', slug, scenario: name })} aria-current="page" className="tab current">
            Timeline
          </a>
          <CommentsTab slug={slug} name={name} />
        </nav>
      </header>

      {proposal && <ProposalBanner slug={slug} name={name} proposal={proposal} shown={v.proposal?.shown} />}
      <div className="tl-top">
        {v.runs.length > 1 && !proposal && (
          <label className="tl-run-pick">
            <span className="label">Capture</span>
            <select data-testid="timeline-run-picker" value={v.run_id} onChange={(e) => (location.hash = hrefTo({ name: 'timeline', slug, scenario: name, run: e.target.value }))}>
              {v.runs.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="small" data-testid="timeline-source">
          {proposal ? (
            <>
              <Badge tone="warning">proposed edit</Badge> The edit Claude proposed, on the take its comment was made on — not written.
            </>
          ) : v.source.edit === 'scenario' ? (
            <>
              <Badge tone="info">today's edit</Badge> The edit of today's file on this take
              {v.source.edit_changes?.length ? (
                <>
                  {' '}
                  — changed since the take: <Txt text={v.source.edit_changes.join(', ')} />
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              <Badge tone="warning">as captured</Badge> The take as it was captured.
            </>
          )}
        </p>
        <RenderBar r={renders} target={renderTarget} shown={shownVersion} />
      </div>
      {v.editable !== true && !proposal && (
        <Notice tone={v.source.scenario_changed ? 'warning' : 'info'} role="note" title={notEditableTitle(v)}>
          <p className="pre-line" data-testid="timeline-not-editable">
            <Txt text={v.editable.why} />
          </p>
          {v.source.scenario_changed && (
            <p>
              <a href={hrefTo({ name: 'run', slug, scenario: name })}>Capture again from the Run screen</a>
            </p>
          )}
        </Notice>
      )}
      {held.length > 0 && (
        <Notice tone="warning" role="note" title={held.length === 1 ? 'A workspace component is not run in the preview' : `${held.length} workspace components are not run in the preview`}>
          <div data-testid="preview-held">
            <p className="small">
              Components of this workspace are code: the preview runs one only once you allow it, for this Studio session (until it stops, or the component changes). Its stand-in draws until then; a render uses it either way.
            </p>
            <ul className="held-list">
              {held.map((c) => (
                <li key={c.id} data-testid="held-component" data-id={c.id}>
                  <Txt className="mono" text={c.id} /> <span className="muted small">({c.kind}, folder {c.hash})</span>{' '}
                  <button type="button" className="button small" data-testid="allow-component" disabled={allowing !== null} onClick={() => allow(c)}>
                    {allowing === c.id ? 'Allowing…' : 'Allow in the preview'}
                  </button>
                </li>
              ))}
            </ul>
            {allowError && (
              <p className="pre-line small" role="alert" data-testid="allow-error">
                <Txt text={allowError} />
              </p>
            )}
          </div>
        </Notice>
      )}
      {capture.slow_scrub && (
        <Notice tone="info" role="note">
          <p data-testid="slow-scrub">
            <Txt text={capture.slow_scrub} />
          </p>
        </Notice>
      )}

      <div className="tl-stage">
        <section className="tl-preview-wrap" aria-label="Preview and transport">
          <div
            className="tl-preview"
            role="region"
            aria-label={`Preview, frame ${(frame + 1).toLocaleString('en')} of ${m.frames.toLocaleString('en')}`}
            aria-busy={loading || buffering}
            data-testid="preview"
            data-frame={frame}
            data-loading={loading ? 'yes' : 'no'}
            style={{ aspectRatio: `${m.width} / ${m.height}` }}
          >
            {previewOn && (
              <PreviewFrame key={`${urls.frame}#${restart}`} url={urls.frame} planUrl={urls.plan} frameRef={frameRef} onMessage={onMessage} onHello={onHello} onStop={onStop} onConnection={onConnection} />
            )}
            {loading && (
              <p className="tl-preview-note" role="status" data-testid="preview-loading">
                Loading the preview…
              </p>
            )}
            {!loading && buffering && playing && (
              <p className="tl-preview-note" role="status">
                Buffering…
              </p>
            )}
            {playable === false && (
              <p className="tl-preview-note is-message" role="status" data-testid="cannot-play">
                {cannotPlayWords(capture.codec)}
              </p>
            )}
            {'preview_error' in v && (
              <p className="tl-preview-note is-message" role="status" data-testid="preview-error">
                The preview cannot show this take: <Txt text={v.preview_error} />
              </p>
            )}
            {stopped !== null && (
              <div className="tl-preview-note is-message" role="alert" data-testid="preview-stopped">
                <p>
                  <Txt text={stopped} />.
                </p>
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    setStopped(null);
                    setRestart((n) => n + 1);
                  }}
                >
                  Restart the preview
                </button>
              </div>
            )}
          </div>

          <div className="tl-transport" role="group" aria-label="Transport">
            <button type="button" className="button primary small" data-testid="play" disabled={!previewOn} onClick={toggle} aria-pressed={playing}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="button small" aria-label="Previous frame" data-testid="prev-frame" onClick={() => seek(frameRef.current - 1)}>
              ◀︎ Frame
            </button>
            <button type="button" className="button small" aria-label="Next frame" data-testid="next-frame" onClick={() => seek(frameRef.current + 1)}>
              Frame ▶︎
            </button>
            <output className="tl-time mono" data-testid="timecode" aria-live="off">
              {timecode(frame, m.fps)} / {duration} · frame {frame.toLocaleString('en')}
            </output>
            <button
              type="button"
              className="button small"
              data-testid="mute"
              disabled={!previewOn}
              onClick={() => {
                wantSound.current = muted;
                conn.current?.send({ type: 'mute', muted: !muted });
              }}
            >
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <label className="tl-rate">
              <span className="label">Speed</span>
              <select
                value={rate}
                disabled={!previewOn}
                data-testid="rate"
                onChange={(e) => {
                  const r = Number(e.target.value) as 0.5 | 1 | 2;
                  setRate(r);
                  conn.current?.send({ type: 'rate', rate: r });
                }}
              >
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
              </select>
            </label>
            {commentOn ? (
              <a
                className="button small"
                data-testid="comment-here"
                data-render={commentOn.render_id}
                href={hrefTo({ name: 'comments', slug, scenario: name, at: { render: commentOn.render_id, frame } })}
                aria-label={`Comment frame ${frame.toLocaleString('en')} of render ${commentOn.render_id}`}
              >
                Comment
              </a>
            ) : (
              <>
                <button type="button" className="button small" disabled data-testid="comment-here-off" aria-describedby="comment-why">
                  Comment
                </button>
                <span id="comment-why" className="sr-only">
                  No render of this version yet: render it, or comment on an earlier render from Comments
                </span>
              </>
            )}
            <span className="tl-zoomer" role="group" aria-label="Zoom">
              <button type="button" className="button quiet small" aria-pressed={zoom === 'fit'} data-testid="zoom-fit" onClick={() => setZoom('fit')}>
                Fit
              </button>
              <button type="button" className="button quiet small" aria-pressed={zoom === 'zoom'} data-testid="zoom-in" onClick={() => setZoom('zoom')}>
                Zoom in
              </button>
            </span>
          </div>
          <p className="muted small tl-keys">
            Space plays or pauses · ← → one frame · Shift + ← → one second · Home / End · [ ] the previous / next segment · ⌘Z undoes a switch · C comments the frame
            {commentOn ? ` on ${commentOn.render_id}` : ' (no render of this version yet: render it, or comment an earlier render from Comments)'}
          </p>
        </section>
        <TimelineInspector v={v} segment={segment} ed={ed} />
      </div>

      <div className="tl-scroll" ref={scroller} data-testid="timeline-scroll" data-zoom={zoom}>
        <div className="tl-inner" style={{ width }}>
          <div className="tl-row tl-scrub-row">
            <span className="tl-label" aria-hidden="true">
              {timecode(frame, m.fps)}
            </span>
            <div className="tl-lane">
              <input
                type="range"
                className="tl-scrubber"
                data-testid="scrubber"
                min={0}
                max={last}
                step={1}
                value={frame}
                aria-label="Playhead"
                aria-valuetext={words}
                onChange={(e) => seek(Number(e.target.value))}
              />
            </div>
          </div>
          <Tracks view={v as TimelineView} onSeek={seek} selected={selected} onSelect={onSelect} at={tracksAt} />
          <div className="tl-overlay" aria-hidden="true">
            <div className="tl-playhead" data-testid="playhead" style={{ left: `${(frame / Math.max(1, m.frames)) * 100}%` }} />
          </div>
        </div>
      </div>
      <section className="card tl-renders" aria-labelledby="tl-renders-h">
        <h2 id="tl-renders-h" className="card-title">
          Renders
        </h2>
        <RendersPanel r={renders} slug={slug} shown={shownVersion} onSeek={seek} fps={m.fps} />
      </section>
      {v.pins.elsewhere.length > 0 && (
        <section className="card tl-elsewhere" aria-labelledby="elsewhere-h" data-testid="pins-elsewhere">
          <h2 id="elsewhere-h" className="card-title">
            Comments made on another take ({v.pins.elsewhere.length})
          </h2>
          <ul>
            {v.pins.elsewhere.map((id) => (
              <li key={id}>
                <a href={hrefTo({ name: 'comments', slug, scenario: name, thread: id })} data-testid="pin-elsewhere">
                  <Txt text={v.untrusted.threads[id]?.text ?? id} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Notes v={v} missing={missing} notes={notes} />
    </div>
  );
}

/** The title of the "no switches" notice: what keeps the switches off, in words that fit the case. */
function notEditableTitle(v: Ready): string {
  if (v.source.scenario_changed) return 'The filmed part changed since this take';
  if (v.hash === undefined) return 'There is no scenario file to switch';
  if (v.source.edit === 'run') return 'Switches are off for this take';
  return 'Switches are off for this file';
}

/** The width of the tracks' label column (px): the playhead and the follow scroll offset by it. */
const LABEL_W = 112;

function Notes({ v, missing, notes }: { v: Ready; missing: string[]; notes: Array<{ type: 'warning' | 'error'; message: string }> }) {
  const plan = [...v.untrusted.warnings.map((w) => ({ type: 'warning' as const, message: w })), ...v.untrusted.notes.map((n) => ({ type: 'note' as const, message: n }))];
  if (missing.length === 0 && notes.length === 0 && plan.length === 0) return null;
  return (
    <section className="card tl-notes" aria-labelledby="tl-notes-h" data-testid="timeline-notes">
      <h2 id="tl-notes-h" className="card-title">
        Warnings and notes
      </h2>
      {missing.length > 0 && (
        <p data-testid="preview-missing">
          Not in the preview (their stand-ins draw): <Txt text={missing.join(', ')} />
        </p>
      )}
      {notes.length > 0 && (
        <>
          <p className="small muted">From the preview — text a component may have written:</p>
          <ul data-testid="preview-notes">
            {notes.map((n, i) => (
              <li key={i}>
                <Badge tone={n.type === 'error' ? 'danger' : 'warning'}>{n.type}</Badge> <Txt text={n.message} />
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.length > 0 && (
        <details>
          <summary>The edit's warnings and notes ({plan.length})</summary>
          <ul data-testid="plan-notes">
            {plan.map((n, i) => (
              <li key={i}>
                <Badge tone={n.type === 'warning' ? 'warning' : 'neutral'}>{n.type}</Badge> <Txt text={n.message} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
