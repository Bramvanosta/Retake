/**
 * Entry point of a jobs worker process: `node …/engine/dist/worker-main.js --root <workspace> [--idle-exit <ms>]
 * [--once]` (what ensureWorker starts; `studio worker` runs the same). stdout stays empty: whatever a library prints goes
 * to stderr, which the spawner sends to .demo-studio/workers/worker.log.
 */
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
const idle = arg('--idle-exit');
const idleExitMs = idle !== undefined ? Number(idle) : process.env.DEMO_STUDIO_WORKER_IDLE_MS ? Number(process.env.DEMO_STUDIO_WORKER_IDLE_MS) : undefined;
runWorker({ root, ...(idleExitMs !== undefined && Number.isFinite(idleExitMs) ? { idleExitMs } : {}), once: process.argv.includes('--once') })
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`worker: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
