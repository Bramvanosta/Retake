/**
 * R-SBX-10: the base `<db>__retake_base` — the database before its first seed — and the
 * restores from it. Against a real Postgres (the throwaway container of test-support postgres.ts; `pnpm test:pg`),
 * skipped where none can run; the name rules and the refusal to drop someone's own database need no server.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresForTests, startPostgres } from '@retake/test-support/postgres';
import type { TestPostgres } from '@retake/test-support/postgres';
import type { LoadedSandbox } from '@retake/core';
import { BASE_COMMENT, BASE_SUFFIX, EARLIER_SNAPSHOT_SUFFIX, MAX_DATABASE_BYTES, NEXT_SUFFIX, PostgresSnapshot, SNAPSHOT_SUFFIX, parsePostgresUrl, snapshotComment, snapshotTarget } from '../src/snapshot-postgres.js';
import type { SnapshotTarget } from '../src/snapshot-postgres.js';

const PG = postgresForTests('sandbox snapshot-base.test.ts');
const DB = 'snapshot_base_app';

describe('the base: names and refusals (no server)', () => {
  const sandboxWith = (db: string) =>
    ({ env: 'sandbox', manifest: { version: 1, provider: 'docker-compose', services: {}, databases: { main: { url: `postgres://demo:pw@localhost:4528/${db}` } } } }) as unknown as LoadedSandbox;
  const project = { config: {} } as never;

  it('a database name over 50 bytes is refused: its copies would be cut at 63 and collide', async () => {
    expect(BASE_SUFFIX.length).toBe(SNAPSHOT_SUFFIX.length);
    expect(NEXT_SUFFIX.length).toBe(SNAPSHOT_SUFFIX.length);
    expect(MAX_DATABASE_BYTES + BASE_SUFFIX.length).toBe(63);
    const ok = 'a'.repeat(MAX_DATABASE_BYTES);
    await expect(snapshotTarget(project, sandboxWith(ok), async () => '')).resolves.toMatchObject({ database: ok, base: `${ok}${BASE_SUFFIX}`, template: `${ok}${SNAPSHOT_SUFFIX}` });
    await expect(snapshotTarget(project, sandboxWith(`${ok}b`), async () => '')).rejects.toThrow(/is named "a{50}b" \(51 bytes\): .*Postgres cuts names at 63 bytes — give it a name of 50 bytes or fewer/);
    // Bytes, not characters: 26 × "é" is 52 bytes.
    await expect(snapshotTarget(project, sandboxWith('é'.repeat(26)), async () => '')).rejects.toThrow(/\(52 bytes\)/);
  });

  it("a database of the base's name that is not a base is someone's own: never dropped, the base refused", async () => {
    const sent: string[] = [];
    const client = {
      query: async (sql: string) => {
        sent.push(sql);
        return sql.startsWith('SELECT pg_get_userbyid') ? { rows: [{ owner: 'u', comment: null, allow: true, template: false }] } : { rows: [] };
      },
      end: async () => undefined,
    };
    const target = { key: 'main', url: '', host: 'db.test', port: 5432, database: 'shop', template: 'shop__retake_snap', earlier: `shop${EARLIER_SNAPSHOT_SUFFIX}`, base: 'shop__retake_base' };
    const s = Object.assign(Object.create(PostgresSnapshot.prototype) as object, { target, client, version: 160000 }) as unknown as PostgresSnapshot;
    await expect(s.takeBase()).rejects.toThrow('database shop__retake_base exists and is not a base Retake took: rename or drop it');
    expect(sent.filter((q) => !q.startsWith('SELECT'))).toEqual([]);
  });
});

describe('a copy takes the place of the old one only once it is whole (no server)', () => {
  /** A snapshot whose stand-in client knows which databases exist (`dbs`) and fails the statements `fail` matches. */
  function stand(dbs: Set<string>, fail?: RegExp) {
    const sent: string[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        sent.push(sql);
        if (fail?.test(sql)) throw new Error('could not create database: disk full');
        if (sql.startsWith('SELECT pg_get_userbyid')) {
          const name = String(params?.[0]);
          return { rows: dbs.has(name) ? [{ owner: 'u', comment: null, allow: true, template: name !== 'shop' }] : [] };
        }
        const drop = /^DROP DATABASE IF EXISTS "([^"]+)"/.exec(sql);
        if (drop) dbs.delete(drop[1]);
        const create = /^CREATE DATABASE "([^"]+)"/.exec(sql);
        if (create) dbs.add(create[1]);
        const rename = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/.exec(sql);
        if (rename) {
          dbs.delete(rename[1]);
          dbs.add(rename[2]);
        }
        return { rows: [] };
      },
      end: async () => undefined,
    };
    const target = { key: 'main', url: '', host: 'db.test', port: 5432, database: 'shop', template: 'shop__retake_snap', earlier: `shop${EARLIER_SNAPSHOT_SUFFIX}`, base: 'shop__retake_base' };
    const s = Object.assign(Object.create(PostgresSnapshot.prototype) as object, { target, client, version: 160000 }) as unknown as PostgresSnapshot;
    const writes = () => sent.filter((q) => !q.startsWith('SELECT'));
    return { s, writes };
  }

  it('made as <db>__retake_next, marked (template, comment), then the old one dropped and the copy renamed over it; a leftover copy dropped first', async () => {
    const dbs = new Set(['shop', 'shop__retake_snap', 'shop__retake_next']);
    const { s, writes } = stand(dbs);
    await s.take('h2');
    expect(writes()).toEqual([
      'ALTER DATABASE "shop__retake_next" WITH IS_TEMPLATE false',
      'DROP DATABASE IF EXISTS "shop__retake_next" WITH (FORCE)',
      'ALTER DATABASE "shop" WITH ALLOW_CONNECTIONS false',
      'CREATE DATABASE "shop__retake_next" TEMPLATE "shop"',
      'ALTER DATABASE "shop" WITH ALLOW_CONNECTIONS true',
      'ALTER DATABASE "shop__retake_next" WITH ALLOW_CONNECTIONS false IS_TEMPLATE true',
      `COMMENT ON DATABASE "shop__retake_next" IS '${snapshotComment('h2')}'`,
      'ALTER DATABASE "shop__retake_snap" WITH IS_TEMPLATE false',
      'DROP DATABASE IF EXISTS "shop__retake_snap" WITH (FORCE)',
      'ALTER DATABASE "shop__retake_next" RENAME TO "shop__retake_snap"',
    ]);
    expect([...dbs].sort()).toEqual(['shop', 'shop__retake_snap']);
  });

  it('a copy that fails leaves the old template as it was (never dropped first); a base is only ever named once marked', async () => {
    const dbs = new Set(['shop', 'shop__retake_snap']);
    const { s, writes } = stand(dbs, /^CREATE DATABASE/);
    await expect(s.take('h2')).rejects.toThrow('disk full');
    expect(writes().filter((q) => q.includes('shop__retake_snap'))).toEqual([]);
    expect(dbs.has('shop__retake_snap')).toBe(true);
    // The base: its marks come before its name (an interrupted copy is a leftover __retake_next, never an unmarked base).
    const base = stand(new Set(['shop']));
    await base.s.takeBase();
    const w = base.writes();
    expect(w.indexOf(`COMMENT ON DATABASE "shop__retake_next" IS '${BASE_COMMENT}'`)).toBeLessThan(w.indexOf('ALTER DATABASE "shop__retake_next" RENAME TO "shop__retake_base"'));
    expect(w.some((q) => q.startsWith('COMMENT ON DATABASE "shop__retake_base"'))).toBe(false);
  });
});

