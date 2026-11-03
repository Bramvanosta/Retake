/**
 * Which hooks write (L1.7, R-ENV-04): a read-only run refuses them. Static classification shared by validation, the
 * runner (which refuses a read-only run with writing hooks before any browser opens) and @retake/hooks (which
 * refuses each one again on its templated content). The model is destructive.ts.
 */
import { readProjectText, shellDestructiveReason, sqlSource } from './destructive.js';
import type { DestructiveOptions } from './destructive.js';
import { channelWords } from './agent-trust.js';
import type { AgentChannel } from './agent-trust.js';
import { maskSql } from './sql-text.js';
import type { HookStep, HttpHookSpec, JsHookSpec, ShellHookSpec, SqlHookSpec } from './types.js';
import { graphqlOf, graphqlReadsOnly, graphqlWriteName, isWriteMethod } from './writes.js';

/**
 * Who stands behind the trust flags a hook file carries (`confirm: true`, `writes: false`), L3.1. `author`: the person
 * who wrote the file and runs it from a terminal — the flags count. `mcp`: work submitted through the MCP server, whose
 * agent can write those files itself (scenario_save) — `confirm: true` does not count (destructive hooks need a human
 * approval), every shell hook needs one, and a shell hook always counts as writing (`writes: false` is ignored).
 */
export type HookTrust = 'author' | 'mcp';

/**
 * Why a shell hook writes when its `writes: false` is not trusted (work submitted by an agent), worded for the channel
 * it came through (L4.2: "from the Studio" — a Studio user is never told about MCP).
 */
export function shellAlwaysWrites(via?: AgentChannel): string {
  return `a shell command (${channelWords(via)} a shell hook always counts as writing: its \`writes: false\` is not trusted)`;
}

/** shellAlwaysWrites through MCP. */
export const SHELL_ALWAYS_WRITES = shellAlwaysWrites('mcp');

/** Statements that only read (SELECT … INTO, SELECT … FOR UPDATE, data-modifying CTEs are caught below). */
const READ_STATEMENTS = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'EXPLAIN', 'SET', 'RESET']);
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE']);
/** Words after which DELETE / UPDATE are clauses, not statements: ON DELETE, FOR UPDATE, FOR NO KEY UPDATE, OF… */
const CLAUSE_PREFIX = new Set(['ON', 'FOR', 'KEY', 'BEFORE', 'AFTER', 'OF', 'OR', 'INSTEAD']);
/** Functions that write although called from a SELECT (the read-only database session catches the others). */
const WRITING_FUNCTIONS = new Set(['NEXTVAL', 'SETVAL']);
/** dblink runs its SQL over a connection of its own, outside the read-only transaction. */
const DBLINK = /^DBLINK(?:_EXEC|_SEND_QUERY|_OPEN|_CONNECT(?:_U)?)?$/;

function statementWrite(words: readonly string[]): string | null {
  const first = words[0];
  if (!READ_STATEMENTS.has(first)) return `SQL ${first}`;
  if (first === 'SHOW') return null;
  if (first === 'EXPLAIN') {
    if (!words.includes('ANALYZE') && !words.includes('ANALYSE')) return null;
    const at = words.findIndex((w, i) => i > 0 && (DML.has(w) || ['SELECT', 'WITH', 'TABLE', 'VALUES', 'CREATE', 'EXECUTE'].includes(w)));
    if (at < 0) return null;
    const inner = statementWrite(words.slice(at));
    return inner ? `EXPLAIN ANALYZE runs ${inner}` : null;
  }
  if (first === 'SET' || first === 'RESET') {
    // The transaction's read-only mode and the role are not for a hook to change on a read-only run.
    if (first === 'RESET' && words[1] === 'ALL') return 'SQL RESET ALL';
    const touches = words.some(
      (w) => ['TRANSACTION', 'CHARACTERISTICS', 'ROLE', 'AUTHORIZATION'].includes(w) || /READ_ONLY|^DEFAULT_TRANSACTION|^TRANSACTION_/.test(w),
    );
    return touches ? `SQL ${first} of the transaction mode or role` : null;
  }
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (DML.has(w) && !CLAUSE_PREFIX.has(words[i - 1])) return `SQL ${w}`;
    if (WRITING_FUNCTIONS.has(w)) return `SQL ${w.toLowerCase()}() changes a sequence`;
    if (DBLINK.test(w)) return `SQL ${w.toLowerCase()}() runs SQL over its own connection`;
  }
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === 'FOR' && ['UPDATE', 'SHARE', 'NO', 'KEY'].includes(words[i + 1])) return 'SQL SELECT … FOR UPDATE / SHARE locks rows';
  }
  if (first !== 'VALUES' && first !== 'TABLE' && words.includes('INTO')) return 'SQL SELECT … INTO creates a table';
  return null;
}

/**
 * The first statement of a SQL text that does not only read, or null: reads are SELECT (without INTO, FOR UPDATE /
 * SHARE, nextval / setval, dblink), WITH without a data-modifying part, TABLE, VALUES, SHOW, EXPLAIN (EXPLAIN ANALYZE
 * of a read), SET / RESET of anything but the transaction mode or the role. Comments, literals and dollar-quoted
 * bodies never count; a quoted identifier counts by its name (`SET "transaction_read_only" = off`, `"nextval"(…)`). A
 * function called by a SELECT may still write: the hooks run read-only SQL in a read-only transaction.
 */
