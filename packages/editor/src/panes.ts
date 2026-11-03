/**
 * Multi-page clips (L2.11): the geometry of each page (pane) of a split screen or a picture in picture, the corner
 * track of a picture-in-picture inset, the acting page over time, and the mapping of a page's source CSS px to output
 * px at one frame. Pure — shared by the planner, the composition and the review.
 */
import type { BBox, TimelineEvent } from '@retake/core';
import type { LayoutPaneRects } from '@retake/components';
import type { ClipSegment, EditPlan, InsetCorner, PlanInset, PlanPane, PlanPaneLayout, PlanSource, PlanVariant, Rect } from './plan-types.js';
import { REFRAME_MIN_SCALE } from './layout.js';
import { clamp, round, stepEnd } from './util.js';

/** Output seconds an inset takes to glide to another corner. */
export const INSET_GLIDE_S = 0.6;
/** Output seconds the acting emphasis (an inset growing, the idle page dimming) takes to change. */
export const ACTING_EASE_S = 0.4;
/** How much larger an inset is drawn while its page acts (themes that ask for emphasis). */
export const INSET_GROW = 1.18;
/** Seconds before a step the inset must have left the step's targets (it starts gliding then). */
export const INSET_LEAD_S = 0.9;
/** Shortest stay of an inset in a corner (seconds), so it never hops back and forth. */
export const INSET_MIN_HOLD_S = 1.2;
/** Seconds before a step starts that its page becomes the acting one (during the runner's switch pause). */
export const ACTING_LEAD_S = 0.35;

const smooth = (x: number) => {
  const k = clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
};

/** `aspect` (w / h) fitted inside `box`, horizontally centred, top-aligned (split panes line up their tops). */
export function fitTop(box: Rect, aspect: number): Rect {
  const boxAspect = box.w / box.h;
  if (Math.abs(boxAspect - aspect) < 1e-6) return { ...box };
  if (boxAspect > aspect) {
    const w = box.h * aspect;
    return { x: round(box.x + (box.w - w) / 2, 3), y: box.y, w: round(w, 3), h: box.h };
  }
  return { x: box.x, y: box.y, w: box.w, h: round(box.w / aspect, 3) };
}

function scaleRect(r: Rect, unit: number): Rect {
  return { x: round(r.x * unit, 3), y: round(r.y * unit, 3), w: round(r.w * unit, 3), h: round(r.h * unit, 3) };
}

/**
 * A pane's layout: landscape — the page fitted to its aspect inside the pane rect (`top`: top-aligned, else centred);
 * vertical / square — the pane rect itself, the page cropped to the pane's aspect when it differs (reframed: narrowed
 * so the page shows at ≥ REFRAME_MIN_SCALE design px per CSS px).
 */
export function planPaneLayout(rect: Rect, opts: { variant: PlanVariant; unit: number; cssWidth: number; cssHeight: number; radius: number; top?: boolean }): PlanPaneLayout {
  const box = scaleRect(rect, opts.unit);
  const aspect = opts.cssWidth / opts.cssHeight;
  const radius = round(opts.radius * opts.unit, 3);
  if (opts.variant === 'landscape') {
    const capture = opts.top ? fitTop(box, aspect) : fitCentre(box, aspect);
    return { capture, card: { ...capture }, radius };
  }
  const paneAspect = rect.w / rect.h;
  const out: PlanPaneLayout = { capture: box, card: { ...box }, radius };
  if (Math.abs(paneAspect / aspect - 1) > 0.01) {
    let crop = paneAspect < aspect ? { w: opts.cssHeight * paneAspect, h: opts.cssHeight } : { w: opts.cssWidth, h: opts.cssWidth / paneAspect };
    const maxW = rect.w / REFRAME_MIN_SCALE;
    if (crop.w > maxW) crop = { w: maxW, h: maxW / paneAspect };
    out.crop = { w: round(crop.w, 3), h: round(crop.h, 3) };
  }
  return out;
}

function fitCentre(box: Rect, aspect: number): Rect {
  const boxAspect = box.w / box.h;
  if (Math.abs(boxAspect - aspect) < 1e-6) return { ...box };
  if (boxAspect > aspect) {
    const w = box.h * aspect;
    return { x: round(box.x + (box.w - w) / 2, 3), y: box.y, w: round(w, 3), h: box.h };
  }
  const h = box.w / aspect;
  return { x: box.x, y: round(box.y + (box.h - h) / 2, 3), w: box.w, h: round(h, 3) };
}

