/**
 * @demo-studio/runner-web — drives a real web app headless with deterministic pacing, an in-page cursor driven by
 * real input, CDP screencast capture and a timeline of every step (docs/DESIGN.md §3).
 */
export { runScenario } from './run.js';
export type { RunOptions } from './run.js';
export { openSession, BrowserSession, KitClient, DEFAULT_BROWSER_ARGS } from './session.js';
export type { SessionOptions } from './session.js';
export { encodeFrames, cfrSchedule } from './encode.js';
export type { EncodeOptions } from './encode.js';
export type { FrameIndexEntry, RecorderOptions } from './recorder.js';
export { ScreencastRecorder } from './recorder.js';
export { kitSource, kitConfigFor, DEFAULT_CURSOR_SIZE, DEFAULT_RIPPLE_COLOR, CURSOR_STORAGE_KEY } from './kit/source.js';
export type * from './kit/types.js';
export { openLoginBrowser } from './login.js';
export type { LoginOptions } from './login.js';
export { mergePacing, mergeCapture, mergeBrowser, projectBrowser, resolveAuth } from './config.js';
export { CaptureClock, TimelineBuilder, computeIdle, motionCapture } from './timeline.js';
export type { MotionCapture } from './timeline.js';
export { moveDuration, arcPath, easeInOutCubic, isNudge } from './motion.js';
export { evalInPage } from './actions/misc.js';
export { RunnerError, StepError, CancelledError, EncodeError } from './errors.js';
export { StepFailure, describeStep, DEFAULT_STEP_TIMEOUT_S, ERROR_DOM_MAX } from './scenes.js';
export { probeChromium, chromiumExecutable } from './probe.js';
export type { ChromiumProbe } from './probe.js';
