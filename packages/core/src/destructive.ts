import { resolve } from 'node:path';
import { needFiles } from './file-facts.js';
import type { FileFacts, FilesWith } from './file-facts.js';
import { commandName, heredocs, nestedShellScript, shellCommands, shellWords } from './shell-words.js';
import type { HookKind, HookStep, HttpHookSpec, ShellHookSpec, SqlHookSpec } from './types.js';

const SQL_WRITE = new Set(['DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'UPDATE']);
/** Words after which DELETE/UPDATE are clauses, not statements: ON DELETE CASCADE, FOR UPDATE, BEFORE UPDATE… */
const CLAUSE_PREFIX = new Set(['ON', 'FOR', 'KEY', 'BEFORE', 'AFTER', 'OF', 'OR', 'INSTEAD']);

/** Remove comments and quoted literals/identifiers so their contents never count as keywords. */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** First destructive keyword of a SQL text (DELETE, DROP, TRUNCATE, ALTER, UPDATE), or null. */
export function sqlDestructiveKeyword(sql: string): string | null {
  const words = stripSqlNoise(sql).toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    if (SQL_WRITE.has(words[i]) && !(i > 0 && CLAUSE_PREFIX.has(words[i - 1]))) return words[i];
  }
  return null;
}

/** `rm` / `dropdb` used in a shell command (also inside `sh -c "…"`; comments and quoted text ignored). */
export function shellDestructiveCommand(cmd: string): string | null {
  for (const { args } of shellCommands(shellWords(cmd))) {
    for (let i = 0; i < args.length; i++) {
      const name = commandName(args[i]);
      if (name === 'rm' || name === 'dropdb') return name;
      const script = nestedShellScript(args, i);
      if (script !== undefined) {
        const nested = shellDestructiveCommand(script);
        if (nested) return nested;
      }
    }
  }
  return null;
}

export function hookKind(hook: HookStep): HookKind {
  if ('http' in hook) return 'http';
  if ('sql' in hook) return 'sql';
  if ('shell' in hook) return 'shell';
  return 'js';
}

/** `sql: "x.sql"` is a file when it ends with .sql, an inline query otherwise. */
export function sqlSource(spec: string | SqlHookSpec): { file?: string; query?: string } {
  if (typeof spec === 'string') return /\.sql$/i.test(spec.trim()) ? { file: spec.trim() } : { query: spec };
  return { file: spec.file, query: spec.query };
}

/** The options of the destructive-hook rules; `files` is required with `projectDir` unless `readText` reads the files (FilesWith, L7.34). */
export type DestructiveOptions = DestructiveFields & (FilesWith<'projectDir'> | { readText: (absPath: string) => string | undefined });

export interface DestructiveFields {
  /** Project directory: SQL files are read from it to inspect their statements. */
  projectDir?: string;
  /** How those files are read (core FileFacts): required with `projectDir` (unless `readText` reads them). */
  files?: FileFacts;
  /** Override file reading (tests); returns undefined when the file cannot be read. */
  readText?: (absPath: string) => string | undefined;
  /** The hook was written by an agent (hookApprovalReason): its sql statements need a person, as its shell commands do. */
  agentWritten?: boolean;
}

/**
 * Why an sql hook an agent wrote needs a person under trust `mcp`: treated like an agent's shell hook, whatever its
 * statement (its rollback is shown and approved with it). A person's own sql hooks keep the destructive rule only, and
 * a sandbox's seed and reset steps (sandbox.yaml, which no agent path writes) are not concerned.
 */
export const AGENT_SQL_REASON = 'an sql hook the agent wrote (runs statements on the database)';

function readWith(files: FileFacts, file: string): string | undefined {
  try {
    return files.kind(file) !== undefined ? files.readText(file) : undefined;
  } catch {
    return undefined;
  }
}

/** psql short options that take an argument (the rest of the cluster or the next word). */
const PSQL_ARG_OPTS = new Set('cdfhpUvoLFRPT'.split(''));

/** A project file's text (relative to `opts.projectDir`), or undefined when it cannot be read or there is no project dir. */
export function readProjectText(file: string, opts: DestructiveOptions): string | undefined {
  if (!opts.projectDir) return undefined;
  const abs = resolve(opts.projectDir, file);
  return opts.readText ? opts.readText(abs) : readWith(needFiles(opts.files, 'reading a project file'), abs);
}

/** Destructive SQL passed to psql via -c / --command / -f / --file, or null. */
function psqlArgsReason(args: readonly string[], opts: DestructiveOptions): string | null {
  const sqls: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--command' || a === '--file') {
      const v = args[++i];
      if (v === undefined) continue;
      if (a === '--command') sqls.push(v);
      else files.push(v);
    } else if (a.startsWith('--command=')) sqls.push(a.slice(10));
    else if (a.startsWith('--file=')) files.push(a.slice(7));
    else if (/^-[A-Za-z]/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const o = a[k];
        if (!PSQL_ARG_OPTS.has(o)) continue;
        const v = k + 1 < a.length ? a.slice(k + 1) : args[++i];
        if (v !== undefined && o === 'c') sqls.push(v);
        if (v !== undefined && o === 'f') files.push(v);
        break;
      }
    }
  }
  for (const sql of sqls) {
    const kw = sqlDestructiveKeyword(sql);
    if (kw) return `psql -c ${kw}`;
  }
  for (const f of files) {
    const text = readProjectText(f, opts);
    const kw = text === undefined ? null : sqlDestructiveKeyword(text);
    if (kw) return `psql -f ${f} contains ${kw}`;
  }
  return null;
}

