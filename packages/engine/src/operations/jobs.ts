/**
 * The job operations (moved from the MCP server's tools/jobs.ts): job_list, which the shells share (L7.13),
 * job_cancel with the job id argument job_status takes too (L7.15), and job_status (L7.18: its recording answer is
 * scenario_record's `recordOutput`, its site and inspection answers template_from_site's and page_inspect's).
 */
import { z } from 'zod';
import { JOB_ID_RE, JOB_STATES } from '@retake/core';
import { JOB_CANCEL, READ } from './annotations.js';
import { recordOutput } from './authoring.js';
import { detail } from './compact.js';
import { defineOperation } from './define.js';
import { inspectOutput } from './inspect.js';
import { jobData, jobErrorLine, jobLine, previewImages } from './job-lines.js';
import { projectSlug } from './schema.js';
import { siteOutput } from './themes.js';
import { JOB_WAIT_MAX_S, waitJob, waitS } from './wait.js';
import { plural } from './words.js';

export const jobList = defineOperation({
  name: 'job_list',
  title: 'List jobs',
  description:
    'Jobs of the workspace, newest first: dry runs, captures, renders, reviews, exports, hooks and environment resets submitted through this server (by any session), with their state (queued, running, succeeded, failed, cancelled, interrupted) and progress. A job "succeeded" when it ran to the end; its run may still have failed (result.status).',
  input: z.strictObject({
    project: projectSlug.optional().describe('Only the jobs of this project.'),
    state: z.array(z.enum(JOB_STATES)).optional().describe('Only jobs in these states.'),
    limit: z.number().int().min(1).max(200).default(20).describe('At most this many jobs (default 20).'),
  }),
  annotations: READ,
  async run({ project, state, limit }, { engine }) {
    const jobs = await engine.jobs.list({ project, states: state, limit });
    const worker = await engine.jobs.worker();
    return {
      summary: [
        jobs.length ? `${plural(jobs.length, 'job')}:\n${jobs.map((j) => `- ${jobLine(j)}`).join('\n')}` : 'No job yet.',
        `worker: ${worker ? `running (pid ${worker.pid})` : 'not running (it starts when a job is submitted)'}`,
      ].join('\n'),
      data: { jobs: jobs.map(jobData), worker: worker ? { pid: worker.pid, since: worker.since, build: worker.build } : null },
    };
  },
});

/** A job id argument (job_status's and job_cancel's). */
export const jobId = z.string().regex(JOB_ID_RE, 'a job id: j_ followed by 26 characters (job_list names them)').describe('Job id (from run_dry, run_capture, render, review, export, component_preview, template_preview, template_from_site, page_inspect, scenario_record, hooks_run, env_reset or job_list).');

/** Where a queued job stands, in words (L5.14: a heavy job a take holds waits for it whatever its place). */
function queueWords(position: { ahead: number; running?: string; held_by?: 'take' }): string {
  if (position.held_by === 'take') return `waiting for a take to finish${position.ahead ? ` (${plural(position.ahead, 'job')} ahead)` : ''}`;
  return position.ahead ? `${plural(position.ahead, 'job')} ahead${position.running ? ` (running: ${position.running})` : ''}` : 'next in the queue';
}

