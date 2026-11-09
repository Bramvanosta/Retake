/**
 * `@retake/editor/plan` — the editor without its renderer: the edit planner (`planEdit`: timeline + theme + components
 * → EditPlan, pure and deterministic) and the modules it is made of, the EditPlan contract, the frame geometry the
 * compositions and the review share (where a layout, a pane, an overlay or the brand mark sits on a frame), the views
 * of a plan (summary, timeline) and the render record's type. No module reachable from here imports the renderer,
 * Remotion, React or the file system (test/plan-entry.test.ts walks the imports); a review imports the editor only
 * through this entry (scripts/audit/lib.mjs R8).
 */
export * from './plan-types.js';
export { planEdit, PlanError, MUSIC_DEFAULTS, CONTIGUOUS_GAP_S, CLEAR_LOOKAHEAD_S, DEFAULT_ZOOM, REFRAME_CLICK_WINDOW_S, markDoneAt, musicFile, musicPlays, musicSpecOf, reframeTargets } from './plan.js';
export type { PlanEditInput, PlanInputFile } from './plan.js';
export { TRACK_GLIDE_S, TUTORIAL_TIMING, eventClicks, loupeRegion, planBadgeNumbers, planClipTutorial, planProgress, stepNavigates, tutorialReframeTargets, tutorialRequested, tutorialStateOf } from './tutorial.js';
export {
  DEFAULT_IDLE_THRESHOLD_S,
  IDLE_KEEP_S,
  MARK_WINDOW_S,
  QUICK_RUN_SPEED,
  SPEED_RAMP_S,
  WAIT_ACTIONS,
  WAIT_KEEP_S,
  WAIT_LOADING_MIN_S,
  WAIT_MIN_S,
  WAIT_SPEED,
  loadsBesideOtherPages,
  planRunTiming,
  protectedSpans,
  outFrameAt,
  quickRunSpans,
  waitingSpans,
} from './timing.js';
export type { MapPiece, ProtectedSpan, RunTiming, RunTimingInput } from './timing.js';
export { MIN_ZOOM_EASE_S, REFRAME, cameraTrack, clampView, corridorSmooth, dampedSmooth, hintEase, leadingPart, reframeTrack } from './camera.js';
export type { ReframeTarget, ZoomMove } from './camera.js';
export { DESIGN_SPACES, FALLBACK_GEOMETRY, RAW_GEOMETRY, REFRAME_MIN_SCALE, fitRect, mapSourceRect, planLayout, viewOf } from './layout.js';
export type { SourceView } from './layout.js';
export { BUILTIN_DEFAULTS, TRANSITION_COMPONENTS, transitionKindOf } from './resolve.js';
export { resolvePlanAssets, summarizePlan } from './summary.js';
export { placePins, reasonOf, timelineOf } from './timeline.js';
export type {
  CutReason,
  PinThread,
  PlacedPin,
  TimelineCaption,
  TimelineComponent,
  TimelineCut,
  TimelineMarker,
  TimelineModel,
  TimelineOptions,
  TimelineSegment,
  TimelineSpeed,
  TimelineStep,
  TimelineZoom,
} from './timeline.js';
export { isRenderRecord, readRenderRecords } from './render-record.js';
export type { RenderRecord, RenderRecordReader } from './render-record.js';
// The frame geometry of src/remotion/frames.ts is renderer-free (no React, no Remotion): the compositions draw with it,
// the review checks frames with it.
export { OVERLAY_BOX_MARGIN, brandmarkRect, captionBandOver, drawnOverlayBox, duckSpans, insetHole, layoutRects, loupePlacement, mapUseRect, overlayAvoid, overlayBoxAt, overlayRects, overlayTargets, plateOf, playsSound, shortcutRow, shortcutSlot, musicPlayGain, musicVolumeAt, srcFrameAt, standInTransition, staysInInset, trackBoxAt, trackKeysAt, transitionWindows, urlAt, useScreen } from './remotion/frames.js';
export type { TransitionWindow } from './remotion/frames.js';
export {
  ACTING_EASE_S,
  ACTING_LEAD_S,
  INSET_GLIDE_S,
  INSET_GROW,
  INSET_LEAD_S,
  INSET_MIN_HOLD_S,
  TARGET_FOCUS_HALF,
  actingWeights,
  cornerOf,
  drawsUrl,
  fitTop,
  focusBox,
  growRect,
  insetCornerRects,
  insetRectAt,
  layoutPaneRectsAt,
  mapPaneRect,
  paneCaptureAt,
  paneIndexOf,
  paneSource,
  paneUrlAt,
  paneViewOf,
  planActing,
  planInsetTrack,
  planPaneLayout,
  stepBoxes,
} from './panes.js';
export type { InsetPlanInput } from './panes.js';
