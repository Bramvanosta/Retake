import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Journal, databaseTarget, maskSql, runHooks, transactionControl } from '@retake/hooks';
import type { HookStep, ProjectConfig } from '@retake/core';
import { makeContext, makeProject, tempProject, writeFiles } from './helpers.js';
import { postgresForTests, startPostgres } from '@retake/test-support/postgres';
import type { TestPostgres } from '@retake/test-support/postgres';

let tmp: Awaited<ReturnType<typeof tempProject>>;
beforeEach(async () => {
  tmp = await tempProject();
});
afterEach(async () => {
  await tmp.cleanup();
});

const journalAt = () => Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));

describe('SQL text analysis', () => {
  it('masks comments, literals and dollar-quoted bodies without moving offsets', () => {
    const sql = "SELECT 'a;b' AS \"x;y\" -- c;\n/* d; /* nested; */ e; */ $f$ g; $f$, E'h\\';i';";
    const masked = maskSql(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked.split(';')).toHaveLength(2);
  });

  it.each([
    ['BEGIN; INSERT INTO t VALUES (1); COMMIT;', 'BEGIN'],
    ['INSERT INTO t VALUES (1);\ncommit', 'COMMIT'],
    ['START TRANSACTION; SELECT 1', 'START TRANSACTION'],
    ['SELECT 1; END;', 'END'],
    ['SAVEPOINT a; INSERT INTO t VALUES (1); ROLLBACK TO SAVEPOINT a;', null],
    ['DO $$ BEGIN UPDATE t SET a = 1; END $$;', null],
    ['CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT f();', null],
    ["INSERT INTO log VALUES ('COMMIT'); -- BEGIN", null],
  ])('%s → %s', (sql, expected) => {
    expect(transactionControl(sql)).toBe(expected);
  });

  it('parses connection targets like pg does', () => {
    expect(databaseTarget('postgres://app:pw@db.example.com:6543/northfield')).toMatchObject({
      host: 'db.example.com',
      port: 6543,
      database: 'northfield',
      password: 'pw',
      socket: false,
    });
    expect(databaseTarget('postgresql:///northfield?host=/var/run/postgresql')).toMatchObject({ socket: true, database: 'northfield' });
  });
});

describe('sql hooks without a server', () => {
  const project = (extra: Partial<ProjectConfig>) => makeProject(tmp.dir, {}, extra);

  it('explain missing or unknown databases', async () => {
    const journal = await journalAt();
    const none = await runHooks([{ sql: 'select 1' }], makeContext(project({})).ctx, { phase: 'teardown', journal });
    expect(none.results[0].error).toBe('sql hooks need a database: add `databases: {main: {url: "postgres://…"}}` to project.yaml');
    const unknown = await runHooks([{ sql: { query: 'select 1', db: 'analytics' } }], makeContext(project({ databases: { main: { url: 'postgres://app@localhost/northfield' } } })).ctx, {
      phase: 'teardown',
      journal,
    });
    expect(unknown.results[0].error).toBe('unknown database "analytics" (project.yaml declares: main)');
  });

  it('refuse SQL that manages its own transaction, and missing files', async () => {
    await writeFiles(tmp.dir, { 'hooks/tx.sql': 'BEGIN;\nINSERT INTO replies (text) VALUES (1);\nCOMMIT;\n' });
    const { ctx } = makeContext(project({ databases: { main: { url: 'postgres://app@localhost/northfield' } } }));
    const res = await runHooks([{ sql: 'hooks/tx.sql' }, { sql: 'hooks/missing.sql' }], ctx, { phase: 'teardown', journal: await journalAt() });
    expect(res.results[0].error).toBe('hooks/tx.sql contains its own transaction control (BEGIN); sql hooks already run inside BEGIN … COMMIT, remove it');
    expect(res.results[1].error).toBe(`SQL file hooks/missing.sql not found (looked for ${join(tmp.dir, 'hooks/missing.sql')})`);
  });

  it('describe unix-socket connections in dry runs', async () => {
    const { ctx } = makeContext(project({ databases: { local: { url: 'postgresql:///northfield?host=/var/run/postgresql' } } }), { dryRun: true });
    const res = await runHooks([{ sql: { query: "INSERT INTO replies (text) VALUES ('hi')" } }], ctx, { phase: 'setup', journal: await journalAt() });
    expect(res.results[0]).toMatchObject({
      status: 'dry',
      description: `sql "INSERT INTO replies (text) VALUES ('hi')" on local (socket /var/run/postgresql/northfield)`,
    });
  });
});

