/**
 * Job changes for the Studio's event stream (L4.1, critique B2): never from the index — unfinished jobs are read live
 * from the queue at each poll (their derived states included: a running job whose worker was killed reads
 * `interrupted` with no file changed), finished ones are history. Each poll reads only the jobs that are new since the
 * last one and those that were unfinished then: a handful of job.json files, whatever the queue's length — and, when a
 * heavy job is queued, what holds heavy work once per poll (queue.takeHold: the unfinished jobs and the markers).
 */
import { heldWork } from '../jobs/held.js';
import type { HeldWork } from '../jobs/held.js';
import { FileJobQueue } from '../jobs/queue.js';
import { FINISHED_JOB_STATES } from '../jobs/types.js';
import type { JobRecord } from '../jobs/types.js';

function signature(j: JobRecord): string {
  // L5.14: a heavy job held or let go by a take is a change (the Studio says it within one poll).
  return JSON.stringify([j.state, j.progress ?? null, j.cancel_requested_at ?? null, j.started_at ?? null, j.finished_at ?? null, j.yield?.state ?? null, j.yield?.cause ?? null]);
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

  /** L5.14: what a filming take holds of this workspace's jobs at the last poll (heavy jobs waiting or slowed). */
  held(): HeldWork | undefined {
    return heldWork([...this.records.values()].filter((j) => !FINISHED_JOB_STATES.has(j.state)));
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
    // What holds heavy work, read once for the whole poll (review A M1 / B L8: not once per queued heavy job).
    let hold: Promise<'here' | 'elsewhere' | undefined> | undefined;
    const once = () => (hold ??= this.queue.takeHold());
    for (const id of look) {
      const job = await this.queue.get(id, { hold: once }).catch(() => undefined);
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
