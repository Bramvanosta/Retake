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
 * - L5.12a « Épure » 4a (R4-Edit, R-UI-45): Edit in the shell — no breadcrumb, heading or tabs (the title bar names the
 *   project and scenario, the modes go to the other views; the h1 stays for assistive technology), the browser pane
 *   hidden; the stage (EditPreview.tsx: the preview region, the transport, the take's facts) above the tracks
 *   (TimelineTracks.tsx on the kit, a scrubber with time labels, the playhead over the lanes), the inspector in the
 *   shell's pane (TimelineInspector.tsx), the notes (EditNotes.tsx), and the status bar (EditStatus.tsx: what is on
 *   screen, the render line with Cancel, Undo · Redo, Render — Edit owns ⌘B at the screen's priority, H2). The renders'
 *   list and reviews moved to the Review report; its "Show in Edit" hands a finding over (edit-handoff.ts) and Edit seeks
 *   to its frame only when that render shows this version. This file keeps the one PreviewFrame and its checked URL
 *   (the source lint pins them here), the state, the keys and the seek loop.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TimelineView } from '@retake/engine';
import type { TimelineViewAnswer } from '../../server/ops.js';
import type { PreviewConnection } from '../../player/parent.js';
import type { FrameMessage } from '../../player/protocol.js';
import { errorText } from '../api.js';
import { previewAllow, timelineLeave, useTimelineView } from '../data/edit.js';
import { Txt } from '../bits.js';
import { commentsEventAction, useEvents, useScenarioEvents } from '../events.js';
import { commentKey } from '../words/comment-words.js';
import { takeEditSeek } from './edit-handoff.js';
import type { EditSeek } from './edit-handoff.js';
import { EditNotes, EditNotices } from './EditNotes.js';
import type { FrameNote } from './EditNotes.js';
import { EditPreview } from './EditPreview.js';
import { EditStatus, renderOff } from './EditStatus.js';
import { PreviewFrame } from './PreviewFrame.js';
import { ProposalBanner } from '../review/ProposalBanner.js';
import { RenderOutcome, useRenders, useReportEntry } from '../review/Renders.js';
import { useShownFile } from '../shoot/shoot-data.js';
import { PROPOSAL_RENDER, versionNote, versionWords } from '../words/render-words.js';
import type { RenderTarget } from '../review/Renders.js';
import { hrefTo } from '../route.js';
import { PRIORITY, usePaletteGroup, useShellCommand } from '../shell/command-bus.js';
import { say } from '../shell/say.js';
import { BrowserCollapsed, ShellSlot } from '../shell/slots.js';
import { Callout, EmptyState, LinkButton, Playhead, Scrubber, Select, TerminalCommands as Commands, studioShell } from '../ui-kit/index.js';
import { TimelineInspector, useSwitchEditor } from './TimelineInspector.js';
import { Tracks } from './TimelineTracks.js';
import { canPlay, cannotPlayWords, frameWords, keyAction, landingOf, previewUrls, segmentWords, targetFrame, timecode, zoomFactor } from '../words/timeline-words.js';
import type { CodecProbe, KeyTarget } from '../words/timeline-words.js';

