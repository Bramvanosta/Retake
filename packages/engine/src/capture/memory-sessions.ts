/**
 * The in-memory capture runner's sessions, js-hook pages, recording window and site (memory-capture.ts composes them):
 * no browser, no file of the Retake home read. Not exported from the package (a test imports this file); under src so
 * that the port's types check it. The contract they share with the runner package is engine/test/capture-sessions-contract.ts.
 *
 * - sessions: a persona without a `check` is `unchecked` (the runner's words); else its scripted check (`valid` by
 *   default). A sign-in answers the scripted result (by default: signed in, its check `valid`, nothing written) and makes
 *   it the persona's check. Locks and status records are scripted by profile folder and by status file. A signal
 *   already aborted is a cancel (`CancelledError`, as the runner's).
 * - hook pages: a browser per `open`, closed by `close`; `evalIn` answers the scripted evaluator in the tab of
 *   `pageKey` (the environment's first page by default), refusing a page the environment lacks and a tab that lands on
 *   the persona's sign-in page (the engine's `loginLanding`); a handle of another runner is refused, never cast.
 *   `authReader` keeps the runner's origin rule (trust mcp: the persona's own pages only, core personaAuthOriginProblem)
 *   before it opens the persona's browser and answers its scripted cookie.
 * - record: the scripted events, appended to `eventsFile` and handed to `onEvent` after `onOpen`, then the scripted
 *   `during`; a cancel (before or during) removes the events file and throws; a `stop` ends it `stopped`.
 * - site: the scripted report (or what the scripted function answers), written as site.json into `outDir`.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRunAccess } from '@retake/core/environment';
import { personaAuthOriginProblem } from '@retake/core/scenario';
import type { ErrorKind } from '@retake/core/base';
import type { ResolvedPersona } from '@retake/core/environment';
import type { PersonaRequestAuth } from '@retake/core/hooks';
import type { RecordedEvent } from '@retake/core/run';
import type {
  HookPageOptions,
  PersonaCheckResult,
  PersonaStatusRecord,
  ProfileLock,
  RecordSessionOptions,
  RecordSessionResult,
  SignInOptions,
  SignInResult,
  SiteExtractOptions,
  SiteReport,
} from '@retake/runner-web/types';
import { EngineError } from '../errors.js';
import type { CaptureRunner, CaptureSessions, HookAuthOptions, HookBrowser, HookBrowserOptions, HookPages, SessionCheckOptions } from './runner.js';

/**
 * A cancel of these members: the runner's name and kind (as memory-capture.ts MemoryCancelledError; written here too
 * because memory-capture.ts composes this file, which must not import it back).
 */
export class MemorySessionCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelledError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return 'cancelled';
  }
}

const cancelIf = (signal: AbortSignal | undefined, message: string): void => {
  if (signal?.aborted) throw new MemorySessionCancelledError(message);
};

export type MemorySessionCall =
  | { member: 'check'; persona: string }
  | { member: 'signIn'; persona: string; mode: SignInOptions['mode'] }
  | { member: 'lock'; profileDir: string }
  | { member: 'status'; file: string };

export interface MemorySessionsOptions {
  /** The check of a persona that declares one, by persona name (an Error: the check throws it). Default `valid`. */
  checks?: Record<string, PersonaCheckResult | Error>;
  /** What a sign-in answers (an Error: it throws it). Default: signed in, its check `valid`. */
  signIn?: (o: SignInOptions) => SignInResult | Error;
  /** The master profiles' locks, by profile folder. Default `none`. */
  locks?: Record<string, ProfileLock>;
  /** The last status records, by status file. Default null. */
  statuses?: Record<string, PersonaStatusRecord>;
}

/** A persona's session in memory (the calls kept in `calls`; its scripted state in the maps, changed by a sign-in). */
export class MemorySessions implements CaptureSessions {
  readonly calls: MemorySessionCall[] = [];
  readonly checks: Map<string, PersonaCheckResult | Error>;
  readonly locks: Map<string, ProfileLock>;
  readonly statuses: Map<string, PersonaStatusRecord>;
  private readonly signInOf: MemorySessionsOptions['signIn'];

  constructor(o: MemorySessionsOptions = {}) {
    this.checks = new Map(Object.entries(o.checks ?? {}));
    this.locks = new Map(Object.entries(o.locks ?? {}));
    this.statuses = new Map(Object.entries(o.statuses ?? {}));
    this.signInOf = o.signIn;
  }