let server: TestPostgres;
let admin: string;

async function sql(url: string, text: string): Promise<Array<Record<string, unknown>>> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    return (await c.query(text)).rows as Array<Record<string, unknown>>;
  } finally {
    await c.end();
  }
}

const app = () => admin.replace(/\/[^/?]*(\?.*)?$/, `/${DB}`);

function target(): SnapshotTarget {
  const u = new URL(app());
  const { host, port } = parsePostgresUrl(app());
  return {
    key: 'main',
    url: app(),
    host,
    port,
    database: DB,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    template: `${DB}${SNAPSHOT_SUFFIX}`,
    earlier: `${DB}${EARLIER_SNAPSHOT_SUFFIX}`,
    base: `${DB}${BASE_SUFFIX}`,
  };
}

const rows = async () => (await sql(app(), 'SELECT name FROM demo ORDER BY id')).map((r) => r.name);

describe.skipIf(!PG.ok)('the base of a snapshot sandbox (Postgres)', () => {
  beforeAll(async () => {
    server = await startPostgres();
    admin = server.url;
  }, 60_000);
  afterAll(async () => {
    await server?.stop();
  });

  beforeEach(async () => {
    const snap = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      await snap.dropTemplate();
      await snap.dropBase();
    } finally {
      await snap.close();
    }
    await sql(admin, `DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await sql(admin, `DROP ROLE IF EXISTS snapshot_base_owner`);
    await sql(admin, `CREATE ROLE snapshot_base_owner`);
    await sql(admin, `CREATE DATABASE "${DB}" OWNER snapshot_base_owner`);
    // What the services leave before the first seed: a schema (boot migrations, init scripts), no rows.
    await sql(app(), 'CREATE TABLE demo (id serial PRIMARY KEY, name text NOT NULL)');
  });

  it('the base is taken before the seed and restored with its owner, comment and no connections allowed', async () => {
    const snap = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      expect(await snap.hasBase()).toBe(false);
      const b = await snap.takeBase();
      expect(b.owner).toBe('snapshot_base_owner');
      expect(await snap.hasBase()).toBe(true);
      const row = await snap.database(target().base);
      expect(row).toMatchObject({ comment: BASE_COMMENT, allow: false, template: true });
      // The seed, then the snapshot: the base keeps the database as it was before it.
      await sql(app(), "INSERT INTO demo (name) VALUES ('Willow Street Bakery'), ('Copper Kettle Cafe')");
      await snap.take('seed-1');
      expect(await snap.templateState('seed-1')).toEqual({ present: true, valid: true });
      // A restore from the base with no owner recorded keeps the database's owner.
      await snap.restore(undefined, 'base');
      expect((await snap.database(DB))?.owner).toBe('snapshot_base_owner');
      expect((await snap.database(DB))?.allow).toBe(true);
    } finally {
      await snap.close();
    }
    expect(await rows()).toEqual([]);
  });

  it("a restore of the base drops the take's rows; the seed then makes the new snapshot without them", async () => {
    const snap = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      await snap.takeBase();
      // An additive seed (no DROP / TRUNCATE): the field case.
      const seed = "INSERT INTO demo (name) VALUES ('Willow Street Bakery'), ('Copper Kettle Cafe')";
      await sql(app(), seed);
      await snap.take('seed-1');
      // A take adds a row; then the seed changes: the reset restores the base before the seed.
      await sql(app(), "INSERT INTO demo (name) VALUES ('TAKE ROW')");
      await snap.restore('snapshot_base_owner', 'base');
      await sql(app(), seed);
      await snap.take('seed-2');
      expect(await rows()).toEqual(['Willow Street Bakery', 'Copper Kettle Cafe']);
      // A take again, then the next reset restores the new snapshot: exactly the seed's rows.
      await sql(app(), "INSERT INTO demo (name) VALUES ('TAKE ROW')");
      await snap.restore('snapshot_base_owner');
      // A second takeBase replaces the base only when it is ours (the comment): it is.
      expect(await snap.hasBase()).toBe(true);
    } finally {
      await snap.close();
    }
    expect(await rows()).toEqual(['Willow Street Bakery', 'Copper Kettle Cafe']);
  });

  it('a take that cannot make its copy leaves the old snapshot whole: it is still restored', async () => {
    await sql(admin, 'DROP ROLE IF EXISTS snapshot_base_nocreate');
    await sql(admin, "CREATE ROLE snapshot_base_nocreate LOGIN CREATEDB PASSWORD 'nocreate-pw'");
    await sql(admin, `ALTER DATABASE "${DB}" OWNER TO snapshot_base_nocreate`);
    const u = new URL(app());
    u.username = 'snapshot_base_nocreate';
    u.password = 'nocreate-pw';
    const as = { ...target(), url: u.toString(), user: 'snapshot_base_nocreate', password: 'nocreate-pw' };
    await sql(app(), "INSERT INTO demo (name) VALUES ('Willow Street Bakery')");
    const snap = await PostgresSnapshot.open(as, 'sandbox');
    try {
      await snap.take('seed-1');
      // The role can no longer create databases: the next copy fails at its CREATE.
      await sql(admin, 'ALTER ROLE snapshot_base_nocreate NOCREATEDB');
      await sql(app(), "INSERT INTO demo (name) VALUES ('TAKE ROW')");
      await expect(snap.take('seed-2')).rejects.toThrow(/permission denied/);
      expect(await snap.templateState('seed-1')).toEqual({ present: true, valid: true });
    } finally {
      await snap.close();
    }
    await sql(admin, 'ALTER ROLE snapshot_base_nocreate CREATEDB');
    const admin2 = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      await admin2.restore(undefined);
    } finally {
      await admin2.close();
    }
    expect(await rows()).toEqual(['Willow Street Bakery']);
    await sql(admin, `ALTER DATABASE "${DB}" OWNER TO snapshot_base_owner`);
    await sql(admin, `ALTER DATABASE "${DB}${SNAPSHOT_SUFFIX}" OWNER TO snapshot_base_owner`);
  });

  it('isEmpty: a missing database or one with no relation of its own is empty; a table makes it not', async () => {
    const snap = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      expect(await snap.isEmpty()).toBe(false); // beforeEach made table demo
      await sql(app(), 'DROP TABLE demo');
      expect(await snap.isEmpty()).toBe(true);
      await sql(app(), 'CREATE SCHEMA app; CREATE SEQUENCE app.counter');
      expect(await snap.isEmpty()).toBe(false);
      await sql(admin, `DROP DATABASE "${DB}" WITH (FORCE)`);
      expect(await snap.isEmpty()).toBe(true);
    } finally {
      await snap.close();
    }
    await sql(admin, `CREATE DATABASE "${DB}" OWNER snapshot_base_owner`);
  });
});
