/**
 * `@retake/sandbox/types` (L7.25): a sandbox's vocabulary as types only — what the engine's Sandboxes port and the
 * shells name (the results of up, down and reset, a status, logs, a take, a call's options and progress, a seed's
 * trust and recorder, the providers' capabilities, the scaffold's options and result).
 * Every line is `export type … from`: the built entry loads nothing (no pg, no process or Docker code), so it is a
 * domain entry (scripts/audit/lib.mjs DOMAIN_ENTRIES) and the engine may name it where the package root is an adapter.
 * The package root exports every one of these names too (packages/sandbox/test/types-entry.test.ts).
 */
export type { ResetResult, SandboxCallOptions, SandboxLogs, SandboxStatus, SandboxUpResult, Take } from './sandbox.js';
export type {
  DownOptions,
  DownResult,
  ProviderCapabilities,
  SandboxLog,
  SandboxLogLevel,
  SandboxProgress,
  SeedRecorder,
  SeedRunResult,
  SeedTrust,
  ServiceStatus,
  UpOptions,
  UpResult,
} from './provider.js';
export type { InitSandboxOptions, InitSandboxResult } from './init.js';
