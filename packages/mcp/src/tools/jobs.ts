/**
 * The MCP server's job tools: job_list (L7.13) and job_cancel (L7.15) are the engine's operations, served here as these
 * very objects in tools/list order; job_status stays here until its recording answer (recordOutput, tools/authoring.ts)
 * is the engine's too — its inspection and site answers are the contract's already.
 */
import { z } from 'zod';
import { JOB_WAIT_MAX_S, OPERATIONS_BY_NAME, detail, inspectOutput, jobData, jobErrorLine, jobId, jobLine, previewImages, siteOutput, waitJob, waitS } from '@retake/engine/contract';
import { plural } from '../result.js';
import { READ, defineTool } from './define.js';
import type { ToolDef } from './define.js';

const { job_list: jobList, job_cancel: jobCancel } = OPERATIONS_BY_NAME;

/** Where a queued job stands, in words (L5.14: a heavy job a take holds waits for it whatever its place). */
function queueWords(position: { ahead: number; running?: string; held_by?: 'take' }): string {
  if (position.held_by === 'take') return `waiting for a take to finish${position.ahead ? ` (${plural(position.ahead, 'job')} ahead)` : ''}`;
  return position.ahead ? `${plural(position.ahead, 'job')} ahead${position.running ? ` (running: ${position.running})` : ''}` : 'next in the queue';
}

export const jobStatus = defineTool({
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
      const { recordOutput } = await import('./authoring.js');
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

export const JOB_TOOLS = [jobList, jobStatus, jobCancel] as const satisfies readonly ToolDef[];
