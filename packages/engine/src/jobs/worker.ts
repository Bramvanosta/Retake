/**
 * The jobs worker of a workspace (L3.1): one process per workspace (the worker lock), one job at a time. It claims the
 * oldest queued job, runs it with the same engine code as the CLI, writes its state, and exits once idle — or when the
 * workspace disappears, or when its build changed (it then hands over to a new worker if jobs wait).
 *
 * Signals: the first SIGINT / SIGTERM stops claiming and cancels the running job (its teardown and rollbacks still
 * run — the runner aborts on the same signal), then the worker exits. Any later signal quits at once: session copies
 * and what a sandbox take started are removed synchronously; the quit is deferred to the next tick so that the
 * runner's own second-signal handler (registered after this one) still kills the shell hooks it runs.
 *
 * A job whose final state cannot be written makes the worker exit non-zero: readers then see its pid gone and derive
 * `interrupted`, never a `running` job with a live pid that will never finish.
 */
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_STUDIO_VERSION, JOB_INPUT_VERSION, JOB_KINDS, JobInputSchema } from '@demo-studio/core';
import type { RenderJobInput, RunJobInput } from '@demo-studio/core';
import { toEngineError } from '../errors.js';
import type { InterruptPort } from '../interrupts.js';
import { openProjectBySlug } from '../projects.js';
import { openWorkspace } from '../workspace.js';
import { buildStamp } from './build.js';
import { WorkerLock } from './lock.js';
import { processStart, selfIdentity } from './proc.js';
import { FileJobQueue, stateDir } from './queue.js';
import { executeEnvResetJob, executeHooksJob } from './hooks-job.js';
import { executeRunJob, finaliseReservedRun } from './run-job.js';
import { executeAuthLoginJob } from './auth-job.js';
import { executeSandboxJob } from './sandbox-job.js';
import { appendHistory, runCounted } from '../history.js';
import { approvalsOf, verifiedApprovals } from './signing.js';
import { spawnWorker } from './spawn.js';
import { FINISHED_JOB_STATES } from './types.js';
import type { JobErrorView, JobEventBody, JobProgress, JobRecord, JobWorkerInfo } from './types.js';

export interface WorkerOptions {
  root: string;
  /** Exit after this long without a job (ms, default 60 000). */
  idleExitMs?: number;
  /** How often the queue and a running job's cancel marker are looked at (ms, default 500 / 250). */
  pollMs?: number;
  /** Run at most one job, then exit (tests). */
  once?: boolean;
  /** Diagnostics (stderr): never stdout. */
  log?: (message: string) => void;
  /** How often the build is compared while idle (ms, default 5 000). */
  buildCheckMs?: number;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A finished job's line of the history (history.jsonl). */
function historyOf(job: JobRecord): Parameters<typeof appendHistory>[1] {
  const r = job.result;
  const run = r?.kind === 'run' && job.input.kind === 'run' ? { id: r.run_id, scenario: job.input.scenario, mode: r.mode, status: r.status } : undefined;
  const render =
    job.input.kind === 'render' ? { id: job.input.render_id, scenario: job.input.scenario, ...(r?.kind === 'render' ? { variant: r.variant } : {}) } : undefined;
  const review = job.input.kind === 'review' ? { render: job.input.render_id, ...(r?.kind === 'review' ? { clean: r.clean } : {}) } : undefined;
  // An export counts the formats it re-rendered through the planner (as `studio export` does); transcodes do not count.
  const exported = job.input.kind === 'export' ? { render: job.input.render_id, formats: r?.kind === 'export' ? r.outputs.map((o) => o.format) : [], rendered: r?.kind === 'export' ? r.rendered : 0 } : undefined;
  const preview =
    job.input.kind === 'preview'
      ? { id: job.input.preview_id, target: job.input.target.kind === 'component' ? job.input.target.component : 'theme', ...(r?.kind === 'preview' ? { theme: r.theme } : {}) }
      : undefined;
  const started = job.started_at ? Date.parse(job.started_at) : NaN;
  return {
    ...(job.finished_at ? { at: job.finished_at } : {}),
    job: job.id,
    kind: job.kind,
    project: job.input.project,
    submitted_by: job.input.submitted_by,
    state: job.state,
    ...(Number.isFinite(started) && job.finished_at ? { ms: Date.parse(job.finished_at) - started } : {}),
    ...(run ? { run } : {}),
    ...(render ? { render } : {}),
    ...(review ? { review } : {}),
    ...(exported ? { export: { render: exported.render, formats: exported.formats } } : {}),
    ...(preview ? { preview } : {}),
    // A render counts once it wrote its video (the Remotion usage a licence would track); an export, its re-renders.
    counted: run
      ? runCounted(run.mode, run.status)
      : { captures: 0, dry_runs: 0, renders: render && job.state === 'succeeded' && r?.kind === 'render' ? 1 : (exported?.rendered ?? 0) },
  };
}

/** What in a job's input this worker does not know (a newer client's input version or kind), or null. */
function unknownInput(input: unknown): string | null {
  const i = (input ?? {}) as { version?: unknown; kind?: unknown };
  if (i.version !== JOB_INPUT_VERSION) return `input version ${JSON.stringify(i.version ?? null)} (it knows ${JOB_INPUT_VERSION})`;
  if (!(JOB_KINDS as readonly unknown[]).includes(i.kind)) return `kind ${JSON.stringify(i.kind ?? null)} (it knows ${JOB_KINDS.join(', ')})`;
  return null;
}

const sleep = (ms: number, wake: { fn?: () => void }) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    wake.fn = () => {
      clearTimeout(t);
      r();
    };
  });