type Ready = Extract<TimelineViewAnswer, { run_id: string; model: unknown }>;
/** Frame notes kept (warnings and errors the frame posted). */
const NOTES_MAX = 20;

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
      void timelineLeave({ project: slug, lease }).catch(() => undefined);
    },
    [slug, lease],
  );
  const pc = proposal?.comment_id;
  const pe = proposal?.entry_id;
  const args = useMemo(
    () => ({ project: slug, name, lease, ...(run ? { run } : {}), ...(pc !== undefined && pe !== undefined ? { proposal: { comment_id: pc, entry_id: pe } } : {}) }),
    [slug, name, run, lease, pc, pe],
  );
  const [loaded, reload] = useTimelineView(args, `${slug}\0${name}\0${run ?? ''}\0${pc ?? ''}\0${pe ?? ''}`);
  useScenarioEvents(slug, name, { reread: reload, progress: () => undefined });
  // L4.6: this scenario's threads changed (a comment posted, resolved): the pins are read again.
  useEvents((e) => {
    if (e.type !== 'resync' && commentsEventAction(e, slug, name).threads) reload();
  });

  // L5.12a fixes (review A-M1): on a proposal's preview Render is refused in every state — before the view is read, on an
  // error, on a blocked take — at the screen's priority (the status bar's own refuses too); once the view is read, the
  // take's screen (Timeline below) owns it.
  const shows = loaded.state === 'ready' && !('blocked' in loaded.data);
  useShellCommand('render', () => say(`Render of ${name}: ${PROPOSAL_RENDER}`), PRIORITY.screen, proposal !== undefined && !shows);
  // (review A-L6): an Edit that cannot show the take drops the report's pending Show in Edit (never a stale seek later).
  const cannot = loaded.state === 'error' || (loaded.state === 'ready' && 'blocked' in loaded.data);
  useEffect(() => {
    if (cannot) takeEditSeek(slug, name);
  }, [cannot, slug, name]);

  if (loaded.state === 'loading') {
    return (
      <div className="ed-screen is-plain">
        <BrowserCollapsed />
        <EditHeading name={name} />
        <p className="ed-quiet" role="status">
          Loading the timeline…
        </p>
      </div>
    );
  }
  if (loaded.state === 'error') {
    return (
      <div className="ed-screen is-plain">
        <BrowserCollapsed />
        <EditHeading name={name} />
        <Callout state={loaded.code === 'not_found' ? 'idle' : 'fail'} role="alert" title={loaded.code === 'not_found' ? 'No capture to show' : 'This timeline cannot be opened'}>
          <p className="ed-pre" data-testid="timeline-error">
            <Txt text={loaded.error} />
          </p>
          <p>
            <LinkButton size="sm" variant="ghost" to={{ name: 'scenario', slug, scenario: name, tab: 'blocks' }}>
              Back to the scenario
            </LinkButton>
            {': a capture there films the take this screen shows.'}
          </p>
          {proposal && (
            <p>
              <LinkButton size="sm" variant="ghost" to={{ name: 'comments', slug, scenario: name, thread: proposal.comment_id }} testId="banner-back">
                Back to the comment
              </LinkButton>
              {': a proposal is previewed while it is the thread\'s newest, not yet applied, and the scenario is still the file it was proposed on.'}
            </p>
          )}
        </Callout>
      </div>
    );
  }
  const d = loaded.data;
  if ('blocked' in d) {
    return (
      <div className="ed-screen is-plain">
        <BrowserCollapsed />
        <EditHeading name={name} />
        <EmptyState title="The Studio does not preview this take">
          <div data-testid="timeline-blocked">
            {d.blocked.problems.map((p, i) => (
              <p key={i} className="ed-pre">
                <Txt text={p} />
              </p>
            ))}
            <Commands {...(d.blocked.command ? { fix: d.blocked.command } : {})} />
          </div>
        </EmptyState>
      </div>
    );
  }
  return <Timeline key={d.run_id} slug={slug} name={name} v={d as Ready} step={step} reload={reload} {...(proposal ? { proposal } : {})} />;
}

