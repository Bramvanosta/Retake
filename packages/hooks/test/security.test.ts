import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookSecurityError,
  Journal,
  allowedHosts,
  checkHostAllowed,
  destructiveReason,
  isDestructive,
  isHostAllowed,
  runHooks,
  shellWords,
} from '@demo-studio/hooks';
import type { HookStep } from '@demo-studio/core';
import { makeContext, makeProject, tempProject, writeFiles } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
beforeEach(async () => {
  tmp = await tempProject();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

describe('allow-list', () => {
  const project = makeProject('/projects/northfield', { console: 'http://localhost:4401' }, {
    allow_hosts: ['api.partner.example.net', '*.cdn.example.org', 'https://hooks.example.com/path', 'db.example.com:5432'],
  });

  it('lists localhost, every environment host and allow_hosts', () => {
    expect(allowedHosts(project)).toEqual([
      'localhost',
      '127.0.0.1',
      '::1',
      'console.staging.example.com',
      'shop.staging.example.com',
      'api.partner.example.net',
      '*.cdn.example.org',
      'hooks.example.com',
      'db.example.com',
    ]);
  });

  it.each([
    ['http://localhost:4401/api/reset', true],
    ['http://127.0.0.1:9999/x', true],
    ['http://[::1]:8080/x', true],
    ['https://CONSOLE.staging.example.com./api', true],
    ['https://shop.staging.example.com/cart', true],
    ['https://api.partner.example.net/v1', true],
    ['https://img.cdn.example.org/a.png', true],
    ['https://cdn.example.org/a.png', false],
    ['https://hooks.example.com/other', true],
    ['https://console.example.com/api', false],
    ['https://staging.example.com.attacker.example.net/', false],
    ['http://127.0.0.2/', false],
    ['postgres://app:secret@db.example.com:5432/northfield', true],
    ['postgres://app:secret@db.prod.example.com/northfield', false],
    ['postgresql:///northfield?host=/var/run/postgresql', true],
    ['socket:/var/run/postgresql?db=northfield', true],
    ['postgres://app@localhost/northfield', true],
  ])('%s → %s', (url, allowed) => {
    if (allowed) expect(() => checkHostAllowed(url, project)).not.toThrow();
    else expect(() => checkHostAllowed(url, project)).toThrow(HookSecurityError);
  });

  it('names the host, never the URL (it may carry credentials)', () => {
    let error: unknown;
    try {
      checkHostAllowed('postgres://app:hunter2-secret@db.prod.example.com/northfield', project);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HookSecurityError);
    expect((error as HookSecurityError).reason).toBe('host');
    expect((error as Error).message).toBe(
      'refusing to contact db.prod.example.com: it is not in the allow-list of project "northfield" (allowed: localhost, 127.0.0.1, ::1, ' +
        'console.staging.example.com, shop.staging.example.com, api.partner.example.net, *.cdn.example.org, hooks.example.com, db.example.com); ' +
        'add it to allow_hosts in project.yaml if it is a staging host',
    );
    expect(() => checkHostAllowed('not a url', project)).toThrow('refusing a malformed URL (its host cannot be checked)');
    expect(isHostAllowed('LOCALHOST', project)).toBe(true);
  });

  it('refuses http hooks to other hosts before any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ctx } = makeContext(makeProject(tmp.dir, { console: 'http://localhost:4401' }));
    const journal = await Journal.open(join(tmp.dir, 'runs/r/hooks-journal.json'));
    const res = await runHooks(
      [
        { http: { method: 'POST', url: 'https://console.production.example.com/api/reset' } },
        { http: { url: 'http://localhost:4401/never-reached' } },
      ],
      ctx,
      { phase: 'setup', journal },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, results: [{ status: 'refused' }] });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].error).toMatch(/^refusing to contact console\.production\.example\.com:/);
    expect(journal.entries).toMatchObject([{ status: 'failed', error: res.results[0].error }]);
  });

  it('refuses sql hooks to other database hosts before connecting', async () => {
    const project = makeProject(tmp.dir, {}, { databases: { main: { url: 'postgres://app:{{env:NF_DB_PASSWORD}}@db.prod.example.com/northfield' } } });
    process.env.NF_DB_PASSWORD = 'pw-not-used';
    const { ctx } = makeContext(project);
    const journal = await Journal.open(join(tmp.dir, 'runs/r/hooks-journal.json'));
    const res = await runHooks([{ sql: { query: 'select 1' } }], ctx, { phase: 'teardown', journal });
    expect(res.results[0]).toMatchObject({ status: 'refused' });
    expect(res.results[0].error).toMatch(/^refusing to contact db\.prod\.example\.com:/);
    delete process.env.NF_DB_PASSWORD;
  });

  it('optional does not tolerate refusals', async () => {
    const { ctx } = makeContext(makeProject(tmp.dir, {}));
    const journal = await Journal.open(join(tmp.dir, 'runs/r/hooks-journal.json'));
    const res = await runHooks(
      [{ optional: true, http: { url: 'https://elsewhere.example.net/' } }, { shell: 'echo ran > ran.txt' }],
      ctx,
      { phase: 'setup', journal },
    );
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(1);
  });
});

