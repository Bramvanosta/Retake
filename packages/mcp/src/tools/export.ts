import { z } from 'zod';
import { EXPORT_FORMAT_NAMES } from '@retake/core';
import type { ExportJobResult, JobRecord } from '@retake/engine';
import { projectSlug, renderId, scenarioName } from '../schema.js';
import { plural } from '../result.js';
import { RENDER_JOB, defineTool } from './define.js';
import type { ToolContext, ToolDef } from './define.js';
import { jobData, jobLine } from './jobs.js';
import { WAIT_MAX_S, waitJob, waitS } from './run.js';

/** The summary of an export job: its state, the files written, what to do next. */
export function exportSummary(job: JobRecord): string {
  const r = job.result?.kind === 'export' ? (job.result as ExportJobResult) : undefined;
  const lines = [jobLine(job)];
  if (r) {
    lines.push(...r.outputs.map((o) => `${o.format} (${o.method}, ${o.width}×${o.height}, ${o.duration_s} s, ${(o.size_bytes / 1048576).toFixed(1)} MB): ${o.file}`));
    lines.push(`manifest: ${r.manifest}`);
    if (r.failed.length) lines.push(`${plural(r.failed.length, 'format')} failed (${r.failed.join(', ')}): the messages are in "result.untrusted.failures"`);
    if (r.untrusted.warnings.length) lines.push(`${plural(r.untrusted.warnings.length, 'warning')} of re-rendered formats in "result.untrusted.warnings"`);
  }
  if (job.state === 'interrupted' && job.error) lines.push(`${job.error.message}${job.error.fix ? ` — a human runs: ${job.error.fix}` : ''}`);
  if (job.state === 'failed' && job.error) lines.push(`failed: ${job.error.code} — the message is in "untrusted.error"${job.error.fix ? `; a human runs: ${job.error.fix}` : ''}`);
  if (job.state === 'queued' || job.state === 'running') lines.push(`follow it: job_status {job_id: "${job.id}", wait_s: ${WAIT_MAX_S}}; stop it: job_cancel {job_id: "${job.id}"}`);
  return lines.join('\n');
}

export const exportTool = defineTool({
  name: 'export',
  title: 'Export a render',
  description: `Export a render to delivery formats in exports/<render_id>/ (+ manifest.json): ${EXPORT_FORMAT_NAMES.join(', ')} (default mp4_1080p, webm, gif_preview). Formats derived from the master are transcoded; vertical_9x16, square_1x1 and a 4K from a smaller master are re-rendered from the same run, theme and overrides (minutes each; planned and checked first, as a render). A job runs it in the background (refused while an export of the render is queued or running, and while two exports of the workspace are): this call returns at once (or waits up to wait_s) — follow it with job_status {wait_s}, stop it with job_cancel (formats written before stay). The folder is fixed; failure messages are under "untrusted".`,
  input: z.strictObject({
    project: projectSlug,
    render_id: z.union([renderId, z.literal('latest')]).describe('Render id (what render returned), or "latest": the newest finished render (of scenario).'),
    scenario: scenarioName.optional().describe('With render_id "latest": the newest render of this scenario.'),
    formats: z
      .array(z.enum(EXPORT_FORMAT_NAMES))
      .min(1)
      .max(EXPORT_FORMAT_NAMES.length)
      .refine((f) => new Set(f).size === f.length, 'each format once')
      .optional()
      .describe('Formats to write (default mp4_1080p, webm, gif_preview).'),
    gif_start_s: z.number().min(0).max(3600).optional().describe('Start of the GIF preview, seconds of the video (default: around the first marker).'),
    gif_duration_s: z.number().min(0.5).max(30).optional().describe('Length of the GIF preview, seconds (default 15, at most 30).'),
    wait_s: waitS(0, 'the export to finish'),
  }),
  annotations: RENDER_JOB,
  async run({ project, render_id, scenario, formats, gif_start_s, gif_duration_s, wait_s }, ctx: ToolContext) {
    const { engine } = ctx;
    const gif = gif_start_s !== undefined || gif_duration_s !== undefined ? { ...(gif_start_s !== undefined ? { start_s: gif_start_s } : {}), ...(gif_duration_s !== undefined ? { duration_s: gif_duration_s } : {}) } : undefined;
    const sub = await engine.exports.submit({ project, render_id, ...(scenario ? { scenario } : {}), ...(formats ? { formats } : {}), ...(gif ? { gif } : {}) });
    await waitJob(engine, sub.job, wait_s, ctx);
    const job = await engine.jobs.get(sub.job.id);
    return {
      summary: [
        `export of ${sub.render_id} submitted (job ${sub.job.id}): ${sub.formats.join(', ')}${sub.rerendered.length ? ` — ${sub.rerendered.join(', ')} re-rendered` : ''}.`,
        exportSummary(job),
      ].join('\n'),
      data: { render_id: sub.render_id, formats: sub.formats, rerendered: sub.rerendered, job: jobData(job) },
    };
  },
});

export const EXPORT_TOOLS: ToolDef[] = [exportTool];
