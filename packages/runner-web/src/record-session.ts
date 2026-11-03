/**
 * A recording session (L3.4, `retake record` / `scenario_record`, part 1: capture): a HEADED window — like `retake
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
 *   `auth.login_url`); the page holds its events until the runner says where it is (`__dsrecVerdict`);
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
import { createWriteStream, existsSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import {
  RecordedEventSchema,
  compileWritePolicy,
  describeWriteRequest,
  graphqlOf,
  graphqlReadsOnly,
  guardsWrites,
  isGuardedHost,
  isPageOrigin,
  isWriteMethod,
  pageOrigins,
  resolveRunAccess,
  urlOriginPath,
} from '@retake/core';
import type { BrowserConfig, LoadedProject, LoginMatcher, RecordedEvent, ResolvedEnvironment, ResolvedPersona, RunAccess } from '@retake/core';
import { ensurePrivateDir, prepareSessions, registerSessionCopy, signInMatchers } from './auth.js';
import { projectBrowser } from './config.js';
import { CancelledError, RunnerError } from './errors.js';
import { kitConfigFor, kitSource } from './kit/source.js';
import { SECRET_MASK, SECRET_MIN, looksLikeToken, recorderSource, secretHash } from './kit/record-script.js';
import type { SecretHash } from './kit/record-script.js';
import { DEFAULT_BROWSER_ARGS, applyStorageState, launchTarget } from './session.js';
import type { StorageStateFile } from './session.js';
import { armWriteGuard, enableServiceWorkerRequests } from './write-guard.js';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** The longest a recording lasts by default (it stops and keeps what it has). */
export const RECORD_MAX_MS = 30 * 60_000;
/** In-page time budget of one element's suggestion at pointerdown (ms). */
export const RECORD_BUDGET_MS = 150;
/** In-page time budget of its alternative targets (ms, inside RECORD_BUDGET_MS): a press waits for them (L4.8). */
export const RECORD_ALT_BUDGET_MS = 10;
/** The isolated world the recorder runs in. */
const WORLD = 'retake-record';
/** Query keys a typed navigation never keeps (they may carry a token). */
const SENSITIVE_QUERY_KEY = /token|code|state|session|sig|auth|key|pass|secret|otp|pwd|nonce|ticket|jwt|saml|credential/i;

export interface RecordSessionOptions {
  project: LoadedProject;
  env: ResolvedEnvironment;
  /** The persona the window is signed in as (its session is copied); null / absent: signed out (a fresh profile). */
  persona?: ResolvedPersona | null;
  /** The page the window opens (an environment page's URL; the caller checks it). */
  url: string;
  /** `--allow-writes` (a production environment that allows writes), as `retake run`. */
  allowWrites?: boolean;
  browser?: BrowserConfig;
  /** Events are appended here as they come (0600; the folder must exist). */
  eventsFile?: string;
  /** Longest recording (default 30 min): it stops and keeps what it has (`max_duration`). */
  maxMs?: number;
  log?: Log;
  /** The window shows its first page (the CLI says what to do). */
  onOpen?: (url: string) => void;
  /** Each event kept (progress: count it, never print page text). */
  onEvent?: (e: RecordedEvent) => void;
  /** Stop and keep (Ctrl-C in the CLI, a worker signal): the pending typing is committed, the window closes. */
  stop?: AbortSignal;
  /** Cancel (job_cancel): the window closes, the events file is removed, throws a CancelledError. */
  signal?: AbortSignal;
  /** Test hook: plays the person in the window (Playwright input is trusted); the recording ends when it closes it. */
  drive?: (page: Page) => Promise<void>;
  /** With `drive`: the "headed" window runs headless (tests without a display). */
  headless?: boolean;
  /** The window's size (tests; default: maximised on the screen). */
  windowSize?: { width: number; height: number };
  /** Test hook: the alternatives' in-page budget per press (default RECORD_ALT_BUDGET_MS; 0: none, said partial). */
  alternativesBudgetMs?: number;
}

