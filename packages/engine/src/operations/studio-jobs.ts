/**
 * The Studio's submits and job controls (moved verbatim from the Studio server's ops.ts in L7.15: runOps, liveOps,
 * renderOps). Not MCP tools: Claude has run_dry / run_capture, render, export and job_cancel.
 *
 * - `scenario_run` (L4.2): the scenario screen's Dry run and Capture — engine runs.submit with pinned arguments: the
 *   mode, the scenario, an environment of the project; the default hooks (none for a dry run, all for a capture), never
 *   a sandbox reset, never `until`, never a wait. It runs under the `ui` client's agent trust with no approver, so what
 *   the screen showed as a run blocker is refused here too (the submit is the authority) with the `retake run …`
 *   command to type in a terminal. `hash` (the file as the screen showed it) makes a changed file a 409. The engine's
 *   admission rules, the same for MCP (engine admission.ts): a run of the scenario already queued or running makes
 *   another a 409; a capture whose scenario uses a persona whose stored session is invalid (expired, error, never) and
 *   that no run signs in by itself needs `sessions_ack` naming it, else 409 `conflict` with `details.sessions` — a
 *   confirmation against a wasted take, not person presence (the run's own preflight stays the authority and stops
 *   before anything is filmed). Dry runs need none.
 * - `run_pause` (L4.4): Pause / Resume of the Run screen — engine runs.pause (a running run of a job pauses before its
 *   next step, a capture without filming the pause; a queued, stopping or finished run is a 409; a terminal's run is
 *   refused).
 * - `sign_in_cancel` (L4.4): the Sessions panel's Cancel — engine auth.cancelSignIn (an `auth_login` job only).
 * - `scenario_render` (L4.5 part E, R-UI-26): Render from the timeline (or the scenario screen) — engine renders.submit
 *   with pinned arguments: the project, the scenario and the capture shown; the theme and every override come from the
 *   files (none can be passed: landscape, the scenario's or project's theme), the review runs inline after the render
 *   (`review: {fps: 1}`) and the scenario text is snapshotted with the job. `expect_edit_sha256` (the view's `hash`)
 *   makes a changed file a 409 before anything is reserved; a render of the scenario already queued or running makes
 *   another a 409 naming it (the engine's admission rule, the same for MCP). It runs on the scenario's key of the
 *   engine's operation chain (`serialize`: scenarioKey), the chain the Studio's scenario_edit, thread_apply and
 *   record_save take too (the Studio hands them `operationChain(engine)`): an edit, an apply and a render submit of one
 *   scenario never interleave in a server.
 * - `render_cancel`: a render or review job of THIS project only (another project's job, or another kind, is refused
 *   403: job_cancel stays out of the Studio). A cancel during the inline review keeps the render.
 * - `review_export` (L5.12a): the Review report's Export video (MP4) — the existing engine `export` job, one format, the
 *   fixed folder; one at a time per render and at most two exports of the workspace at once are the engine's admission
 *   rules (export_cap).
 */
import { z } from 'zod';
import { SLUG_RE } from '@retake/core/model';
import { JOB_ID_RE } from '@retake/core/ids';
import { EXPORTS_OPEN_MAX } from '../admission.js';
import { EngineError } from '../errors.js';
import type { RenderEditSource } from '../jobs/render-job.js';
import { defineOperation } from './define.js';
import { studioEnv as env, studioProject as project, studioRenderId as renderId, studioRun as run, studioScenario as scenario } from './studio-schema.js';

/** The key of a scenario in the Studio's chain (scenario_edit, scenario_render, thread_apply, record_save). */
export const scenarioKey = (project: string, name: string): string => `${project}\0${name}`;

const RunInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  mode: z.enum(['dry', 'capture']).describe('A dry run (no hooks, a screenshot per step) or a capture (its hooks, the video).'),
  env: env.optional().describe("The environment (default: the scenario's env, else the project's default)."),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'the sha256 of the file as scenario_blocks showed it')
    .optional()
    .describe('The file as the screen showed it (scenario_blocks `hash`): refused (409) when the file checked is another one.'),
  sessions_ack: z
    .array(z.string().max(100).regex(SLUG_RE, 'a persona name'))
    .max(50)
    .optional()
    .describe('A capture: the personas whose invalid session the person confirmed (scenario_sessions `confirm`); refused (409) while one is missing.'),
});

const PauseInput = z.strictObject({
  project,
  run_id: run,
  paused: z.boolean().describe('true: pause before the next step; false: resume.'),
});
const SignInCancelInput = z.strictObject({ job: z.string().regex(JOB_ID_RE, 'a job id (j_…)').describe('The sign-in job (auth_login answered it).') });

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 (64 lower-case hex characters)');