  async check(o: SessionCheckOptions): Promise<PersonaCheckResult> {
    this.calls.push({ member: 'check', persona: o.persona.name });
    if (!o.persona.check) return { status: 'unchecked', detail: 'no check declared', ms: 0 };
    cancelIf(o.signal, 'session check cancelled');
    const r = this.checks.get(o.persona.name) ?? { status: 'valid', detail: `${o.persona.name} is signed in (in memory)`, ms: 0 };
    if (r instanceof Error) throw r;
    return { ...r };
  }

  async signIn(o: SignInOptions): Promise<SignInResult> {
    this.calls.push({ member: 'signIn', persona: o.persona.name, mode: o.mode });
    cancelIf(o.signal, 'sign-in cancelled');
    const url = o.url ?? o.env.pages[o.page ?? o.persona.pages[0] ?? Object.keys(o.env.pages)[0] ?? ''] ?? 'about:blank';
    o.onOpen?.(url);
    const scripted = this.signInOf?.(o);
    if (scripted instanceof Error) throw scripted;
    const r: SignInResult = scripted ?? {
      persona: o.persona.name,
      check: o.persona.check ? { status: 'valid', detail: `${o.persona.name} is signed in (in memory)`, ms: 0 } : { status: 'unchecked', detail: 'no check declared', ms: 0 },
      ...(o.persona.profileDir ? { profileDir: o.persona.profileDir } : {}),
      ...(o.persona.snapshot ? { snapshot: o.persona.snapshot } : {}),
      cookies: 0,
      origins: 0,
      url,
    };
    // A later check sees the session the sign-in left.
    if (o.persona.check) this.checks.set(o.persona.name, r.check);
    return r;
  }

  async lock(profileDir: string): Promise<ProfileLock> {
    this.calls.push({ member: 'lock', profileDir });
    return { ...(this.locks.get(profileDir) ?? { state: 'none' }) };
  }

  async status(file: string): Promise<PersonaStatusRecord | null> {
    this.calls.push({ member: 'status', file });
    const st = this.statuses.get(file);
    return st ? { ...st } : null;
  }
}

/** A persona's session in memory. */
export function memorySessions(o: MemorySessionsOptions = {}): MemorySessions {
  return new MemorySessions(o);
}

/** A js-hook browser of the in-memory pages. */
export class MemoryHookBrowser implements HookBrowser {
  closed = false;
  /** The js hooks run in it, in order: their page and code. */
  readonly ran: Array<{ page: string; code: string }> = [];

