import type { AgentChannel, HookAccess, HookKind, HookStep, HookTrust, HttpHookSpec, LoadedProject, ResolvedEnvironment } from '@retake/core';

/**
 * Which list of hooks is being run. Only `setup` and `step` hooks journal a rollback action. `seed` (L1.8): the steps
 * that build a sandbox's demo data — they stop at the first failure like setup, but nothing is rolled back (the next
 * reset rebuilds the data), no destructive hook asks for a confirmation (a sandbox is local and disposable) and js hooks
 * cannot run. `step` (L5.8): a named hook a `hook:` step runs during the take — it stops at its first failure (the step
 * fails), and the rollbacks of what it did run with the setup's, after the teardown.
 */
export type HookPhase = 'setup' | 'teardown' | 'reset' | 'seed' | 'step';

/** The phases whose hooks journal their rollback (undone after the teardown, or when the setup fails). */
export function journalsRollback(phase: HookPhase): boolean {
  return phase === 'setup' || phase === 'step';
}

export type HookLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface HookContext {
  project: LoadedProject;
  /** Selected environment: its pages are the `{{page}}` template keys. */
  env: ResolvedEnvironment;
  /** `{{vars.x}}` / `{{x}}` (merged over project.config.vars). */
  vars: Record<string, unknown>;
  /** `{{run.id}}`; also stored in journal entries. */
  runId?: string;
  /** `{{run.dir}}`: the run folder of a capture (absent for `retake hooks run`, which has no run folder). */
  runDir?: string;
  /**
   * The folder hook files (sql `file`) and shell working directories are relative to (default `project.dir`): a sandbox
   * seed's is the folder of its sandbox.yaml (L1.8).
   */
  baseDir?: string;
  /** Describe (and security-check) what would run, without executing anything. */
  dryRun?: boolean;
  /** Every message is redacted of the secret values resolved so far for this context. */
  log: (level: HookLogLevel, msg: string) => void;
  /**
   * Provided by the runner: evaluates a function body in the js hook tab of an environment page key (runner-web
   * `evalHookInPage`: a tab of the run's browser where requests to hosts outside the allow-list are blocked). Throws
   * core `HostRefusedError` when the tab's page or the hook's code reached such a host.
   */
  evalInPage?: (pageKey: string | undefined, code: string) => Promise<unknown>;
  /** `save_as` results, exposed to templating as `{{hooks.<name>.status|headers|body|json…}}`. Mutated in place. */
  saved: Record<string, unknown>;
  /**
   * Approves a destructive hook that lacks `confirm: true` (CLI `--yes`, interactive prompt) — with trust `mcp`, every
   * hook that needs a human (`request`: the raw hook, where it stands and its fingerprint; the jobs worker checks the
   * fingerprint against the approvals of its job). Without it, such hooks are refused. Never called in a dry run with
   * trust `mcp` (the result says what would need approval).
   */
  confirmDestructive?: (description: string, reason: string, request: HookApprovalRequest) => boolean | Promise<boolean>;
  /**
   * Who stands behind the flags of the hook files (L3.1, core HookTrust). Default `author`: `confirm: true` and a shell
   * hook's `writes: false` count. `mcp` (work submitted through the MCP server): `confirm: true` is ignored, every shell
   * hook needs an approval and always counts as writing.
   */
  trust?: HookTrust;
  /**
   * L5.14: replay a rollback whose journal entry Retake did not sign for its journal (journal.ts) when this says yes to
   * it — never with trust `mcp`, never a sql or js one, one that references secrets or a shell one on a sandbox. The
   * CLI's `--replay-unsigned` asks the person in the terminal about each entry, shown in full (`file`: its journal).
   * Default: refused.
   */
  replayUnsigned?: boolean | ((entry: JournalEntry, file: string) => boolean | Promise<boolean>);
  /**
   * Called once per hook or rollback this context executed or refused — never for a dry run, nor for a hook a
   * preflight stopped before anything ran (record.ts recordHookRun): the engine journals it in the workspace journal
   * (who, which hook, its outcome; never a value). Awaited before the next hook; a failure never fails the hook.
   * `run`: the run (or hooks journal) id of a rollback's journal, given when it is not this context's run (`retake env
   * reset` and `retake hooks rollback` replay the journals of earlier runs).
   */
  recordRun?: (result: HookResult, run?: string) => Promise<void>;
  /**
   * Trust `mcp`: the names of the variables the agent wrote (a scenario's own `vars`, over project.yaml's). A hook
   * whose templates use one counts as written by the agent (RunHooksOptions.agentWritten), wherever it is declared.
   */
  agentVars?: readonly string[];
  /**
   * The channel trust-`mcp` work came through, for the wording of its refusals (L4.2): `studio` (the Studio web app:
   * "from the Studio", "run it in a terminal") or `mcp` (default: "through MCP").
   */
  via?: AgentChannel;
  /**
   * The access of the run (L1.7, core resolveRunAccess): on `read-only`, a hook that writes is refused (status
   * `refused`, reason `read-only`) and SQL runs in a read-only transaction. Absent: read-write.
   */
  access?: HookAccess;
  /**
   * The access of another environment of the project, by name: a journal replay (`retake env reset`, `retake hooks
   * rollback`) checks each entry against the environment it ran in, not the command's. Undefined (an environment no
   * longer in project.yaml): `access`.
   */
  accessOf?: (env: string) => HookAccess | undefined;
  /**
   * Ctrl-C (a sandbox seed, L1.8): a running shell command's process group gets SIGTERM (SIGKILL 2 s later) and the
   * hooks stop — the caller reports the interrupt.
   */
  signal?: AbortSignal;
  /** The process groups of the shell commands running now (L1.8): a second Ctrl-C kills them synchronously. */
  running?: Set<number>;
  /**
   * Where a sql step connects for a sandbox database's host and port (L1.8, a docker-compose sandbox's seed): the
   * address Docker publishes the port on (127.0.0.1, ::1) instead of the URL's host name — `localhost` may reach another
   * container publishing the same port on ::1. Undefined: the URL's host.
   */
  connectAddress?: (host: string, port: number) => string | undefined;
}

