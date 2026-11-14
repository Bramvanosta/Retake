/** The façade's `runs` (createEngine): the list and status with the state of their job overlaid, submit (the admission rules), cancel, pause, thumbnails, the poster. */
import { EngineError } from '../errors.js';
import { listRuns, runStatus } from '../runs.js';
import { submitRunJob } from '../jobs/run-job.js';
import { checkRunId } from '../refs.js';
import { otherCopyWarning } from '../jobs/spawn.js';
import type { EngineContext } from './context.js';
import type { Engine, RunListItem, RunStatusWithJob } from './types.js';

/** engine.runs. */
export function runsApi(ctx: EngineContext): Engine['runs'] {
  const { opts, project, queue, submitCtx, startWorker, overlaid, admitted, runThumbs, boards } = ctx;
  const runStatusWithJob = async (slug: string, runId: string): Promise<RunStatusWithJob> => {
    const view: RunStatusWithJob = await runStatus(await project(slug), runId);
    const job = await queue.ofRun(slug, runId);
    if (!job) return view;
    const position = job.state === 'queued' ? await queue.position(job.id) : undefined;
    view.job = {
      id: job.id,
      state: job.state,
      ...(position ? { queue: position } : {}),
      ...(job.cancel_requested_at ? { cancel_requested_at: job.cancel_requested_at } : {}),
      ...(job.pause_requested_at ? { pause_requested_at: job.pause_requested_at } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
    const status = view.finished ? undefined : overlaid(view.status, job);
    if (status) {
      view.status = status;
      view.finished = true;
    }
    return view;
  };
  return {
    list: async (slug, o) => {
      const runs: RunListItem[] = await listRuns(await project(slug), o);
      for (const r of runs) {
        if (r.newer || r.unread || (r.status !== 'queued' && r.status !== 'running')) continue;
        const job = await queue.ofRun(slug, r.id);
        const status = job ? overlaid(r.status, job) : undefined;
        if (status) r.status = status;
      }
      return runs;
    },
    status: runStatusWithJob,
    submit: async (req, o = {}) => {
      const r = await (admitted ? admitted.run(req, (admit) => submitRunJob(submitCtx, req, o.approver, admit)) : submitRunJob(submitCtx, req, o.approver));
      const worker = await startWorker();
      return { job: r.job, run_id: r.run_id, warnings: [...r.warnings, ...(worker?.other ? [otherCopyWarning(worker.other)] : [])], ...(worker ? { worker } : {}) };
    },
    cancel: async (slug, runId) => {
      await project(slug);
      const job = await queue.ofRun(slug, runId);
      if (!job) {
        await runStatus(await project(slug), runId); // not_found when there is no such run
        throw new EngineError('refused', `run ${runId} was not started through a job (a \`retake run\` in a terminal): it is stopped with Ctrl-C there`);
      }
      const rec = await queue.cancel(job.id, opts.client);
      await startWorker();
      return rec;
    },
    pause: async (slug, runId, paused) => {
      const p = await project(slug);
      const job = await queue.ofRun(slug, runId);
      if (!job) {
        await runStatus(p, runId); // not_found when there is no such run
        throw new EngineError('refused', `run ${runId} was not started through a job (a \`retake run\` in a terminal): it cannot be paused from here`);
      }
      if (paused) {
        if (job.state === 'queued') throw new EngineError('conflict', `run ${runId} has not started yet: it can be paused once it runs (between steps)`);
        if (job.state !== 'running') throw new EngineError('conflict', `run ${runId} has ended (${job.state}): there is nothing to pause`);
        if (job.cancel_requested_at) throw new EngineError('conflict', `run ${runId} is stopping: it is not paused`);
      }
      await queue.requestPause(job.id, paused, opts.client);
      return runStatusWithJob(slug, runId);
    },
    thumbs: async (slug, runId, keys, o = {}) => runThumbs.thumbs((await project(slug)).dir, slug, runId, keys, o),
    poster: async (slug, runId) => boards.poster(await project(slug), checkRunId(runId)),
  };
}
