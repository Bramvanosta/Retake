/**
 * The CaptureRunner port (L7.12, U6's last slice): what drives a real browser for the engine — a scenario's run
 * (capture, dry, inspection), a recording's window, a persona's session (its check, its sign-in, its lock and last
 * status), the browsers js hooks run in outside a capture, a site's facts — and the two things a signal handler needs
 * synchronously: the cancel's error and the removal of a persona's session copies. The composition roots choose it
 * (ports.ts `EnginePorts.capture`): the runner package (`runnerWebCapture()`), or an in-memory one in tests
 * (memory-capture.ts).
 *
 * Its vocabulary is the runner's own, named through its type-only domain entry `@retake/runner-web/types` (as the
 * Reviewer names the review's options through `@retake/review/checks`): a mirror of a run's options would only drift. The
 * engine adds one thing to a run's request: the hook runner its hooks run through (hook-run/runner.ts).
 */
import type { LoadedProject, PersonaRequestAuth, ResolvedPersona, RunRecord, WorkPolicy, WritePolicy } from '@retake/core';
import type {
  HookPageOptions,
  PersonaAuthSource,
  PersonaCheckResult,
  PersonaStatusRecord,
  ProfileLock,
  RecordSessionOptions,
  RecordSessionResult,
  RunOptions,
  SignInOptions,
  SignInResult,
  SiteExtractOptions,
  SiteReport,
} from '@retake/runner-web/types';
import type { HookRunner } from '../hook-run/runner.js';

/**
 * A run of a scenario (capture, dry run, or a dry replay with `inspect`): the runner's options without its two test
 * seams (`browser`, `resolveSecret`), and the hook runner its setup, teardown and hook steps run through (required:
 * every run the engine starts hands its composition root's).
 */
export type CaptureRequest = Omit<RunOptions, 'browser' | 'resolveSecret' | 'hookRunner'> & { hookRunner: HookRunner };

/** A live check of a persona's saved session, the way a run sees it (no window; its test seam `browser` left out). */
export type SessionCheckOptions = Pick<SignInOptions, 'project' | 'env' | 'persona' | 'log' | 'signal' | 'policy'>;

/** A persona's session: its live check, its sign-in, and what is known of it without a browser. */
export interface CaptureSessions {
  /** checkSavedSession: `unchecked` when the persona declares no check. */
  check(o: SessionCheckOptions): Promise<PersonaCheckResult>;
  /** A headed window a human signs in to, or the persona's login steps (`auto`, headless); the check made after. */
  signIn(o: SignInOptions): Promise<SignInResult>;
  /** The master profile's `SingletonLock`: held by a running browser (`live`), left behind (`stale`), or none. */
  lock(profileDir: string): Promise<ProfileLock>;
  /** The persona's last status file, or null. */
  status(file: string): Promise<PersonaStatusRecord | null>;
}

/** A browser js hooks run in outside a capture (one per persona): opaque to the engine, closed by it. */
export interface HookBrowser {
  /** Close it (its session copies — a persona's cookies — go with it). */
  close(): Promise<void>;
}

/** What a js-hook browser is opened with (the engine decides the persona, the guard and the words). */
export interface HookBrowserOptions {
  policy: WorkPolicy;
  /** Its capture size and browser settings are the project's. */
  project: LoadedProject;
  /** Signed in as this persona (a copy of its saved session), or as nobody. */
  persona?: ResolvedPersona;
  /** The run the session copies are named after. */
  runId: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** How a saved session that cannot be used is said (the start of the error). */
  failure?: string;
  /** The write guard of its tabs (a read-only command, the hosts of read-only environments). */
  writes?: { policy: WritePolicy };
}

/** What reads a persona's cookies and token for an http hook's `auth: {persona}`, from a js-hook browser of it. */
export type HookAuthOptions = Omit<PersonaAuthSource, 'context'> & {
  /** The persona's browser (opened on first use by the engine, shared with its js hooks). */
  browser: () => Promise<HookBrowser>;
};

/** The js hooks' pages outside a capture. A handle of another runner is refused, never cast. */
export interface HookPages {
  open(o: HookBrowserOptions): Promise<HookBrowser>;
  /** Run a js hook in the guarded hook tab of `pageKey` (the environment's first page when undefined) of `browser`. */
  evalIn(browser: HookBrowser, o: HookPageOptions, pageKey: string | undefined, code: string): Promise<unknown>;
  authReader(o: HookAuthOptions): Promise<(url: string) => Promise<PersonaRequestAuth>>;
}

export interface CaptureRunner {
  /**
   * Load the runner, as the roots do before they listen to signals: `cancelled` and `cleanupSync` work after it only
   * (each throws `internal` before). Every other member loads it on its own call too.
   */
  load(): Promise<void>;
  /** Run a scenario: a failed or cancelled run is a record, not an error (the runner's early refusals throw). */
  run(req: CaptureRequest): Promise<RunRecord>;
  /** A recording's headed window, until the person closes it (or `stop` / `signal`). */
  record(o: RecordSessionOptions): Promise<RecordSessionResult>;
  readonly sessions: CaptureSessions;
  readonly hookPages: HookPages;
  readonly site: {
    /** One public page's colours, fonts and logos through the worker's proxy, into `outDir`. */
    extract(o: SiteExtractOptions): Promise<SiteReport>;
  };
  /** The error a cancel aborts a running capture with (the runner's own cancel: its name, its kind). Synchronous. */
  cancelled(message?: string): Error;
  /** Remove every session copy this process made, synchronously (a second signal); how many were removed. */
  cleanupSync(): number;
}
