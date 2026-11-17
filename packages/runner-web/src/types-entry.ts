/**
 * `@retake/runner-web/types`: the capture's vocabulary as types only — what the engine's CaptureRunner port and
 * the shells name (a run's options and record, the filming events, the live picture, the pause gate, an inspection's
 * report, a site's report, a recording's options and result, a sign-in's, a persona's session state, a js hook's page,
 * what a check of the machine learns of the capture browser, a raw export's options, progress and package, and the
 * driver seam another package's driver implements: capture/driver.ts).
 * Every line is `export type … from`: the built entry loads nothing (no Playwright, no encoder, no kit), so it is a
 * domain entry (scripts/audit/lib.mjs DOMAIN_ENTRIES) and the engine may name it where the package root is an adapter.
 * The package root exports every one of these names too (packages/runner-web/test/types-entry.test.ts).
 */
export type { FilmingEvent, FilmingReport, RunOptions, RunScenarioOptions } from './run.js';
export type { LiveFrame, LiveSink } from './live-preview.js';
export type { PauseGate } from './pause.js';
export type { InspectReport, InspectRequest } from './inspect.js';
export type { SiteExtractOptions, SiteReport } from './site/extract.js';
export type { ConfirmHook } from './hooks-bridge.js';
export type { PersonaCheckResult, PersonaStatusRecord, ProfileLock } from './auth.js';
export type { SignInOptions, SignInResult } from './login.js';
export type { RecordSessionOptions, RecordSessionResult } from './record-session.js';
export type { HookPageOptions } from './hook-page.js';
export type { ChromiumProbe } from './probe.js';
export type { PersonaAuthSource } from './persona-auth.js';
export type { ExportCaptureOptions, RawExportProgress, RawExportResult, RawManifest, RawManifestClip } from './raw/export.js';
export type { CaptureDriver, CaptureRun, CaptureTools, DriverFactory, DriverTake, StepRef } from './capture/driver.js';
export type { DriverHooks } from './capture/hooks.js';
export type { HookStepOutcome, LogLevel } from './runtime.js';
export type { CaptureClock, TimelineBuilder } from './timeline.js';
export type { RunFiles } from './runfiles.js';
export type { RunSecrets } from './secrets.js';
