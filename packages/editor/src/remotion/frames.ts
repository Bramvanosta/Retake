/**
 * Pure helpers of the composition (no React): transition windows, URL and camera lookups, brand mark placement,
 * music volume. Shared by the Remotion composition and the tests (and later by the Studio preview).
 */
import type { ComponentKind } from '@retake/core/model';
import { captionBandBox, insetPhoneEdge, loupeLens, safeAreaRect, shortcutPlateBox, shortcutPlateLayout, shortcutPlateMetrics, stepBadgeBox } from '@retake/components/geometry';
import type { LayoutRects, LoupePlacement } from '@retake/components/geometry';
import { mapSourceRect } from '../layout.js';
import { insetRectAt, layoutPaneRectsAt, mapPaneRect, paneCaptureAt, paneSource } from '../panes.js';
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
 * transition frames [0, ⌊n/2⌋) and the incoming segment's first frames are [⌊n/2⌋, n). Every fade is drawn by a
 * transition component (R-CMP-01): a plan whose fade carries none (the planner never writes one — a transition set to
 * none is a cut — but a hand-written plan may) gets the transition stand-in, like any missing component.
 */
export function transitionWindows(plan: Pick<EditPlan, 'segments'>, index: number): { entering?: TransitionWindow; exiting?: TransitionWindow } {
  const seg = plan.segments[index];
  const next = plan.segments[index + 1];
  const out: { entering?: TransitionWindow; exiting?: TransitionWindow } = {};
  const t = seg.transition;
  if (t && t.kind !== 'cut' && t.frames > 0) {
    const component = t.component ?? standInTransition(t.kind);
    if (t.kind === 'crossfade') {
      out.entering = {
        direction: 'entering',
        from: 0,
        to: Math.min(t.frames, seg.durationInFrames),
        offset: 0,
        frames: t.frames,
        kind: 'crossfade',
        component,
        ...(t.anchor ? { anchor: t.anchor } : {}),
      };
    } else {
      const half = Math.floor(t.frames / 2);
      const inn = Math.min(t.frames - half, seg.durationInFrames);
      out.entering = { direction: 'entering', from: 0, to: inn, offset: half, frames: t.frames, kind: 'fade-black', component, ...(t.anchor ? { anchor: t.anchor } : {}) };
    }
  }
  const nt = next?.transition;
  if (nt && nt.kind !== 'cut' && nt.frames > 0) {
    const component = nt.component ?? standInTransition(nt.kind);
    const d = seg.durationInFrames;
    if (nt.kind === 'crossfade') {
      const n = Math.min(nt.frames, d);
      out.exiting = { direction: 'exiting', from: d - n, to: d, offset: nt.frames - n, frames: nt.frames, kind: 'crossfade', component, ...(nt.anchor ? { anchor: nt.anchor } : {}) };
    } else {
      const half = Math.min(Math.floor(nt.frames / 2), d);
      out.exiting = {
        direction: 'exiting',
        from: d - half,
        to: d,
        offset: Math.floor(nt.frames / 2) - half,
        frames: nt.frames,
        kind: 'fade-black',
        component,
        ...(nt.anchor ? { anchor: nt.anchor } : {}),
      };
    }
  }
  return out;
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

/**
 * The URL shown by a browser-chrome layout at frame `f` of a clip; undefined while it is a hidden (local) one — the bar
 * shows no address (L1.7: a local URL is never drawn).
 */
export function urlAt(clip: Pick<ClipSegment, 'urls'>, f: number): string | undefined {
  let at: ClipSegment['urls'][number] | undefined;
  for (const u of clip.urls) {
    if (u.frame <= f) at = u;
    else break;
  }
  at ??= clip.urls[0];
  return at && !at.hidden ? at.url : undefined;
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
  for (const [a, b] of duckSpans(plan)) {
    if (f < a - ramp || f >= b + ramp) continue;
    const inside = f < a ? (f - (a - ramp)) / ramp : f >= b ? 1 - (f - b + 1) / ramp : 1;
    onClip = Math.max(onClip, smoothstep(inside));
  }
  const duck = 1 - (1 - m.duck) * onClip;
  return Math.round(m.volume * fadeIn * fadeOut * duck * 1e4) / 1e4;
}

/** Does a use play a sound of its own (a user video with sound and a volume above 0, L2.12)? */
export function playsSound(rc: Pick<ResolvedComponent, 'media' | 'params'>): boolean {
  const m = rc.media?.file;
  return m?.kind === 'video' && m.audio && (typeof rc.params.volume === 'number' ? rc.params.volume > 0 : true);
}

const duckCache = new WeakMap<object, Array<[number, number]>>();

/**
 * Output frames [a, b) under which the music bed ducks: product footage (every clip) and every user file with sound
 * (L2.12: a video intro, outro, card or interstitial, an overlay video over a clip) — "like under any audio segment".
 */
export function duckSpans(plan: Pick<EditPlan, 'segments'>): Array<[number, number]> {
  const hit = duckCache.get(plan.segments);
  if (hit) return hit;
  const out: Array<[number, number]> = [];
  for (const s of plan.segments) {
    if (s.kind === 'clip') {
      out.push([s.from, s.from + s.durationInFrames]);
      continue;
    }
    if (playsSound(s.component)) out.push([s.from, s.from + s.durationInFrames]);
  }
  duckCache.set(plan.segments, out);
  return out;
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

/** The stand-in use of a fade that carries no transition component: drawn by the transition scaffold. */
export function standInTransition(kind: 'crossfade' | 'fade-black'): ResolvedComponent {
  return {
    id: kind === 'fade-black' ? 'studio/transition-fade-black' : 'studio/transition-crossfade',
    version: '0.0.0',
    kind: 'transition',
    params: {},
    slots: {},
    source: 'builtin-default',
    missing: true,
  };
}

/** Params of a stand-in transition: the scaffold dips through the text colour for a fade-black. */
export function standInParams(kind: ComponentKind, transitionKind?: 'crossfade' | 'fade-black'): Record<string, unknown> {
  if (kind === 'transition') return { through: transitionKind === 'fade-black' ? 'text' : 'none' };
  return {};
}

/** Glide of an overlay's anchor between two boxes of its track (output seconds, eased in and out). */
export const TRACK_GLIDE_S = 0.45;

/**
 * A source rect of an overlay's page (CSS px) in output px at clip frame `f`: through its pane (multi-page clips,
 * L2.11) or the clip's layout, camera and reframe.
 */
export function mapUseRect(
  plan: Pick<EditPlan, 'source' | 'tracks' | 'variant' | 'fps'>,
  clip: ClipSegment,
  use: Pick<OverlayUse, 'pane'>,
  f: number,
  rect: { x: number; y: number; w?: number; h?: number },
): Rect {
  if (use.pane !== undefined && clip.panes?.[use.pane]) return mapPaneRect(plan, clip, use.pane, f, rect);
  return mapSourceRect(plan, clip, f, rect);
}

/**
 * Does an overlay of a picture-in-picture inset's page stay inside the inset (L2.11)? Its spotlight (the `screen`
 * layer) and its step badges (small, beside a target of that page: never half over the inset's edge) do; its other
 * free-standing overlays — key caps, the typing lens, a step's own overlay — are too large for it and are placed in the
 * main page's area.
 */
export function staysInInset(use: Pick<OverlayUse, 'layer' | 'tutorial'>): boolean {
  return use.layer === 'screen' || use.tutorial === 'steps';
}

/**
 * The rects an overlay places itself in (`ComponentProps.rects`): the clip layout's, with — for an overlay of a page of
 * a multi-page clip — `screen` = that page's capture (a spotlight dims only that page; key caps sit at its bottom). An
 * inset page's free-standing overlays (key caps, lens) use the main page's area: the inset is too small for them
 * (`staysInInset`).
 */
export function overlayRects(plan: Pick<EditPlan, 'source' | 'tracks' | 'fps'>, clip: ClipSegment, use: Pick<OverlayUse, 'pane' | 'layer' | 'tutorial'>, f: number): LayoutRects {
  const base = layoutRects(clip.layout);
  if (use.pane === undefined || !clip.panes?.[use.pane]) return base;
  const pane = clip.panes[use.pane];
  const cap = paneCaptureAt(clip, use.pane, f, plan.fps);
  const inset = clip.inset?.pane === use.pane;
  const screen = inset && !staysInInset(use) ? clip.panes[0].layout.capture : cap;
  return { ...base, screen: { ...screen }, frame: { ...(inset ? cap : pane.layout.card) }, radius: pane.layout.radius, panes: layoutPaneRectsAt(plan, clip, f) };
}

/**
 * The two keyed boxes of a track around frame `local` and how far the glide between them is (0..1, smoothstep): a
 * loupe gliding to the next field cross-fades the two fields instead of panning over what lies between them.
 */
export function trackKeysAt(use: Pick<OverlayUse, 'track'>, local: number, fps: number): { prev?: Rect; cur: Rect; t: number } | undefined {
  const track = use.track;
  if (!track || track.length === 0) return undefined;
  let k = 0;
  for (let i = 0; i < track.length; i++) if (track[i].at <= local) k = i;
  const cur = { ...track[k].bbox };
  if (k === 0) return { cur, t: 1 };
  const glide = Math.max(1, TRACK_GLIDE_S * fps);
  const x = clamp((local - track[k].at) / glide, 0, 1);
  if (x >= 1) return { cur, t: 1 };
  return { prev: { ...track[k - 1].bbox }, cur, t: x * x * (3 - 2 * x) };
}

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
  const band = captionBandBox({
    rects: { screen: clip.layout.capture },
    area: clip.layout.caption,
    width: plan.width,
    height: plan.height,
    unit: plan.unit,
    position: 'over',
    maxWidth,
    variant: plan.variant,
  });
  return band.over ? band.box : undefined;
}

/**
 * The row the built-in key caps (studio/overlay-shortcut) take in a clip, full width, output px: the bottom (or top) of
 * the capture, above a caption band over the screen when one is on during them.
 */
export function shortcutRow(
  plan: Pick<EditPlan, 'width' | 'height' | 'unit' | 'variant'>,
  clip: Pick<ClipSegment, 'caption' | 'cues' | 'layout' | 'panes' | 'inset'>,
  use: Pick<OverlayUse, 'component' | 'from' | 'durationInFrames' | 'pane' | 'layer'>,
): Rect | undefined {
  if (use.component.id !== 'studio/overlay-shortcut') return undefined;
  const p = use.component.params;
  const m = shortcutPlateMetrics(typeof p.size === 'number' ? p.size : 62, plan.unit, plan.variant ?? 'landscape');
  const screen = useScreen(clip, use);
  const bounds = { x: screen.x + m.inset, y: screen.y + m.inset, w: screen.w - 2 * m.inset, h: screen.h - 2 * m.inset };
  const band = captionBandOver(plan, clip);
  const bandOn = band && clip.cues.some((c) => c.from < use.from + use.durationInFrames && c.to > use.from);
  const position = 'brand' in plan && 'source' in plan ? shortcutSlot(plan as EditPlan, clip as ClipSegment, use as OverlayUse) : p.position === 'top' ? 'top' : 'bottom';
  const row = shortcutPlateBox({ bounds, w: bounds.w, h: m.height, position, ...(bandOn ? { avoid: [band] } : {}), gap: m.clearance });
  const pad = 8 * plan.unit;
  return { x: row.x, y: row.y - pad, w: row.w, h: row.h + 2 * pad };
}

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Where the key caps of an overlay-shortcut use go (L2.11 polish): their preferred row (`position`, default bottom),
 * above a caption band over the screen — unless the plate would then cover a target of the current or next step
 * (`OverlayUse.clear`): the other row, when it covers none (else the one covering least).
 */
export function shortcutSlot(plan: EditPlan, clip: ClipSegment, use: OverlayUse): 'top' | 'bottom' {
  const p = use.component.params;
  const preferred: 'top' | 'bottom' = p.position === 'top' ? 'top' : 'bottom';
  if (use.component.id !== 'studio/overlay-shortcut' || !use.clear || use.clear.length === 0) return preferred;
  const lay = plateOf(plan, use);
  const m = lay.metrics;
  const screen = useScreen(clip, use);
  const bounds = screen.w > lay.W + 2 * m.inset ? { x: screen.x + m.inset, y: screen.y + m.inset, w: screen.w - 2 * m.inset, h: screen.h - 2 * m.inset } : safeAreaRect(plan.width, plan.height, 0.04);
  const band = captionBandOver(plan, clip);
  const bandOn = band && clip.cues.some((c) => c.from < use.from + use.durationInFrames && c.to > use.from);
  const targets = use.clear.map((c) => mapUseRect(plan, clip, c.pane !== undefined ? { pane: c.pane } : use, use.from + clamp(c.from, 0, Math.max(0, use.durationInFrames - 1)), c.bbox));
  let best: { pos: 'top' | 'bottom'; cost: number } | undefined;
  for (const pos of [preferred, preferred === 'top' ? 'bottom' : 'top'] as const) {
    const box = shortcutPlateBox({ bounds, w: lay.W, h: lay.H, position: pos, ...(bandOn ? { avoid: [band] } : {}), gap: m.clearance });
    const cost = targets.reduce((sum, t) => sum + overlap(box, t), 0);
    if (cost === 0) return pos;
    if (!best || cost < best.cost) best = { pos, cost };
  }
  return best!.pos;
}

/** The measured key-cap plate of an overlay-shortcut use (kit `shortcutPlateLayout`, the component's own numbers). */
export function plateOf(plan: Pick<EditPlan, 'unit' | 'variant' | 'brand'>, use: Pick<OverlayUse, 'component'>): ReturnType<typeof shortcutPlateLayout> {
  const p = use.component.params;
  const slots = use.component.slots;
  return shortcutPlateLayout({
    keys: slots.keys ?? '',
    ...(slots.label ? { label: slots.label } : {}),
    times: Math.max(1, Number.parseInt(slots.times ?? '1', 10) || 1),
    platform: p.platform === 'windows' || p.platform === 'linux' ? p.platform : 'mac',
    size: typeof p.size === 'number' ? p.size : 62,
    unit: plan.unit,
    variant: plan.variant ?? 'landscape',
    fontFamily: plan.brand.tokens.fonts.body,
  });
}

/**
 * The capture area an overlay places itself in, at rest (no inset glide): its page's pane in a multi-page clip (an
 * inset page's free-standing overlays: the main page's), else the clip's capture.
 */
export function useScreen(clip: Pick<ClipSegment, 'layout' | 'panes' | 'inset'>, use: Pick<OverlayUse, 'pane' | 'layer' | 'tutorial'>): Rect {
  if (use.pane === undefined || !clip.panes?.[use.pane]) return clip.layout.capture;
  if (clip.inset?.pane === use.pane && !staysInInset(use)) return clip.panes[0].layout.capture;
  return clip.panes[use.pane].layout.capture;
}

/**
 * The targets an overlay keeps clear of at frame `local` of the overlay (`OverlayUse.clear`: the current step's and the
 * next click steps' targets), in output px, `kind: 'target'` (added to `ComponentProps.avoid`).
 */
export function overlayTargets(
  plan: Pick<EditPlan, 'source' | 'tracks' | 'variant' | 'fps'>,
  clip: ClipSegment,
  use: Pick<OverlayUse, 'clear' | 'pane' | 'from'>,
  local: number,
): Array<Rect & { kind: 'target' }> {
  const out: Array<Rect & { kind: 'target' }> = [];
  for (const c of use.clear ?? []) {
    if (local < c.from || local >= c.to) continue;
    out.push({ ...mapUseRect(plan, clip, c.pane !== undefined ? { pane: c.pane } : use, use.from + local, c.bbox), kind: 'target' });
  }
  return out;
}

/**
 * What an overlay keeps clear of (`ComponentProps.avoid`, output px): the caption band over the screen while one of the
 * clip's cues is on during the overlay [from, from + durationInFrames) (frames relative to the clip); for a loupe or a
 * step badge, also the row of the key caps showing during it.
 */
export function overlayAvoid(
  plan: Pick<EditPlan, 'width' | 'height' | 'unit' | 'variant'>,
  clip: Pick<ClipSegment, 'caption' | 'cues' | 'layout' | 'overlays' | 'panes' | 'inset'>,
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
    if (
      use.track.every((k, i) => {
        const b = lensAt(k, i, side);
        return b.fits && b.side === side;
      })
    )
      return side;
  }
  return undefined;
}

