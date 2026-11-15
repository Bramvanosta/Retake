/**
 * A sandbox's Postgres snapshot taken before the template database took its present name (`<db>` +
 * SNAPSHOT_SUFFIX) is still restored: the next reset renames the earlier template (its comment, so its seed hash,
 * goes with it), or drops it when a template under the present name exists. Against a real Postgres (the throwaway
 * container of test-support postgres.ts; `pnpm test:pg`), skipped where none can run.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresForTests, startPostgres } from '@retake/test-support/postgres';
import type { TestPostgres } from '@retake/test-support/postgres';
import { EARLIER_SNAPSHOT_SUFFIX, PostgresSnapshot, SNAPSHOT_SUFFIX, parsePostgresUrl, snapshotComment } from '../src/snapshot-postgres.js';
import type { SnapshotTarget } from '../src/snapshot-postgres.js';

const PG = postgresForTests('sandbox snapshot-earlier-name.test.ts');
const DB = 'snapshot_earlier_app';

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
const databases = async () => (await sql(admin, `SELECT datname AS n FROM pg_database WHERE datname LIKE '${DB}%' ORDER BY 1`)).map((r) => r.n);

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
  };
}

/** A template under the earlier name, made the way the snapshot was taken before (seeded data, the seed's comment). */
async function earlierSnapshot(hash: string): Promise<void> {
  const old = `"${DB}${EARLIER_SNAPSHOT_SUFFIX}"`;
  await sql(admin, `CREATE DATABASE ${old} TEMPLATE "${DB}"`);
  await sql(admin, `ALTER DATABASE ${old} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`);
  await sql(admin, `COMMENT ON DATABASE ${old} IS '${snapshotComment(hash)}'`);
}

describe.skipIf(!PG.ok)('a snapshot under its earlier name (Postgres)', () => {
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
    } finally {
      await snap.close();
    }
    await sql(admin, `DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await sql(admin, `CREATE DATABASE "${DB}"`);
    await sql(app(), 'CREATE TABLE t (n int); INSERT INTO t VALUES (1), (2), (3)');
  });

  it('is renamed to the present name, its seed kept, and restores the seeded data', async () => {
    await earlierSnapshot('seed-1');
    await sql(app(), 'DELETE FROM t');
    const snap = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      expect(await snap.valid('seed-1')).toBe(false);
      expect(await snap.adoptEarlier()).toBe('renamed');
      expect(await databases()).toEqual([DB, `${DB}${SNAPSHOT_SUFFIX}`]);
      expect(await snap.valid('seed-1')).toBe(true);
      await snap.restore((await snap.database(DB))!.owner);
    } finally {
      await snap.close();
    }
    expect(await sql(app(), 'SELECT count(*)::int AS n FROM t')).toEqual([{ n: 3 }]);
  });

  it('is dropped when a template under the present name exists; a second call does nothing', async () => {
    await earlierSnapshot('seed-old');
    const snap = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      await snap.take('seed-new');
      expect(await snap.adoptEarlier()).toBe('dropped');
      expect(await databases()).toEqual([DB, `${DB}${SNAPSHOT_SUFFIX}`]);
      expect(await snap.valid('seed-new')).toBe(true);
      expect(await snap.adoptEarlier()).toBeNull();
    } finally {
      await snap.close();
    }
  });

  it('a database of the earlier name that is no template is no snapshot: neither moved nor dropped', async () => {
    const own = `"${DB}${EARLIER_SNAPSHOT_SUFFIX}"`;
    await sql(admin, `CREATE DATABASE ${own}`);
    const snap = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      expect(await snap.adoptEarlier()).toBeNull();
      await snap.dropTemplate();
      expect(await databases()).toEqual([DB, `${DB}${EARLIER_SNAPSHOT_SUFFIX}`]);
    } finally {
      await snap.close();
    }
    await sql(admin, `DROP DATABASE ${own}`);
  });

  it('a snapshot is only ever made under the present name; dropTemplate removes both', async () => {
    const snap = await PostgresSnapshot.open(target(), 'sandbox');
    try {
      await snap.take('h');
      expect(await databases()).toEqual([DB, `${DB}${SNAPSHOT_SUFFIX}`]);
      await earlierSnapshot('h');
      await snap.dropTemplate();
      expect(await databases()).toEqual([DB]);
    } finally {
      await snap.close();
    }
  });
});
