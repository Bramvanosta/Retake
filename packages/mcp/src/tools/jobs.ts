import { z } from 'zod';
import { JOB_ID_RE, JOB_STATES } from '@demo-studio/core';
import type { JobRecord } from '@demo-studio/engine';
import { projectSlug } from '../schema.js';
import { plural } from '../result.js';
import { CANCEL, READ, defineTool } from './define.js';
import type { ToolDef } from './define.js';
import { waitJob, waitS } from './run.js';

const jobId = z.string().regex(JOB_ID_RE, 'a job id: j_ followed by 26 characters (job_list names them)').describe('Job id (from run_dry, run_capture, hooks_run, env_reset or job_list).');

/** "j_… run quote (dry) on northfield-fixture: running · 3/12 steps · scenes". */
function jobLine(j: JobRecord): string {
  const i = j.input;
  const on = i.env ? ` on ${i.env}` : '';
  const what =
    i.kind === 'run'
      ? `run ${i.scenario} (${i.mode}) → ${i.run_id}`
      : i.kind === 'hooks'
        ? `hooks ${i.source}${i.dry ? ' (dry)' : ''}${on}`
        : i.kind === 'env_reset'
          ? `env_reset${i.dry ? ' (dry)' : ''}${on}`
          : i.kind === 'auth_login'
            ? `sign-in of ${i.persona ?? 'the persona'} (${i.mode})${on}`
            : `${i.kind === 'sandbox_up' ? 'sandbox up' : `sandbox reset${i.reseed ? ' (reseed)' : ''}`}${on}`;
  const p = j.progress;
  const progress = p && j.state === 'running' ? ` · ${p.steps_done}/${p.steps_total} steps${p.current ? ` · ${p.current.scene}.${p.current.step} ${p.current.action}` : p.phase ? ` · ${p.phase}` : ''}` : '';
  const r = j.result;
  const result = !r
    ? ''
    : r.kind === 'run'
      ? ` · run ${r.status}`
      : r.kind === 'auth_login'
        ? ` · ${r.signed_in ? 'signed in' : `not signed in (${r.status})`}`
        : r.kind === 'hooks' || r.kind === 'env_reset'
          ? ` · ${r.ok ? 'ok' : 'with failures'}`
          : ` · ${r.reset ? `reset ${r.reset.strategy}` : 'up, no seed needed'}`;
  return `${j.id} ${what} in ${j.input.project}: ${j.state}${progress}${result}${j.cancel_requested_at && j.state !== 'cancelled' ? ' (cancel requested)' : ''}`;
}

export const jobList = defineTool({
  name: 'job_list',
  title: 'List jobs',
  description:
    'Jobs of the workspace, newest first: dry runs, captures, hooks and environment resets submitted through this server (by any session), with their state (queued, running, succeeded, failed, cancelled, interrupted) and progress. A job "succeeded" when it ran to the end; its run may still have failed (result.status).',
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
      data: { jobs, worker: worker ? { pid: worker.pid, since: worker.since, build: worker.build } : null },
    };
  },
});

export const jobStatus = defineTool({
  name: 'job_status',
  title: 'Status of a job',
  description:
    'One job: its input, state, progress, place in the queue, result (for a run: the run id and its status — run_status has the details; for hooks and resets: each hook\'s outcome) or why it failed. wait_s long-polls until it finishes. A job is "interrupted" when its worker died while it ran: its run stopped where it was and the fix names the environment reset a human runs.',
  input: z.strictObject({ job_id: jobId, wait_s: waitS(0, 'the job to finish') }),
  annotations: READ,
  async run({ job_id, wait_s }, ctx) {
    const { engine } = ctx;
    let job = await engine.jobs.get(job_id);
    if (wait_s > 0) {
      await waitJob(engine, job, wait_s, ctx);
      job = await engine.jobs.get(job_id);
    }
    const position = job.state === 'queued' ? await engine.jobs.position(job_id) : undefined;
    return {
      summary: [
        jobLine(job),
        ...(position ? [position.ahead ? `${plural(position.ahead, 'job')} ahead${position.running ? ` (running: ${position.running})` : ''}` : 'next in the queue'] : []),
        ...(job.error ? [`${job.error.message}${job.error.fix ? ` — fix: ${job.error.fix}` : ''}`] : []),
        ...(job.result?.kind === 'run' ? [`run_status {project: "${job.input.project}", run_id: "${job.result.run_id}"} has the run's details`] : []),
      ].join('\n'),
      data: { ...job, ...(position ? { queue: position } : {}) } as unknown as Record<string, unknown>,
    };
  },
});

export const jobCancel = defineTool({
  name: 'job_cancel',
  title: 'Cancel a job',
  description: 'Cancel a job: a queued one never starts; a running run stops at its next step, then its teardown and pending rollbacks still run. Finished jobs are left as they are.',
  input: z.strictObject({ job_id: jobId }),
  annotations: CANCEL,
  async run({ job_id }, { engine }) {
    const job = await engine.jobs.cancel(job_id);
    const what = job.state === 'cancelled' ? 'cancelled' : job.state === 'running' || job.state === 'queued' ? 'cancel requested (teardown and rollbacks run first)' : `already ${job.state}`;
    return { summary: `${jobLine(job)}\n${what}.`, data: job as unknown as Record<string, unknown> };
  },
});

export const JOB_TOOLS: ToolDef[] = [jobList, jobStatus, jobCancel];
