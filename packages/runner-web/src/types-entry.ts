/**
 * `@retake/runner-web/types` (L7.12): the capture's vocabulary as types only — what the engine's CaptureRunner port and
 * the shells name (a run's options and record, the filming events, the live picture, the pause gate, an inspection's
 * report, a site's report, a recording's options and result, a sign-in's, a persona's session state, a js hook's page).
 * Every line is `export type … from`: the built entry loads nothing (no Playwright, no encoder, no kit), so it is a
 * domain entry (scripts/audit/lib.mjs DOMAIN_ENTRIES) and the engine may name it where the package root is an adapter.
 * The package root exports every one of these names too (packages/runner-web/test/types-entry.test.ts).
 */
export type { FilmingEvent, FilmingReport, RunOptions } from './run.js';
export type { LiveFrame, LiveSink } from './live-preview.js';
export type { PauseGate } from './pause.js';
export type { InspectReport, InspectRequest } from './inspect.js';
export type { SiteExtractOptions, SiteReport } from './site/extract.js';
export type { ConfirmHook, HookApprovalRequestLike } from './hooks-bridge.js';
export type { PersonaCheckResult, PersonaStatusRecord, ProfileLock } from './auth.js';
export type { SignInOptions, SignInResult } from './login.js';
export type { RecordSessionOptions, RecordSessionResult } from './record-session.js';
export type { HookPageOptions } from './hook-page.js';
export type { PersonaAuthSource } from './persona-auth.js';