// ── Picture in picture: corners ───────────────────────────────────────────────

/** The corner of `main` an inset rect sits in (the nearest one). */
export function cornerOf(main: Rect, inset: Rect): InsetCorner {
  const right = inset.x + inset.w / 2 > main.x + main.w / 2;
  const bottom = inset.y + inset.h / 2 > main.y + main.h / 2;
  return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}` as InsetCorner;
}

/** The inset at each corner of `main`, with the margins of its declared position. */
export function insetCornerRects(main: Rect, inset: Rect): Record<InsetCorner, Rect> {
  const corner = cornerOf(main, inset);
  const mx = corner.endsWith('right') ? main.x + main.w - (inset.x + inset.w) : inset.x - main.x;
  const my = corner.startsWith('bottom') ? main.y + main.h - (inset.y + inset.h) : inset.y - main.y;
  const at = (c: InsetCorner): Rect => ({
    x: round(c.endsWith('right') ? main.x + main.w - mx - inset.w : main.x + mx, 3),
    y: round(c.startsWith('bottom') ? main.y + main.h - my - inset.h : main.y + my, 3),
    w: inset.w,
    h: inset.h,
  });
  return { 'bottom-right': at('bottom-right'), 'bottom-left': at('bottom-left'), 'top-right': at('top-right'), 'top-left': at('top-left') };
}

/** `r` scaled by `k` around its outer corner (the one at `corner` of the main page): it grows toward the main page's centre. */
export function growRect(r: Rect, corner: InsetCorner, k: number): Rect {
  if (k === 1) return { ...r };
  const w = r.w * k;
  const h = r.h * k;
  const x = corner.endsWith('right') ? r.x + r.w - w : r.x;
  const y = corner.startsWith('bottom') ? r.y + r.h - h : r.y;
  return { x: round(x, 2), y: round(y, 2), w: round(w, 2), h: round(h, 2) };
}

const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const expand = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

type Click = { t: number; bbox?: BBox };

/** The clicks of a step: widgets list theirs in `data.clicks`; otherwise its target at `t_click`. */
function clicksOf(ev: TimelineEvent): Click[] {
  const data = ev.data as { clicks?: Array<{ bbox?: BBox; t_click?: number }> } | undefined;
  const list = Array.isArray(data?.clicks) ? data!.clicks.filter((c) => typeof c.t_click === 'number') : [];
  if (list.length > 0) return list.map((c) => ({ t: c.t_click!, ...(c.bbox ? { bbox: c.bbox } : {}) }));
  if (ev.t_click !== undefined) return [{ t: ev.t_click, ...(ev.target?.bbox ? { bbox: ev.target.bbox } : {}) }];
  return [];
}

const goodBox = (b: BBox | undefined): b is BBox => !!b && b.w > 0 && b.h > 0;

/** Half-size (source CSS px) of the part of a wide target the viewer looks at: around the point the cursor acts on. */
export const TARGET_FOCUS_HALF = { w: 180, h: 110 } as const;

/**
 * A target box narrowed to what the viewer looks at: a target wider (taller) than the focus window — a whole table
 * row, a card — counts only around the point the step acted on (the cursor), else around its centre.
 */
export function focusBox(box: BBox, point?: { x: number; y: number }): BBox {
  const c = point ?? { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  let { x, y, w, h } = box;
  if (w > 2 * TARGET_FOCUS_HALF.w) {
    const x0 = Math.max(x, Math.min(c.x - TARGET_FOCUS_HALF.w, x + w - 2 * TARGET_FOCUS_HALF.w));
    x = x0;
    w = 2 * TARGET_FOCUS_HALF.w;
  }
  if (h > 2 * TARGET_FOCUS_HALF.h) {
    const y0 = Math.max(y, Math.min(c.y - TARGET_FOCUS_HALF.h, y + h - 2 * TARGET_FOCUS_HALF.h));
    y = y0;
    h = 2 * TARGET_FOCUS_HALF.h;
  }
  return { x, y, w, h };
}

/**
 * The leading part (top-left: where its text starts — a row's id and label) of a target wider (taller) than the focus
 * window; undefined for a target that fits it.
 */
export function leadingBox(box: BBox): BBox | undefined {
  if (box.w <= 2 * TARGET_FOCUS_HALF.w && box.h <= 2 * TARGET_FOCUS_HALF.h) return undefined;
  return { x: box.x, y: box.y, w: Math.min(box.w, 2 * TARGET_FOCUS_HALF.w), h: Math.min(box.h, 2 * TARGET_FOCUS_HALF.h) };
}

/**
 * The boxes (source CSS px) a step shows: its target, its clicks' targets, its overlay's anchor — each narrowed to
 * the part the viewer looks at (`focusBox`), plus the leading part of a wide one (`leadingBox`: what tells which row).
 */
export function stepBoxes(ev: TimelineEvent): BBox[] {
  const out: BBox[] = [];
  const point = ev.point;
  const push = (box: BBox, at?: { x: number; y: number }) => {
    const f = focusBox(box, at);
    out.push(f);
    const lead = leadingBox(box);
    if (lead && (lead.x !== f.x || lead.y !== f.y)) out.push(lead);
  };
  if (goodBox(ev.target?.bbox)) push(ev.target!.bbox!, point);
  for (const c of clicksOf(ev)) if (goodBox(c.bbox)) push(c.bbox!, point);
  if (goodBox(ev.overlay?.bbox)) push(ev.overlay!.bbox!);
  return out;
}

export interface InsetPlanInput {
  /** The steps of the clip (step ≥ 0), in time order, with their page. */
  steps: readonly TimelineEvent[];
  /** Page id of the main pane and of the inset. */
  mainPage: string;
  insetPage: string;
  /** Capture seconds → frame relative to the clip (clamped). */
  rel: (t: number) => number;
  n: number;
  fps: number;
  /** A main-page box (source CSS px) in output px at a clip frame. */
  mapMain: (frame: number, box: BBox) => Rect;
  /** The inset at each corner (output px), its declared corner and its grow factor while its page acts. */
  corners: Record<InsetCorner, Rect>;
  preferred: InsetCorner;
  grow: number;
  /** Boxes always kept clear when possible (a caption band over the screen), output px. */
  avoid?: readonly Rect[];
  /** Clearance around the boxes (output px). */
  clearance: number;
  /** The corner the inset is in at the clip's start (a clip joined to the previous one continues from its corner). */
  initial?: InsetCorner;
}

/**
 * The corners of a picture-in-picture inset over a clip: for each step, the boxes the main page shows — the step's
 * targets when it acts on the main page, and the next step's when that one does ("current and next click target") —
 * must stay uncovered; the inset keeps its corner while it covers none of them, else it glides to the free corner
 * nearest to it (the least covering one when none is free; between equals, the one the next steps leave free),
 * `INSET_LEAD_S` before the step and never sooner than `INSET_MIN_HOLD_S` after its previous move. While its own page
 * acts it does not move (the cursor is in it): a corner needed by the main-page step that follows one of the inset's
 * steps is reached after that step.
 */
export function planInsetTrack(input: InsetPlanInput): Pick<PlanInset, 'track' | 'reasons'> {
  const order: InsetCorner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
  const steps = input.steps.filter((e) => e.step >= 0 && e.status !== 'skipped');
  const lead = Math.round(INSET_LEAD_S * input.fps);
  const hold = Math.round(INSET_MIN_HOLD_S * input.fps);
  const reasons: string[] = [];
  const cost = (corner: InsetCorner, boxes: Rect[], grown: boolean): number => {
    const r = grown ? growRect(input.corners[corner], corner, input.grow) : input.corners[corner];
    const hard = boxes.reduce((s, b) => s + overlapArea(r, expand(b, input.clearance)), 0);
    const soft = (input.avoid ?? []).reduce((s, b) => s + overlapArea(r, b), 0);
    return hard * 10 + soft;
  };
  const dist = (a: InsetCorner, b: InsetCorner) => {
    const ra = input.corners[a];
    const rb = input.corners[b];
    return Math.hypot(ra.x - rb.x, ra.y - rb.y);
  };
  // Needs per step: the main page's boxes of this step and of the next one.
  const mainBoxes = (e: TimelineEvent, at: number): Rect[] => stepBoxes(e).map((b) => input.mapMain(at, b));
  const needs = steps.map((e, i) => {
    const at = clamp(input.rel(e.t_start), 0, Math.max(0, input.n - 1));
    const boxes: Rect[] = [];
    if (e.page === input.mainPage) boxes.push(...mainBoxes(e, at));
    const next = steps[i + 1];
    if (next && next.page === input.mainPage) boxes.push(...mainBoxes(next, clamp(input.rel(next.t_start), 0, Math.max(0, input.n - 1))));
    return { e, at, boxes, insetActs: e.page === input.insetPage };
  });
  const free = (c: InsetCorner, k: number) => cost(c, needs[k].boxes, needs[k].insetActs) === 0;
  /** What a corner would cover over the needs that come within a stay in it (it must not have to leave it again soon). */
  const upcoming = (c: InsetCorner, k: number) => {
    let sum = 0;
    for (let j = k + 1; j < needs.length && needs[j].at <= needs[k].at + hold + lead; j++) sum += cost(c, needs[j].boxes, needs[j].insetActs);
    return sum;
  };
  const rank = (k: number, from: InsetCorner) => (a: InsetCorner, b: InsetCorner) =>
    cost(a, needs[k].boxes, needs[k].insetActs) - cost(b, needs[k].boxes, needs[k].insetActs) || upcoming(a, k) - upcoming(b, k) || dist(from, a) - dist(from, b);
  // The first corner: free for the first steps (the preferred one when possible).
  let current: InsetCorner = input.initial ?? input.preferred;
  if (input.initial === undefined && needs.length > 0 && !free(current, 0)) {
    current = [...order].sort(rank(0, input.preferred))[0];
    reasons.push(`starts ${current}: the ${input.preferred} corner would cover step ${needs[0].e.step}'s target`);
  }
  const track: PlanInset['track'] = [{ at: 0, corner: current, rect: { ...input.corners[current] } }];
  let lastMove = -Infinity;
  for (let k = 0; k < needs.length; k++) {
    const nd = needs[k];
    if (nd.boxes.length === 0 || free(current, k)) continue;
    const best = [...order].sort(rank(k, current))[0];
    if (best === current || cost(best, nd.boxes, nd.insetActs) >= cost(current, nd.boxes, nd.insetActs)) continue;
    // Glide before the step, never while the inset's own page acts: after its previous step on that page — or, when
    // the step itself is on the inset's page (only the next, main-page step needs the corner), once it has ended.
    const prev = steps[steps.indexOf(nd.e) - 1];
    let earliest = Math.max(lastMove + hold, prev && prev.page === input.insetPage ? input.rel(stepEnd(prev)) : 0);
    if (nd.insetActs) earliest = Math.max(earliest, input.rel(stepEnd(nd.e)));
    const at = clamp(Math.max(earliest, nd.at - lead), 1, Math.max(1, input.n - 1));
    if (at >= input.n - 1) break;
    reasons.push(`→ ${best} at frame ${at}: the ${current} corner would cover step ${nd.e.step}${nd.e.page === input.mainPage ? '' : ' (next)'} target`);
    current = best;
    lastMove = at;
    track.push({ at, corner: best, rect: { ...input.corners[best] } });
  }
  return { track, reasons };
}

