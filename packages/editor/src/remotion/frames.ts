/**
 * Pure helpers of the composition (no React): transition windows, URL and camera lookups, brand mark placement,
 * music volume. Shared by the Remotion composition and the tests (and later by the Studio preview).
 */
import type { ComponentKind } from '@demo-studio/core';
import type { LayoutRects } from '@demo-studio/components';
import type { ClipSegment, EditPlan, PlanLayout, PlanSegment, Rect, ResolvedComponent } from '../plan-types.js';
import { clamp } from '../util.js';

/**
 * Where a transition component renders around one segment, in frames relative to that segment: the window
 * [from, to) of the segment it covers, and `offset` = the transition frame at `from` (the component sees frames
 * offset … offset + (to - from) - 1 of a transition `frames` long).
 */
export interface TransitionWindow {
  direction: 'entering' | 'exiting';
  from: number;
  to: number;
  offset: number;
  /** Length of the whole transition (the component's durationInFrames). */
  frames: number;
  kind: 'crossfade' | 'fade-black';
  component: ResolvedComponent;
}

/**
 * The transition windows of segment `index` (DESIGN-phase2 §2.2): a crossfade overlaps the two segments (both renders
 * see transition frames [0, n)); a dip (fade-black) does not — the outgoing segment's last ⌊n/2⌋ frames are the
 * transition frames [0, ⌊n/2⌋) and the incoming segment's first frames are [⌊n/2⌋, n).
 */
export function transitionWindows(plan: Pick<EditPlan, 'segments'>, index: number): { entering?: TransitionWindow; exiting?: TransitionWindow } {
  const seg = plan.segments[index];
  const next = plan.segments[index + 1];
  const out: { entering?: TransitionWindow; exiting?: TransitionWindow } = {};
  const t = seg.transition;
  if (t && t.component && t.kind !== 'cut' && t.frames > 0) {
    if (t.kind === 'crossfade') {
      out.entering = { direction: 'entering', from: 0, to: Math.min(t.frames, seg.durationInFrames), offset: 0, frames: t.frames, kind: 'crossfade', component: t.component };
    } else {
      const half = Math.floor(t.frames / 2);
      const inn = Math.min(t.frames - half, seg.durationInFrames);
      out.entering = { direction: 'entering', from: 0, to: inn, offset: half, frames: t.frames, kind: 'fade-black', component: t.component };
    }
  }
  const nt = next?.transition;
  if (nt && nt.component && nt.kind !== 'cut' && nt.frames > 0) {
    const d = seg.durationInFrames;
    if (nt.kind === 'crossfade') {
      const n = Math.min(nt.frames, d);
      out.exiting = { direction: 'exiting', from: d - n, to: d, offset: nt.frames - n, frames: nt.frames, kind: 'crossfade', component: nt.component };
    } else {
      const half = Math.min(Math.floor(nt.frames / 2), d);
      out.exiting = { direction: 'exiting', from: d - half, to: d, offset: Math.floor(nt.frames / 2) - half, frames: nt.frames, kind: 'fade-black', component: nt.component };
    }
  }
  return out;
}

/**
 * Opacity / veil of the plain fade envelope of a segment at frame `f` (used only when a fade has no transition
 * component): `opacity` multiplies the segment, `black` is the opacity of a black veil over it.
 */
export function envelopeAt(seg: Pick<PlanSegment, 'fadeIn' | 'fadeOut' | 'durationInFrames' | 'transition'>, f: number, hasExitComponent: boolean): { opacity: number; black: number } {
  let opacity = 1;
  let black = 0;
  const fi = seg.fadeIn;
  if (fi.frames > 0 && !seg.transition?.component && f < fi.frames) {
    const p = (f + 1) / (fi.frames + 1);
    if (fi.color === 'black') black = Math.max(black, 1 - p);
    else opacity *= p;
  }
  const fo = seg.fadeOut;
  const start = seg.durationInFrames - fo.frames;
  if (fo.frames > 0 && !hasExitComponent && f >= start) {
    const p = (f - start + 1) / fo.frames;
    if (fo.color === 'black') black = Math.max(black, p);
    else opacity *= 1 - p;
  }
  return { opacity: clamp(opacity, 0, 1), black: clamp(black, 0, 1) };
}

