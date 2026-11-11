/**
 * The end of a job, written by the jobs worker (worker.ts) when its runner did not write it: a job it ends itself
 * (closeJob), what a dead worker or job process could not write (persistDerived: this worker holds the lock, no other
 * one runs), and what a job killed mid-way leaves (cleanupDead). A job whose state cannot be written makes the worker
 * exit non-zero (writeOrExit): readers then see its pid gone and derive `interrupted`.
 */
import { stampOf } from '../clock.js';
import { appendHistory } from '../history.js';
import { historyOf } from './run-job-record.js';
import type { JobRecord } from './types.js';
import type { Worker } from './worker-record.js';

/** Write job.json, or exit: a job whose state cannot be written must not look alive. */
export async function writeOrExit(w: Worker, rec: JobRecord): Promise<void> {
  try {
    await w.queue.write(rec);
  } catch (e) {
    w.log(`cannot write the state of job ${rec.id} (${(e as Error).message}): exiting`);
    w.lock?.release();
    process.exit(1);
  }
}

/** Close a job this worker ends itself (its runner never wrote its end): job.json, its last events, its history line. */
export async function closeJob(w: Worker, final: JobRecord, opts: { cleanup?: boolean } = {}): Promise<void> {
  await writeOrExit(w, final);
  try {
    await w.queue.append(final.id, await w.queue.lastSeq(final.id), [{ type: 'state', state: final.state }, { type: 'result', ...(final.error ? { error: final.error } : {}) }]);
  } catch (e) {
    w.log(`job ${final.id}: events not written (${(e as Error).message})`);
  }
  w.done.add(final.id);
  try {
    await appendHistory(w.root, historyOf(final), w.clock);
  } catch (e) {
    w.log(`job ${final.id}: no history line (${(e as Error).message})`);
  }
  if (opts.cleanup) await cleanupDead(w, final);
  w.log(`job ${final.id}: ${final.state} (${final.error?.message.split('\n')[0] ?? ''})`);
}

/** What a job killed mid-way leaves: its browser (Remotion starts it detached), its lock, partial files. */
export async function cleanupDead(w: Worker, final: JobRecord): Promise<void> {
  if (final.input.kind === 'render') {
    const { cleanupInterruptedRender } = await import('./render-job.js');
    await cleanupInterruptedRender(w.ws, w.files, final, w.log);
  } else if (final.input.kind === 'export') {
    // An export's re-render leaves the same: its browser and partial files.
    const { cleanupInterruptedExport } = await import('./export-job.js');
    await cleanupInterruptedExport(w.ws, w.files, final, w.log);
  } else if (final.input.kind === 'preview') {
    // A preview's browser, started detached like a render's.
    const { killRecordedBrowser } = await import('./render-job.js');
    await killRecordedBrowser(w.files, final, w.log);
  } else if (final.input.kind === 'review') {
    // A review killed between its two renames leaves the previous review set aside.
    const { cleanupInterruptedReview } = await import('./review-job.js');
    await cleanupInterruptedReview(w.ws, final, w.log);
  }
}

/** Persist what dead workers could not write (this worker holds the lock: no other one runs). */
export async function persistDerived(w: Worker, stored: JobRecord): Promise<void> {
  const rec = await w.queue.derive(stored);
  if (rec.state === 'interrupted') {
    const final = { ...rec, finished_at: rec.finished_at ?? stampOf(w.clock) };
    await w.queue.write(final);
    w.done.add(rec.id);
    await appendHistory(w.root, historyOf(final), w.clock);
    await cleanupDead(w, final);
  }
}
