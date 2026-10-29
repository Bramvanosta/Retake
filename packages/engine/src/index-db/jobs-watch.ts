/**
 * Job changes for the Studio's event stream (L4.1, critique B2): never from the index — unfinished jobs are read live
 * from the queue at each poll (their derived states included: a running job whose worker was killed reads
 * `interrupted` with no file changed), finished ones are history. Each poll reads only the jobs that are new since the
 * last one and those that were unfinished then: a handful of job.json files, whatever the queue's length.
 */
import { FileJobQueue } from '../jobs/queue.js';
import { FINISHED_JOB_STATES } from '../jobs/types.js';
import type { JobRecord } from '../jobs/types.js';

function signature(j: JobRecord): string {
  return JSON.stringify([j.state, j.progress ?? null, j.cancel_requested_at ?? null, j.started_at ?? null, j.finished_at ?? null]);
}

export class JobsWatch {
  private known: Set<string> | undefined;
  private live = new Map<string, string>();
  private records = new Map<string, JobRecord>();

  constructor(private readonly queue: FileJobQueue) {}

  /** Ids of the jobs that were unfinished at the last poll (L5.2b: the desktop shell's pending snapshot). */
  get unfinished(): string[] {
    return [...this.live.keys()].sort();
  }

  /**
   * The record of job `id` as the last poll read it (a job new or unfinished then; L5.2b review B L15: a reader of the
   * changes reuses it instead of reading the job again — a running job's read checks its worker with `ps`).
   */
  record(id: string): JobRecord | undefined {
    return this.records.get(id);
  }

  /** Ids of the jobs that appeared or changed since the last poll (none on the first: it only takes stock). */
  async poll(): Promise<string[]> {
    const ids = await this.queue.ids();
    const first = this.known === undefined;
    const known = this.known ?? new Set<string>();
    const look = new Set<string>(first ? [] : ids.filter((id) => !known.has(id)));
    for (const id of this.live.keys()) look.add(id);
    if (first) {
      // Taking stock: unfinished jobs only (a finished one never changes again).
      for (const id of ids) look.add(id);
    }
    const changed: string[] = [];
    const live = new Map<string, string>();
    const records = new Map<string, JobRecord>();
    // L5.10 flake fix: ids listed with no job.json to read yet — enqueue() makes the folder before it writes job.json —
    // stay unknown, so the next poll looks at them again (known, they were never read again: a job queued and finished
    // between two polls, or with a poll in that window, was never told).
    const unread = new Set<string>();
    for (const id of look) {
      const job = await this.queue.get(id).catch(() => undefined);
      if (!job) {
        unread.add(id);
        continue;
      }
      // The first poll reads the whole history: only its unfinished jobs are kept.
      if (!first || !FINISHED_JOB_STATES.has(job.state)) records.set(id, job);
      const s = signature(job);
      if (!first && this.live.get(id) !== s) changed.push(id);
      if (!FINISHED_JOB_STATES.has(job.state)) live.set(id, s);
    }
    this.known = new Set(ids.filter((id) => !unread.has(id)));
    this.live = live;
    this.records = records;
    return changed.sort();
  }
}
