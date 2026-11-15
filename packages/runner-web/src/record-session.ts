/**
 * A recording session (`retake record` / `scenario_record`, part 1: capture): a HEADED window — like `retake
 * login`'s — on a copy of the persona's session, where a person performs a flow once; every action is streamed to
 * `events.jsonl` (core RecordedEvent) for the draft generator. Claude may start a recording, never drive it.
 *
 * Security model (docs/DESIGN.md §3.12):
 * - the recorder (kit/record-script.ts) and a passive copy of the kit run in an ISOLATED WORLD of the window's page,
 *   installed over CDP (`Page.enable`, `Page.addScriptToEvaluateOnNewDocument` with a world name, `Runtime.addBinding`
 *   scoped to that world): the page's scripts cannot see the binding, the kit or the recorder, cannot call them, and
 *   cannot forge an event (only trusted events are recorded); no Playwright binding is exposed;
 * - each message is checked here too: it must come from the recorder's world in the page's main frame, on an origin of
 *   the environment's pages, and not from a sign-in page (the persona's patterns, else the environment's
 *   `auth.login_url`); the page holds its events until the runner says where it is (`__retakeRecVerdict`);
 * - secrets never cross: the page sends no secret-class field's text, masks every remembered secret value in every
 *   string it sends, and tells the runner only salted hashes of the final secret values — this side masks them again
 *   in every string it keeps (write labels and typed URLs included) and passes them to the next documents;
 * - the window's profile is a COPY of the persona's (never its master), its password manager and autofill switched off;
 *   the environment's access applies exactly as in a run (a read-only environment's writes are stopped or mocked by
 *   the write guard, which lists them; on a read-write one every write request of the window is listed, whatever its
 *   host — an API on another host included — so the check replay stops before it); paths are kept without their
 *   query (a typed navigation keeps a filtered one) and with segments that look like a token or an e-mail address
 *   masked, a foreign page by its host alone.
 * Not recorded (warned): tabs and popups the page opens, frames.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import type { BrowserContext, CDPSession } from 'playwright-core';
import { compileWritePolicy, resolveRunAccess } from '@retake/core/environment';
import { isPageOrigin, pageOrigins } from '@retake/core/run';
import type { LoginMatcher, ResolvedPersona, RunAccess } from '@retake/core/environment';
import { ensurePrivateDir, prepareSessions, registerSessionCopy, signInMatchers } from './auth.js';
import { projectBrowser } from './config.js';
import { CancelledError, RunnerError } from './errors.js';
import { checkProfileBrowser, launchMajor } from './profile-browser.js';
import { launchCredentials, launchOptions, refuseUnsandboxed } from './launch.js';
import { DEFAULT_BROWSER_ARGS, applyStorageState, launchTarget } from './session.js';
import type { StorageStateFile } from './session.js';
import { enableServiceWorkerRequests } from './write-guard.js';
import { errorMessage } from '@retake/core/base';
import { RECORD_MAX_MS } from './record-options.js';
import type { Log, RecordSessionOptions, RecordSessionResult } from './record-options.js';
import { keep, newRecording, watchWrites } from './recording.js';
import type { Recording } from './recording.js';
import { installRecorder, listenNavigations, listenRecorder, stopRecording, whenClosed } from './record-window.js';
import type { RecordWindow } from './record-window.js';

export { RECORD_ALT_BUDGET_MS, RECORD_BUDGET_MS, RECORD_MAX_MS } from './record-options.js';
export type { RecordSessionOptions, RecordSessionResult } from './record-options.js';
export { looksLikeSecretSegment, maskPathSecrets } from './record-secrets.js';

/**
 * The recording window's Preferences: no password manager, no autofill (a persona master saved during a headed `retake
 * login` may hold a saved address or card; their values would arrive as typing).
 */
export async function disableAutofill(userDataDir: string): Promise<void> {
  const dir = join(userDataDir, 'Default');
  const file = join(dir, 'Preferences');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let prefs: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const v = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) prefs = v as Record<string, unknown>;
    } catch {
      prefs = {};
    }
  }
  const obj = (k: string): Record<string, unknown> => {
    const v = prefs[k];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  prefs.profile = { ...obj('profile'), password_manager_enabled: false };
  prefs.autofill = { ...obj('autofill'), enabled: false, profile_enabled: false, credit_card_enabled: false };
  await writeFile(file, JSON.stringify(prefs), { mode: 0o600 });
}

