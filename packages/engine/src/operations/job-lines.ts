/**
 * How a tool shows a job: its one summary line (jobLine), its error line (jobErrorLine), the job as data with an error
 * that can quote the product kept under `untrusted` (untrustedError, jobData), and a preview job's stills
 * (previewImages). Shared by job_list (jobs.ts), the MCP server's job_status and the tools that submit jobs (moved from
 * the MCP server's tools/job-lines.ts in L7.13).
 */
import { jobProject } from '../jobs/queue-core.js';
import { yieldWords } from '../jobs/held.js';
import type { JobRecord } from '../jobs/types.js';
import type { ToolImage } from './define.js';
import { jobOutcome, jobProgress, jobWhat } from './job-words.js';

/**
 * Kinds whose error message can quote the filmed product or the scenario (a page's text, a caption, a component's
 * error, ffmpeg on a render's file, a re-render's): outside an `interrupted` job (a message the engine writes), it is
 * shown only under `untrusted.error`.
 */
const PRODUCT_TEXT_KINDS: ReadonlySet<JobRecord['kind']> = new Set(['run', 'render', 'preview', 'review', 'export', 'inspect', 'record', 'site']);

/** Whether `job`'s error message is kept under `untrusted` (never in the summary nor the job's own fields). */
export function untrustedError(job: JobRecord): boolean {
  return !!job.error && job.state !== 'interrupted' && PRODUCT_TEXT_KINDS.has(job.input.kind);
}

/** A job as a tool returns it (jobData): its record, with an error message that can quote the product under `untrusted.error`. */
export type JobData = JobRecord & { untrusted?: { error: string } };

/** A job as a tool returns it: an error message that can quote the product moved to `untrusted.error`. */
export function jobData(job: JobRecord): JobData {
  if (!untrustedError(job)) return job;
  return { ...job, error: { ...job.error!, message: 'the message is in "untrusted.error"' }, untrusted: { error: job.error!.message } };
}

/** The summary line of a job's error: its message, or (untrustedError) its code and where the message is. */
export function jobErrorLine(job: JobRecord, fixLead = ' — fix: '): string | undefined {
  if (!job.error) return undefined;
  const fix = job.error.fix ? `${fixLead}${job.error.fix}` : '';
  return untrustedError(job) ? `${job.state}: ${job.error.code} — the message is in "untrusted.error" (it can quote the scenario or the filmed site)${fix}` : `${job.error.message}${fix}`;
}

/** The stills of a finished preview job, labelled for the client (kind, component, second shown). */
export function previewImages(job: JobRecord): ToolImage[] {
  const r = job.result;
  if (job.state !== 'succeeded' || r?.kind !== 'preview') return [];
  return r.images.map((i) => ({ label: `${r.target.kind === 'theme' ? `${i.kind}: ` : ''}${i.component} (${r.theme} theme, at ${i.at} s)`, file: i.file }));
}

/** "j_… run quote (dry) → 20261017-142233-quote in northfield-fixture: running · 3/12 steps · scenes". */
export function jobLine(j: JobRecord): string {
  const progress = j.progress && j.state === 'running' ? ` · ${jobProgress(j.progress)}` : '';
  const result = j.result ? ` · ${jobOutcome(j.result, 'brief')}` : '';
  // A heavy job a filming take holds (data: `yield`, an enum; where the take films is never named).
  const held = j.yield ? ` · ${yieldWords(j.yield)}` : '';
  return `${j.id} ${jobWhat(j.input)} in ${jobProject(j.input) ?? 'the workspace'}: ${j.state}${held}${progress}${result}${j.cancel_requested_at && j.state !== 'cancelled' ? ' (cancel requested)' : ''}`;
}
