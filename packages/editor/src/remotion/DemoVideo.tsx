/**
 * DemoVideo / DemoVertical: render an EditPlan and nothing else (DESIGN-phase2 §2.2). The theme background, one
 * Sequence per segment with its transition component (every fade is one: R-CMP-01), the segment component with its
 * slots/params; for clips the layout component with `screen` = the capture (one source frame per output frame, under
 * the camera transform), the caption component with the clip's cues in the layout's caption area, the overlays placed
 * from their source anchor through layout + camera, and the brand mark; the music bed. Every URL in the plan is
 * already an http URL (the renderer swapped the `ds-asset:` URLs for the asset server's).
 */
import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Html5Audio, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import { Logo, Wordmark, backgroundCss } from '@demo-studio/components/kit';
import type { ComponentProps, ThemeTokens } from '@demo-studio/components';
import type { CardSegment, ClipSegment, EditPlan, OverlayUse, PlanSegment, ResolvedComponent } from '../plan-types.js';
import { viewOf } from '../layout.js';
import type { SourceView } from '../layout.js';
import { layoutPaneRectsAt, paneSource, paneViewOf } from '../panes.js';
import type { PlanSource } from '../plan-types.js';
import { useThemeFonts } from './fonts.js';
import { brandmarkRect, insetHole, layoutRects, mapUseRect, overlayBoxAt, musicPlayGain, musicVolumeAt, loupePlacement, overlayAvoid, overlayRects, overlayTargets, shortcutSlot, srcFrameAt, trackBoxAt, trackKeysAt, transitionWindows, urlAt } from './frames.js';
import type { TransitionWindow } from './frames.js';
import { pickComponent, useModules } from './modules.js';

export interface DemoVideoProps extends Record<string, unknown> {
  plan: EditPlan | null;
}

const fill: CSSProperties = { position: 'absolute', inset: 0 };

/** Props shared by every component use of a plan. */
function baseProps(plan: EditPlan): Pick<ComponentProps, 'theme' | 'unit' | 'width' | 'height' | 'fps' | 'variant'> {
  return { theme: plan.brand.tokens, unit: plan.unit, width: plan.width, height: plan.height, fps: plan.fps, variant: plan.variant };
}

/** One component use: the registered implementation, or the scaffold of its kind for a missing one. */
function Use(props: { rc: ResolvedComponent; plan: EditPlan; durationInFrames: number; extra?: Partial<ComponentProps>; transitionKind?: 'crossfade' | 'fade-black' }) {
  const modules = useModules();
  const { Component, params } = pickComponent(modules, props.rc, props.transitionKind);
  const media = props.rc.media ? { media: props.rc.media } : {};
  // `as`: the kind of this use (a component usable as several kinds — a user file, a Lottie — draws accordingly).
  return <Component {...baseProps(props.plan)} as={props.rc.kind} slots={props.rc.slots} params={params} durationInFrames={props.durationInFrames} {...media} {...props.extra} />;
}

// ── Clips ─────────────────────────────────────────────────────────────────────

/**
 * The capture frame `srcFrame` (index into the CFR capture): an OffthreadVideo inside a Sequence shifted so that the
 * video sees composition frame srcFrame × fps / srcFps, i.e. capture time srcFrame / srcFps.
 *
 * Not `<Freeze frame={srcFrame}>`: Remotion clamps a frozen timeline position to the composition range, so a capture
 * frame index beyond the video's length (a clip taken late in a long capture, an interstitial backdrop near the end)
 * would silently show the wrong frame. A Sequence offset moves the media time without moving the timeline.
 */
function CaptureFrame({ plan, srcFrame, source }: { plan: EditPlan; srcFrame: number; source?: PlanSource }) {
  const current = useCurrentFrame();
  const src = source ?? plan.source;
  const t = (srcFrame / src.fps) * plan.fps;
  return (
    <Sequence from={current - t} layout="none" name="capture">
      {/* objectFit fill: the box is the visible region (the reframe crop) scaled to the capture's aspect, never letterboxed. */}
      <OffthreadVideo src={src.url} muted style={{ width: '100%', height: '100%', display: 'block', objectFit: 'fill' }} />
    </Sequence>
  );
}

/**
 * The capture as the layout's `screen`: fills the layout's screen box, letterboxed to the visible region's aspect
 * ratio, the source frame of this output frame scaled and moved by the camera. `frame` = the clip frame to show
 * (default: the current one).
 */
