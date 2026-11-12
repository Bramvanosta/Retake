/**
 * @retake/runner-web — drives a real web app headless with deterministic pacing, an in-page cursor driven by
 * real input, CDP screencast capture and a timeline of every step (docs/DESIGN.md §3).
 */
export { DISK_FREE_MIN_GB, DISK_FREE_MIN_SHARE, choppyCause, diskCheck, motionWarnings, runScenario } from './run.js';
export type { FilmingEvent, FilmingReport, RunOptions } from './run.js';
export { LIVE_FPS_MAX, LIVE_JPEG_QUALITY, LIVE_MAX_WIDTH, LivePreview } from './live-preview.js';
export type { LiveFrame, LivePreviewOptions, LiveSink } from './live-preview.js';
export { PAUSE_MAX_MS, RESUME_FRAME_MS, RunPauser } from './pause.js';
export type { PauseGate, PausePoint, PauseTake } from './pause.js';
export { INSPECT_BUDGET_MS, INSPECT_LIMIT, INSPECT_LIMIT_MAX, INSPECT_PACING, INSPECT_TARGETS_MAX, inspectElement, inspectPage } from './inspect.js';
export { INSPECT_PAUSE_CAP_S } from './inspect-limits.js';
export type { InspectContext, InspectElement, InspectReport, InspectRequest, InspectStepHint, InspectTargetCheck } from './inspect.js';
export { SERVICE_WORKER_BLOCK, UNROUTED_APIS_BLOCK, SITE_CALL_TIMEOUT_MS, SITE_CANDIDATES_MAX, SITE_DEADLINE_MS, SITE_REPORT_FILE, SITE_REPORT_VERSION, SITE_SCREENSHOT_FILE, extractSite, imageMime, requestUrlProblem, sameSiteHost, siteBrowserArgs } from './site/extract.js';
export type { BlockedReason, SiteCandidateView, SiteExtractOptions, SiteReport } from './site/extract.js';
export { ProxyRefusalError, SITE_PROXY_CAPS, SiteProxy } from './site/proxy.js';
export type { ProxyRefusal, ResolvedAddress, SiteProxyCaps, SiteProxyOptions, SiteProxyStats } from './site/proxy.js';
export { chroma, contrast, luminance, mergeSamples, sitePalette } from './site/palette.js';
export type { SitePalette, SiteRoles, Swatch } from './site/palette.js';
export type { ConfirmHook, HookApprovalRequestLike } from './hooks-bridge.js';
export { openSession, BrowserSession, KitClient, DEFAULT_BROWSER_ARGS, frameRateArgs, scaleArgs } from './session.js';
export { gpuInfoOf } from './session.js';
export type { GpuInfo, RealmSpec, SessionOptions, StorageStateFile, SystemInfoReply } from './session.js';
export { encodeFrames, cfrSchedule } from './encode.js';
export { CfrStream, STREAM_LAG_S, StreamEncoder, THUMB_H, THUMB_W, VIDEOTOOLBOX_QUALITY, encoderLabel, resolveEncoder, streamArgs, videotoolboxWorks } from './stream.js';
export type { StreamEncoderOptions, StreamFrame } from './stream.js';
export { ActivityRecorder, BIG_CELLS, BUSY_MIN_S, CELLS_X, CELLS_Y, QUIET_S, SLOW_TRANSITION_MS, analyzeActivity, cellMask, clicksOf, slowTransitions } from './activity.js';
export type { ActivityClick, ActivityInput, ActivityResult } from './activity.js';
export { PERF_SAMPLE_MS, PerfSampler, UNFILMED_WARN_CORES, chromiumGroup, listeningPids, localPorts, parseCpuTime } from './perf.js';
export type { ChromiumProcess, PerfSamplerOptions } from './perf.js';
export { prewarmPages, prewarmTargets } from './prewarm.js';
export { PAGE_PREFLIGHT_TIMEOUT_MS, preflightRefusal, probePages } from './page-preflight.js';
export type { PageProbe } from './page-preflight.js';
export type { PrewarmTarget } from './prewarm.js';
export type { EncodeOptions } from './encode.js';
export type { FrameIndexEntry, RecorderOptions } from './recorder.js';
export { KICK_GAP_MS, KICK_WINDOW_MS, ScreencastRecorder } from './recorder.js';
export { kitSource, kitConfigFor, DEFAULT_CURSOR_SIZE, DEFAULT_RIPPLE_COLOR, CURSOR_STORAGE_KEY } from './kit/source.js';
export type * from './kit/types.js';
export { checkSavedSession, openLoginBrowser, seedProfilePreferences, signIn } from './login.js';
export { RECORD_ALT_BUDGET_MS, RECORD_BUDGET_MS, RECORD_MAX_MS, disableAutofill, looksLikeSecretSegment, maskPathSecrets, recordSession } from './record-session.js';
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
export { personaAuthReader } from './persona-auth.js';
export type { PersonaAuthSource, PersonaRequestAuth } from './persona-auth.js';
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
export { browserSandbox, launchOptions, playwrightExecutable } from './launch.js';
export type { BrowserSandbox, LaunchSecurity } from './launch.js';
export type { ChromiumProbe } from './probe.js';
export { ArtefactStore, artefactSlug, previewText, htmlText, sniffMime, extensionFor, imageSize, projectDocuments, EMAIL_PREVIEW_CHARS } from './artefacts/store.js';
export { ArtefactRenderer, sandboxedEmail, EMAIL_WIDTH, EMAIL_SCALE, PDF_SCALE, ICON_SIZE } from './artefacts/render.js';
export { MailboxClient, mailMatches, parseAddress, parseAddressList, formatAddress, inlineCids } from './artefacts/mailbox.js';
export type { MailAddress, MailMessage, MailSummary } from './artefacts/mailbox.js';
export { ARTEFACT_TIMEOUT_S, captureValue, textPattern } from './actions/artefacts.js';
export { NOTIFICATION_BINDING, launchTarget } from './session.js';
export type { NotificationPayload } from './session.js';
export * from './raw/index.js';
// Named too (L7.22): the raw export's vocabulary that the types entry names (types-entry.test reads named exports).
export type { ExportCaptureOptions, RawExportProgress, RawExportResult, RawManifest, RawManifestClip } from './raw/export.js';
export { CURSOR_BINDING } from './session.js';
export { pushCursorEffect } from './timeline.js';
export { materialize, runFfmpeg } from './encode.js';
export { PROFILE_BROWSER_FILE, checkProfileBrowser, launchMajor, profileMajor, recordProfileBrowser } from './profile-browser.js';
