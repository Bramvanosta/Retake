import type { Engine, JobRecord, PreviewSubmitted } from '@retake/engine';
import { plural } from '../result.js';
import type { ToolOutput } from '../result.js';
import type { ToolContext } from './define.js';
import { jobLine, previewImages } from './job-lines.js';
import { WAIT_MAX_S, waitJob } from './run.js';

/** The summary of a preview job: state, the images written, what to do next (the guard's warnings stay under untrusted). */
export function previewSummary(job: JobRecord): string {
  const r = job.result?.kind === 'preview' ? job.result : undefined;
  const lines = [jobLine(job)];
  if (r) {
    lines.push(`${plural(r.images.length, 'image')} (960×540 PNG) in ${r.dir}`);
    if (r.skipped?.length) lines.push(`the ${r.theme} theme shows no ${r.skipped.join(', ')} (none picked)`);
    if (r.untrusted.warnings.length) lines.push(`the network guard blocked requests of a component: "untrusted.warnings" names the origins`);
  }
  if (job.state === 'failed' && job.error) lines.push(`failed: ${job.error.code} — the message is in "untrusted.error" (it can quote a component's error)${job.error.fix ? `; a human runs: ${job.error.fix}` : ''}`);
  if (job.state === 'interrupted' && job.error) lines.push(job.error.message);
  if (job.state === 'queued' || job.state === 'running') lines.push(`follow it: job_status {job_id: "${job.id}", wait_s: ${WAIT_MAX_S}} (it returns the images); stop it: job_cancel {job_id: "${job.id}"}`);
  return lines.join('\n');
}

/** Wait on a submitted preview (wait_s), then its summary and, once it succeeded, its stills as images. */
export async function previewOutput(engine: Engine, sub: PreviewSubmitted, waitSeconds: number, ctx: ToolContext, head: string): Promise<ToolOutput> {
  await waitJob(engine, sub.job, waitSeconds, ctx);
  const job = await engine.jobs.get(sub.job.id);
  const images = previewImages(job);
  const r = job.result?.kind === 'preview' ? job.result : undefined;
  const untrusted = { ...(r?.untrusted.warnings.length ? { warnings: r.untrusted.warnings } : {}), ...(job.error ? { error: job.error.message } : {}) };
  return {
    summary: [head, previewSummary(job)].join('\n'),
    data: {
      preview_id: sub.preview_id,
      theme: sub.theme,
      targets: sub.targets,
      ...(sub.skipped.length ? { skipped: sub.skipped } : {}),
      job: { id: job.id, state: job.state, ...(job.progress ? { progress: job.progress } : {}), ...(job.error ? { error: { code: job.error.code, ...(job.error.fix ? { fix: job.error.fix } : {}) } } : {}) },
      ...(r ? { dir: r.dir, stills: r.images } : {}),
      ...(Object.keys(untrusted).length ? { untrusted } : {}),
    },
    ...(images.length ? { images } : {}),
  };
}
