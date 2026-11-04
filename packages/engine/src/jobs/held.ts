/**
 * Captures first in words (L5.14): what a heavy job held by a filming take is doing (JobRecord.yield), said the same
 * way by the Studio, MCP and `retake jobs`. Fixed words only: where the take films is "in this workspace" or
 * "elsewhere on this Mac", never named.
 */
import type { JobKind } from '@retake/core';
import type { JobRecord, JobYield } from './types.js';

const WHERE: Record<JobYield['cause'], string> = { here: 'in this workspace', elsewhere: 'elsewhere on this Mac' };

/** "waiting for a take to finish (in this workspace)", "slowed during a take (elsewhere on this Mac)". */
export function yieldWords(y: JobYield): string {
  const where = WHERE[y.cause] ?? WHERE.elsewhere;
  if (y.state === 'past_cap') return `going on: a take (${where}) has held heavy work for ${y.cap_min ? `over ${y.cap_min} min` : 'longer than the cap'}`;
  return `${y.state === 'waiting' ? 'waiting for a take to finish' : 'slowed during a take'} (${where})`;
}

/** What a take holds of a workspace's jobs now: the first heavy job slowed (else waiting), and how many are held. */
export interface HeldWork {
  state: JobYield['state'];
  cause: JobYield['cause'];
  kind: JobKind;
  /** Heavy jobs held (waiting or slowed). */
  count: number;
}

/** HeldWork of a list of jobs (derived records), or undefined when no take holds any. */
export function heldWork(jobs: readonly JobRecord[]): HeldWork | undefined {
  const held = jobs.filter((j) => j.yield && (j.state === 'queued' || j.state === 'running'));
  if (!held.length) return undefined;
  const first = held.find((j) => j.yield!.state === 'background') ?? held[0]!;
  return { state: first.yield!.state, cause: first.yield!.cause, kind: first.kind, count: held.length };
}

/** "a render is slowed during a take (in this workspace)", "2 jobs wait for a take to finish (elsewhere on this Mac)". */
export function heldWorkWords(h: HeldWork): string {
  const what = h.count > 1 ? `${h.count} jobs` : `${/^[aeiou]/.test(h.kind) ? 'an' : 'a'} ${h.kind.replace(/_/g, ' ')}`;
  if (h.state === 'background') return `${what} ${h.count > 1 ? 'are' : 'is'} slowed during a take (${WHERE[h.cause]})`;
  if (h.state === 'past_cap') return `${what} ${h.count > 1 ? 'go' : 'goes'} on: a take (${WHERE[h.cause]}) has held heavy work for longer than the cap`;
  return `${what} ${h.count > 1 ? 'wait' : 'waits'} for a take to finish (${WHERE[h.cause]})`;
}