export interface RecordSessionResult {
  events: RecordedEvent[];
  stop: 'closed' | 'stopped' | 'max_duration';
  ms: number;
  /** The page's viewport in the window (CSS px), as the recorder saw it first. */
  window: { width: number; height: number } | null;
  capture: { width: number; height: number };
  access: RunAccess['mode'];
  persona: string | null;
  counts: {
    events: number;
    /** Presses, typing, keys, selects, files. */
    actions: number;
    writes: number;
    /** Strings the secret memory masked. */
    redacted: number;
    dropped: { sign_in: number; frame: number; invalid: number; new_page: number };
  };
  /** Never quotes page text or a typed value. */
  warnings: string[];
}

/** A context of the recorder's world, as CDP announced it. */
interface WorldContext {
  origin: string;
  frameId: string;
}

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

/** The environment page whose URL is the longest prefix of `url` (same origin, path under its base). */
function pageKeyOf(url: string, pages: Record<string, string>): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let best: { key: string; len: number } | null = null;
  for (const [key, base] of Object.entries(pages)) {
    let b: URL;
    try {
      b = new URL(base);
    } catch {
      continue;
    }
    if (b.origin !== u.origin) continue;
    const bp = b.pathname.replace(/\/+$/, '');
    if (bp && u.pathname !== bp && !u.pathname.startsWith(`${bp}/`)) continue;
    if (!best || bp.length > best.len) best = { key, len: bp.length };
  }
  return best?.key ?? null;
}

/** The secret memory of the session: salted hashes of the final secret values (never the values). */
class SecretMemory {
  readonly salt = randomBytes(4).readUInt32LE(0);
  private readonly byLength = new Map<number, Set<string>>();
  readonly list: SecretHash[] = [];

  add(n: number, h: string): void {
    if (!Number.isInteger(n) || n < SECRET_MIN || n > 4096 || typeof h !== 'string' || h.length > 20) return;
    let set = this.byLength.get(n);
    if (!set) this.byLength.set(n, (set = new Set()));
    if (set.has(h) || this.list.length >= 1000) return;
    set.add(h);
    this.list.push([n, h]);
  }

  mask(s: string): { s: string; hit: boolean } {
    let out = s;
    let hit = false;
    for (const [n, set] of this.byLength) {
      if (out.length < n) continue;
      let res = '';
      let from = 0;
      for (let i = 0; i + n <= out.length; ) {
        if (set.has(secretHash(out.slice(i, i + n), this.salt))) {
          res += out.slice(from, i) + SECRET_MASK;
          i += n;
          from = i;
          hit = true;
        } else i++;
      }
      if (from > 0) out = res + out.slice(from);
    }
    return { s: out, hit };
  }

  maskDeep<T>(v: T, count: { n: number }): T {
    if (this.byLength.size === 0) return v;
    if (typeof v === 'string') {
      const r = this.mask(v);
      if (r.hit) count.n++;
      return r.s as T;
    }
    if (Array.isArray(v)) return v.map((x) => this.maskDeep(x, count)) as T;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.maskDeep(x, count);
      return out as T;
    }
    return v;
  }
}

/**
 * A path segment or query value that may be a credential or a person's address: an e-mail address, a long hex string
 * (a UUID included), a JWT, a key-like value (looksLikeToken) or a long run of letters and digits (base64url). A slug
 * (`single-origin-2024`) is none of these.
 */
export function looksLikeSecretSegment(raw: string): boolean {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    s = raw;
  }
  s = s.trim();
  if (/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(s)) return true;
  if (s.length < 16) return false;
  if (/^[0-9a-f]{32,}$/i.test(s.replace(/-/g, ''))) return true;
  if (/^[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}$/.test(s) && s.length >= 20) return true;
  if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s) && looksLikeToken(s)) return true;
  return s.split(/[-_.~+=]/).some((run) => run.length >= 20 && /[0-9]/.test(run) && /[a-z]/i.test(run));
}

/** A path (or a label `POST host/path`) with its segments that look like a secret masked. */
export function maskPathSecrets(path: string): string {
  if (!path) return path;
  return path
    .split('/')
    .map((seg) => (seg && looksLikeSecretSegment(seg) ? SECRET_MASK : seg))
    .join('/');
}

