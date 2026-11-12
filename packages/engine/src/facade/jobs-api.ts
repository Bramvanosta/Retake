/**
 * The façade's job sub-APIs (createEngine): `jobs` (read, wait for, cancel a job; the worker), and the submissions that
 * are a job and nothing else — `hooks`, `env` (a reset), `sandbox` (up, reset; its status is read here).
 */
import { EngineError } from '../errors.js';
import { sandboxStatus } from '../sandbox.js';
import { liveWorker } from '../jobs/lock.js';
import { submitEnvResetJob, submitHooksJob } from '../jobs/hooks-job.js';
import { submitSandboxJob } from '../jobs/sandbox-job.js';
import { checkAgentCancel } from '../record-studio.js';
import { FINISHED_JOB_STATES } from '../jobs/types.js';
import type { JobRecord } from '../jobs/types.js';
import type { EngineContext } from './context.js';
import type { Engine, WaitOptions } from './types.js';

/** engine.jobs. */
export function jobsApi(ctx: EngineContext): Engine['jobs'] {
  const { opts, ws, queue, startWorker } = ctx;
  const getJob = async (id: string): Promise<JobRecord> => {
    const job = await queue.get(id);
    if (!job) throw new EngineError('not_found', `job ${id} not found (job_list names the jobs)`);
    return job;
  };
  const wait = async (id: string, w: WaitOptions): Promise<JobRecord> => {
    const deadline = Date.now() + Math.max(0, w.timeoutMs);
    let job = await getJob(id);
    let last = JSON.stringify([job.state, job.progress?.steps_done, job.progress?.current, job.progress?.phase, job.progress?.paused]);
    while (!FINISHED_JOB_STATES.has(job.state) && Date.now() < deadline && !w.signal?.aborted) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(300, Math.max(0, deadline - Date.now())));
        w.signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
      job = await getJob(id);
      const now = JSON.stringify([job.state, job.progress?.steps_done, job.progress?.current, job.progress?.phase, job.progress?.paused]);
      if (now !== last) {
        last = now;
        w.onChange?.(job);
      }
    }
    return job;
  };
  return {
    get: getJob,
    list: (f) => queue.list(f),
    events: async (id, o) => (await getJob(id), queue.events(id, o)),
    cancel: async (id) => {
      // B16 (L4.8): Claude never discards the person's open Studio recording through job_cancel.
      checkAgentCancel(await getJob(id), opts.client);
      const rec = await queue.cancel(id, opts.client);
      await startWorker();
      return rec;
    },
    wait,
    position: (id) => queue.position(id),
    worker: () => liveWorker(ws.root),
  };
}

/** engine.hooks. */
export function hooksApi(ctx: EngineContext): Engine['hooks'] {
  const { submitCtx, startWorker } = ctx;
  return {
    submit: async (req, o = {}) => {
      const r = await submitHooksJob(submitCtx, req, o.approver);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
  };
}

/** engine.env. */
export function envApi(ctx: EngineContext): Engine['env'] {
  const { submitCtx, startWorker } = ctx;
  return {
    reset: async (req, o = {}) => {
      const r = await submitEnvResetJob(submitCtx, req, o.approver);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
  };
}

/** engine.sandbox. */
export function sandboxApi(ctx: EngineContext): Engine['sandbox'] {
  const { project, submitCtx, startWorker } = ctx;
  return {
    status: async (slug, env) => {
      const p = await project(slug);
      return sandboxStatus(p, env, ctx.ws.policy, ctx.scope.stores.folder(p.dir), ctx.ports.sandboxes);
    },
    up: async (req, o = {}) => {
      const r = await submitSandboxJob(submitCtx, 'sandbox_up', req, o.approver);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
    reset: async (req, o = {}) => {
      const r = await submitSandboxJob(submitCtx, 'sandbox_reset', req, o.approver);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
  };
}
