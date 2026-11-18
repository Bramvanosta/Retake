/**
 * Which queued job a worker's slot takes next (captures first): a pure function over the stored records, oldest
 * first (job ids sort by creation time). The class is this build's JOB_CLASS of the kind the job's input runs; nothing
 * else in job.json orders the queue. Hooks, environment resets and sandboxes are captures: they stay one at a time with
 * each other and with the takes (the hooks journal is not written for concurrent use).
 *
 * - `capture` slot: the oldest queued capture-class job (job-input.ts JOB_CLASS; an unknown kind counts as a capture so the
 *   worker refuses it as before). Captures go before any heavy job whatever their age.
 * - Either slot: a job whose kind needs a Tool of the app that is not downloaded yet is skipped (`blocked`).
 * - `heavy` slot: nothing while a filming take (core isFilming) of this workspace waits in the queue — a take queued
 *   behind a recording or a sign-in holds heavy claims too; a cancelled one holds nothing —, nor while something films
 *   now (`filmingLive`: a filming marker of this user, or the worker's own take while it films — not during its setup
 *   or teardown hooks, not while it is paused); else the oldest queued heavy job.
 */
import { isFilming, jobClass, jobNeeds } from './job-input.js';
import type { ToolNeed } from '@retake/core/io';
import type { JobClass, JobState } from './job-input.js';

export interface PickRecord {
  id: string;
  state: JobState;
  kind: string;
  input: unknown;
  /** A claim file exists (a worker took it: not queued for anyone else). */
  claimed: boolean;
  /** A cancel was asked (a queued job then closes without running: it holds nothing). */
  cancelled?: boolean;
  /** What it needs of the Tools (the queue's toolNeed: its project's own browser needs none); default its kind's. */
  needs?: ToolNeed | null;
}

export interface PickContext {
  slot: JobClass;
  /** Something films now: a filming marker of this user (any workspace, any terminal), or the worker's own take. */
  filmingLive: boolean;
  /**
   * The needs of the app's Tools that are missing now (engine tools/gate.ts; empty in a checkout): a job whose kind needs
   * one (job-input.ts JOB_TOOLS) is skipped — never an early return, so the slot's other jobs go on — and a take it
   * holds back holds no heavy job either.
   */
  blocked?: ReadonlySet<ToolNeed>;
}

/** Does the job's kind need a Tool that is missing now? */
function held(r: Pick<PickRecord, 'kind' | 'needs'>, blocked: ReadonlySet<ToolNeed> | undefined): boolean {
  const need = r.needs !== undefined ? r.needs : jobNeeds(r.kind);
  return need !== null && !!blocked?.has(need);
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
    // A take that waits for the browser films nothing: it holds no heavy job.
    if (open.some((r) => takeWaiting(r) && !held(r, ctx.blocked))) return undefined;
  }
  // A cancelled job is still claimed (its slot closes it without running it).
  return open.find((r) => r.state === 'queued' && !r.claimed && jobClass(r.kind) === ctx.slot && !held(r, ctx.blocked))?.id;
}
