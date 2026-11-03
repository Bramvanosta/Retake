/**
 * @retake/ui — the Studio web app and its server (L4.1, R-UI-01): `retake ui` serves a React app, bundled in memory
 * by esbuild, and the engine's `/v1` HTTP API of one workspace on 127.0.0.1 behind the engine's gate; the app calls an
 * allow-list of the MCP server's tools through the same SDK-free tool layer (`callTool`). The MCP server never depends
 * on this package: it keeps working without it.
 */
export { APP_ENTRY, INDEX_HTML, UI_TARGETS, buildUi } from './bundle.js';
export type { UiAsset } from './bundle.js';
export { CALL_BODY_MAX, SMALL_BODY_MAX, UI_OPS, startStudioServer, uiTools } from './server/studio.js';
export type { StudioServer, StudioServerOptions, UiOp } from './server/studio.js';
export { EVENT_KEEPALIVE_MS, EVENT_POLL_MS, EVENT_STREAMS_MAX, Live, noIndexError, sseText } from './server/live.js';
export type { LiveOptions } from './server/live.js';
export { EDIT_OPS, INDEX_OPS, LIVE_OPS, OWN_OPS, PreviewLeases, RENDER_OPS, REVIEW_IMAGES_MAX, RUN_OPS, SCENARIO_OPS, TIMELINE_LEASE_TTL_MS, TIMELINE_OPS, boardOp, confirmWhy, editOps, indexOps, liveOps, overviewOp, renderOps, reviewAnswer, runOps, scenarioOps, sessionsToConfirm, timelineOps } from './server/ops.js';
export type { ProjectOverview, RenderReviewAnswer, ScenarioRenderAnswer, ScenarioRunAnswer, PreviewHeld, SessionToConfirm, TimelineViewAnswer } from './server/ops.js';
export { COMMENT_OPS, THREADS_LIST_MAX, THREAD_ENTRIES_SHOWN, THREAD_ITEM_TEXT_MAX, commentOps, pathFree, proposalOffer, threadAnswer, threadItem } from './server/comment-ops.js';
export type { OfferFacts, ProposalAnswer, ProposalOffer, ThreadAnswer, ThreadApplyAnswer, ThreadGetAnswer, ThreadItem, ThreadsListAnswer } from './server/comment-ops.js';
export { opChain, scenarioKey } from './server/op-chain.js';
export { LIBRARY_IMAGES_ANSWER_MAX, LIBRARY_OPS, LIBRARY_VIEW_MEMO_MAX, LOOP_DATA_MAX, POSTER_DATA_MAX, componentAnswer, libraryOps } from './server/library-ops.js';
export type { LibraryComponentAnswer, LibraryImage, LibraryImagesAnswer, LibraryItem, LibraryParam, LibraryRenderAnswer, LibrarySlot, LibraryViewAnswer } from './server/library-ops.js';
export { THEME_OPS, themeOps, themePreview } from './server/theme-ops.js';
export { RECORD_OPS, recordOps, recordPathFree, recordViewAnswer } from './server/record-ops.js';
export { RECORD_WATCH_PER_PROJECT, RECORD_WATCH_PROJECTS_MAX, recordsChanges, recordsWatchScan } from './server/record-watch.js';
export type { RecordEnvironmentOption, RecordOptionsAnswer, RecordPersonaOption, RecordStartAnswer, RecordViewAnswer } from './server/record-ops.js';
export type { SiteListAnswer, ThemeListAnswer, ThemeOpsOptions, ThemePreviewAnswer } from './server/theme-ops.js';
export { WATCH_DEPTH_MAX, WATCH_ENTRIES_MAX, WATCH_FOLDERS_MAX, WATCH_SCAN_BUDGET, componentNamespaceSignatures, libraryChanges, libraryWatchScan, siteSignature, themeSignatures, treeSignature, watchBudget } from './server/library-watch.js';
export type { OpChain } from './server/op-chain.js';
export {
  JsonlTail,
  LIVE_LINE_MAX,
  LIVE_OUTLINE_MAX,
  LIVE_READ_CHUNK,
  LIVE_SNAPSHOT_LOG_LINES,
  LIVE_TAIL_MAX,
  LIVE_TEXT_MAX,
  RUN_LIVE_POLL_MS,
  RUN_LIVE_STREAMS_MAX,
  RunLive,
  RunLiveInput,
  URL_MASK,
  maskUrls,
  mergeByTime,
  scrubber,
  viewJobEvent,
  viewProgress,
} from './server/run-live.js';
export type { LiveItem, PictureState, RunLiveOptions, RunLiveRequest, Scrub } from './server/run-live.js';
export { PREVIEW_DISPLAY_PATHS, isPreviewDisplayText } from './player/protocol.js';
export { COMPONENT_PREVIEW_FORMAT, DEFAULT_SCOPE, PLAYER_FILES_MAX, checkPreviewSpec, PLAYER_PLANS_KEEP, PLAYER_PLAN_MAX, PLAYER_SCOPES_MAX, frameCsp, frameHtml, servedName, startPlayerServer } from './server/player.js';
export type { PlayerServer, PlayerServerOptions, PublishedPreview } from './server/player.js';
export { COMPONENT_FILE_MAX, PLAYER_BUNDLES_KEEP, PLAYER_BUNDLE_FORMAT, PlayerBundles, buildPlayerBundle, playerBundleHash, playerComponentSet, playerComponents, workspaceComponents } from './player/bundle-player.js';
export type { PlayerBundle, PreviewAllowed, WorkspaceComponent } from './player/bundle-player.js';
export { COMPONENT_HASH_RE, PREVIEW_ALLOW_MAX, PreviewAllowList } from './server/preview-allow.js';
export { studioWorkerEnv } from './server/worker-env.js';
export { launchStudio } from './server/launch.js';
export { TAB_ID_RE, UNSAVED_ITEMS_MAX, UNSAVED_KINDS, UNSAVED_OPS, UNSAVED_TABS_MAX, UnsavedBoard, UnsavedReportInput, unsavedOps } from './server/unsaved.js';
export type { UnsavedItem, UnsavedKind } from './server/unsaved.js';
export {
  JOB_END_PER_MIN,
  PENDING_GAP_MS,
  PIPE_KINDS,
  PIPE_LINE_MAX,
  PIPE_LIST_MAX,
  PIPE_OUTCOMES,
  PIPE_POLL_MS,
  PIPE_PROJECT_RE,
  PIPE_REASONS,
  PIPE_SCENARIO_RE,
  Supervisor,
  jobEndLine,
  jobNames,
  jobOutcome,
  pendingLine,
  pipeKind,
  startSupervisor,
} from './server/supervise.js';
export type { JobEnd, PendingSnapshot, PipeJob, PipeKind, PipeOut, PipeOutcome, PipeReason, SupervisorOptions } from './server/supervise.js';
export type { Launched } from './server/launch.js';
export { DESKTOP_OPS, DesktopAnswerInput, DesktopPipe, QUIT_ID_RE, SHOWN_PER_MIN, desktopOps } from './server/desktop.js';
