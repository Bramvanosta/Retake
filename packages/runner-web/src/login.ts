/**
 * `retake login` (L1.6, docs/DESIGN.md §3.6): sign one persona in and save its session — its master profile (this is
 * its only writer), its snapshot (cookies, session cookies included, and localStorage) and the status of a check made
 * the way a run makes it (on a copy of the master plus the snapshot's cookies). Headed: a visible window the user signs
 * in with (SSO, 2FA…), closed by the user; auto: the persona's login steps, headless (tests, CI, a quick refresh). Both
 * start from the saved session as a run does (the master plus the snapshot's cookies).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { LEGACY_PERSONA, resolveCheckUrl, resolveEnvironment, resolvePageUrl, resolvePersonas } from '@retake/core';
import type { BrowserConfig, LoadedProject, ResolvedPersona, TemplateContext } from '@retake/core';
import {
  autoLogin,
  checkPersona,
  ensurePrivateDir,
  isProfileDir,
  prepareSessions,
  profileLock,
  readSnapshot,
  registerSessionCopy,
  writeSnapshot,
  writeStatus,
} from './auth.js';
import type { PersonaCheckResult, SessionSnapshot, SnapshotMeta } from './auth.js';
import { projectBrowser } from './config.js';
import { RunnerError, errorMessage, isCancelled } from './errors.js';
import { checkProfileBrowser, launchMajor, recordProfileBrowser } from './profile-browser.js';
import { kitConfigFor } from './kit/source.js';
import { launchCredentials, launchOptions, refuseUnsandboxed } from './launch.js';
import { RunSecrets } from './secrets.js';
import { BrowserSession, DEFAULT_BROWSER_ARGS, applyStorageState, launchTarget } from './session.js';
import type { StorageStateFile } from './session.js';
import { throwIfAborted } from './util.js';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** How often the headed window's cookies and localStorage are read (the window may be quit at any time). */
const POLL_MS = 1500;

export interface SignInOptions {
  project: LoadedProject;
  env: { name: string; pages: Record<string, string> };
  persona: ResolvedPersona;
  /** headed: a visible window, closed by the user; auto: the persona's login steps, headless. */
  mode: 'headed' | 'auto';
  /** Environment page the window opens (default: the persona's check URL, else its first page). */
  page?: string;
  /** Explicit URL the window opens (over `page`). */
  url?: string;
  browser?: BrowserConfig;
  /** Resolves `{{env:…}}` / `{{keychain:…}}` of the login steps (default core resolveSecretRef; tests inject one). */
  resolveSecret?: (ref: string) => Promise<string>;
  log?: Log;
  /** Called once the window shows its first page (the CLI says what to do). */
  onOpen?: (url: string) => void;
  /** Test hook: plays the user in the headed window (fills the form, then closes the page or the browser). */
  drive?: (page: Page) => Promise<void>;
  /** With `drive`: the "headed" window runs headless (tests without a display). */
  headless?: boolean;
  /**
   * Cancels the sign-in (the CLI's Ctrl-C): the window or the browser closes, its temporary profile is removed, nothing
   * is saved; throws a CancelledError.
   */
  signal?: AbortSignal;
}

export interface SignInResult {
  persona: string;
  /** The check made the way a run sees the session (a copy + the snapshot); `unchecked` without a check. */
  check: PersonaCheckResult;
  /** The master profile signed in (none for a `storage_state` persona). */
  profileDir?: string;
  /** The snapshot written (none for the legacy single-account form: its files are the user's). */
  snapshot?: string;
  cookies: number;
  origins: number;
  /** The page the window opened. */
  url: string;
  /** auto: the saved session was still valid, no login step ran (it is kept as it is). */
  alreadySignedIn?: boolean;
  /** headed: the window ended signed out while the session saved before still works: that one is kept. */
  kept?: boolean;
}

/**
 * A new profile never offers to save a password: Playwright runs Chromium with a mock keychain, so a password saved in
 * the login window would sit in the profile in the clear (runs leave `Login Data` out of their copies anyway).
 */
