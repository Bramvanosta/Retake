/**
 * The hooks context's types (@retake/core/hooks): a hook's shapes: the http, sql, shell and js hook specs and named
 * hooks.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */

export interface HttpHookSpec {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  url: string;
  headers?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** Raw body. */
  body?: string;
  /** Expected status code(s). Default: any 2xx. */
  expect?: number | number[];
  /**
   * Send the request as a persona of the environment: the cookies its saved session holds for the URL (`Cookie`) and,
   * for a product signed in with Firebase Auth, its ID token (`Authorization: Bearer …`).
   */
  auth?: { persona: string };
  /** Store the response as `{{hooks.<save_as>.status|body|json.<path>}}` for later templating. */
  save_as?: string;
  /** Request that undoes this one (templated after the request, so it can use `{{response.json.id}}`). */
  rollback?: Omit<HttpHookSpec, 'rollback' | 'save_as'>;
}

export interface SqlHookSpec {
  /** SQL file relative to the project dir. */
  file?: string;
  /** Inline SQL. */
  query?: string;
  /** Database key from project.databases (default: the first one). */
  db?: string;
  /** SQL that undoes this hook: a file path (*.sql) or inline SQL. */
  rollback?: string | { file?: string; query?: string };
}

export interface ShellHookSpec {
  run: string;
  cwd?: string;
  env?: Record<string, string>;
  rollback?: string;
  timeout?: number;
}

export interface JsHookSpec {
  /** Inline JS evaluated in a page (function body; may `return` / `await`). */
  code?: string;
  /** JS file relative to the project dir. */
  file?: string;
  /** Environment page key whose page runs it (default: the first page). */
  page?: string;
  rollback?: string;
}

/** Common fields on any hook entry. */
export interface HookCommon {
  name?: string;
  /** Required for hooks detected/declared as destructive. */
  confirm?: boolean;
  /** Declare the hook destructive explicitly (also auto-detected). */
  destructive?: boolean;
  /** Continue even if this hook fails. */
  optional?: boolean;
  /**
   * Shell hooks only: `false` declares that the command only reads, so it may run on a read-only environment (L1.7).
   * http and sql hooks are classified from their request / SQL; js hooks are guarded in their tab.
   */
  writes?: boolean;
}

/** `sql: "hooks/x.sql"` (path when it ends with .sql, inline query otherwise); `shell: "cmd"`; `js: "code"`. */
export type HookStep = HookCommon & ({ http: HttpHookSpec } | { sql: string | SqlHookSpec } | { shell: string | ShellHookSpec } | { js: string | JsHookSpec });

export type HookKind = 'http' | 'sql' | 'shell' | 'js';

/** `hooks:` of a scenario or project.yaml (L5.8): name → one hook entry, or a list run in order. */
export type NamedHooks = Record<string, HookStep | HookStep[]>;
