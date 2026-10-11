/**
 * DemoVideo / DemoVertical: render an EditPlan and nothing else (DESIGN-phase2 §2.2). The theme background, one
 * Sequence per segment with its transition component (or plain fade envelope), the segment component with its
 * slots/params; for clips the layout component with `screen` = the capture (one source frame per output frame, under
 * the camera transform), the caption component with the clip's cues in the layout's caption area, the overlays placed
 * from their source anchor through layout + camera, and the brand mark; the music bed. Every URL in the plan is
 * already an http URL (the renderer swapped the `ds-asset:` URLs for the asset server's).
 */
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Html5Audio, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import { Logo, Wordmark, backgroundCss } from '@demo-studio/components/kit';
import type { ComponentProps, ThemeTokens } from '@demo-studio/components';
import type { CardSegment, ClipSegment, EditPlan, OverlayUse, PlanSegment, ResolvedComponent } from '../plan-types.js';
import { mapSourceRect, viewOf } from '../layout.js';
import { useThemeFonts } from './fonts.js';
import { brandmarkRect, envelopeAt, musicVolumeAt, srcFrameAt, transitionWindows, urlAt } from './frames.js';
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
  return <Component {...baseProps(props.plan)} slots={props.rc.slots} params={params} durationInFrames={props.durationInFrames} {...props.extra} />;
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
function CaptureFrame({ plan, srcFrame }: { plan: EditPlan; srcFrame: number }) {
  const current = useCurrentFrame();
  const t = (srcFrame / plan.source.fps) * plan.fps;
  return (
    <Sequence from={current - t} layout="none" name="capture">
      <OffthreadVideo src={plan.source.url} muted style={{ width: '100%', height: '100%', display: 'block' }} />
    </Sequence>
  );
}

/**
 * The capture as the layout's `screen`: fills the layout's screen box, letterboxed to the visible region's aspect
 * ratio, the source frame of this output frame scaled and moved by the camera. `frame` = the clip frame to show
 * (default: the current one).
 */
function CaptureScreen({ plan, clip, frame }: { plan: EditPlan; clip: ClipSegment; frame?: number }) {
  const current = useCurrentFrame();
  const f = Math.max(0, Math.min(clip.durationInFrames - 1, frame ?? current));
  const view = viewOf(plan, clip, f);
  const W = plan.source.cssWidth;
  const H = plan.source.cssHeight;
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
          width: `min(100cqw, calc(100cqh * ${aspect}))`,
          height: `min(100cqh, calc(100cqw / ${aspect}))`,
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
          <CaptureFrame plan={plan} srcFrame={srcFrameAt(clip, f)} />
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
  const a = use.anchor?.bbox ?? use.anchor?.point;
  const anchor = a ? mapSourceRect(plan, clip, f, a) : undefined;
  return <Use rc={use.component} plan={plan} durationInFrames={use.durationInFrames} extra={anchor ? { anchor } : {}} />;
}

/**
 * A clip: layout(screen = capture), brand mark, caption, overlays. `stillAt` = backdrop use: that clip frame, without
 * caption and overlays.
 */
function ClipView({ plan, clip, stillAt }: { plan: EditPlan; clip: ClipSegment; stillAt?: number }) {
  const current = useCurrentFrame();
  const still = stillAt !== undefined;
  const f = stillAt ?? current;
  return (
    <AbsoluteFill>
      <Use rc={clip.component} plan={plan} durationInFrames={clip.durationInFrames} extra={{ screen: <CaptureScreen plan={plan} clip={clip} frame={stillAt} />, url: urlAt(clip, f) }} />
      <Brandmark plan={plan} clip={clip} />
      {!still && clip.caption && clip.cues.length > 0 ? (
        <Use rc={clip.caption} plan={plan} durationInFrames={clip.durationInFrames} extra={{ cues: clip.cues, ...(clip.layout.caption ? { area: clip.layout.caption } : {}) }} />
      ) : null}
      {!still
        ? clip.overlays.map((o, i) => (
            <Sequence key={`${o.scene}-${o.step}-${i}`} from={o.from} durationInFrames={o.durationInFrames} name={`overlay ${o.component.id}`}>
              <OverlayView plan={plan} clip={clip} use={o} />
            </Sequence>
          ))
        : null}
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
      <Use rc={w.component} plan={plan} durationInFrames={w.frames} transitionKind={w.kind} extra={{ direction: w.direction, screen }} />
    </Sequence>
  );
}

function Envelope({ seg, hasExit, children }: { seg: PlanSegment; hasExit: boolean; children: ReactNode }) {
  const f = useCurrentFrame();
  const { opacity, black } = envelopeAt(seg, f, hasExit);
  if (opacity === 1 && black === 0) return <>{children}</>;
  return (
    <AbsoluteFill style={{ opacity }}>
      {children}
      {black > 0 ? <AbsoluteFill style={{ background: '#000000', opacity: black }} /> : null}
    </AbsoluteFill>
  );
}

function SegmentView({ plan, index }: { plan: EditPlan; index: number }) {
  const f = useCurrentFrame();
  const seg = plan.segments[index];
  const { entering, exiting } = transitionWindows(plan, index);
  let node: ReactNode = (
    <Envelope seg={seg} hasExit={!!exiting}>
      <SegmentBody plan={plan} index={index} />
    </Envelope>
  );
  if (exiting && f >= exiting.from && f < exiting.to) node = <TransitionRender plan={plan} w={exiting}>{node}</TransitionRender>;
  if (entering && f >= entering.from && f < entering.to) node = <TransitionRender plan={plan} w={entering}>{node}</TransitionRender>;
  return <AbsoluteFill>{node}</AbsoluteFill>;
}

// ── Music ─────────────────────────────────────────────────────────────────────

function MusicBed({ plan }: { plan: EditPlan }) {
  const m = plan.music;
  if (!m) return null;
  return <Html5Audio src={m.url} loop volume={(f: number) => musicVolumeAt(plan, f)} />;
}

// ── The composition ───────────────────────────────────────────────────────────

/** Renders `plan` (landscape or vertical: the plan says which; DemoVertical only checks it is vertical). */
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
      {ready ? <MusicBed plan={plan} /> : null}
    </AbsoluteFill>
  );
}
