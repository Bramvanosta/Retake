/**
 * The render reads of the MCP server (moved from its tools/render.ts in L7.14): plan_preview and render_status, and the
 * trusted lines they share with the MCP server's render and review (the status of a render, what `latest` passed over,
 * what the edit re-planned).
 */
import { z } from 'zod';
import { SLUG_RE } from '@retake/core/model';
import { editReplannedMessage, scenarioChangedMessage } from '@retake/core/scenario';
import type { Engine } from '../engine.js';
import { yieldWords } from '../jobs/held.js';
import type { RenderStatusView } from '../renders.js';
import { READ } from './annotations.js';
import { defineOperation } from './define.js';
import { editOverrides, projectSlug, renderId, runId, scenarioName, templateName } from './schema.js';
import { WAIT_MAX_S, waitJob, waitS } from './wait.js';
import { plural } from './words.js';

/** The arguments plan_preview and render share. */
export const renderInput = {
  project: projectSlug,
  scenario: scenarioName,
  run_id: runId.optional().describe("The capture run to render (default: the scenario's latest capture; run_list names them)."),
  template: templateName.optional(),
  overrides: editOverrides.optional(),
};

const pct = (f: number | undefined) => (f === undefined ? '' : ` ${Math.round(f * 100)} %`);

/** The summary of a render's status: state, where it waits or how far it is, the files, what to do next. */
export function renderStatusSummary(r: RenderStatusView): string {
  const job = r.job;
  const q = job?.queue;
  const waiting =
    r.status === 'queued' && q
      ? `queued: ${q.held_by === 'take' ? (job?.yield ? yieldWords(job.yield) : 'waiting for a take to finish') : q.ahead ? `${plural(q.ahead, 'job')} ahead` : 'next'}${q.running ? `, behind job ${q.running.id} (${q.running.kind}${q.running.phase ? ` · ${q.running.phase}` : ''}${pct(q.running.fraction)}${q.running.eta_s !== undefined ? `, ~${q.running.eta_s} s left` : ''})` : ''}`
      : undefined;
  const p = job?.progress;
  // L5.14: slowed during a take (background priority), said with its progress.
  const slowed = job?.yield?.state === 'background' ? ` · ${yieldWords(job.yield)}` : '';
  const running = r.status === 'running' && p ? `running: ${p.phase ?? ''}${pct(p.fraction)}${p.steps_total ? ` · ${p.steps_done}/${p.steps_total} frames` : ''}${p.eta_s !== undefined ? ` · ~${p.eta_s} s left` : ''}${slowed}` : undefined;
  const rec = r.record;
  const lines = [
    `render ${r.render_id}${r.scenario ? ` of ${r.scenario}` : ''}: ${waiting ?? running ?? r.status}`,
    ...(job ? [`job ${job.id}: ${job.state}${job.cancel_requested_at && !r.finished ? ' (cancel requested)' : ''}`] : []),
    ...(rec ? [`${rec.duration_s} s, ${rec.width}×${rec.height} @ ${rec.fps} fps, theme ${rec.template}, ${rec.variant}, ${(rec.size_bytes / 1048576).toFixed(1)} MB`] : []),
    ...(r.file && r.status === 'succeeded' ? [`video: ${r.file}`, ...(r.record_file ? [`record: ${r.record_file}`] : [])] : []),
    // The video a record names elsewhere than renders/<id>.mp4 is the file's text: never in this line.
    ...(!r.file && rec && r.status === 'succeeded' ? [`video: its record names a file other than renders/${r.render_id}.mp4 ("untrusted.record.file")`, ...(r.record_file ? [`record: ${r.record_file}`] : [])] : []),
    ...(r.status === 'interrupted' && job?.error ? [`${job.error.message}${job.error.fix ? ` — a human runs: ${job.error.fix}` : ''}`] : []),
    ...(r.status === 'cancelled' ? ['cancelled: nothing was written under this id (the next render of the scenario may reuse it)'] : []),
    ...(r.status === 'failed' ? ['failed: nothing was written under this id (the next render of the scenario may reuse it); the message is in "untrusted.error"'] : []),
    ...(r.untrusted.warnings.length ? [`${plural(r.untrusted.warnings.length, 'warning')} in "untrusted" (they quote the scenario and the filmed site)`] : []),
    ...(!r.finished ? [`follow it: render_status {project: "${r.project}", render_id: "${r.render_id}", wait_s: ${WAIT_MAX_S}}; stop it: job_cancel {job_id: "${job?.id ?? ''}"}`] : []),
  ];
  return lines.join('\n');
}

