/**
 * A Postgres snapshot blocks connections to the app's database while it copies it, then lets them in again. When
 * letting them in fails after a copy that worked, the take fails saying so (the app would otherwise meet a database
 * that refuses it on camera); after a copy that failed, the copy's own error is the one thrown. No server needed: the
 * maintenance connection is a stand-in that answers each statement.
 */
import { describe, expect, it } from 'vitest';
import { PostgresSnapshot, SandboxError } from '../src/index.js';

const TARGET = { key: 'app', url: 'postgres://u@db.test/shop', host: 'db.test', port: 5432, user: 'u', database: 'shop', template: 'shop__ds_snapshot' };

/** A snapshot whose client answers `sql` with `answer` (a thrown error for a refused statement), the statements kept. */
function snapshot(answer: (sql: string) => unknown) {
  const sent: string[] = [];
  const client = {
    query: async (sql: string) => {
      sent.push(sql);
      const r = answer(sql);
      if (r instanceof Error) throw r;
      return r ?? { rows: [] };
    },
    end: async () => undefined,
  };
  const s = Object.assign(Object.create(PostgresSnapshot.prototype) as object, { target: TARGET, client, version: 160000 }) as unknown as PostgresSnapshot;
  return { s, sent };
}

const DB = { rows: [{ owner: 'u', comment: null, allow: true, template: false }] };
const reopen = 'ALTER DATABASE "shop" WITH ALLOW_CONNECTIONS true';

describe('a snapshot take lets connections in again', () => {
  it('after a copy that worked, a failure to let them in fails the take, naming the database', async () => {
    const { s, sent } = snapshot((sql) => (sql.startsWith('SELECT pg_get_userbyid') ? (sent.length === 1 ? DB : { rows: [] }) : sql === reopen ? new Error('permission denied') : undefined));
    const e = await s.take('h').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SandboxError);
    expect((e as Error).message).toBe('database shop was left refusing connections after its snapshot (permission denied): the next reset lets them in again');
    expect(sent).toContain(reopen);
    expect(sent.some((q) => q.startsWith('COMMENT ON DATABASE'))).toBe(false);
  });

  it("after a copy that failed, the copy's error is thrown (the next reset repairs the database first)", async () => {
    const { s, sent } = snapshot((sql) =>
      sql.startsWith('SELECT pg_get_userbyid')
        ? sent.length === 1
          ? DB
          : { rows: [] }
        : sql.startsWith('CREATE DATABASE')
          ? new Error('disk full')
          : sql === reopen
            ? new Error('permission denied')
            : undefined,
    );
    await expect(s.take('h')).rejects.toThrow('disk full');
    expect(sent).toContain(reopen);
  });

  it('when both work, the template is marked and the owner returned', async () => {
    const { s, sent } = snapshot((sql) => (sql.startsWith('SELECT pg_get_userbyid') ? (sent.length === 1 ? DB : { rows: [] }) : undefined));
    expect(await s.take('h')).toMatchObject({ owner: 'u' });
    expect(sent.indexOf(reopen)).toBeLessThan(sent.findIndex((q) => q.startsWith('COMMENT ON DATABASE')));
  });
});