  constructor(
    /** Signed in as this persona (undefined: nobody). */
    readonly persona: string | undefined,
    /** The options it was opened with (the engine's persona, guard and words). */
    readonly options: HookBrowserOptions,
  ) {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface MemoryHookPagesOptions {
  /** What a js hook answers, from its code, its page and the persona of its browser. Default: undefined. */
  evaluate?: (code: string, at: { page: string; persona: string | undefined }) => unknown;
  /** Where the tab of a page lands (default: the page's URL): a sign-in page there is the engine's `loginLanding`. */
  landing?: (page: string, persona: string | undefined, url: string) => string;
  /** The cookie header a persona's browser sends (by persona name; none: no header). */
  cookies?: Record<string, string>;
}

/** The js hooks' pages in memory (the browsers opened kept in `opened`). */
export class MemoryHookPages implements HookPages {
  readonly opened: MemoryHookBrowser[] = [];

  constructor(private readonly o: MemoryHookPagesOptions = {}) {}

  async open(o: HookBrowserOptions): Promise<HookBrowser> {
    const b = new MemoryHookBrowser(o.persona?.name, o);
    this.opened.push(b);
    return b;
  }

  async evalIn(browser: HookBrowser, o: HookPageOptions, pageKey: string | undefined, code: string): Promise<unknown> {
    const b = own(browser);
    if (b.closed) throw new EngineError('internal', 'a js hook ran in a browser already closed');
    const key = pageKey ?? Object.keys(o.env.pages)[0];
    if (!key) throw new Error(`js hook: environment "${o.env.name}" declares no pages`);
    const url = o.env.pages[key];
    if (!url) throw new Error(`js hook: environment "${o.env.name}" has no page "${key}"`);
    const at = this.o.landing?.(key, b.persona, url) ?? url;
    const signIn = o.loginLanding?.(key, at);
    if (signIn) throw new Error(signIn);
    b.ran.push({ page: key, code });
    return this.o.evaluate?.(code, { page: key, persona: b.persona });
  }

  async authReader(o: HookAuthOptions): Promise<(url: string) => Promise<PersonaRequestAuth>> {
    const persona: ResolvedPersona = o.persona;
    return async (url) => {
      if (o.origins) {
        const problem = personaAuthOriginProblem(persona.name, url, o.origins);
        if (problem) throw new Error(problem);
      }
      own(await o.browser());
      const cookie = this.o.cookies?.[persona.name];
      return cookie ? { cookie } : {};
    };
  }
}

/** A browser of these pages (another runner's is refused, never cast). */
function own(browser: HookBrowser): MemoryHookBrowser {
  if (browser instanceof MemoryHookBrowser) return browser;
  throw new EngineError('internal', 'a js-hook browser opened by another capture runner was handed to the in-memory runner');
}

/** The js hooks' pages in memory. */
export function memoryHookPages(o: MemoryHookPagesOptions = {}): MemoryHookPages {
  return new MemoryHookPages(o);
}

/** A site's facts in memory: the scripted report (default: a failed extraction that read nothing). */
export function memorySite(report?: SiteReport | ((o: SiteExtractOptions) => SiteReport | Promise<SiteReport>)): CaptureRunner['site'] {
  return {
    extract: async (o) => {
      cancelIf(o.signal, 'site extraction cancelled');
      const r = typeof report === 'function' ? await report(o) : (report ?? emptySiteReport(o.url));
      await writeFile(join(o.outDir, 'site.json'), `${JSON.stringify(r, null, 1)}\n`, { mode: 0o600 });
      return r;
    },
  };
}

/** A report that read nothing (no palette, no candidate, no screenshot). */
export function emptySiteReport(url: string): SiteReport {
  return {
    version: 1,
    url,
    host: new URL(url).host,
    at: new Date(0).toISOString(),
    status: 'failed',
    http_status: null,
    redirects: 0,
    palette: null,
    candidates: [],
    screenshot: null,
    network: { requests: 0, blocked: {}, tunnels: 0, bytes: 0, refused: {}, capped: 0 },
    warnings: [],
    untrusted: {},
  };
}

export interface MemoryRecordOptions {
  /** The events the person "made" (default none: nothing recorded). */
  events?: RecordedEvent[] | ((o: RecordSessionOptions) => RecordedEvent[]);
  /** How the window ended (default `closed`; `stopped` when `stop` was aborted). */
  stop?: RecordSessionResult['stop'];
  /** What happens while the window is open, after its events (a test's stand-in for the person: a stop, a cancel). */
  during?: (o: RecordSessionOptions) => Promise<void>;
}

/** Presses, typing, keys, selects, files (RecordSessionResult `counts.actions`). */
const ACTION_KINDS = new Set<RecordedEvent['kind']>(['pointer', 'type', 'key', 'select_native', 'file']);

/** A recording's window in memory: the scripted events (see the module comment). */
export function memoryRecord(m: MemoryRecordOptions = {}): CaptureRunner['record'] {
  return async (o) => {
    cancelIf(o.signal, 'recording cancelled');
    o.onOpen?.(o.url);
    const events = typeof m.events === 'function' ? m.events(o) : (m.events ?? []);
    if (o.eventsFile) await writeFile(o.eventsFile, events.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
    for (const e of events) o.onEvent?.(e);
    await m.during?.(o);
    if (o.signal?.aborted) {
      if (o.eventsFile) await rm(o.eventsFile, { force: true });
      throw new MemorySessionCancelledError('recording cancelled');
    }
    const actions = events.filter((e) => ACTION_KINDS.has(e.kind)).length;
    const capture = o.project.config.capture;
    return {
      events,
      stop: m.stop ?? (o.stop?.aborted ? 'stopped' : 'closed'),
      ms: 0,
      window: o.windowSize ?? { width: capture.width, height: capture.height },
      capture: { width: capture.width, height: capture.height },
      access: resolveRunAccess(o.env, { allowWrites: o.allowWrites === true, project: o.project }).mode,
      persona: o.persona?.name ?? null,
      counts: { events: events.length, actions, writes: events.filter((e) => e.kind === 'write').length, redacted: 0, dropped: { sign_in: 0, frame: 0, invalid: 0, new_page: 0 } },
      warnings: [],
    };
  };
}
