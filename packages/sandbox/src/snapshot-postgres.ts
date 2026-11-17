/**
 * Postgres snapshot resets (strategy `snapshot`): after the seed, the sandbox's database is copied as a template
 * database `<db>__retake_snap`; before each take the database is dropped and created again from that template — a
 * file-level copy, faster than reseeding once the seed is realistic. SQL only, through `pg` (no pg_dump needed on the
 * host). The template's comment `retake snapshot <seed hash>` (and the state file) say which seed it holds: any
 * other is stale and retaken. Postgres 13 or later (DROP DATABASE … WITH (FORCE)); STRATEGY is left to the server
 * (WAL_LOG from 15, FILE_COPY before). The caller has checked the database belongs to the sandbox's own compose project.
 *
 *   take:    ALTER DATABASE app WITH ALLOW_CONNECTIONS false; terminate its backends;
 *            (retake) ALTER DATABASE app__retake_snap IS_TEMPLATE false; DROP DATABASE IF EXISTS app__retake_snap;
 *            CREATE DATABASE app__retake_snap TEMPLATE app; ALTER DATABASE app WITH ALLOW_CONNECTIONS true;
 *            ALTER DATABASE app__retake_snap WITH ALLOW_CONNECTIONS false IS_TEMPLATE true; COMMENT ON DATABASE …
 *   restore: ALTER DATABASE app WITH ALLOW_CONNECTIONS false; DROP DATABASE IF EXISTS app WITH (FORCE);
 *            CREATE DATABASE app TEMPLATE app__retake_snap OWNER <owner at take>
 *
 * A template under its earlier name (`<db>` + EARLIER_SNAPSHOT_SUFFIX, a sandbox's snapshot taken before the name
 * changed) is renamed to the present one at the next reset or snapshot (`adoptEarlier`), comment and seed kept; when
 * both exist, the earlier one is dropped. A template is only ever looked for under these two names.
 *
 * R-SBX-10: the base `<db>__retake_base` (comment `retake base`) is the database as the
 * services leave it right before its first seed — taken only when Retake never touched that database's data —, never
 * taken again from a seeded one. When the snapshot is outdated, the reset restores the base (else the outdated
 * snapshot) before it seeds again: a seed never runs on a take's data (sandbox reset-plan.ts).
 *
 *   base:    as take, into app__retake_base with the comment 'retake base' (before the first seed)
 *   each copy is made as app__retake_next, marked, then renamed over the old one (a failed copy keeps the old)
 *   restore: as above, from app__retake_base (an outdated snapshot), then the seed and a new snapshot
 *
 * Postgres cuts identifiers at 63 bytes: a database name over MAX_DATABASE_BYTES is refused (its templates' names
 * would be cut, then collide).
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
import { interpolateDeep } from '@retake/core/base';
import { prefetchSecrets } from '@retake/core/io';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedSandbox } from '@retake/core/sandbox';
import { databaseTarget, sandboxDatabaseProblem } from '@retake/hooks/db-url';
import { SandboxError, errorMessage } from './errors.js';

/** Suffix of the template database (`<db>__retake_snap`): as long as the earlier one, so the same names fit. */
export const SNAPSHOT_SUFFIX = '__retake_snap';
/** The template's suffix before it took its present name: read at a reset, renamed to SNAPSHOT_SUFFIX, never made. */
export const EARLIER_SNAPSHOT_SUFFIX = '__ds_snapshot'; // old-name: the template's name in sandboxes made before
/** Suffix of the base (`<db>__retake_base`): the database before its first seed. Same length as SNAPSHOT_SUFFIX. */
export const BASE_SUFFIX = '__retake_base';
/** Suffix of a copy being made (copyAs): renamed to its template's name once marked. Same length as SNAPSHOT_SUFFIX. */
export const NEXT_SUFFIX = '__retake_next';
/** The base's comment. */
export const BASE_COMMENT = 'retake base';
/** Longest database name a snapshot reset takes: its templates' names (+13 bytes) must fit Postgres's 63. */
export const MAX_DATABASE_BYTES = 50;
/** server_version_num of Postgres 13 (DROP DATABASE … WITH (FORCE)). */
export const MIN_PG_VERSION_NUM = 130_000;
const CONNECT_TIMEOUT_MS = 10_000;
const APPLICATION_NAME = 'retake-sandbox';

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
  return `retake snapshot ${hash}`;
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
  /** `<database>` + SNAPSHOT_SUFFIX. */
  template: string;
  /** `<database>` + EARLIER_SNAPSHOT_SUFFIX: the template's earlier name, adopted (adoptEarlier) or dropped. */
  earlier: string;
  /** `<database>` + BASE_SUFFIX: the database before its first seed. */
  base: string;
}

