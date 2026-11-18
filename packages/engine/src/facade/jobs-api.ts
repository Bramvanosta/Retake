/**
 * The façade's job sub-APIs (createEngine): `jobs` (read, wait for, cancel a job; the worker), and the submissions that
 * are a job and nothing else — `hooks`, `env` (a reset), `sandbox` (up, reset; its status is read here).
 */
import { EngineError } from '../errors.js';
import { sandboxStatus } from '../sandbox.js';
import { liveWorker } from '../jobs/lock.js';
import { checkEnvName, submitEnvResetJob, submitHooksJob } from '../jobs/hooks-job.js';
import { SandboxError } from '@retake/core/sandbox';
import { sandboxWork } from '../sandbox-work.js';
import { fileWriter } from '../store/project-store.js';
import { storeOf } from '../store/store.js';
import { submitSandboxJob } from '../jobs/sandbox-job.js';
import { checkAgentCancel } from '../record-studio.js';
import { FINISHED_JOB_STATES } from '../jobs/types.js';
import type { JobRecord } from '../jobs/types.js';
import type { EngineContext } from './context.js';
import type { Engine, WaitOptions } from './types.js';

/** How long past its timeout, in real time, a wait on a clock that did not move fails (jobs.wait). */
export const STALLED_CLOCK_MS = 1_000;

/** engine.jobs. */
export function jobsApi(ctx: EngineContext): Engine['jobs'] {
  const { opts, ws, queue, startWorker } = ctx;
  const getJob = async (id: string): Promise<JobRecord> => {
    const job = await queue.get(id);
    if (!job) throw new EngineError('not_found', `job ${id} not found (job_list names the jobs)`);
    return job;
  };
  const wait = async (id: string, w: WaitOptions): Promise<JobRecord> => {
    const clock = ctx.ports.clock;
    const started = clock.monotonic();
    const deadline = started + Math.max(0, w.timeoutMs);
    // The deadline is the clock's: a clock that does not move (a ManualClock nobody advances) would wait forever, so
    // past the wait plus STALLED_CLOCK_MS of real time with the clock still where it started, the wait fails, said.
    const realStart = performance.now();
    const stalled = () => clock.monotonic() === started && performance.now() - realStart > Math.max(0, w.timeoutMs) + STALLED_CLOCK_MS;
    let job = await getJob(id);
    let last = JSON.stringify([job.state, job.progress?.steps_done, job.progress?.current, job.progress?.phase, job.progress?.paused]);
    while (!FINISHED_JOB_STATES.has(job.state) && ctx.ports.clock.monotonic() < deadline && !w.signal?.aborted) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(300, Math.max(0, deadline - ctx.ports.clock.monotonic())));
        w.signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
      job = await getJob(id);
      if (!FINISHED_JOB_STATES.has(job.state) && stalled()) {
        throw new EngineError(
          'internal',
          `the wait for job ${id} did not end: the engine's clock did not move in ${Math.round(w.timeoutMs + STALLED_CLOCK_MS)} ms of real time (a manual clock that is never advanced)`,
        );
      }
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
      // B16: Claude never discards the person's open Studio recording through job_cancel.
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
    init: async (slug, env) => {
      checkEnvName(env);
      const p = await project(slug);
      const folder = ctx.scope.stores.folder(p.dir);
      const ref = (f: string) => folder.refOf(f);
      let view: Awaited<ReturnType<typeof sandboxWork.init>>;
      try {
        // Retake's own scaffold, never over a file (no force); written through the project store as the caller.
        view = await sandboxWork.init(ctx.ports, p, { ...(env !== undefined ? { env } : {}), write: fileWriter(storeOf(p, ctx.scope), 'sandbox') });
      } catch (e) {
        if (!(e instanceof SandboxError)) throw e;
        // The scaffold's refusals in this tool's words: its argument is `env`, and it never passes --force (the user
        // decides about their files). A name the scaffold cannot use is an invalid argument, not a conflict.
        const message = e.message
          .replace(
            /: --force writes the scaffold over (its files|it|them)/,
            ': sandbox_init never writes over a file — the user moves $1 away, or runs retake sandbox init with --force in their terminal',
          )
          .replace(/ \(--env\)/g, ' (env)');
        throw new EngineError(/cannot name an environment/.test(e.message) ? 'invalid' : 'conflict', message);
      }
      const r = view.result;
      const rel = ref(r.manifest);
      return {
        project: p.slug,
        env: r.env,
        dir: ref(r.dir),
        manifest: rel,
        files: r.files.map(ref),
        project_yaml: { action: r.projectYaml === 'added' ? 'added' : 'kept', entry: `sandboxes.${r.env}: ${rel}` },
        ports: r.ports,
        is_default: view.isDefault,
        warnings: view.warnings.map((w) => `${w.path.join('.')}: ${w.message}`),
      };
    },
  };
}