function CaptureScreen({ plan, clip, frame, region, pane, fit }: { plan: EditPlan; clip: ClipSegment; frame?: number; region?: { x: number; y: number; w: number; h: number }; pane?: number; fit?: 'contain' | 'cover' }) {
  const current = useCurrentFrame();
  const f = Math.max(0, Math.min(clip.durationInFrames - 1, frame ?? current));
  // Multi-page clips (L2.11): a page's own track, view and size.
  const source = pane !== undefined && clip.panes?.[pane] ? paneSource(plan, clip.panes[pane]) : plan.source;
  // A fixed source region (the typing loupe) instead of the camera's view.
  const view: SourceView = region
    ? { cx: region.x + region.w / 2, cy: region.y + region.h / 2, w: region.w, h: region.h }
    : pane !== undefined && clip.panes?.[pane]
      ? paneViewOf(plan, clip, pane, f)
      : viewOf(plan, clip, f);
  const W = source.cssWidth;
  const H = source.cssHeight;
  const aspect = view.w / view.h;
  const sx = W / view.w;
  const sy = H / view.h;
  const tx = (-(view.cx - view.w / 2) / view.w) * 100;
  const ty = (-(view.cy - view.h / 2) / view.h) * 100;
  return (
    <div style={{ ...fill, overflow: 'hidden', containerType: 'size' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          // contain: the region whole (letterboxed); cover: the box filled (a loupe cross-fading two regions).
          width: fit === 'cover' ? `max(100cqw, calc(100cqh * ${aspect}))` : `min(100cqw, calc(100cqh * ${aspect}))`,
          height: fit === 'cover' ? `max(100cqh, calc(100cqw / ${aspect}))` : `min(100cqh, calc(100cqw / ${aspect}))`,
          transform: 'translate(-50%, -50%)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: '100%',
            height: '100%',
            transformOrigin: '0 0',
            transform: sx === 1 && sy === 1 && tx === 0 && ty === 0 ? undefined : `translate(${tx}%, ${ty}%) scale(${sx}, ${sy})`,
          }}
        >
          <CaptureFrame plan={plan} srcFrame={srcFrameAt(clip, f)} source={source} />
        </div>
      </div>
    </div>
  );
}

function Brandmark({ plan, clip }: { plan: EditPlan; clip: ClipSegment }) {
  const theme: ThemeTokens = plan.brand.tokens;
  const mark = brandmarkRect(plan, clip.layout.brandmark, theme.brandmark?.position ?? plan.brand.brandmark.position);
  if (!mark) return null;
  const size = theme.brandmark?.size ?? plan.brand.brandmark.size ?? 30;
  const { rect, align } = mark;
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 10 * plan.unit,
        opacity: theme.brandmark?.opacity ?? 1,
      }}
    >
      <Logo theme={theme} size={size} unit={plan.unit} />
      <Wordmark theme={theme} height={size * 0.8} unit={plan.unit} />
    </div>
  );
}

function OverlayView({ plan, clip, use }: { plan: EditPlan; clip: ClipSegment; use: OverlayUse }) {
  const local = useCurrentFrame();
  const f = use.from + local;
  // The anchor of this frame (a track glides from box to box), mapped through layout (or the page's pane) + camera + reframe.
  const a = trackBoxAt(use, local, plan.fps);
  // A box-filling overlay (a user file, L2.12): the box it fills this frame; else what it points at.
  const anchor = use.box ? overlayBoxAt(plan, clip, use, f) : a ? mapUseRect(plan, clip, use, f, a) : undefined;
  const extra: Partial<ComponentProps> = { rects: overlayRects(plan, clip, use, f), ...(anchor ? { anchor } : {}) };
  if (use.moment !== undefined) extra.moment = use.moment;
  // A caption band over the screen, the key caps' row, the targets of the current and next steps: kept clear.
  // Key caps choose their row (bottom / top) once, from those targets; a lens or a badge keeps them clear frame by frame.
  const caps = use.component.id === 'studio/overlay-shortcut';
  const staticAvoid = useMemo(() => overlayAvoid(plan, clip, use), [plan, clip, use]);
  const avoid = caps ? staticAvoid : [...staticAvoid, ...overlayTargets(plan, clip, use, local)];
  if (avoid.length > 0) extra.avoid = avoid;
  const slot = useMemo(() => (caps ? shortcutSlot(plan, clip, use) : undefined), [caps, plan, clip, use]);
  // A loupe gliding from field to field keeps one side of them.
  const side = useMemo(() => (use.tutorial === 'loupe' ? loupePlacement(plan, clip, use, staticAvoid) : undefined), [plan, clip, use, staticAvoid]);
  const rc = side
    ? { ...use.component, params: { ...use.component.params, placement: side } }
    : slot && slot !== use.component.params.position
      ? { ...use.component, params: { ...use.component.params, position: slot } }
      : use.component;
  if (use.region) {
    // A live capture region (the typing loupe): the component places a box of the region's aspect, `screen` fills it.
    // Gliding to the next field, the lens box glides while its content cross-fades from one field to the other — it
    // never pans over what lies between them.
    const keys = use.track ? trackKeysAt(use, local, plan.fps) : undefined;
    const region = use.track && a ? a : use.region;
    extra.region = { ...region };
    if (keys?.prev && keys.t < 1) {
      const fadeIn = Math.min(1, Math.max(0, (keys.t - 0.2) / 0.6));
      extra.screen = (
        <AbsoluteFill>
          <AbsoluteFill style={{ opacity: 1 - fadeIn }}>
            <CaptureScreen plan={plan} clip={clip} frame={f} region={keys.prev} pane={use.pane} fit="cover" />
          </AbsoluteFill>
          <AbsoluteFill style={{ opacity: fadeIn }}>
            <CaptureScreen plan={plan} clip={clip} frame={f} region={keys.cur} pane={use.pane} fit="cover" />
          </AbsoluteFill>
        </AbsoluteFill>
      );
    } else extra.screen = <CaptureScreen plan={plan} clip={clip} frame={f} region={keys?.cur ?? region} pane={use.pane} />;
  }
  const body = <Use rc={rc} plan={plan} durationInFrames={use.componentFrames ?? use.durationInFrames} extra={extra} />;
  // Picture in picture: the inset floats above the main page and everything drawn on it (a badge's ring, a spotlight).
  const hole = insetHole(plan, clip, use, f);
  return hole ? <AbsoluteFill style={{ clipPath: hole }}>{body}</AbsoluteFill> : body;
}