/** The screen's h1 for assistive technology (the title bar names the scenario): the name as text (review A-M3). */
function EditHeading({ name }: { name: string }) {
  return (
    <h1 className="k-sr">
      <Txt text={name} />
      {' — Edit'}
    </h1>
  );
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
  const [notes, setNotes] = useState<FrameNote[]>([]);
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
  // The scenario's renders (a Render refused because the file changed reads the view again).
  const renders = useRenders(slug, name, reload);
  // L5.11a (critique L6): the status bar's Render (⌘B) renders the capture and the file this screen shows.
  useShownFile(slug, name, proposal ? null : (v.hash ?? null), v.run_id);
  const shownVersion = useMemo(
    () => ({ run: v.run_id, theme: v.theme, plan_sha256: v.plan_sha256, theme_sha256: v.theme_sha256, ...(v.hash ? { hash: v.hash } : {}) }),
    [v.run_id, v.theme, v.hash, v.plan_sha256, v.theme_sha256],
  );
  // Workspace components the take uses that the preview does not run yet (review A H1 c), and the Allow clicks.
  const [allowing, setAllowing] = useState<string | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  const allow = (c: { id: string; hash: string }) => {
    setAllowing(c.id);
    setAllowError(null);
    previewAllow({ id: c.id, hash: c.hash })
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
    ? { why: PROPOSAL_RENDER }
    : v.hash === undefined
      ? { why: `scenarios/${name}.yaml is not there: nothing to render` }
      : { run: v.run_id, hash: v.hash, asCaptured: v.source.edit === 'run' };
  // H2: Edit owns Render (⌘B, the palette) at the screen's priority — the capture and the file as shown, through
  // useRenders (its refusals, its `mine`); on a proposal it says why and renders nothing.
  const renderNow = () => {
    const off = renderOff(renders, renderTarget);
    if (off !== null || 'why' in renderTarget) return say(`Render of ${name}: ${off ?? 'not ready'}`);
    if (renders.sending) return;
    renders.render(renderTarget);
  };
  useShellCommand('render', renderNow, PRIORITY.screen);
  const inApp = useMemo(() => studioShell() !== null, []);

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

  // L5.12a: the Review report's Show in Edit — the finding's frame only when its render shows this version (the same plan
  // and theme files: its frame f is the preview's frame f); else its step. L5.12a fixes (review B-M1): the note "made from
  // another version" only when the render is found AND differs — a finding with no frame on this version (the video's
  // length) goes to its step or stays, saying nothing; a render no longer listed goes to the step, no frame trusted.
  const [handoff] = useState<EditSeek | null>(() => (proposal ? null : takeEditSeek(slug, name)));
  const handled = useRef(false);
  const [seekNote, setSeekNote] = useState<string | null>(null);
  useEffect(() => {
    if (!handoff || handled.current || renders.loaded.state !== 'ready') return;
    handled.current = true;
    const r = renders.loaded.data.renders.find((x) => x.render_id === handoff.render_id);
    const differs = r !== undefined && !versionNote(r, shownVersion).same;
    if (r && !differs && handoff.frame !== undefined) {
      seek(handoff.frame);
      return;
    }
    const first = handoff.step ? m.steps.filter((s) => s.key === handoff.step).sort((a, b) => a.from - b.from)[0] : undefined;
    if (first) seek(first.from);
    if (differs) setSeekNote(`${versionWords(handoff.render_id)} was made from another version of the edit: its frame is not this preview's${first ? ', so the preview shows the step it points at' : ''}.`);
  }, [handoff, renders.loaded, shownVersion, m.steps, seek]);

  // Keys.
  const commentRef = useRef<string | null>(null);
  commentRef.current = commentOn ? commentOn.render_id : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A control handled the key (the transport's toolbar roves with the arrows, Home and End): its own.
      if (e.defaultPrevented) return;
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

  // The zoomed level: the playhead stays on screen while playing (an instant scroll).
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom !== 'zoom' || !playing) return;
    const labelW = el.querySelector<HTMLElement>('.k-track-label')?.offsetWidth ?? 96;
    const lane = el.scrollWidth - labelW;
    const x = labelW + (frame / Math.max(1, m.frames)) * lane;
    if (x < el.scrollLeft + labelW || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, x - labelW - 40);
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
  // L5.12b: ⌘K's Scenes (a pick selects the segment and seeks to it), its Themes (the theme the take is edited with:
  // the theme editor — the palette never sets one) and the Review report with the last render's words.
  usePaletteGroup(
    'scenes',
    m.segments.map((s) => ({ id: `segment-${s.id}`, label: s.kind === 'clip' ? `Scene ${s.id}` : segmentWords(s), hint: timecode(landingOf(s), m.fps), icon: 'scene' as const, run: () => onSelect(s.id, landingOf(s)) })),
  );
  usePaletteGroup('themes', [{ id: v.theme, label: v.theme, hint: 'set for this scenario', icon: 'theme', run: () => (location.hash = hrefTo({ name: 'themes', slug, theme: v.theme })) }]);
  useReportEntry(slug, name, renders);
  const stepsOf = useCallback((id: string) => new Set(m.steps.filter((s) => s.scene === id && s.step >= 0).map((s) => s.key)).size, [m.steps]);

  const previewOn = urls !== null && playable === true && stopped === null;
  // Loading: the codec not asked yet, or the frame asked not settled.
  const loading = urls !== null && stopped === null && (playable === null || (previewOn && waiting !== null && !playing));
  const words = frameWords(frame, m, v.untrusted.steps);
  const factor = zoom === 'fit' ? 1 : zoomFactor(m.frames, m.fps);
  const width = zoom === 'fit' ? '100%' : `${factor * 100}%`;
  const marks = useMemo(() => timeMarks(m.frames, m.fps, factor), [m.frames, m.fps, factor]);

  return (
    <div className="ed-screen" data-testid="timeline" data-hash={v.hash ?? ''}>
      <BrowserCollapsed />
      <EditHeading name={name} />
      {v.runs.length > 1 && !proposal && (
        <ShellSlot name="context">
          <Select
            layout="inline"
            label="Take"
            testId="timeline-run-picker"
            value={v.run_id}
            options={v.runs.map((r) => ({ value: r, label: r }))}
            onChange={(r) => (location.hash = hrefTo({ name: 'timeline', slug, scenario: name, run: r }))}
          />
        </ShellSlot>
      )}
      <ShellSlot name="inspector" inline="Inspector">
        <TimelineInspector v={v} segment={segment} ed={ed} fps={m.fps} stepsOf={stepsOf} />
      </ShellSlot>
      <ShellSlot name="actions">
        <EditStatus slug={slug} name={name} source={{ proposal: proposal !== undefined, edit: v.source.edit, run: v.run_id, ...(v.source.edit_changes ? { changes: v.source.edit_changes } : {}) }} r={renders} target={renderTarget} shown={shownVersion} ed={ed} inApp={inApp} />
      </ShellSlot>
      <div className="ed-top">
        {proposal && <ProposalBanner slug={slug} name={name} proposal={proposal} shown={v.proposal?.shown} />}
        <RenderOutcome r={renders} />
        {seekNote && (
          <Callout state="idle" role="status" title="Note: made from another version" testId="edit-seek-note">
            <Txt text={seekNote} />
          </Callout>
        )}
        <EditNotices v={v} slug={slug} name={name} proposal={proposal !== undefined} allowing={allowing} allowError={allowError} onAllow={allow} />
      </div>
      <EditPreview
        slug={slug}
        name={name}
        m={m}
        run={v.run_id}
        theme={v.theme}
        capture={v.capture}
        frame={frame}
        words={words}
        previewOn={previewOn}
        loading={loading}
        buffering={buffering}
        playing={playing}
        playable={playable}
        cannotPlay={cannotPlayWords(v.capture.codec)}
        {...('preview_error' in v ? { previewError: v.preview_error } : {})}
        stopped={stopped}
        onRestart={() => {
          setStopped(null);
          setRestart((n) => n + 1);
        }}
        muted={muted}
        onMute={() => {
          wantSound.current = muted;
          conn.current?.send({ type: 'mute', muted: !muted });
        }}
        rate={rate}
        onRate={(r) => {
          setRate(r);
          conn.current?.send({ type: 'rate', rate: r });
        }}
        onToggle={toggle}
        onStep={(by) => seek(frameRef.current + by)}
        commentOn={commentOn ? commentOn.render_id : null}
        zoom={zoom}
        onZoom={setZoom}
      >
        {previewOn && <PreviewFrame key={`${urls.frame}#${restart}`} url={urls.frame} planUrl={urls.plan} frameRef={frameRef} onMessage={onMessage} onHello={onHello} onStop={onStop} onConnection={onConnection} />}
      </EditPreview>
      <section className="ed-tracks" aria-label="Tracks">
        <div className="ed-scroll" ref={scroller} data-testid="timeline-scroll" data-zoom={zoom}>
          <div className="ed-inner" style={{ width }}>
            <Scrubber testId="scrubber" time={timecode(frame, m.fps)} max={last} value={frame} valueText={words} onChange={seek} marks={marks} />
            <Tracks view={v as TimelineView} onSeek={seek} selected={selected} onSelect={onSelect} at={tracksAt} />
            <Playhead testId="playhead" at={frame / Math.max(1, m.frames)} />
          </div>
        </div>
        <p className="ed-keys">
          Space plays or pauses · ← → one frame · Shift + ← → one second · Home / End · [ ] the previous / next segment · ⌘Z undoes a switch · C comments the frame
          <Txt text={commentOn ? ` on ${commentOn.render_id}` : ' (no render of this version yet: render it, or comment an earlier render from Comments)'} />
        </p>
      </section>
      <EditNotes v={v} slug={slug} name={name} missing={missing} notes={notes} />
    </div>
  );
}

/** Time labels under the scrubber: about a dozen across what is on screen, on a round step (1 s … 5 min). */
function timeMarks(frames: number, fps: number, factor: number): Array<{ at: number; label: string }> {
  const seconds = frames / Math.max(1, fps);
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => seconds / s <= 12 * factor) ?? 600;
  const out: Array<{ at: number; label: string }> = [];
  for (let t = 0; t <= seconds && out.length < 400; t += step) {
    const m = Math.floor(t / 60);
    out.push({ at: t / seconds, label: `${m}:${String(Math.floor(t - m * 60)).padStart(2, '0')}` });
  }
  return out;
}
