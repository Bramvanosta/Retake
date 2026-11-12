/**
 * Compact results (L5.8, R-FLD-34): the `detail` argument and the run status as run_status returns it by default — the
 * status, where it failed, the paths to read — and, with `detail: "full"`, everything as before (moved from the MCP
 * server's compact.ts in L7.13 with run_status; the review's and the inspection's compacts stay there for now).
 * Nothing the summary says is dropped: run.json keeps the rest.
 *
 * Trust is unchanged: what the filmed site or the scenario wrote stays under `untrusted` (capUntrusted still applies).
 */
import { z } from 'zod';
import { perfSummary } from '@retake/core';
import type { CompactRunStatus, RunStatusWithJob } from '../facade/types.js';

export const detail = z
  .enum(['compact', 'full'])
  .default('compact')
  .describe('"compact" (default): what to act on — status, where it failed, findings, the paths to read; "full": every field (all elements, files, timings), several times longer.');

export type Detail = z.infer<typeof detail>;

/** Warnings a compact run status carries (the rest are counted; run.json and log.jsonl have them all). */
export const COMPACT_WARNINGS_MAX = 8;
/** Findings a compact review carries besides its errors (every error is kept). */
export const COMPACT_FINDINGS_MAX = 30;
/** Characters of one untrusted message in a compact result. */
export const COMPACT_MESSAGE_MAX = 400;

/** One untrusted message of a compact result, cut to `max` characters (saying how many more). */
export const cutMessage = (s: string, max = COMPACT_MESSAGE_MAX): string => (s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s);

/** A run's status, compact: no per-step screenshot list, no hashes, the take's cost as one line. */
export function compactRunStatus(r: RunStatusWithJob): CompactRunStatus {
  const out = (name: string) => r.outputs.find((o) => o.ref.endsWith(`/${name}`))?.path;
  const hooks = Object.fromEntries(Object.entries(r.hooks).filter(([, v]) => v !== undefined && v !== 'none'));
  const warnings = r.untrusted.warnings;
  return {
    id: r.id,
    project: r.project,
    scenario: r.scenario,
    mode: r.mode,
    env: r.env,
    status: r.status,
    finished: r.finished,
    steps_done: r.steps_done,
    steps_total: r.steps_total,
    ...(r.duration_ms !== undefined ? { duration_s: Math.round(r.duration_ms / 100) / 10 } : {}),
    ...(r.current && !r.finished ? { current: r.current } : {}),
    ...(r.paused && !r.finished ? { paused: r.paused } : {}),
    ...(r.stopped_at ? { stopped_at: r.stopped_at } : {}),
    ...(Object.keys(hooks).length ? { hooks } : {}),
    ...(r.error
      ? {
          error: {
            ...(r.error.scene !== undefined ? { scene: r.error.scene } : {}),
            ...(r.error.step !== undefined ? { step: r.error.step } : {}),
            ...(r.error.action !== undefined ? { action: r.error.action } : {}),
            ...(r.error.screenshot ? { screenshot: r.error.screenshot.path } : {}),
            ...(r.error.dom ? { dom: r.error.dom.path } : {}),
          },
        }
      : {}),
    ...(r.optional_failures?.length ? { optional_failures: r.optional_failures.map((f) => ({ scene: f.scene, step: f.step, action: f.action, ...(f.screenshot ? { screenshot: f.screenshot.path } : {}) })) } : {}),
    ...(r.perf ? { perf: perfSummary(r.perf) } : {}),
    files: {
      dir: r.dir,
      ...(out('capture.mp4') ? { capture: out('capture.mp4') } : {}),
      ...(out('timeline.json') ? { timeline: out('timeline.json') } : {}),
      ...(r.screenshots.length ? { screenshots: { dir: `${r.dir}/screenshots`, count: r.screenshots.length } } : {}),
    },
    ...(r.job ? { job: { id: r.job.id, state: r.job.state, ...(r.job.queue ? { queue: r.job.queue } : {}), ...(r.job.cancel_requested_at ? { cancel_requested_at: r.job.cancel_requested_at } : {}), ...(r.job.pause_requested_at ? { pause_requested_at: r.job.pause_requested_at } : {}), ...(r.job.error ? { error: r.job.error } : {}) } } : {}),
    untrusted: {
      ...(r.untrusted.error_message !== undefined ? { error_message: r.untrusted.error_message } : {}),
      ...(r.untrusted.missing_targets?.length ? { missing_targets: r.untrusted.missing_targets } : {}),
      ...(r.untrusted.optional_errors?.length ? { optional_errors: r.untrusted.optional_errors.map((m) => cutMessage(m)) } : {}),
      ...(warnings.length ? { warnings: warnings.slice(0, COMPACT_WARNINGS_MAX).map((w) => cutMessage(w)) } : {}),
      ...(warnings.length > COMPACT_WARNINGS_MAX ? { warnings_total: warnings.length } : {}),
    },
  };
}
