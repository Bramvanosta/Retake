/**
 * How a tool shows a job: its one summary line (jobLine), its error line (jobErrorLine), the job as data with an error
 * that can quote the product kept under `untrusted` (untrustedError, jobData), and a preview job's stills
 * (previewImages). Shared by job_status / job_list (jobs.ts) and the tools that submit jobs.
 */
import { jobProject, yieldWords } from '@retake/engine';
import type { JobRecord } from '@retake/engine';
import type { ToolImage } from '../result.js';

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
  // L5.14: a heavy job a filming take holds (data: `yield`, an enum; where the take films is never named).
  const held = j.yield ? ` · ${yieldWords(j.yield)}` : '';
  return `${j.id} ${what} in ${jobProject(j.input) ?? 'the workspace'}: ${j.state}${held}${progress}${result}${j.cancel_requested_at && j.state !== 'cancelled' ? ' (cancel requested)' : ''}`;
}
