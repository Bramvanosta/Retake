/**
 * The jobs worker of a workspace (L3.1, L5.14): one process per workspace (the worker lock) with two slots — captures
 * first. The capture slot runs one capture-class job at a time (core JOB_CLASS: takes, what prepares them, sign-ins,
 * recordings, inspections) in this process; the heavy slot runs one heavy job at a time (renders, reviews, exports,
 * previews, site extractions) in a job process of its own (job-child.ts). Each slot claims the oldest queued job of its
 * class, captures whatever their age (pick.ts); a heavy job starts only while no filming take of this workspace is
 * queued or running and no filming marker of this user holds (captures.ts), and a running one yields during a take
 * (background QoS, yield.ts). It exits once idle — or when the workspace disappears, or when its build changed (it then
 * stops claiming and hands over to a new worker once both slots are empty).
 *
 * Signals: the first SIGINT / SIGTERM stops claiming, cancels the running capture (its teardown and rollbacks still run
 * — the runner aborts on the same signal) and the job process (its first signal cancels with teardown), waits for both,
 * then the worker exits. Any later signal quits at once: session copies and what a sandbox take started are removed
 * synchronously, the job process's tree is killed; the quit is deferred to the next tick so that the runner's own
 * second-signal handler (registered after this one) still kills the shell hooks it runs. Every signal to a job process or
 * its tree goes through signal.ts (review B L1: never a pid of -1, 0, 1, the worker itself or its own group).
 *
 * A job whose final state cannot be written makes the worker exit non-zero: readers then see its pid gone and derive
 * `interrupted`, never a `running` job with a live pid that will never finish (a job process whose worker is gone ends
 * its job itself).
 *
 * The code: runWorker opens the workspace (trust mcp, never beside a worker from before the rename), builds the queue
 * (this process's composition root), takes the worker lock and builds the one record a worker keeps while it serves
 * (worker-record.ts); then it orchestrates the parts that read and change that record — the process's signals
 * (worker-signals.ts), the recovery of what earlier workers left (worker-recovery.ts), the loop, its drain and the
 * hand-over (worker-loop.ts) over the claims of each turn and the capture slot (worker-slots.ts, worker-claim.ts), the
 * heavy slot (worker-heavy.ts) and the ends this worker writes itself (worker-finish.ts).
 */
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { processTableSync } from '@retake/core/io';
import { stampOf } from '../clock.js';
import { enginePorts } from '../ports.js';
import { openWorkspace } from '../workspace.js';
import { buildDirs } from './build.js';
import { heldFile } from './captures.js';
import { WorkerLock } from './lock.js';
import { selfIdentity } from './proc.js';
import { FileJobQueue } from './queue.js';
import { shellQuote } from './run-job-record.js';
import type { Workspace } from './run-job-record.js';
import { drain, handOver, serve } from './worker-loop.js';
import { newWorker } from './worker-record.js';
import type { WorkerOptions } from './worker-record.js';
import { recoverLeftovers } from './worker-recovery.js';
import { handleSignals } from './worker-signals.js';
import { captureJobRunner } from './worker-slots.js';
import { workerPorts } from './worker-ports.js';

export type { WorkerOptions } from './worker-record.js';

/** The workspace a worker serves, opened under the agent policy; undefined (said) when it cannot be. */
async function openForWorker(root: string, log: (message: string) => void): Promise<Workspace | undefined> {
  let ws: Workspace;
  try {
    // The worker runs every job under trust mcp, whoever submitted it (the Studio, the desktop app, an MCP client).
    ws = await openWorkspace({ root, agent: true });
  } catch (e) {
    log(`no workspace at ${root}: ${(e as Error).message}`);
    return undefined;
  }
  return ws;
}

/** Run a worker until it is idle, stopped or replaced; resolves with the process exit code. */
export async function runWorker(o: WorkerOptions): Promise<number> {
  // The worker process's composition root: the ports its jobs run with (a test's, else the product's).
  const engine = enginePorts(o.ports);
  const { clock, stores, hooks, reviewer, capture, sandboxes } = engine;
  const log = o.log ?? ((m: string) => void process.stderr.write(`${stampOf(clock)} worker ${process.pid}: ${m}\n`));
  const root = resolve(o.root);
  const ws = await openForWorker(root, log);
  if (!ws) return 1;
  const cli = `retake -C ${shellQuote(root)}`;
  // The worker process's composition root: the one queue this worker reads and writes.
  const queue = new FileJobQueue(root, cli, clock);
  const dirs = buildDirs();
  const { ports, heavyInProcess } = workerPorts(engine, o.ports, dirs);
  const build = ports.processes.buildStamp();
  const lock = await WorkerLock.acquire(root, build, clock, log, o.startedBy);
  if (!lock) {
    log('another worker serves this workspace: exiting');
    return 0;
  }
  const self = await selfIdentity();
  // Loaded now, before the signals are listened to: a signal's cancel and its removal of session copies are synchronous.
  await capture.load();
  log(`serving ${root} (build ${build})`);

  const w = newWorker({
    o,
    log,
    root,
    clock,
    stores,
    hooks,
    reviewer,
    ws,
    cli,
    queue,
    files: queue.files,
    dirs,
    build,
    lock,
    self,
    captureRunner: capture,
    sandboxes,
    os: { processTableSync },
    renderer: ports.renderer,
    recordWindow: ports.recordWindow,
    freeBytes: ports.freeBytes,
    processes: ports.processes,
    heavyInProcess,
  });
  const stopListening = handleSignals(w);
  w.runJob = captureJobRunner(w);
  let handover = false;
  try {
    await recoverLeftovers(w);
    handover = await serve(w);
    await drain(w);
  } finally {
    if (w.heldWritten) await rm(heldFile(root), { force: true }).catch(() => undefined);
    stopListening();
    w.lock.release();
  }
  if (handover) await handOver(w);
  return 0;
}