/** What `save_as` stores in `ctx.saved[name]`, and `{{response…}}` in an http rollback. */
export interface SavedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Parsed body when it is JSON. */
  json?: unknown;
}

/**
 * ok: executed. failed: execution or preparation error. refused: allow-list / destructive refusal
 * (never tolerated by `optional`). dry: described only (`ctx.dryRun`).
 */
export type HookResultStatus = 'ok' | 'failed' | 'refused' | 'dry';

export interface HookResult {
  /** Position in the hook list (for rollbacks: the journal entry seq). */
  index: number;
  name?: string;
  /** Absent when the hook entry is malformed. */
  kind?: HookKind;
  phase: HookPhase | 'rollback';
  /** Runtime description (templated, secrets redacted). */
  description: string;
  ok: boolean;
  status: HookResultStatus;
  /** The hook was `optional: true` (its failure did not stop the phase). */
  optional?: boolean;
  /** Short outcome: "201 Created", "2 statements, 3 rows", "exit 0"… */
  message?: string;
  error?: string;
  ms: number;
  /** Journal entry written for this execution. */
  journal_seq?: number;
  /**
   * Trust `mcp`: the hook needs a human approval before it runs (a dry run only reports it; a real run was refused
   * without, or ran with one).
   */
  approval?: { reason: string; fingerprint: string };
  /** Trust `mcp`: its rollback (setup), templated and redacted — what an approval of the hook also approves. */
  rollback?: string;
  /**
   * Trust `mcp`: what runs in full, templated and redacted — one line per field (shell: run, cwd, each env entry; sql:
   * the statement or its file and the database; js: the code or its file and the page; http: method, URL, headers,
   * body), then its rollback's the same way (`rollback run: …`), every hidden character written out (shown.ts).
   */
  shown?: string[];
}

/** What `confirmDestructive` is asked about: the hook as its file declares it, where it stands, its fingerprint. */
export interface HookApprovalRequest {
  hook: HookStep;
  phase: HookPhase;
  index: number;
  env: string;
  /** Trust `mcp`: the project files it references, ref → sha256 (approval.ts hookFiles). */
  files?: Record<string, string>;
  /** hookFingerprint(hook, {phase, index, env, files}). */
  fingerprint: string;
}

/** HTTP request part of a hook (also the shape of an http rollback). */
export type HttpRequestSpec = Omit<HttpHookSpec, 'rollback' | 'save_as'>;

/**
 * Non-secret template data a rollback needs, captured when the hook ran: only the paths its
 * template references (`{{response.json.id}}`, `{{console}}`, `{{vars.x}}`…). Secret references
 * (`{{env:X}}`, `{{keychain:a/b}}`) stay in template form and are resolved again at rollback time.
 */
export interface TemplateSnapshot {
  pages?: Record<string, string>;
  vars?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  run?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

interface RollbackBase {
  /** Templated, redacted description (for logs and listings). */
  description: string;
  data: TemplateSnapshot;
}

/** Template form of the action that undoes a hook (interpolated with `data` + fresh secrets at rollback time). */
export type RollbackAction =
  | (RollbackBase & { kind: 'http'; request: HttpRequestSpec })
  | (RollbackBase & { kind: 'sql'; db: string; file?: string; query: string })
  | (RollbackBase & { kind: 'shell'; run: string; cwd?: string; env?: Record<string, string>; timeout?: number; /** Written by an agent (trust `mcp`): checked again when replayed. */ agent?: true })
  | (RollbackBase & { kind: 'js'; code: string; page?: string });

/** ok: executed (its rollback, if any, is pending). failed: did not complete. rolled_back: undone. */
export type JournalEntryStatus = 'ok' | 'failed' | 'rolled_back';

export interface JournalEntry {
  /** 1-based, increasing within a journal file. */
  seq: number;
  name?: string;
  kind: HookKind;
  phase: HookPhase;
  description: string;
  env?: string;
  run_id?: string;
  started_at: string;
  finished_at: string;
  status: JournalEntryStatus;
  error?: string;
  /** Only setup hooks that executed and declare a rollback. */
  rollback?: RollbackAction;
  rolled_back_at?: string;
  /**
   * The rollback will never be replayed (L1.8): a sandbox reset rebuilt the data of the entry's environment (replaying
   * it would act on the new data). Not pending any more.
   */
  superseded?: { at: string; by: string };
  /** Last failed rollback attempt (the entry stays pending). */
  rollback_error?: string;
  rollback_attempts?: number;
  /** L5.14: HMAC-SHA256 with the Retake home's key over the journal's id and the entry (journal.ts), hex. */
  sig?: string;
}

export type NewJournalEntry = Omit<JournalEntry, 'seq'>;

/** runs/<id>/hooks-journal.json */
export interface JournalFile {
  version: 1;
  created_at: string;
  updated_at: string;
  entries: JournalEntry[];
}
