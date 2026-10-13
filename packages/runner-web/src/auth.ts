/**
 * Sessions & personas at run time (L1.6, docs/DESIGN.md §3.6): each persona a run films is signed in on a copy of its
 * session (its master profile, never opened by a run, plus the cookies of its snapshot), checked off camera before
 * anything runs (the preflight), signed in automatically when it declares login steps, and watched during the run (a
 * page landing on a sign-in page fails the run: the guard).
 *
 * Files (core personaPaths): the master profile (`studio login` is its only writer), the snapshot (Playwright storage
 * state + `demo_studio` metadata) and the status of the last check — snapshots and status files are written 0600 in
 * 0700 folders; per-run copies live in the system temp folder (0700) and are removed when the browser closes.
 */
import { constants as fsConstants } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import {
  PERSONA_CHECK_TIMEOUT_S,
  describeTarget,
  interpolateAt,
  isAbsoluteUrl,
  loginCommand,
  loginMatchers,
  matchLoginUrl,
  normalizeStep,
  normalizeTarget,
  resolveCheckUrl,
  resolvePageUrl,
  splitPageOpen,
  urlOriginPath,
  writeTextAtomic,
} from '@demo-studio/core';
import type {
  LoginMatcher,
  LoginStep,
  NormalizedStep,
  OpenArgs,
  PressArgs,
  ResolvedPersona,
  Step,
  TargetObject,
  TargetSpec,
  TemplateContext,
  TypeArgs,
  WaitForArgs,
} from '@demo-studio/core';
import { LoginPageError, PreflightError, RunnerError, errorMessage, isCancelled } from './errors.js';
import type { RunSecrets } from './secrets.js';
import { KitClient } from './session.js';
import type { BrowserSession, RealmSpec, StorageStateFile } from './session.js';
import { STALE_COPY_AGE_MS, SESSION_COPY_PREFIXES, isLiveCopy, registerSessionCopy } from './copies.js';
import { fileSlug, sleep, throwIfAborted, wallNow } from './util.js';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** Default timeout of a login step (seconds). */
const LOGIN_STEP_TIMEOUT_S = 15;
/** Without `expect_text`, a check is valid once its page loaded this long ago off every sign-in page. */
const CHECK_SETTLE_MS = 500;

function firstLine(s: string): string {
  return s.split('\n')[0];
}

// ── The master profile: lock and copy ───────────────────────────────────────────

/** Whether a Chromium profile is in use: `live` (a running browser holds it), `stale` (a crashed one left its lock), `none`. */
export interface ProfileLock {
  state: 'none' | 'live' | 'stale';
  pid?: number;
  host?: string;
}

/** Whether a host name is this computer's (Chromium writes the full name, macOS sometimes the short one). */
function isThisHost(h: string): boolean {
  const a = h.toLowerCase();
  const b = hostname().toLowerCase();
  return a === b || a.split('.')[0] === b.split('.')[0];
}

/**
 * Read a profile's `SingletonLock`: Chromium makes it a symbolic link to "<host>-<pid>" while it runs (a dangling link,
 * so `existsSync` says false). Live when the pid runs on this computer (or the lock is from another computer, or a
 * plain file: no way to tell); stale when that process is gone.
 */
export async function profileLock(dir: string): Promise<ProfileLock> {
  const file = join(dir, 'SingletonLock');
  try {
    const st = await lstat(file);
    if (!st.isSymbolicLink()) return { state: 'live' };
  } catch {
    return { state: 'none' };
  }
  let target: string;
  try {
    target = await readlink(file);
  } catch {
    return { state: 'live' };
  }
  const dash = target.lastIndexOf('-');
  const host = dash > 0 ? target.slice(0, dash) : target;
  const pid = dash > 0 ? Number(target.slice(dash + 1)) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'live', host };
  if (!isThisHost(host)) return { state: 'live', pid, host };
  try {
    process.kill(pid, 0);
    return { state: 'live', pid, host };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? { state: 'live', pid, host } : { state: 'stale', pid, host };
  }
}

/** Entries of a profile a run copy leaves out, by exact name: caches (rebuilt) and crash reports. */
const SKIP_NAMES = new Set([
  'Crashpad',
  'component_crx_cache',
  'extensions_crx_cache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'GPUCache',
  'Cache',
  'Code Cache',
]);
/**
 * …and by name prefix: the lock of the running browser, metrics, and the saved passwords and autofill data — Playwright
 * runs Chromium with a mock keychain, so a password saved in the login window is kept in the clear there: never copied.
 */
