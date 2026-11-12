/**
 * One handler per job kind (L7.29, P7): what running a claimed job of that kind does once runJob (run-job-record.ts)
 * has parsed it, verified its approvals and marked it running — the kind's execute function, and the state, result and
 * error its record ends with. `JOB_HANDLERS` is typed by the job kind: a kind without a handler, or a handler of no
 * kind, does not compile (no default branch). Everything around the handler — the claim, the cancel / stop / pause
 * poll, the progress writes, the final write, the history line — stays runJob's.
 */
import type { JobInput, JobKind } from './job-input.js';
import type { FilmingEvent, FilmingReport } from '@retake/runner-web/types';
import type { Clock } from '../clock.js';
import type { CaptureRunner } from '../capture/runner.js';
import type { HookRunner } from '../hook-run/runner.js';
import type { InterruptPort } from '../interrupts.js';
import type { Renderer } from '../render/renderer.js';
import type { Reviewer } from '../review/reviewer.js';
import type { Sandboxes } from '../sandboxes/sandboxes.js';
import type { ProjectStores } from '../store/store.js';
import type { openWorkspace } from '../workspace.js';
import { executeAuthLoginJob, signInStoppedText } from './auth-job.js';
import { executeEnvResetJob, executeHooksJob } from './hooks-job.js';
import type { JobQueue } from './job-queue.js';
import { openLiveChannel } from './live-channel.js';
import type { LiveChannel } from './live-channel.js';
import type { ProcessIdentity } from './proc.js';
import type { JobFiles } from './queue.js';
import { executeRunJob, pauseMaxMs } from './run-job.js';
import { executeSandboxJob } from './sandbox-job.js';
import type { JobErrorView, JobEventBody, JobProgress, JobResult } from './types.js';
import type { FreeBytes, RecordWindow } from './worker-ports.js';

/** The input of a job of kind `K`. */
export type JobOfKind<K extends JobKind> = Extract<JobInput, { kind: K }>;

/** What every kind's execute function is handed (trust `mcp`: only the approvals taken at submit count). */
export interface JobBase {
  ws: Awaited<ReturnType<typeof openWorkspace>>;
  cli: string;
  queue: JobQueue;
  /** The job's cancel. */
  signal: AbortSignal;
  event: (e: JobEventBody) => void;
  clock: Clock;
  stores: ProjectStores;
  hooks: HookRunner;
  reviewer: Reviewer;
  capture: CaptureRunner;
  sandboxes: Sandboxes;
}

/** What a handler runs with: the base context and the parts of runJob a kind uses. */
export interface JobRun {
  id: string;
  base: JobBase;
  /** The job's interrupt port (the runner's second-signal handling), on the job's cancel. */
  interrupts: () => InterruptPort;
  /** Progress, written to job.json at most every 500 ms. */
  progress: (p: JobProgress) => void;
  /** A render browser started: recorded at once (browser.json). */
  browser: (b: { pid: number; user_data_dir?: string }) => void;
  renderer: Renderer;
  files: Pick<JobFiles, 'browser' | 'live'>;
  self: ProcessIdentity;
  log: (message: string) => void;
  /** A run's pause marker, as the poll reads it (L4.4). */
  pause: { requested: boolean; maxMs?: number };
  /** A capture take's filming marker (L5.14). */
  filming: () => { on: (state: FilmingEvent) => void | FilmingReport; close: () => void };
  /** A `record` job's stop marker (L4.8: the Studio's Stop), as the poll reads it. */
  stopAsked: AbortController;
  /** The process's slot: a `record` job's worker stop is held there while it runs. */
  slot: { currentStop?: AbortController };
  /** The window a `record` job opens (absent: the product's). */
  recordWindow?: RecordWindow;
  /** What a library preview reads the free space with (absent: the product's). */
  freeBytes?: FreeBytes;
}

/** How a handled job ends: its state and result, its error, and whether its last progress is kept on the record. */
export interface JobOutcome {
  result: JobResult;
  state: 'succeeded' | 'cancelled';
  error?: JobErrorView;
  /** The record keeps the job's latest progress (the kinds that report one). */
  progress?: true;
}

export type JobHandler<K extends JobKind> = (job: JobOfKind<K>, run: JobRun) => Promise<JobOutcome>;

const succeeded = (result: JobResult, progress?: true): JobOutcome => ({ result, state: 'succeeded', ...(progress ? { progress } : {}) });

const runHandler: JobHandler<'run'> = async (job, run) => {
  const { id, base, log } = run;
  try {
    const max = pauseMaxMs();
    if (max !== undefined) run.pause.maxMs = max;
  } catch (e) {
    base.event({ type: 'log', level: 'warn', message: `${(e as Error).message}: the default (30 min) applies` });
  }
  // The live picture's channel (L4.4): a loopback listener and live.json, for as long as the job runs.
  let channel: LiveChannel | null = null;
  try {
    channel = await openLiveChannel({ files: run.files, jobId: id, runId: job.run_id, worker: run.self });
  } catch (e) {
    log(`job ${id}: no live picture (${(e as Error).message})`);
  }
  // L5.14: a filming take holds heavy work of every workspace while it films (captures.ts).
  const film = job.mode === 'capture' ? run.filming() : undefined;
  let result: Awaited<ReturnType<typeof executeRunJob>>;
  try {
    result = await executeRunJob({
      ...base,
      input: job,
      interrupts: run.interrupts(),
      progress: run.progress,
      ...(channel ? { live: channel.sink } : {}),
      pause: run.pause,
      ...(film ? { onFilming: film.on } : {}),
    });
  } finally {
    film?.close();
    await channel?.close();
  }
  if (result.status === 'cancelled') return { result, state: 'cancelled', error: { code: 'cancelled', message: result.untrusted?.error_message ?? 'run cancelled' }, progress: true };
  return succeeded(result, true);
};

