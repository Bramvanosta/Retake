import { z } from 'zod';
import { JOB_ID_RE, JOB_STATES } from '@retake/core';
import { jobProject } from '@retake/engine';
import type { JobRecord } from '@retake/engine';
import type { ToolImage } from '../result.js';
import { projectSlug } from '../schema.js';
import { plural } from '../result.js';
import { CANCEL, READ, defineTool } from './define.js';
import type { ToolDef } from './define.js';
import { JOB_WAIT_MAX_S, waitJob, waitS } from './run.js';
import { detail } from '../compact.js';

const jobId = z.string().regex(JOB_ID_RE, 'a job id: j_ followed by 26 characters (job_list names them)').describe('Job id (from run_dry, run_capture, render, review, export, component_preview, template_preview, template_from_site, page_inspect, scenario_record, hooks_run, env_reset or job_list).');

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

/** A job as a tool returns it: an error message that can quote the product moved to `untrusted.error`. */
export function jobData(job: JobRecord): Record<string, unknown> {
  if (!untrustedError(job)) return job as unknown as Record<string, unknown>;
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

/** "j_… run quote (dry) on northfield-fixture: running · 3/12 steps · scenes". */
export function jobLine(j: JobRecord): string {
  const i = j.input;
  const on = 'env' in i && i.env ? ` on ${i.env}` : '';
  const what =
    i.kind === 'render'
      ? `render ${i.scenario} (run ${i.run_id}${i.template ? `, theme ${i.template}` : ''}) → ${i.render_id}`
      : i.kind === 'review'
        ? `review ${i.render_id}${i.fps === 2 ? ' (2 fps)' : ''}`
        : i.kind === 'export'
          ? `export ${i.render_id} → ${i.formats.join(', ')}`
          : i.kind === 'preview'
            ? `preview of ${i.target.kind === 'component' ? i.target.component : i.target.kind === 'library' ? `${i.target.items.length} library component${i.target.items.length === 1 ? '' : 's'}` : 'the theme'}${i.template ? ` (theme ${i.template})` : ''} → ${i.preview_id}`
          : i.kind === 'run'
      ? `run ${i.scenario} (${i.mode}) → ${i.run_id}`
      : i.kind === 'hooks'
        ? `hooks ${i.source}${i.dry ? ' (dry)' : ''}${on}`
        : i.kind === 'env_reset'
          ? `env_reset${i.dry ? ' (dry)' : ''}${on}`
          : i.kind === 'auth_login'
            ? `sign-in of ${i.persona ?? 'the persona'} (${i.mode})${on}`
            : i.kind === 'inspect'
              ? `inspect ${i.source.kind === 'page' ? `page ${i.source.page} ${i.source.path}` : `scenario ${i.source.scenario}${i.source.until ? ` until ${i.source.until}` : ''}`}${on} → ${i.inspect_id}`
              : i.kind === 'record'
                ? `record ${i.scenario ?? 'a scenario'} from page ${i.source.page} ${i.source.path}${on} → ${i.rec_id}`
                : i.kind === 'site'
                  ? `site extraction of ${i.url} → ${i.site_id}`
                  : `${i.kind === 'sandbox_up' ? 'sandbox up' : `sandbox reset${i.reseed ? ' (reseed)' : ''}`}${on}`;
  const p = j.progress;
  const progress =
    p && j.state === 'running'
      ? p.fraction !== undefined
        ? ` · ${Math.round(p.fraction * 100)} %${p.phase ? ` · ${p.phase}` : ''}${p.eta_s !== undefined ? ` · ~${p.eta_s} s left` : ''}`
        : p.steps_total === 0 && !p.current && p.phase
          ? ` · ${p.phase}`
          : ` · ${p.steps_done}/${p.steps_total} steps${p.current ? ` · ${p.current.scene}.${p.current.step} ${p.current.action}` : p.phase ? ` · ${p.phase}` : ''}`
      : '';
  const r = j.result;
  const result = !r
    ? ''
    : r.kind === 'render'
      ? ` · ${r.duration_s} s ${r.width}×${r.height}`
      : r.kind === 'review'
        ? ` · ${r.clean ? 'clean' : `${r.counts.error} errors, ${r.counts.warning} warnings`}`
        : r.kind === 'export'
          ? ` · ${r.outputs.length} files${r.failed.length ? `, ${r.failed.length} failed` : ''}`
          : r.kind === 'preview'
            ? ` · ${r.images.length} image${r.images.length === 1 ? '' : 's'} (${r.theme} theme)`
          : r.kind === 'run'
      ? ` · run ${r.status}`
      : r.kind === 'auth_login'
        ? ` · ${r.signed_in ? 'signed in' : `not signed in (${r.status})`}`
        : r.kind === 'hooks' || r.kind === 'env_reset'
          ? ` · ${r.ok ? 'ok' : 'with failures'}`
          : r.kind === 'inspect'
            ? ` · ${r.reported ? `${r.status}${r.counts ? `, ${r.counts.listed} elements listed` : ''}` : `not inspected (replay ${r.run_status})`}`
            : r.kind === 'record'
              ? ` · ${r.not_saved === 'nothing_recorded' ? 'nothing recorded' : `${r.stats.steps} steps${r.saved ? ', saved' : ''}, check ${r.check.status}`}`
              : r.kind === 'site'
                ? ` · ${r.status === 'ok' ? `${r.candidates.length} logo candidates` : 'the page could not be read'}`
                : ` · ${r.reset ? `reset ${r.reset.strategy}` : 'up, no seed needed'}`;
  return `${j.id} ${what} in ${jobProject(j.input) ?? 'the workspace'}: ${j.state}${progress}${result}${j.cancel_requested_at && j.state !== 'cancelled' ? ' (cancel requested)' : ''}`;
}

export const jobList = defineTool({
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
      const ahead = position ? [position.ahead ? `${plural(position.ahead, 'job')} ahead${position.running ? ` (running: ${position.running})` : ''}` : 'next in the queue'] : [];
      // The result is the data itself: not repeated under `job`.
      const { result: _result, ...rest } = jobData(job);
      return { summary: [out.summary, ...ahead].join('\n'), data: { ...out.data, job: { ...rest, ...(position ? { queue: position } : {}) } } };
    }
    if (job.input.kind === 'site') {
      // A site extraction that outlived template_from_site's wait: the same result (site.json read back, images included).
      const { siteOutput } = await import('./theme.js');
      const out = await siteOutput(engine, job);
      const ahead = position ? [position.ahead ? `${plural(position.ahead, 'job')} ahead${position.running ? ` (running: ${position.running})` : ''}` : 'next in the queue'] : [];
      const { result: _result, ...rest } = jobData(job);
      return { summary: [out.summary, ...ahead].join('\n'), data: { ...out.data, job: { ...rest, ...(position ? { queue: position } : {}) } }, ...(out.images ? { images: out.images } : {}) };
    }
    if (job.input.kind === 'inspect') {
      // An inspection that outlived page_inspect's wait: the same result (marked screenshot included), with the job.
      const { inspectOutput } = await import('./inspect.js');
      const out = await inspectOutput(engine, job, [], level);
      const ahead = position ? [position.ahead ? `${plural(position.ahead, 'job')} ahead${position.running ? ` (running: ${position.running})` : ''}` : 'next in the queue'] : [];
      return { summary: [out.summary, ...ahead].join('\n'), data: { ...out.data, job: { ...jobData(job), ...(position ? { queue: position } : {}) } }, ...(out.images ? { images: out.images } : {}) };
    }
    return {
      summary: [
        jobLine(job),
        ...(position ? [position.ahead ? `${plural(position.ahead, 'job')} ahead${position.running ? ` (running: ${position.running})` : ''}` : 'next in the queue'] : []),
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

export const jobCancel = defineTool({
  name: 'job_cancel',
  title: 'Cancel a job',
  description: 'Cancel a job: a queued one never starts; a running run stops at its next step, then its teardown and pending rollbacks still run; a recording whose window is open is discarded (after it, only its check replay stops). Finished jobs are left as they are.',
  input: z.strictObject({ job_id: jobId }),
  annotations: CANCEL,
  async run({ job_id }, { engine }) {
    const job = await engine.jobs.cancel(job_id);
    const what = job.state === 'cancelled' ? 'cancelled' : job.state === 'running' || job.state === 'queued' ? 'cancel requested (teardown and rollbacks run first)' : `already ${job.state}`;
    return { summary: `${jobLine(job)}\n${what}.`, data: jobData(job) };
  },
});

export const JOB_TOOLS: ToolDef[] = [jobList, jobStatus, jobCancel];