/** The window's profile: its folder, the snapshot's cookies to apply, and how to remove the copies. */
interface RecordProfile {
  userDataDir: string;
  state: StorageStateFile | undefined;
  removeCopies: () => Promise<void>;
}

/** The window's profile: a copy of the persona's master (its snapshot's cookies applied), else a fresh one. */
async function openProfile(persona: ResolvedPersona | null, log: Log): Promise<RecordProfile> {
  const cleanup: string[] = [];
  let userDataDir: string;
  let state: StorageStateFile | undefined;
  if (persona) {
    const [prepared] = await prepareSessions([persona], { runId: `record-${Date.now()}`, log, failure: `cannot open the recording window of persona ${persona.name}:` });
    cleanup.push(...(prepared.realm.cleanup ?? []));
    state = typeof prepared.realm.storageState === 'object' ? prepared.realm.storageState : undefined;
    userDataDir = prepared.realm.userDataDir ?? '';
  } else userDataDir = '';
  if (!userDataDir) {
    userDataDir = await mkdtemp(join(tmpdir(), 'retake-session-record-'));
    registerSessionCopy(userDataDir);
    cleanup.push(userDataDir);
  }
  const removeCopies = async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    // The browser's last writes (its "Local State") can land after the context closed: removed again a moment later.
    setTimeout(() => {
      for (const d of cleanup) void rm(d, { recursive: true, force: true }).catch(() => undefined);
    }, 1500).unref();
  };
  return { userDataDir, state, removeCopies };
}

/** Opens the headed window on the profile copy (the caller removes the copies when it fails). */
async function launchWindow(o: RecordSessionOptions, persona: ResolvedPersona | null, userDataDir: string, readOnly: boolean): Promise<BrowserContext> {
  await ensurePrivateDir(userDataDir);
  await disableAutofill(userDataDir);
  if (readOnly) enableServiceWorkerRequests();
  const b = projectBrowser(o.project, o.browser);
  const { executablePath, channel } = launchTarget(b, { headless: o.headless === true, policy: o.policy });
  // A persona's profile copy is never opened by an older Chromium than the one that opened it last.
  if (persona) checkProfileBrowser(userDataDir, launchMajor({ executablePath, channel }), persona.name);
  const size = o.windowSize;
  const httpCredentials = launchCredentials(o.project, o.env.name);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: o.headless === true,
    channel,
    executablePath,
    // The window's real size (a capture viewport larger than the screen would hide the bottom of the page).
    viewport: null,
    locale: b.locale,
    timezoneId: b.timezone,
    handleSIGINT: false,
    handleSIGTERM: false,
    ...(httpCredentials ? { httpCredentials: { ...httpCredentials } } : {}),
    ...launchOptions({
      args: [...DEFAULT_BROWSER_ARGS.filter((a) => a !== '--hide-scrollbars'), ...(size ? [`--window-size=${size.width},${size.height}`] : ['--start-maximized'])],
      browserArgs: b.args,
      policy: o.policy,
    }),
  });
  await refuseUnsandboxed(context.browser(), () => context.close(), 'The recording browser');
  return context;
}

/** The recording's result; warns about what it could not record. */
function recordingResult(rec: Recording, capture: RecordSessionResult['capture'], access: RunAccess, persona: ResolvedPersona | null, warnings: string[]): RecordSessionResult {
  const { dropped, events } = rec;
  if (dropped.new_page) warnings.push(`${dropped.new_page} tab(s) or popup(s) opened during the recording: what happened there is not recorded`);
  if (dropped.frame) warnings.push('actions inside a frame are not recorded');
  if (dropped.sign_in) warnings.push(`${dropped.sign_in} action(s) on a sign-in page were not recorded`);
  const actions = events.filter((e) => ['pointer', 'type', 'key', 'select_native', 'file'].includes(e.kind)).length;
  return {
    events,
    stop: rec.stopReason,
    ms: Date.now() - rec.started,
    window: rec.windowSize,
    capture,
    access: access.mode,
    persona: persona?.name ?? null,
    counts: { events: events.length, actions, writes: events.filter((e) => e.kind === 'write').length, redacted: rec.redactedTotal, dropped },
    warnings,
  };
}

/**
 * Record a flow: opens the headed window on `url`, streams the person's actions until the window is closed (its last
 * page), `stop` aborts, or the maximum duration passes. Throws a CancelledError on `signal` (the events file removed).
 */