const hooksHandler: JobHandler<'hooks'> = async (job, run) => {
  const result = await executeHooksJob({ ...run.base, input: job });
  return result.interrupted ? { result, state: 'cancelled', error: { code: 'cancelled', message: 'hooks cancelled: the remaining hooks did not run' } } : succeeded(result);
};

const envResetHandler: JobHandler<'env_reset'> = async (job, run) => {
  const result = await executeEnvResetJob({ ...run.base, input: job });
  return result.interrupted ? { result, state: 'cancelled', error: { code: 'cancelled', message: 'environment reset cancelled: the remaining hooks did not run' } } : succeeded(result);
};

const authLoginHandler: JobHandler<'auth_login'> = async (job, run) => {
  const result = await executeAuthLoginJob({ ...run.base, input: job, interrupts: run.interrupts() });
  if (!result.interrupted) return succeeded(result);
  return { result, state: 'cancelled', error: { code: 'cancelled', message: `sign-in ${result.timed_out ? 'stopped' : 'cancelled'}: ${signInStoppedText(result)}` } };
};

const sandboxHandler = async (job: JobOfKind<'sandbox_up' | 'sandbox_reset'>, run: JobRun): Promise<JobOutcome> =>
  succeeded(await executeSandboxJob({ ...run.base, input: job, interrupts: run.interrupts() }));

const renderHandler: JobHandler<'render'> = async (job, run) => {
  // Lazy: Remotion is loaded by the first render, never by a capture-only worker.
  const { executeRenderJob } = await import('./render-job.js');
  const result = await executeRenderJob({
    ...run.base,
    input: job,
    progress: run.progress,
    browser: run.browser,
    renderer: run.renderer,
    jobFile: (name, maxBytes) => run.base.queue.jobFile(run.id, name, maxBytes),
  });
  return succeeded(result, true);
};

const reviewHandler: JobHandler<'review'> = async (job, run) => {
  // Lazy: sharp and the review checks are loaded by the first review.
  const { executeReviewJob } = await import('./review-job.js');
  return succeeded(await executeReviewJob({ ...run.base, input: job, progress: run.progress }), true);
};

const exportHandler: JobHandler<'export'> = async (job, run) => {
  const { executeExportJob } = await import('./export-job.js');
  const result = await executeExportJob({ ...run.base, input: job, progress: run.progress, browser: run.browser, renderer: run.renderer });
  // A cancel stops between formats: what was written stays (and is in the result).
  if (!run.base.signal.aborted) return succeeded(result, true);
  return { result, state: 'cancelled', error: { code: 'cancelled', message: `export cancelled: ${result.outputs.length} of ${job.formats.length} formats written` }, progress: true };
};

const previewHandler: JobHandler<'preview'> = async (job, run) => {
  // Lazy: Remotion is loaded by the first preview. A cancel stops between images.
  const { executePreviewJob } = await import('./preview-job.js');
  return succeeded(
    await executePreviewJob({ ...run.base, input: job, progress: run.progress, browser: run.browser, renderer: run.renderer, ...(run.freeBytes ? { freeBytes: run.freeBytes } : {}) }),
    true,
  );
};

const inspectHandler: JobHandler<'inspect'> = async (job, run) => {
  // Lazy: the review package (sharp) draws the marks; the runner is already loaded.
  const { executeInspectJob } = await import('./inspect-job.js');
  return succeeded(await executeInspectJob({ ...run.base, input: job, progress: run.progress }), true);
};

const recordHandler: JobHandler<'record'> = async (job, run) => {
  // A headed window for a person: it holds the worker's capture slot (renders go on beside it) until it is closed.
  const { executeRecordJob } = await import('./record-job.js');
  const stop = new AbortController();
  run.slot.currentStop = stop;
  // A Stop asked before the worker took the job (the Studio's Stop as it was taken): seen before anything opens.
  if (!run.stopAsked.signal.aborted && (await run.base.queue.stopOf(run.id).catch(() => undefined)) !== undefined) run.stopAsked.abort();
  try {
    return succeeded(
      await executeRecordJob({
        ...run.base,
        input: job,
        jobId: run.id,
        stop: stop.signal,
        finish: run.stopAsked.signal,
        progress: run.progress,
        ...(run.recordWindow ? { window: run.recordWindow } : {}),
      }),
      true,
    );
  } finally {
    run.slot.currentStop = undefined;
  }
};

const siteHandler: JobHandler<'site'> = async (job, run) => {
  // A clean browser on one public page, through the worker's CONNECT proxy; refused without its signed approval.
  const { executeSiteJob } = await import('./site-job.js');
  return succeeded(await executeSiteJob({ ...run.base, jobId: run.id, input: job, progress: run.progress }), true);
};

/** The handler of each job kind (job-input.ts JOB_KINDS): exhaustive by its type. */
export const JOB_HANDLERS: { readonly [K in JobKind]: JobHandler<K> } = {
  run: runHandler,
  hooks: hooksHandler,
  env_reset: envResetHandler,
  auth_login: authLoginHandler,
  sandbox_up: (job, run) => sandboxHandler(job, run),
  sandbox_reset: (job, run) => sandboxHandler(job, run),
  render: renderHandler,
  review: reviewHandler,
  export: exportHandler,
  preview: previewHandler,
  inspect: inspectHandler,
  record: recordHandler,
  site: siteHandler,
};

/** Run a parsed job through its kind's handler. */
export function handleJob<K extends JobKind>(job: JobOfKind<K>, run: JobRun): Promise<JobOutcome> {
  // TypeScript does not tie a union's `kind` to the table's key: the table's type holds each pair.
  return (JOB_HANDLERS[job.kind as K] as JobHandler<K>)(job, run);
}
