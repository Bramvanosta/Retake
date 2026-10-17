/**
 * @demo-studio/engine — the typed, in-process API shared by the CLI and the MCP server (L3.1). Part A: workspace and
 * project loading (moved from the CLI), projects / scenarios / runs / auth / sandbox reads, `if_match` saves, a local
 * storage abstraction and typed EngineError codes for clients outside the CLI. Part B: the run executor shared by
 * `studio run` and the jobs worker, the job queue under <workspace>/.demo-studio/jobs and the worker. Part C: hooks
 * outside a capture (moved from the CLI), `hooks` / `env_reset` jobs, and human approvals of hooks for work submitted
 * through MCP (trust `mcp`, fingerprints taken at submit and checked by the worker). Part D: sign-ins and sandbox
 * up / reset as jobs (login moved from the CLI; shell seed steps approved like hooks), the job history and an
 * entitlements stub.
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
export { listRuns, runStatus } from './runs.js';
export type { RunStatusView, RunSummary } from './runs.js';
export { sandboxStatus } from './sandbox.js';
export type { SandboxStatusView } from './sandbox.js';
export { ENGINE_API_VERSION, createEngine } from './engine.js';
export type { AuthStatus, AuthStatusItem, Engine, EngineClient, EngineInfo, EngineOptions, RunJobView, RunListItem, RunStatusWithJob, WaitOptions } from './engine.js';
export { formatMs, sandboxUpText } from './format.js';
export { signalInterrupts } from './interrupts.js';
export type { InterruptOptions, InterruptPort, InterruptScope } from './interrupts.js';
export { RunOptionError, SandboxTakeError, checkAllowWrites, checkSandboxEnv, executeRun, pickSandboxEnv, prepareRun, writesSummary } from './execute-run.js';
export type { ExecuteRunOptions, PreparedRun, RunPorts, RunRequest } from './execute-run.js';
export { newJobId } from './jobs/ids.js';
export { FileJobQueue, jobsDir, stateDir } from './jobs/queue.js';
export type { ClaimRecord, JobFilter } from './jobs/queue.js';
export { WorkerLock, liveWorker, readWorkerLock, workerLockFile, workersDir } from './jobs/lock.js';
export type { WorkerLockRecord } from './jobs/lock.js';
export { buildDirs, buildStamp } from './jobs/build.js';
export { isAlive, selfIdentity } from './jobs/proc.js';
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
export { approvalChecker, preflightHooks, refusedError, takeApprovals } from './approvals.js';
export type { ApprovalItem, ApprovalOutcome, ApprovalRequest, Approver, Preflight } from './approvals.js';
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
  RunJobResult,
} from './jobs/types.js';
export { LoginOptionError, loginTarget, signInPersona } from './login.js';
export type { SignInOutcome, SignInPorts } from './login.js';
export { executeAuthLoginJob, loginCommandLine, submitAuthLoginJob } from './jobs/auth-job.js';
export type { AuthLoginSubmitRequest } from './jobs/auth-job.js';
export { executeSandboxJob, sandboxCommandLine, submitSandboxJob } from './jobs/sandbox-job.js';
export type { SandboxJobKind, SandboxSubmitRequest } from './jobs/sandbox-job.js';
export { HISTORY_VERSION, appendHistory, historyFile, runCounted, usageCounts } from './history.js';
export type { HistoryEntry, UsageCounts } from './history.js';
export { entitlements } from './entitlements.js';
export type { Entitlements } from './entitlements.js';
export { SHELL_SEED_REASON, checkAgentTrust, seedApprovalItems } from './approvals.js';
export { checkNewProjectHosts, checkWorkspaceProtection, protectedHostOf, workspaceProtectedHosts } from './protected-hosts.js';
export type { WorkspaceProtectedHost } from './protected-hosts.js';
export { APPROVAL_KEY_FILE, approvalKeyFile, signApprovals, verifiedApprovals } from './jobs/signing.js';
