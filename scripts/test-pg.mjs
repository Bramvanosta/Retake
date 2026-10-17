#!/usr/bin/env node
/**
 * The Postgres tests (packages/hooks/test/sql.test.ts, skipped without DEMO_STUDIO_TEST_PG) against a throwaway
 * Postgres in Docker — `pnpm test:pg`:
 *   1. checks that Docker runs and that the image postgres:17-alpine is present (it never pulls: it prints the
 *      `docker pull` to run);
 *   2. starts its own container `demo-studio-pg-test-<hex>` (label demo-studio.test=pg) with a random password, on a
 *      loopback port Docker picks (5432 may belong to another stack of the machine);
 *   3. waits until Postgres answers over TCP with password authentication (what the connection-failure test needs);
 *   4. runs the tests with DEMO_STUDIO_TEST_PG set, and exits with their exit code;
 *   5. removes its own container — and only it — with its anonymous data volume (the image declares one; `--rm` does
 *      not drop it when the container is removed by name), at the end, on an error, on Ctrl-C or SIGTERM.
 * A container left by a killed run (SIGKILL) is printed with the command that removes it, never removed by this script.
 *
 *   node scripts/test-pg.mjs            # the Postgres tests only (a few seconds)
 *   node scripts/test-pg.mjs --all      # the whole suite with Postgres, Docker (DEMO_STUDIO_TEST_DOCKER=1) and the slow
 *                                       # tests (DEMO_STUDIO_TEST_SLOW=1): everything this machine can run
 * Other arguments go to vitest (e.g. `-t "rolls back"`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'postgres:17-alpine';
const LABEL = 'demo-studio.test=pg';
const USER = 'demo_studio';
const DATABASE = 'demo_studio_test';
const READY_TIMEOUT_MS = 30_000;

const args = process.argv.slice(2);
const all = args.includes('--all');
const vitestArgs = args.filter((a) => a !== '--all');

/** `docker …` → {status, stdout, stderr} (status null when docker is not installed). */
function docker(...dargs) {
  const r = spawnSync('docker', dargs, { encoding: 'utf8' });
  return { status: r.error ? null : r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function fail(message, code = 2) {
  console.error(`test-pg: ${message}`);
  process.exit(code);
}

if (docker('info', '--format', '{{.ServerVersion}}').status !== 0) {
  fail('Docker is not running (or not installed): start Docker (or OrbStack) and run it again');
}
if (docker('image', 'inspect', IMAGE, '--format', '{{.Id}}').status !== 0) {
  fail(`the image ${IMAGE} is not on this machine; this script never pulls one — run:\n  docker pull ${IMAGE}`);
}
// Containers of an earlier run that was killed before it could clean up: shown, never touched.
const leftovers = docker('ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}} ({{.Status}})').stdout.split('\n').filter(Boolean);
if (leftovers.length) {
  console.error(`test-pg: ${leftovers.length} container(s) left by an earlier run that was killed (not removed by this script):`);
  for (const l of leftovers) console.error(`  ${l}`);
  console.error(`  remove them with: docker rm -f -v ${leftovers.map((l) => l.split(' ')[0]).join(' ')}`);
}

const name = `demo-studio-pg-test-${randomBytes(3).toString('hex')}`;
const password = randomBytes(12).toString('hex');
let started = false;
let removed = false;

/** Remove this run's own container (by its exact name) and its anonymous volume (`-v`); never another one. */
function removeContainer() {
  if (!started || removed) return;
  removed = true;
  const r = docker('rm', '-f', '-v', name);
  if (r.status === 0) console.error(`test-pg: removed ${name}`);
  else console.error(`test-pg: could not remove ${name} (${r.stderr || 'docker failed'}): docker rm -f -v ${name}`);
}

let child = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // Passed on to the tests (a signal sent to this script alone would leave them running against a removed database).
    child?.kill(sig);
    removeContainer();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const run = docker(
    'run', '-d', '--rm',
    '--name', name,
    '--label', LABEL,
    '-e', `POSTGRES_USER=${USER}`,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_DB=${DATABASE}`,
    '-p', '127.0.0.1::5432',
    IMAGE,
  );
  if (run.status !== 0) fail(`docker run failed: ${run.stderr}`, 1);
  started = true;

  // The loopback port Docker picked ("127.0.0.1:55012"; Docker Desktop and OrbStack may add an IPv6 line).
  const ports = docker('port', name, '5432/tcp').stdout;
  const port = Number(/^127\.0\.0\.1:(\d+)$/m.exec(ports)?.[1]);
  if (!port) throw new Error(`no loopback port published for ${name} (docker port: ${ports || 'nothing'})`);

  // Ready when a password-authenticated query answers over TCP: during the image's first-start initialisation the
  // server listens on no TCP socket, so the first answer comes from the final server.
  const pg = createRequire(join(ROOT, 'packages', 'hooks', 'package.json'))('pg');
  const t0 = Date.now();
  for (;;) {
    const client = new pg.Client({ host: '127.0.0.1', port, user: USER, password, database: DATABASE, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      break;
    } catch (e) {
      await client.end().catch(() => undefined);
      if (Date.now() - t0 > READY_TIMEOUT_MS) {
        throw new Error(`Postgres in ${name} did not answer within ${READY_TIMEOUT_MS / 1000} s: ${e instanceof Error ? e.message : e}`);
      }
      await sleep(250);
    }
  }
  console.error(`test-pg: ${name} (${IMAGE}) ready on 127.0.0.1:${port} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const env = {
    ...process.env,
    DEMO_STUDIO_TEST_PG: `postgres://${USER}:${password}@127.0.0.1:${port}/${DATABASE}`,
    ...(all ? { DEMO_STUDIO_TEST_DOCKER: '1', DEMO_STUDIO_TEST_SLOW: '1' } : {}),
  };
  const vitest = createRequire(join(ROOT, 'package.json')).resolve('vitest/vitest.mjs');
  const files = all ? [] : ['packages/hooks/test/sql.test.ts'];
  const code = await new Promise((resolve) => {
    child = spawn(process.execPath, [vitest, 'run', ...files, ...vitestArgs], { cwd: ROOT, env, stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`test-pg: cannot start vitest: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  child = null;
  process.exitCode = code;
} catch (e) {
  console.error(`test-pg: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  removeContainer();
}