export const jobStatus = defineOperation({
  name: 'job_status',
  title: 'Status of a job',
  description:
    'One job: its input, state, progress, place in the queue, result (for a run: the run id and its status — run_status has the details; for hooks and resets: each hook\'s outcome; for a preview: its stills as images; for an inspection: the page_inspect result with its marked screenshot; for a recording: the draft scenario; for a site extraction: the template_from_site result with its screenshot and logo candidates) or why it failed. wait_s long-polls until it finishes — up to 600 s here (a capture, a render, a review followed in one call), with a progress notification at least every 15 s. A job is "interrupted" when its worker died while it ran: its run stopped where it was and the fix names the environment reset a human runs.',
  input: z.strictObject({
    job_id: jobId,
    detail: detail.describe('For an inspection: "compact" (default) or "full", as page_inspect.'),
    wait_s: waitS(0, 'the job to finish (up to 10 minutes: a capture or a render followed in one call)', JOB_WAIT_MAX_S),
  }),
  annotations: READ,
  async run({ job_id, detail: level, wait_s }, ctx) {
    const { engine } = ctx;
    let job = await engine.jobs.get(job_id);
    if (wait_s > 0) {
      await waitJob(engine, job, wait_s, ctx);
      job = await engine.jobs.get(job_id);
    }
    const position = job.state === 'queued' ? await engine.jobs.position(job_id) : undefined;
    if (job.input.kind === 'record') {
      // A recording: while the window is open, what the user does; once finished, the draft read from its folder.
      const out = await recordOutput(engine, job);
      const ahead = position ? [queueWords(position)] : [];
      // The result is the data itself: not repeated under `job`.
      const { result: _result, ...rest } = jobData(job);
      return { summary: [out.summary, ...ahead].join('\n'), data: { ...out.data, job: { ...rest, ...(position ? { queue: position } : {}) } } };
    }
    if (job.input.kind === 'site') {
      // A site extraction that outlived template_from_site's wait: the same result (site.json read back, images included).
      const out = await siteOutput(engine, job);
      const ahead = position ? [queueWords(position)] : [];
      const { result: _result, ...rest } = jobData(job);
      return { summary: [out.summary, ...ahead].join('\n'), data: { ...out.data, job: { ...rest, ...(position ? { queue: position } : {}) } }, ...(out.images ? { images: out.images } : {}) };
    }
    if (job.input.kind === 'inspect') {
      // An inspection that outlived page_inspect's wait: the same result (marked screenshot included), with the job.
      const out = await inspectOutput(engine, job, [], level);
      const ahead = position ? [queueWords(position)] : [];
      return { summary: [out.summary, ...ahead].join('\n'), data: { ...out.data, job: { ...jobData(job), ...(position ? { queue: position } : {}) } }, ...(out.images ? { images: out.images } : {}) };
    }
    return {
      summary: [
        jobLine(job),
        ...(position ? [queueWords(position)] : []),
        // A failure that can quote the product (a page, a caption, a component's error): only under untrusted.error.
        ...(job.error ? [jobErrorLine(job)!] : []),
        ...(job.result?.kind === 'run' && job.input.kind === 'run' ? [`run_status {project: "${job.input.project}", run_id: "${job.result.run_id}"} has the run's details`] : []),
        ...(job.input.kind === 'render' ? [`render_status {project: "${job.input.project}", render_id: "${job.input.render_id}"} has the render's details`] : []),
        ...(job.input.kind === 'review' ? [`review_get {project: "${job.input.project}", render_id: "${job.input.render_id}"} reads the review (with its contact sheet)`] : []),
        ...(job.result?.kind === 'preview' ? [`preview images in ${job.result.dir} (shown below)`] : []),
        ...(job.result?.kind === 'export' ? [...job.result.outputs.map((o) => `${o.format} (${o.method}): ${o.file}`), `manifest: ${job.result.manifest}`, ...(job.result.failed.length ? [`failed: ${job.result.failed.join(', ')} (messages in result.untrusted.failures)`] : [])] : []),
      ].join('\n'),
      // A finished preview: its folder and stills where template_preview / component_preview put them (a client reads
      // `stills` whichever tool answered).
      data: { ...jobData(job), ...(job.state === 'succeeded' && job.result?.kind === 'preview' ? { dir: job.result.dir, stills: job.result.images } : {}), ...(position ? { queue: position } : {}) },
      // A finished preview's stills (component_preview / template_preview that outlived their wait).
      ...(previewImages(job).length ? { images: previewImages(job) } : {}),
    };
  },
});

export const jobCancel = defineOperation({
  name: 'job_cancel',
  title: 'Cancel a job',
  description: 'Cancel a job: a queued one never starts; a running run stops at its next step, then its teardown and pending rollbacks still run; a recording whose window is open is discarded (after it, only its check replay stops). Finished jobs are left as they are.',
  input: z.strictObject({ job_id: jobId }),
  annotations: JOB_CANCEL,
  async run({ job_id }, { engine }) {
    const job = await engine.jobs.cancel(job_id);
    const what = job.state === 'cancelled' ? 'cancelled' : job.state === 'running' || job.state === 'queued' ? 'cancel requested (teardown and rollbacks run first)' : `already ${job.state}`;
    return { summary: `${jobLine(job)}\n${what}.`, data: jobData(job) };
  },
});
