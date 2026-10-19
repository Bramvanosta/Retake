/**
 * @demo-studio/engine — the typed, in-process API shared by the CLI and the MCP server (L3.1). Part A: workspace and
 * project loading (moved from the CLI), projects / scenarios / runs / auth / sandbox reads, `if_match` saves, a local
 * storage abstraction and typed EngineError codes for clients outside the CLI. Part B: the run executor shared by
 * `studio run` and the jobs worker, the job queue under <workspace>/.demo-studio/jobs and the worker. Part C: hooks
 * outside a capture (moved from the CLI), `hooks` / `env_reset` jobs, and human approvals of hooks for work submitted
 * through MCP (trust `mcp`, fingerprints taken at submit and checked by the worker). Part D: sign-ins and sandbox
 * up / reset as jobs (login moved from the CLI; shell seed steps approved like hooks), the job history and an
 * entitlements stub. L3.2 part A: renders as jobs (plan in the client's process through the trust gates, render in
 * the worker with the network guard), render status, the render history. Part B: reviews and exports as jobs (renders named by id, their files inside the project; export
 * re-renders under the render trust rules), review_get reading report.json as data, thumbnails made on read. L3.6:
 * the frame comment store (one file per thread, entries appended under a lock, stills machine-local).
 */
export { openWorkspace, openProject } from './workspace.js';
export type { WorkspaceOptions } from './workspace.js';
export { personaState, personaStateView, projectPersonaStates, tildePath } from './auth.js';
export type { LoginCommandOf, PersonaState, PersonaStateView } from './auth.js';
export { ENGINE_ERROR_CODES, EngineError, toEngineError } from './errors.js';
export type { EngineErrorCode } from './errors.js';
export { RUN_ID_RE, checkProjectSlug, checkRunId, checkScenarioName } from './refs.js';
export { LocalStorage, checkRef, sha256Hex } from './storage.js';
export type { Storage, StoredKind, StoredRef, WriteResult } from './storage.js';
export { createProjectFromRequest, listProjectSummaries, maskUrlCredentials, openProjectBySlug, projectView, updateProjectReadme } from './projects.js';
export type { CreateProjectRequest, EnvironmentView, PersonaView, ProjectSummary, ProjectView } from './projects.js';
export { getScenario, saveScenarioText, validateScenarioText } from './scenarios.js';
export type { SaveResult, ScenarioText, ValidateResult } from './scenarios.js';
export { draftFromScript } from './authoring.js';
export { RECORD_KEEP, RECORD_MAX_ENV, activeRecords, defaultRecordName, newRecordId, pruneRecords, recordDir, recordMaxMs, recordScenario, recordStart, recordsRoot } from './record.js';
export type { RecordCheck, RecordOutcome, RecordPorts, RecordRequest, RecordStart } from './record.js';
export type { ScriptDraftView } from './authoring.js';
export { listRuns, runStatus } from './runs.js';
export type { RunStatusView, RunSummary } from './runs.js';
export { sandboxStatus } from './sandbox.js';
export type { SandboxStatusView } from './sandbox.js';
export { ENGINE_API_VERSION, createEngine } from './engine.js';
export type { AuthStatus, AuthStatusItem, Engine, EngineClient, EngineInfo, EngineOptions, InspectSubmitted, PreviewSubmitted, RecordSubmitted, RunJobView, RunListItem, RunStatusWithJob, WaitOptions } from './engine.js';
export { formatMs, sandboxUpText } from './format.js';
export { signalInterrupts } from './interrupts.js';
export type { InterruptOptions, InterruptPort, InterruptScope } from './interrupts.js';
export { RunOptionError, SandboxTakeError, checkAllowWrites, checkSandboxEnv, executeRun, pickSandboxEnv, prepareRun, writesSummary } from './execute-run.js';
export type { ExecuteRunOptions, PreparedRun, RunPorts, RunRequest } from './execute-run.js';
export { newJobId } from './jobs/ids.js';
export { FileJobQueue, jobProject, jobsDir, stateDir } from './jobs/queue.js';
export type { ClaimRecord, JobFilter } from './jobs/queue.js';
export { WorkerLock, liveWorker, readWorkerLock, workerLockFile, workersDir } from './jobs/lock.js';
export type { WorkerLockRecord } from './jobs/lock.js';
export { buildDirs, buildStamp } from './jobs/build.js';
export { isAlive, processStart, selfIdentity } from './jobs/proc.js';
export type { ProcessIdentity } from './jobs/proc.js';
export { executeRunJob, finaliseReservedRun, preflightJournal, runCommandLine, submitRunJob } from './jobs/run-job.js';
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
export { approvalChecker, preflightHooks, refusedError, takeApprovals, takeSiteApproval } from './approvals.js';
export type { ApprovalItem, ApprovalOutcome, ApprovalRequest, Approver, Preflight, SiteApprovalRequest } from './approvals.js';
export type { RunSubmitRequest } from './jobs/run-job.js';
export { ensureWorker, spawnWorker, workerCommand } from './jobs/spawn.js';
export { runWorker } from './jobs/worker.js';
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
  JobResult,
  JobWorkerInfo,
  ExportJobResult,
  ExportOutputView,
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
export { executeAuthLoginJob, loginCommandLine, submitAuthLoginJob } from './jobs/auth-job.js';
export type { AuthLoginSubmitRequest } from './jobs/auth-job.js';
export { executeSandboxJob, sandboxCommandLine, submitSandboxJob } from './jobs/sandbox-job.js';
export {
  checkRenderRequest,
  cleanupInterruptedRender,
  executeRenderJob,
  killRecordedBrowser,
  parseRenderId,
  planRenderRequest,
  releaseRenderLock,
  removePartials,
  renderCommandLine,
  submitRenderJob,
} from './jobs/render-job.js';
export type { RecordedBrowser, RenderRequest } from './jobs/render-job.js';
export { planPreview, renderForWork, renderStatus } from './renders.js';
export { cleanupInterruptedReview, executeReviewJob, reviewCommandLine, submitReviewJob } from './jobs/review-job.js';
export type { ReviewRequest } from './jobs/review-job.js';
export { DEFAULT_JOB_EXPORT_FORMATS, cleanupInterruptedExport, executeExportJob, exportCommandLine, submitExportJob } from './jobs/export-job.js';
export type { ExportRequest } from './jobs/export-job.js';
export { reviewGet, thumbnail } from './reviews.js';
export { THEME_PREVIEW_KINDS, executePreviewJob, previewCommandLine, previewDir, submitPreviewJob } from './jobs/preview-job.js';
export type { PreviewRequest } from './jobs/preview-job.js';
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
export { checkComponentId, componentCreate, componentGet, componentList, componentValidate } from './components.js';
export type { ComponentCreateRequest, ComponentCreated, ComponentListView, ComponentSummary, ComponentValidationView, ComponentView } from './components.js';
export { checkTemplateName, templateGet, templateList, themeAssetProblems, themeForWork } from './templates.js';
export type { TemplateDetail, TemplateListView, TemplateSummary } from './templates.js';
export type { ReviewFindingView, ReviewImageRef, ReviewImagesMode, ReviewView } from './reviews.js';
export type { PlanPreviewSegment, PlanPreviewView, RenderJobView, RenderQueueView, RenderStatusView } from './renders.js';
export type { SandboxJobKind, SandboxSubmitRequest } from './jobs/sandbox-job.js';
export { HISTORY_VERSION, appendHistory, historyFile, runCounted, usageCounts } from './history.js';
export type { HistoryEntry, UsageCounts } from './history.js';
export {
  COMMENT_FILE_MAX_BYTES,
  COMMENT_LIST_MAX_FILES,
  COMMENT_LOCK_WAIT_MS,
  MCP_AUTHOR_NAME,
  addComment,
  checkCommentId,
  commentLockFile,
  commentRef,
  commentStillFile,
  defaultAuthorName,
  getComment,
  listComments,
  reopenComment,
  replyComment,
  resolveComment,
} from './comments.js';
export type { CommentAddRequest, CommentAdded, CommentEntryView, CommentListRequest, CommentListView, CommentResolveRequest, CommentView, CommentWritten } from './comments.js';
export { entitlements } from './entitlements.js';
export type { Entitlements } from './entitlements.js';
export { SHELL_SEED_REASON, checkAgentTrust, seedApprovalItems } from './approvals.js';
export { checkNewProjectHosts, checkWorkspaceProtection, protectedHostOf, workspaceProtectedHosts } from './protected-hosts.js';
export type { WorkspaceProtectedHost } from './protected-hosts.js';
export { APPROVAL_KEY_FILE, approvalKeyFile, approvalsOf, signApprovals, verifiedApprovals } from './jobs/signing.js';
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
