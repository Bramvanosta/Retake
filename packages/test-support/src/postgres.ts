/**
 * A throwaway Postgres for the SQL hook tests (hooks sql.test.ts, agent-sql.test.ts), so they run by default wherever
 * they can:
 * - `RETAKE_TEST_PG` set (a URL whose role may create tables): that server, as it is;
 * - else Docker running and the image postgres:17-alpine on this machine: a container of the file's own,
 *   `retake-pg-test-<hex>` (label retake.test=pg), with a random password, on a loopback port Docker picks, removed
 *   with its anonymous data volume when the file ends — or when its process ends or is stopped (SIGINT, SIGTERM)
 *   first; it stops by itself after LIFETIME_S in any case (a process killed outright leaves nothing behind for long:
 *   `--rm` then drops it and its volume); it never pulls the image;
 * - else the tests skip, and the file says why (no Docker, or no image: the tests never pull one); RETAKE_TEST_PG=off
 *   skips them without asking Docker (the CI tier, scripts/test-ci.mjs).
 * `pnpm test:pg` (scripts/test-pg.mjs) runs the same files and fails instead of skipping.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO } from './repo.js';

export const PG_IMAGE = 'postgres:17-alpine';
export const PG_LABEL = 'retake.test=pg';
/** How long a test container may live at most (seconds): far more than a file needs. */
export const LIFETIME_S = 900;
const USER = 'retake';
const DATABASE = 'retake_test';
const READY_TIMEOUT_MS = 30_000;

/** What this file uses of `pg` (the hooks package's dependency; test-support has none of its own). */
interface PgModule {
  Client: new (o: { connectionString: string; connectionTimeoutMillis: number }) => { connect(): Promise<void>; query(q: string): Promise<unknown>; end(): Promise<void> };
}

type Docker = (...args: string[]) => { status: number | null; stdout: string; stderr: string };