/**
 * Destructive SQL sent to psql: `psql -c "DELETE …"`, `psql -f file.sql` (read from the project dir),
 * a heredoc fed to psql, `echo "DROP …" | psql`, also inside `sh -c "…"`.
 */
export function psqlDestructiveStatement(cmd: string, opts: DestructiveOptions = {}): string | null {
  const cmds = shellCommands(shellWords(cmd));
  let usesPsql = false;
  for (let i = 0; i < cmds.length; i++) {
    const { args, after } = cmds[i];
    for (let k = 0; k < args.length; k++) {
      const script = nestedShellScript(args, k);
      const nested = script === undefined ? null : psqlDestructiveStatement(script, opts);
      if (nested) return nested;
    }
    const at = args.findIndex((w) => commandName(w) === 'psql');
    if (at < 0) continue;
    usesPsql = true;
    const r = psqlArgsReason(args.slice(at + 1), opts);
    if (r) return r;
    const prev = cmds[i - 1];
    if (after === '|' && prev && ['echo', 'printf'].includes(commandName(prev.args[0] ?? ''))) {
      const kw = sqlDestructiveKeyword(prev.args.slice(1).join(' '));
      if (kw) return `SQL piped to psql: ${kw}`;
    }
  }
  if (usesPsql) {
    for (const h of heredocs(cmd)) {
      const kw = sqlDestructiveKeyword(h.body);
      if (kw) return `psql heredoc ${kw}`;
    }
  }
  return null;
}

/** `rm` / `dropdb`, or destructive SQL given to psql, in a shell command. */
export function shellDestructiveReason(cmd: string, opts: DestructiveOptions = {}): string | null {
  const c = shellDestructiveCommand(cmd);
  return c ? `shell ${c}` : psqlDestructiveStatement(cmd, opts);
}

/**
 * Why a hook is destructive (it then needs `confirm: true`), or null.
 * Declared (`destructive: true`), SQL with DELETE/DROP/TRUNCATE/ALTER/UPDATE (inline or in its file),
 * HTTP DELETE, shell `rm` / `dropdb` / psql given destructive SQL. Rollback actions are not considered (they undo
 * the hook).
 */
