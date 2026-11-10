/**
 * @retake/engine — the typed, in-process API shared by the CLI and the MCP server (L3.1). Part A: workspace and
 * project loading (moved from the CLI), projects / scenarios / runs / auth / sandbox reads, `if_match` saves, a local
 * storage abstraction and typed EngineError codes for clients outside the CLI. Part B: the run executor shared by
 * `retake run` and the jobs worker, the job queue under <workspace>/.retake/jobs and the worker. Part C: hooks
 * outside a capture (moved from the CLI), `hooks` / `env_reset` jobs, and human approvals of hooks for work submitted
 * through MCP (trust `mcp`, fingerprints taken at submit and checked by the worker). Part D: sign-ins and sandbox
 * up / reset as jobs (login moved from the CLI; shell seed steps approved like hooks), the job history and an
 * entitlements stub. L3.2 part A: renders as jobs (plan in the client's process through the trust gates, render in
 * the worker with the network guard), render status, the render history. Part B: reviews and exports as jobs (renders named by id, their files inside the project; export
 * re-renders under the render trust rules), review_get reading report.json as data, thumbnails made on read. L3.6:
 * the frame comment store (one file per thread, entries appended under a lock, stills machine-local). L4.1: the local
 * HTTP servers' security gate, 127.0.0.1 listener, tokens and bootstrap codes, discovery file, error → status map, and
 * the client `ui` (agent trust); reads never follow a symbolic link out of a project; the workspace index
 * (index-db/: node:sqlite, a cache of the files for the Studio's activity feed and search), the bounded stat poll of
 * the workspace's sources and the job watch behind the Studio's event stream.
 */
