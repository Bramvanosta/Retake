/**
 * The environment context's types (@retake/core/environment): an environment's shapes: sign-in personas and steps,
 * display pages, production and read-only access with its write rules and mocks, the clock, the mailbox and database
 * settings, the environment's sandbox switch, and the writes a take saw.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */
import type { OpenArgs, PressArgs, TargetSpec, WaitForArgs } from './language.js';

/**
 * What a sign-in page looks like (L1.6), matched against a page's origin + path (never its query or fragment): a path
 * prefix ("/sign-in" — also "/sign-in/…", not "/sign-in-help"), "<environment page>:<path>" (that page's origin and
 * path), an absolute URL prefix ("https://sso.example.com" — every page there), or {regex, flags?}.
 */
export type LoginPattern = string | { regex: string; flags?: string };

/** How the runner tells a persona is signed in (L1.6), off camera before every run. */
export interface PersonaCheck {
  /** "<env page>:/path", a path (on the persona's first page) or an absolute URL. Default: the first page's "/". */
  url?: string;
  /** Text visible only when signed in (e.g. the account name). Without it: signed in when the page loads off the sign-in page. */
  expect_text?: string;
  /** Pages the check must NOT end on (also sign-in pages for the run's guard). */
  expect_not_url?: LoginPattern | LoginPattern[];
  /** Seconds (default 10). */
  timeout?: number;
}

/**
 * One step of an automated login (L1.6): open, click, type, press, wait_for or wait (scenario syntax), run off camera in
 * a tab of its own. Typed secrets come from {{env:…}} / {{keychain:…}} references.
 */
export type LoginStep = (
  | { open: string | OpenArgs }
  | { click: TargetSpec }
  | { type: { into?: TargetSpec; text: string; enter?: boolean } }
  | { press: string | PressArgs }
  | { wait_for: string | WaitForArgs }
  | { wait: number }
) & {
  /** Seconds before the step fails (default 15). */
  timeout?: number;
  note?: string;
};

/**
 * One account the videos are filmed as (L1.6): its session lives outside the project, in
 * ~/.retake/profiles|sessions/<project>/<env>/<persona> (RETAKE_HOME moves it) — never a path here.
 */
export interface PersonaConfig {
  /** The persona's mail address (L5.6): `wait_for_email {to: persona:<name>}`, the mailbox label of a mail card. */
  email?: string;
  /** Environment pages this persona is signed into by default (a page is in at most one persona's list). */
  pages?: string[];
  /** profile (default): a Chromium profile kept by `retake login`, copied for each run; storage_state: cookies + localStorage only. */
  session?: 'profile' | 'storage_state';
  check?: PersonaCheck;
  /** Sign-in pages of this persona (with auth.login_url and check.expect_not_url). */
  login_url?: LoginPattern | LoginPattern[];
  /** Automated login, off camera: used when the saved session is missing or expired. */
  login?: LoginStep[];
}

export interface AuthConfig {
  /** Legacy single account: persistent, pre-authenticated Chromium profile directory (~ expanded). Prefer `personas`. */
  profile?: string;
  /** Legacy single account: Playwright storageState JSON (alternative to profile). Prefer `personas`. */
  storage_state?: string;
  /** Sign-in pages of every persona (and of pages without one): landing there during a run fails it. */
  login_url?: LoginPattern | LoginPattern[];
  /** Named accounts (L1.6). */
  personas?: Record<string, PersonaConfig>;
}

export interface DatabaseConfig {
  /** Connection URL; may use {{env:VAR}} / {{keychain:service/account}} references. Never a clear-text password. */
  url: string;
}

/**
 * Access of an environment. `read-only`: hooks that write are refused and the browser's writes to the environment's
 * hosts are stopped (or answered by a mock); `read-write`: nothing is stopped.
 */
export const ENVIRONMENT_ACCESS = ['read-only', 'read-write'] as const;

export type EnvironmentAccess = (typeof ENVIRONMENT_ACCESS)[number];

/** A page of an environment as written in project.yaml: its base URL, or `{url, display}` (the URL the video shows). */
export type EnvironmentPageSpec = string | { url: string; display?: string };

/**
 * A write the read-only guard lets through: `"[METHOD ]<page>:/path"` (against that page's base URL) or
 * `"[METHOD ]/path"` (any guarded host); `*` matches within one path segment, `**` anything; the query is ignored.
 * `operation` narrows it to one GraphQL operation name.
 */
export type WriteRuleSpec = string | { request: string; operation?: string };

/** The answer to a write stopped on a read-only run (scenario `mocks:`, environment `read_only.mocks`). Literal. */
export interface WriteMockSpec {
  /** Same pattern as an allow entry: `"[METHOD ]<page>:/path"` or `"[METHOD ]/path"`. */
  request: string;
  /** GraphQL operation name. */
  operation?: string;
  /** 200–599, default 200. */
  status?: number;
  /** JSON body (content type application/json). Exactly one of `json` / `body` at most. */
  json?: unknown;
  /** Raw body (content type text/plain unless `content_type`). */
  body?: string;
  content_type?: string;
  headers?: Record<string, string>;
  /** Wait before answering (0–10 000 ms). */
  delay_ms?: number;
}