/**
 * The box (output px) a free-standing tutorial overlay draws at frame `local` of the overlay — the key-cap plate, a
 * step badge, the typing lens — computed with the components' own kit functions and the inputs the composition hands
 * them (rects, anchor, avoid, placement). The review checks it against the click targets (`overlay-covers-target`).
 * Undefined for other overlays.
 */
export function drawnOverlayBox(plan: EditPlan, clip: ClipSegment, use: OverlayUse, local: number): Rect | undefined {
  const f = use.from + local;
  const rects = overlayRects(plan, clip, use, f);
  const staticAvoid = overlayAvoid(plan, clip, use);
  const variant = plan.variant ?? 'landscape';
  const p = use.component.params;
  if (use.component.id === 'studio/overlay-shortcut') {
    const lay = plateOf(plan, use);
    const m = lay.metrics;
    const screen = rects.screen;
    const bounds =
      screen && screen.w > lay.W + 2 * m.inset ? { x: screen.x + m.inset, y: screen.y + m.inset, w: screen.w - 2 * m.inset, h: screen.h - 2 * m.inset } : safeAreaRect(plan.width, plan.height, 0.04);
    const box = shortcutPlateBox({ bounds, w: lay.W, h: lay.H, position: shortcutSlot(plan, clip, use), ...(staticAvoid.length ? { avoid: staticAvoid } : {}), gap: m.clearance });
    return { x: box.x, y: box.y, w: box.w, h: box.h };
  }
  const a = trackBoxAt(use, local, plan.fps);
  const anchor = a ? mapUseRect(plan, clip, use, f, a) : undefined;
  const avoid = [...staticAvoid, ...overlayTargets(plan, clip, use, local)];
  if (use.component.id === 'studio/overlay-steps') {
    const placement = p.placement === 'left' || p.placement === 'right' || p.placement === 'above' || p.placement === 'below' ? p.placement : 'auto';
    const b = stepBadgeBox({
      ...(anchor ? { anchor } : {}),
      screen: rects.screen,
      width: plan.width,
      height: plan.height,
      unit: plan.unit,
      variant,
      size: typeof p.size === 'number' ? p.size : 44,
      placement,
      ...(avoid.length ? { avoid } : {}),
    });
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }
  if (use.component.id === 'studio/overlay-loupe' && use.region && anchor) {
    const region = use.track && a ? a : use.region;
    const side = loupePlacement(plan, clip, use, staticAvoid);
    const placement = side ?? (p.placement === 'below' || p.placement === 'above' ? p.placement : 'auto');
    const lens = loupeLens({
      anchor,
      region,
      screen: rects.screen,
      width: plan.width,
      height: plan.height,
      unit: plan.unit,
      variant,
      zoom: typeof p.zoom === 'number' ? p.zoom : 2,
      maxWidth: typeof p.max_width === 'number' ? p.max_width : 900,
      placement,
      avoid,
    });
    return { x: lens.box.x, y: lens.box.y, w: lens.box.w, h: lens.box.h };
  }
  return undefined;
}