/**
 * The answer of a render's status: the engine's view, whose trusted members are closed words and checked values (a
 * status Retake never writes is `unknown`, by its id as through `latest`; the record's text is under `untrusted`).
 */
export async function renderStatusOutput(engine: Engine, project: string, id: string, extra: string[] = [], extraData: Record<string, unknown> = {}, extraUntrusted: Record<string, unknown> = {}) {
  const r = await engine.renders.status(project, id);
  return { summary: [...extra, renderStatusSummary(r)].join('\n'), data: { ...r, ...extraData, untrusted: { ...r.untrusted, ...extraUntrusted } } };
}

/** A scene id as a scenario writes one (a slug of at most 100 characters): only such a text is said in a trusted line — run.json is a file anyone may write. */
const isSceneId = (v: unknown): v is string => typeof v === 'string' && v.length <= 100 && SLUG_RE.test(v);

/**
 * The trusted lines of a plan or a render about the run `latest` picked (none for a run named by run_id):
 * - how many newer captures of the scenario were passed over — failed, cancelled, not finished, without their film… —
 *   as a count only: their folder names are text anyone who can write runs/ chose, and stay under "untrusted";
 * - where the capture picked ends when it was stopped by `--until` (the step as `--until` names it, when its scene
 *   reads as a scene id; else only that it was stopped).
 */
export function latestLines(p: { run_id: string; passed_over?: number; not_considered?: number; until?: { scene?: string; step?: number } }): string[] {
  const lines: string[] = [];
  if (p.passed_over) lines.push(`${plural(p.passed_over, 'newer capture')} of the scenario passed over: "untrusted.passed_over" names ${p.passed_over === 1 ? 'it' : 'them'}`);
  if (p.not_considered) lines.push(`${plural(p.not_considered, 'newer run folder')} without a run.json that reads as a record ${p.not_considered === 1 ? 'was' : 'were'} not considered`);
  if (p.until) {
    const step = isSceneId(p.until.scene) && Number.isInteger(p.until.step) ? ` at step ${p.until.scene}.${p.until.step}` : ' early';
    lines.push(`run ${p.run_id} stops${step} (\`--until\`): the render shows the scenario up to there`);
  }
  return lines;
}

/**
 * The trusted lines about the render `latest` picked (none for a render named by its id): how many newer files of
 * renders/ were passed over — a record renamed or copied, a link, one that lacks a member, of a newer Retake… — as a
 * count only (their names are text anyone who can write renders/ chose, and stay under "untrusted"), and how many
 * files say nothing readable under a name that is no render id.
 */
export function renderLatestLines(p: { renders_passed_over?: number; renders_not_considered?: number }): string[] {
  const lines: string[] = [];
  if (p.renders_passed_over) lines.push(`${plural(p.renders_passed_over, 'newer file')} of renders/ passed over: "untrusted.renders_passed_over" names ${p.renders_passed_over === 1 ? 'it' : 'them'}`);
  if (p.renders_not_considered) lines.push(`${plural(p.renders_not_considered, 'file')} of renders/ ${p.renders_not_considered === 1 ? 'does' : 'do'} not read: not considered`);
  return lines;
}

/** The members an answer carries on from a `latest` of renders: the counts as data, the names under `untrusted`. */
export function renderLatestData(p: { renders_passed_over?: number; renders_not_considered?: number; untrusted?: { renders_passed_over?: unknown } }): { data: Record<string, unknown>; untrusted: Record<string, unknown> } {
  return {
    data: { ...(p.renders_passed_over !== undefined ? { renders_passed_over: p.renders_passed_over } : {}), ...(p.renders_not_considered !== undefined ? { renders_not_considered: p.renders_not_considered } : {}) },
    untrusted: p.untrusted?.renders_passed_over ? { renders_passed_over: p.untrusted.renders_passed_over } : {},
  };
}

/**
 * The trusted lines of a plan or a render about its edit (L5.5): the filmed part of the scenario changed since the
 * capture (re-capture to film it), or today's edit was re-planned on the run. They name only the scenario (a checked
 * name), the run id and the parts that changed (keys, scene ids, step keys: core filmedChanges / replanEdit).
 */
export function editLines(project: string, scenario: string, p: { run_id: string; edit: 'scenario' | 'run'; scenario_changed?: boolean; filmed_changes?: string[]; edit_changes?: string[] }): string[] {
  if (p.scenario_changed) return [scenarioChangedMessage(scenario, p.run_id, `run_capture {project: "${project}", scenario: "${scenario}"}`, p.filmed_changes)];
  if (p.edit === 'scenario' && p.edit_changes?.length) {
    const list = p.edit_changes.slice(0, 12).join(', ') + (p.edit_changes.length > 12 ? `, and ${p.edit_changes.length - 12} more` : '');
    return [`${editReplannedMessage(scenario, p.run_id)} (changed: ${list})`];
  }
  return [];
}