/**
 * The largest grow factor ≤ `grow` (by 0.01) at which the inset, at each corner of its track, stays `gap` clear of the
 * `avoid` boxes (a caption band over the screen): it grows toward the main page's centre, never into the band. A
 * corner where the inset already touches a box ungrown is left out (growing is not what covers it).
 */
export function growClearOf(track: PlanInset['track'], grow: number, avoid: readonly Rect[], gap = 0): number {
  let g = grow;
  for (const t of track) {
    const hit = (k: number) => avoid.some((a) => overlapArea(growRect(t.rect, t.corner, k), expand(a, gap)) > 0);
    if (hit(1)) continue;
    while (g > 1 && hit(g)) g = round(Math.max(1, g - 0.01), 2);
  }
  return g;
}

/**
 * The acting page over a clip: `first` from its start — the page of the scene's opening still, which the runner makes
 * the page of the first step (it acts from the scene's start, without a switch pause) —, then from each step's start (a
 * little before: the switch pause) the pane of its page. `previous`: the acting pane at the end of the clip this one is
 * joined to (no cut): the emphasis then eases from it to `first` from the clip's start.
 */
export function planActing(steps: readonly TimelineEvent[], paneOf: (page: string | undefined) => number, rel: (t: number) => number, fps: number, first: number, previous?: number): Array<{ frame: number; pane: number }> {
  const out: Array<{ frame: number; pane: number }> = previous !== undefined && previous !== first ? [{ frame: 0, pane: previous }, { frame: 1, pane: first }] : [{ frame: 0, pane: first }];
  const lead = Math.round(ACTING_LEAD_S * fps);
  for (const e of steps) {
    if (e.step < 0 || e.status === 'skipped') continue;
    const pane = paneOf(e.page);
    if (pane < 0 || pane === out[out.length - 1].pane) continue;
    const frame = Math.max(out[out.length - 1].frame + 1, rel(e.t_start) - lead);
    out.push({ frame: Math.max(0, frame), pane });
  }
  return out;
}

