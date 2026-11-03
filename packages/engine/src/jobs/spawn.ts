/**
 * Starting the jobs worker of a workspace (L3.1): `ensureWorker` after each submit — nothing when the worker lock's
 * holder is alive, else a detached `node …/engine/worker-main.js --root <ws>` whose output goes to
 * .retake/workers/worker.log. It outlives the client that started it (a capture finishes with its teardown even
 * when the MCP session closes) and exits once idle. Run from the sources (tests), the same entry is started as
 * TypeScript through tsx with the packages' `source` export condition.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WORKER_CLIENT_RE, liveWorker, workersDir } from './lock.js';

/** Starts the worker process: node's `spawn` (tests inject one to see the command and the environment). */
export type WorkerSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => Pick<ChildProcess, 'pid' | 'on' | 'unref'>;

export interface WorkerSpawnOptions {
  /** Exit after this long without a job (ms; default the worker's own, 60 s). */
  idleExitMs?: number;
  /**
   * The worker's environment (default this process's). The Studio passes a clean one (L4.2, critique B5): the PATH
   * sanitised like `retake mcp`'s, no package-manager or LLM variables, RETAKE_HOME kept.
   */
  env?: NodeJS.ProcessEnv;
  /** The client starting it, recorded in the worker lock (`started_by`). */
  startedBy?: string;
  /** Tests: the process starter (default node's spawn). */
  spawn?: WorkerSpawnFn;
}

/** tsx's ESM loader, found from this file up (only needed when running from the sources). */
function tsxLoader(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const loader = join(dir, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    if (existsSync(loader)) return pathToFileURL(loader).href;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The command line of a worker for `root`: the engine's worker-main entry, built or from the sources. */
export function workerCommand(root: string, opts: WorkerSpawnOptions = {}): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url); // …/engine/(dist|src)/jobs/spawn.(js|ts)
  const fromSources = here.endsWith('.ts');
  const entry = join(dirname(dirname(here)), fromSources ? 'worker-main.ts' : 'worker-main.js');
  const args: string[] = [];
  if (fromSources) {
    const loader = tsxLoader(dirname(here));
    if (!loader) throw new Error('cannot start a worker from the sources: tsx is not installed (pnpm install)');
    args.push('--conditions=source', '--import', loader);
  }
  args.push(entry, '--root', root);
  if (opts.idleExitMs !== undefined) args.push('--idle-exit', String(opts.idleExitMs));
  if (opts.startedBy !== undefined && WORKER_CLIENT_RE.test(opts.startedBy)) args.push('--started-by', opts.startedBy);
  return { command: process.execPath, args };
}

/** Start a detached worker for `root` (its output appended to workers/worker.log); returns its pid. */
export async function spawnWorker(root: string, opts: WorkerSpawnOptions = {}): Promise<number | undefined> {
  await mkdir(workersDir(root), { recursive: true });
  const { command, args } = workerCommand(root, opts);
  const log = openSync(join(workersDir(root), 'worker.log'), 'a');
  try {
    const child = (opts.spawn ?? spawn)(command, args, { cwd: root, detached: true, stdio: ['ignore', log, log], env: opts.env ?? process.env });
    child.on('error', () => undefined);
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

/**
 * Make sure a worker serves `root`: the live holder of the worker lock (a worker of an older build hands over to a new
 * one itself once idle), else a new one. Two clients starting one at the same time is harmless: the second worker finds
 * the lock held and exits.
 */
export async function ensureWorker(root: string, opts: WorkerSpawnOptions = {}): Promise<{ pid?: number; spawned: boolean }> {
  const live = await liveWorker(root);
  if (live) return { pid: live.pid, spawned: false };
  return { pid: await spawnWorker(root, opts), spawned: true };
}
