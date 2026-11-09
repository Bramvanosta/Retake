/**
 * Where the kit's React elements sit on a frame, as plain numbers (no React, no Remotion): the fit of a full-frame file
 * and the edge of a phone drawn around an inset page. The elements (media.tsx, panes.tsx) draw with them; the edit
 * planner and the review read them through `@retake/components/geometry`.
 */

/** How a file fills its box. */
export type MediaFitMode = 'cover' | 'contain';

/** `fit: auto` covers when the crop keeps at least this share of the file's width and height, else contains. */
export const AUTO_COVER_MIN_SHARE = 0.8;

/**
 * The fit of `fit: auto` (the default of a full-frame file): `cover` when the file has about the shape of the box —
 * covering keeps ≥ `AUTO_COVER_MIN_SHARE` of each side —, else `contain`: a 16:9 intro in the vertical variant, or a
 * square image in a 16:9 video, shows whole on the background instead of losing most of itself. Unknown size: cover.
 */
export function autoFit(media: { width?: number; height?: number }, box: { w: number; h: number }): MediaFitMode {
  if (!media.width || !media.height || box.w <= 0 || box.h <= 0) return 'cover';
  const a = media.width / media.height;
  const b = box.w / box.h;
  return Math.min(a, b) / Math.max(a, b) >= AUTO_COVER_MIN_SHARE ? 'cover' : 'contain';
}

/** Band + bezel width of a phone drawn around a display `h` tall (as the kit's phone cards: 1.7 % + 0.6 %). */
export function insetPhoneEdge(displayH: number): number {
  return Math.round(displayH * 0.017) + Math.round(displayH * 0.006);
}
