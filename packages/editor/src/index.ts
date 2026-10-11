/**
 * @demo-studio/editor — the edit planner (`planEdit`: timeline + theme + components → EditPlan, pure and
 * deterministic) and the EditPlan contract shared with the compositions and the review (docs/DESIGN-phase2.md §2).
 * Rendering (Remotion) arrives in L2.4.
 */
export * from './plan-types.js';
export { planEdit, PlanError, MUSIC_DEFAULTS, CONTIGUOUS_GAP_S } from './plan.js';
export type { PlanEditInput } from './plan.js';
export { DEFAULT_IDLE_THRESHOLD_S, IDLE_KEEP_S, MARK_WINDOW_S, SPEED_RAMP_S, planRunTiming, protectedSpans, outFrameAt } from './timing.js';
export type { MapPiece, ProtectedSpan, RunTiming, RunTimingInput } from './timing.js';
export { MIN_ZOOM_EASE_S, cameraTrack, clampView, hintEase, reframeTrack } from './camera.js';
export type { ZoomMove } from './camera.js';
export { FALLBACK_GEOMETRY, RAW_GEOMETRY, fitRect, mapSourceRect, planLayout, viewOf } from './layout.js';
export type { SourceView } from './layout.js';
export { BUILTIN_DEFAULTS, TRANSITION_COMPONENTS, transitionKindOf } from './resolve.js';
export { resolvePlanAssets, summarizePlan } from './summary.js';
