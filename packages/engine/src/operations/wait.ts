/**
 * Waiting on a job inside a call (moved from the MCP server's tools/run.ts in L7.13): the long-poll budgets, the
 * `wait_s` argument and the wait itself, with progress notifications; the call's cancel ends the wait, never the job.
 */
import { z } from 'zod';
import type { Engine } from '../engine.js';
import type { JobRecord } from '../jobs/types.js';
import type { ToolContext } from './define.js';

/** Long-poll budget of one call (s): no call outlives an agent's tool timeout. */
export const WAIT_MAX_S = 25;
/** job_status's own budget (L5.8, R-FLD-34): a capture or a render followed in one call instead of a side script. */
export const JOB_WAIT_MAX_S = 600;
/** While a long wait lasts, a progress notification at least this often (clients that time out without one). */
export const WAIT_HEARTBEAT_MS = 15_000;

export const waitS = (def: number, what: string, max = WAIT_MAX_S) =>
  z
    .number()
    .int()
    .min(0)
    .max(max)
    .default(def)
    .describe(`Wait up to this many seconds (0–${max}, default ${def}) for ${what} before answering; progress notifications are sent meanwhile. Call the status tool (run_status, render_status, job_status) again to keep following.`);

/** Wait on a job (when asked) with progress notifications; the call's cancel ends the wait, never the job. */
export async function waitJob(engine: Engine, job: JobRecord, seconds: number, ctx: ToolContext): Promise<void> {
  if (seconds <= 0) return;
  let last = job;
  const report = (j: JobRecord) => {
    last = j;
    const p = j.progress;
    // A job that knows its overall progress (a render) reports percent; others report steps.
    const pct = p?.fraction !== undefined ? Math.round(p.fraction * 100) : undefined;
    ctx.progress?.({
      progress: pct ?? p?.steps_done ?? 0,
      ...(pct !== undefined ? { total: 100 } : p?.steps_total ? { total: p.steps_total } : {}),
      message: `${j.state}${p?.current ? ` · ${p.current.scene}.${p.current.step} ${p.current.action}` : p?.phase ? ` · ${p.phase}` : ''}`,
    });
  };
  report(job);
  // A long wait (job_status) says it is alive even when nothing changes (a render's encoding, a long hold).
  const beat = seconds * 1000 > WAIT_HEARTBEAT_MS ? setInterval(() => report(last), WAIT_HEARTBEAT_MS) : undefined;
  try {
    await engine.jobs.wait(job.id, { timeoutMs: seconds * 1000, signal: ctx.signal, onChange: report });
  } finally {
    if (beat) clearInterval(beat);
  }
}
