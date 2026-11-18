/** The façade's `tools` sub-API: the app's downloaded Tools for the Studio, on this engine's ports. */
import { abandonUpdateTools, checkToolsFor, controlToolsFor, installToolsFor, installUpdateTools, missingToolsNow, pruneToolsFor, toolLicences, toolsStarted, toolsStatusOf } from '../tools-work.js';
import { readUpdateArchive } from '../tools/update-archive.js';
import type { ToolsWork } from '../tools-work.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** engine.tools: the Tools of this engine's home (its ports' env), installed by the Studio when `by` is not given. */
export function toolsApi(ctx: EngineContext): Engine['tools'] {
  const work: ToolsWork = { env: ctx.ports.env, clock: ctx.ports.clock, ...(ctx.opts.tools ?? {}) };
  return {
    status: () => toolsStatusOf(work),
    async install(req) {
      const r = await installToolsFor(work, { ...req, by: req.by ?? 'studio' });
      // Jobs that waited for the Tools: the worker exited (it never waits busy), so it is started again.
      if (r.outcome === 'ready') await ctx.startWorker().catch(() => undefined);
      return r;
    },
    control: (action) => controlToolsFor(work, action),
    check: () => checkToolsFor(work, 'studio'),
    prune: (o) => pruneToolsFor(work, o),
    started: () => toolsStarted(work),
    // The updater's server side (the Studio's update-tools.ts): an update's own Tools, before its restart.
    readUpdate: (a) => readUpdateArchive(a),
    installUpdate: (u) => installUpdateTools(work, u),
    licences: () => toolLicences(work),
    abandonUpdate: (app) => abandonUpdateTools(work, app),
    async wake() {
      // The worker exits while only jobs held by the Tools wait; once they are ready, a queued job it can claim
      // starts it again (the Studio when it sees them ready or opens, `retake tools install` when it ends). Decided
      // from the Tools as they are now, never the queue's gate (cached for a second: it may predate the install).
      const fresh = missingToolsNow(work);
      const queued = await ctx.queue.list({ states: ['queued'], limit: 50, tools: () => fresh });
      if (!queued.some((j) => j.state === 'queued' && j.yield?.cause !== 'tools')) return false;
      return (await ctx.startWorker()) !== undefined;
    },
  };
}