/**
 * Real Postgres, by default wherever it can run (test-support postgres.ts): RETAKE_TEST_PG as given (a connection URL
 * whose role may create tables, e.g. postgres://retake:retake_pw@127.0.0.1:5432/retake_test), else a throwaway
 * container when Docker runs and the image is here; skipped otherwise, saying why.
 */
const POSTGRES = postgresForTests('hooks sql.test.ts');

describe.skipIf(!POSTGRES.ok)('sql hooks against Postgres', () => {
  const table = `nf_replies_${process.pid}_${Date.now() % 100000}`;
  let server: TestPostgres | undefined;
  let PG: string;
  let password: string | undefined;
  let admin: pg.Client;

  beforeAll(async () => {
    server = await startPostgres();
    PG = server.url;
    password = databaseTarget(PG).password;
    admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, text text NOT NULL, shown_on date)`);
  });
  afterAll(async () => {
    // The container goes whatever happened to the table or the connection (a server gone, a failed beforeAll).
    try {
      await admin?.query(`DROP TABLE IF EXISTS ${table}`);
      await admin?.end();
    } finally {
      await server?.stop();
    }
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE ${table}`);
    await writeFiles(tmp.dir, {
      'hooks/seed.sql': `-- two replies for the quote scene\nINSERT INTO {{vars.table}} (text) VALUES ('Sample requested');\nINSERT INTO {{vars.table}} (text) VALUES ('Order shipped');\n`,
      'hooks/unseed.sql': `DELETE FROM {{vars.table}} WHERE text IN ('Sample requested', 'Order shipped');`,
      'hooks/bad.sql': `INSERT INTO {{vars.table}} (text) VALUES ('should not stay');\nINSERT INTO {{vars.table}} (nope) VALUES (1);\n`,
    });
  });

  const texts = async () => (await admin.query(`SELECT text FROM ${table} ORDER BY id`)).rows.map((r: { text: string }) => r.text);

  function context(url = '{{env:RETAKE_TEST_PG}}') {
    const project = makeProject(tmp.dir, {}, { databases: { main: { url } } });
    return makeContext(project, { vars: { table } });
  }

  it('runs a file in one transaction and undoes it with its rollback file', async () => {
    const { ctx } = context();
    const journal = await journalAt();
    const hooks: HookStep[] = [{ sql: { file: 'hooks/seed.sql', rollback: 'hooks/unseed.sql' } }];
    const res = await runHooks(hooks, ctx, { phase: 'setup', journal });
    expect(res.ok).toBe(true);
    const target = databaseTarget(PG!);
    expect(res.results[0]).toMatchObject({
      message: '2 statements, 2 rows affected',
      description: `sql hooks/seed.sql on main (${target.host}:${target.port}/${target.database})`,
    });
    expect(await texts()).toEqual(['Sample requested', 'Order shipped']);
    expect(journal.pending()[0].rollback).toMatchObject({ kind: 'sql', db: 'main', file: 'hooks/unseed.sql', data: { vars: { table } } });

    const rolled = await (await journalAt()).rollbackAll(makeContext(makeProject(tmp.dir, {}, { databases: { main: { url: '{{env:RETAKE_TEST_PG}}' } } })).ctx);
    expect(rolled).toMatchObject([{ status: 'ok', message: '1 statement, 2 rows affected' }]);
    expect(await texts()).toEqual([]);
  });

  it('runs inline SQL with templating; destructive statements need confirm', async () => {
    const { ctx } = context();
    ctx.vars = { ...ctx.vars, reply: "Roaster's note" };
    const journal = await journalAt();
    const insert: HookStep = { sql: { query: "INSERT INTO {{vars.table}} (text, shown_on) VALUES ($q${{vars.reply}}$q$, DATE '2027-03-01')" } };
    const shift: HookStep = {
      sql: {
        query: 'UPDATE {{vars.table}} SET shown_on = shown_on + 30',
        rollback: { query: 'UPDATE {{vars.table}} SET shown_on = shown_on - 30' },
      },
    };
    const refused = await runHooks([insert, shift], ctx, { phase: 'setup', journal });
    expect(refused.results.map((r) => r.status)).toEqual(['ok', 'refused']);
    expect(refused.results[1].error).toMatch(/^refusing destructive hook \(SQL UPDATE\) without "confirm: true"/);
    const dates = async () => (await admin.query(`SELECT to_char(shown_on, 'YYYY-MM-DD') AS d FROM ${table}`)).rows.map((r: { d: string }) => r.d);
    expect(await texts()).toEqual(["Roaster's note"]); // no rollback declared: it stays
    expect(await dates()).toEqual(['2027-03-01']);

    const confirmed = await runHooks([{ ...shift, confirm: true }], ctx, { phase: 'setup', journal });
    expect(confirmed.results[0]).toMatchObject({ status: 'ok', message: '1 statement, 1 row affected' });
    expect(await dates()).toEqual(['2027-03-31']);
    await journal.rollbackAll(ctx);
    expect(await dates()).toEqual(['2027-03-01']);
  });

  it('rolls back the whole file on error and reports the failing line', async () => {
    const { ctx } = context();
    const res = await runHooks([{ sql: 'hooks/bad.sql' }], ctx, { phase: 'setup', journal: await journalAt() });
    expect(res.ok).toBe(false);
    expect(res.results[0].error).toBe(`hooks/bad.sql failed, transaction rolled back: column "nope" of relation "${table}" does not exist (line 2)`);
    expect(await texts()).toEqual([]);
  });

  it('a setup failure runs the rollback of the SQL hooks that completed', async () => {
    const { ctx } = context();
    const journal = await journalAt();
    const res = await runHooks(
      [
        { sql: { file: 'hooks/seed.sql', rollback: 'hooks/unseed.sql' } },
        { confirm: true, sql: { query: "UPDATE {{vars.table}} SET shown_on = DATE '2027-01-15'", rollback: { query: 'UPDATE {{vars.table}} SET shown_on = NULL' } } },
        { sql: 'hooks/bad.sql' },
      ],
      ctx,
      { phase: 'setup', journal },
    );
    expect(res.results.map((r) => [r.phase, r.status, r.message])).toEqual([
      ['setup', 'ok', '2 statements, 2 rows affected'],
      ['setup', 'ok', '1 statement, 2 rows affected'],
      ['setup', 'failed', undefined],
      ['rollback', 'ok', '1 statement, 2 rows affected'],
      ['rollback', 'ok', '1 statement, 2 rows affected'],
    ]);
    expect(await texts()).toEqual([]);
  });

  it('a read-only run reads in a read-only transaction: a function that writes fails in Postgres (L1.7)', async () => {
    await admin.query(`CREATE OR REPLACE FUNCTION ${table}_touch() RETURNS int LANGUAGE sql AS $$ INSERT INTO ${table} (text) VALUES ('touched') RETURNING id $$`);
    try {
      const { ctx } = context();
      ctx.access = { env: 'production', mode: 'read-only', production: true, configured: 'read-only' };
      // The static check sees a SELECT: Postgres refuses the write the function makes.
      const res = await runHooks([{ sql: `SELECT ${table}_touch()` }, { sql: `SELECT count(*) FROM ${table}` }], ctx, { phase: 'teardown', journal: await journalAt() });
      expect(res.results.map((r) => r.status)).toEqual(['failed', 'ok']);
      expect(res.results[0].error).toMatch(/cannot execute INSERT in a read-only transaction/);
      expect(await texts()).toEqual([]);
    } finally {
      await admin.query(`DROP FUNCTION IF EXISTS ${table}_touch()`);
    }
  });

  it('keeps the database password out of logs and the journal', async () => {
    const { ctx, logText } = context();
    const journal = await journalAt();
    await runHooks([{ sql: { file: 'hooks/seed.sql', rollback: 'hooks/unseed.sql' } }, { sql: 'hooks/bad.sql' }], ctx, { phase: 'setup', journal });
    const journalText = await readFile(journal.file, 'utf8');
    expect(journalText).toContain('hooks/unseed.sql');
    if (password) {
      expect(logText()).not.toContain(password);
      expect(journalText).not.toContain(password);
    }
    expect(journalText).not.toContain(PG!);
  });

  it('connection failures name the database, not the URL; clear-text passwords are flagged', async () => {
    const t = databaseTarget(PG!);
    const url = `postgres://${t.user}:wrong-password-123@${t.host}:${t.port}/${t.database}`;
    const { ctx, logText } = context(url);
    const res = await runHooks([{ sql: { query: 'SELECT 1' } }], ctx, { phase: 'setup', journal: await journalAt() });
    expect(res.results[0].error).toBe(`cannot connect to database main (${t.host}:${t.port}/${t.database}): password authentication failed for user "${t.user}"`);
    expect(logText()).toContain('warn databases.main.url contains a clear-text password: use {{env:VAR}} or {{keychain:service/account}}');
    expect(logText()).not.toContain('wrong-password-123');
  });
});