export function destructiveReason(hook: HookStep, opts: DestructiveOptions = {}): string | null {
  if (hook.destructive === true) return 'declared destructive';
  switch (hookKind(hook)) {
    case 'http': {
      const spec = (hook as { http: HttpHookSpec }).http;
      return spec.method === 'DELETE' ? 'HTTP DELETE' : null;
    }
    case 'sql': {
      const { file, query } = sqlSource((hook as { sql: string | SqlHookSpec }).sql);
      if (query) {
        const kw = sqlDestructiveKeyword(query);
        if (kw) return `SQL ${kw}`;
      }
      if (file && opts.projectDir) {
        const text = readProjectText(file, opts);
        const kw = text === undefined ? null : sqlDestructiveKeyword(text);
        if (kw) return `${file} contains ${kw}`;
      }
      return null;
    }
    case 'shell': {
      const spec = (hook as { shell: string | ShellHookSpec }).shell;
      return shellDestructiveReason(typeof spec === 'string' ? spec : spec.run, opts);
    }
    case 'js':
      return null; // only an explicit `destructive: true` marks page scripts
  }
}

/**
 * Why a setup hook's rollback needs a human before the hook runs, for work submitted through MCP (trust `mcp`): a
 * destructive rollback (HTTP DELETE, destructive SQL inline or in its file), and every shell or js rollback (local code,
 * code run in the page). Null: no rollback, or one that only undoes with a non-destructive request.
 */
export function rollbackApprovalReason(hook: HookStep, opts: DestructiveOptions = {}): string | null {
  switch (hookKind(hook)) {
    case 'http': {
      const rb = (hook as { http: HttpHookSpec }).http?.rollback;
      return rb && (rb.method ?? 'GET').toUpperCase() === 'DELETE' ? 'its rollback: HTTP DELETE' : null;
    }
    case 'sql': {
      const spec = (hook as { sql: string | SqlHookSpec }).sql;
      const rb = typeof spec === 'object' && spec ? spec.rollback : undefined;
      if (rb === undefined) return null;
      const { file, query } = typeof rb === 'string' ? sqlSource(rb) : rb;
      const text = query ?? (file ? readProjectText(file, opts) : undefined);
      const kw = text === undefined ? null : sqlDestructiveKeyword(text);
      return kw ? `its rollback: ${file && !query ? `${file} contains ${kw}` : `SQL ${kw}`}` : null;
    }
    case 'shell': {
      const spec = (hook as { shell: string | ShellHookSpec }).shell;
      return typeof spec === 'object' && spec?.rollback !== undefined ? 'its rollback: a shell command (runs local code)' : null;
    }
    case 'js': {
      const spec = (hook as { js: unknown }).js as { rollback?: string } | string;
      return typeof spec === 'object' && spec?.rollback !== undefined ? 'its rollback: JavaScript run in the page' : null;
    }
  }
}

/**
 * Why a hook needs a human before work submitted by an agent (trust `mcp`: the MCP server, the Studio) runs it, from
 * its file alone, or null: declared or detected destructive, any shell command (local code), an sql hook the agent
 * wrote (`opts.agentWritten`: AGENT_SQL_REASON) and, for a setup hook (`phase`), a rollback that needs approval
 * (rollbackApprovalReason). The submit's preflight (engine approvals.ts) also
 * templates each hook; this is its backstop and what the Studio's hooks strip shows. A malformed hook gives null
 * (validation reports it).
 */
export function hookApprovalReason(hook: HookStep, phase: string, opts: DestructiveOptions = {}): string | null {
  let kind: HookKind;
  try {
    kind = hookKind(hook);
  } catch {
    return null;
  }
  try {
    const own = hook.destructive === true ? 'declared destructive' : (destructiveReason(hook, opts) ?? (kind === 'shell' ? 'a shell command (runs local code)' : kind === 'sql' && opts.agentWritten === true ? AGENT_SQL_REASON : null));
    // Setup and step hooks (L5.8) journal their rollback, run later without asking again.
    const rollback = phase === 'setup' || phase === 'step' ? rollbackApprovalReason(hook, opts) : null;
    const reasons = [own, rollback].filter((r): r is string => r !== null);
    return reasons.length ? reasons.join('; ') : null;
  } catch {
    return null;
  }
}
