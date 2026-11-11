/**
 * Layout geometry: the layout component's manifest geometry (design space 1920×1080, 1080×1920 for the vertical
 * variant, 1080×1080 for the square one) scaled by `unit`, with the capture fitted to its aspect ratio — and the mapping of source CSS px to output
 * px through the layout and the camera (overlay anchors, review). Pure.
 */
import type { LayoutGeometry } from '@retake/components/geometry';
import type { CameraFrame, EditPlan, PlanLayout, PlanSegment, PlanVariant, Rect } from './plan-types.js';
import { clamp, round } from './util.js';

/** Geometry used when the layout component is missing or declares none (the reference "card" look). */
export const FALLBACK_GEOMETRY: Readonly<Record<PlanVariant, LayoutGeometry>> = {
  landscape: {
    screen: { x: 180, y: 40, w: 1560, h: 878 },
    caption: { x: 180, y: 930, w: 1220, h: 110 },
    brandmark: { x: 1420, y: 965, w: 320, h: 40 },
    radius: 18,
  },
  vertical: {
    screen: { x: 40, y: 560, w: 1000, h: 563 },
    caption: { x: 40, y: 1135, w: 1000, h: 220 },
    brandmark: { x: 700, y: 1840, w: 340, h: 40 },
    radius: 18,
  },
  square: {
    screen: { x: 40, y: 35, w: 1000, h: 758 },
    caption: { x: 40, y: 805, w: 1000, h: 160 },
    brandmark: { x: 700, y: 1010, w: 340, h: 40 },
    radius: 18,
  },
};