/** A typed navigation's query: keys that may carry a token removed, values that look like one (or the memory knows) too. */
function keptQuery(url: URL, memory: SecretMemory): string | undefined {
  const kept = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (SENSITIVE_QUERY_KEY.test(k) || looksLikeSecretSegment(k) || looksLikeSecretSegment(v)) continue;
    const m = memory.mask(v);
    if (m.hit) continue;
    kept.append(k, v);
  }
  const q = kept.toString();
  return q ? `?${q}`.slice(0, 2048) : undefined;
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

  // The window's profile: a copy of the persona's master (its snapshot's cookies applied), else a fresh one.
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

  let context: BrowserContext;
  try {
    await ensurePrivateDir(userDataDir);
    await disableAutofill(userDataDir);
    if (policy.readOnly) enableServiceWorkerRequests();
    const b = projectBrowser(o.project, o.browser);
    const { executablePath, channel } = launchTarget(b);
    const size = o.windowSize;
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: o.headless === true,
      channel,
      executablePath,
      // The window's real size (a capture viewport larger than the screen would hide the bottom of the page).
      viewport: null,
      locale: b.locale,
      timezoneId: b.timezone,
      args: [
        ...DEFAULT_BROWSER_ARGS.filter((a) => a !== '--hide-scrollbars'),
        ...(size ? [`--window-size=${size.width},${size.height}`] : ['--start-maximized']),
        ...(b.args ?? []),
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
    });
  } catch (e) {
    await removeCopies();
    throw e;
  }

  const started = Date.now();
  const events: RecordedEvent[] = [];
  const memory = new SecretMemory();
  const binding = `__dsrec_${randomBytes(8).toString('hex')}`;
  const dropped = { sign_in: 0, frame: 0, invalid: 0, new_page: 0 };
  let redactedTotal = 0;
  let windowSize: { width: number; height: number } | null = null;
  let stream: WriteStream | null = null;
  let streamError: unknown = null;
  if (o.eventsFile) {
    stream = createWriteStream(o.eventsFile, { flags: 'a', mode: 0o600 });
    stream.on('error', (e) => {
      streamError = e;
    });
  }
  let seq = 0;
  let open = true;
  const keep = (body: Record<string, unknown> & { kind: string }, path: string, age = 0): void => {
    if (!open) return;
    const count = { n: 0 };
    const t = Math.max(0, Date.now() - started - age);
    const candidate: Record<string, unknown> = memory.maskDeep({ ...body, seq, t, page: 'p1', path: memory.mask(maskPathSecrets(path)).s }, count);
    const prior = typeof candidate.redacted === 'number' ? candidate.redacted : 0;
    if (count.n + prior > 0) candidate.redacted = count.n + prior;
    // A typing event whose text the runner's memory masked is a secret one.
    if (candidate.kind === 'type' && count.n > 0 && candidate.text !== undefined) {
      delete candidate.text;
      candidate.secret = true;
      if (['text', 'search', 'multiline', 'contenteditable'].includes(String(candidate.field_kind))) candidate.field_kind = 'secret';
    }
    let parsed = RecordedEventSchema.safeParse(candidate);
    const el = candidate.el as Record<string, unknown> | null | undefined;
    if (!parsed.success && el && typeof el === 'object' && ('alternatives' in el || 'alternatives_partial' in el)) {
      // Alternatives the schema refuses never cost the action: it is kept without them.
      delete el.alternatives;
      delete el.alternatives_partial;
      parsed = RecordedEventSchema.safeParse(candidate);
    }
    if (!parsed.success) {
      dropped.invalid++;
      log('debug', `recording: an event was refused by the schema (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')})`);
      return;
    }
    seq++;
    redactedTotal += parsed.data.redacted ?? 0;
    events.push(parsed.data);
    stream?.write(`${JSON.stringify(parsed.data)}\n`);
    try {
      o.onEvent?.(parsed.data);
    } catch {
      /* a listener error must not stop the recording */
    }
  };
  const isSignIn = (url: string): boolean => matchers.some((m) => m.test(url));

  // Writes: the guard's own report (a read-only environment's, every host it sees a write to; the protected hosts of
  // a read-write one); on a read-write environment, every other write request of the window as seen — whatever its
  // host (an API on another host, a read_only.hosts entry), a form post or a beacon: the check replay stops before
  // the first step one followed. A GraphQL body that only reads is not a write. Labels never carry the query.
  const label = (method: string, url: string) => maskPathSecrets(describeWriteRequest(method, url, env.pages));
  try {
    if (guardsWrites(policy)) {
      await armWriteGuard(
        context,
        { policy, onWrite: (w) => keep({ kind: 'write', method: w.method.toUpperCase(), label: maskPathSecrets(w.label), outcome: w.outcome }, '') },
        () => 'capture',
      );
    }
    if (!policy.readOnly) {
      context.on('request', (r) => {
        if (!isWriteMethod(r.method())) return;
        let host: string;
        try {
          const u = new URL(r.url());
          if (!/^https?:$/.test(u.protocol)) return;
          host = u.hostname;
        } catch {
          return;
        }
        // The guard reports the writes it stops (another environment's hosts).
        if (guardsWrites(policy) && isGuardedHost(host, policy)) return;
        let body: string | null = null;
        try {
          body = r.postData();
        } catch {
          body = null;
        }
        const gql = body ? graphqlOf(body) : null;
        if (gql && graphqlReadsOnly(gql)) return;
        keep({ kind: 'write', method: r.method().toUpperCase(), label: label(r.method(), r.url()), outcome: 'passed' }, '');
      });
    }
  } catch (e) {
    await context.close().catch(() => undefined);
    await removeCopies();
    throw e;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  const cdp: CDPSession = await context.newCDPSession(page);
  const contexts = new Map<number, WorldContext>();
  let mainFrame = '';
  let topContext: number | null = null;
  let starting = true;

  const evaluateIn = async (id: number, expression: string): Promise<void> => {
    await cdp.send('Runtime.evaluate', { contextId: id, expression, returnByValue: true }).catch(() => undefined);
  };
  const verdict = (id: number, url: string): void => {
    const ok = isPageOrigin(url, env.pages) && !isSignIn(url);
    void evaluateIn(id, `globalThis.__dsrecVerdict && globalThis.__dsrecVerdict(${JSON.stringify(url)}, ${ok}, ${JSON.stringify(memory.list)})`);
  };

  // An isolated world's context reports no origin ("://"): it is its document's, taken from the frame's main-world
  // context created just before it (a new document creates its main world first).
  const frameOrigin = new Map<string, string>();
  cdp.on('Runtime.executionContextCreated', (e: { context: { id: number; origin: string; name: string; auxData?: { frameId?: string; isDefault?: boolean } } }) => {
    const frameId = e.context.auxData?.frameId ?? '';
    if (e.context.auxData?.isDefault) {
      frameOrigin.set(frameId, e.context.origin);
      return;
    }
    if (e.context.name !== WORLD) return;
    contexts.set(e.context.id, { origin: frameOrigin.get(frameId) ?? '', frameId });
    if (frameId === mainFrame) topContext = e.context.id;
  });
  cdp.on('Runtime.executionContextDestroyed', (e: { executionContextId: number }) => {
    contexts.delete(e.executionContextId);
    if (topContext === e.executionContextId) topContext = null;
  });
  cdp.on('Runtime.executionContextsCleared', () => {
    contexts.clear();
    topContext = null;
  });
  cdp.on('Runtime.bindingCalled', (e: { name: string; payload: string; executionContextId: number }) => {
    if (e.name !== binding || e.payload.length > 1_000_000) return;
    const ctx = contexts.get(e.executionContextId);
    // Only the recorder's world of an environment page: its main frame records, a frame says it was used.
    if (!ctx || !origins.includes(ctx.origin)) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (ctx.frameId !== mainFrame) {
      if (m.k === 'frame') {
        dropped.frame++;
        keep({ kind: 'dropped', reason: 'frame', count: 1 }, '');
      }
      return;
    }
    switch (m.k) {
      case 'hello': {
        if (!windowSize && typeof m.w === 'number' && typeof m.h === 'number') windowSize = { width: Math.round(m.w), height: Math.round(m.h) };
        if (typeof m.url === 'string') verdict(e.executionContextId, m.url);
        return;
      }
      case 'where':
        if (typeof m.url === 'string') verdict(e.executionContextId, m.url);
        return;
      case 'secret':
        memory.add(Number(m.n), String(m.h));
        return;
      case 'discarded': {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(m.count) || 1)));
        dropped.sign_in += n;
        keep({ kind: 'dropped', reason: 'sign_in', count: n }, '');
        return;
      }
      case 'ev': {
        const path = typeof m.path === 'string' ? m.path : '';
        // The page's own check, made again here: never an event of a sign-in page.
        if (isSignIn(`${ctx.origin}${path}`)) {
          dropped.sign_in++;
          keep({ kind: 'dropped', reason: 'sign_in', count: 1 }, '');
          return;
        }
        const body = m.e as Record<string, unknown> & { kind: string };
        if (!body || typeof body !== 'object' || typeof body.kind !== 'string' || ['navigation', 'write', 'dropped', 'stop', 'new_page'].includes(body.kind)) {
          dropped.invalid++;
          return;
        }
        const age = Math.max(0, Math.min(60_000, Math.floor(Number(m.age) || 0)));
        keep({ ...body, ...(typeof m.redacted === 'number' ? { redacted: m.redacted } : {}) }, path, age);
        return;
      }
      default:
        return;
    }
  });

  // Navigations of the main frame (the runner's view: where the page went, and how).
  const navigation = async (url: string, sameDocument: boolean): Promise<void> => {
    let cause: 'start' | 'typed' | 'link' | 'form' | 'reload' | 'spa' | 'other' = sameDocument ? 'spa' : 'other';
    if (starting && !sameDocument) cause = 'start';
    else if (!sameDocument) {
      try {
        const h = (await cdp.send('Page.getNavigationHistory')) as { currentIndex: number; entries: Array<{ transitionType?: string }> };
        const tt = h.entries[h.currentIndex]?.transitionType ?? '';
        cause = tt === 'typed' || tt === 'auto_bookmark' || tt === 'generated' ? 'typed' : tt === 'link' ? 'link' : tt === 'form_submit' ? 'form' : tt === 'reload' ? 'reload' : 'other';
      } catch {
        cause = 'other';
      }
    }
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    const base = { kind: 'navigation', cause, same_document: sameDocument } as const;
    if (!isPageOrigin(url, env.pages)) {
      keep({ ...base, where: 'foreign', page_key: null, host: u.host }, '');
      return;
    }
    if (isSignIn(url)) {
      keep({ ...base, where: 'sign_in', page_key: null }, urlOriginPath(url).slice(u.origin.length));
      return;
    }
    const query = cause === 'typed' ? keptQuery(u, memory) : undefined;
    keep({ ...base, where: 'environment', page_key: pageKeyOf(url, env.pages), ...(query ? { query } : {}) }, u.pathname);
  };
  let lastPath = '';
  cdp.on('Page.frameNavigated', (e: { frame: { id: string; parentId?: string; url: string }; type?: string }) => {
    if (e.frame.parentId) return;
    mainFrame = e.frame.id;
    lastPath = e.frame.url.split(/[?#]/)[0];
    void navigation(e.frame.url, false);
  });
  cdp.on('Page.navigatedWithinDocument', (e: { frameId: string; url: string }) => {
    if (e.frameId !== mainFrame) return;
    const p = e.url.split(/[?#]/)[0];
    // A fragment-only change is not a route change.
    if (p === lastPath) return;
    lastPath = p;
    void navigation(e.url, true);
  });

  // Tabs and popups the page opens are not recorded.
  context.on('page', (p) => {
    if (p === page) return;
    dropped.new_page++;
    keep({ kind: 'new_page' }, '');
  });

  let stopReason: RecordSessionResult['stop'] = 'closed';
  let driveError: unknown = null;
  let maxTimer: NodeJS.Timeout | null = null;
  const onStop = (reason: 'stopped' | 'max_duration') => {
    if (!open) return;
    stopReason = reason;
    void (async () => {
      // Commit what the person was typing (and a pending scroll or key), then close.
      if (topContext !== null) await evaluateIn(topContext, 'globalThis.__dsrecFlush && globalThis.__dsrecFlush()');
      await new Promise((r) => setTimeout(r, 150));
      await context.close().catch(() => undefined);
    })();
  };
  const onCancel = () => void context.close().catch(() => undefined);
  const stopListener = () => onStop('stopped');
  o.stop?.addEventListener('abort', stopListener, { once: true });
  o.signal?.addEventListener('abort', onCancel, { once: true });

  try {
    const closed = new Promise<void>((resolve) => {
      context.on('close', () => resolve());
      const watch = (p: Page) =>
        p.on('close', () => {
          // The last page closed (the browser may stay open on macOS): the recording ends.
          if (context.pages().length === 0) void context.close().catch(() => undefined);
        });
      context.pages().forEach(watch);
      context.on('page', watch);
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    mainFrame = tree.frameTree.frame.id;
    await cdp.send('Runtime.addBinding', { name: binding, executionContextName: WORLD });
    const source = `${kitSource({ ...kitConfigFor(undefined, { hidden: true }), passive: true })}\n${recorderSource({ binding, origins, salt: memory.salt, budget_ms: RECORD_BUDGET_MS, alt_budget_ms: o.alternativesBudgetMs ?? RECORD_ALT_BUDGET_MS, secret_min: SECRET_MIN })}`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD, runImmediately: true });
    if (state) await applyStorageState(context, state);
    if (o.signal?.aborted) onCancel();
    if (o.stop?.aborted) stopListener();
    maxTimer = setTimeout(() => onStop('max_duration'), o.maxMs ?? RECORD_MAX_MS);
    await page.goto(o.url).catch(() => undefined);
    starting = false;
    if (!o.signal?.aborted && open) o.onOpen?.(o.url);
    if (windowSize === null) await new Promise((r) => setTimeout(r, 100));
    const w = windowSize as { width: number; height: number } | null;
    if (w && w.width < capture.width) {
      warnings.push(`the window shows ${w.width}×${w.height} CSS px, narrower than the capture (${capture.width}×${capture.height}): the check replay runs at the capture size and shows any difference`);
    }
    if (o.drive) {
      void o.drive(page).catch((e: unknown) => {
        driveError = e;
        void context.close().catch(() => undefined);
      });
    }
    await closed;
  } finally {
    if (maxTimer) clearTimeout(maxTimer);
    o.stop?.removeEventListener('abort', stopListener);
    o.signal?.removeEventListener('abort', onCancel);
    await context.close().catch(() => undefined);
    if (!o.signal?.aborted) keep({ kind: 'stop', reason: stopReason }, '');
    open = false;
    if (stream) await new Promise<void>((r) => stream!.end(() => r()));
    await removeCopies();
  }
  if (o.signal?.aborted) {
    if (o.eventsFile) await rm(o.eventsFile, { force: true }).catch(() => undefined);
    throw new CancelledError('recording cancelled: nothing was kept');
  }
  if (driveError) throw driveError;
  if (streamError) throw new RunnerError(`the recording's events could not be written: ${(streamError as Error).message}`);
  if (dropped.new_page) warnings.push(`${dropped.new_page} tab(s) or popup(s) opened during the recording: what happened there is not recorded`);
  if (dropped.frame) warnings.push('actions inside a frame are not recorded');
  if (dropped.sign_in) warnings.push(`${dropped.sign_in} action(s) on a sign-in page were not recorded`);
  const actions = events.filter((e) => ['pointer', 'type', 'key', 'select_native', 'file'].includes(e.kind)).length;
  return {
    events,
    stop: stopReason,
    ms: Date.now() - started,
    window: windowSize,
    capture,
    access: access.mode,
    persona: persona?.name ?? null,
    counts: { events: events.length, actions, writes: events.filter((e) => e.kind === 'write').length, redacted: redactedTotal, dropped },
    warnings,
  };
}
