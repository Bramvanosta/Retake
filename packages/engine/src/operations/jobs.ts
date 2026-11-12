/**
 * The job operations (moved from the MCP server's tools/jobs.ts): job_list, which the shells share (L7.13), and
 * job_cancel with the job id argument job_status takes too (L7.15).
 */
import { z } from 'zod';
import { JOB_ID_RE, JOB_STATES } from '@retake/core';
import { JOB_CANCEL, READ } from './annotations.js';
import { defineOperation } from './define.js';
import { jobData, jobLine } from './job-lines.js';
import { projectSlug } from './schema.js';
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
