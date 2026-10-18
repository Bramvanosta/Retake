/**
 * @demo-studio/runner-web — drives a real web app headless with deterministic pacing, an in-page cursor driven by
 * real input, CDP screencast capture and a timeline of every step (docs/DESIGN.md §3).
 */
export { motionWarnings, runScenario } from './run.js';
export type { RunOptions } from './run.js';
export { INSPECT_BUDGET_MS, INSPECT_LIMIT, INSPECT_LIMIT_MAX, INSPECT_PACING, INSPECT_PAUSE_CAP_S, INSPECT_TARGETS_MAX, inspectElement, inspectPage } from './inspect.js';
export type { InspectContext, InspectElement, InspectReport, InspectRequest, InspectStepHint, InspectTargetCheck } from './inspect.js';
export type { ConfirmHook, HookApprovalRequestLike } from './hooks-bridge.js';
export { openSession, BrowserSession, KitClient, DEFAULT_BROWSER_ARGS, frameRateArgs, scaleArgs } from './session.js';
export type { RealmSpec, SessionOptions, StorageStateFile } from './session.js';
export { encodeFrames, cfrSchedule } from './encode.js';
export type { EncodeOptions } from './encode.js';
export type { FrameIndexEntry, RecorderOptions } from './recorder.js';
export { ScreencastRecorder } from './recorder.js';
export { kitSource, kitConfigFor, DEFAULT_CURSOR_SIZE, DEFAULT_RIPPLE_COLOR, CURSOR_STORAGE_KEY } from './kit/source.js';
export type * from './kit/types.js';
export { checkSavedSession, openLoginBrowser, seedProfilePreferences, signIn } from './login.js';
export { RECORD_BUDGET_MS, RECORD_MAX_MS, disableAutofill, looksLikeSecretSegment, maskPathSecrets, recordSession } from './record-session.js';
export type { RecordSessionOptions, RecordSessionResult } from './record-session.js';
export { SECRET_MASK, SECRET_MIN, demoRecorder, looksLikeToken, recorderSource, secretHash } from './kit/record-script.js';
export type { RecorderConfig, SecretHash } from './kit/record-script.js';
export type { LoginOptions, SignInOptions, SignInResult } from './login.js';
export { mergePacing, mergeCapture, mergeBrowser, projectBrowser, resolveAuth } from './config.js';
export { CaptureClock, STALL_MIN_S, TimelineBuilder, computeIdle, motionCapture } from './timeline.js';
export type { CaptureStall, MotionCapture } from './timeline.js';
export { moveDuration, arcPath, easeInOutCubic, isNudge } from './motion.js';
export { evalInPage } from './actions/misc.js';
export { evalHookInPage } from './hook-page.js';
export type { HookPageOptions } from './hook-page.js';
export { armWriteGuard, closePage, unloadGuardScript, unloadPages } from './write-guard.js';
export type { GuardedWrite, PageRole, WriteGuardOptions, WriteVia } from './write-guard.js';
export { REAL_TIME_SCRIPT, isRealTimePage, productClock, productClockScript, useRealTime } from './product-clock.js';
export type { ProductClockConfig } from './product-clock.js';
export { RunnerError, StepError, CancelledError, EncodeError, PreflightError, LoginPageError } from './errors.js';
export {
  LoginGuard,
  autoLogin,
  checkPersona,
  copyProfile,
  describeLoginStep,
  ensurePrivateDir,
  preflight,
  prepareSessions,
  profileLock,
  readSnapshot,
  readStatus,
  registerSessionCopy,
  signInMatchers,
  removeSessionCopiesSync,
  skippedInCopy,
  sweepStaleSessionCopies,
  SESSION_COPY_PREFIXES,
  STALE_COPY_AGE_MS,
  writeSnapshot,
  writeStatus,
} from './auth.js';
export type { CheckDeps, GuardTarget, Landing, LoginDeps, PersonaCheckResult, PersonaStatusRecord, PreflightDeps, PreparedSession, ProfileLock, SessionSnapshot, SnapshotMeta } from './auth.js';
export { StepFailure, describeStep, trimSnippet, DEFAULT_STEP_TIMEOUT_S, ERROR_DOM_MAX } from './scenes.js';
export { RunSecrets, TIMELINE_POLICY, RECORD_POLICY, PROGRESS_POLICY } from './secrets.js';
export type { RedactPolicy } from './secrets.js';
export { probeChromium, chromiumExecutable } from './probe.js';
export type { ChromiumProbe } from './probe.js';
export { ArtefactStore, artefactSlug, previewText, htmlText, sniffMime, extensionFor, imageSize, projectDocuments, EMAIL_PREVIEW_CHARS } from './artefacts/store.js';
export { ArtefactRenderer, sandboxedEmail, EMAIL_WIDTH, EMAIL_SCALE, PDF_SCALE, ICON_SIZE } from './artefacts/render.js';
export { MailboxClient, mailMatches, parseAddress, parseAddressList, formatAddress, inlineCids } from './artefacts/mailbox.js';
export type { MailAddress, MailMessage, MailSummary } from './artefacts/mailbox.js';
export { ARTEFACT_TIMEOUT_S, captureValue, textPattern } from './actions/artefacts.js';
export { NOTIFICATION_BINDING, launchTarget } from './session.js';
export type { NotificationPayload } from './session.js';
export * from './raw/index.js';
export { CURSOR_BINDING } from './session.js';
export { pushCursorEffect } from './timeline.js';
export { materialize, runFfmpeg } from './encode.js';