/** What the state file keeps of the base (provider_state.base). */
export interface BaseState {
  /** The database it is the base of. */
  database: string;
  /** Owner of the database when the base was taken. */
  owner: string;
  taken_at: string;
  ms: number;
}

/** The template now: there at all, and holding this seed. */
export interface TemplateState {
  present: boolean;
  valid: boolean;
}

/**
 * What a reset does with the sandbox's Postgres (PostgresSnapshot; a test hands the Sandbox a fake one to see the order
 * of the calls without a database).
 */
export interface SnapshotPort {
  readonly target: SnapshotTarget;
  close(): Promise<void>;
  /**
   * The server's cluster: its system identifier, made by initdb (`pg_control_system()`, readable by any role) — another
   * one means the data folder was made again (in memory, the container's own layer, a volume removed). null when it
   * cannot be read.
   */
  clusterId(): Promise<string | null>;
  broken(): Promise<string | null>;
  repair(): Promise<boolean>;
  adoptEarlier(): Promise<'renamed' | 'dropped' | null>;
  /** The template under its present name (`earlier`: or under its earlier one, for a status that renames nothing). */
  templateState(hash: string, opts?: { earlier?: boolean }): Promise<TemplateState>;
  /** The base of this database is there (a template with the base's comment). */
  hasBase(): Promise<boolean>;
  ensureDatabase(owner?: string): Promise<boolean>;
  /** Copy the database (not seeded yet) as the base. */
  takeBase(): Promise<{ owner: string; ms: number }>;
  /** The database holds no relation of its own (missing, or nothing outside the system schemas). */
  isEmpty(): Promise<boolean>;
  /** Copy the database (just seeded) as the template. */
  take(hash: string): Promise<{ owner: string; ms: number }>;
  /** Drop the database and create it again from the template (`from: 'base'`: from the base), owned by `owner` (else its owner now). */
  restore(owner: string | undefined, from?: 'snapshot' | 'base'): Promise<{ ms: number }>;
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
export async function resolveDatabaseUrl(project: Pick<LoadedProject, 'config'>, url: string, resolveSecret: (ref: string) => Promise<string>): Promise<string> {
  const { resolver } = await prefetchSecrets(url, resolveSecret);
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
export async function snapshotTarget(
  project: Pick<LoadedProject, 'config'>,
  sandbox: Pick<LoadedSandbox, 'env' | 'manifest'>,
  resolveSecret: (ref: string) => Promise<string>,
): Promise<SnapshotTarget> {
  const dbs = sandbox.manifest.databases ?? {};
  const key = sandbox.manifest.reset?.snapshot?.database ?? Object.keys(dbs)[0];
  if (key === undefined || !Object.hasOwn(dbs, key)) {
    throw new SandboxError(`sandbox ${sandbox.env}: a snapshot reset needs a Postgres database in sandbox.yaml \`databases\``);
  }
  const url = await resolveDatabaseUrl(project, dbs[key].url, resolveSecret);
  const endpoint = pgEndpoint(url, `sandbox ${sandbox.env}: database ${key}`);
  if (!endpoint.database) throw new SandboxError(`sandbox ${sandbox.env}: database ${key}: its URL names no database (postgres://…/<db>)`);
  const bytes = Buffer.byteLength(endpoint.database, 'utf8');
  if (bytes > MAX_DATABASE_BYTES) {
    throw new SandboxError(
      `sandbox ${sandbox.env}: database ${key} is named "${endpoint.database}" (${bytes} bytes): a snapshot reset keeps copies named <database>${SNAPSHOT_SUFFIX}, <database>${BASE_SUFFIX} and <database>${NEXT_SUFFIX}, and Postgres cuts names at 63 bytes — give it a name of ${MAX_DATABASE_BYTES} bytes or fewer`,
    );
  }
  if (['postgres', 'template0', 'template1'].includes(endpoint.database.toLowerCase())) {
    throw new SandboxError(`sandbox ${sandbox.env}: database ${key} is "${endpoint.database}": a snapshot reset drops and recreates its database — give the sandbox a database of its own`);
  }
  return {
    key,
    url,
    ...endpoint,
    template: `${endpoint.database}${SNAPSHOT_SUFFIX}`,
    earlier: `${endpoint.database}${EARLIER_SNAPSHOT_SUFFIX}`,
    base: `${endpoint.database}${BASE_SUFFIX}`,
  };
}

async function connect(endpoint: PgEndpoint, timeoutMs = CONNECT_TIMEOUT_MS): Promise<pg.Client> {
  const { host, port, database, user, password } = endpoint;
  const client = new pg.Client({ host, port, database, user, password, connectionTimeoutMillis: timeoutMs, application_name: APPLICATION_NAME });
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
export class PostgresSnapshot implements SnapshotPort {
  private constructor(
    readonly target: SnapshotTarget,
    private readonly client: pg.Client,
    /** server_version_num. */
    readonly version: number,
  ) {}

  /** Connect and check the server (Postgres 13 or later). Throws SandboxError. `timeoutMs`: of the connection (a status waits less). */
  static async open(target: SnapshotTarget, env: string, opts: { timeoutMs?: number } = {}): Promise<PostgresSnapshot> {
    let client: pg.Client | null = null;
    let last: unknown;
    for (const db of ['postgres', 'template1']) {
      try {
        client = await connect({ ...target, database: db }, opts.timeoutMs);
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

  async clusterId(): Promise<string | null> {
    try {
      const r = await this.q('SELECT system_identifier::text AS id FROM pg_control_system()');
      const id = (r.rows[0] as { id?: string } | undefined)?.id;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
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

  /**
   * The template under its earlier name moved to its present one (a snapshot of a sandbox made before the name
   * changed): renamed when the present one is missing (its comment, so its seed hash, goes with it), dropped when both
   * exist. Run at the start of every reset, before the template is looked at; says what it did (null: nothing).
   */
  async adoptEarlier(): Promise<'renamed' | 'dropped' | null> {
    const { template, earlier } = this.target;
    // Only a snapshot is moved: a database of that name that is no template is someone's own, and is left alone.
    const found = earlier === template ? null : await this.database(earlier);
    if (!found?.template) return null;
    const old = quoteIdent(earlier);
    if (await this.database(template)) {
      await this.q(`ALTER DATABASE ${old} WITH IS_TEMPLATE false`);
      await this.q(`DROP DATABASE IF EXISTS ${old} WITH (FORCE)`);
      return 'dropped';
    }
    // A template allows no connections: none to end before the rename.
    await this.q(`ALTER DATABASE ${old} RENAME TO ${quoteIdent(template)}`);
    return 'renamed';
  }

  /** The template holds this seed. */
  async valid(hash: string): Promise<boolean> {
    return (await this.templateState(hash)).valid;
  }

  async templateState(hash: string, opts: { earlier?: boolean } = {}): Promise<TemplateState> {
    let t = await this.database(this.target.template);
    if (!t?.template && opts.earlier && this.target.earlier !== this.target.template) t = await this.database(this.target.earlier);
    return t?.template ? { present: true, valid: t.comment === snapshotComment(hash) } : { present: false, valid: false };
  }

  async hasBase(): Promise<boolean> {
    const b = await this.database(this.target.base);
    return !!b && b.template && b.comment === BASE_COMMENT;
  }

  /** The database exists (an interrupted restore may have dropped it); created empty with `owner` if not. */
  async ensureDatabase(owner?: string): Promise<boolean> {
    if (await this.database(this.target.database)) return false;
    await this.q(`CREATE DATABASE ${quoteIdent(this.target.database)}${owner ? ` OWNER ${quoteIdent(owner)}` : ''}`);
    return true;
  }

  /** Copy the database (just seeded) as the template. */
  take(hash: string): Promise<{ owner: string; ms: number }> {
    return this.copyAs(this.target.template, snapshotComment(hash), 'after the seed');
  }

  /**
   * Copy the database, not seeded yet, as its base. A database of that name that is not a base (someone's own) is never
   * dropped: refused.
   */
  async takeBase(): Promise<{ owner: string; ms: number }> {
    const found = await this.database(this.target.base);
    if (found && !(found.template && found.comment === BASE_COMMENT)) {
      throw new SandboxError(`database ${this.target.base} exists and is not a base Retake took: rename or drop it — a snapshot reset keeps the database before its first seed under that name`);
    }
    return this.copyAs(this.target.base, BASE_COMMENT, 'before the seed');
  }

  /**
   * Copy the database as template `name` with `comment` (its sessions ended, connections blocked during the copy). The
   * copy is made under NEXT_SUFFIX, marked (template, no connections, its comment), and only then takes the place of the
   * old one: a failed or interrupted copy leaves the previous template as it was, and `name` never names an unmarked
   * copy (a leftover `<db>__retake_next` is dropped by the next copy).
   */
  private async copyAs(name: string, comment: string, when: string): Promise<{ owner: string; ms: number }> {
    const t0 = Date.now();
    const { database } = this.target;
    const db = await this.database(database);
    if (!db) throw new SandboxError(`database ${database} does not exist ${when}: nothing to snapshot`);
    const app = quoteIdent(database);
    const next = `${database}${NEXT_SUFFIX}`;
    const tmp = quoteIdent(next);
    const tpl = quoteIdent(name);
    // A copy an interrupted take left: never in use (it is renamed or dropped as soon as it is made).
    if (await this.database(next)) {
      await this.q(`ALTER DATABASE ${tmp} WITH IS_TEMPLATE false`);
      await this.q(`DROP DATABASE IF EXISTS ${tmp} WITH (FORCE)`);
    }
    await this.q(`ALTER DATABASE ${app} WITH ALLOW_CONNECTIONS false`);
    let failed: { error: unknown } | undefined;
    try {
      // The app's pool cannot reconnect while it is copied; the copy needs no other session on it.
      await this.q(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [database]);
      await this.q(`CREATE DATABASE ${tmp} TEMPLATE ${app}`);
    } catch (e) {
      failed = { error: e };
    }
    try {
      await this.q(`ALTER DATABASE ${app} WITH ALLOW_CONNECTIONS true`);
    } catch (e) {
      // A copy that failed throws its own error (the next reset repairs the database first: repair()); after a copy
      // that worked, a database left refusing connections would fail the app on camera: said, not swallowed.
      if (!failed) throw new SandboxError(`database ${database} was left refusing connections after its snapshot (${errorMessage(e)}): the next reset lets them in again`);
    }
    if (failed) throw failed.error;
    // Marked before it takes the name: `name` is a whole template or nothing.
    await this.q(`ALTER DATABASE ${tmp} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`);
    await this.q(`COMMENT ON DATABASE ${tmp} IS ${quoteLiteral(comment)}`);
    if (await this.database(name)) {
      await this.q(`ALTER DATABASE ${tpl} WITH IS_TEMPLATE false`);
      await this.q(`DROP DATABASE IF EXISTS ${tpl} WITH (FORCE)`);
    }
    await this.q(`ALTER DATABASE ${tmp} RENAME TO ${tpl}`);
    return { owner: db.owner, ms: Date.now() - t0 };
  }

  /**
   * The database holds no relation of its own (missing, or nothing outside the system schemas): what a sandbox's
   * database is before anything wrote to it. Read only.
   */
  async isEmpty(): Promise<boolean> {
    if (!(await this.database(this.target.database))) return true;
    const c = await connect({ ...this.target }, CONNECT_TIMEOUT_MS);
    try {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
      );
      return Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0) === 0;
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  /**
   * Drop the database and create it again from the template — or from the base (`from: 'base'`) — (sessions on it are
   * terminated), owned by `owner`, else by its owner now, else by the copy's.
   */
  async restore(owner: string | undefined, from: 'snapshot' | 'base' = 'snapshot'): Promise<{ ms: number }> {
    const t0 = Date.now();
    const app = quoteIdent(this.target.database);
    const source = from === 'base' ? this.target.base : this.target.template;
    const now = await this.database(this.target.database);
    const who = owner ?? now?.owner ?? (await this.database(source))?.owner;
    if (now) await this.q(`ALTER DATABASE ${app} WITH ALLOW_CONNECTIONS false`);
    // From here to CREATE nothing checks the abort signal: an interrupt lets the database come back.
    await this.q(`DROP DATABASE IF EXISTS ${app} WITH (FORCE)`);
    await this.q(`CREATE DATABASE ${app} TEMPLATE ${quoteIdent(source)}${who ? ` OWNER ${quoteIdent(who)}` : ''}`);
    return { ms: Date.now() - t0 };
  }

  /** Remove the base (tests). */
  async dropBase(): Promise<void> {
    if (!(await this.hasBase())) return;
    await this.q(`ALTER DATABASE ${quoteIdent(this.target.base)} WITH IS_TEMPLATE false`);
    await this.q(`DROP DATABASE IF EXISTS ${quoteIdent(this.target.base)} WITH (FORCE)`);
  }

  /** Remove the template, under either name (tests, a stale one). */
  async dropTemplate(): Promise<void> {
    for (const name of [this.target.template, this.target.earlier]) {
      const db = await this.database(name);
      // Under the earlier name, only a snapshot (a template) is ours to drop.
      if (!db || (name === this.target.earlier && name !== this.target.template && !db.template)) continue;
      await this.q(`ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE false`);
      await this.q(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
  }
}
