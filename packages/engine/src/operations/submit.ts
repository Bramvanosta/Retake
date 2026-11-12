/**
 * The MCP server's submits (moved verbatim from its tools/run.ts, render.ts, review.ts and export.ts in L7.15): run_dry,
 * run_capture, render, review and export — each queues a job through the engine's submit (its admission rules and, for
 * a run, its hook approvals inside it: the approver is the MCP client's, handed in the call's context), waits up to
 * wait_s and answers with what the job's follow-up read says (run_status, render_status, review_get, job_status).
 */
import { z } from 'zod';
import { EXPORT_FORMAT_NAMES, SLUG_RE } from '@retake/core';
import type { ExportJobResult, JobRecord } from '../jobs/types.js';
import { RENDER_JOB, RUN_JOB } from './annotations.js';
import { detail } from './compact.js';
import { defineOperation } from './define.js';
import type { ToolContext } from './define.js';
import { jobData, jobLine } from './job-lines.js';
import { editLines, latestLines, renderInput, renderLatestData, renderLatestLines, renderStatusOutput } from './renders.js';
import { reviewImages as images, reviewOutput, reviewRenderRef as renderRef } from './reviews.js';
import { runOutput } from './runs.js';
import { envName, projectSlug, renderId, scenarioName } from './schema.js';
import { WAIT_MAX_S, waitJob, waitS } from './wait.js';
import { plural } from './words.js';

const runInput = {
  project: projectSlug,
  scenario: scenarioName,
  env: envName.optional().describe('Environment (default: the scenario\'s env, else the project\'s default_env). Production environments always run read-only here.'),
};

