import { describe, expect, it } from 'vitest';
import { destructiveReason, shellDestructiveCommand, sqlDestructiveKeyword } from '@retake/core';

describe('destructive hook detection', () => {
  it('SQL statements, not clauses, comments or literals', () => {
    expect(sqlDestructiveKeyword('delete from offers')).toBe('DELETE');
    expect(sqlDestructiveKeyword('BEGIN; drop table x; COMMIT;')).toBe('DROP');
    expect(sqlDestructiveKeyword('INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2')).toBe('UPDATE');
    expect(sqlDestructiveKeyword('ALTER TABLE t ADD COLUMN c int')).toBe('ALTER');
    expect(sqlDestructiveKeyword('CREATE TABLE t (id int REFERENCES u ON DELETE CASCADE ON UPDATE CASCADE)')).toBeNull();
    expect(sqlDestructiveKeyword('SELECT * FROM t FOR UPDATE')).toBeNull();
    expect(sqlDestructiveKeyword("-- DELETE old rows\nINSERT INTO log VALUES ('UPDATE later') /* DROP */")).toBeNull();
    expect(sqlDestructiveKeyword('SELECT "delete" FROM t')).toBeNull();
  });

  it('shell commands', () => {
    expect(shellDestructiveCommand('rm -rf tmp')).toBe('rm');
    expect(shellDestructiveCommand('cd x && rm file')).toBe('rm');
    expect(shellDestructiveCommand('dropdb demo')).toBe('dropdb');
    expect(shellDestructiveCommand('npm run format')).toBeNull();
    expect(shellDestructiveCommand('echo firm')).toBeNull();
    expect(shellDestructiveCommand('/bin/rm -f out.log')).toBe('rm');
    expect(shellDestructiveCommand('bash -c "cd tmp && rm -rf cache"')).toBe('rm');
    expect(shellDestructiveCommand('npm run seed # then rm the dump by hand')).toBeNull();
    expect(shellDestructiveCommand("echo 'rm -rf /'")).toBeNull();
  });

  it('destructive SQL sent to psql (validation flags what the hook runner refuses)', () => {
    expect(destructiveReason({ shell: 'psql "$DATABASE_URL" -c "DELETE FROM offers"' })).toBe('psql -c DELETE');
    expect(destructiveReason({ shell: { run: "psql -Atc 'truncate imports' demo" } })).toBe('psql -c TRUNCATE');
    expect(destructiveReason({ shell: "psql demo <<'SQL'\nUPDATE offers SET paused = true;\nSQL" })).toBe('psql heredoc UPDATE');
    expect(destructiveReason({ shell: 'echo "DROP TABLE t" | psql demo' })).toBe('SQL piped to psql: DROP');
    expect(destructiveReason({ shell: 'psql -f hooks/clean.sql' }, { projectDir: '/p', readText: () => 'DELETE FROM t;' })).toBe(
      'psql -f hooks/clean.sql contains DELETE',
    );
    expect(destructiveReason({ shell: 'psql -c "SELECT count(*) FROM offers"' })).toBeNull();
  });

  it('hooks', () => {
    expect(destructiveReason({ http: { method: 'DELETE', url: '/x' } })).toBe('HTTP DELETE');
    expect(destructiveReason({ http: { method: 'POST', url: '/x' } })).toBeNull();
    expect(destructiveReason({ sql: 'TRUNCATE offers' })).toBe('SQL TRUNCATE');
    expect(destructiveReason({ sql: { query: 'select 1' } })).toBeNull();
    expect(destructiveReason({ js: 'localStorage.clear()', destructive: true })).toBe('declared destructive');
    expect(
      destructiveReason({ sql: 'hooks/reset.sql' }, { projectDir: '/p', readText: () => 'DELETE FROM t' }),
    ).toBe('hooks/reset.sql contains DELETE');
    expect(destructiveReason({ sql: 'hooks/reset.sql' })).toBeNull();
  });
});