export { openWorkspace, openProject } from './workspace.js';
export type { OpenedWorkspace, WorkspaceOptions } from './workspace.js';
export { personaState, personaStateView, projectPersonaStates, scenarioPersonaStates, tildePath } from './auth.js';
export type { LoginCommandOf, PersonaState, PersonaStateView } from './auth.js';
export { ENGINE_ERROR_CODES, EngineError, toEngineError } from './errors.js';
export type { EngineErrorCode } from './errors.js';
export { checkProjectSlug, checkRunId, checkScenarioName } from './refs.js';
export { LocalStorage, READ_TEXT_MAX_BYTES, checkRef, sha256Hex } from './storage.js';
export type { Storage, StoredKind, StoredRef, WriteResult } from './storage.js';
export { ProjectStore, fileWriter, personScope } from './store/project-store.js';
export type { FolderStage, StoreScope, StoreWriteOptions } from './store/project-store.js';
export { JOURNAL_FILES_MAX, JOURNAL_VERSION, appendJournal, hookEntry, hookRunRecorder, journalFile, journalPath, readJournal } from './store/journal.js';
export type { HookRunResult, JournalBy, JournalEntry, JournalHook, JournalQuery, JournalWhat, JournalWrite } from './store/journal.js';
export { README_MAX_CHARS, createProjectFromRequest, writeNewProject, firstErrorLine, listProjectSummaries, maskUrlCredentials, openProjectBySlug, projectView, updateProjectReadme } from './projects.js';
export type { CreateProjectRequest, EnvironmentView, PersonaView, ProjectSummary, ProjectView } from './projects.js';
export { editScenario, getScenario, knownScenarioVersion, prepareScenarioEdit, saveScenarioText, scenarioEditBlocker, validateScenarioText } from './scenarios.js';
export { SLOW_SCRUB_KEYFRAME_S, captureInfo, clearTimelineViewMemo, memoRegistry, timelineView } from './timeline-view.js';
export type { FieldChoice, TimelineCaptureInfo, TimelineView, TimelineViewRequest, TimelineViewResult } from './timeline-view.js';
export { FRAME_STYLE_OPTIONS, MULTI_PAGE_OPTIONS, TRANSITION_KIND_OPTIONS, componentUseOf, fieldFitProblem, fieldOptions, videoPages } from './field-options.js';
export type { FieldOption } from './field-options.js';
export type { PreparedScenarioEdit, SaveResult, ScenarioEdit, ScenarioEditRequest, ScenarioEditResult, ScenarioText, ValidateResult } from './scenarios.js';
export { draftFromScript } from './authoring.js';
export { RECORD_KEEP, RECORD_MAX_ENV, activeRecords, defaultRecordName, newRecordId, pruneRecords, recordDir, recordMaxMs, recordScenario, recordStart, recordsRoot } from './record.js';
export type { RecordCheck, RecordOutcome, RecordPorts, RecordRequest, RecordStart } from './record.js';
export { RECORD_META_FILE, RECORD_STUDIO_FILE, RECORD_UNSAVED_KEEP_MS, readRecordAnnotations, readRecordMeta, recordLockFile } from './record-files.js';
export type { RecordMeta } from './record-files.js';
export { RECORD_EVENTS_MAX_BYTES, RECORD_LIST_MAX, checkAgentCancel, readRecordEvents, recordAnnotate, recordDiscard, recordList, recordLive, recordSave, recordStop, recordView, saveRecordedDraft } from './record-studio.js';
export type { RecordAnnotated, RecordCheckView, RecordDiscarded, RecordListItem, RecordSaved, RecordState, RecordStopped, RecordTargetOption, RecordView, RecordZoomView } from './record-studio.js';
export type { ScriptDraftView } from './authoring.js';
export { listRuns, runStatus } from './runs.js';
export type { RunStatusView, RunSummary } from './runs.js';
export { RUN_FRAME_NAME_RE, RunFolder, TRACK_FRAMES_RE, TRACK_VIDEO_RE, readPlainRange } from './run-files.js';
export type { RangeRead, RunFileProblem, RunFileRead } from './run-files.js';
export { RunData, RunDataCache, errorScreenshotName, frameAt, gridFrame, parseFrameIndex, runPictures, seekTime, stepScreenshotName } from './run-data.js';
export type { FrameIndex, PageSource } from './run-data.js';
export { RUN_KEY_RE, RUN_THUMBS_MAX_KEYS, RUN_THUMBS_RESPONSE_MAX, RunThumbs, SCREENSHOT_MAX, Semaphore, THUMB_BASE64_MAX, THUMB_CACHE_BYTES } from './run-thumbs.js';
export type { RunThumb, RunThumbsOptions, RunThumbsView, ThumbMissingReason, ThumbSource } from './run-thumbs.js';
export { ScenarioViews, VIEW_ISSUES_MAX, VIEW_RUNS_MAX, VIEW_STEPS_MAX } from './scenario-view.js';
export { BOARD_RUNS_WINDOW, BOARD_SCENARIOS_MAX, BOARD_TITLE_MAX, FILE_FACTS_TTL_MS, ProjectBoards } from './project-board.js';
export type { BoardRun, BoardScenario, ProjectBoardContext, ProjectBoardView, RunPoster } from './project-board.js';
export type { EditAbility, SceneFacts, ScenarioActions, ScenarioEnvironmentFacts, ScenarioRunChoice, ScenarioSource, ScenarioView, ScenarioViewContext, StepBinding } from './scenario-view.js';
export { sandboxStatus } from './sandbox.js';
export type { SandboxStatusView } from './sandbox.js';
export { ENGINE_API_VERSION, agentTrust, createEngine } from './engine.js';
export {
  ENGINE_TRUST,
  admits,
  agentChecks,
  agentWorkspace,
  anchorsOnShownRender,
  callerOf,
  chainsRecordings,
  cleansWorkerEnv,
  drivesRecordScreen,
  editsThemes,
  guardsStudioRecordings,
  needsIfMatch,
  proposes,
  refusalChannel,
  speaksAsPerson,
  submittedInStudio,
  submitterChannel,
} from './caller.js';
export type { Caller, CallerChannel, CallerTrust } from './caller.js';
export { EXPORTS_OPEN_MAX, SUBMIT_RULES, admission, confirmWhy, opChain, sessionsToConfirm } from './admission.js';
export type { Admission, AdmissionDeps, OpChain, PreparedTake, RunAdmit, SessionToConfirm, SessionsView } from './admission.js';
export type { AuthStatus, AuthStatusItem, Engine, EngineClient, EngineInfo, EngineOptions, InspectSubmitted, PreviewSubmitted, RecordSubmitted, CompactRunStatus, RunJobView, RunListItem, RunStatusWithJob, ScenarioCheck, ScenarioSessions, WaitOptions } from './engine.js';
export { formatMs, sandboxUpText } from './format.js';
export { signalInterrupts } from './interrupts.js';
export type { InterruptOptions, InterruptPort, InterruptScope } from './interrupts.js';
export { RunOptionError, SandboxTakeError, checkAllowWrites, checkSandboxEnv, executeRun, pickSandboxEnv, prepareRun, writesSummary } from './execute-run.js';
export type { ExecuteRunOptions, PreparedRun, RunPorts, RunRequest } from './execute-run.js';
// The pipeline calls a shell makes itself (renderWork / stillWork / exportWork: through the in-process functions below).
export { defaultStillFile, editorErrorOf, findRenderOf, findRunOf, planWork, reviewWork } from './pipeline.js';
export { exportInProcess, inspectInProcess, renderInProcess, runInProcess, stillInProcess } from './in-process.js';
// The renderer port, and the product's renderer for a composition root (a shell's command run in process).
export { editorRenderer } from './render/editor-renderer.js';
// Component previews on a handed renderer (a shell's `components preview` and `components create`).
export { previewsWork } from './render/work.js';
export type { OnRenderer } from './render/work.js';
export type {
  PreviewBundle,
  PreviewBundleRequest,
  PreviewOpenRequest,
  PreviewRendering,
  PreviewSession,
  RenderProcess,
  RenderRequestBase,
  RenderStillsRequest,
  RenderVideoRequest,
  RenderVideoResult,
  Renderer,
  RendererFailure,
} from './render/renderer.js';
export type { EditOverrides, ExportFormat, ExportProgress, ExportResult, PlannedRun, RenderProgress, RenderRecord, ReviewResult, RunRef } from './pipeline.js';
export { newJobId } from './jobs/ids.js';
export type { CancelMark, ClaimRecord, DeriveOptions, JobFileRead, JobFilter, JobMark, JobPosition, JobQueue, JobQueueView, TakeHold, YieldMark } from './jobs/job-queue.js';
export { jobProject } from './jobs/queue-core.js';
export { FileJobQueue, JobFiles } from './jobs/queue.js';
export { jobsDir, stateDir } from './workspace-state.js';
export { MemoryJobQueue } from './jobs/memory-queue.js';
export type { MemoryJobQueueOptions } from './jobs/memory-queue.js';
export { WORKER_CLIENT_RE, WorkerLock, liveWorker, otherCopy, readWorkerLock, workerLockFile, workersDir } from './jobs/lock.js';
export type { WorkerLockRecord } from './jobs/lock.js';
export { buildDirs, buildStamp } from './jobs/build.js';
export { isAlive, processStart, selfIdentity } from './jobs/proc.js';
export type { ProcessIdentity } from './jobs/proc.js';
export { PAUSE_MAX_ENV, executeRunJob, finaliseReservedRun, pauseMaxMs, preflightJournal, runBlockers, runCommandLine } from './jobs/run-job.js';
export { LIVE_FILE_VERSION, LIVE_FRAME_MAX_BYTES, LIVE_IDLE_MS, LIVE_PATH, LIVE_SOCKETS_MAX, LIVE_STREAMS_MAX, encodeRecord, openLiveChannel, openLiveFeed, readLiveChannel } from './jobs/live-channel.js';
export type { LiveChannel, LiveChannelInfo, LiveFeedFrame, LiveFrameHeader } from './jobs/live-channel.js';
export {
  checkEnvName,
  envResetCommandLine,
  executeEnvResetJob,
  executeHooksJob,
  hookResultView,
  hooksCommandLine,
  submitEnvResetJob,
  submitHooksJob,
} from './jobs/hooks-job.js';
export type { EnvResetSubmitRequest, HooksSubmitRequest } from './jobs/hooks-job.js';
export { HooksSourceError, createHookContext, hooksAccess, selectHooks } from './hooks.js';
export type { HookContextOptions, HookSelection } from './hooks.js';
export { APPROVAL_FORM_MAX_CHARS, APPROVAL_HOOK_MAX_CHARS, PRUNE_FORM_MAX_LINES, approvalChecker, approvalFormText, approvalItemTitle, preflightHooks, pruneApprovalFormText, pruneApprovalRequest, pruneKindsText, refusedError, takeApprovals, takePruneApproval, takeSiteApproval } from './approvals.js';
export type { ApprovalItem, ApprovalOutcome, ApprovalRequest, Approver, Preflight, PruneApprovalRequest, SiteApprovalRequest } from './approvals.js';
export type { RunBlocker, RunBlockerKind, RunSubmitRequest } from './jobs/run-job.js';
export { ensureWorker, otherCopyWarning, spawnWorker, workerCommand } from './jobs/spawn.js';
export type { WorkerSpawnFn, WorkerSpawnOptions } from './jobs/spawn.js';
export { WORKER_ENV_DROPPED, cleanWorkerEnv } from './jobs/worker-env.js';
export type { WorkerEnvOptions } from './jobs/worker-env.js';
export { runWorker } from './jobs/worker.js';
export { BEAT_MS, CAP_CARRY_MS, FilmingMarker, FilmingWatch, HELD_FILE, HOLD_MAX_MIN, TakeBeside, heldFile, isTakeOwnerCommand, workerHolds, MARKER_MAX_BYTES, MARKER_NAME_RE, STALE_MS, ancestorPids, capMinutes, capturesDir, capturesLocation, workspaceCaptureId } from './jobs/captures.js';
export type { FilmingState, FilmingWatchOptions, LiveTake, MarkerRecord, TakeBesideReport } from './jobs/captures.js';
// What a take reports to its filming callback: the runner's types, re-exported so that the CLI's `retake run` names them
// without importing the runner (a shell imports no adapter: the import rules' R4, scripts/audit/lib.mjs).
export type { FilmingEvent, FilmingReport } from '@retake/runner-web';
export { heldWork, heldWorkWords, yieldWords } from './jobs/held.js';
export type { HeldWork } from './jobs/held.js';
export { QosYield, REWALK_MS, parseQosTable, qosTable, taskpolicy, treeOf } from './jobs/yield.js';
export type { QosDeps, QosProc } from './jobs/yield.js';
export { killTree, ownProcessGroup, signalTree, signalablePid } from './jobs/signal.js';
export type { KillFn } from './jobs/signal.js';
export { pick, takeWaiting } from './jobs/pick.js';
export type { PickContext, PickRecord } from './jobs/pick.js';
export { JOB_EXIT, runJobChild } from './jobs/job-child.js';
export { jobProcessCommand } from './jobs/spawn.js';
export type { WorkerOptions } from './jobs/worker.js';
export { FINISHED_JOB_STATES, JOB_RECORD_VERSION } from './jobs/types.js';
export type {
  AuthLoginJobResult,
  SandboxJobResult,
  EnvResetJobResult,
  HookResultView,
  HooksJobResult,
  JobErrorView,
  JobEvent,
  JobEventBody,
  JobProgress,
  JobRecord,
  JobYield,
  JobResult,
  JobWorkerInfo,
  ExportJobResult,
  ExportOutputView,
  LibraryEntryView,
  LibraryJobView,
  PreviewImageView,
  PreviewJobResult,
  InspectJobResult,
  RecordJobResult,
  RenderJobResult,
  ReviewJobResult,
  RunJobResult,
  SiteCandidateResult,
  SiteJobResult,
} from './jobs/types.js';
export { LoginOptionError, loginTarget, signInPersona } from './login.js';
export type { SignInOutcome, SignInPorts } from './login.js';
export { AUTH_HEADED_MAX_ENV, AUTH_HEADED_MAX_MS, cancelSignIn, executeAuthLoginJob, headedSignInMaxMs, loginCommandLine, signInStoppedText, submitAuthLoginJob, withTimeLimit } from './jobs/auth-job.js';
export type { AuthLoginSubmitRequest } from './jobs/auth-job.js';
export { executeSandboxJob, sandboxCommandLine, submitSandboxJob } from './jobs/sandbox-job.js';
export {
  EDIT_SNAPSHOT_FILE,
  checkRenderRequest,
  cleanupInterruptedRender,
  executeRenderJob,
  killRecordedBrowser,
  planRenderRequest,
  releaseRenderLock,
  removePartials,
  renderCommandLine,
  renderJobEditText,
  reviewInline,
} from './jobs/render-job.js';
export type { InlineReview, LatestRunNotice, PassedOverRuns, RecordedBrowser, RenderEditSource, RenderRequest } from './jobs/render-job.js';
export { SCENARIO_RENDERS_MAX, failureWords, planPreview, planSignature, renderForWork, renderStatus, reportReads, scenarioRenders, withoutPaths } from './renders.js';
export { cleanupInterruptedReview, executeReviewJob, reviewCommandLine, submitReviewJob } from './jobs/review-job.js';
export type { ReviewRequest } from './jobs/review-job.js';
export { DEFAULT_JOB_EXPORT_FORMATS, cleanupInterruptedExport, executeExportJob, exportCommandLine } from './jobs/export-job.js';
export type { ExportRequest } from './jobs/export-job.js';
export { REVIEW_IMAGE_BASE64_MAX, REVIEW_IMAGE_MAX_PX, REVIEW_IMAGE_RE, REVIEW_IMAGE_SOURCE_MAX, reviewGet, reviewImage, thumbnail } from './reviews.js';
export { THEME_PREVIEW_KINDS, executePreviewJob, libraryStatesOf, previewCommandLine, previewDir, submitPreviewJob } from './jobs/preview-job.js';
export type { PreviewJobTestHooks, PreviewRequest } from './jobs/preview-job.js';
export {
  LIBRARY_CACHE_MAX_BYTES,
  LIBRARY_CACHE_MAX_ENTRIES,
  LIBRARY_DISK_MIN_BYTES,
  LIBRARY_FILES,
  LIBRARY_PREVIEW_FORMAT,
  LIBRARY_REASON_MAX,
  LIBRARY_TMP_MAX_AGE_MS,
  checkLibraryDisk,
  commitLibraryEntry,
  diskSentence,
  dropLibraryEntry,
  ensureLibraryCacheDir,
  isEditorialStarter,
  currentEntry,
  failureIsCurrent,
  libraryCacheDir,
  libraryKeyContext,
  libraryPreviewKey,
  libraryRegistryHash,
  libraryStates,
  plainLibraryCacheDir,
  pruneLibraryCache,
  readLibraryEntry,
  readLibraryImage,
  stageLibraryEntry,
} from './library.js';
export type { LibraryEntry, LibraryEntryMeta, LibraryFailure, LibraryItemState, LibraryKeyContext, LibraryLoopState, LibraryPosterState, LibraryPreviewKind, LibraryStatesView } from './library.js';
export {
  INSPECT_KEEP,
  activeInspections,
  executeInspectJob,
  inspectCommandLine,
  inspectDir,
  inspectResult,
  inspectRoot,
  markBoxes,
  newInspectId,
  pageOfUrl,
  prepareInspect,
  pruneInspections,
  readInspection,
  runInspection,
  submitInspectJob,
} from './jobs/inspect-job.js';
export type { InspectSourceDraft, InspectSubmitRequest, InspectionOptions, InspectionRun, PreparedInspect } from './jobs/inspect-job.js';
export { RECORD_DRAFT_MAX, executeRecordJob, readRecording, recordCommandLine, recordResult, submitRecordJob } from './jobs/record-job.js';
export type { RecordJobContext, RecordJobTestHooks, RecordSubmitRequest } from './jobs/record-job.js';
export { checkComponentId, componentCreate, componentWriter, componentGet, componentList, componentValidate } from './components.js';
export type { ComponentCreateRequest, ComponentCreated, ComponentListView, ComponentSummary, ComponentValidationView, ComponentView } from './components.js';
export { checkTemplateName, templateGet, templateList, themeAssetProblems, themeForWork } from './templates.js';
export type { TemplateDetail, TemplateListView, TemplateSummary } from './templates.js';
export { THEME_USES_STATS, editTemplate, knownThemeVersion, templateView, themeEditList, themeFileProblem } from './theme-edit.js';
export type { ThemeComponentView, ThemeEditList, ThemeEditRequest, ThemeEditResult, ThemeEditView, ThemeEditable, ThemeListItem } from './theme-edit.js';
export { THEME_COPY_MAX_BYTES, THEME_COPY_MAX_FILES, copyTheme } from './brand/copy.js';
export type { ThemeCopied } from './brand/copy.js';
export { BRAND_LIST_MAX_DEPTH, BRAND_LIST_MAX_ENTRIES, BRAND_LIST_MAX_FILES, brandFileList } from './brand/file-list.js';
export type { BrandFileList } from './brand/file-list.js';
export { siteList } from './site-list.js';
export type { SiteList, SiteListEntry } from './site-list.js';
export type { ReviewFindingView, ReviewImageRef, ReviewImageView, ReviewImagesMode, ReviewView } from './reviews.js';
export type { PlanPreviewSegment, PlanPreviewView, RenderJobView, RenderQueueView, RenderReviewSummary, RenderStatusView, ScenarioRenderJobView, ScenarioRenderView, ScenarioRendersView } from './renders.js';
export type { SandboxJobKind, SandboxSubmitRequest } from './jobs/sandbox-job.js';
export { HISTORY_VERSION, appendHistory, historyFile, runCounted, usageCounts } from './history.js';
export type { HistoryEntry, UsageCounts } from './history.js';
export {
  COMMENT_COUNT_MAX_FOLDERS,
  COMMENT_FILE_MAX_BYTES,
  COMMENT_LIST_MAX_FILES,
  COMMENT_LOCK_WAIT_MS,
  CommentIndex,
  MCP_AUTHOR_NAME,
  PROPOSAL_CONTEXT_LINES,
  addComment,
  anchorAt,
  applyProposal,
  checkCommentId,
  commentLockFile,
  commentRef,
  commentStillFile,
  defaultAuthorName,
  getComment,
  getProposal,
  listComments,
  prepareComment,
  proposalForPreview,
  reopenComment,
  replyComment,
  resolveComment,
  timecodeOf,
} from './comments.js';
export {
  RENDER_FRAME_BASE64_MAX,
  RENDER_FRAME_CACHE_BYTES,
  RENDER_FRAME_MAX_PX,
  RENDER_FRAME_QUEUE_MAX,
  RENDER_FRAME_TIMEOUT_MS,
  RENDER_OUTLINE_MARKERS_MAX,
  RenderFrames,
} from './render-frames.js';
export type { RenderFrameRequest, RenderFrameView, RenderFramesOptions, RenderOutlineRequest, RenderOutlineView } from './render-frames.js';
export { DEFAULT_KEEP_RENDERS, formatBytes, pruneKey, pruneProject } from './prune.js';
export type { PruneItem, PruneRequest, PruneResult } from './prune.js';
export type {
  CommentAddRequest,
  CommentAdded,
  CommentAnchorRequest,
  CommentAnchorView,
  CommentApplied,
  CommentApplyRequest,
  CommentCountsView,
  CommentEntryView,
  CommentProposalSummary,
  CommentProposalView,
  CommentListRequest,
  CommentListView,
  CommentPrepareRequest,
  CommentResolveRequest,
  CommentSummary,
  CommentView,
  CommentWritten,
  PreparedComment,
  ProposalPreview,
  ProposalRow,
} from './comments.js';
export { PROPOSAL_ROWS_MAX, buildProposal, checkProposedText, diffRows, proposalRowsProblem, rebuildProposal } from './comment-proposals.js';
export type { BuiltProposal, ProposalInput } from './comment-proposals.js';
export { ENGINE_HTTP_API, BODY_DRAIN_MAX, BodyTooLargeError, FRAME_SRC_RE, PERMISSIONS_POLICY, STUDIO_CSP, allowedHosts, allowedOrigins, checkRequest, drainBody, fromBrowser, isJsonType, readBody, securityHeaders, studioCsp } from './http/gate.js';
export { MCP_HTTP_TOKEN_FILE, mcpHttpTokenFile, privateFileProblem, readPrivateText, readPrivateToken, replacePrivateFile, stableToken } from './http/token-file.js';
export type { GateOptions, GateRequest, GateResult, GateStatus, RouteSpec } from './http/gate.js';
export { BOOTSTRAP_CODES_MAX, BOOTSTRAP_CODE_TTL_MS, BootstrapCodes, bearerToken, newSecret, secretEquals } from './http/token.js';
export { LOOPBACK, isLoopbackAddress, listenLoopback } from './http/listen.js';
export { ERROR_STATUS } from './http/status.js';
export { DISCOVERY_VERSION, claimDiscovery, discoveryFile, holderAlive, readDiscovery, readStudioToken, releaseDiscovery, releaseStudioToken, studioTokenDir, studioTokenFile, tokenHolderAlive, writeStudioToken } from './http/discovery.js';
export type { DiscoveryClaim, DiscoveryRecord, StudioTokenRecord } from './http/discovery.js';
export { INDEX_SCHEMA, RUNS_INDEX_MAX, WorkspaceIndex, ftsQuery, indexFile } from './index-db/index-db.js';
export type { ActivityItem, HistoryRow, IndexChanges, IndexOptions, IndexRebuild, SearchHit } from './index-db/index-db.js';
export { SQLITE_WARNING, isCorruptionError, loadSqlite } from './index-db/sqlite.js';
export type { SqliteLoader, SqliteModule } from './index-db/sqlite.js';
export { COMMENT_SOURCE_MAX_FOLDERS, diffSources, runChanges, scanSources, sourceKey, workspaceChanges } from './index-db/sources.js';
export type { RunChange, RunRow, SourceKind, SourceMap } from './index-db/sources.js';
export { JobsWatch } from './index-db/jobs-watch.js';
export { entitlements } from './entitlements.js';
export type { Entitlements } from './entitlements.js';
export { SHELL_SEED_REASON, agentChannel, checkAgentTrust, seedApprovalItems } from './approvals.js';
export { checkNewProjectHosts, checkWorkspaceProtection, protectedHostOf, setProtectedHostResolver, workspaceProtectedHosts } from './protected-hosts.js';
export type { HostLookup, ProtectedHostHit, WorkspaceProtectedHost } from './protected-hosts.js';
export { APPROVALS_USED_DIR, APPROVAL_KEY_FILE, approvalKeyFile, approvalsOf, approvalsUsedDir, consumeApprovals, pruneUsedApprovals, recordDigest, restoreApprovals, signApprovals, verifiedApprovals } from './jobs/signing.js';
export { DEFAULT_BRAND_BASE, PACKAGE_ROOT, THEME_PROVENANCE_FILE, createThemeFromBrand, fileNameFace, replaceProblem } from './brand/create.js';
export type { ThemeCreateOptions, ThemeCreated, ThemeFontView } from './brand/create.js';
export { SITE_KEEP, checkSiteUrl, executeSiteJob, extractSiteForAuthor, isSiteWarning, makeSiteDir, newSiteId, pruneSites, readSite, siteApproved, siteCommandLine, siteDir, siteDraft, siteHostConflicts, siteRoot, siteView, submitSiteJob } from './jobs/site-job.js';
export type { SiteJobContext, SiteSubmitted } from './jobs/site-job.js';
export {
  BRAND_TOTAL_MAX_BYTES,
  FONT_MAX_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  IMAGE_MIN_HEIGHT,
  SVG_MAX_BYTES,
  WEIGHT_NAMES,
  brandSourceProblem,
  checkImage,
  fontCopyName,
  rasterInfo,
  readBrandFile,
  scanSvg,
  sniffFont,
  standardWeight,
} from './brand/files.js';
export type { BrandFileKind, BrandTrust, FontFormat, FontInfo, ImageInfo, ResolvedBrandFile, SvgScan } from './brand/files.js';