describe('destructive hooks', () => {
  const cases: Array<[string, HookStep, string | null]> = [
    ['declared', { js: 'localStorage.clear()', destructive: true }, 'declared destructive'],
    ['plain js', { js: 'localStorage.clear()' }, null],
    ['SQL DELETE', { sql: 'DELETE FROM offers WHERE region = $$Iceland$$' }, 'SQL DELETE'],
    ['SQL lower-case update', { sql: { query: 'update offers set paused = true' } }, 'SQL UPDATE'],
    ['SQL DROP', { sql: 'drop table imports' }, 'SQL DROP'],
    ['SQL TRUNCATE', { sql: 'TRUNCATE offers' }, 'SQL TRUNCATE'],
    ['SQL ALTER', { sql: 'ALTER TABLE offers ADD COLUMN note text' }, 'SQL ALTER'],
    ['SQL insert', { sql: "INSERT INTO notes VALUES ('DROP TABLE offers; DELETE everything')" }, null],
    ['SQL comments', { sql: '-- delete old rows\n/* UPDATE later */ SELECT 1' }, null],
    ['SQL clause', { sql: 'SELECT * FROM offers FOR UPDATE' }, null],
    ['SQL upsert', { sql: 'INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2' }, 'SQL UPDATE'],
    ['HTTP DELETE', { http: { method: 'DELETE', url: '{{console}}/api/replies/1' } }, 'HTTP DELETE'],
    ['HTTP POST', { http: { method: 'POST', url: '{{console}}/api/replies' } }, null],
    ['rm', { shell: 'rm -rf tmp/exports' }, 'shell rm'],
    ['dropdb', { shell: 'dropdb northfield_staging' }, 'shell dropdb'],
    ['psql -c', { shell: 'psql "$DATABASE_URL" -c "DELETE FROM offers"' }, 'psql -c DELETE'],
    ['psql -Atc', { shell: "psql -Atc 'truncate imports' northfield" }, 'psql -c TRUNCATE'],
    ['psql --command=', { shell: 'psql --command="UPDATE offers SET paused = false"' }, 'psql -c UPDATE'],
    ['psql select', { shell: 'psql -c "SELECT count(*) FROM offers"' }, null],
    ['psql -d then -c', { shell: 'psql -d northfield -c "select 1"' }, null],
    ['psql heredoc', { shell: "psql northfield <<'SQL'\nDELETE FROM replies;\nSQL" }, 'psql heredoc DELETE'],
    ['echo | psql', { shell: 'echo "DROP TABLE replies" | psql northfield' }, 'SQL piped to psql: DROP'],
    ['nested sh -c', { shell: `sh -c "psql -c 'DELETE FROM replies'"` }, 'psql -c DELETE'],
    ['seed', { shell: 'pnpm run seed --roasters 3' }, null],
    ['firm', { shell: 'echo confirm firmware' }, null],
  ];

  it.each(cases)('%s', (_label, hook, reason) => {
    expect(destructiveReason(hook)).toBe(reason);
    expect(isDestructive(hook)).toBe(reason !== null);
  });

  it('reads SQL files given to sql hooks and psql -f from the project dir', async () => {
    await writeFiles(tmp.dir, { 'hooks/clean.sql': '-- remove duplicates\nDELETE FROM registry_refs WHERE dup;', 'hooks/read.sql': 'SELECT 1;' });
    expect(destructiveReason({ sql: 'hooks/clean.sql' }, { projectDir: tmp.dir })).toBe('hooks/clean.sql contains DELETE');
    expect(destructiveReason({ shell: 'psql -f hooks/clean.sql' }, { projectDir: tmp.dir })).toBe('psql -f hooks/clean.sql contains DELETE');
    expect(destructiveReason({ shell: 'psql --file=hooks/read.sql' }, { projectDir: tmp.dir })).toBeNull();
  });

  it('are refused at run time without confirm: true, unless confirmDestructive approves', async () => {
    const project = makeProject(tmp.dir, {});
    const journal = await Journal.open(join(tmp.dir, 'runs/r/hooks-journal.json'));
    await writeFiles(tmp.dir, { 'exports/old.mp4': 'x' });

    const refused = await runHooks([{ shell: 'rm exports/old.mp4' }], makeContext(project).ctx, { phase: 'teardown', journal });
    expect(refused.results[0]).toMatchObject({ ok: false, status: 'refused' });
    expect(refused.results[0].error).toBe(
      'refusing destructive hook (shell rm) without "confirm: true"; add it to the hook once you have checked what it does',
    );

    const asked: string[] = [];
    const { ctx, logText } = makeContext(project, {
      confirmDestructive: (description, reason) => {
        asked.push(`${reason} | ${description}`);
        return true;
      },
    });
    const approved = await runHooks([{ shell: 'rm exports/old.mp4' }], ctx, { phase: 'teardown', journal });
    expect(approved.ok).toBe(true);
    expect(asked).toEqual(['shell rm | shell "rm exports/old.mp4"']);
    expect(logText()).toContain('warn destructive hook (shell rm) approved without "confirm: true"');

    const confirmed = await runHooks([{ confirm: true, shell: 'echo x > a.txt && rm a.txt' }], makeContext(project).ctx, {
      phase: 'teardown',
      journal,
    });
    expect(confirmed.ok).toBe(true);
  });

  it('checks the SQL that would actually run (templated file content)', async () => {
    const project = makeProject(tmp.dir, {}, { databases: { main: { url: 'postgres://app@localhost/northfield' } } });
    await writeFiles(tmp.dir, { 'hooks/pause.sql': '{{vars.verb}} offers SET paused = true;' });
    const { ctx } = makeContext(project, { vars: { verb: 'UPDATE' }, dryRun: true });
    const journal = await Journal.open(join(tmp.dir, 'runs/r/hooks-journal.json'));
    const res = await runHooks([{ sql: 'hooks/pause.sql' }], ctx, { phase: 'setup', journal });
    expect(res.results[0]).toMatchObject({ status: 'refused' });
    expect(res.results[0].error).toMatch(/^refusing destructive hook \(hooks\/pause\.sql contains UPDATE\)/);
  });
});

describe('shellWords', () => {
  it('splits words and operators, resolving quotes', () => {
    expect(shellWords(`PGOPTIONS='-c x' psql -c "DELETE FROM \\"t\\"" && echo 'a b'|wc -l # rm -rf /`)).toEqual([
      'PGOPTIONS=-c x',
      'psql',
      '-c',
      'DELETE FROM "t"',
      '&&',
      'echo',
      'a b',
      '|',
      'wc',
      '-l',
    ]);
  });
});