export const runDry = defineOperation({
  name: 'run_dry',
  title: 'Dry-run a scenario',
  description:
    'Run a scenario without recording, to check it: every step runs in a headless browser against the environment (irreversible steps and the scenario\'s setup / teardown hooks are skipped unless hooks: "run"), with one screenshot per step, then the run stops. A job runs it in the background (refused while a run of the scenario is queued or running); this call waits up to wait_s (default 20) and returns the run as it is then (run_status follows it). On a failure: the scene, step, error screenshot and DOM snapshot paths. until stops after that step (scene.step, a step id or a scene id).',
  input: z.strictObject({
    ...runInput,
    until: z.string().min(1).max(200).optional().describe('Stop after this step: <scene>.<step id or index>, a unique step id, or a scene id.'),
    hooks: z
      .enum(['run', 'skip'])
      .optional()
      .describe('"run" executes the setup / teardown hooks too (default skip). Hooks that are destructive or run shell commands need a human: the user is asked to approve them (else the call is refused with the command a human runs).'),
    wait_s: waitS(20, 'the dry run to finish'),
  }),
  annotations: RUN_JOB,
  async run({ project, scenario, env, until, hooks, wait_s }, ctx) {
    const { engine } = ctx;
    const sub = await engine.runs.submit({ project, scenario, mode: 'dry', env, until, hooks }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    await waitJob(engine, sub.job, wait_s, ctx);
    return runOutput(engine, project, sub.run_id, [`dry run ${sub.run_id} submitted (job ${sub.job.id}).`, ...sub.warnings.map((w) => `warning: ${w}`)]);
  },
});

export const runCapture = defineOperation({
  name: 'run_capture',
  title: 'Capture a scenario',
  description:
    'Capture a scenario: its setup hooks, every scene filmed in a headless browser (capture.mp4 + timeline.json), its teardown and rollbacks. A job runs it in the background (one capture at a time; renders, reviews and exports wait or yield while it films; refused while a run of the scenario is queued or running); this call returns at once (or waits up to wait_s) with the run id — follow it with run_status {wait_s}, stop it with run_cancel. sandbox: true resets the sandbox environment to its seed first. Setup / teardown hooks that are destructive or run shell commands need a human: the user is asked to approve them before anything is queued ("confirm: true" in the file does not count here); a decline, or a client that cannot ask, refuses the call with the command a human runs. A persona whose saved session is not valid (expired, error, never signed in) and that no run signs in by itself refuses the call (conflict, details.sessions) until sessions_ack names it: tell the user, who signs in (auth_login) or confirms the capture.',
  input: z.strictObject({
    ...runInput,
    sandbox: z.boolean().optional().describe('Reset the sandbox environment (sandbox.yaml) to its seed before the take: up if needed, health, reset.'),
    sessions_ack: z
      .array(z.string().max(100).regex(SLUG_RE, 'a persona name'))
      .max(50)
      .optional()
      .describe('The personas whose session is not valid that the user confirms capturing with anyway (a refusal\'s details.sessions names them; the run still checks each one it can before filming).'),
    wait_s: waitS(0, 'the capture to finish'),
  }),
  annotations: RUN_JOB,
  async run({ project, scenario, env, sandbox, sessions_ack, wait_s }, ctx) {
    const { engine } = ctx;
    const sub = await engine.runs.submit({ project, scenario, mode: 'capture', env, sandbox, ...(sessions_ack ? { sessions_ack } : {}) }, { ...(ctx.approver ? { approver: ctx.approver } : {}) });
    await waitJob(engine, sub.job, wait_s, ctx);
    return runOutput(engine, project, sub.run_id, [`capture ${sub.run_id} submitted (job ${sub.job.id}).`, ...sub.warnings.map((w) => `warning: ${w}`)]);
  },
});

export const render = defineOperation({
  name: 'render',
  title: 'Render a capture',
  description:
    "Render a capture run into a video (renders/<render_id>.mp4 + .json), with the run's theme or another (template) and edit overrides. The edit comes from today's scenario file re-planned on the capture (captions, cards, durations, overlays, title, intro/outro, template: no new capture) while its filmed part is unchanged; a change to the filmed part (steps, pages, hooks, capture settings) shows only in a new capture (run_capture first; scenario_changed and filmed_changes say what changed). It is planned and checked first (as plan_preview), then a job renders it in the background (refused while a render of the scenario is queued or running; one render, review or export at a time, beside captures; it waits for a take filming on this Mac and yields during one; ≈ 1–3 min for a minute of video): this call returns at once (or waits up to wait_s) with the reserved render_id; follow it with render_status {wait_s}, stop it with job_cancel. A failed or cancelled render writes nothing under its id (the next render of the scenario may reuse it). Through this server the render loads only the files of its plan: files outside the project, a theme folder, remote images in slots and any other network request are refused or blocked.",
  input: z.strictObject({ ...renderInput, wait_s: waitS(0, 'the render to finish') }),
  annotations: RENDER_JOB,
  async run({ project, scenario, run_id, template, overrides, wait_s }, ctx: ToolContext) {
    const { engine } = ctx;
    const sub = await engine.renders.submit({ project, scenario, ...(run_id ? { run_id } : {}), ...(template ? { template } : {}), ...(overrides ? { overrides } : {}) });
    await waitJob(engine, sub.job, wait_s, ctx);
    return renderStatusOutput(
      engine,
      project,
      sub.render_id,
      [
        `render ${sub.render_id} submitted (job ${sub.job.id}): run ${sub.run_id}, ${sub.variant}, ${sub.duration_s} s.`,
        ...editLines(project, scenario, sub),
        ...latestLines(sub),
        ...(sub.warnings.length ? [`${plural(sub.warnings.length, 'plan warning')}: render_status shows them under "untrusted".`] : []),
      ],
      // the run it renders (the render's record names it only once rendered)
      {
        run_id: sub.run_id,
        edit: sub.edit,
        ...(sub.scenario_changed !== undefined ? { scenario_changed: sub.scenario_changed } : {}),
        ...(sub.filmed_changes ? { filmed_changes: sub.filmed_changes } : {}),
        ...(sub.edit_changes ? { edit_changes: sub.edit_changes } : {}),
        ...(sub.passed_over !== undefined ? { passed_over: sub.passed_over } : {}),
        ...(sub.not_considered !== undefined ? { not_considered: sub.not_considered } : {}),
        ...(sub.until ? { until: sub.until } : {}),
      },
      // the newer captures `latest` passed over: folder names of runs/, kept with the other text nobody vouches for
      sub.untrusted?.passed_over ? { passed_over: sub.untrusted.passed_over } : {},
    );
  },
});

export const review = defineOperation({
  name: 'review',
  title: 'Review a render',
  description:
    'Review a render before showing it: contact sheets, per-scene sheets, key frames, the output timeline and a report of every check (blank screens, captions too long, cursor outside a zoom, transitions over clicks, long waits, duration…) with a diff against the previous render, written to review/<render_id>/. A job runs it in the background (ffmpeg, no browser); this call waits up to wait_s (default 20): when the review finishes in time, the result is review_get\'s — the verdict, finding codes and times, and the contact sheet as images to look at. Otherwise follow it with review_get {wait_s}. Finding messages are under "untrusted": they quote the scenario and the filmed site.',
  input: z.strictObject({
    project: projectSlug,
    render_id: renderRef,
    scenario: scenarioName.optional().describe('With render_id "latest": the newest render of this scenario.'),
    fps: z.union([z.literal(1), z.literal(2)]).default(1).describe('Contact sheet frames per second (1 or 2; per-scene sheets are always 2 fps).'),
    previous: z.union([renderId, z.literal(false)]).optional().describe('Render to compare with (an id), or false for none; default the previous render of the same scenario and variant.'),
    images,
    detail,
    wait_s: waitS(20, 'the review to finish'),
  }),
  annotations: RENDER_JOB,
  async run({ project, render_id, scenario, fps, previous, images: mode, detail: level, wait_s }, ctx: ToolContext) {
    const { engine } = ctx;
    const sub = await engine.reviews.submit({ project, render_id, ...(scenario ? { scenario } : {}), fps, ...(previous !== undefined ? { previous } : {}) });
    await waitJob(engine, sub.job, wait_s, ctx);
    const out = await reviewOutput(engine, project, sub.render_id, mode, [`review of ${sub.render_id} submitted (job ${sub.job.id}).`, ...renderLatestLines(sub)], level);
    // With render_id "latest": what it passed over (counts as data, the file names under "untrusted").
    const passed = renderLatestData(sub);
    if (!Object.keys(passed.data).length && !Object.keys(passed.untrusted).length) return out;
    return { ...out, data: { ...out.data, ...passed.data, untrusted: { ...(out.data.untrusted as Record<string, unknown> | undefined), ...passed.untrusted } } };
  },
});

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

export const exportRender = defineOperation({
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
    const passed = renderLatestData(sub);
    return {
      summary: [
        `export of ${sub.render_id} submitted (job ${sub.job.id}): ${sub.formats.join(', ')}${sub.rerendered.length ? ` — ${sub.rerendered.join(', ')} re-rendered` : ''}.`,
        ...renderLatestLines(sub),
        exportSummary(job),
      ].join('\n'),
      // With render_id "latest": what it passed over (counts as data, the file names under "untrusted").
      data: { render_id: sub.render_id, formats: sub.formats, rerendered: sub.rerendered, job: jobData(job), ...passed.data, ...(Object.keys(passed.untrusted).length ? { untrusted: passed.untrusted } : {}) },
    };
  },
});
