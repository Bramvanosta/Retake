/**
 * Entry point of a jobs worker process: `node …/engine/dist/worker-main.js --root <workspace> [--idle-exit <ms>]
 * [--once] [--started-by <client>]` (what ensureWorker starts — `--started-by` names the client that started it, recorded in
 * the worker lock; `retake worker` runs the same). stdout stays empty: whatever a library prints goes
 * to stderr, which the spawner sends to .retake/workers/worker.log.
 *
 * L5.14: `--job <id> --kind <kind> --root <ws> --build <stamp> --supervisor <pid> --digest <sha256>` runs one heavy job a
 * worker claimed (jobs/job-child.ts), as a process of its own; only a worker starts it so.
 */
// First: the app bundle's browsers before any module loads playwright-core (bundle-env.ts; the cli app-bundle test).
import './bundle-env.js';
import { WORKER_CLIENT_RE } from './jobs/lock.js';
import { JOB_EXIT, passedBuildDirs, runJobChild } from './jobs/job-child.js';
import { runWorker } from './jobs/worker.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const toStderr = (...args: unknown[]) => void process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

const root = arg('--root');
if (!root) {
  process.stderr.write('worker-main: --root <workspace> is required\n');
  process.exit(2);
}
const job = arg('--job');
if (job !== undefined) {
  const supervisor = Number(arg('--supervisor'));
  const kind = arg('--kind');
  const build = arg('--build');
  const digest = arg('--digest');
  if (!kind || !build || !Number.isInteger(supervisor) || supervisor <= 1 || !digest || !/^[0-9a-f]{64}$/.test(digest)) {
    process.stderr.write('worker-main --job: --kind, --build, --supervisor <pid> and --digest <sha256> are required\n');
    process.exit(JOB_EXIT.refused);
  }
  const dirs = passedBuildDirs(process.env.RETAKE_JOB_BUILD_DIRS);
  runJobChild({ root, id: job, kind, build, supervisor, digest, ...(dirs ? { dirs } : {}) })
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`job process: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
} else {
  const idle = arg('--idle-exit');
  const idleExitMs = idle !== undefined ? Number(idle) : process.env.RETAKE_WORKER_IDLE_MS ? Number(process.env.RETAKE_WORKER_IDLE_MS) : undefined;
  const startedBy = arg('--started-by');
  runWorker({
    root,
    ...(idleExitMs !== undefined && Number.isFinite(idleExitMs) ? { idleExitMs } : {}),
    once: process.argv.includes('--once'),
    ...(startedBy !== undefined && WORKER_CLIENT_RE.test(startedBy) ? { startedBy } : {}),
  })
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`worker: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
}