/** Run a worker until it is idle, stopped or replaced; resolves with the process exit code. */
export async function runWorker(o: WorkerOptions): Promise<number> {
  const log = o.log ?? ((m: string) => void process.stderr.write(`${new Date().toISOString()} worker ${process.pid}: ${m}\n`));
  const root = resolve(o.root);
  const idleExitMs = o.idleExitMs ?? 60_000;
  const pollMs = o.pollMs ?? 500;
  const buildCheckMs = o.buildCheckMs ?? 5_000;
  let ws: Awaited<ReturnType<typeof openWorkspace>>;
  try {
    ws = await openWorkspace({ root });
  } catch (e) {
    log(`no workspace at ${root}: ${(e as Error).message}`);
    return 1;
  }
  const cli = `studio -C ${shellQuote(root)}`;
  const queue = new FileJobQueue(root, cli);
  const build = buildStamp();
  let lock = await WorkerLock.acquire(root, build, log);
  if (!lock) {
    log('another worker serves this workspace: exiting');
    return 0;
  }
  const self = await selfIdentity();
  const worker: JobWorkerInfo = { ...self, host: hostname() };
  const rw = await import('@demo-studio/runner-web');
  log(`serving ${root} (build ${build})`);

  // ── signals ──
  let stopping = false;
  let signals = 0;
  let current: AbortController | undefined;
  const quitSync = new Set<() => void>();
  const wake: { fn?: () => void } = {};
  const onSignal = (sig: NodeJS.Signals) => {
    signals++;
    if (signals === 1) {
      stopping = true;
      log(`${sig}: stopping${current ? ' (cancelling the running job: its teardown still runs)' : ''}`);
      current?.abort(new rw.CancelledError(`run cancelled (${sig})`));
      wake.fn?.();
      return;
    }
    rw.removeSessionCopiesSync();
    for (const f of quitSync) {
      try {
        f();
      } catch {
        /* quitting anyway */
      }
    }
    lock?.release();
    process.nextTick(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // A render that fails mid-way (a refused download, a component error) leaves Remotion's encoder pipe to reject with
  // EPIPE after the failure, unhandled: the job already failed, the worker must not die of it. Anything else still
  // crashes the worker (readers then derive `interrupted`).
  const onRejection = (reason: unknown) => {
    if ((reason as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') {
      log(`ignored a write to a closed pipe after a render (${(reason as Error).message})`);
      return;
    }
    throw reason;
  };
  process.on('unhandledRejection', onRejection);

  const interrupts = (signal: AbortSignal): InterruptPort => ({
    open: async (opts = {}) => {
      const q = opts.onQuitSync;
      if (q) quitSync.add(q);
      return {
        signal,
        get interrupted() {
          return signal.aborted;
        },
        dispose: () => {
          if (q) quitSync.delete(q);
        },
      };
    },
  });

  /** Ids whose stored state is final: not read again. */
  const done = new Set<string>();
  /** A queued job this build does not know while the code changed: a new worker takes it (handover). */
  let newerJob = false;

  /** Persist what dead workers could not write (this worker holds the lock: no other one runs). */
  const persistDerived = async (stored: JobRecord): Promise<void> => {
    const rec = await queue.derive(stored);
    if (rec.state === 'interrupted') {
      const final = { ...rec, finished_at: rec.finished_at ?? new Date().toISOString() };
      await queue.write(final);
      done.add(rec.id);
      await appendHistory(root, historyOf(final));
      // A killed render leaves its browser running (Remotion starts it detached), its lock and partial files.
      if (rec.input.kind === 'render') {
        const { cleanupInterruptedRender } = await import('./render-job.js');
        await cleanupInterruptedRender(ws, queue, final, log);
      } else if (rec.input.kind === 'export') {
        // An export's re-render leaves the same: its browser and partial files.
        const { cleanupInterruptedExport } = await import('./export-job.js');
        await cleanupInterruptedExport(ws, queue, final, log);
      } else if (rec.input.kind === 'preview') {
        // A preview's browser, started detached like a render's.
        const { killRecordedBrowser } = await import('./render-job.js');
        await killRecordedBrowser(queue, final, log);
      } else if (rec.input.kind === 'review') {
        // A review killed between its two renames leaves the previous review set aside.
        const { cleanupInterruptedReview } = await import('./review-job.js');
        await cleanupInterruptedReview(ws, final, log);
      }
    }
  };

  const claimNext = async (): Promise<JobRecord | undefined> => {
    for (const id of await queue.ids()) {
      if (done.has(id)) continue;
      const stored = await queue.stored(id);
      if (!stored) continue;
      if (FINISHED_JOB_STATES.has(stored.state)) {
        done.add(id);
        continue;
      }
      if (stored.state === 'running' || (await queue.claimOf(id))) {
        await persistDerived(stored);
        continue;
      }
      // A job of a newer client (its input version or kind): left for a worker of the new build when the code changed.
      if (unknownInput(stored.input) && buildStamp() !== build) {
        newerJob = true;
        return undefined;
      }
      if (await queue.claim(id, self)) return stored;
    }
    return undefined;
  };

  const hasQueued = async (): Promise<boolean> => {
    for (const id of await queue.ids()) {
      if (done.has(id)) continue;
      const rec = await queue.get(id);
      if (rec?.state === 'queued') return true;
    }
    return false;
  };

  /** Write job.json, or exit: a job whose state cannot be written must not look alive. */
  const writeOrExit = async (rec: JobRecord): Promise<void> => {
    try {
      await queue.write(rec);
    } catch (e) {
      log(`cannot write the state of job ${rec.id} (${(e as Error).message}): exiting`);
      lock?.release();
      process.exit(1);
    }
  };

  const runJob = async (stored: JobRecord): Promise<void> => {
    const id = stored.id;
    let seq = 0;
    let chain: Promise<unknown> = Promise.resolve();
    const append = (events: JobEventBody[]) => {
      chain = chain.then(async () => {
        try {
          seq = await queue.append(id, seq, events);
        } catch (e) {
          log(`job ${id}: events not written (${(e as Error).message})`);
        }
      });
    };
    const finish = async (rec: JobRecord, error?: JobErrorView) => {
      await chain;
      const final: JobRecord = { ...rec, finished_at: new Date().toISOString(), ...(error ? { error } : {}) };
      await writeOrExit(final);
      append([{ type: 'state', state: final.state }, { type: 'result', ...(final.result ? { result: final.result } : {}), ...(error ? { error } : {}) }]);
      await chain;
      done.add(id);
      await appendHistory(root, historyOf(final));
      log(`job ${id}: ${final.state}${error ? ` (${error.message.split('\n')[0]})` : ''}`);
    };

    // A cancel asked before the claim closes the job without running it (its reserved run too).
    if (await queue.cancelRequested(id)) {
      if (stored.input.kind === 'run') {
        await finaliseRun(stored.input, 'cancelled', 'cancelled before it started');
      }
      if (stored.input.kind === 'render') await releaseLock(stored.input);
      await finish({ ...stored, state: 'cancelled' }, { code: 'cancelled', message: 'cancelled before it started' });
      return;
    }
    // A job this worker does not know is refused without running (never parsed as another kind).
    const unknown = unknownInput(stored.input);
    if (unknown) {
      await finish(
        { ...stored, state: 'failed' },
        { code: 'invalid', message: `refused without running: this worker (Demo Studio ${DEMO_STUDIO_VERSION}, build ${build}) does not know job ${unknown} — submit it again once the client and the worker run the same build` },
      );
      return;
    }
    const parsed = JobInputSchema.safeParse(stored.input);
    if (!parsed.success) {
      await finish({ ...stored, state: 'failed' }, { code: 'invalid', message: `invalid job input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
      return;
    }
    const controller = new AbortController();
    current = controller;
    let rec: JobRecord = { ...stored, state: 'running', started_at: new Date().toISOString(), worker };
    await writeOrExit(rec);
    append([{ type: 'state', state: 'running' }]);
    log(`job ${id}: running (${stored.kind} ${stored.input.project})`);

    // Progress: job.json at most every 500 ms; nothing after the final write.
    let closed = false;
    let progressTimer: NodeJS.Timeout | undefined;
    let latest: JobProgress | undefined;
    const flushProgress = () => {
      progressTimer = undefined;
      if (closed || !latest) return;
      rec = { ...rec, progress: latest };
      const snapshot = rec;
      chain = chain.then(() => (closed ? undefined : queue.write(snapshot).catch(() => undefined)));
    };
    const cancelPoll = setInterval(() => {
      void queue.cancelRequested(id).then((asked) => {
        if (asked && !controller.signal.aborted) {
          log(`job ${id}: cancel requested`);
          controller.abort(new rw.CancelledError('run cancelled (cancel requested)'));
        }
      });
    }, 250);
    let error: JobErrorView | undefined;
    try {
      const event = (e: JobEventBody) => append([e]);
      // Only approvals a submit signed count (signing.ts): the others are dropped, their hooks refused.
      const { approvals, rejected } = await verifiedApprovals(parsed.data);
      if (rejected) event({ type: 'log', level: 'warn', message: `${rejected} approval(s) of this job are not signed by this studio home's key (not written by a submit): ignored` });
      const job = { ...parsed.data, ...(approvalsOf(parsed.data) ? { approvals } : {}) } as typeof parsed.data;
      // Every kind runs with trust `mcp` (hooks, seed steps): only the approvals taken at submit count.
      const base = { ws, cli, signal: controller.signal, event };
      const onProgress = (p: JobProgress) => {
        latest = p;
        if (!progressTimer) progressTimer = setTimeout(flushProgress, 500);
      };
      // A render browser is recorded at once (pid + start time): a worker killed mid-render leaves it running.
      const recordBrowser = (b: { pid: number; user_data_dir?: string }) => {
        chain = chain.then(async () => {
          const t = await processStart(b.pid).catch(() => null);
          await writeFile(queue.browserFile(id), `${JSON.stringify({ pid: b.pid, ...(t !== null ? { started_at: new Date(t).toISOString() } : {}), ...(b.user_data_dir ? { user_data_dir: b.user_data_dir } : {}) })}\n`).catch(() => undefined);
        });
      };
      switch (job.kind) {
        case 'run': {
          const result = await executeRunJob({
            ...base,
            input: job,
            interrupts: interrupts(controller.signal),
            progress: onProgress,
          });
          rec = { ...rec, result, ...(latest ? { progress: latest } : {}), state: result.status === 'cancelled' ? 'cancelled' : 'succeeded' };
          if (result.status === 'cancelled') error = { code: 'cancelled', message: result.untrusted?.error_message ?? 'run cancelled' };
          break;
        }
        case 'hooks':
        case 'env_reset': {
          const result = job.kind === 'hooks' ? await executeHooksJob({ ...base, input: job }) : await executeEnvResetJob({ ...base, input: job });
          rec = { ...rec, result, state: result.interrupted ? 'cancelled' : 'succeeded' };
          if (result.interrupted) error = { code: 'cancelled', message: `${job.kind === 'hooks' ? 'hooks' : 'environment reset'} cancelled: the remaining hooks did not run` };
          break;
        }
        case 'auth_login': {
          const result = await executeAuthLoginJob({ ...base, input: job, interrupts: interrupts(controller.signal) });
          rec = { ...rec, result, state: result.interrupted ? 'cancelled' : 'succeeded' };
          if (result.interrupted) error = { code: 'cancelled', message: 'sign-in cancelled: the window was closed, nothing was saved' };
          break;
        }
        case 'sandbox_up':
        case 'sandbox_reset': {
          const result = await executeSandboxJob({ ...base, input: job, interrupts: interrupts(controller.signal) });
          rec = { ...rec, result, state: 'succeeded' };
          break;
        }
        case 'render': {
          // Lazy: Remotion is loaded by the first render, never by a capture-only worker.
          const { executeRenderJob } = await import('./render-job.js');
          const result = await executeRenderJob({
            ...base,
            input: job,
            progress: onProgress,
            browser: recordBrowser,
          });
          rec = { ...rec, result, ...(latest ? { progress: latest } : {}), state: 'succeeded' };
          break;
        }
        case 'review': {
          // Lazy: sharp and the review checks are loaded by the first review.
          const { executeReviewJob } = await import('./review-job.js');
          const result = await executeReviewJob({ ...base, input: job, progress: onProgress });
          rec = { ...rec, result, ...(latest ? { progress: latest } : {}), state: 'succeeded' };
          break;
        }
        case 'export': {
          const { executeExportJob } = await import('./export-job.js');
          const result = await executeExportJob({ ...base, input: job, progress: onProgress, browser: recordBrowser });
          // A cancel stops between formats: what was written stays (and is in the result).
          const cancelled = controller.signal.aborted;
          rec = { ...rec, result, ...(latest ? { progress: latest } : {}), state: cancelled ? 'cancelled' : 'succeeded' };
          if (cancelled) error = { code: 'cancelled', message: `export cancelled: ${result.outputs.length} of ${job.formats.length} formats written` };
          break;
        }
        case 'preview': {
          // Lazy: Remotion is loaded by the first preview. A cancel stops between images.
          const { executePreviewJob } = await import('./preview-job.js');
          const result = await executePreviewJob({ ...base, input: job, progress: onProgress, browser: recordBrowser });
          rec = { ...rec, result, ...(latest ? { progress: latest } : {}), state: 'succeeded' };
          break;
        }
        default: {
          const never: never = job;
          throw new Error(`unknown job kind ${(never as { kind: string }).kind}`);
        }
      }
    } catch (e) {
      const err = toEngineError(e);
      const cancelled = controller.signal.aborted || err.code === 'cancelled';
      rec = { ...rec, state: cancelled ? 'cancelled' : 'failed' };
      error = { code: cancelled ? 'cancelled' : err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) };
    } finally {
      clearInterval(cancelPoll);
      if (progressTimer) clearTimeout(progressTimer);
      closed = true;
      current = undefined;
    }
    if (stored.kind === 'render' || stored.kind === 'export' || stored.kind === 'preview') {
      // The render browser is closed: its record must not outlive the job (a reused pid is never killed anyway).
      await chain;
      await rm(queue.browserFile(id), { force: true }).catch(() => undefined);
    }
    await finish(rec, error);
  };

  async function releaseLock(input: RenderJobInput): Promise<void> {
    try {
      const { releaseRenderLock } = await import('./render-job.js');
      await releaseRenderLock(ws, input);
    } catch (e) {
      log(`render ${input.render_id}: lock not released (${(e as Error).message})`);
    }
  }

  async function finaliseRun(input: RunJobInput, status: 'cancelled' | 'failed', message: string): Promise<void> {
    try {
      const project = await openProjectBySlug(ws, input.project);
      await finaliseReservedRun(join(project.dir, 'runs', input.run_id), status, message);
    } catch (e) {
      log(`run ${input.run_id}: not finalised (${(e as Error).message})`);
    }
  }

  // ── the loop ──
  let idleSince = Date.now();
  let lastBuildCheck = Date.now();
  let handover = false;
  try {
    for (;;) {
      if (stopping) break;
      if (!existsSync(stateDir(root))) {
        log('the workspace is gone: exiting');
        break;
      }
      const job = await claimNext();
      if (newerJob) {
        log('a queued job needs a newer build than this worker: handing over');
        handover = true;
        break;
      }
      if (job) {
        await runJob(job);
        idleSince = Date.now();
        if (o.once) break;
        continue;
      }
      if (Date.now() - idleSince >= idleExitMs) {
        // Idle: release the lock, then look once more — a job queued while a client saw this worker alive must not wait.
        lock.release();
        if (!(await hasQueued())) break;
        const again = await WorkerLock.acquire(root, build, log);
        if (!again) break; // another worker took over
        lock = again;
        idleSince = Date.now();
        continue;
      }
      if (Date.now() - lastBuildCheck >= buildCheckMs) {
        lastBuildCheck = Date.now();
        if (buildStamp() !== build) {
          log('the code changed since this worker started: handing over');
          handover = true;
          break;
        }
      }
      await sleep(pollMs, wake);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('unhandledRejection', onRejection);
    lock.release();
  }
  if (handover && !stopping && existsSync(stateDir(root)) && (await hasQueued())) await spawnWorker(root, { idleExitMs });
  return 0;
}
