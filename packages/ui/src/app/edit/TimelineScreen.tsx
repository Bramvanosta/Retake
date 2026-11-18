/**
 * The timeline screen (R-UI-15 "Open timeline", R-UI-24, R-UI-25; DESIGN §4g): one capture of a scenario
 * as the edit plans it — the preview (the Remotion Player in the sandboxed frame of the player origin: PreviewFrame),
 * the transport, the scrubber and the tracks (TimelineTracks), with the take's warnings and notes.
 *
 * - One read, `timeline_view` (the engine's path-free view and the preview's capability URLs), again when this
 *   scenario's file or runs change and after a reconnection; the engine's memo makes a re-read of an unchanged take
 *   free, and a new plan URL loads into the same frame (no reload).
 * - The preview starts muted (the frame's first `state` says so; "Unmute" asks it), shows "Loading the preview…" until
 *   the frame is `settled` at the frame asked, seeks exactly when paused (a seek pauses), and a scrub
 *   sends at most one seek per animation frame. A browser that cannot play the capture's codec (Playwright's Chromium
 *   and H.264) gets the message only — the tracks and the scrubber still work. A stopped preview (a
 *   flood, an invalid message: parent.ts) says why and can be restarted.
 * - Keys (timeline-words keyAction): Space, ← / →, Shift+← / →, Home / End, [ / ] — never while typing or in a radio
 *   group, and not doubling the scrubber's own arrows. Zoom: fit, or about ten seconds per screen with scroll; the
 *   playhead follows while playing.
 * - The inspector (TimelineInspector.tsx) beside the preview: a segment is selected by a click on the segments
 *   track or by [ / ] (the segment the playhead lands on); the video's and that segment's switches write in one click,
 *   the view is read again and its new plan loads into the same frame — "Loading the preview…" until it is settled at
 *   the playhead, which stays where it was. Undo / redo restore the exact bytes. Every string from the server is a text
 *   node.
 * - Render (Renders.tsx): the header's Render bar renders the capture shown on the version shown (a file changed
 *   since is refused and the view read again) and says what the newest render is doing; the Renders card under the
 *   tracks holds the queue (Cancel), the renders with their review's verdict, and a render's review — its findings seek
 *   the preview only when the render is of the version shown (the same plan signature and theme files), its images.
 * - Comment (key C) opens the Comments screen at the playhead's frame of the newest render of the version shown
 *   (its frame f is the preview's frame f); a pin's tooltip and the other-take card open the thread; the pins are read
 *   again when the scenario's threads change.
 * - Preview change (`#/p/<slug>/s/<name>/proposal/<comment>/<entry>`) shows the take planned from the
 *   text Claude proposed on a thread (`timeline_view {proposal}`: in memory, nothing written, switches and Render off),
 *   under a banner (ProposalBanner: which comment, whether the plan shows the change, Back to the comment — the thread,
 *   scrolled to its proposal: Apply is offered only there, under the whole diff) and seeks to that comment's pin.
 * - The page holds a lease on its project's preview capability (timeline_view `lease`) and gives it
 *   back when it leaves (`timeline_leave`): the project's preview URLs are revoked once no page holds one. A workspace
 *   component the take uses is not run in the preview until the person allows it here (`preview_allow`, by id and
 *   folder hash, for this Studio session): its stand-in draws, a notice names it with an Allow button.
 * - (R-UI-45) Edit in the shell — no breadcrumb, heading or tabs (the title bar names the
 *   project and scenario, the modes go to the other views; the h1 stays for assistive technology), the browser pane
 *   hidden; the stage (EditPreview.tsx: the preview region, the transport, the take's facts) above the tracks
 *   (TimelineTracks.tsx on the kit, a scrubber with time labels, the playhead over the lanes), the inspector in the
 *   shell's pane (TimelineInspector.tsx), the notes (EditNotes.tsx), and the status bar (EditStatus.tsx: what is on
 *   screen, the render line with Cancel, Undo · Redo, Render — Edit owns ⌘B at the screen's priority). The renders'
 *   list and reviews are the Review report's; its "Show in Edit" hands a finding over (edit-handoff.ts) and Edit seeks
 *   to its frame only when that render shows this version. This file keeps the one PreviewFrame and its checked URL
 *   (the source lint pins them here) and the palette's groups; the preview's state and the seek loop are
 *   timeline-preview.ts', the arrival seeks and the keys timeline-navigation.ts', the slots, the notices and the
 *   tracks' section timeline-sections.tsx'.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorText } from '../api.js';
import { previewAllow, timelineLeave, useTimelineView } from '../data/edit.js';
import { Txt } from '../bits.js';
import { commentsEventAction, useEvents, useScenarioEvents } from '../events.js';
import { takeEditSeek } from './edit-handoff.js';
import { EditNotes } from './EditNotes.js';
import { EditPreview } from './EditPreview.js';
import { renderOff } from './EditStatus.js';
import { PreviewFrame } from './PreviewFrame.js';
import { useRenders, useReportEntry } from '../review/Renders.js';
import { useShownFile } from '../shoot/shoot-data.js';
import { PROPOSAL_RENDER, versionNote } from '../words/render-words.js';
import type { RenderTarget } from '../review/Renders.js';
import { hrefTo } from '../route.js';
import { PRIORITY, usePaletteGroup, useShellCommand } from '../shell/command-bus.js';
import { say } from '../shell/say.js';
import { BrowserCollapsed } from '../shell/slots.js';
import { Callout, EmptyState, LinkButton, TerminalCommands as Commands, studioShell } from '../ui-kit/index.js';
import { useSwitchEditor } from './TimelineInspector.js';
import { cannotPlayWords, frameWords, landingOf, previewUrls, segmentWords, timecode, zoomFactor } from '../words/timeline-words.js';
import { bestEffort } from '../best-effort.js';
import { usePlayback, useFrameHandlers, usePreviewState } from './timeline-preview.js';
import type { PreviewedProposal, PreviewState, Ready } from './timeline-preview.js';
import { useArrivalSeek, useFollowPlayhead, useTimelineKeys } from './timeline-navigation.js';
import { EditTop, TimelineSlots, TrackSection, timeMarks } from './timeline-sections.js';

export type { PreviewedProposal } from './timeline-preview.js';

/** A random lease id (22 base64url characters) for timeline_view / timeline_leave. */
function newLease(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function TimelineScreen({ slug, name, run, step, proposal }: { slug: string; name: string; run?: string; step?: string; proposal?: PreviewedProposal }) {
  // The page's lease on its project's preview URLs: given back when it leaves the project or the screen.
  const [lease] = useState(newLease);
  useEffect(
    () => () => {
      void bestEffort(timelineLeave({ project: slug, lease }), 'the lease expires by itself when the leave is not heard');
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
  // This scenario's threads changed (a comment posted, resolved): the pins are read again.
  useEvents((e) => {
    if (e.type !== 'resync' && commentsEventAction(e, slug, name).threads) reload();
  });

  // On a proposal's preview Render is refused in every state — before the view is read, on an
  // error, on a blocked take — at the screen's priority (the status bar's own refuses too); once the view is read, the
  // take's screen (Timeline below) owns it.
  const shows = loaded.state === 'ready' && !('blocked' in loaded.data);
  useShellCommand('render', () => say(`Render of ${name}: ${PROPOSAL_RENDER}`), PRIORITY.screen, proposal !== undefined && !shows);
  // An Edit that cannot show the take drops the report's pending Show in Edit (never a stale seek later).
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
              {": a proposal is previewed while it is the thread's newest, not yet applied, and the scenario is still the file it was proposed on."}
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
              // biome-ignore lint/suspicious/noArrayIndexKey: the take's problems, replaced whole on each read, text only: the index is the identity
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

/** The screen's h1 for assistive technology (the title bar names the scenario): the name as text. */
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

  const p = usePreviewState();
  const { frame, frameRef, playing, missing, notes, setRestart, zoom, scroller } = p;
  /** The segment the inspector shows (its id), or null. */
  const [selected, setSelected] = useState<string | null>(null);
  const ed = useSwitchEditor(slug, name, v, reload);
  // The scenario's renders (a Render refused because the file changed reads the view again).
  const renders = useRenders(slug, name, reload);
  // The status bar's Render (⌘B) renders the capture and the file this screen shows.
  useShownFile(slug, name, proposal ? null : (v.hash ?? null), v.run_id);
  const shownVersion = useShownVersion(v);
  const { allowing, allowError, allow } = useAllow(slug, setRestart, reload);
  // Comment at the playhead — a render of the version shown (the same plan and theme files: its frame f is the
  // preview's frame f), the newest; without one the button is off, with why.
  const commentOn = renders.loaded.state === 'ready' ? renders.loaded.data.renders.find((x) => x.status === 'succeeded' && versionNote(x, shownVersion).same) : undefined;
  const tracksAt = useMemo(() => ({ slug, scenario: name }), [slug, name]);
  const renderTarget = renderTargetOf(v, name, proposal);
  useRenderCommand(name, renders, renderTarget);
  const inApp = useMemo(() => studioShell() !== null, []);

  const { wait, show, seek, toggle } = usePlayback(p, v, last);
  const handlers = useFrameHandlers(p, wait, show, urls?.plan);
  const seekNote = useArrivalSeek({ slug, name, v, step, proposal, renders, shownVersion, seek });
  useTimelineKeys({ slug, name, m, commentOn: commentOn ? commentOn.render_id : null, frameRef, toggle, seek, setSelected });
  useFollowPlayhead(scroller, zoom, playing, frame, m.frames);

  const onSelect = useCallback(
    (id: string, from: number) => {
      setSelected(id);
      seek(from);
    },
    [seek],
  );
  // A segment gone from the new version (renamed, deleted): nothing selected.
  const segment = m.segments.find((s) => s.id === selected) ?? null;
  // ⌘K's Scenes (a pick selects the segment and seeks to it), its Themes (the theme the take is edited with:
  // the theme editor — the palette never sets one) and the Review report with the last render's words.
  usePaletteGroup(
    'scenes',
    m.segments.map((s) => ({
      id: `segment-${s.id}`,
      label: s.kind === 'clip' ? `Scene ${s.id}` : segmentWords(s),
      hint: timecode(landingOf(s), m.fps),
      icon: 'scene' as const,
      run: () => onSelect(s.id, landingOf(s)),
    })),
  );
  usePaletteGroup('themes', [{ id: v.theme, label: v.theme, hint: 'set for this scenario', icon: 'theme', run: () => (location.hash = hrefTo({ name: 'themes', slug, theme: v.theme })) }]);
  useReportEntry(slug, name, renders);
  const stepsOf = useCallback((id: string) => new Set(m.steps.filter((s) => s.scene === id && s.step >= 0).map((s) => s.key)).size, [m.steps]);

  const words = frameWords(frame, m, v.untrusted.steps);
  const factor = zoom === 'fit' ? 1 : zoomFactor(m.frames, m.fps);
  const marks = useMemo(() => timeMarks(m.frames, m.fps, factor), [m.frames, m.fps, factor]);

  return (
    <div className="ed-screen" data-testid="timeline" data-hash={v.hash ?? ''}>
      <BrowserCollapsed />
      <EditHeading name={name} />
      <TimelineSlots
        slug={slug}
        name={name}
        v={v}
        proposal={proposal}
        segment={segment}
        ed={ed}
        stepsOf={stepsOf}
        renders={renders}
        renderTarget={renderTarget}
        shownVersion={shownVersion}
        inApp={inApp}
      />
      <EditTop slug={slug} name={name} v={v} proposal={proposal} renders={renders} seekNote={seekNote} allowing={allowing} allowError={allowError} onAllow={allow} />
      <TimelineStage slug={slug} name={name} v={v} p={p} preview={urls} handlers={handlers} words={words} onToggle={toggle} onSeek={seek} commentOn={commentOn ? commentOn.render_id : null} />
      <TrackSection
        v={v}
        p={p}
        factor={factor}
        last={last}
        words={words}
        marks={marks}
        onSeek={seek}
        selected={selected}
        onSelect={onSelect}
        at={tracksAt}
        commentOn={commentOn ? commentOn.render_id : null}
      />
      <EditNotes v={v} slug={slug} name={name} missing={missing} notes={notes} />
    </div>
  );
}

/** The version shown: the capture, the theme and the plan and theme files (and the scenario's hash). */
function useShownVersion(v: Ready) {
  return useMemo(
    () => ({ run: v.run_id, theme: v.theme, plan_sha256: v.plan_sha256, theme_sha256: v.theme_sha256, ...(v.hash ? { hash: v.hash } : {}) }),
    [v.run_id, v.theme, v.hash, v.plan_sha256, v.theme_sha256],
  );
}

/** Own components (the workspace's, the project's) the take uses that the preview does not run yet, and the Allow clicks. */
function useAllow(slug: string, setRestart: PreviewState['setRestart'], reload: () => void) {
  const [allowing, setAllowing] = useState<string | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  const allow = (c: { id: string; hash: string }) => {
    setAllowing(c.id);
    setAllowError(null);
    previewAllow({ id: c.id, hash: c.hash, project: slug })
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
  return { allowing, allowError, allow };
}

/** Edit owns Render (⌘B, the palette) at the screen's priority. */
function useRenderCommand(name: string, renders: ReturnType<typeof useRenders>, renderTarget: RenderTarget) {
  // H2: Edit owns Render (⌘B, the palette) at the screen's priority — the capture and the file as shown, through
  // useRenders (its refusals, its `mine`); on a proposal it says why and renders nothing.
  const renderNow = () => {
    const off = renderOff(renders, renderTarget);
    if (off !== null || 'why' in renderTarget) return say(`Render of ${name}: ${off ?? 'not ready'}`);
    if (renders.sending) return;
    renders.render(renderTarget);
  };
  useShellCommand('render', renderNow, PRIORITY.screen);
}

/** What Render renders from this screen: the capture and the file shown, or why not. */
function renderTargetOf(v: Ready, name: string, proposal: PreviewedProposal | undefined): RenderTarget {
  return proposal
    ? { why: PROPOSAL_RENDER }
    : v.hash === undefined
      ? { why: `scenarios/${name}.yaml is not there: nothing to render` }
      : { run: v.run_id, hash: v.hash, asCaptured: v.source.edit === 'run' };
}

/** The stage: the preview region (the one PreviewFrame, on the URL previewUrls checked), the transport and the take's facts. */
function TimelineStage({
  slug,
  name,
  v,
  p,
  preview: urls,
  handlers,
  words,
  onToggle,
  onSeek,
  commentOn,
}: {
  slug: string;
  name: string;
  v: Ready;
  p: PreviewState;
  preview: ReturnType<typeof previewUrls>;
  handlers: ReturnType<typeof useFrameHandlers>;
  words: string;
  onToggle: () => void;
  onSeek: (to: number) => void;
  commentOn: string | null;
}) {
  const { frame, frameRef, waiting, playing, muted, buffering, rate, setRate, stopped, setStopped, restart, setRestart, zoom, setZoom, playable, conn, wantSound } = p;
  const { onMessage, onHello, onStop, onConnection } = handlers;
  const previewOn = urls !== null && playable === true && stopped === null;
  // Loading: the codec not asked yet, or the frame asked not settled.
  const loading = urls !== null && stopped === null && (playable === null || (previewOn && waiting !== null && !playing));
  return (
    <EditPreview
      slug={slug}
      name={name}
      m={v.model}
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
      onToggle={onToggle}
      onStep={(by) => onSeek(frameRef.current + by)}
      commentOn={commentOn}
      zoom={zoom}
      onZoom={setZoom}
    >
      {previewOn && (
        <PreviewFrame key={`${urls.frame}#${restart}`} url={urls.frame} planUrl={urls.plan} frameRef={frameRef} onMessage={onMessage} onHello={onHello} onStop={onStop} onConnection={onConnection} />
      )}
    </EditPreview>
  );
}