// ── Per frame (composition, review) ───────────────────────────────────────────

/** How much each pane acts at frame `f` (1 = acting, eased over ACTING_EASE_S at each change). */
export function actingWeights(clip: Pick<ClipSegment, 'acting' | 'panes'>, f: number, fps: number): number[] {
  const n = clip.panes?.length ?? 0;
  const out = new Array<number>(n).fill(0);
  const acting = clip.acting ?? [];
  if (n === 0) return out;
  if (acting.length === 0) {
    out[0] = 1;
    return out;
  }
  let k = 0;
  for (let i = 0; i < acting.length; i++) if (acting[i].frame <= f) k = i;
  const cur = acting[k].pane;
  const ease = Math.max(1, ACTING_EASE_S * fps);
  const t = k === 0 ? 1 : smooth((f - acting[k].frame) / ease);
  const prev = k === 0 ? cur : acting[k - 1].pane;
  out[cur] += t;
  out[prev] += 1 - t;
  return out.map((v) => round(clamp(v, 0, 1), 4));
}

/** The inset's rect at frame `f`: gliding between its corners (smoothstep over INSET_GLIDE_S), grown while its page acts. */
export function insetRectAt(clip: Pick<ClipSegment, 'inset' | 'acting' | 'panes'>, f: number, fps: number): Rect | undefined {
  const inset = clip.inset;
  if (!inset || inset.track.length === 0) return undefined;
  let k = 0;
  for (let i = 0; i < inset.track.length; i++) if (inset.track[i].at <= f) k = i;
  const cur = inset.track[k];
  let rect = cur.rect;
  if (k > 0) {
    const t = smooth((f - cur.at) / Math.max(1, INSET_GLIDE_S * fps));
    const prev = inset.track[k - 1].rect;
    const lerp = (a: number, b: number) => round(a + (b - a) * t, 2);
    rect = { x: lerp(prev.x, cur.rect.x), y: lerp(prev.y, cur.rect.y), w: lerp(prev.w, cur.rect.w), h: lerp(prev.h, cur.rect.h) };
  }
  const w = actingWeights(clip, f, fps)[inset.pane] ?? 0;
  const g = 1 + (inset.grow - 1) * w;
  return g === 1 ? { ...rect } : growRect(rect, cur.corner, g);
}

