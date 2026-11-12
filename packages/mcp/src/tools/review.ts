/**
 * The MCP server's review tool (review_get is the engine's operation since L7.14: its object is served here in
 * tools/list order, and review answers with its summary and answer, taken from the contract).
 */
import { z } from 'zod';
import { OPERATIONS_BY_NAME, detail, renderLatestData, renderLatestLines, reviewImages as images, reviewOutput, reviewRenderRef as renderRef, waitJob, waitS } from '@retake/engine/contract';
import { projectSlug, renderId, scenarioName } from '../schema.js';
import { RENDER_JOB, defineTool } from './define.js';
import type { ToolContext, ToolDef } from './define.js';

const { review_get: reviewGet } = OPERATIONS_BY_NAME;

export const reviewTool = defineTool({
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

export const REVIEW_TOOLS = [reviewTool, reviewGet] as const satisfies readonly ToolDef[];