/**
 * The rects a layout component draws at (`ComponentProps.rects`): the planner's layout in output px — the capture
 * rect as `screen`, the card / device outline as `frame`.
 */
export function layoutRects(layout: PlanLayout): LayoutRects {
  const out: LayoutRects = { screen: { ...layout.capture }, frame: { ...layout.card }, radius: layout.radius };
  if (layout.display) out.display = { ...layout.display };
  if (layout.chrome) out.chrome = { ...layout.chrome };
  if (layout.caption) out.caption = { ...layout.caption };
  if (layout.brandmark) out.brandmark = { ...layout.brandmark };
  return out;
}

/** The URL shown by a browser-chrome layout at frame `f` of a clip. */
export function urlAt(clip: Pick<ClipSegment, 'urls'>, f: number): string | undefined {
  let url: string | undefined;
  for (const u of clip.urls) {
    if (u.frame <= f) url = u.url;
    else break;
  }
  return url ?? clip.urls[0]?.url;
}

/** The source frame index shown at frame `f` of a clip (clamped to the clip). */
export function srcFrameAt(clip: Pick<ClipSegment, 'srcFrames'>, f: number): number {
  const k = clamp(Math.round(f), 0, Math.max(0, clip.srcFrames.length - 1));
  return clip.srcFrames[k] ?? 0;
}

/**
 * The brand mark rect at the theme position: the layout's brandmark rect (bottom-right in the layouts' geometry),
 * mirrored horizontally for bottom-left and vertically for top-right; undefined when the layout has none or the
 * theme says none. `align` is the side the mark sticks to.
 */
export function brandmarkRect(
  plan: Pick<EditPlan, 'width' | 'height'>,
  rect: Rect | undefined,
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'none' | undefined,
): { rect: Rect; align: 'left' | 'right' } | undefined {
  if (!rect || position === 'none') return undefined;
  if (position === 'bottom-left') return { rect: { ...rect, x: plan.width - rect.x - rect.w }, align: 'left' };
  if (position === 'top-right') return { rect: { ...rect, y: plan.height - rect.y - rect.h }, align: 'right' };
  return { rect: { ...rect }, align: 'right' };
}

/**
 * Volume of the music bed at output frame `f`: base volume × fade in × fade out × ducking (×duck while a clip is on
 * screen, eased over 0.4 s at clip boundaries).
 */
export function musicVolumeAt(plan: Pick<EditPlan, 'music' | 'fps' | 'durationInFrames' | 'segments'>, f: number): number {
  const m = plan.music;
  if (!m) return 0;
  const t = f / plan.fps;
  const total = plan.durationInFrames / plan.fps;
  const fadeIn = m.fadeIn_s > 0 ? clamp(t / m.fadeIn_s, 0, 1) : 1;
  const fadeOut = m.fadeOut_s > 0 ? clamp((total - t) / m.fadeOut_s, 0, 1) : 1;
  const ramp = Math.max(1, Math.round(0.4 * plan.fps));
  let onClip = 0;
  for (const s of plan.segments) {
    if (s.kind !== 'clip') continue;
    const a = s.from;
    const b = s.from + s.durationInFrames;
    if (f < a - ramp || f >= b + ramp) continue;
    const inside = f < a ? (f - (a - ramp)) / ramp : f >= b ? 1 - (f - b + 1) / ramp : 1;
    onClip = Math.max(onClip, clamp(inside, 0, 1));
  }
  const duck = 1 - (1 - m.duck) * onClip;
  return Math.round(m.volume * fadeIn * fadeOut * duck * 1e4) / 1e4;
}

/** The kinds the composition may need a stand-in for. */
export type StandInKind = ComponentKind;

/** Params of a stand-in transition: the scaffold dips through the text colour for a fade-black. */
export function standInParams(kind: ComponentKind, transitionKind?: 'crossfade' | 'fade-black'): Record<string, unknown> {
  if (kind === 'transition') return { through: transitionKind === 'fade-black' ? 'text' : 'none' };
  return {};
}