/** Pane `i`'s capture rect at frame `f` (output px): its layout's, or the inset's current one. */
export function paneCaptureAt(clip: Pick<ClipSegment, 'panes' | 'inset' | 'acting'>, i: number, f: number, fps: number): Rect {
  const pane = clip.panes![i];
  if (clip.inset?.pane === i) return insetRectAt(clip, f, fps) ?? pane.layout.capture;
  return pane.layout.capture;
}

/** The source of a pane (its page's track). */
export function paneSource(plan: Pick<EditPlan, 'tracks' | 'source'>, pane: Pick<PlanPane, 'track'>): PlanSource {
  return plan.tracks?.[pane.track] ?? plan.source;
}

/** The visible source region of pane `i` at clip frame `f`: the whole page (or its reframe crop) under its camera. */
export function paneViewOf(plan: Pick<EditPlan, 'tracks' | 'source' | 'variant'>, clip: ClipSegment, i: number, frame: number): { cx: number; cy: number; w: number; h: number } {
  const pane = clip.panes![i];
  const src = paneSource(plan, pane);
  const W = src.cssWidth;
  const H = src.cssHeight;
  const f = clamp(Math.round(frame), 0, Math.max(0, clip.durationInFrames - 1));
  const cam = pane.camera?.[f] ?? [1, W / 2, H / 2];
  const zoom = cam[0];
  let w = W / zoom;
  let h = H / zoom;
  let cx = cam[1];
  let cy = cam[2];
  if (pane.layout.crop) {
    w = pane.layout.crop.w / zoom;
    h = pane.layout.crop.h / zoom;
    const rf = pane.reframe?.[f];
    if (rf) {
      cx = rf[0];
      cy = rf[1];
    }
  }
  return { cx: clamp(cx, w / 2, W - w / 2), cy: clamp(cy, h / 2, H - h / 2), w, h };
}