const SKIP_PREFIXES = ['Singleton', 'BrowserMetrics', 'Login Data', 'Web Data'];

/** Whether a profile entry (file or folder name) is left out of a run copy. */
export function skippedInCopy(name: string): boolean {
  return SKIP_NAMES.has(name) || SKIP_PREFIXES.some((p) => name.startsWith(p)) || /^Dawn.*Cache$/.test(name);
}

/**
 * Copy a master profile into `dest` (copy-on-write clones where the disk supports it), leaving out `skippedInCopy`. A
 * profile path that is a symbolic link (a profile moved to another disk) is copied from its target.
 */
export async function copyProfile(master: string, dest: string): Promise<void> {
  const root = await realpath(master);
  await cp(root, dest, {
    recursive: true,
    force: true,
    mode: fsConstants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: (src) => resolve(src) === root || !skippedInCopy(basename(src)),
  });
  await chmod(dest, 0o700);
}

/** Whether a profile folder exists and holds something (a master `studio login` made). */
export async function isProfileDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

// ── Copies left behind ────────────────────────────────────────────────────────

export { STALE_COPY_AGE_MS, SESSION_COPY_PREFIXES, registerSessionCopy, removeSessionCopiesSync } from './copies.js';

/**
 * Remove the session copies, login profiles and throwaway profiles a killed process left in the system temp folder
 * (they hold a persona's cookies): folders named `SESSION_COPY_PREFIXES`, untouched for `maxAgeMs` (default STALE_COPY_AGE_MS), with no
 * browser on them (their Chromium lock is not live), never one of this process. Best effort, never throws; returns the
 * folders removed. Runs before each run's copies are made (prepareSessions); the CLI can call it too.
 */
export async function sweepStaleSessionCopies(opts: { dir?: string; maxAgeMs?: number; now?: number } = {}): Promise<string[]> {
  const dir = opts.dir ?? tmpdir();
  const maxAge = opts.maxAgeMs ?? STALE_COPY_AGE_MS;
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!SESSION_COPY_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = join(dir, name);
    if (isLiveCopy(full)) continue;
    try {
      const st = await lstat(full);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || now - st.mtimeMs < maxAge) continue;
      if ((await profileLock(full)).state === 'live') continue;
      await rm(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      /* gone meanwhile, or not ours */
    }
  }
  return removed;
}

// ── Snapshot and status files ───────────────────────────────────────────────────

/** What a snapshot says about itself (it is tied to the computer that made it). */
export interface SnapshotMeta {
  version: 1;
  project: string;
  env: string;
  persona: string;
  /** os.hostname() of the computer that saved it. */
  machine: string;
  created_at: string;
  /** How it was made: `manual` (a headed `studio login`), `auto` (login steps)… */
  how: string;
}

/** A session snapshot: Playwright storage state (cookies, session cookies included, and localStorage) + its metadata. */
export interface SessionSnapshot extends StorageStateFile {
  demo_studio?: SnapshotMeta;
}

/** A snapshot, or null when there is none; an unreadable one fails (a RunnerError naming the file). */
export async function readSnapshot(file: string): Promise<SessionSnapshot | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RunnerError(`cannot read the session snapshot ${file}: ${errorMessage(e)}`);
  }
  try {
    return JSON.parse(text) as SessionSnapshot;
  } catch (e) {
    throw new RunnerError(`the session snapshot ${file} is not valid JSON: ${errorMessage(e)}`);
  }
}

/** A folder only its owner can read (created with its parents when missing). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** Write a snapshot: 0600 in a 0700 folder, stamped with this computer and the time. */
export async function writeSnapshot(
  file: string,
  state: StorageStateFile,
  meta: Pick<SnapshotMeta, 'project' | 'env' | 'persona' | 'how'>,
): Promise<void> {
  await ensurePrivateDir(join(file, '..'));
  const out: SessionSnapshot = {
    cookies: state.cookies ?? [],
    origins: state.origins ?? [],
    demo_studio: { version: 1, ...meta, machine: hostname(), created_at: new Date().toISOString() },
  };
  await writeTextAtomic(file, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
}

/** The status of a persona's last check (`studio auth status` shows it; "never" is not stored: no session at all). */
export interface PersonaStatusRecord {
  version: 1;
  status: 'valid' | 'expired' | 'error';
  checked_at: string;
  /** run: the session expired during a run (a page landed on its sign-in page, or a failed step was checked). */
  by: 'preflight' | 'login' | 'auth-status' | 'run';
  /** The run whose preflight checked it (or during which it expired). */
  run?: string;
  /** Where the check ended: origin + path (never a query string). */
  at?: string;
  detail?: string;
}

export async function readStatus(file: string): Promise<PersonaStatusRecord | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as PersonaStatusRecord;
  } catch {
    return null;
  }
}