export const planPreview = defineOperation({
  name: 'plan_preview',
  title: 'Preview the plan of a render',
  description:
    'Plan a render without rendering it (fast, nothing is written): the video it would make — variant, size, fps, duration, theme, frame, the segments (intro, clips, cards, interstitials, outro) with their component and timing, music — and the planner\'s warnings. Use it to check a theme, a component switch or other overrides before render. The edit comes from today\'s scenario file, re-planned on the run\'s capture (edit: "scenario"), as long as the filmed part is unchanged since the capture: captions, cards and their order, durations, overlays, title, intro/outro, template and speeds need only a render. scenario_changed (with filmed_changes) says the filmed part changed — steps, pages, hooks, capture settings: the render then shows the run as captured and a new capture (run_capture) films the change. Files the scenario names must be files of the project; a theme is named (template), never a folder. Captions, warnings and the text summary are under "untrusted": they quote the scenario and the filmed site.',
  input: z.strictObject(renderInput),
  annotations: READ,
  async run({ project, scenario, run_id, template, overrides }, { engine }) {
    const p = await engine.renders.plan({ project, scenario, ...(run_id ? { run_id } : {}), ...(template ? { template } : {}), ...(overrides ? { overrides } : {}) });
    const kinds = new Map<string, number>();
    for (const g of p.segments) kinds.set(g.kind, (kinds.get(g.kind) ?? 0) + 1);
    return {
      summary: [
        `plan of ${p.scenario} (run ${p.run_id}): ${p.variant} ${p.width}×${p.height} @ ${p.fps} fps, ${p.duration_s} s, theme ${p.theme}, frame ${p.frame}`,
        ...editLines(project, scenario, p),
        ...latestLines(p),
        `${plural(p.segments.length, 'segment')}: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}${p.music ? '; music' : ''}`,
        ...(p.untrusted.warnings.length ? [`${plural(p.untrusted.warnings.length, 'warning')} in "untrusted"`] : []),
        // A changed filmed part shows only in a new capture: never offer to render the old run (L3.8 review M1).
        p.scenario_changed
          ? `capture first: run_capture {project: "${project}", scenario: "${scenario}"}; then render {project: "${project}", scenario: "${scenario}"${template ? `, template: "${template}"` : ''}${overrides ? ', overrides: …' : ''}}`
          : `render it: render {project: "${project}", scenario: "${scenario}"${run_id ? `, run_id: "${run_id}"` : ''}${template ? `, template: "${template}"` : ''}${overrides ? ', overrides: …' : ''}} → ${p.next_render_id} (if no other render takes it first)`,
      ].join('\n'),
      data: p,
    };
  },
});

export const renderStatus = defineOperation({
  name: 'render_status',
  title: 'Status of a render',
  description:
    'A render by its id: its job first (queued — with the job it waits behind —, running with its stage, percent and time left, succeeded, failed, cancelled, interrupted), then its record renders/<id>.json once rendered: video and record paths, duration, size, fps, theme, variant, overrides, timings, the probe of the file. render_id "latest" (with scenario: of that scenario) names the newest render. wait_s long-polls until it finishes. Outside "untrusted" the answer holds only closed words and checked values (a status Retake never writes is unknown); warnings, a failure\'s message and the record as its file holds it (untrusted.record) are under "untrusted": they quote the scenario and the filmed site.',
  input: z.strictObject({
    project: projectSlug,
    render_id: z.union([renderId, z.literal('latest')]).describe('Render id (what render returned), or "latest".'),
    scenario: scenarioName.optional().describe('With render_id "latest": the newest render of this scenario.'),
    wait_s: waitS(0, 'the render to finish'),
  }),
  annotations: READ,
  async run({ project, render_id, scenario, wait_s }, ctx) {
    const { engine } = ctx;
    const first = await engine.renders.status(project, render_id, scenario ? { scenario } : {});
    if (wait_s > 0 && first.job && !first.finished) await waitJob(engine, await engine.jobs.get(first.job.id), wait_s, ctx);
    // What `latest` passed over is said by the first read (the second names the render by its id).
    const passed = renderLatestData(first);
    return renderStatusOutput(engine, project, first.render_id, renderLatestLines(first), passed.data, passed.untrusted);
  },
});