export async function seedProfilePreferences(userDataDir: string): Promise<void> {
  const file = join(userDataDir, 'Default', 'Preferences');
  if (existsSync(file)) return;
  await mkdir(join(userDataDir, 'Default'), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false } }), { mode: 0o600 });
}

/**
 * Wait until the browser that held a profile has exited (at most `ms`): Chromium still writes its profile for a moment
 * after its window closed or it was quit — its lock is gone by then, its process not yet — and the check copies it.
 */
async function profileReleased(lockPid: number | undefined, ms = 10_000): Promise<void> {
  if (!lockPid) return;
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(lockPid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The page a login window opens: `url` > `page` > the persona's check URL > its first page. */
function startUrl(o: Pick<SignInOptions, 'url' | 'page' | 'persona' | 'env'>): string {
  if (o.url) return o.url;
  if (o.page !== undefined) {
    if (!Object.hasOwn(o.env.pages, o.page)) {
      throw new RunnerError(`environment "${o.env.name}" has no page "${o.page}" (pages: ${Object.keys(o.env.pages).join(', ') || 'none'})`);
    }
    return resolvePageUrl(o.env.pages[o.page], '/');
  }
  const u = resolveCheckUrl(o.persona, o.env.pages);
  if (!u) throw new RunnerError(`environment "${o.env.name}" has no page to open: give --url`);
  return u;
}

function personaLabel(p: Pick<ResolvedPersona, 'name' | 'env'>): string {
  return `persona ${p.name} (env ${p.env})`;
}

/**
 * Sign a persona in (`retake login`): refuses a master profile open in another browser; signs in on the master (a
 * `storage_state` persona: on a temporary profile, only the snapshot is kept), starting from the saved session as a run
 * does (the snapshot's cookies; all of it for a `storage_state` persona); writes the snapshot (0600) and, when the
 * persona has a check, the status of a check made on a copy + the snapshot — exactly what the next run will see. A
 * session still valid is kept as it is (auto); a window that ends signed out never replaces a saved session that still
 * works (headed). A first sign-in that fails or is cancelled leaves no profile behind.
 */
export async function signIn(o: SignInOptions): Promise<SignInResult> {
  const p = o.persona;
  const log: Log = o.log ?? (() => undefined);
  if (o.mode === 'auto' && !p.login?.length) {
    throw new RunnerError(`${personaLabel(p)} declares no login steps (auth.personas.${p.name}.login): sign in by hand — retake login without --auto`);
  }
  throwIfAborted(o.signal);
  const master = p.session === 'profile' ? p.profileDir : undefined;
  if (master) {
    const lock = await profileLock(master);
    if (lock.state === 'live') {
      throw new RunnerError(
        `the profile of ${personaLabel(p)} is open in another browser${lock.pid ? ` (pid ${lock.pid})` : ''} — another retake login window, or a browser started on it? Close it, then try again`,
      );
    }
  }
  const url = startUrl(o);
  // The session saved so far (the legacy form has none of its own: its files are the user's).
  const snapshot = p.legacy ? undefined : p.snapshot;
  let saved: SessionSnapshot | null = null;
  if (snapshot) {
    try {
      saved = await readSnapshot(snapshot);
    } catch (e) {
      log('warn', `${errorMessage(e)} — signing in replaces it`);
    }
  }
  // Applied as a run applies it: a profile persona takes the snapshot's cookies (session cookies are lost when a
  // profile closes), a storage_state persona all of it.
  const applied: StorageStateFile | undefined = saved ? (master ? { cookies: saved.cookies ?? [] } : { cookies: saved.cookies ?? [], origins: saved.origins ?? [] }) : undefined;
  const firstProfile = master !== undefined && !(await isProfileDir(master));
  const temp = master ? null : await mkdtemp(join(tmpdir(), 'retake-login-'));
  if (temp) registerSessionCopy(temp);
  const userDataDir = master ?? temp!;
  let state: StorageStateFile;
  let first: PersonaCheckResult | undefined;
  try {
    await ensurePrivateDir(userDataDir);
    await seedProfilePreferences(userDataDir);
    if (o.mode === 'auto') {
      const r = await autoSession(o, userDataDir, url, log, applied);
      state = r.state;
      first = r.stillValid;
    } else {
      state = await headedSession(o, userDataDir, url, applied);
    }
    throwIfAborted(o.signal);
  } catch (e) {
    // A first sign-in that fails leaves nothing (`retake auth status` says "never", not "saved, never checked").
    if (firstProfile && master) await rm(master, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
  const meta = { project: o.project.slug, env: o.env.name, persona: p.name, how: o.mode === 'auto' ? 'auto' : 'manual' };
  let check: PersonaCheckResult;
  let kept = false;
  if (first) {
    // auto, still signed in (checked the way a run sees it): the saved session is kept as it is.
    check = first;
    if (snapshot && !saved) await writeSnapshot(snapshot, state, meta);
  } else if (snapshot && saved && o.mode === 'headed' && p.check) {
    ({ check, kept } = await saveUnlessSignedOut({ ...o, log }, snapshot, state, meta));
  } else {
    if (snapshot) await writeSnapshot(snapshot, state, meta);
    check = await checkSavedSession({ ...o, log });
  }
  if (check.status !== 'unchecked') await writeStatus(p.statusFile, { status: check.status, by: 'login', ...(check.at ? { at: check.at } : {}), detail: check.detail });
  // The snapshot the persona keeps: the saved one when it was kept, else the new one.
  const unchanged = (first !== undefined || kept) && saved ? saved : null;
  return {
    persona: p.name,
    check,
    ...(master ? { profileDir: master } : {}),
    ...(snapshot ? { snapshot } : {}),
    cookies: (unchanged ?? state).cookies?.length ?? 0,
    origins: (unchanged ?? state).origins?.length ?? 0,
    url,
    ...(first ? { alreadySignedIn: true } : {}),
    ...(kept ? { kept } : {}),
  };
}

/**
 * headed, over a saved session: the window may have been closed before signing in, or have signed out — a saved session
 * that still works is never replaced with a signed-out one. The window's session is written next to the snapshot
 * (0600) and checked; when it is not valid and the saved one still is, the saved one is kept, else it replaces it.
 */
async function saveUnlessSignedOut(
  o: Pick<SignInOptions, 'project' | 'env' | 'persona' | 'browser' | 'log' | 'signal'>,
  snapshot: string,
  state: StorageStateFile,
  meta: Pick<SnapshotMeta, 'project' | 'env' | 'persona' | 'how'>,
): Promise<{ check: PersonaCheckResult; kept: boolean }> {
  const candidate = `${snapshot}.new`;
  try {
    await writeSnapshot(candidate, state, meta);
    const check = await checkSavedSession({ ...o, persona: { ...o.persona, snapshot: candidate } });
    if (check.status !== 'valid') {
      const before = await checkSavedSession(o);
      if (before.status === 'valid') return { check: before, kept: true };
    }
    await rename(candidate, snapshot);
    return { check, kept: false };
  } finally {
    await rm(candidate, { force: true }).catch(() => undefined);
  }
}

/** The browser of an automated login or of a check: a session (kit, bindings) of one realm, headless. */
function sessionOptions(o: Pick<SignInOptions, 'project' | 'browser' | 'env'>, log: Log) {
  const capture = o.project.config.capture;
  const httpCredentials = launchCredentials(o.project, o.env.name);
  return {
    ...(httpCredentials ? { httpCredentials } : {}),
    width: capture.width,
    height: capture.height,
    scale: capture.scale,
    kit: kitConfigFor(undefined),
    browser: projectBrowser(o.project, o.browser),
    log,
  };
}

/**
 * auto: on the master itself plus the saved session (`applied`, as a run applies it) — checked first (nothing to do
 * when still valid: `stillValid`), else the login steps.
 */
async function autoSession(
  o: SignInOptions,
  userDataDir: string,
  url: string,
  log: Log,
  applied: StorageStateFile | undefined,
): Promise<{ state: StorageStateFile; stillValid?: PersonaCheckResult }> {
  const p = o.persona;
  const secrets = new RunSecrets(o.resolveSecret);
  const session = await BrowserSession.open({
    ...sessionOptions(o, log),
    realms: [{ name: p.name, userDataDir, ...(applied ? { storageState: applied } : {}) }],
    realmOf: () => p.name,
  });
  const pid = (await profileLock(userDataDir)).pid;
  try {
    const context = await session.contextOf(p.name);
    const deps = { envPages: o.env.pages, kitSource: session.source, ...(o.signal ? { signal: o.signal } : {}) };
    o.onOpen?.(url);
    if (p.check) {
      const first = await checkPersona(context, p, deps);
      if (first.status === 'valid') return { state: await context.storageState(), stillValid: first };
      if (first.status === 'error') throw new RunnerError(`${personaLabel(p)} could not be checked — ${first.detail}`);
    }
    try {
      await secrets.prefetch(p.login);
    } catch (e) {
      throw new RunnerError(`the login steps of ${personaLabel(p)} cannot run: ${errorMessage(e)}`);
    }
    const template: TemplateContext = {
      pages: o.env.pages,
      vars: { ...(o.project.config.vars ?? {}) },
      run: { id: 'login' },
      hooks: {},
      secrets: secrets.resolver,
    };
    try {
      await autoLogin(context, p, { ...deps, template, secrets });
    } catch (e) {
      if (isCancelled(e) || o.signal?.aborted) throw e;
      throw new RunnerError(`automated login of ${personaLabel(p)} failed: ${secrets.redactText(errorMessage(e))}`);
    }
    return { state: await context.storageState() };
  } finally {
    await session.close();
    await profileReleased(pid);
  }
}

/**
 * headed: a visible window on the master, showing the saved session (`applied`, as a run applies it); resolves when
 * the user closed its last page or quit the browser (or `signal` aborted: the window closes). Cookies (session cookies
 * included) and the localStorage of the open pages are read every 1.5 s — a quit browser cannot be read any more — and
 * the cookies once more when the last page closes; the localStorage of origins not open then is the saved one.
 */
async function headedSession(o: SignInOptions, userDataDir: string, url: string, applied: StorageStateFile | undefined): Promise<StorageStateFile> {
  const b = projectBrowser(o.project, o.browser);
  const { executablePath, channel } = launchTarget(b);
  // L5.16c: never an older Chromium than the one that opened this profile last (profile-browser.ts).
  const major = launchMajor({ executablePath, channel });
  checkProfileBrowser(userDataDir, major);
  const httpCredentials = launchCredentials(o.project, o.env.name);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: o.headless === true,
    channel,
    executablePath,
    viewport: null,
    locale: b.locale,
    timezoneId: b.timezone,
    // Ctrl-C is the caller's (the CLI aborts `signal`, which closes the window): Playwright would quit the process.
    handleSIGINT: false,
    handleSIGTERM: false,
    ...(httpCredentials ? { httpCredentials: { ...httpCredentials } } : {}),
    ...launchOptions({ args: [...DEFAULT_BROWSER_ARGS.filter((a) => a !== '--hide-scrollbars'), ...(b.args ?? [])] }),
  });
  await refuseUnsandboxed(context.browser(), () => context.close(), 'The sign-in browser');
  recordProfileBrowser(userDataDir, major);
  const pid = (await profileLock(userDataDir)).pid;
  try {
    if (applied) await applyStorageState(context, applied);
  } catch (e) {
    await context.close().catch(() => undefined);
    await profileReleased(pid);
    throw e;
  }
  let cookies: NonNullable<StorageStateFile['cookies']> = await context.cookies().catch(() => []);
  const storage = new Map<string, Array<{ name: string; value: string }>>((applied?.origins ?? []).map((x) => [x.origin, x.localStorage ?? []]));
  let open = true;
  const read = async (withStorage: boolean): Promise<void> => {
    if (!open) return;
    try {
      cookies = await context.cookies();
    } catch {
      /* the browser is going away: keep the last read */
    }
    if (!withStorage) return;
    for (const page of context.pages()) {
      try {
        const r = await page.evaluate(() => ({ origin: location.origin, items: Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) ?? '' })) }));
        if (/^https?:/.test(r.origin)) storage.set(r.origin, r.items);
      } catch {
        /* a page loading, closed, or without storage (about:blank) */
      }
    }
  };
  let reading: Promise<void> = Promise.resolve();
  const poll = setInterval(() => {
    reading = reading.then(() => read(true));
  }, POLL_MS);
  let driveError: unknown = null;
  const onAbort = () => void context.close().catch(() => undefined);
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const closed = new Promise<void>((resolve) => {
      context.on('close', () => {
        open = false;
        resolve();
      });
      const watch = (page: Page) =>
        page.on('close', () => {
          if (context.pages().length > 0) return;
          // The last page closed (the browser may stay open on macOS): read once more, then close it.
          reading = reading.then(() => read(false)).then(() => context.close().catch(() => undefined));
        });
      context.pages().forEach(watch);
      context.on('page', watch);
    });
    if (o.signal?.aborted) onAbort();
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url).catch(() => undefined);
    if (!o.signal?.aborted) o.onOpen?.(url);
    if (o.drive) {
      void o.drive(page).catch((e: unknown) => {
        driveError = e;
        void context.close().catch(() => undefined);
      });
    }
    await closed;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    clearInterval(poll);
    open = false;
    await reading.catch(() => undefined);
    await context.close().catch(() => undefined);
    await profileReleased(pid);
  }
  throwIfAborted(o.signal);
  if (driveError) throw driveError;
  return { cookies, origins: [...storage].map(([origin, localStorage]) => ({ origin, localStorage })) };
}

