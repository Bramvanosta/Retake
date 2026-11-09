/**
 * The façade's production sub-APIs (createEngine): `renders` (plan, submit — the admission rules —, status, a scenario's
 * renders, frames and outlines), `timeline` (the timeline view), `reviews` (submit, read, images), `exports` (submit).
 */
import { submitRenderJob } from '../jobs/render-job.js';
import { planPreview, renderStatus, scenarioRenders } from '../renders.js';
import { timelineView } from '../timeline-view.js';
import { submitReviewJob } from '../jobs/review-job.js';
import { submitExportJob } from '../jobs/export-job.js';
import { reviewGet, reviewImage } from '../reviews.js';
import { otherCopyWarning } from '../jobs/spawn.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** engine.renders. */
export function rendersApi(ctx: EngineContext): Engine['renders'] {
  const { ws, project, studio, queue, submitCtx, startWorker, admitted, renderFrames } = ctx;
  return {
    plan: (req) => planPreview(ws, studio, req),
    submit: async (req) => {
      const submit = () => submitRenderJob(submitCtx, req);
      const r = await (admitted ? admitted.render(req, submit) : submit());
      const worker = await startWorker();
      return { ...r, ...(worker?.other ? { warnings: [...r.warnings, otherCopyWarning(worker.other)] } : {}), ...(worker ? { worker } : {}) };
    },
    status: (slug, renderId, o = {}) => renderStatus(ws, queue, slug, renderId, o.scenario),
    ofScenario: (slug, scenario) => scenarioRenders(ws, queue, slug, scenario),
    frame: async (slug, req, o = {}) => renderFrames.frame(await project(slug), req, o),
    outline: async (slug, req) => renderFrames.outline(await project(slug), req),
  };
}

/** engine.timeline. */
export function timelineApi(ctx: EngineContext): Engine['timeline'] {
  const { agent, via, ws, studio } = ctx;
  return {
    view: (req) => timelineView(ws, studio, req, { agent, via }),
  };
}

/** engine.reviews. */
export function reviewsApi(ctx: EngineContext): Engine['reviews'] {
  const { ws, queue, submitCtx, startWorker } = ctx;
  return {
    submit: async (req) => {
      const r = await submitReviewJob(submitCtx, req);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
    get: (slug, renderId, o = {}) => reviewGet(ws, queue, slug, renderId, o),
    image: (slug, renderId, image) => reviewImage(ws, slug, renderId, image),
  };
}

/** engine.exports. */
export function exportsApi(ctx: EngineContext): Engine['exports'] {
  const { submitCtx, startWorker, admitted } = ctx;
  return {
    submit: async (req) => {
      const r = await (admitted ? admitted.export(req, (recheck) => submitExportJob(submitCtx, req, { admit: recheck })) : submitExportJob(submitCtx, req));
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
  };
}