/** `read_only:` of an environment: used only when a run on it is read-only. */
export interface ReadOnlySettings {
  /** More hosts whose writes are stopped (allow_hosts syntax, `*.example.com`; `"*"` = every host). The pages' hosts always are. */
  hosts?: string[];
  /** Writes let through (a token refresh, a search sent as POST…). */
  allow?: WriteRuleSpec[];
  /** Answers to stopped writes, for every scenario on this environment (a scenario's own `mocks` come first). */
  mocks?: WriteMockSpec[];
}

/**
 * What project.yaml says about an environment besides its page URLs (`ProjectConfig.environment_settings`, derived
 * by loadProject; only environments that say something are listed).
 */
export interface EnvironmentSettings {
  production?: boolean;
  /** As written (absent: read-only in production, else read-write — core environmentAccess). */
  access?: EnvironmentAccess;
  /** Page key → display base, normalised (`https://host[:port][/path]`, no trailing slash). */
  display?: Record<string, string>;
  read_only?: ReadOnlySettings;
  /** A sandbox environment (L1.8): its manifest and provider. A sandbox is never production and always read-write. */
  sandbox?: EnvironmentSandbox;
  /** The sandbox's own test mailbox (core mailboxFor: it replaces the project's `mailbox` on this environment). */
  mailbox?: MailboxConfig;
  /** The sandbox's databases (core databasesFor: merged over the project's `databases` on this environment). */
  databases?: Record<string, DatabaseConfig>;
}

/** How a sandbox starts its services: `docker compose` on its compose files, or local processes. */
export const SANDBOX_PROVIDERS = ['docker-compose', 'process'] as const;

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

/** Which sandbox an environment is (EnvironmentSettings / ResolvedEnvironment). */
export interface EnvironmentSandbox {
  /** Absolute path of its sandbox.yaml. */
  file: string;
  provider: SandboxProvider;
}

/**
 * `clock:` of a project or scenario: the date and time the product's browser clock reads when the capture starts
 * (ISO 8601; without an offset, wall time in the browser's time zone), or `{at, freeze}` (`freeze: true`: it never
 * moves).
 */
export type ClockSpec = string | { at: string; freeze?: boolean };

/** The clock of a run (core resolveClock). */
export interface ResolvedClock {
  /** As written. */
  at: string;
  /** The instant it names (epoch ms). */
  epoch_ms: number;
  /** The IANA zone a time without an offset was read in (`browser.timezone`, else the machine's); absent: an explicit offset. */
  timezone?: string;
  freeze?: true;
}

/**
 * A test mailbox the runner reads with `wait_for_email`. `mailpit`: the Mailpit API (GET <url>/api/v1/messages and
 * <url>/api/v1/message/<ID>); `http`: the generic JSON shape documented in docs/guide/scenarios.md (GET <url>/messages and
 * <url>/messages/<id>). Its host must be allowed (localhost, an environment host or `allow_hosts`).
 */
export interface MailboxConfig {
  provider: 'mailpit' | 'http';
  /** Base URL, e.g. http://localhost:8025. */
  url: string;
  /** Polling interval in ms (default 500). */
  poll_ms?: number;
  /** Extra request headers (e.g. an API token: use {{env:VAR}}). */
  headers?: Record<string, string>;
}

/** A write request seen on a read-only run (L1.7). */
export interface TimelineWrite {
  /** Capture time; absent before capture time 0 (session preflight, setup hooks). */
  t?: number;
  method: string;
  /** The real URL (query included). */
  url: string;
  /** GraphQL operation name, when the request is GraphQL. */
  operation?: string;
  /**
   * blocked: stopped (the app saw a network error); mocked: answered by a mock; allowed: an allow entry let it through;
   * passed: not a guarded host; exempt: the automated sign-in's own write, sent from its sign-in page (never counted).
   */
  outcome: 'blocked' | 'mocked' | 'allowed' | 'passed' | 'exempt';
  /** The allow / mock entry that matched. */
  rule?: string;
  /** Status of the mock's answer. */
  status?: number;
  /** Who sent it: a capture page, a js hook tab, the automated sign-in tab. */
  via?: 'page' | 'hook' | 'sign-in';
  /** The other, read-only environment whose host it went to (guarded in every run, L1.7). */
  protected_by?: string;
}

export interface ResolvedEnvironment {
  name: string;
  /** page key → real base URL (what the runner and the hooks use). */
  pages: Record<string, string>;
  /** page key → display base (L1.7), for the pages that declare one. */
  display?: Record<string, string>;
  /** Absent: false. */
  production?: boolean;
  /** As written in project.yaml; absent: read-only in production, else read-write (core environmentAccess). */
  access?: EnvironmentAccess;
  read_only?: ReadOnlySettings;
  /** A sandbox environment (L1.8): never production, always read-write. */
  sandbox?: EnvironmentSandbox;
}
