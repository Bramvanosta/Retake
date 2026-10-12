/**
 * Pure helpers of the composition (no React): transition windows, URL and camera lookups, brand mark placement,
 * music volume. Shared by the Remotion composition and the tests (and later by the Studio preview).
 */
import type { ComponentKind } from '@demo-studio/core';
import { captionBandBox, loupeLens, shortcutPlateBox, shortcutPlateMetrics } from '@demo-studio/components/kit';
import type { LoupePlacement } from '@demo-studio/components/kit';
import { mapSourceRect } from '../layout.js';
import type { LayoutRects } from '@demo-studio/components';
import type { ClipSegment, EditPlan, OverlayUse, PlanLayout, PlanSegment, Rect, ResolvedComponent } from '../plan-types.js';
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
  /** The box the transition opens from (PlanTransition.anchor), when the outgoing segment declares one. */
  anchor?: Rect;
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
      out.entering = { direction: 'entering', from: 0, to: Math.min(t.frames, seg.durationInFrames), offset: 0, frames: t.frames, kind: 'crossfade', component: t.component, ...(t.anchor ? { anchor: t.anchor } : {}) };
    } else {
      const half = Math.floor(t.frames / 2);
      const inn = Math.min(t.frames - half, seg.durationInFrames);
      out.entering = { direction: 'entering', from: 0, to: inn, offset: half, frames: t.frames, kind: 'fade-black', component: t.component, ...(t.anchor ? { anchor: t.anchor } : {}) };
    }
  }
  const nt = next?.transition;
  if (nt && nt.component && nt.kind !== 'cut' && nt.frames > 0) {
    const d = seg.durationInFrames;
    if (nt.kind === 'crossfade') {
      const n = Math.min(nt.frames, d);
      out.exiting = { direction: 'exiting', from: d - n, to: d, offset: nt.frames - n, frames: nt.frames, kind: 'crossfade', component: nt.component, ...(nt.anchor ? { anchor: nt.anchor } : {}) };
    } else {
      const half = Math.min(Math.floor(nt.frames / 2), d);
      out.exiting = { direction: 'exiting', from: d - half, to: d, offset: Math.floor(nt.frames / 2) - half, frames: nt.frames, kind: 'fade-black', component: nt.component, ...(nt.anchor ? { anchor: nt.anchor } : {}) };
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

const smoothstep = (x: number) => {
  const k = clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
};

/**
 * Volume of the music bed at output frame `f` (before any loop-seam gain): base volume × fade in × fade out × ducking.
 * The bed is at its base volume on the intro, the outro, cards and interstitials, and ducked (× `duck`) while product
 * footage (a clip) is on screen, eased (smoothstep) over `duck_ramp_s` around each clip's edges.
 */
export function musicVolumeAt(plan: Pick<EditPlan, 'music' | 'fps' | 'durationInFrames' | 'segments'>, f: number): number {
  const m = plan.music;
  if (!m) return 0;
  const t = f / plan.fps;
  const total = plan.durationInFrames / plan.fps;
  const fadeIn = m.fadeIn_s > 0 ? smoothstep(t / m.fadeIn_s) : 1;
  const fadeOut = m.fadeOut_s > 0 ? smoothstep((total - t) / m.fadeOut_s) : 1;
  const ramp = Math.max(1, Math.round((m.duck_ramp_s ?? 0.4) * plan.fps));
  let onClip = 0;
  for (const s of plan.segments) {
    if (s.kind !== 'clip') continue;
    const a = s.from;
    const b = s.from + s.durationInFrames;
    if (f < a - ramp || f >= b + ramp) continue;
    const inside = f < a ? (f - (a - ramp)) / ramp : f >= b ? 1 - (f - b + 1) / ramp : 1;
    onClip = Math.max(onClip, smoothstep(inside));
  }
  const duck = 1 - (1 - m.duck) * onClip;
  return Math.round(m.volume * fadeIn * fadeOut * duck * 1e4) / 1e4;
}

/**
 * Gain of one play of the track at frame `local` of that play (loop seams): equal-power fade in over its first
 * `fadeIn` frames and fade out over its last `fadeOut` frames, so two overlapping plays keep a steady loudness.
 */
export function musicPlayGain(play: { frames: number; fadeIn: number; fadeOut: number }, local: number): number {
  let g = 1;
  if (play.fadeIn > 0 && local < play.fadeIn) g *= Math.sin(((local + 0.5) / play.fadeIn) * (Math.PI / 2));
  const fromEnd = play.frames - local;
  if (play.fadeOut > 0 && fromEnd <= play.fadeOut) g *= Math.sin(((fromEnd - 0.5) / play.fadeOut) * (Math.PI / 2));
  return clamp(g, 0, 1);
}

/** The kinds the composition may need a stand-in for. */
export type StandInKind = ComponentKind;

/** Params of a stand-in transition: the scaffold dips through the text colour for a fade-black. */
export function standInParams(kind: ComponentKind, transitionKind?: 'crossfade' | 'fade-black'): Record<string, unknown> {
  if (kind === 'transition') return { through: transitionKind === 'fade-black' ? 'text' : 'none' };
  return {};
}

/** Glide of an overlay's anchor between two boxes of its track (output seconds, eased in and out). */
export const TRACK_GLIDE_S = 0.45;

/**
 * The anchor box (source CSS px) of an overlay at frame `local` (relative to the overlay): its track's box, gliding
 * from the previous one over `TRACK_GLIDE_S` after each change (smoothstep); else its static anchor.
 */
export function trackBoxAt(use: Pick<OverlayUse, 'track' | 'anchor'>, local: number, fps: number): { x: number; y: number; w: number; h: number } | undefined {
  const track = use.track;
  if (!track || track.length === 0) {
    const b = use.anchor?.bbox;
    if (b) return { ...b };
    const p = use.anchor?.point;
    return p ? { x: p.x, y: p.y, w: 0, h: 0 } : undefined;
  }
  let k = 0;
  for (let i = 0; i < track.length; i++) if (track[i].at <= local) k = i;
  const cur = track[k].bbox;
  if (k === 0) return { ...cur };
  const glide = Math.max(1, TRACK_GLIDE_S * fps);
  const t = clamp((local - track[k].at) / glide, 0, 1);
  if (t >= 1) return { ...cur };
  const e = t * t * (3 - 2 * t);
  const prev = track[k - 1].bbox;
  const lerp = (a: number, b: number) => Math.round((a + (b - a) * e) * 100) / 100;
  return { x: lerp(prev.x, cur.x), y: lerp(prev.y, cur.y), w: lerp(prev.w, cur.w), h: lerp(prev.h, cur.h) };
}

/**
 * The box of a clip's caption band when the caption is drawn over the screen (`position: over`, e.g.
 * studio/caption-overlay): the box the caption component reserves (its band grows up from the bottom of it), in output
 * px. Undefined when the caption sits beside or below the capture, or the clip has no cue.
 */
export function captionBandOver(plan: Pick<EditPlan, 'width' | 'height' | 'unit' | 'variant'>, clip: Pick<ClipSegment, 'caption' | 'cues' | 'layout'>): Rect | undefined {
  const params = clip.caption?.params ?? {};
  if (!clip.caption || clip.cues.length === 0 || params.position !== 'over') return undefined;
  const maxWidth = typeof params.max_width === 'number' ? params.max_width : 1400;
  const band = captionBandBox({ rects: { screen: clip.layout.capture }, area: clip.layout.caption, width: plan.width, height: plan.height, unit: plan.unit, position: 'over', maxWidth, variant: plan.variant });
  return band.over ? band.box : undefined;
}

/**
 * The row the built-in key caps (studio/overlay-shortcut) take in a clip, full width, output px: the bottom (or top) of
 * the capture, above a caption band over the screen when one is on during them.
 */
export function shortcutRow(plan: Pick<EditPlan, 'width' | 'height' | 'unit' | 'variant'>, clip: Pick<ClipSegment, 'caption' | 'cues' | 'layout'>, use: Pick<OverlayUse, 'component' | 'from' | 'durationInFrames'>): Rect | undefined {
  if (use.component.id !== 'studio/overlay-shortcut') return undefined;
  const p = use.component.params;
  const m = shortcutPlateMetrics(typeof p.size === 'number' ? p.size : 62, plan.unit, plan.variant ?? 'landscape');
  const screen = clip.layout.capture;
  const bounds = { x: screen.x + m.inset, y: screen.y + m.inset, w: screen.w - 2 * m.inset, h: screen.h - 2 * m.inset };
  const band = captionBandOver(plan, clip);
  const bandOn = band && clip.cues.some((c) => c.from < use.from + use.durationInFrames && c.to > use.from);
  const row = shortcutPlateBox({ bounds, w: bounds.w, h: m.height, position: p.position === 'top' ? 'top' : 'bottom', ...(bandOn ? { avoid: [band] } : {}), gap: m.clearance });
  const pad = 8 * plan.unit;
  return { x: row.x, y: row.y - pad, w: row.w, h: row.h + 2 * pad };
}

/**
 * What an overlay keeps clear of (`ComponentProps.avoid`, output px): the caption band over the screen while one of the
 * clip's cues is on during the overlay [from, from + durationInFrames) (frames relative to the clip); for a loupe or a
 * step badge, also the row of the key caps showing during it.
 */
export function overlayAvoid(
  plan: Pick<EditPlan, 'width' | 'height' | 'unit' | 'variant'>,
  clip: Pick<ClipSegment, 'caption' | 'cues' | 'layout' | 'overlays'>,
  use: Pick<OverlayUse, 'from' | 'durationInFrames'> & Partial<Pick<OverlayUse, 'tutorial'>>,
): Rect[] {
  const out: Rect[] = [];
  const end = use.from + use.durationInFrames;
  const band = captionBandOver(plan, clip);
  if (band && clip.cues.some((c) => c.from < end && c.to > use.from)) out.push(band);
  if (use.tutorial === 'loupe' || use.tutorial === 'steps') {
    const seen = new Set<string>();
    for (const o of clip.overlays) {
      if (o.tutorial !== 'shortcuts' || o.from >= end || o.from + o.durationInFrames <= use.from) continue;
      const row = shortcutRow(plan, clip, o);
      const key = row ? `${row.x},${row.y},${row.w},${row.h}` : '';
      if (row && !seen.has(key)) {
        seen.add(key);
        out.push(row);
      }
    }
  }
  return out;
}

/**
 * One side for a loupe gliding from field to field (`placement: auto`): when the fields of its track would put the lens
 * on different sides (one near the bottom of the capture or the key caps), the side where it fits for every field —
 * so it never jumps across a field mid-glide. Undefined: keep the component's own choice.
 */
export function loupePlacement(
  plan: Pick<EditPlan, 'width' | 'height' | 'unit' | 'variant' | 'source' | 'fps'>,
  clip: ClipSegment,
  use: Pick<OverlayUse, 'component' | 'from' | 'durationInFrames' | 'track'>,
  avoid: readonly Rect[],
): LoupePlacement | undefined {
  const p = use.component.params;
  if ((p.placement ?? 'auto') !== 'auto' || !use.track || use.track.length < 2) return undefined;
  const glide = Math.round(TRACK_GLIDE_S * plan.fps);
  const lensAt = (k: { at: number; bbox: Rect }, i: number, placement: LoupePlacement) => {
    const f = use.from + Math.min(use.durationInFrames - 1, k.at + (i === 0 ? 0 : glide));
    return loupeLens({
      anchor: mapSourceRect(plan, clip, f, k.bbox),
      region: k.bbox,
      screen: clip.layout.capture,
      width: plan.width,
      height: plan.height,
      unit: plan.unit,
      variant: plan.variant ?? 'landscape',
      zoom: typeof p.zoom === 'number' ? p.zoom : 2,
      maxWidth: typeof p.max_width === 'number' ? p.max_width : 900,
      placement,
      avoid,
    }).box;
  };
  const sides = use.track.map((k, i) => lensAt(k, i, 'auto').side);
  if (sides.every((s) => s === sides[0])) return undefined;
  for (const side of ['below', 'above'] as const) {
    if (use.track.every((k, i) => {
      const b = lensAt(k, i, side);
      return b.fits && b.side === side;
    }))
      return side;
  }
  return undefined;
}
