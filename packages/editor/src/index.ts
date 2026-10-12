/**
 * @demo-studio/editor — the edit planner (`planEdit`: timeline + theme + components → EditPlan, pure and
 * deterministic), the EditPlan contract shared with the compositions and the review, and the render pipeline
 * (`renderVideo` / `renderStill` / `listRenders`: Remotion bundle cache, local asset server) — docs/DESIGN-phase2.md
 * §2. The compositions themselves (src/remotion, React) are only loaded by the render bundle.
 */
export * from './plan-types.js';
export { planEdit, PlanError, MUSIC_DEFAULTS, CONTIGUOUS_GAP_S, DEFAULT_ZOOM, REFRAME_CLICK_WINDOW_S, musicFile, musicPlays, musicSpecOf, reframeTargets } from './plan.js';
export type { PlanEditInput } from './plan.js';
export { DEFAULT_IDLE_THRESHOLD_S, IDLE_KEEP_S, MARK_WINDOW_S, SPEED_RAMP_S, planRunTiming, protectedSpans, outFrameAt } from './timing.js';
export type { MapPiece, ProtectedSpan, RunTiming, RunTimingInput } from './timing.js';
export { MIN_ZOOM_EASE_S, REFRAME, cameraTrack, clampView, corridorSmooth, dampedSmooth, hintEase, reframeTrack } from './camera.js';
export type { ReframeTarget, ZoomMove } from './camera.js';
export { DESIGN_SPACES, FALLBACK_GEOMETRY, RAW_GEOMETRY, REFRAME_MIN_SCALE, fitRect, mapSourceRect, planLayout, viewOf } from './layout.js';
export type { SourceView } from './layout.js';
export { BUILTIN_DEFAULTS, TRANSITION_COMPONENTS, transitionKindOf } from './resolve.js';
export { resolvePlanAssets, summarizePlan } from './summary.js';
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
export type { RenderPlanOptions, RenderPlanResult, RenderStillOptions, RenderStillsOptions, RenderVideoOptions } from './render/render.js';
export { findRun, listRenders, nextVersion, rendersDir, reserveVersion, runScenario, takenVersions } from './render/runs.js';
export type { RunRef } from './render/runs.js';
export { CONTENT_TYPES, parseRange, startAssetServer } from './render/asset-server.js';
export type { AssetServer } from './render/asset-server.js';
export {
  BUNDLE_CACHE_KEEP,
  scaffoldComponents,
  BUNDLE_FORMAT,
  COMPOSITION_DEPS,
  EDITOR_DIR,
  bundleCacheDir,
  bundleComponentsFor,
  bundleHash,
  compositionFiles,
  ensureBundle,
  entrySource,
  listCachedBundles,
  planComponentIds,
  registryModuleSource,
} from './render/bundle.js';
export type { BundleComponent, EnsureBundleOptions, RenderBundle } from './render/bundle.js';
export { HEADLESS_SHELL_ENV, playwrightHeadlessShell, renderBrowser } from './render/browser.js';
export type { RenderBrowser } from './render/browser.js';
export { brandmarkRect, envelopeAt, layoutRects, musicPlayGain, musicVolumeAt, srcFrameAt, transitionWindows, urlAt } from './remotion/frames.js';
export type { TransitionWindow } from './remotion/frames.js';
export { buildComponentPreview, loadPreviewSamples } from './preview.js';
export type { BuildPreviewOptions, BuiltPreview, ComponentPreviewSpec, PreviewSample, PreviewSamples, PreviewScene, PreviewScreenName, PreviewTarget, PreviewUse } from './preview.js';
export { PREVIEW_COMPOSITION, STARTER_TEMPLATES_DIR, loadPreviewTheme, renderComponentPreviews } from './render/preview.js';
export type { PreviewComponentTarget, RenderPreviewsOptions, RenderedPreview } from './render/preview.js';
export { generateTestTrack, testTrackExpression } from './render/audio.js';
export { DEFAULT_EXPORT_FORMATS, EXPORT_FORMATS, ExportError, GIF_PREVIEW, exportRender, findRenderRecord, gifWindow } from './render/export.js';
export type { ExportFormat, ExportOutput, ExportProgress, ExportRenderOptions, ExportResult } from './render/export.js';
