/**
 * @retake/runner-web — drives a real web app headless with deterministic pacing, an in-page cursor driven by
 * real input, CDP screencast capture and a timeline of every step (docs/DESIGN.md §3).
 */
export type * from './types-entry.js';
export { runScenario } from './run.js';
export type { RunOptions } from './run.js';
export type { InspectReport } from './inspect.js';
export { extractSite } from './site/extract.js';
export { openSession, BrowserSession } from './session.js';
export { encodeFrames } from './encode.js';
export { kitConfigFor } from './kit/source.js';

export { checkSavedSession, signIn } from './login.js';
export { recordSession } from './record-session.js';
export { projectBrowser } from './config.js';
export { evalHookInPage } from './hook-page.js';
export { personaAuthReader } from './persona-auth.js';
export { RunnerError, StepError, CancelledError, EncodeError, PreflightError, LoginPageError } from './errors.js';
export { prepareSessions, profileLock, readStatus, registerSessionCopy, removeSessionCopiesSync, writeStatus } from './auth.js';
export { probeChromium, chromiumExecutable } from './probe.js';
export type { ChromiumProbe } from './probe.js';
export { MailboxClient, inlineCids } from './artefacts/mailbox.js';
export { rawSettings, rawPackageDir, rawExportRun, exportCapture, RawExportError } from './raw/index.js';
