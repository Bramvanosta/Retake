/**
 * `@retake/components/geometry` — the components without a renderer: where things sit on a frame and the pure pieces of
 * the component contract the edit planner reads. The kit's frame geometry (the fit of a full-frame file, the phone
 * edge of an inset page, the caption band, the safe area, the loupe and step badge, the shortcut plate, the camera
 * easings), layout geometry expressions and anchors, slot filling, theme tokens, CSV tables and the contract's types.
 *
 * Every module reachable from here imports no package and no Node module at run time (type imports only): the
 * planner (`@retake/editor/plan`) and the review load it without React, Remotion or esbuild, and the compositions'
 * bundles (render and the Studio's player) take it into a browser page (test/geometry-entry.test.ts walks the
 * imports). Components themselves import only `@retake/components/kit`, which exports the same frame helpers.
 */
export { AUTO_COVER_MIN_SHARE, autoFit, insetPhoneEdge } from './kit/frame-geometry.js';
export type { MediaFitMode } from './kit/frame-geometry.js';
export { captionBandBox } from './kit/devices.js';
export type { CaptionBandInput } from './kit/devices.js';
export { BUTTON_LABEL_MIN, buttonColors, inkOn, safeAreaRect } from './kit/style.js';
export { loupeLens, stepBadgeBox } from './kit/place.js';
export type { LoupePlacement } from './kit/place.js';
export { shortcutPlateBox, shortcutPlateLayout, shortcutPlateMetrics } from './kit/keys.js';
export { CAMERA_EASINGS, cubicBezier } from './kit/easing.js';
export type { Bezier, EasingFn } from './kit/easing.js';
export { ANCHOR_KEYS, GEOMETRY_KEYS, evalAnchor, evalLayoutGeometry, isMultiPaneGeometry, paramEnums } from './geometry.js';
export { fillSlots } from './slots.js';
export type { SlotContext } from './slots.js';
export { fontFileFace, themeTokens } from './theme.js';
export { parseCsv } from './data.js';
export { ARTEFACT_SLOT_TYPES } from './types.js';
export type {
  AnchorSpec,
  ArtefactSlotType,
  CaptionCue,
  ComponentManifest,
  LayoutGeometry,
  LayoutPaneRects,
  LayoutRects,
  MediaValue,
  PictureMedia,
  ProgressChapter,
  ResolvedComponentRef,
  ThemeTokens,
} from './types.js';
export type { ComponentRegistry } from './registry.js';