/**
 * The clip-path that keeps an overlay of a picture in picture's main page off the inset (its card or phone, edge
 * included) at clip frame `f`: the whole frame minus the inset (even-odd). Undefined for other overlays.
 */
export function insetHole(
  plan: Pick<EditPlan, 'tracks' | 'source' | 'fps' | 'unit' | 'width' | 'height'>,
  clip: Pick<ClipSegment, 'inset' | 'panes' | 'acting'>,
  use: Pick<OverlayUse, 'pane'>,
  f: number,
): string | undefined {
  const inset = clip.inset;
  if (!inset || !clip.panes || use.pane === undefined || use.pane === inset.pane) return undefined;
  const r = insetRectAt(clip, f, plan.fps);
  if (!r) return undefined;
  const e = paneSource(plan, clip.panes[inset.pane]).mobile ? insetPhoneEdge(r.h) : 4 * plan.unit;
  const n = (v: number) => Math.round(v * 100) / 100;
  const [x, y, w, h] = [n(r.x - e), n(r.y - e), n(r.w + 2 * e), n(r.h + 2 * e)];
  return `path(evenodd, 'M0 0H${plan.width}V${plan.height}H0Z M${x} ${y}h${w}v${h}h${-w}Z')`;
}

/** Margin (share of the visible capture's shorter side) of a box overlay placed at a side or a corner of the screen. */
export const OVERLAY_BOX_MARGIN = 0.04;

