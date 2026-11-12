/**
 * The MCP server's render tool (plan_preview and render_status are the engine's operations since L7.14: their objects
 * are served here in tools/list order, and render takes the summary and trusted lines they share from the contract).
 */
import { z } from 'zod';
import { OPERATIONS_BY_NAME, editLines, latestLines, renderInput, renderStatusOutput, waitJob, waitS } from '@retake/engine/contract';
import { plural } from '../result.js';
import { RENDER_JOB, defineTool } from './define.js';
import type { ToolContext, ToolDef } from './define.js';

const { plan_preview: planPreview, render_status: renderStatus } = OPERATIONS_BY_NAME;

export const render = defineTool({
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

export const RENDER_TOOLS = [planPreview, render, renderStatus] as const satisfies readonly ToolDef[];
