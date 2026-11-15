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
export type { FileValidation } from './validate-files.js';
export type { OpenedWorkspace } from './workspace.js';
export type { LoginCommandOf, PersonaState } from './auth.js';
export { ENGINE_ERROR_CODES, EngineError, toEngineError } from './errors.js';
export type { EngineErrorCode } from './errors.js';
export type { WorkspaceReads } from './workspace-reads/reads.js';
export type { Outputs } from './outputs/outputs.js';
export type { Clock } from './clock.js';
export type { EnginePorts } from './ports.js';
export type { HookJournal, HookJournalRollback, PendingHookJournal } from './hook-run/runner.js';
export type { SandboxHandle, Sandboxes } from './sandboxes/sandboxes.js';
export type { Reviewer } from './review/reviewer.js';
export type { JournalEntry } from './store/journal.js';
export type { EnvironmentView, ProjectSummary, ProjectView } from './projects.js';
export type { TimelineView, TimelineViewResult } from './views/timeline-view.js';
export type { ScenarioEdit } from './scenarios.js';
export type { RecordOutcome, RecordPorts } from './record.js';
export type { RecordCheckView, RecordListItem, RecordState } from './record-studio.js';
export type { RunSummary } from './runs.js';
export type { RangeRead } from './outputs/run-files.js';
export type { RunThumbsView } from './run-thumbs.js';
export type { BoardRun, BoardScenario, ProjectBoardView } from './views/project-board.js';
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
export { ENGINE_API_VERSION, agentTrust, createEngine } from './engine.js';
export type { JobState, JobKind, JobClient } from './jobs/job-input.js';
export type { OpChain, PreparedTake, SessionToConfirm } from './admission.js';
export type { AuthStatus, AuthStatusItem, Engine, EngineClient, EngineInfo, CompactRunStatus, RunListItem, RunStatusWithJob, ScenarioSessions } from './engine.js';
export type { InterruptPort } from './interrupts.js';
export type { PreparedRun } from './execute-run.js';
export type { RawExportProgress, RawExportResult } from '@retake/runner-web/types';
export type { Renderer } from './render/renderer.js';
export type { EditOverrides, ExportFormat, ExportProgress, FoundRender, PlannedRun, RenderProgress, RenderRecord, ReviewResult, RunRef } from './pipeline.js';
export type { ClaimRecord, JobQueue, JobQueueView } from './jobs/job-queue.js';
export type { Secrets } from './secrets/secrets.js';
export type { JobQueues } from './jobs/job-queue.js';
export type { WorkerLockRecord } from './jobs/lock.js';
export type { ProcessIdentity } from './jobs/proc.js';
export type { LiveChannel, LiveFeedFrame } from './jobs/live-channel.js';
export type { HookWorkOptions, HooksRunOutcome } from './hooks-work.js';
export type { AgentWrittenShellHooks, RenderedText, ScenarioShellHook } from './agent-written.js';
export type { ApprovalOutcome, ApprovalRequest, Approver, PruneApprovalRequest, SiteApprovalRequest } from './approvals.js';
export type { RunBlocker } from './jobs/run-job.js';
export type { WorkerSpawnFn } from './jobs/spawn.js';
export type { FilmingState } from './jobs/captures.js';
// What a take reports to its filming callback: the runner's types, re-exported so that the CLI's `retake run` names them
// without importing the runner (a shell imports no adapter: the import rules' R4, scripts/audit/lib.mjs).
export type { FilmingEvent, FilmingReport } from '@retake/runner-web/types';
export type { HeldWork } from './jobs/held.js';
export type { FreeBytes, RecordWindow } from './jobs/worker-ports.js';
export type { JobRecord, JobYield, SiteJobResult } from './jobs/types.js';
export type { RenderForWork } from './renders.js';
export type { InspectSourceDraft } from './jobs/inspect-job.js';
export type { ComponentEntry, ComponentRef, RegistryNoticeView } from './components.js';
export type { ThemeEditResult, ThemeEditView } from './theme-edit.js';
export type { ThemeCopied } from './brand/copy.js';
export type { BrandFileList } from './brand/file-list.js';
export type { ReviewFindingView, ReviewImageView, ReviewView } from './reviews.js';
export type { PlanPreviewView, RenderReviewSummary, RenderStatusView, ScenarioRenderJobView, ScenarioRenderView, ScenarioRendersView } from './renders.js';
export type { HistoryEntry } from './history.js';
export type { RenderFrameView, RenderOutlineView } from './render-frames.js';
export type { PruneItem, PruneResult } from './prune.js';
export type { CommentAnchorView, CommentCountsView, CommentProposalView, CommentListView, CommentView, CommentWritten } from './comments.js';
export type { RouteSpec } from './http/gate.js';
export type { DiscoveryRecord, StudioTokenRecord } from './http/discovery.js';
export type { ActivityItem, SearchHit } from './index-db/index-db.js';
export type { SqliteLoader } from './index-db/sqlite.js';
export type { RunChange, RunRow, SourceMap } from './index-db/sources.js';
export type { ThemeCreateOptions, ThemeCreated } from './brand/create.js';
// theme_preview's spec (built by the engine; the Studio serves it on its player origin).