function docker(...args: string[]): ReturnType<Docker> {
  const r = spawnSync(process.env.RETAKE_DOCKER?.trim() || 'docker', args, { encoding: 'utf8', timeout: 20_000 });
  return { status: r.error ? null : r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/** Whether the SQL tests can run here, and why not. Reads the machine (a `docker` call or two), never pulls. */
export function postgresAvailability(env: NodeJS.ProcessEnv = process.env, run: Docker = docker): { ok: true; given: boolean } | { ok: false; reason: string } {
  if (env.RETAKE_TEST_PG?.trim() === 'off') return { ok: false, reason: 'RETAKE_TEST_PG=off (the CI tier: scripts/test-ci.mjs)' };
  if (env.RETAKE_TEST_PG?.trim()) return { ok: true, given: true };
  if (run('info', '--format', '{{.ServerVersion}}').status !== 0) return { ok: false, reason: 'Docker is not running (or not installed) and RETAKE_TEST_PG is not set' };
  if (run('image', 'inspect', PG_IMAGE, '--format', '{{.Id}}').status !== 0)
    return { ok: false, reason: `the image ${PG_IMAGE} is not on this machine (the tests never pull one: docker pull ${PG_IMAGE})` };
  return { ok: true, given: false };
}

/**
 * The availability of the file's Postgres, said once when it is missing (the file's output shows why its SQL tests were
 * skipped). Under RETAKE_TEST_PG_REQUIRED=1 (`pnpm test:pg`) a missing one is an error instead.
 */
export function postgresForTests(file: string, env: NodeJS.ProcessEnv = process.env, run: Docker = docker): { ok: boolean } {
  const a = postgresAvailability(env, run);
  if (!a.ok) {
    if (env.RETAKE_TEST_PG_REQUIRED === '1') throw new Error(`${file}: no Postgres for the SQL tests: ${a.reason}`);
    console.info(`${file}: the tests against Postgres are skipped: ${a.reason}`);
  }
  return { ok: a.ok };
}

export interface TestPostgres {
  /** postgres://retake:<password>@127.0.0.1:<port>/retake_test (or RETAKE_TEST_PG as given). */
  url: string;
  /** Removes the container this file started (nothing for a given RETAKE_TEST_PG); RETAKE_TEST_PG is put back. */
  stop(): Promise<void>;
}

/** The `docker run` arguments of a test container: never a pull, a lifetime cap, a loopback port Docker picks. */
export function containerRunArgs(name: string, password: string): string[] {
  return [
    'run',
    '-d',
    '--rm',
    // The image must be here already (postgresAvailability checked it): a run never pulls one, even if it went away.
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    PG_LABEL,
    '-e',
    `POSTGRES_USER=${USER}`,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${DATABASE}`,
    '-p',
    '127.0.0.1::5432',
    // A lifetime cap (busybox timeout in the image): the container ends, and `--rm` removes it with its volume.
    '--entrypoint',
    'timeout',
    PG_IMAGE,
    String(LIFETIME_S),
    'docker-entrypoint.sh',
    'postgres',
  ];
}

/**
 * Removes the container `name` when the process ends, is stopped (SIGINT, SIGTERM) or loses its channel to vitest (a
 * stopped run), before its afterAll could; returns the function that takes the hooks off again.
 */
export function removeOnExit(name: string, run: Docker = docker, proc: NodeJS.EventEmitter = process): () => void {
  const sync = () => {
    off();
    run('rm', '-f', '-v', name);
  };
  const onSignal = (sig: NodeJS.Signals) => {
    sync();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const off = () => {
    proc.off('exit', sync);
    proc.off('disconnect', sync);
    proc.off('SIGINT', onSignal);
    proc.off('SIGTERM', onSignal);
  };
  proc.once('exit', sync);
  // A vitest worker whose run is stopped (Ctrl-C, SIGTERM to vitest) loses its channel to vitest before it goes.
  proc.once('disconnect', sync);
  proc.once('SIGINT', onSignal);
  proc.once('SIGTERM', onSignal);
  return off;
}

/**
 * The file's Postgres: RETAKE_TEST_PG as given, or a container started now and ready for a password-authenticated
 * query over TCP. RETAKE_TEST_PG is set to its URL while it runs (the hooks read `{{env:RETAKE_TEST_PG}}`). The
 * container is removed by stop(), or when the process ends or is stopped first (removeOnExit).
 */
export async function startPostgres(): Promise<TestPostgres> {
  const given = process.env.RETAKE_TEST_PG?.trim();
  if (given && given !== 'off') return { url: given, stop: async () => undefined };
  const name = `retake-pg-test-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  const run = docker(...containerRunArgs(name, password));
  if (run.status !== 0) throw new Error(`docker run ${PG_IMAGE} failed: ${run.stderr || 'docker did not start'}`);
  const unhook = removeOnExit(name);
  let removed = false;
  const remove = async () => {
    if (removed) return;
    removed = true;
    unhook();
    if (process.env.RETAKE_TEST_PG === url) delete process.env.RETAKE_TEST_PG;
    const r = docker('rm', '-f', '-v', name);
    if (r.status !== 0) console.error(`could not remove ${name} (${r.stderr || 'docker failed'}): docker rm -f -v ${name}`);
  };
  let url = '';
  try {
    // The loopback port Docker picked ("127.0.0.1:55012"; Docker Desktop and OrbStack may add an IPv6 line).
    const ports = docker('port', name, '5432/tcp').stdout;
    const port = Number(/^127\.0\.0\.1:(\d+)$/m.exec(ports)?.[1]);
    if (!port) throw new Error(`no loopback port published for ${name} (docker port: ${ports || 'nothing'})`);
    url = `postgres://${USER}:${password}@127.0.0.1:${port}/${DATABASE}`;
    // Ready when a password-authenticated query answers over TCP: during the image's first-start initialisation the
    // server listens on no TCP socket, so the first answer comes from the final server.
    const pg = createRequire(join(REPO, 'packages', 'hooks', 'package.json'))('pg') as PgModule;
    const t0 = Date.now();
    for (;;) {
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        break;
      } catch (e) {
        await client.end().catch(() => undefined);
        if (Date.now() - t0 > READY_TIMEOUT_MS) throw new Error(`Postgres in ${name} did not answer within ${READY_TIMEOUT_MS / 1000} s: ${e instanceof Error ? e.message : e}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } catch (e) {
    await remove();
    throw e;
  }
  process.env.RETAKE_TEST_PG = url;
  return { url, stop: remove };
}