function Overlays({ plan, clip, layer }: { plan: EditPlan; clip: ClipSegment; layer: 'screen' | 'top' }) {
  return (
    <>
      {clip.overlays.map((o, i) =>
        (o.layer === 'screen') === (layer === 'screen') ? (
          <Sequence key={`${o.scene}-${o.step}-${i}`} from={o.from} durationInFrames={o.durationInFrames} name={`overlay ${o.component.id}`}>
            <OverlayView plan={plan} clip={clip} use={o} />
          </Sequence>
        ) : null,
      )}
    </>
  );
}

/**
 * A clip: layout(screen = capture), brand mark, caption, overlays. `stillAt` = backdrop use: that clip frame, without
 * caption and overlays.
 */
function ClipView({ plan, clip, stillAt }: { plan: EditPlan; clip: ClipSegment; stillAt?: number }) {
  const current = useCurrentFrame();
  const still = stillAt !== undefined;
  const f = stillAt ?? current;
  // Multi-page clips (L2.11): every page from its own track, all at the same source frame; the layout gets one screen
  // per page and each page's rects of this frame (an inset glides between corners and grows while its page acts).
  const layoutExtra: Partial<ComponentProps> = clip.panes
    ? {
        screens: clip.panes.map((_, i) => <CaptureScreen key={i} plan={plan} clip={clip} frame={stillAt} pane={i} />),
        rects: { ...layoutRects(clip.layout), panes: layoutPaneRectsAt(plan, clip, f) },
      }
    : { screen: <CaptureScreen plan={plan} clip={clip} frame={stillAt} />, url: urlAt(clip, f), rects: layoutRects(clip.layout) };
  return (
    <AbsoluteFill>
      <Use rc={clip.component} plan={plan} durationInFrames={clip.durationInFrames} extra={layoutExtra} />
      {!still ? <Overlays plan={plan} clip={clip} layer="screen" /> : null}
      <Brandmark plan={plan} clip={clip} />
      {!still && clip.caption && clip.cues.length > 0 ? (
        <Use
          rc={clip.caption}
          plan={plan}
          durationInFrames={clip.durationInFrames}
          extra={{ cues: clip.cues, rects: layoutRects(clip.layout), ...(clip.layout.caption ? { area: clip.layout.caption } : {}) }}
        />
      ) : null}
      {!still ? <Overlays plan={plan} clip={clip} layer="top" /> : null}
    </AbsoluteFill>
  );
}

/** The interstitial backdrop: the previous clip as it looked on its last frame (layout, capture, brand mark). */
function Backdrop({ plan, index }: { plan: EditPlan; index: number }) {
  const seg = plan.segments[index] as CardSegment;
  if (seg.backdropSrcFrame === undefined) return null;
  let prev: ClipSegment | undefined;
  for (let i = index - 1; i >= 0; i--) {
    const s = plan.segments[i];
    if (s.kind === 'clip') {
      prev = s;
      break;
    }
  }
  if (!prev) return null;
  return <ClipView plan={plan} clip={prev} stillAt={prev.durationInFrames - 1} />;
}

