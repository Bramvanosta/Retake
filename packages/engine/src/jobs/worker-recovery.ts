/**
 * What earlier workers left, recovered by a jobs worker (worker.ts) before its first claim: the job processes a dead
 * worker left (signalled only when provably that job's — review A M1), the approvals and rollbacks no job needs any more.
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { stampOf } from '../clock.js';
import { isAlive, processStart } from './proc.js';
import { interrupted } from './interrupted.js';
import { FINISHED_JOB_STATES } from './types.js';
import type { JobWorkerInfo } from './types.js';
import { killTree, signalTree, signalablePid } from './signal.js';
import { pruneUsedApprovals } from './signing.js';
import { closeJob, persistDerived } from './worker-finish.js';
import type { Worker } from './worker-record.js';

/** A process's command line (`ps -ww`, with a time limit), or null. */
function commandLine(pid: number): Promise<string | null> {
  return new Promise((r) => {
    execFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5_000 }, (err, stdout) => r(err ? null : String(stdout).trim()));
  });
}

/**
 * Review A M1: the process a running job's record names is provably that job's job process — a pid this worker may
 * signal, on this host, running with the recorded start time (ps), with the command line of a job process of this job
 * and this workspace (`worker-main… --job <id> --kind … --root <root> --build`). A hand-edited, restored or synced
 * job.json never makes the worker signal another process.
 */
async function provenJobProcess(id: string, root: string, w: JobWorkerInfo | undefined): Promise<boolean> {
  if (!w || !signalablePid(w.pid) || w.host !== hostname() || typeof w.started_at !== 'string') return false;
  const recorded = Date.parse(w.started_at);
  const start = await processStart(w.pid);
  if (start === null || !Number.isFinite(recorded) || Math.abs(start - recorded) > 2000) return false;
  const cmd = await commandLine(w.pid);
  if (!cmd || !/\/worker-main\.(?:js|ts) /.test(cmd) || !cmd.includes(` --job ${id} --kind `)) return false;
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* the workspace as named */
  }
  return cmd.includes(` --root ${root} --build `) || cmd.includes(` --root ${real} --build `);
}

/**
 * Before any claim (probe 3: no kernel safety net): a job process a dead worker left — it ends its job itself once its
 * worker is gone; given `orphanGraceMs`, then SIGTERM (cancel with teardown), then its tree killed; its end persisted.
 * Only a process provably that job's is ever signalled (review A M1); any other recorded pid is left alone and the job
 * persisted `interrupted` (its clean-ups, which may signal its recorded browser, do not run then).
 */
async function recoverOrphans(w: Worker): Promise<void> {
  for (const id of await w.queue.ids()) {
    const stored = await w.queue.stored(id).catch(() => undefined);
    if (!stored || stored.state !== 'running' || !stored.supervisor || !stored.worker) continue;
    if (stored.worker.pid === process.pid || (await isAlive(stored.supervisor))) continue;
    if (!(await isAlive(stored.worker))) continue; // dead too: persisted as interrupted by the first scan
    if (!(await provenJobProcess(id, w.root, stored.worker))) {
      w.log(`job ${id}: the process its record names (pid ${String(stored.worker.pid).slice(0, 12)}) is not provably its job process: left alone, the job ends interrupted`);
      await closeJob(w, { ...interrupted(stored, w.cli, 'its jobs worker stopped while the job ran, and the process its record names could not be confirmed as its job process (left alone)'), finished_at: stampOf(w.clock) });
      continue;
    }
    const pid = stored.worker.pid;
    w.log(`job ${id}: its job process (pid ${pid}) outlived its worker: waiting for it to end`);
    const until = Date.now() + w.orphanGraceMs;
    while (Date.now() < until && (await isAlive(stored.worker))) await new Promise((r) => setTimeout(r, 200));
    if (await isAlive(stored.worker)) {
      signalTree(pid, 'SIGTERM', undefined, w.processes.kill);
      const t = Date.now() + 5_000;
      while (Date.now() < t && (await isAlive(stored.worker))) await new Promise((r) => setTimeout(r, 200));
      if (await isAlive(stored.worker)) await killTree(pid, w.processes.kill);
    }
    const after = await w.queue.stored(id);
    if (after && !FINISHED_JOB_STATES.has(after.state)) await persistDerived(w, after);
  }
}

/** What earlier workers left, before this worker's first claim: their orphaned job processes, then the approvals and rollbacks done with. */
export async function recoverLeftovers(w: Worker): Promise<void> {
  await recoverOrphans(w);
  await pruneUsedApprovals(process.env, w.clock.now()).catch(() => undefined);
  await w.hooks.journals.pruneDone().catch(() => undefined);
}
