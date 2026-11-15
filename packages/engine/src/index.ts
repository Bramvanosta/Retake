/**
 * @retake/engine — the engine's façade for its shells (the CLI, the MCP server, the Studio server): `createEngine`, its
 * errors and the types of what it takes and answers. The values a shell still calls in process (its composition root's
 * ports, the job queue and the worker, the local HTTP servers' gate, views and words it formats) are the
 * `@retake/engine/shell` entry; the operation contract, the catalogue, the integrations and the machine checks have
 * their own entries (`/contract`, `/catalogue`, `/integrations`, `/doctor`); the values only other packages' tests use
 * are `@retake/engine/testing`. A value no other package imports is in no entry: the engine's own tests import it from
 * its file. packages/engine/test/engine-entries.test.ts holds what each entry may hold.
 */
export type { InitResult } from './init-workspace.js';
export type { FileValidation, FileValidationOptions } from './validate-files.js';
export type { OpenedWorkspace, WorkspaceOptions } from './workspace.js';
export type { LoginCommandOf, PersonaState, PersonaStateView, RecheckOptions, SessionRecheck } from './auth.js';
export { ENGINE_ERROR_CODES, EngineError, toEngineError } from './errors.js';
export type { EngineErrorCode } from './errors.js';
export type { Storage, StoredKind, StoredRef, WriteResult } from './storage.js';
export type { WorkspaceReads } from './workspace-reads/reads.js';
export type { OutputFolder, OutputKind, Outputs, RenderOutputs, RunFileFacts, RunFolderReadOptions, RunOutputs } from './outputs/outputs.js';
export type { FolderStage, ProjectFolder, ProjectStore, ProjectStores, StoreLabel, StoreScope, StoreWriteOptions, StoredText } from './store/store.js';
export type { Clock } from './clock.js';
export type { EnginePorts } from './ports.js';
export type { HookJournal, HookJournalRollback, HookPlace, HookRunOptions, HookRunner, PendingHookJournal } from './hook-run/runner.js';
export type { SandboxHandle, Sandboxes } from './sandboxes/sandboxes.js';
export type { CaptureRaw, CaptureRequest, CaptureRunner, CaptureSessions, HookAuthOptions, HookBrowser, HookBrowserOptions, HookPages, SessionCheckOptions } from './capture/runner.js';
export type { FrameInput, FrameThumb, FrameThumbOptions, FrameTools, FramesAtOptions, MarkBox, MarksOptions, Reviewer, StillOptions } from './review/reviewer.js';
export type { HookRunResult, JournalBy, JournalEntry, JournalHook, JournalQuery, JournalWhat, JournalWrite } from './store/journal.js';
export type { CreateProjectRequest, EnvironmentView, PersonaView, ProjectSummary, ProjectView } from './projects.js';
export type { FieldChoice, TimelineCaptureInfo, TimelineView, TimelineViewRequest, TimelineViewResult } from './views/timeline-view.js';
export type { FieldOption } from './field-options.js';
export type { PreparedScenarioEdit, SaveResult, ScenarioEdit, ScenarioEditRequest, ScenarioEditResult, ScenarioText, ValidateResult } from './scenarios.js';
export type { RecordCheck, RecordOutcome, RecordPorts, RecordRequest, RecordStart } from './record.js';
export type { RecordMeta } from './record-files.js';
export type { RecordAnnotated, RecordCheckView, RecordDiscarded, RecordListItem, RecordSaved, RecordState, RecordStopped, RecordTargetOption, RecordView, RecordZoomView } from './record-studio.js';
export type { ScriptDraftView } from './authoring.js';
export type { RunStatusView, RunSummary } from './runs.js';
export type { RangeRead, RunFileProblem, RunFileRead } from './outputs/run-files.js';
export type { FrameIndex, PageSource } from './run-data.js';
export type { RunThumb, RunThumbsOptions, RunThumbsView, ThumbMissingReason, ThumbSource } from './run-thumbs.js';
export type { BoardRun, BoardScenario, ProjectBoardContext, ProjectBoardView, RunPoster } from './views/project-board.js';
export type {
  EditAbility,
  SceneFacts,
  ScenarioActions,
  ScenarioEnvironmentFacts,
  ScenarioRunChoice,
  ScenarioSource,
  ScenarioView,
  ScenarioViewContext,
  StepBinding,
  ViewRunStatus,
} from './views/scenario-view.js';
export type { SandboxStatusView } from './sandbox.js';
export { ENGINE_API_VERSION, agentTrust, createEngine } from './engine.js';
export type { AgentChannel, Caller, CallerChannel, CallerTrust } from './caller.js';
export type {
  JobState,
  JobKind,
  JobClass,
  JobClient,
  JobApproval,
  EditOverridesInput,
  RunJobInput,
  HooksJobInput,
  EnvResetJobInput,
  AuthLoginJobInput,
  SandboxUpJobInput,
  SandboxResetJobInput,
  RenderJobInput,
  ReviewJobInput,
  ExportJobInput,
  PreviewJobInput,
  InspectJobInput,
  RecordJobInput,
  SiteJobInput,
  JobInput,
} from './jobs/job-input.js';
export type { Admission, AdmissionDeps, OpChain, PreparedTake, RunAdmit, SessionToConfirm, SessionsView } from './admission.js';
export type {
  AuthStatus,
  AuthStatusItem,
  Engine,
  EngineClient,
  EngineInfo,
  EngineOptions,
  InspectSubmitted,
  PreviewSubmitted,
  RecordSubmitted,
  CompactRunStatus,
  RunJobView,
  RunListItem,
  RunStatusWithJob,
  ScenarioCheck,
  ScenarioSessions,
  WaitOptions,
} from './engine.js';
export type { InterruptOptions, InterruptPort, InterruptScope } from './interrupts.js';
export type { ExecuteRunOptions, PreparedRun, RunPorts, RunRequest } from './execute-run.js';
export type { PlanOfRunOptions } from './pipeline.js';
export type { RawExportSettings, RawExportWorkOptions } from './raw-export.js';
export type { ExportCaptureOptions, RawExportProgress, RawExportResult, RawManifest } from '@retake/runner-web/types';
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
export type { EditOverrides, ExportFormat, ExportProgress, ExportResult, FoundRender, PlannedRun, RenderProgress, RenderRecord, ReviewResult, RunRef } from './pipeline.js';
export type { CancelMark, ClaimRecord, DeriveOptions, JobFileRead, JobFilter, JobMark, JobPosition, JobQueue, JobQueueView, TakeHold, YieldMark } from './jobs/job-queue.js';
export type { Secrets } from './secrets/secrets.js';
export type { EngineEnv } from './env.js';
export type { JobQueues, WorkspaceQueue } from './jobs/job-queue.js';
export type { WorkerLockRecord } from './jobs/lock.js';
export type { ProcessIdentity } from './jobs/proc.js';
export type { LiveChannel, LiveChannelInfo, LiveFeedFrame, LiveFrameHeader } from './jobs/live-channel.js';
export type { EnvResetSubmitRequest, HooksSubmitRequest } from './jobs/hooks-job.js';
export type { HookContextOptions, HookSelection } from './hooks.js';
export type {
  EnvResetOutcome,
  EnvResetWorkOptions,
  HookInterrupt,
  HookWorkOptions,
  HooksRunOutcome,
  HooksRunProtection,
  HooksRunWorkOptions,
  Protected,
  RollbackOutcome,
  RollbackWorkOptions,
} from './hooks-work.js';
export type { SandboxDownWorkOptions, SandboxHeldOptions, SandboxInitView, SandboxResetWorkOptions, SandboxSeedingOptions, SandboxUpWorkOptions, SeedTrusted } from './sandbox-work.js';
export type { AgentWrittenShellHooks, HookFileChange, HooksAuthor, ScenarioHooksCheck, HooksTrustView, ListingContext, RenderedText, ScenarioHookPhases, ScenarioShellHook } from './agent-written.js';
export type { ApprovalItem, ApprovalOutcome, ApprovalRequest, Approver, Preflight, PruneApprovalRequest, SiteApprovalRequest } from './approvals.js';
export type { RunBlocker, RunBlockerKind, RunSubmitRequest } from './jobs/run-job.js';
export type { WorkerSpawnFn, WorkerSpawnOptions } from './jobs/spawn.js';
export type { WorkerEnvOptions } from './jobs/worker-env.js';
export type { FilmingState, FilmingWatchOptions, LiveTake, MarkerRecord, TakeBesideReport } from './jobs/captures.js';
// What a take reports to its filming callback: the runner's types, re-exported so that the CLI's `retake run` names them
// without importing the runner (a shell imports no adapter: the import rules' R4, scripts/audit/lib.mjs).
export type { FilmingEvent, FilmingReport } from '@retake/runner-web/types';
export type { HeldWork } from './jobs/held.js';
export type { QosDeps, QosProc } from './jobs/yield.js';
export type { KillFn } from './jobs/signal.js';
export type { PickContext, PickRecord } from './jobs/pick.js';
export type { WorkerOptions } from './jobs/worker.js';
export type { FreeBytes, JobProcesses, JobProcessJob, RecordWindow, WorkerPorts, WorkerPortsGiven } from './jobs/worker-ports.js';
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
export type { SignInOutcome, SignInPorts } from './login.js';
export type { AuthLoginSubmitRequest } from './jobs/auth-job.js';
export type { InlineReview, LatestRunNotice, PassedOverRuns, RecordedBrowser, RenderEditSource, RenderRequest } from './jobs/render-job.js';
export type { LatestRenderNotice, PassedOverRenders, RenderForWork } from './renders.js';
export type { ReviewRequest } from './jobs/review-job.js';
export type { ExportRequest } from './jobs/export-job.js';
export type { PreviewRequest } from './jobs/preview-job.js';
export type { LibraryEntry, LibraryEntryMeta, LibraryFailure, LibraryItemState, LibraryKeyContext, LibraryLoopState, LibraryPosterState, LibraryPreviewKind, LibraryStatesView } from './library.js';
export type { InspectSourceDraft, InspectSubmitRequest, InspectionOptions, InspectionRun, PreparedInspect } from './jobs/inspect-job.js';
export type { RecordJobContext, RecordSubmitRequest } from './jobs/record-job.js';
export type { ComponentCreateRequest, ComponentCreated, ComponentListView, ComponentSummary, ComponentValidationView, ComponentView } from './components.js';
export type {
  ComponentCatalogView,
  ComponentCreatedByShell,
  ComponentEntry,
  ComponentFileIssue,
  ComponentRef,
  ComponentValidationsView,
  PreviewSelection,
  PreviewTargetsView,
  RegistryNoticeView,
} from './components.js';
export type { TemplateDetail, TemplateListView, TemplateSummary } from './templates.js';
export type { ThemeComponentView, ThemeEditList, ThemeEditRequest, ThemeEditResult, ThemeEditView, ThemeEditable, ThemeListItem } from './theme-edit.js';
export type { ThemeCopied } from './brand/copy.js';
export type { BrandFileList } from './brand/file-list.js';
export type { SiteList, SiteListEntry } from './views/site-list.js';
export type { ReviewFindingView, ReviewImageRef, ReviewImageView, ReviewImagesMode, ReviewView } from './reviews.js';
export type {
  PlanPreviewSegment,
  PlanPreviewView,
  RenderJobView,
  RenderQueueView,
  RenderReviewSummary,
  RenderStatusRecord,
  RenderStatusView,
  ScenarioRenderJobView,
  ScenarioRenderView,
  ScenarioRendersView,
} from './renders.js';
export type { SandboxJobKind, SandboxSubmitRequest } from './jobs/sandbox-job.js';
export type { HistoryEntry, UsageCounts } from './history.js';
export type { RenderFrameRequest, RenderFrameView, RenderFramesOptions, RenderOutlineRequest, RenderOutlineView } from './render-frames.js';
export type { PruneItem, PruneKeptTake, PruneRequest, PruneResult } from './prune.js';
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
export type { BuiltProposal, ProposalInput } from './comment-proposals.js';
export type { GateOptions, GateRequest, GateResult, GateStatus, RouteSpec } from './http/gate.js';
export type { DiscoveryClaim, DiscoveryRecord, StudioTokenRecord } from './http/discovery.js';
export type { ActivityItem, HistoryRow, IndexChanges, IndexOptions, IndexRebuild, SearchHit } from './index-db/index-db.js';
export type { SqliteLoader, SqliteModule } from './index-db/sqlite.js';
export type { RunChange, RunRow, SourceKind, SourceMap } from './index-db/sources.js';
export type { Entitlements } from './entitlements.js';
export type { HostLookup, HostResolver, ProtectedHostHit, WorkspaceProtectedHost } from './protected-hosts.js';
export type { ThemeCreateOptions, ThemeCreated, ThemeFontView } from './brand/create.js';
export type { SiteJobContext, SiteSubmitted } from './jobs/site-job.js';
export type { BrandFileKind, BrandTrust, FontFormat, FontInfo, ImageInfo, ResolvedBrandFile, SvgScan } from './brand/files.js';
export type { WatchBudget } from './library-watch.js';
// theme_preview's spec (L7.17: built by the engine; the Studio serves it on its player origin).
export type { ThemePreviewBase, ThemePreviewBuild, ThemePreviewBuilt, ThemePreviewDraft, ThemePreviewRequest, ThemePreviewServe } from './views/theme-preview.js';
