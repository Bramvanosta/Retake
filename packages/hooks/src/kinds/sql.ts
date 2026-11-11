import pg from 'pg';
import { collectSecretRefs, databasesFor, databasesSource, sandboxOf, sqlDestructiveKeyword, sqlSource, sqlWriteStatement } from '@retake/core';
import type { SqlHookSpec, TemplateContext } from '@retake/core';
import { checkHostAllowed } from '../allow-list.js';
import { databaseTarget, describeTarget, sandboxDatabaseProblem } from '../db-url.js';
import type { DatabaseTarget } from '../db-url.js';
import { describeSql } from '../describe.js';
import { HookError, HookSecurityError, errorMessage } from '../errors.js';
import { addSecret, redactText } from '../secrets.js';
import { lineAt, transactionControl } from '../sql-text.js';
import { hookTemplateContext, render, snapshotFor, snapshotTemplateContext } from '../template.js';
import { journalsRollback } from '../types.js';
import type { HookContext, HookLogLevel, RollbackAction, TemplateSnapshot } from '../types.js';
import { baseDirOf, ignoreRollback, readHookFile } from './common.js';
import type { KindEnv, PreparedHook, RollbackEnv } from './common.js';

export const SQL_CONNECT_TIMEOUT_MS = 15_000;
/** Server-side limit per statement (a hook waiting on a lock must not hang a run forever). */
export const SQL_STATEMENT_TIMEOUT_MS = 300_000;

interface Database {
  key: string;
  urlTemplate: string;
  connectionString: string;
  target: DatabaseTarget;
  /** "main (127.0.0.1:5432/app)" */
  label: string;
}

/**
 * Connection of `databases[key ?? first]` of the environment (`env`, default the context's: a sandbox's own databases,
 * else project.yaml's — core databasesFor): URL templated (secrets resolved), host checked against the allow-list
 * before any connection. `snapshot` re-templates it for a rollback.
 */
async function openDatabase(
  ctx: HookContext,
  log: (level: HookLogLevel, msg: string) => void,
  key: string | undefined,
  snapshot?: TemplateSnapshot,
  env: string = ctx.env.name,
): Promise<Database> {
  const dbs = databasesFor(ctx.project, env);
  const where = databasesSource(ctx.project, env);
  const keys = Object.keys(dbs);
  if (!keys.length) {
    throw new HookError(`sql hooks need a database: add \`databases: {main: {url: "postgres://…"}}\` to ${where}`);
  }
  const k = key ?? keys[0];
  if (!Object.hasOwn(dbs, k)) {
    throw new HookError(`unknown database "${k}" (${where} declares: ${keys.join(', ')})`);
  }
  const urlTemplate = dbs[k].url;
  const tpl = snapshot
    ? await snapshotTemplateContext(ctx, snapshot, urlTemplate)
    : await hookTemplateContext(ctx, urlTemplate);
  const connectionString = render(urlTemplate, tpl);
  // A sandbox's database (L1.8): pg must connect where its URL says, on this machine (validation refuses the rest).
  if (sandboxOf(ctx.project, env)) {
    const problem = sandboxDatabaseProblem(connectionString);
    if (problem) throw new HookSecurityError(`refusing database ${k} of sandbox ${env}: ${problem}`, 'host');
  }
  const target = databaseTarget(connectionString);
  if (target.password) {
    addSecret(ctx, target.password);
    // A sandbox's database is local and disposable (L1.8): its plain demo password is expected.
    if (collectSecretRefs(urlTemplate).size === 0 && !sandboxOf(ctx.project, env)) {
      log('warn', `databases.${k}.url contains a clear-text password: use {{env:VAR}} or {{keychain:service/account}}`);
    }
  }
  checkHostAllowed(connectionString, ctx.project);
  // A docker-compose sandbox's own database: on the exact address Docker publishes its port on (HookContext).
  const address = sandboxOf(ctx.project, env) && !target.socket ? ctx.connectAddress?.(target.host, target.port) : undefined;
  return { key: k, urlTemplate, connectionString: address ? withHost(connectionString, address) : connectionString, target, label: `${k} (${describeTarget(target)})` };
}

/** A connection string with another host (an IPv6 address in brackets). */
function withHost(connectionString: string, host: string): string {
  const u = new URL(connectionString);
  u.hostname = host.includes(':') ? `[${host}]` : host;
  return u.href;
}

function sqlErrorMessage(e: unknown, sql: string): string {
  const err = e as { message?: string; position?: string; detail?: string; hint?: string };
  let msg = err.message ?? String(e);
  const pos = Number(err.position);
  if (Number.isFinite(pos) && pos > 0) msg += ` (line ${lineAt(sql, pos)})`;
  if (err.detail) msg += `; ${err.detail}`;
  if (err.hint) msg += `; hint: ${err.hint}`;
  return msg;
}

function summarize(res: pg.QueryResult | pg.QueryResult[]): string {
  const all = Array.isArray(res) ? res : [res];
  const rows = all
    .filter((r) => r.command !== 'SELECT' && typeof r.rowCount === 'number')
    .reduce((n, r) => n + (r.rowCount ?? 0), 0);
  return `${all.length} statement${all.length === 1 ? '' : 's'}, ${rows} row${rows === 1 ? '' : 's'} affected`;
}

/**
 * Run a whole SQL text as one multi-statement query inside BEGIN … COMMIT (ROLLBACK on error). `readOnly` (a read-only
 * run, L1.7): BEGIN READ ONLY — whatever the static check could not see (a function that writes) fails in Postgres.
 */
