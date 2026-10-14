/**
 * Postgres snapshot resets (L1.8, strategy `snapshot`): after the seed, the sandbox's database is copied as a template
 * database `<db>__ds_snapshot`; before each take the database is dropped and created again from that template — a
 * file-level copy, faster than reseeding once the seed is realistic. SQL only, through `pg` (no pg_dump needed on the
 * host). The template's comment `demo-studio snapshot <seed hash>` (and the state file) say which seed it holds: any
 * other is stale and retaken. Postgres 13 or later (DROP DATABASE … WITH (FORCE)); STRATEGY is left to the server
 * (WAL_LOG from 15, FILE_COPY before). The caller has checked the database belongs to the sandbox's own compose project.
 *
 *   take:    ALTER DATABASE app WITH ALLOW_CONNECTIONS false; terminate its backends;
 *            (retake) ALTER DATABASE app__ds_snapshot IS_TEMPLATE false; DROP DATABASE IF EXISTS app__ds_snapshot;
 *            CREATE DATABASE app__ds_snapshot TEMPLATE app; ALTER DATABASE app WITH ALLOW_CONNECTIONS true;
 *            ALTER DATABASE app__ds_snapshot WITH ALLOW_CONNECTIONS false IS_TEMPLATE true; COMMENT ON DATABASE …
 *   restore: ALTER DATABASE app WITH ALLOW_CONNECTIONS false; DROP DATABASE IF EXISTS app WITH (FORCE);
 *            CREATE DATABASE app TEMPLATE app__ds_snapshot OWNER <owner at take>
 *
 * Every reset first repairs ALLOW_CONNECTIONS (a take or restore interrupted after blocking connections). Nothing
 * between DROP and CREATE looks at the abort signal: an interrupt lets the CREATE finish. One query per statement
 * (CREATE DATABASE cannot run inside a multi-statement query).
 *
 * Where it connects is read with pg's own parser (hooks databaseTarget) and must be what the URL names — a loopback
 * host and port, no unix socket, no `?host=` / `?port=` (sandboxDatabaseProblem) —; pg is then given that host and
 * port explicitly, never the URL (whose query parameters would win over them).
 */
import pg from 'pg';
import { interpolateDeep, prefetchSecrets } from '@demo-studio/core';
import type { LoadedProject, LoadedSandbox } from '@demo-studio/core';
import { databaseTarget, sandboxDatabaseProblem } from '@demo-studio/hooks';
import { SandboxError, errorMessage } from './errors.js';

/** Suffix of the template database (`<db>__ds_snapshot`). */
export const SNAPSHOT_SUFFIX = '__ds_snapshot';
/** server_version_num of Postgres 13 (DROP DATABASE … WITH (FORCE)). */
export const MIN_PG_VERSION_NUM = 130_000;
const CONNECT_TIMEOUT_MS = 10_000;
const APPLICATION_NAME = 'demo-studio-sandbox';

/** "app" → `"app"` (a Postgres identifier, quotes doubled). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A string literal (single quotes doubled). */
export function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** The template's comment: which seed it holds. */
export function snapshotComment(hash: string): string {
  return `demo-studio snapshot ${hash}`;
}

/** Where pg connects: given to it explicitly (never a URL whose query parameters could send it elsewhere). */
export interface PgEndpoint {
  host: string;
  port: number;
  database: string;
  user?: string;
  /** Never printed. */
  password?: string;
}

/** What a snapshot reset works on. */
export interface SnapshotTarget extends PgEndpoint {
  /** Key of `databases`. */
  key: string;
  /** The URL, secrets resolved (never printed). */
  url: string;
  /** The database dropped and recreated at each take. */
  database: string;
  /** `<database>__ds_snapshot`. */
  template: string;
}

/** What the state file keeps of the snapshot (provider_state.snapshot). */
export interface SnapshotState {
  key: string;
  database: string;
  template: string;
  /** The seed hash it was taken from. */
  hash: string;
  /** Owner of the database at the take: the database is recreated with it. */
  owner: string;
  taken_at: string;
  ms: number;
}

/** A Postgres URL with its secrets resolved ({{env:…}} / {{keychain:…}} in the password). */
export async function resolveDatabaseUrl(project: Pick<LoadedProject, 'config'>, url: string): Promise<string> {
  const { resolver } = await prefetchSecrets(url);
  return interpolateDeep(url, { vars: project.config.vars ?? {}, secrets: resolver });
}