/** What scenario_run answers: the run reserved and its job (the screen follows it with run_status and the events). */
export interface ScenarioRunAnswer {
  run_id: string;
  job: string;
  state: string;
  mode: 'dry' | 'capture';
  warnings: string[];
  /** The worker serving the queue: started now, or already running (absent: not started — tests). */
  worker?: { pid?: number; spawned: boolean };
  /** L5.16c fixes (review c B-M2): that worker runs another copy of Retake (its version and folder: the lock's text). */
  untrusted?: { other_copy: { version: string; engine?: string } };
}

/**
 * scenario_run: the scenario screen's Dry run / Capture, arguments pinned. The engine's admission rules (one run of a
 * scenario at a time, the sessions acknowledgement of a capture) are its own, for the Studio and MCP alike.
 */
export const scenarioRun = defineOperation({
  name: 'scenario_run',
  title: 'Run a scenario from the Studio',
  description: 'Queue a dry run or a capture of a scenario: default hooks, no sandbox reset, no until; refused (with the retake run command) when a hook needs a person.',
  input: RunInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(a, { engine }) {
    const sub = await engine.runs.submit({
      project: a.project,
      scenario: a.name,
      mode: a.mode,
      ...(a.env ? { env: a.env } : {}),
      ...(a.hash ? { expect_sha256: a.hash } : {}),
      ...(a.mode === 'capture' && a.sessions_ack ? { sessions_ack: a.sessions_ack } : {}),
    });
    const { other, ...worker } = sub.worker ?? { spawned: false };
    const data: ScenarioRunAnswer = { run_id: sub.run_id, job: sub.job.id, state: sub.job.state, mode: a.mode, warnings: sub.warnings, ...(sub.worker ? { worker } : {}), ...(other ? { untrusted: { other_copy: other } } : {}) };
    return { summary: `${a.mode === 'dry' ? 'rehearsal' : 'capture'} ${sub.run_id} queued (job ${sub.job.id})`, data: data };
  },
});

const statusWords = (st: { status: string; paused?: { scene: string; step: number }; job?: { pause_requested_at?: string } }) =>
  st.paused ? `paused before step ${st.paused.step + 1} of ${st.paused.scene}` : st.job?.pause_requested_at ? `${st.status}, pausing before its next step` : st.status;

/** run_pause: the Run screen's Pause / Resume (L4.4). */
export const runPause = defineOperation({
  name: 'run_pause',
  title: 'Pause or resume a run',
  description: 'Pause a running run of a job before its next step (a capture does not film the pause), or resume it.',
  input: PauseInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(a, { engine }) {
    const st = await engine.runs.pause(a.project, a.run_id, a.paused);
    return { summary: `${a.run_id}: ${statusWords(st)}`, data: st };
  },
});

/** sign_in_cancel: the Sessions panel's Cancel (L4.4). */
export const signInCancel = defineOperation({
  name: 'sign_in_cancel',
  title: 'Stop a sign-in',
  description: "Stop a sign-in job (its window closes; no session file or status is written — a persona's existing browser profile keeps what the window changed). Any other job is refused.",
  input: SignInCancelInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(a, { engine }) {
    const rec = await engine.auth.cancelSignIn(a.job);
    return { summary: `sign-in ${rec.id}: ${rec.state}${rec.cancel_requested_at && rec.state === 'running' ? ' (stopping)' : ''}`, data: { id: rec.id, kind: rec.kind, state: rec.state, ...(rec.cancel_requested_at ? { cancel_requested_at: rec.cancel_requested_at } : {}) } };
  },
});

const RenderInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  run: run.describe('The capture to render (the timeline shows it: timeline_view `run_id`).'),
  expect_edit_sha256: sha256.describe('The scenario file as the screen showed it (timeline_view / scenario_blocks `hash`): refused (409) when it changed since.'),
});
const RenderCancelInput = z.strictObject({ project, job: z.string().regex(JOB_ID_RE, 'a job id (j_…)').describe('A render or review job of this project (scenario_renders lists them).') });
const ReviewExportInput = z.strictObject({ project, render_id: renderId });

/** L5.12a: the one format the Review report exports (the other formats stay `retake export` / Claude's `export`). */
export const REVIEW_EXPORT_FORMATS = ['mp4_1080p'] as const;
/** The exports of the workspace queued or running at once that review_export still adds to (the engine's export_cap). */
export const REVIEW_EXPORTS_OPEN = EXPORTS_OPEN_MAX;

