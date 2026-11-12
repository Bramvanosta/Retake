/**
 * The job operations the shells share (moved from the MCP server's tools/jobs.ts in L7.13): job_list.
 */
import { z } from 'zod';
import { JOB_STATES } from '@retake/core';
import { READ } from './annotations.js';
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