/** host, port and database of a Postgres URL, as written (messages; pgEndpoint says where pg connects). */
export function parsePostgresUrl(url: string): { host: string; port: number; database: string } {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return { host, port: Number(u.port || 5432), database: decodeURIComponent(u.pathname.replace(/^\//, '')) };
}

/**
 * Where pg connects for a sandbox database URL (secrets resolved), read with pg's own parser. Throws SandboxError when
 * that is not the loopback host and port the URL names (a unix socket, `?host=`, `?port=`): validation refuses those,
 * this is the last line before a DROP DATABASE.
 */
export function pgEndpoint(url: string, what: string): PgEndpoint {
  const problem = sandboxDatabaseProblem(url);
  if (problem) throw new SandboxError(`${what}: ${problem}`);
  const t = databaseTarget(url);
  return { host: t.host.replace(/^\[|\]$/g, ''), port: t.port, database: t.database ?? '', ...(t.user ? { user: t.user } : {}), ...(t.password ? { password: t.password } : {}) };
}

/** "app on localhost:4601". */
export function describeDatabase(t: Pick<SnapshotTarget, 'database' | 'host' | 'port'>): string {
  return `${t.database} on ${t.host}:${t.port}`;
}

/** The database a snapshot reset works on: `reset.snapshot.database` (a key of `databases`), default the first. */
export async function snapshotTarget(project: Pick<LoadedProject, 'config'>, sandbox: Pick<LoadedSandbox, 'env' | 'manifest'>): Promise<SnapshotTarget> {
  const dbs = sandbox.manifest.databases ?? {};
  const key = sandbox.manifest.reset?.snapshot?.database ?? Object.keys(dbs)[0];
  if (key === undefined || !Object.hasOwn(dbs, key)) {
    throw new SandboxError(`sandbox ${sandbox.env}: a snapshot reset needs a Postgres database in sandbox.yaml \`databases\``);
  }
  const url = await resolveDatabaseUrl(project, dbs[key].url);
  const endpoint = pgEndpoint(url, `sandbox ${sandbox.env}: database ${key}`);
  if (!endpoint.database) throw new SandboxError(`sandbox ${sandbox.env}: database ${key}: its URL names no database (postgres://…/<db>)`);
  if (['postgres', 'template0', 'template1'].includes(endpoint.database.toLowerCase())) {
    throw new SandboxError(`sandbox ${sandbox.env}: database ${key} is "${endpoint.database}": a snapshot reset drops and recreates its database — give the sandbox a database of its own`);
  }
  return { key, url, ...endpoint, template: `${endpoint.database}${SNAPSHOT_SUFFIX}` };
}

async function connect(endpoint: PgEndpoint): Promise<pg.Client> {
  const { host, port, database, user, password } = endpoint;
  const client = new pg.Client({ host, port, database, user, password, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: APPLICATION_NAME });
  // Errors also reject the pending query; this only keeps a dropped connection from crashing the process.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (e) {
    await client.end().catch(() => undefined);
    throw e;
  }
  return client;
}

/** SQLSTATEs of a server that answers about a database it cannot open: 3D000 it does not exist, 55000 it allows no connections. */
const SERVER_ANSWERS = new Set(['3D000', '55000']);

/**
 * One `SELECT 1` on a database: null when it answers, else why not. A database that does not exist (the seed creates
 * it, or an interrupted restore dropped it) or allows no connections (an interrupted reset) counts as ready: its server
 * answers, and the next reset repairs it.
 */
export async function pgAnswers(endpoint: PgEndpoint): Promise<string | null> {
  let client: pg.Client | null = null;
  try {
    client = await connect(endpoint);
    await client.query('SELECT 1');
    return null;
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code && SERVER_ANSWERS.has(err.code)) return null;
    return err.code === 'ECONNREFUSED' ? 'connection refused' : errorMessage(e);
  } finally {
    await client?.end().catch(() => undefined);
  }
}

interface DatabaseRow {
  owner: string;
  comment: string | null;
  allow: boolean;
  template: boolean;
}

/** A maintenance connection (database `postgres`, else `template1`) to the server of a snapshot target. */
export class PostgresSnapshot {
  private constructor(
    readonly target: SnapshotTarget,
    private readonly client: pg.Client,
    /** server_version_num. */
    readonly version: number,
  ) {}

  /** Connect and check the server (Postgres 13 or later). Throws SandboxError. */
  static async open(target: SnapshotTarget, env: string): Promise<PostgresSnapshot> {
    let client: pg.Client | null = null;
    let last: unknown;
    for (const db of ['postgres', 'template1']) {
      try {
        client = await connect({ ...target, database: db });
        break;
      } catch (e) {
        last = e;
        if ((e as { code?: string }).code !== '3D000') break; // only "database does not exist" tries the next one
      }
    }
    if (!client) throw new SandboxError(`sandbox ${env}: cannot connect to the Postgres server of database ${target.key} (${target.host}:${target.port}) for its snapshot: ${errorMessage(last)}`);
    const v = Number((await client.query('SHOW server_version_num')).rows[0]?.server_version_num ?? 0);
    if (v < MIN_PG_VERSION_NUM) {
      await client.end().catch(() => undefined);
      throw new SandboxError(`sandbox ${env}: snapshot resets need Postgres 13 or later (database ${target.key} runs ${Math.floor(v / 10_000)}): use strategy reseed`);
    }
    return new PostgresSnapshot(target, client, v);
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }

  private q(sql: string, params?: unknown[]) {
    return this.client.query(sql, params as never);
  }

  /** A database's owner, comment and flags; null when it does not exist. */
  async database(name: string): Promise<DatabaseRow | null> {
    const r = await this.q(
      `SELECT pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS comment, datallowconn AS allow, datistemplate AS template FROM pg_database WHERE datname = $1`,
      [name],
    );
    return (r.rows[0] as DatabaseRow | undefined) ?? null;
  }

  /**
   * Why the database cannot serve the app now (an interrupted reset: dropped, or connections blocked), or null. `up`
   * resets a sandbox in that state even when its seed is current.
   */
  async broken(): Promise<string | null> {
    const db = await this.database(this.target.database);
    if (!db) return `database ${this.target.database} is missing (an interrupted restore)`;
    return db.allow ? null : `database ${this.target.database} accepts no connections (an interrupted reset)`;
  }

  /** Let connections in again (a take or restore interrupted after blocking them). Run at the start of every reset. */
  async repair(): Promise<boolean> {
    const db = await this.database(this.target.database);
    if (!db || db.allow) return false;
    await this.q(`ALTER DATABASE ${quoteIdent(this.target.database)} WITH ALLOW_CONNECTIONS true`);
    return true;
  }

  /** The template holds this seed. */
  async valid(hash: string): Promise<boolean> {
    const t = await this.database(this.target.template);
    return !!t && t.template && t.comment === snapshotComment(hash);
  }

  /** The database exists (an interrupted restore may have dropped it); created empty with `owner` if not. */
  async ensureDatabase(owner?: string): Promise<boolean> {
    if (await this.database(this.target.database)) return false;
    await this.q(`CREATE DATABASE ${quoteIdent(this.target.database)}${owner ? ` OWNER ${quoteIdent(owner)}` : ''}`);
    return true;
  }

  /** Copy the database (just seeded) as the template. */
  async take(hash: string): Promise<{ owner: string; ms: number }> {
    const t0 = Date.now();
    const { database, template } = this.target;
    const db = await this.database(database);
    if (!db) throw new SandboxError(`database ${database} does not exist after the seed: nothing to snapshot`);
    const app = quoteIdent(database);
    const tpl = quoteIdent(template);
    await this.q(`ALTER DATABASE ${app} WITH ALLOW_CONNECTIONS false`);
    try {
      // The app's pool cannot reconnect while it is copied; the copy needs no other session on it.
      await this.q(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [database]);
      if (await this.database(template)) {
        await this.q(`ALTER DATABASE ${tpl} WITH IS_TEMPLATE false`);
        await this.q(`DROP DATABASE IF EXISTS ${tpl} WITH (FORCE)`);
      }
      await this.q(`CREATE DATABASE ${tpl} TEMPLATE ${app}`);
    } finally {
      await this.q(`ALTER DATABASE ${app} WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
    }
    await this.q(`ALTER DATABASE ${tpl} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`);
    await this.q(`COMMENT ON DATABASE ${tpl} IS ${quoteLiteral(snapshotComment(hash))}`);
    return { owner: db.owner, ms: Date.now() - t0 };
  }

  /** Drop the database and create it again from the template (sessions on it are terminated). */
  async restore(owner: string): Promise<{ ms: number }> {
    const t0 = Date.now();
    const app = quoteIdent(this.target.database);
    if (await this.database(this.target.database)) await this.q(`ALTER DATABASE ${app} WITH ALLOW_CONNECTIONS false`);
    // From here to CREATE nothing checks the abort signal: an interrupt lets the database come back.
    await this.q(`DROP DATABASE IF EXISTS ${app} WITH (FORCE)`);
    await this.q(`CREATE DATABASE ${app} TEMPLATE ${quoteIdent(this.target.template)} OWNER ${quoteIdent(owner)}`);
    return { ms: Date.now() - t0 };
  }

  /** Remove the template (tests, a stale one). */
  async dropTemplate(): Promise<void> {
    if (!(await this.database(this.target.template))) return;
    await this.q(`ALTER DATABASE ${quoteIdent(this.target.template)} WITH IS_TEMPLATE false`);
    await this.q(`DROP DATABASE IF EXISTS ${quoteIdent(this.target.template)} WITH (FORCE)`);
  }
}
