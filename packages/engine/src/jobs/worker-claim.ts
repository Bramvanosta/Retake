/**
 * The open jobs a jobs worker (worker.ts) sees, and the claim of one: re-read, refused at once when its record lies
 * about its kind or its approvals were taken before, given back unrun (its claim and the approvals its claim took).
 */
import { isFilming } from './job-input.js';
import { stampOf } from '../clock.js';
import { buildStamp } from './build.js';
import type { PickRecord } from './pick.js';
import { unknownInput } from './run-job-record.js';
import { FINISHED_JOB_STATES } from './types.js';
import type { JobRecord } from './types.js';
import { approvalsUsedDir, consumeApprovals, restoreApprovals } from './signing.js';
import { closeJob, persistDerived } from './worker-finish.js';
import type { Worker } from './worker-record.js';

/**
 * The open jobs as `pick` reads them; what a dead worker or job process left is persisted on the way (critique M2:
 * never the jobs of this worker's own slots, whose ends this worker writes itself).
 */
export async function scanOpenJobs(w: Worker): Promise<PickRecord[]> {
  const out: PickRecord[] = [];
  for (const id of await w.queue.ids()) {
    if (w.done.has(id)) continue;
    const stored = await w.queue.stored(id);
    if (!stored) continue;
    if (FINISHED_JOB_STATES.has(stored.state)) {
      w.done.add(id);
      continue;
    }
    const claimed = (await w.queue.claimOf(id)) !== undefined;
    if ((stored.state === 'running' || claimed) && id !== w.capture?.id && id !== w.heavy?.id) {
      await persistDerived(w, stored);
      if (w.done.has(id)) continue;
    }
    // The class comes from the kind of the input the job runs, through this build's JOB_CLASS (no field of job.json orders it).
    const kind = String((stored.input as { kind?: unknown } | undefined)?.kind ?? stored.kind);
    // A cancelled queued take holds nothing (review B L7): only takes are asked (one marker read each).
    const cancelled = stored.state === 'queued' && isFilming(stored.input) && (await w.queue.cancelOf(id)) !== undefined;
    out.push({ id, state: stored.state, kind, input: stored.input, claimed, ...(cancelled ? { cancelled } : {}) });
  }
  return out;
}

export async function hasQueued(w: Worker): Promise<boolean> {
  for (const id of await w.queue.ids()) {
    if (w.done.has(id)) continue;
    const rec = await w.queue.get(id);
    if (rec?.state === 'queued') return true;
  }
  return false;
}

/**
 * Claim a job (re-read: it may have changed since the scan); undefined when someone else took it, or when it was refused
 * at once — review A M2: a record whose kind is not its input's kind (which a job process would refuse) ends `failed`
 * on its first claim, never claimed and given back in a loop. A job's approvals are taken as it is claimed (signing.ts
 * consumeApprovals): a job whose approvals were taken before (a job folder made again under the same id) is refused.
 */
export async function claimJob(w: Worker, id: string): Promise<JobRecord | undefined> {
  const stored = await w.queue.stored(id);
  if (!stored || stored.state !== 'queued') return undefined;
  // A job of a newer client (its input version or kind): left for a worker of the new build when the code changed.
  if (unknownInput(stored.input) && buildStamp(w.dirs) !== w.build) {
    w.newerJob = true;
    return undefined;
  }
  if (!(await w.queue.claim(id, w.self))) return undefined;
  const inputKind = (stored.input as { kind?: unknown } | undefined)?.kind;
  if (inputKind !== stored.kind) {
    w.started++;
    w.ended++;
    await closeJob(w, {
      ...stored,
      state: 'failed',
      finished_at: stampOf(w.clock),
      error: { code: 'invalid', message: `refused without running: job ${id} is a ${JSON.stringify(stored.kind)} job whose input is of kind ${JSON.stringify(inputKind ?? null)}` },
    });
    return undefined;
  }
  // Review B L4: a record that cannot be written is said as such (not as approvals taken before).
  const consumed = await consumeApprovals(stored, process.env, w.clock.now()).then(
    (ok) => (ok ? null : `refused without running: the approvals of job ${id} were taken by an earlier claim of that id (approvals are bound to their job) — submit it again`),
    (e: unknown) => `not run: the record of the approvals workers took (${approvalsUsedDir()}) cannot be written (${(e as Error).message}) — fix it, then submit the job again`,
  );
  if (consumed) {
    w.started++;
    w.ended++;
    await closeJob(w, { ...stored, state: 'failed', finished_at: stampOf(w.clock), error: { code: 'refused', message: consumed } });
    return undefined;
  }
  return stored;
}

/** Give a claimed job back to the queue unrun: its claim and the approvals its claim took. */
export async function unclaimJob(w: Worker, id: string): Promise<void> {
  await restoreApprovals(id).catch(() => undefined);
  await w.queue.unclaim(id);
}
