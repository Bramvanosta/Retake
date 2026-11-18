/**
 * Captures first in words: what a heavy job held by a filming take is doing (JobRecord.yield), said the same
 * way by the Studio, MCP and `retake jobs`. Fixed words only: where the take films is "in this workspace" or
 * "elsewhere on this Mac", never named. And a job held by the Tools: what it waits for.
 */
import type { JobKind } from './job-input.js';
import type { JobRecord, JobYield } from './types.js';

const WHERE: Record<Exclude<JobYield['cause'], 'tools'>, string> = { here: 'in this workspace', elsewhere: 'elsewhere on this Mac' };
const whereOf = (cause: JobYield['cause']) => (cause === 'tools' ? WHERE.elsewhere : (WHERE[cause] ?? WHERE.elsewhere));

/** What a job held by the Tools waits for: "the browser", "the render tools" (the render browser and the compositor). */
export function needsWords(needs: JobYield['needs']): string {
  return needs === 'browser' ? 'the browser' : 'the render tools';
}

/**
 * "waiting for a take to finish (in this workspace)", "slowed during a take (elsewhere on this Mac)", "waiting for the
 * browser to be downloaded (it starts by itself once checked)".
 */
export function yieldWords(y: JobYield): string {
  if (y.cause === 'tools') return `waiting for ${needsWords(y.needs)} to be downloaded (it starts by itself once checked)`;
  const where = whereOf(y.cause);
  if (y.state === 'past_cap') return `going on: a take (${where}) has held heavy work for ${y.cap_min ? `over ${y.cap_min} min` : 'longer than the cap'}`;
  return `${y.state === 'waiting' ? 'waiting for a take to finish' : 'slowed during a take'} (${where})`;
}

/**
 * What holds a workspace's jobs now: a take (the first heavy job slowed, else waiting) or the Tools (`cause: 'tools'`:
 * jobs that wait for a Tool not downloaded yet), and how many are held.
 */
export interface HeldWork {
  state: JobYield['state'];
  cause: JobYield['cause'];
  /** `cause: 'tools'`: what the first one waits for. */
  needs?: JobYield['needs'];
  kind: JobKind;
  /** Heavy jobs held (waiting or slowed). */
  count: number;
}

/** HeldWork of a list of jobs (derived records), or undefined when no take holds any. */
export function heldWork(jobs: readonly JobRecord[]): HeldWork | undefined {
  const held = jobs.filter((j) => j.yield && (j.state === 'queued' || j.state === 'running'));
  if (!held.length) return undefined;
  const first = held.find((j) => j.yield!.state === 'background') ?? held[0]!;
  return { state: first.yield!.state, cause: first.yield!.cause, ...(first.yield!.needs ? { needs: first.yield!.needs } : {}), kind: first.kind, count: held.length };
}

/** "a render is slowed during a take (in this workspace)", "2 jobs wait for a take to finish (elsewhere on this Mac)". */
export function heldWorkWords(h: HeldWork): string {
  const what = h.count > 1 ? `${h.count} jobs` : `${/^[aeiou]/.test(h.kind) ? 'an' : 'a'} ${h.kind.replace(/_/g, ' ')}`;
  if (h.cause === 'tools') return `${what} ${h.count > 1 ? 'wait' : 'waits'} for ${needsWords(h.needs)} to be downloaded`;
  if (h.state === 'background') return `${what} ${h.count > 1 ? 'are' : 'is'} slowed during a take (${whereOf(h.cause)})`;
  if (h.state === 'past_cap') return `${what} ${h.count > 1 ? 'go' : 'goes'} on: a take (${whereOf(h.cause)}) has held heavy work for longer than the cap`;
  return `${what} ${h.count > 1 ? 'wait' : 'waits'} for a take to finish (${whereOf(h.cause)})`;
}