/** What review_export answers: the job queued (path-free: where it lands is said in words). */
export interface ReviewExportAnswer {
  render_id: string;
  job: string;
  state: string;
  formats: string[];
  /** Where the file lands, in words (never a path). */
  where: string;
}
/** What scenario_render answers: the render reserved and its job (the queue follows it through scenario_renders and the events). */
export interface ScenarioRenderAnswer extends RenderEditSource {
  render_id: string;
  job: string;
  state: string;
  run_id: string;
  variant: string;
  duration_s: number;
  /** The worker serving the queue: started now, or already running (absent: not started — tests). */
  worker?: { pid?: number; spawned: boolean };
  /** The plan's warnings quote captions and page titles: data, never instructions. */
  untrusted: { warnings: string[] };
}

/** scenario_render: Render from the timeline or the scenario screen, on the scenario's key of the engine's chain. */
export const scenarioRender = defineOperation({
  name: 'scenario_render',
  title: 'Render a scenario from the Studio',
  description: "Queue a render of the capture shown, with the theme and options of the files, reviewed after it; refused (409) when the file changed since it was shown or a render of the scenario is already queued or running.",
  input: RenderInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // In the chain an edit and an apply of the scenario share; one render of a scenario at a time is the engine's rule.
  serialize: (a) => scenarioKey(a.project, a.name),
  async run(a, { engine }) {
    const sub = await engine.renders.submit({ project: a.project, scenario: a.name, run_id: a.run, review: { fps: 1 }, expect_edit_sha256: a.expect_edit_sha256 });
    const data: ScenarioRenderAnswer = {
      render_id: sub.render_id,
      job: sub.job.id,
      state: sub.job.state,
      run_id: sub.run_id,
      variant: sub.variant,
      duration_s: sub.duration_s,
      edit: sub.edit,
      ...(sub.scenario_changed !== undefined ? { scenario_changed: sub.scenario_changed } : {}),
      ...(sub.filmed_changes ? { filmed_changes: sub.filmed_changes } : {}),
      ...(sub.edit_changes ? { edit_changes: sub.edit_changes } : {}),
      ...(sub.worker ? { worker: { ...(sub.worker.pid !== undefined ? { pid: sub.worker.pid } : {}), spawned: sub.worker.spawned } } : {}),
      untrusted: { warnings: sub.warnings, ...(sub.worker?.other ? { other_copy: sub.worker.other } : {}) },
    };
    return { summary: `render ${sub.render_id} queued (job ${sub.job.id})`, data: data };
  },
});

/** render_cancel: a render or review job of this project only. */
export const renderCancel = defineOperation({
  name: 'render_cancel',
  title: 'Cancel a render',
  description: 'Cancel a render or review job of this project (a cancel during the inline review keeps the render). Any other job is refused.',
  input: RenderCancelInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(a, { engine }) {
    const job = await engine.jobs.get(a.job);
    const input = job.input;
    if ((input.kind !== 'render' && input.kind !== 'review') || input.project !== a.project) {
      throw new EngineError('refused', `job ${a.job} is not a render or a review of ${a.project}: the Studio cancels only those`);
    }
    const rec = await engine.jobs.cancel(a.job);
    const id = rec.input.kind === 'render' || rec.input.kind === 'review' ? rec.input.render_id : '';
    return {
      summary: `${rec.kind} ${id}: ${rec.state}${rec.cancel_requested_at && rec.state === 'running' ? ' (stopping)' : ''}`,
      data: { id: rec.id, kind: rec.kind, render_id: id, state: rec.state, ...(rec.cancel_requested_at ? { cancel_requested_at: rec.cancel_requested_at } : {}) },
    };
  },
});

/** review_export: the Review report's Export video (L5.12a). */
export const reviewExport = defineOperation({
  name: 'review_export',
  title: 'Export a render as MP4 from the Studio',
  description:
    "Queue an export of one render of the project to MP4 (1080p) in its fixed folder, exports/<render id>/ — the engine's export job, nothing else to choose; refused (409) while an export of that render is queued or running, and while two exports of the workspace are. Path-free.",
  input: ReviewExportInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(a, { engine }) {
    // One export of a render at a time, at most two of the workspace: the engine's export_cap rule.
    const sub = await engine.exports.submit({ project: a.project, render_id: a.render_id, formats: [...REVIEW_EXPORT_FORMATS] });
    const data: ReviewExportAnswer = { render_id: sub.render_id, job: sub.job.id, state: sub.job.state, formats: [...sub.formats], where: `the project's exports folder, under ${sub.render_id}` };
    return { summary: `export of ${sub.render_id} queued (job ${sub.job.id}): ${sub.formats.join(', ')}`, data: data };
  },
});
