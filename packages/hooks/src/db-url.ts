import pg from 'pg';
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