export function sqlWriteStatement(sql: string): string | null {
  for (const stmt of maskSql(sql, { identifiers: true }).split(';')) {
    const words = stmt.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g) ?? [];
    if (words.length === 0) continue;
    const r = statementWrite(words);
    if (r) return r;
  }
  return null;
}

/** Why an HTTP request writes, or null: every method but GET / HEAD, unless its body is a GraphQL query (reads only). */
export function httpWriteReason(req: { method?: string; json?: unknown; body?: string }): string | null {
  const method = (req.method ?? 'GET').toUpperCase();
  if (!isWriteMethod(method)) return null;
  const gql = graphqlOf(req.json !== undefined ? req.json : req.body);
  if (gql && graphqlReadsOnly(gql)) return null;
  if (gql) {
    const name = graphqlWriteName(gql);
    return `GraphQL ${gql.some((g) => g.persisted) ? 'persisted query' : 'mutation'}${name ? ` ${name}` : ''}`;
  }
  return `HTTP ${method}`;
}

function sqlTextReason(source: { file?: string; query?: string }, opts: DestructiveOptions): string | null {
  if (source.query) return sqlWriteStatement(source.query);
  if (!source.file) return null;
  const text = readProjectText(source.file, opts);
  if (text === undefined) return null;
  const r = sqlWriteStatement(text);
  return r ? `${source.file}: ${r}` : null;
}

/**
 * Why a hook writes (refused on a read-only run), or null. http: its method (a GraphQL query sent as POST reads);
 * sql: its statements (inline or in its file, read from the project dir); shell: always, unless the hook declares
 * `writes: false` (then a destructive command still writes); js: never statically (its tab guards its requests).
 * A rollback counts too: an http rollback by its method, a sql rollback by its statements, a shell or js rollback
 * always — a hook that only reads but undoes something with a write is refused like a writing hook.
 */
export function hookWriteReason(hook: HookStep, opts: DestructiveOptions & { rollback?: boolean; trust?: HookTrust; via?: AgentChannel } = {}): string | null {
  // Only setup hooks are rolled back: a rollback declared elsewhere is ignored when it runs, and here.
  const withRollback = opts.rollback !== false;
  if ('http' in hook) {
    const spec = (hook as { http: HttpHookSpec }).http;
    const own = httpWriteReason(spec);
    if (own) return own;
    const rb = spec.rollback && withRollback ? httpWriteReason(spec.rollback) : null;
    return rb ? `its rollback: ${rb}` : null;
  }
  if ('sql' in hook) {
    const spec = (hook as { sql: string | SqlHookSpec }).sql;
    const own = sqlTextReason(sqlSource(spec), opts);
    if (own) return own;
    const rb = typeof spec === 'object' && withRollback ? spec.rollback : undefined;
    if (rb === undefined) return null;
    const r = sqlTextReason(typeof rb === 'string' ? sqlSource(rb) : rb, opts);
    return r ? `its rollback: ${r}` : null;
  }
  if ('shell' in hook) {
    const spec = (hook as { shell: string | ShellHookSpec }).shell;
    const run = typeof spec === 'string' ? spec : spec.run;
    if (hook.writes !== false) return 'a shell command — add `writes: false` to a shell hook that only reads';
    if (opts.trust === 'mcp') return shellAlwaysWrites(opts.via);
    const destructive = shellDestructiveReason(run, opts);
    if (destructive) return `${destructive}, although it declares writes: false`;
    return typeof spec === 'object' && spec.rollback !== undefined && withRollback ? 'its rollback: a shell command' : null;
  }
  const spec = (hook as { js: string | JsHookSpec }).js;
  return typeof spec === 'object' && spec.rollback !== undefined && withRollback ? 'its rollback: JavaScript run in the page' : null;
}

/** A journaled rollback action (the hooks' RollbackAction, structurally): does replaying it write? */
export function rollbackWriteReason(action: { kind: string; request?: { method?: string; json?: unknown; body?: string }; query?: string }): string | null {
  switch (action.kind) {
    case 'http':
      return action.request ? httpWriteReason(action.request) : null;
    case 'sql':
      return action.query !== undefined ? sqlWriteStatement(action.query) : null;
    case 'shell':
      return 'a shell command';
    default:
      return 'JavaScript run in the page';
  }
}

/** The hooks of a scenario that write, for the refusal of a read-only run (before anything runs). */
export function writingHooks(
  lists: { setup?: readonly HookStep[]; teardown?: readonly HookStep[]; step?: readonly HookStep[] },
  opts: DestructiveOptions & { trust?: HookTrust; via?: AgentChannel } = {},
): Array<{ phase: 'setup' | 'teardown' | 'step'; index: number; name?: string; reason: string }> {
  const out: Array<{ phase: 'setup' | 'teardown' | 'step'; index: number; name?: string; reason: string }> = [];
  // `step`: the entries of the named hooks a scenario's `hook:` steps run (L5.8), journaled like setup hooks.
  for (const phase of ['setup', 'teardown', 'step'] as const) {
    (lists[phase] ?? []).forEach((hook, index) => {
      const reason = hookWriteReason(hook, { ...opts, rollback: phase !== 'teardown' });
      if (reason) out.push({ phase, index, ...(hook.name ? { name: hook.name } : {}), reason });
    });
  }
  return out;
}