export async function writeStatus(file: string, status: Omit<PersonaStatusRecord, 'version' | 'checked_at'>): Promise<void> {
  await ensurePrivateDir(join(file, '..'));
  const out: PersonaStatusRecord = { version: 1, ...status, checked_at: new Date().toISOString() };
  await writeTextAtomic(file, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
}

// ── Per-run sessions ────────────────────────────────────────────────────────────

/** A persona's browser for one run, ready to launch. */
export interface PreparedSession {
  persona: ResolvedPersona;
  realm: RealmSpec;
  /** Where its session comes from: a copy of the master profile, the snapshot alone, or nothing (never signed in). */
  source: 'copy' | 'snapshot' | 'fresh';
}

/** First line of a failure of the preflight (and of prepareSessions for a run). */
const PREFLIGHT_FAILED = 'session preflight failed — nothing was recorded:';

function preflightFailure(lines: string[], header = PREFLIGHT_FAILED): PreflightError {
  return new PreflightError([header, ...lines].join('\n'));
}

function personaLabel(p: Pick<ResolvedPersona, 'name' | 'env'>): string {
  return `persona ${p.name} (env ${p.env})`;
}

/**
 * Prepare each persona's browser for one run, never touching its master: a `profile` persona runs on a copy of its
 * master profile (caches, locks and saved passwords left out) plus its snapshot's cookies (session cookies are lost
 * when a profile closes; the snapshot keeps them) — the legacy form applies the whole storage state, as before; with no
 * master, on a fresh profile plus the snapshot; a `storage_state` persona on a fresh profile plus its snapshot. A master
 * held by a running browser (the `studio login` window) is refused: Chromium writes cookies lazily, a copy taken then
 * may miss them. The legacy `auth.storage_state` file must exist (as before L1.6: only a missing legacy profile starts
 * signed out). Stale copies of killed processes are swept first; on failure the copies made so far are removed.
 * `failure`: the first line of a failure when the sessions are not for a run (a check, the js hooks of the CLI).
 */
export async function prepareSessions(
  personas: readonly ResolvedPersona[],
  opts: { runId: string; log: Log; failure?: string },
): Promise<PreparedSession[]> {
  const out: PreparedSession[] = [];
  const swept = await sweepStaleSessionCopies();
  if (swept.length) opts.log('debug', `removed ${swept.length} session cop${swept.length === 1 ? 'y' : 'ies'} a killed run left in ${tmpdir()}`);
  try {
    for (const persona of personas) {
      const snapshot = persona.snapshot ? await readSnapshot(persona.snapshot) : null;
      if (persona.legacy && persona.snapshot && !snapshot) {
        throw preflightFailure(
          [
            `  ${personaLabel(persona)}: its auth.storage_state file does not exist: ${persona.snapshot}`,
            '    export it again, or name the account in auth.personas and sign it in with `studio login`',
          ],
          opts.failure,
        );
      }
      const machine = snapshot?.demo_studio?.machine;
      if (machine && !isThisHost(machine)) {
        opts.log('warn', `${personaLabel(persona)}: its saved session was made on another computer (${machine}): sessions are tied to one computer — sign in here if the check fails`);
      }
      const state: StorageStateFile | undefined = snapshot ? { cookies: snapshot.cookies ?? [], origins: snapshot.origins ?? [] } : undefined;
      if (persona.session === 'profile' && persona.profileDir && (await isProfileDir(persona.profileDir))) {
        const lock = await profileLock(persona.profileDir);
        if (lock.state === 'live') {
          throw preflightFailure(
            [
              `  ${personaLabel(persona)}: its profile is open in another browser${lock.pid ? ` (pid ${lock.pid}${lock.host && !isThisHost(lock.host) ? ` on ${lock.host}` : ''})` : ''} — the \`studio login\` window? Close it, then ${opts.failure ? 'try' : 'run'} again`,
              `    profile: ${persona.profileDir}`,
            ],
            opts.failure,
          );
        }
        const dest = await mkdtemp(join(tmpdir(), `demo-studio-session-${fileSlug(opts.runId)}-${fileSlug(persona.name)}-`));
        registerSessionCopy(dest);
        // Profile personas take only the snapshot's cookies: localStorage travels in the profile (an init script would
        // bring back keys the app removed during the run).
        const applied = state ? (persona.legacy ? state : { cookies: state.cookies }) : undefined;
        out.push({ persona, realm: { name: persona.name, userDataDir: dest, cleanup: [dest], ...(applied ? { storageState: applied } : {}) }, source: 'copy' });
        const t = wallNow();
        try {
          await copyProfile(persona.profileDir, dest);
        } catch (e) {
          throw new RunnerError(`${personaLabel(persona)}: its profile could not be copied for this run (${persona.profileDir}): ${errorMessage(e)}`, { cause: e });
        }
        opts.log('debug', `${personaLabel(persona)}: copied its profile for this run in ${Math.round(wallNow() - t)} ms`);
      } else if (state) {
        out.push({ persona, realm: { name: persona.name, storageState: state }, source: 'snapshot' });
      } else {
        out.push({ persona, realm: { name: persona.name }, source: 'fresh' });
      }
    }
  } catch (e) {
    for (const p of out) for (const dir of p.realm.cleanup ?? []) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return out;
}

// ── The check ─────────────────────────────────────────────────────────────────

/**
 * Run `work` on an off-camera page until it settles or the run is aborted (Ctrl-C): an abort closes the page — a
 * pending `goto` rejects at once instead of after its timeout — and throws the abort's reason.
 */
async function untilAborted<T>(page: Page, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (!signal) return work();
  throwIfAborted(signal);
  const onAbort = () => void page.close().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await work();
  } catch (e) {
    throwIfAborted(signal);
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** What a persona check found. */
export interface PersonaCheckResult {
  /** unchecked: the persona declares no check. */
  status: 'valid' | 'expired' | 'error' | 'unchecked';
  /** What it saw, for messages and the status file (never a query string). */
  detail: string;
  /** Where it ended: origin + path. */
  at?: string;
  ms: number;
}

export interface CheckDeps {
  envPages: Record<string, string>;
  /** The kit (session.source): the check reads visible text with it. */
  kitSource: string;
  signal?: AbortSignal;
}

/**
 * Check a persona off camera, in a tab of its own browser (closed after): open check.url; expired when it lands on a
 * sign-in page (its login patterns) or answers 401 / 403, or `expect_text` does not show within `timeout`; valid when
 * `expect_text` shows (without one: once the page loaded off every sign-in page); error when the page cannot load.
 */
export async function checkPersona(context: BrowserContext, persona: ResolvedPersona, deps: CheckDeps): Promise<PersonaCheckResult> {
  const started = wallNow();
  const done = (status: PersonaCheckResult['status'], detail: string, at?: string): PersonaCheckResult => ({
    status,
    detail,
    ...(at ? { at } : {}),
    ms: Math.round(wallNow() - started),
  });
  const check = persona.check;
  if (!check) return done('unchecked', 'no check declared');
  const url = resolveCheckUrl(persona, deps.envPages);
  if (!url) return done('error', 'nothing to open: give check.url');
  const label = check.url ?? urlOriginPath(url);
  const matchers = loginMatchers(persona.loginPatterns, deps.envPages);
  const landed = (at: string) => done('expired', `${label} landed on the sign-in page (${urlOriginPath(at)})`, urlOriginPath(at));
  const page = await context.newPage();
  try {
    let status: number | undefined;
    page.on('response', (r) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = r.status();
      } catch {
        /* a detached frame */
      }
    });
    try {
      await untilAborted(page, deps.signal, () => page.goto(url, { waitUntil: 'load', timeout: 30_000 }));
    } catch (e) {
      if (deps.signal?.aborted || isCancelled(e)) throw e;
      if (matchLoginUrl(page.url(), matchers)) return landed(page.url());
      return done('error', `${label} could not be loaded: ${firstLine(errorMessage(e)).replace(/^page\.goto: /, '')}`);
    }
    const loadedAt = wallNow();
    const kit = new KitClient(page, deps.kitSource);
    const timeoutS = check.timeout ?? PERSONA_CHECK_TIMEOUT_S;
    const deadline = loadedAt + timeoutS * 1000;
    for (;;) {
      const at = page.url();
      if (matchLoginUrl(at, matchers)) return landed(at);
      if (status === 401 || status === 403) return done('expired', `${label} answered HTTP ${status}`, urlOriginPath(at));
      if (check.expect_text !== undefined) {
        if (await kit.hasText(check.expect_text).catch(() => false)) return done('valid', `${label} shows ${JSON.stringify(check.expect_text)}`, urlOriginPath(at));
      } else if (wallNow() - loadedAt >= CHECK_SETTLE_MS) {
        return done('valid', `${label} loads off the sign-in pages`, urlOriginPath(at));
      }
      if (wallNow() >= deadline) {
        return done('expired', `${label} does not show ${JSON.stringify(check.expect_text)} within ${timeoutS} s (at ${urlOriginPath(at)})`, urlOriginPath(at));
      }
      await sleep(100, deps.signal);
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ── Automated login ─────────────────────────────────────────────────────────────

/** A login step described for messages from the step AS WRITTEN: tokens, never their values; never the typed text. */
export function describeLoginStep(raw: LoginStep): string {
  const r = raw as Record<string, unknown>;
  const target = (t: unknown): string => {
    try {
      return describeTarget(t as TargetSpec);
    } catch {
      return '?';
    }
  };
  if (r.open !== undefined) return `open ${typeof r.open === 'string' ? r.open : String((r.open as OpenArgs).url)}`.split(/[?#]/)[0];
  if (r.click !== undefined) return `click ${target(r.click)}`;
  if (r.type !== undefined) {
    const into = (r.type as { into?: unknown }).into;
    return into !== undefined ? `type into ${target(into)}` : 'type';
  }
  if (r.press !== undefined) return `press ${typeof r.press === 'string' ? r.press : (r.press as PressArgs).key}`;
  if (r.wait_for !== undefined) {
    const w = r.wait_for;
    if (typeof w === 'string') return `wait_for text ${JSON.stringify(w)}`;
    const o = w as WaitForArgs;
    return `wait_for ${[o.text !== undefined && `text ${JSON.stringify(o.text)}`, o.target !== undefined && target(o.target), o.url !== undefined && `url ${o.url}`].filter(Boolean).join(', ') || 'condition'}`;
  }
  if (r.wait !== undefined) return `wait ${String(r.wait)} s`;
  return 'step';
}

export interface LoginDeps extends CheckDeps {
  /** Pages, vars and the run's secret resolver: the steps are templated with it (their secrets prefetched). */
  template: TemplateContext;
  secrets: RunSecrets;
}

function waitUrlMatches(url: string, pattern: string): boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    try {
      return new RegExp(m[1], m[2]).test(url);
    } catch {
      return url.includes(pattern);
    }
  }
  return url.includes(pattern);
}

/** A login step's element, in view, and where to point (polled until the step's timeout). */
async function locate(kit: KitClient, target: TargetObject, timeoutMs: number, signal?: AbortSignal): Promise<{ x: number; y: number; ref: string }> {
  const deadline = wallNow() + timeoutMs;
  for (;;) {
    const r = await kit.find(target).catch(() => null);
    if (r && r.count > 0 && 'ref' in r) {
      for (let i = 0; i < 4; i++) {
        const op = await kit.scrollPlan(r.ref, 40).catch(() => null);
        if (!op) break;
        await kit.scrollAnimate(op.container, op.top, op.left, 0).catch(() => undefined);
      }
      const pt = await kit.point(r.ref, null).catch(() => null);
      if (pt) return { x: pt.x, y: pt.y, ref: r.ref };
    }
    if (wallNow() >= deadline) throw new RunnerError(`no visible element matches ${describeTarget(target)} after ${(timeoutMs / 1000).toFixed(1)} s`);
    await sleep(100, signal);
  }
}

async function runLoginStep(page: Page, kit: KitClient, step: NormalizedStep, persona: ResolvedPersona, deps: LoginDeps): Promise<void> {
  const timeoutMs = (step.timeout ?? LOGIN_STEP_TIMEOUT_S) * 1000;
  switch (step.action) {
    case 'open': {
      const a = step.args as OpenArgs;
      const keys = Object.keys(deps.envPages);
      let url: string;
      if (a.page !== undefined) {
        if (!Object.hasOwn(deps.envPages, a.page)) throw new RunnerError(`unknown page "${a.page}" (pages: ${keys.join(', ')})`);
        url = resolvePageUrl(deps.envPages[a.page], a.url);
      } else {
        const split = splitPageOpen(a.url, keys);
        const base = deps.envPages[persona.pages[0] ?? keys[0]];
        url = split ? resolvePageUrl(deps.envPages[split.page], split.path) : isAbsoluteUrl(a.url) ? a.url : resolvePageUrl(base ?? '', a.url);
      }
      await untilAborted(page, deps.signal, () => page.goto(url, { waitUntil: a.wait_until ?? 'load', timeout: Math.max(timeoutMs, 30_000) }));
      return;
    }
    case 'click': {
      const pt = await locate(kit, step.args as TargetObject, timeoutMs, deps.signal);
      await page.mouse.click(pt.x, pt.y);
      return;
    }
    case 'type': {
      const a = step.args as TypeArgs;
      if (a.into !== undefined) {
        const pt = await locate(kit, normalizeTarget(a.into), timeoutMs, deps.signal);
        await page.mouse.click(pt.x, pt.y);
        // A copied profile may have filled the field (autofill): typed text must not be appended to it.
        await kit.clearField(pt.ref).catch(() => null);
      } else {
        await kit.clearField(null).catch(() => null);
      }
      await page.keyboard.type(a.text);
      if (a.enter) await page.keyboard.press('Enter');
      return;
    }
    case 'press': {
      const a = step.args as PressArgs;
      for (let n = 0; n < (a.times ?? 1); n++) await page.keyboard.press(a.key);
      return;
    }
    case 'wait_for': {
      const a = step.args as WaitForArgs;
      const ms = (a.timeout ?? step.timeout ?? LOGIN_STEP_TIMEOUT_S) * 1000;
      const deadline = wallNow() + ms;
      if (a.network_idle) await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => undefined);
      const count = async (t: TargetSpec) => ((await kit.find(normalizeTarget(t)).catch(() => null))?.count ?? 0);
      for (;;) {
        const unmet: string[] = [];
        if (a.text !== undefined && !(await kit.hasText(a.text).catch(() => false))) unmet.push(`text ${JSON.stringify(a.text)} is not visible`);
        if (a.not_text !== undefined && (await kit.hasText(a.not_text).catch(() => false))) unmet.push(`text ${JSON.stringify(a.not_text)} is still visible`);
        if (a.target !== undefined && (await count(a.target)) === 0) unmet.push(`${describeTarget(a.target)} is not visible`);
        if (a.gone !== undefined && (await count(a.gone)) > 0) unmet.push(`${describeTarget(a.gone)} is still visible`);
        if (a.url !== undefined && !waitUrlMatches(page.url(), a.url)) unmet.push(`the page is ${urlOriginPath(page.url())}`);
        if (unmet.length === 0) return;
        if (wallNow() >= deadline) throw new RunnerError(`timed out after ${(ms / 1000).toFixed(1)} s: ${unmet.join('; ')}`);
        await sleep(100, deps.signal);
      }
    }
    case 'wait':
      await sleep((step.args as { seconds: number }).seconds * 1000, deps.signal);
      return;
    default:
      throw new RunnerError(`${step.action} is not a login action (open, click, type, press, wait_for, wait)`);
  }
}

/**
 * Run a persona's login steps off camera, in a tab of its own browser (closed after; never a capture page): templated
 * with the run's pages, vars and secrets (prefetched by the caller: their values are redacted), executed with real input
 * and the kit's targets. Errors name the step as written (never a typed value) and are redacted.
 */
export async function autoLogin(context: BrowserContext, persona: ResolvedPersona, deps: LoginDeps): Promise<void> {
  const raw = persona.login ?? [];
  let steps: LoginStep[];
  try {
    steps = interpolateAt(raw, deps.template, ['login']);
  } catch (e) {
    throw new RunnerError(deps.secrets.redactText(errorMessage(e)));
  }
  const page = await context.newPage();
  const kit = new KitClient(page, deps.kitSource);
  try {
    for (let i = 0; i < steps.length; i++) {
      const label = describeLoginStep(raw[i]);
      try {
        await runLoginStep(page, kit, normalizeStep(steps[i] as unknown as Step, i), persona, deps);
      } catch (e) {
        // A cancel (Ctrl-C) is a cancel, never a failed login.
        throwIfAborted(deps.signal);
        if (isCancelled(e)) throw e;
        throw new RunnerError(`login step ${i + 1} (${label}): ${deps.secrets.redactText(firstLine(errorMessage(e)).replace(/^(page|keyboard|mouse)\.\w+: /, ''))}`);
      }
    }
    await untilAborted(page, deps.signal, () => page.waitForLoadState('load', { timeout: 15_000 })).catch((e: unknown) => {
      if (deps.signal?.aborted) throw e;
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ── The preflight ───────────────────────────────────────────────────────────────

export interface PreflightDeps extends LoginDeps {
  project: string;
  env: string;
  runId: string;
  log: Log;
  /** The command that signs a persona in again (default core loginCommand). */
  loginCommand?: (p: { project: string; env: string; persona?: string }) => string;
}

/**
 * Check every persona of a run before anything else runs (no setup hook, no recorder yet), each in its own browser, in
 * parallel. A persona that is not signed in and declares `login` steps is signed in automatically (its secrets
 * resolved one after the other first — a keychain prompt each —, then the logins in parallel) and checked again. The
 * status of each check is saved (an automatic login leaves the saved session expired: nothing is written back). Throws
 * a PreflightError naming each failing persona and the exact `studio login` command to run. The legacy single-account
 * form never fails for a missing or unchecked session (as before L1.6: the run starts signed out).
 */
export async function preflight(session: BrowserSession, prepared: readonly PreparedSession[], deps: PreflightDeps): Promise<void> {
  const command = (p: ResolvedPersona) => (deps.loginCommand ?? loginCommand)({ project: deps.project, env: p.env, persona: p.legacy ? undefined : p.name });
  const failures: string[] = [];
  const statuses: Array<{ persona: ResolvedPersona; status: PersonaStatusRecord['status']; detail: string; at?: string }> = [];
  const fail = (p: PreparedSession, why: string, hint: 'once' | 'again' | 'reach') => {
    failures.push(`  ${personaLabel(p.persona)}: ${why}`);
    failures.push(
      hint === 'once'
        ? `    sign in once: ${command(p.persona)}`
        : hint === 'again'
          ? `    sign in again: ${command(p.persona)}`
          : `    is the app running? Then sign in again if needed: ${command(p.persona)}`,
    );
  };
  const checked = await Promise.all(
    prepared.map(async (p) => ({ p, r: await checkPersona(await session.contextOf(p.persona.name), p.persona, deps) })),
  );
  const toLogin: Array<{ p: PreparedSession; why: string; r: PersonaCheckResult }> = [];
  for (const { p, r } of checked) {
    const never = p.source === 'fresh';
    if (r.status === 'valid') {
      deps.log('debug', `${personaLabel(p.persona)}: signed in (${r.detail}, ${(r.ms / 1000).toFixed(1)} s)`);
      statuses.push({ persona: p.persona, status: 'valid', detail: r.detail, at: r.at });
    } else if (r.status === 'unchecked' && !never) {
      deps.log('debug', `${personaLabel(p.persona)}: not checked (no \`check\`): its session comes from its ${p.source === 'copy' ? 'profile' : 'snapshot'}`);
    } else if (r.status === 'unchecked' && p.persona.legacy) {
      deps.log('warn', `${personaLabel(p.persona)}: no saved session yet (auth.${p.persona.session}): the run starts signed out`);
    } else if (r.status === 'error') {
      fail(p, `could not be checked — ${r.detail}`, 'reach');
      statuses.push({ persona: p.persona, status: 'error', detail: r.detail, at: r.at });
    } else {
      const why = never ? 'never signed in' : `expired — ${r.detail}`;
      if (p.persona.login?.length) toLogin.push({ p, why, r });
      else {
        fail(p, why, never ? 'once' : 'again');
        // "never" is not stored: there is no session to describe.
        if (!never) statuses.push({ persona: p.persona, status: 'expired', detail: r.detail, at: r.at });
      }
    }
  }
  // Automated logins: the secrets first, one persona after the other (each keychain item may prompt), then the logins.
  const ready: typeof toLogin = [];
  for (const t of toLogin) {
    try {
      await deps.secrets.prefetch(t.p.persona.login);
      ready.push(t);
    } catch (e) {
      fail(t.p, `${t.why}; its automated login cannot run: ${deps.secrets.redactText(errorMessage(e))}`, t.p.source === 'fresh' ? 'once' : 'again');
      if (t.p.source !== 'fresh') statuses.push({ persona: t.p.persona, status: 'expired', detail: t.r.detail, at: t.r.at });
    }
  }
  await Promise.all(
    ready.map(async ({ p, why, r }) => {
      const context = await session.contextOf(p.persona.name);
      try {
        await autoLogin(context, p.persona, deps);
      } catch (e) {
        // Cancelled during the login: the run is cancelled (nothing is written about the session).
        if (isCancelled(e) || deps.signal?.aborted) throw e;
        fail(p, `${why}; automated login failed: ${deps.secrets.redactText(errorMessage(e))}`, p.source === 'fresh' ? 'once' : 'again');
        if (p.source !== 'fresh') statuses.push({ persona: p.persona, status: 'expired', detail: r.detail, at: r.at });
        return;
      }
      const again = await checkPersona(context, p.persona, deps);
      if (again.status === 'valid' || again.status === 'unchecked') {
        deps.log('warn', `${personaLabel(p.persona)}: signed in automatically, off camera (${why}) — \`${command(p.persona)}\` saves a session runs can reuse`);
        statuses.push({ persona: p.persona, status: 'expired', detail: `${why}; signed in automatically for run ${deps.runId}`, at: again.at });
      } else {
        fail(p, `${why}; signed in automatically, but the check still fails: ${again.detail}`, p.source === 'fresh' ? 'once' : 'again');
        if (p.source !== 'fresh') statuses.push({ persona: p.persona, status: again.status === 'error' ? 'error' : 'expired', detail: again.detail, at: again.at });
      }
    }),
  );
  for (const s of statuses) {
    await writeStatus(s.persona.statusFile, {
      status: s.status,
      by: 'preflight',
      run: deps.runId,
      ...(s.at ? { at: s.at } : {}),
      detail: deps.secrets.redactText(s.detail),
    }).catch((e: unknown) => deps.log('warn', `${personaLabel(s.persona)}: its status could not be saved: ${errorMessage(e)}`));
  }
  if (failures.length) throw preflightFailure(failures.map((l) => deps.secrets.redactText(l)));
}

// ── The guard ───────────────────────────────────────────────────────────────────

/** What a filmed page is guarded with: its persona (null: none) and that persona's sign-in patterns. */
export interface GuardTarget {
  persona: string | null;
  matchers: LoginMatcher[];
}

/** Where a guarded page landed on a sign-in page. */
export interface Landing {
  pageId: string;
  page: Page;
  /** Its persona (null: none). */
  persona: string | null;
  /** Origin + path of the sign-in page. */
  url: string;
  pattern: string;
  /** What landed there when it is not the page itself (`the document of download "x"`). */
  what?: string;
}

/**
 * Watches the filmed pages (L1.6): the first one whose main frame lands on a sign-in page fails the run — `onLanding`
 * aborts it with the LoginPageError (the run keeps nothing of its capture). Same-document navigations count too
 * (Playwright reports pushState routes as frame navigations).
 */
export class LoginGuard {
  private landed: LoginPageError | null = null;
  private where: Landing | null = null;

  constructor(
    private readonly o: {
      /** The persona and patterns of a capture page (null: not guarded). */
      targetOf: (pageId: string, page: Page) => GuardTarget | null;
      /** Message of the landing (origin + path of the URL only). */
      describe: (l: Landing) => string;
      onLanding: (e: LoginPageError) => void;
    },
  ) {}

  /** The landing, once a page landed on a sign-in page. */
  get error(): LoginPageError | null {
    return this.landed;
  }

  /** Where it landed (null until then). */
  get landing(): Landing | null {
    return this.where;
  }

  /**
   * Check a page's URL (default: the one it shows now) — or a URL `what` reached for it (a downloaded document) —;
   * returns the run's landing error when there is one.
   */
  check(pageId: string, page: Page, url: string = page.url(), what?: string): LoginPageError | null {
    if (this.landed) return this.landed;
    const t = this.o.targetOf(pageId, page);
    if (!t || t.matchers.length === 0) return null;
    const m = matchLoginUrl(url, t.matchers);
    if (!m) return null;
    this.where = { pageId, page, persona: t.persona, url: urlOriginPath(url), pattern: m.pattern, ...(what ? { what } : {}) };
    this.landed = new LoginPageError(this.o.describe(this.where));
    this.o.onLanding(this.landed);
    return this.landed;
  }
}
