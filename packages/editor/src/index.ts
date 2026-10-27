/**
 * @demo-studio/editor — the edit planner (`planEdit`: timeline + theme + components → EditPlan, pure and
 * deterministic), the EditPlan contract shared with the compositions and the review, and the render pipeline
 * (`renderVideo` / `renderStill` / `listRenders`: Remotion bundle cache, local asset server) — docs/DESIGN-phase2.md
 * §2. The compositions themselves (src/remotion, React) are only loaded by the render bundle.
 */
export * from './plan-types.js';
export { planEdit, PlanError, MUSIC_DEFAULTS, CONTIGUOUS_GAP_S, CLEAR_LOOKAHEAD_S, DEFAULT_ZOOM, REFRAME_CLICK_WINDOW_S, markDoneAt, musicFile, musicPlays, musicSpecOf, reframeTargets } from './plan.js';
export type { PlanEditInput, PlanInputFile } from './plan.js';
export { TRACK_GLIDE_S, TUTORIAL_TIMING, eventClicks, loupeRegion, planBadgeNumbers, planClipTutorial, planProgress, stepNavigates, tutorialReframeTargets, tutorialRequested, tutorialStateOf } from './tutorial.js';
export { imageFileSize, planFileRefs, planFileUses, planInputFiles, remoteSlotUses, themeFileRefs } from './inputs.js';
export type { PlanFileUse } from './inputs.js';
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
export { PreviewPlanError, previewPlan } from './preview-plan.js';
export { PreviewContext, usePreviewMode, usedComponentIds } from './remotion/preview-mode.js';
export type { PreviewMode } from './remotion/preview-mode.js';
export type { PreviewPlan, PreviewPlanOptions } from './preview-plan.js';
export { RenderCancelledError, RenderError } from './render/types.js';
export type { RenderProgress, RenderRecord, RenderStage } from './render/types.js';
export {
  COMPOSITION_IDS,
  FRAME_JPEG_QUALITY,
  RENDER_ENCODING,
  VARIANT_SUFFIX,
  defaultConcurrency,
  probeMedia,
  renderPlan,
  renderStill,
  renderStills,
  renderVideo,
} from './render/render.js';
export type { RenderNetwork, RenderPlanOptions, RenderPlanResult, RenderStillOptions, RenderStillsOptions, RenderVideoOptions } from './render/render.js';
export { PlanTrustError, editOfToday, noteEdit, planRun, preReadProblems, servedFileProblems } from './render/plan-run.js';
export type { PlanRunOptions, PlanTrust, PlannedEdit, PlannedRun } from './render/plan-run.js';
export { allowedDownload, allowedRequest, armNetworkGuard, browserProcessInfo, originOf, pickFreePort } from './render/network-guard.js';
export type { BrowserProcessInfo, NetworkAllowList, NetworkGuard } from './render/network-guard.js';
export { THEME_FILES_MAX, THEME_HASH_BYTES_MAX, themeContentHash, themeStatSignature } from './render/theme-hash.js';
export { findRun, listRenders, nextVersion, rendersDir, reserveVersion, runEnv, runScenario, takenVersions, versionLockFile } from './render/runs.js';
export type { RunRef } from './render/runs.js';
export { CONTENT_TYPES, parseRange, startAssetServer } from './render/asset-server.js';
export type { AssetServer } from './render/asset-server.js';
export {
  BUNDLE_CACHE_KEEP,
  scaffoldComponents,
  BUNDLE_CSP,
  BUNDLE_FORMAT,
  COMPOSITION_DEPS,
  EDITOR_DIR,
  bundleCacheDir,
  bundleComponentsFor,
  bundleHash,
  componentFolderHash,
  compositionFiles,
  ensureBundle,
  entrySource,
  listCachedBundles,
  planComponentIds,
  registryModuleSource,
  withCspMeta,
} from './render/bundle.js';
export type { BundleComponent, EnsureBundleOptions, RenderBundle } from './render/bundle.js';
export { HEADLESS_SHELL_ENV, playwrightHeadlessShell, renderBrowser } from './render/browser.js';
export type { RenderBrowser } from './render/browser.js';
export { OVERLAY_BOX_MARGIN, brandmarkRect, captionBandOver, drawnOverlayBox, duckSpans, insetHole, layoutRects, loupePlacement, mapUseRect, overlayAvoid, overlayBoxAt, overlayRects, overlayTargets, plateOf, playsSound, shortcutRow, shortcutSlot, musicPlayGain, musicVolumeAt, srcFrameAt, standInTransition, staysInInset, trackBoxAt, trackKeysAt, transitionWindows, urlAt, useScreen } from './remotion/frames.js';
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
export type { TransitionWindow } from './remotion/frames.js';
export { buildComponentPreview, loadPreviewSamples } from './preview.js';
export type { BuildPreviewOptions, BuiltPreview, ComponentPreviewSpec, PreviewSample, PreviewSamples, PreviewScene, PreviewScreenName, PreviewTarget, PreviewUse } from './preview.js';
export { PREVIEW_COMPOSITION, STARTER_TEMPLATES_DIR, loadPreviewTheme, renderComponentPreviews } from './render/preview.js';
export type { PreviewComponentTarget, RenderPreviewsOptions, RenderedPreview } from './render/preview.js';
export { generateTestTrack, testTrackExpression } from './render/audio.js';
export { DEFAULT_EXPORT_FORMATS, EXPORT_FORMATS, ExportError, GIF_PREVIEW, exportMethod, exportRender, findRenderRecord, gifWindow, recordPathProblem } from './render/export.js';
export type { ExportFormat, ExportOutput, ExportProgress, ExportRenderOptions, ExportResult } from './render/export.js';