/**
 * The box a box-filling overlay fills at clip frame `f` (L2.12), output px: its rect of the page mapped through the
 * layout (or its pane), the camera and the reframe; or its size — scaled like the page at this frame — at a position of
 * the visible capture (`overlayRects(…).screen`); or that whole visible capture (`screen`). Undefined without a box.
 */
export function overlayBoxAt(plan: Pick<EditPlan, 'source' | 'tracks' | 'variant' | 'fps'>, clip: ClipSegment, use: OverlayUse, f: number): Rect | undefined {
  const box = use.box;
  if (!box) return undefined;
  if (box.rect) return mapUseRect(plan, clip, use, f, box.rect);
  const screen = overlayRects(plan, clip, use, f).screen;
  if (box.anchor === 'screen' || !box.size) return { ...screen };
  const unitBox = mapUseRect(plan, clip, use, f, { x: 0, y: 0, w: box.size.w, h: box.size.h });
  const w = unitBox.w;
  const h = unitBox.h;
  const m = OVERLAY_BOX_MARGIN * Math.min(screen.w, screen.h);
  const a = box.anchor;
  const x = /left$/.test(a) || a === 'left' ? screen.x + m : /right$/.test(a) || a === 'right' ? screen.x + screen.w - m - w : screen.x + (screen.w - w) / 2;
  const y = /^top/.test(a) ? screen.y + m : /^bottom/.test(a) ? screen.y + screen.h - m - h : screen.y + (screen.h - h) / 2;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}