/** A source rect of pane `i`'s page (CSS px; a point is 0×0) in output px at clip frame `f`. */
export function mapPaneRect(
  plan: Pick<EditPlan, 'tracks' | 'source' | 'variant' | 'fps'>,
  clip: ClipSegment,
  i: number,
  frame: number,
  rect: { x: number; y: number; w?: number; h?: number },
): Rect {
  const view = paneViewOf(plan, clip, i, frame);
  const cap = paneCaptureAt(clip, i, frame, plan.fps);
  const sx = cap.w / view.w;
  const sy = cap.h / view.h;
  const left = view.cx - view.w / 2;
  const top = view.cy - view.h / 2;
  return { x: round(cap.x + (rect.x - left) * sx, 2), y: round(cap.y + (rect.y - top) * sy, 2), w: round((rect.w ?? 0) * sx, 2), h: round((rect.h ?? 0) * sy, 2) };
}

/** The URL of pane `i` at clip frame `f`; undefined while it is a hidden (local) one (L1.7: the bar shows no address). */
export function paneUrlAt(pane: Pick<PlanPane, 'urls'>, f: number): string | undefined {
  let at: PlanPane['urls'][number] | undefined;
  for (const u of pane.urls) {
    if (u.frame <= f) at = u;
    else break;
  }
  at ??= pane.urls[0];
  return at && !at.hidden ? at.url : undefined;
}

/**
 * Whether a clip's layout draws a page URL (L1.7) — the whole clip, or pane `pane` of a multi-page clip:
 * studio/layout-browser unless both `show_url` and `tabs` are off (its tab strip names the host); studio/layout-split
 * and studio/layout-pip with `chrome` (a picture in picture: its main page only). Other layouts (card, laptop, tablet,
 * phone, raw, your own) draw none as far as the planner knows.
 */
export function drawsUrl(clip: Pick<ClipSegment, 'component' | 'inset'>, pane?: number): boolean {
  const { id, params } = clip.component;
  if (id === 'studio/layout-browser') return pane === undefined && (params.show_url !== false || params.tabs === true);
  if (id === 'studio/layout-split') return pane !== undefined && params.chrome === true;
  if (id === 'studio/layout-pip') return pane !== undefined && params.chrome === true && clip.inset?.pane !== pane;
  return false;
}

/** Every pane's rects at frame `f` (output px), as a layout component receives them (`LayoutRects.panes`). */
export function layoutPaneRectsAt(plan: Pick<EditPlan, 'tracks' | 'source' | 'fps'>, clip: ClipSegment, f: number): LayoutPaneRects[] {
  const weights = actingWeights(clip, f, plan.fps);
  return (clip.panes ?? []).map((pane, i) => {
    const screen = paneCaptureAt(clip, i, f, plan.fps);
    const isInset = clip.inset?.pane === i;
    const card = isInset ? screen : pane.layout.card;
    const out: LayoutPaneRects = { page: pane.page, screen: { ...screen }, frame: { ...card }, radius: pane.layout.radius, acting: weights[i] ?? 0 };
    if (pane.label !== undefined) out.label = pane.label;
    if (pane.layout.chrome) out.chrome = { ...pane.layout.chrome };
    if (isInset) out.inset = true;
    if (paneSource(plan, pane).mobile) out.mobile = true;
    const url = paneUrlAt(pane, f);
    if (url) out.url = url;
    return out;
  });
}

/** The pane of a page in a multi-page clip (-1 when the clip does not film it). */
export function paneIndexOf(clip: Pick<ClipSegment, 'panes'>, page: string | undefined): number {
  if (!clip.panes || page === undefined) return -1;
  return clip.panes.findIndex((p) => p.page === page);
}