async function runSql(
  db: Database,
  sql: string,
  where: string,
  log: (level: HookLogLevel, msg: string) => void,
  readOnly = false,
): Promise<string> {
  const client = new pg.Client({
    connectionString: db.connectionString,
    connectionTimeoutMillis: SQL_CONNECT_TIMEOUT_MS,
    statement_timeout: SQL_STATEMENT_TIMEOUT_MS,
    application_name: 'retake-hooks',
  });
  // Connection-level errors also reject the pending query; this only prevents an unhandled 'error' event.
  client.on('error', () => undefined);
  client.on('notice', (n) => log('debug', `${where}: ${n.severity ?? 'NOTICE'} ${n.message}`));
  try {
    await client.connect();
  } catch (e) {
    await client.end().catch(() => undefined);
    throw new HookError(`cannot connect to database ${db.label}: ${errorMessage(e)}`);
  }
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    try {
      const res = (await client.query(sql)) as pg.QueryResult | pg.QueryResult[];
      await client.query('COMMIT');
      return summarize(res);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new HookError(`${where} failed, transaction rolled back: ${sqlErrorMessage(e, sql)}`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Template text → SQL to run, refusing texts that manage their own transaction. */
function renderSql(text: string, tpl: TemplateContext, where: string): string {
  const sql = render(text, tpl);
  if (!sql.trim()) throw new HookError(`${where} is empty`);
  const tx = transactionControl(sql);
  if (tx) {
    throw new HookError(`${where} contains its own transaction control (${tx}); sql hooks already run inside BEGIN … COMMIT, remove it`);
  }
  return sql;
}

async function loadSource(ctx: HookContext, source: { file?: string; query?: string }, what: string): Promise<string> {
  if (!source.file === !source.query) throw new HookError(`${what} needs exactly one of \`file\` or \`query\``);
  return source.file ? readHookFile(ctx, baseDirOf(ctx), source.file, 'SQL file') : source.query!;
}

export async function prepareSql(spec: string | SqlHookSpec, k: KindEnv): Promise<PreparedHook> {
  const { ctx, log } = k;
  const source = typeof spec === 'string' ? sqlSource(spec) : { file: spec.file, query: spec.query };
  const where = source.file ?? 'inline SQL';
  const text = await loadSource(ctx, source, 'sql hook');
  const db = await openDatabase(ctx, log, typeof spec === 'object' ? spec.db : undefined);
  const sql = renderSql(text, await hookTemplateContext(ctx, text), where);
  const kw = sqlDestructiveKeyword(sql);
  const readOnly = ctx.access?.mode === 'read-only';

  const rb = typeof spec === 'object' ? spec.rollback : undefined;
  ignoreRollback(k, rb !== undefined);
  let rollback: RollbackAction | undefined;
  let rollbackWrites: string | null = null;
  let rollbackInfo: PreparedHook['rollback'];
  if (rb !== undefined && journalsRollback(k.phase)) {
    const rbSource = typeof rb === 'string' ? sqlSource(rb) : rb;
    const rbText = await loadSource(ctx, rbSource, 'sql rollback');
    // The connection URL is re-templated at rollback time too: snapshot its tokens with the SQL's.
    const tpl = await hookTemplateContext(ctx, [rbText, db.urlTemplate]);
    const rbSql = renderSql(rbText, tpl, rbSource.file ?? 'inline rollback SQL');
    rollbackWrites = sqlWriteStatement(rbSql);
    const rbKw = sqlDestructiveKeyword(rbSql);
    rollback = {
      kind: 'sql',
      db: db.key,
      ...(rbSource.file ? { file: rbSource.file } : {}),
      query: rbText,
      data: snapshotFor(ctx, [rbText, db.urlTemplate], tpl),
      description: redactText(ctx, describeSql(rbSource, db.label)),
    };
    rollbackInfo = {
      description: redactText(ctx, describeSql(rbSource.file ? { file: rbSource.file } : { query: rbSql }, db.label)),
      reason: rbKw ? (rbSource.file ? `${rbSource.file} contains ${rbKw}` : `SQL ${rbKw}`) : null,
      shown: { kind: 'sql', db: db.label, ...(rbSource.file ? { file: rbSource.file } : { query: rbSql }) },
    };
  }
  return {
    description: redactText(ctx, describeSql(source, db.label)),
    // The statement as it runs (a file: its name — its bytes are bound to an approval through MCP).
    shown: { kind: 'sql', db: db.label, ...(source.file ? { file: source.file } : { query: sql }) },
    destructive: kw ? (source.file ? `${source.file} contains ${kw}` : `SQL ${kw}`) : null,
    writes: sqlWriteStatement(sql) ?? (rollbackWrites ? `its rollback: ${rollbackWrites}` : null),
    hosts: db.target.socket ? [] : [db.target.host],
    ...(rollbackInfo ? { rollback: rollbackInfo } : {}),
    async execute() {
      const message = await runSql(db, sql, where, log, readOnly);
      return { message, rollback };
    },
  };
}

export async function rollbackSql(action: Extract<RollbackAction, { kind: 'sql' }>, r: RollbackEnv): Promise<string> {
  const { ctx, log } = r;
  const db = await openDatabase(ctx, log, action.db, action.data, r.env);
  const where = action.file ?? 'inline rollback SQL';
  const sql = renderSql(action.query, await snapshotTemplateContext(ctx, action.data, action.query, r.env), where);
  return runSql(db, sql, where, log, r.readOnly === true);
}
