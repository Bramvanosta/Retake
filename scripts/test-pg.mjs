#!/usr/bin/env node
/**
 * The Postgres tests (packages/hooks/test/sql.test.ts and agent-sql.test.ts) — `pnpm test:pg`. They run by default in
 * `pnpm test` wherever Docker runs and the image is here (each file starts its own throwaway container:
 * packages/test-support/src/postgres.ts) and skip otherwise, saying why; this script runs them and fails instead:
 *   1. checks that Docker runs and that the image postgres:17-alpine is present (it never pulls: it prints the
 *      `docker pull` to run) — unless RETAKE_TEST_PG names a server of your own;
 *   2. lists the containers another or an earlier run left (label retake.test=pg; never removed here: a run removes
 *      its own when it ends or is stopped, and one a killed process left stops by itself within 15 minutes);
 *   3. runs the files with RETAKE_TEST_PG_REQUIRED=1 (a missing Postgres is an error, not a skip), and exits with
 *      their exit code. Each file's container, `retake-pg-test-<hex>` on a loopback port Docker picks with a random
 *      password, is removed with its anonymous data volume when the file ends.
 *
 *   node scripts/test-pg.mjs            # the Postgres tests only (a few seconds)
 *   node scripts/test-pg.mjs --all      # the whole suite with Postgres, Docker (RETAKE_TEST_DOCKER=1) and the slow
 *                                       # tests (RETAKE_TEST_SLOW=1): everything this machine can run
 * Other arguments go to vitest (e.g. `-t "rolls back"`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'postgres:17-alpine';
const LABEL = 'retake.test=pg';
export const PG_FILES = ['packages/hooks/test/sql.test.ts', 'packages/hooks/test/agent-sql.test.ts'];

const args = process.argv.slice(2);
const all = args.includes('--all');
const vitestArgs = args.filter((a) => a !== '--all');

/** `docker …` → {status, stdout, stderr} (status null when docker is not installed). */
function docker(...dargs) {
  const r = spawnSync(process.env.RETAKE_DOCKER?.trim() || 'docker', dargs, { encoding: 'utf8' });
  return { status: r.error ? null : r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function fail(message, code = 2) {
  console.error(`test-pg: ${message}`);
  process.exit(code);
}

const given = process.env.RETAKE_TEST_PG?.trim();
if (given === 'off') fail('RETAKE_TEST_PG=off: unset it (or name a server of your own) to run the Postgres tests');
if (!given) {
  if (docker('info', '--format', '{{.ServerVersion}}').status !== 0) {
    fail('Docker is not running (or not installed): start Docker (or OrbStack) and run it again');
  }
  if (docker('image', 'inspect', IMAGE, '--format', '{{.Id}}').status !== 0) {
    fail(`the image ${IMAGE} is not on this machine; this script never pulls one — run:\n  docker pull ${IMAGE}`);
  }
  // Containers of an earlier run that was killed before it could clean up: shown, never touched.
  const leftovers = docker('ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}} ({{.Status}})').stdout.split('\n').filter(Boolean);
  if (leftovers.length) {
    console.error(`test-pg: ${leftovers.length} container(s) of another or an earlier run (each stops by itself within 15 minutes):`);
    for (const l of leftovers) console.error(`  ${l}`);
    console.error(`  remove them now with: docker rm -f -v ${leftovers.map((l) => l.split(' ')[0]).join(' ')}`);
  }
}

const env = { ...process.env, RETAKE_TEST_PG_REQUIRED: '1', ...(all ? { RETAKE_TEST_DOCKER: '1', RETAKE_TEST_SLOW: '1' } : {}) };
const vitest = createRequire(join(ROOT, 'package.json')).resolve('vitest/vitest.mjs');
const child = spawn(process.execPath, [vitest, 'run', ...(all ? [] : PG_FILES), ...vitestArgs], { cwd: ROOT, env, stdio: 'inherit' });
// Passed on to the tests: each file removes its container in its afterAll.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('error', (e) => {
  console.error(`test-pg: cannot start vitest: ${e.message}`);
  process.exitCode = 1;
});
child.on('exit', (c, signal) => {
  process.exitCode = c ?? (signal ? 1 : 0);
});