function SegmentBody({ plan, index }: { plan: EditPlan; index: number }) {
  const seg = plan.segments[index];
  if (seg.kind === 'clip') return <ClipView plan={plan} clip={seg} />;
  const extra: Partial<ComponentProps> = seg.kind === 'interstitial' ? { screen: <Backdrop plan={plan} index={index} /> } : {};
  return (
    <AbsoluteFill>
      <Use rc={seg.component} plan={plan} durationInFrames={seg.durationInFrames} extra={extra} />
    </AbsoluteFill>
  );
}

// ── Transitions ───────────────────────────────────────────────────────────────

/**
 * The transition component around `children` (the segment) over its window: the component sees transition frames,
 * the segment inside keeps its own frames (the inner Sequence cancels the outer shift).
 */
function TransitionRender({ plan, w, children }: { plan: EditPlan; w: TransitionWindow; children: ReactNode }) {
  const shift = w.from - w.offset;
  const screen = (
    <Sequence from={-shift} layout="none" name="segment">
      {children}
    </Sequence>
  );
  return (
    <Sequence from={shift} durationInFrames={w.frames} layout="none" name={`${w.kind} ${w.direction}`}>
      <Use rc={w.component} plan={plan} durationInFrames={w.frames} transitionKind={w.kind} extra={{ direction: w.direction, screen, ...(w.anchor ? { anchor: w.anchor } : {}) }} />
    </Sequence>
  );
}

function SegmentView({ plan, index }: { plan: EditPlan; index: number }) {
  const f = useCurrentFrame();
  const { entering, exiting } = transitionWindows(plan, index);
  let node: ReactNode = <SegmentBody plan={plan} index={index} />;
  if (exiting && f >= exiting.from && f < exiting.to) node = <TransitionRender plan={plan} w={exiting}>{node}</TransitionRender>;
  if (entering && f >= entering.from && f < entering.to) node = <TransitionRender plan={plan} w={entering}>{node}</TransitionRender>;
  return <AbsoluteFill>{node}</AbsoluteFill>;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

/** The chapter progress bar (L2.10): one overlay over every segment between the intro and the outro. */
function Progress({ plan }: { plan: EditPlan }) {
  const p = plan.tutorial?.progress;
  if (!p) return null;
  return (
    <Sequence from={p.from} durationInFrames={p.durationInFrames} name={`progress ${p.component.id}`}>
      <Use rc={p.component} plan={plan} durationInFrames={p.durationInFrames} extra={{ chapters: p.chapters, rects: layoutRects(plan.layout) }} />
    </Sequence>
  );
}

// ── Music ─────────────────────────────────────────────────────────────────────

/**
 * The music bed: the planned plays of the track (one trimmed play, or loops whose seams crossfade), each with the bed
 * volume (fades, ducking under footage) × its seam gain. Without a measured track length the element loops itself.
 */
function MusicBed({ plan }: { plan: EditPlan }) {
  const m = plan.music;
  if (!m) return null;
  if (!m.plays || m.plays.length === 0) return <Html5Audio src={m.url} loop={m.loop} volume={(f: number) => musicVolumeAt(plan, f)} />;
  return (
    <>
      {m.plays.map((p, i) => (
        <Sequence key={`music-${i}`} from={p.from} durationInFrames={p.frames} layout="none" name={`music ${i + 1}`}>
          <Html5Audio src={m.url} volume={(f: number) => Math.round(musicVolumeAt(plan, p.from + f) * musicPlayGain(p, f) * 1e4) / 1e4} />
        </Sequence>
      ))}
    </>
  );
}

// ── The composition ───────────────────────────────────────────────────────────

/** Renders `plan` (landscape, vertical or square: the plan says which; DemoVertical / DemoSquare only check it). */
export function DemoVideo({ plan }: DemoVideoProps) {
  if (!plan) throw new Error('DemoVideo needs a plan (inputProps: { plan })');
  const ready = useThemeFonts(plan.brand.tokens.font_faces);
  return (
    <AbsoluteFill style={{ background: backgroundCss(plan.brand.tokens) }}>
      {ready
        ? plan.segments.map((seg, i) => (
            <Sequence key={`${seg.id}-${i}`} from={seg.from} durationInFrames={seg.durationInFrames} name={`${seg.kind} ${seg.id}`}>
              <SegmentView plan={plan} index={i} />
            </Sequence>
          ))
        : null}
      {ready ? <Progress plan={plan} /> : null}
      {ready ? <MusicBed plan={plan} /> : null}
    </AbsoluteFill>
  );
}