/**
 * Check a persona's saved session the way a run sees it — a copy of its master + its snapshot's cookies, in a headless
 * browser of its own (closed after, its copy removed) — without signing in. `unchecked` when the persona declares no
 * check; a master open in another browser fails (PreflightError); `signal` cancels it (CancelledError).
 */
export async function checkSavedSession(o: Pick<SignInOptions, 'project' | 'env' | 'persona' | 'browser' | 'log' | 'signal'>): Promise<PersonaCheckResult> {
  const p = o.persona;
  const log: Log = o.log ?? (() => undefined);
  if (!p.check) return { status: 'unchecked', detail: 'no check declared', ms: 0 };
  throwIfAborted(o.signal);
  const prepared = await prepareSessions([p], { runId: `check-${Date.now()}`, log, failure: `cannot check the saved session of ${personaLabel(p)}:` });
  const session = await BrowserSession.open({ ...sessionOptions(o, log), realms: prepared.map((x) => x.realm), realmOf: () => p.name });
  try {
    return await checkPersona(await session.contextOf(p.name), p, { envPages: o.env.pages, kitSource: session.source, ...(o.signal ? { signal: o.signal } : {}) });
  } finally {
    await session.close();
  }
}

export interface LoginOptions {
  project: LoadedProject;
  env?: string;
  /** Environment page key to open (default: the first one). */
  page?: string;
  /** Explicit URL (overrides env/page). */
  url?: string;
  browser?: BrowserConfig;
}

/**
 * The legacy single-account form (`auth.profile`): a HEADED browser on the project's profile, to sign in once; resolves
 * when the window is closed. Runs use a copy of the profile.
 */
export async function openLoginBrowser(opts: LoginOptions): Promise<{ profileDir: string; url: string }> {
  const env = resolveEnvironment(opts.project, opts.env);
  const persona = resolvePersonas(opts.project, env.name).find((x) => x.legacy && x.name === LEGACY_PERSONA);
  if (!persona?.profileDir) {
    throw new RunnerError(
      `project "${opts.project.slug}" has no auth.profile${env.name ? ` for environment "${env.name}"` : ''}: add one to project.yaml to keep a signed-in browser profile`,
    );
  }
  const key = opts.page ?? Object.keys(env.pages)[0];
  const r = await signIn({ project: opts.project, env, persona, mode: 'headed', ...(key !== undefined ? { page: key } : {}), ...(opts.url ? { url: opts.url } : {}), browser: opts.browser });
  return { profileDir: persona.profileDir, url: r.url };
}