export async function recordSession(o: RecordSessionOptions): Promise<RecordSessionResult> {
  const log: Log = o.log ?? (() => undefined);
  if (o.signal?.aborted) throw new CancelledError('recording cancelled');
  const env = o.env;
  const persona = o.persona ?? null;
  if (!isPageOrigin(o.url, env.pages)) throw new RunnerError('a recording opens a page of the environment');
  const access = resolveRunAccess(env, { allowWrites: o.allowWrites === true, project: o.project });
  const policy = compileWritePolicy(env, { access });
  const capture = { width: o.project.config.capture.width, height: o.project.config.capture.height };
  const matchers: LoginMatcher[] = signInMatchers(o.project, env, persona);
  const origins = pageOrigins(env.pages);
  const warnings: string[] = [];
  if (access.notice) warnings.push(access.notice);
  if (policy.readOnly) warnings.push(`environment ${env.name} is read-only: the window's writes are stopped or answered by a mock, as in a run — the app may show an error`);

  const { userDataDir, state, removeCopies } = await openProfile(persona, log);
  let context: BrowserContext;
  try {
    context = await launchWindow(o, persona, userDataDir, policy.readOnly);
  } catch (e) {
    await removeCopies();
    throw e;
  }

  const rec = newRecording(o, log, matchers);
  const binding = `__retakeRec_${randomBytes(8).toString('hex')}`;
  try {
    await watchWrites(context, rec, policy, env);
  } catch (e) {
    await context.close().catch(() => undefined);
    await removeCopies();
    throw e;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  const cdp: CDPSession = await context.newCDPSession(page);
  const win: RecordWindow = { cdp, env, origins, binding, contexts: new Map(), frameOrigin: new Map(), mainFrame: '', topContext: null, starting: true, lastPath: '' };
  listenRecorder(win, rec);
  listenNavigations(win, rec);

  // Tabs and popups the page opens are not recorded.
  context.on('page', (p) => {
    if (p === page) return;
    rec.dropped.new_page++;
    keep(rec, { kind: 'new_page' }, '');
  });

  let maxTimer: NodeJS.Timeout | null = null;
  const onCancel = () => void context.close().catch(() => undefined);
  const stopListener = () => stopRecording(win, rec, context, 'stopped');
  o.stop?.addEventListener('abort', stopListener, { once: true });
  o.signal?.addEventListener('abort', onCancel, { once: true });

  try {
    const closed = whenClosed(context);
    await installRecorder(win, rec);
    if (state) await applyStorageState(context, state);
    if (o.signal?.aborted) onCancel();
    if (o.stop?.aborted) stopListener();
    maxTimer = setTimeout(() => stopRecording(win, rec, context, 'max_duration'), o.maxMs ?? RECORD_MAX_MS);
    await page.goto(o.url).catch(() => undefined);
    win.starting = false;
    if (!o.signal?.aborted && rec.open) o.onOpen?.(o.url);
    if (rec.windowSize === null) await new Promise((r) => setTimeout(r, 100));
    const w = rec.windowSize;
    if (w && w.width < capture.width) {
      warnings.push(
        `the window shows ${w.width}×${w.height} CSS px, narrower than the capture (${capture.width}×${capture.height}): the check replay runs at the capture size and shows any difference`,
      );
    }
    if (o.drive) {
      void o.drive(page).catch((e: unknown) => {
        rec.driveError = e;
        void context.close().catch(() => undefined);
      });
    }
    await closed;
  } finally {
    if (maxTimer) clearTimeout(maxTimer);
    o.stop?.removeEventListener('abort', stopListener);
    o.signal?.removeEventListener('abort', onCancel);
    await context.close().catch(() => undefined);
    if (!o.signal?.aborted) keep(rec, { kind: 'stop', reason: rec.stopReason }, '');
    rec.open = false;
    const { stream } = rec;
    if (stream) await new Promise<void>((r) => stream.end(() => r()));
    await removeCopies();
  }
  if (o.signal?.aborted) {
    if (o.eventsFile) await rm(o.eventsFile, { force: true }).catch(() => undefined);
    throw new CancelledError('recording cancelled: nothing was kept');
  }
  if (rec.driveError) throw rec.driveError;
  if (rec.streamError) throw new RunnerError(`the recording's events could not be written: ${errorMessage(rec.streamError)}`);
  return recordingResult(rec, capture, access, persona, warnings);
}
