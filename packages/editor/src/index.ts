/**
 * @retake/editor — the edit planner (`planEdit`: timeline + theme + components → EditPlan, pure and
 * deterministic), the EditPlan contract shared with the compositions and the review, and the render pipeline
 * (`renderVideo` / `renderStill` / `listRenders`: Remotion bundle cache, local asset server) — docs/DESIGN-phase2.md
 * §2. The compositions themselves (src/remotion, React) are only loaded by the render bundle. The planner alone, without
 * the renderer, is the `@retake/editor/plan` entry (./plan-entry.ts): everything it exports is exported here too.
 */
export * from './plan-entry.js';
export { imageFileSize, planFileRefs, planFileUses, planInputFiles, remoteSlotUses, themeFileRefs } from './inputs.js';
export type { PlanFileUse } from './inputs.js';
export { PreviewPlanError, previewPlan } from './preview-plan.js';
export { PreviewContext, usePreviewMode, usedComponentIds } from './remotion/preview-mode.js';
export type { PreviewMode } from './remotion/preview-mode.js';
export type { PreviewPlan, PreviewPlanOptions } from './preview-plan.js';
export { RenderCancelledError, RenderDiskFullError, RenderError, isDiskFullError } from './render/types.js';
export type { RenderProgress, RenderStage } from './render/types.js';
export {
  COMPOSITION_IDS,
  FRAME_JPEG_QUALITY,
  RENDER_ENCODING,
  defaultConcurrency,
  guardEncoderPipe,
  probeMedia,
  renderPlan,
  renderStill,
  renderStills,
  renderVideo,
} from './render/render.js';
export type { RenderNetwork, RenderPathRecord, RenderPlanOptions, RenderPlanResult, RenderSeams, RenderStillOptions, RenderStillsOptions, RenderVideoOptions } from './render/render.js';
export {
  GPU_CONCURRENCY,
  RENDER_CRF,
  VIDEOTOOLBOX_BITS_PER_PIXEL,
  VIDEOTOOLBOX_MAX_SIDE,
  chooseEncoder,
  encodingRecord,
  gopFrames,
  gpuPathFailure,
  openRenderBrowser,
  previewGlKey,
  probeRenderPath,
  remotionEncoding,
  renderGpuInfo,
  renderPolicy,
  renderSandboxOff,
  renderSandboxRefusal,
  rendererWords,
  resetVideotoolboxProbes,
  resolveRenderPolicy,
  sourceWords,
  videotoolboxFits,
  videotoolboxMbps,
  videotoolboxRenderWorks,
  withGl,
} from './render/policy.js';
export type { EncoderChoice, EncoderProbe, FrameSize, PolicyBrowser, RenderPathProbe, RenderEncoder, RenderGl, RenderPolicy, RenderSettingSource, VideotoolboxProbe } from './render/policy.js';
export { PlanTrustError, editOfToday, noteEdit, planRun, preReadProblems, servedFileProblems } from './render/plan-run.js';
export type { PlanRunOptions, PlanTrust, PlannedEdit, PlannedRun } from './render/plan-run.js';
export { GUARDED_NO_OTHER_BROWSER, allowedDownload, allowedRequest, armNetworkGuard, browserProcessInfo, guardedPageFailed, guardedPageFailure, originOf, pickFreePort } from './render/network-guard.js';
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
  bundledFileProblem,
  componentFilesGuard,
  componentFolderHash,
  componentHashedFiles,
  compositionFiles,
  compositionHash,
  ensureBundle,
  entrySource,
  geometryFiles,
  listCachedBundles,
  planComponentIds,
  registryBundleComponents,
  registryModuleSource,
  renderBundleRestriction,
  withCspMeta,
} from './render/bundle.js';
export type { BundleComponent, EnsureBundleOptions, RenderBundle } from './render/bundle.js';
export { HEADLESS_SHELL_ENV, HEADLESS_SHELL_INSTALL, assertRenderBrowser, playwrightHeadlessShell, renderBrowser, renderBrowserIdentity } from './render/browser.js';
export type { RenderBrowser } from './render/browser.js';
export { PREVIEW_MOTION, buildComponentPreview, loadPreviewSamples } from './preview.js';
export type { BuildPreviewOptions, BuiltPreview, ComponentPreviewSpec, PreviewSample, PreviewSamples, PreviewScene, PreviewScreenName, PreviewTarget, PreviewUse } from './preview.js';
export { LOOP_FORMAT, PREVIEW_COMPOSITION, REMOTION_PREVIEW_BACKEND, STARTER_TEMPLATES_DIR, loadPreviewTheme, loopFrames, previewDriver, renderComponentLoops, renderComponentPreviews } from './render/preview.js';
export { createRenderer } from './render/driver.js';
export type { RenderDriverOptions } from './render/driver.js';
export type { DriverPreviewBundle, DriverPreviewSession, DriverPreviews, DriverProcess, DriverStillsRequest, DriverVideoRequest, DriverVideoResult, RenderDriver } from './render/driver-types.js';
export type {
  LoopItem,
  PreviewBackend,
  PreviewBundleMode,
  PreviewComponentTarget,
  PreviewFailure,
  PreviewRenderer,
  RenderLoopsOptions,
  RenderLoopsResult,
  RenderPreviewsOptions,
  PreviewReadmeWriter,
  RenderedLoop,
  RenderedLoopItem,
  RenderedPoster,
  RenderedPreview,
} from './render/preview.js';
export { generateTestTrack, testTrackExpression } from './render/audio.js';
export { DEFAULT_EXPORT_FORMATS, EXPORT_FORMATS, ExportError, GIF_PREVIEW, exportMethod, exportRender, exportRenderWarnings, findRenderRecord, gifWindow, mp4TranscodeArgs, recordPathProblem, transcodeMp4 } from './render/export.js';
export type { ExportFormat, ExportOutput, ExportProgress, ExportRenderOptions, ExportResult } from './render/export.js';
