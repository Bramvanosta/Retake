import pg from 'pg';
import { isLoopbackHost, normalizeHost } from '@retake/core/environment';
import { HookError } from './errors.js';

export interface DatabaseTarget {
  /** Hostname, or the socket directory for unix-socket connections. */
  host: string;
  port: number;
  database?: string;
  user?: string;
  password?: string;
  /** Unix-socket connection (always local). */
  socket: boolean;
}

/** True for connection strings handled by pg rather than by fetch. */
export function isDatabaseUrl(url: string): boolean {
  return /^(postgres|postgresql|socket):/i.test(url.trim());
}

/**
 * Where pg would connect for this connection string (pg's own parser, so host/port defaults,
 * `?host=/socket/dir` and PGHOST are taken into account). Never connects.
 */
export function databaseTarget(connectionString: string): DatabaseTarget {
  let client: pg.Client;
  try {
    client = new pg.Client({ connectionString });
  } catch (e) {
    throw new HookError(`invalid database connection URL: ${(e as Error).message}`);
  }
  const host = client.host ?? 'localhost';
  return {
    host,
    port: client.port,
    database: client.database ?? undefined,
    user: client.user ?? undefined,
    password: typeof client.password === 'string' && client.password !== '' ? client.password : undefined,
    socket: host.startsWith('/'),
  };
}

/** "db.example.com:5432/app" — no credentials. */
export function describeTarget(t: DatabaseTarget): string {
  const where = t.socket ? `socket ${t.host}` : `${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port}`;
  return t.database ? `${where}/${t.database}` : where;
}

/**
 * Why a sandbox's database URL cannot be used (L1.8), or null. A reset rewrites that database, so pg must connect where
 * the URL says (pg's own parser decides): a loopback host and the port written in it — no unix socket, no `?host=` /
 * `?port=` sending the connection to another server.
 */
export function sandboxDatabaseProblem(connectionString: string): string | null {
  let target: DatabaseTarget;
  let u: URL;
  try {
    target = databaseTarget(connectionString);
    u = new URL(connectionString);
  } catch {
    return 'its URL cannot be read';
  }
  if (target.socket) return `it would connect through the unix socket ${target.host} (a host query parameter)`;
  const host = normalizeHost(u.hostname);
  if (normalizeHost(target.host) !== host || (u.port !== '' && Number(u.port) !== target.port)) {
    return `it would connect to ${describeTarget(target)}, not to the ${host}${u.port ? `:${u.port}` : ''} its URL names (a host or port query parameter)`;
  }
  if (!isLoopbackHost(target.host)) return `${target.host} is not on this machine`;
  return null;
}