/** Design space of each variant (layout geometry and every size a component draws, before `unit`). */
export const DESIGN_SPACES: Readonly<Record<PlanVariant, { width: number; height: number }>> = {
  landscape: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

/**
 * Reframed variants (vertical, square) show the capture at least this many design px per CSS px when the layout
 * reframes it (its screen rect has another aspect than the capture): a square card would otherwise show a whole
 * 1920-px page at 0.7× — text too small on a phone. The crop is then narrower and follows the action.
 */
export const REFRAME_MIN_SCALE = 0.9;

/** Names of the rects of an evaluated geometry that leave the design space of the variant. */
export function geometryOutside(g: LayoutGeometry, variant: PlanVariant): string[] {
  const d = DESIGN_SPACES[variant];
  const space = { w: d.width, h: d.height };
  const eps = 0.5;
  const out: string[] = [];
  for (const name of ['screen', 'frame', 'chrome', 'caption', 'brandmark'] as const) {
    const r = g[name];
    if (!r) continue;
    if (r.w <= 0 || r.h <= 0 || r.x < -eps || r.y < -eps || r.x + r.w > space.w + eps || r.y + r.h > space.h + eps) out.push(name);
  }
  return out;
}

/** Full-frame geometry (frame style `raw` without a component). */
export const RAW_GEOMETRY: Readonly<Record<PlanVariant, LayoutGeometry>> = {
  landscape: { screen: { x: 0, y: 0, w: 1920, h: 1080 }, radius: 0 },
  vertical: { screen: { x: 0, y: 0, w: 1080, h: 1920 }, radius: 0 },
  square: { screen: { x: 0, y: 0, w: 1080, h: 1080 }, radius: 0 },
};

function scale(r: Rect, unit: number): Rect {
  return { x: round(r.x * unit, 3), y: round(r.y * unit, 3), w: round(r.w * unit, 3), h: round(r.h * unit, 3) };
}

/** `aspect` (w/h) fitted inside `box`, centred. */
export function fitRect(box: Rect, aspect: number): Rect {
  const boxAspect = box.w / box.h;
  if (Math.abs(boxAspect - aspect) < 1e-6) return { ...box };
  if (boxAspect > aspect) {
    const w = box.h * aspect;
    return { x: round(box.x + (box.w - w) / 2, 3), y: box.y, w: round(w, 3), h: box.h };
  }
  const h = box.w / aspect;
  return { x: box.x, y: round(box.y + (box.h - h) / 2, 3), w: box.w, h: round(h, 3) };
}

/**
 * PlanLayout from a layout geometry. Landscape: the capture is fitted inside the screen rect (letterboxed by the
 * card/device when the aspect ratios differ); the card is the declared frame, else the fitted capture. Vertical and
 * square: the capture region with the screen rect's aspect ratio (`crop`, source CSS px) fills the screen rect — the
 * whole capture when the aspects match, else a reframe (the largest such region, narrowed so the capture shows at
 * least REFRAME_MIN_SCALE design px per CSS px) whose centre follows `ClipSegment.reframe`.
 */
export function planLayout(
  geometry: LayoutGeometry,
  opts: { variant: PlanVariant; unit: number; cssWidth: number; cssHeight: number; radius?: number; fallback?: boolean },
): PlanLayout {
  const screen = scale(geometry.screen, opts.unit);
  const aspect = opts.cssWidth / opts.cssHeight;
  const out: PlanLayout = { capture: screen, card: screen, radius: round((opts.radius ?? geometry.radius ?? 0) * opts.unit, 3) };
  if (opts.variant === 'landscape') {
    out.capture = fitRect(screen, aspect);
    out.card = geometry.frame ? scale(geometry.frame, opts.unit) : out.capture;
    // Letterboxed / pillarboxed (the capture aspect is outside what the layout's screen can take): keep the screen
    // rect so the layout paints the bars with the theme background.
    if (Math.abs(out.capture.w - screen.w) > 1 || Math.abs(out.capture.h - screen.h) > 1) out.display = { ...screen };
  } else {
    out.capture = screen;
    out.card = geometry.frame ? scale(geometry.frame, opts.unit) : screen;
    const screenAspect = geometry.screen.w / geometry.screen.h;
    let crop = screenAspect < aspect ? { w: opts.cssHeight * screenAspect, h: opts.cssHeight } : { w: opts.cssWidth, h: opts.cssWidth / screenAspect };
    const reframed = Math.abs(screenAspect / aspect - 1) > 0.01;
    const maxW = geometry.screen.w / REFRAME_MIN_SCALE;
    if (reframed && crop.w > maxW) crop = { w: maxW, h: maxW / screenAspect };
    out.crop = { w: round(crop.w, 3), h: round(crop.h, 3) };
  }
  if (geometry.chrome) out.chrome = scale(geometry.chrome, opts.unit);
  if (geometry.caption) out.caption = scale(geometry.caption, opts.unit);
  if (geometry.brandmark) out.brandmark = scale(geometry.brandmark, opts.unit);
  if (opts.fallback) out.fallback = true;
  return out;
}

/** The source region (CSS px: centre and size) visible in the capture rect at one frame of a clip. */
export interface SourceView {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/**
 * The visible source region of frame `frame` (relative) of a clip: the whole capture (landscape) or the crop
 * centred on the reframe track (vertical, square), divided by the camera zoom around the camera centre, clamped
 * inside the capture.
 */
export function viewOf(plan: Pick<EditPlan, 'source' | 'variant'>, clip: Extract<PlanSegment, { kind: 'clip' }>, frame: number): SourceView {
  const W = plan.source.cssWidth;
  const H = plan.source.cssHeight;
  const f = clamp(Math.round(frame), 0, Math.max(0, clip.durationInFrames - 1));
  const cam: CameraFrame = clip.camera?.[f] ?? [1, W / 2, H / 2];
  const zoom = cam[0];
  let w = W / zoom;
  let h = H / zoom;
  let cx = cam[1];
  let cy = cam[2];
  if (plan.variant !== 'landscape' && clip.layout.crop) {
    w = clip.layout.crop.w / zoom;
    h = clip.layout.crop.h / zoom;
    const rf = clip.reframe?.[f];
    if (rf) {
      cx = rf[0];
      cy = rf[1];
    }
  }
  return { cx: clamp(cx, w / 2, W - w / 2), cy: clamp(cy, h / 2, H - h / 2), w, h };
}

/** A source rectangle (CSS px; a point is a 0×0 rect) mapped to output px at one frame of a clip. */
export function mapSourceRect(
  plan: Pick<EditPlan, 'source' | 'variant'>,
  clip: Extract<PlanSegment, { kind: 'clip' }>,
  frame: number,
  rect: { x: number; y: number; w?: number; h?: number },
): Rect {
  const view = viewOf(plan, clip, frame);
  const cap = clip.layout.capture;
  const sx = cap.w / view.w;
  const sy = cap.h / view.h;
  const left = view.cx - view.w / 2;
  const top = view.cy - view.h / 2;
  return {
    x: round(cap.x + (rect.x - left) * sx, 2),
    y: round(cap.y + (rect.y - top) * sy, 2),
    w: round((rect.w ?? 0) * sx, 2),
    h: round((rect.h ?? 0) * sy, 2),
  };
}
