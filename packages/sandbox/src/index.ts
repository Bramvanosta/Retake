/**
 * @retake/sandbox (L1.8): start, seed, reset and stop a project's sandboxes — disposable, local copies of the
 * product declared by a sandbox.yaml (core `sandbox.ts` reads them into environments). docs/DESIGN.md §3.8.
 * Its vocabulary as types only: `@retake/sandbox/types` (L7.25). The OS utilities it hosted (process table and groups,
 * the lock file, who listens on a port), its error class and a sandbox's paths are core's since L7.25 (`@retake/core/io`,
 * `@retake/core`): re-exported here unchanged.
 */
export { Sandbox, openSandbox, providerFor, LOG_CAP_BYTES } from './sandbox.js';
export type { ResetResult, SandboxCallOptions, SandboxLogs, SandboxStatus, SandboxUpResult, Take } from './sandbox.js';
export { SandboxError } from './errors.js';
export type { SandboxErrorCode } from './errors.js';
export { COMPOSE_CAPABILITIES, PROCESS_CAPABILITIES } from './provider.js';
export type {
  DownOptions,
  DownResult,
  OwnerUse,
  Provider,
  ProviderCapabilities,
  ProviderContext,
  ProviderLogs,
  SandboxLog,
  SandboxLogLevel,
  SandboxProgress,
  SeedRecorder,
  SeedRunResult,
  SecretRefResolver,
  SeedTrust,
  ServiceLogFile,
  ServiceStatus,
  UpOptions,
  UpResult,
} from './provider.js';
export {
  COMPOSE_HEALTH_TIMEOUT_S,
  ComposeProvider,
  DOCKER_HELPER,
  EXEC_MARK,
  EXEC_TIMEOUT_S,
  KILL_EXEC_SCRIPT,
  composeArgs,
  composeProject,
  composeProjectName,
  composeRecord,
  connectAddress,
  containerProblem,
  foreignListeners,
  parseComposeConfig,
  parseDockerPs,
  parseLabels,
  parsePs,
  serviceProblems,
  waitTimeoutS,
} from './compose.js';
export type { ComposeConfig, ComposeProjectRef, ComposeProviderOptions, ComposeRecord, PortContainer, PsEntry, PublishedPort } from './compose.js';
export { DOCKER_PROBE_TIMEOUT_MS, MIN_COMPOSE_VERSION, dockerCandidates, dockerEnv, dockerPlaces, dockerReady, findDocker, firstErrorLine, parseVersion, runDocker, versionAtLeast } from './docker.js';
export type { DockerExec, DockerInfo, DockerResult, DockerRunOptions } from './docker.js';
export {
  MIN_PG_VERSION_NUM,
  PostgresSnapshot,
  SNAPSHOT_SUFFIX,
  describeDatabase,
  parsePostgresUrl,
  pgAnswers,
  pgEndpoint,
  quoteIdent,
  quoteLiteral,
  resolveDatabaseUrl,
  snapshotComment,
  snapshotTarget,
} from './snapshot-postgres.js';
export type { PgEndpoint, SnapshotState, SnapshotTarget } from './snapshot-postgres.js';
export { ProcessProvider, DEFAULT_STOP_TIMEOUT_S, resolveCommand, serviceEnv, serviceHash, tailLines } from './process.js';
export { BREAKER_STALE_MS, TakeLock, breakStale, createExclusive, describeLock, lockAlive, readLock } from './lock.js';
export type { LockRecord } from './lock.js';
export { SANDBOX_STATE_DIR, sandboxPaths, serviceLog } from './paths.js';
export type { SandboxPaths } from './paths.js';
export { STATE_VERSION, emptyState, readState, writeState } from './state.js';
export type { ProcessServiceState, SandboxState, ServiceState } from './state.js';
export { busyPorts, describeListeners, listeners, parseLsof, portLabel, probePort, sandboxPorts } from './ports.js';
export type { Listener, SandboxPort } from './ports.js';
export { HEALTH_INTERVAL_MS, PROCESS_HEALTH_TIMEOUT_S, checkOnce, healthNow, pinHealth, pinnedAddress, pinnedRequest, serviceHealth, targetLabel, waitHealthy } from './health.js';
export type { HealthTarget, ServiceHealth } from './health.js';
export {
  bootTime,
  groupMembers,
  groupTree,
  identify,
  killGroupSync,
  parseBootTime,
  parseLstart,
  parseProcessTable,
  processStart,
  processStartSync,
  processTable,
  processTableSync,
  signalState,
  stopGroup,
} from './proc.js';
export type { Known, Member, ProcInfo } from './proc.js';
export { checkExecHosts, checkMailbox, checkSeedDatabases, clearMailbox, masker, runSeed, sandboxSecrets } from './seed.js';
export { DEFAULT_SANDBOX_ENV, INIT_BASE_PORT, SCAFFOLD_DIR, initSandbox, schemaRef } from './init.js';
export type { InitSandboxOptions, InitSandboxResult } from './init.js';
