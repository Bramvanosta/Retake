/**
 * Which queued job a worker's slot takes next (L5.14, captures first): a pure function over the stored records, oldest
 * first (job ids sort by creation time). The class is this build's JOB_CLASS of the kind the job's input runs; nothing
 * else in job.json orders the queue. Hooks, environment resets and sandboxes are captures: they stay one at a time with
 * each other and with the takes (the hooks journal is not written for concurrent use).
 *
 * - `capture` slot: the oldest queued capture-class job (core JOB_CLASS; an unknown kind counts as a capture so the
 *   worker refuses it as before). Captures go before any heavy job whatever their age.
 * - `heavy` slot: nothing while a filming take (core isFilming) of this workspace waits in the queue — a take queued
 *   behind a recording or a sign-in holds heavy claims too; a cancelled one holds nothing (review B L7) —, nor while
 *   something films now (`filmingLive`: a filming marker of this user, or the worker's own take while it films — not
 *   during its setup or teardown hooks, not while it is paused: review B M3); else the oldest queued heavy job.
 */
import { isFilming, jobClass } from '@retake/core';
import type { JobClass, JobState } from '@retake/core';

export interface PickRecord {
  id: string;
  state: JobState;
  kind: string;
  input: unknown;
  /** A claim file exists (a worker took it: not queued for anyone else). */
  claimed: boolean;
  /** A cancel was asked (a queued job then closes without running: it holds nothing). */
  cancelled?: boolean;
}

export interface PickContext {
  slot: JobClass;
  /** Something films now: a filming marker of this user (any workspace, any terminal), or the worker's own take. */
  filmingLive: boolean;
}

/** A filming take of this workspace waiting to be claimed: it holds heavy claims until a capture slot takes it. */
export function takeWaiting(r: Pick<PickRecord, 'state' | 'claimed' | 'cancelled' | 'input'>): boolean {
  return r.state === 'queued' && !r.claimed && r.cancelled !== true && isFilming(r.input);
}

/** The id the slot claims next, or undefined (none, or heavy work held). */
export function pick(records: readonly PickRecord[], ctx: PickContext): string | undefined {
  const open = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ctx.slot === 'heavy') {
    if (ctx.filmingLive) return undefined;
    if (open.some(takeWaiting)) return undefined;
  }
  // A cancelled job is still claimed (its slot closes it without running it).
  return open.find((r) => r.state === 'queued' && !r.claimed && jobClass(r.kind) === ctx.slot)?.id;
}
