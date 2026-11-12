/**
 * Running one claimed job (L3.1 → L5.14): its state in job.json, its events, its history line — the code the jobs worker
 * runs for a capture in its own process, and a job process (`worker-main --job`, job-child.ts) runs for a heavy job.
 * One writer of job.json at a time: the claimer until the job runs, then whoever runs it. What a kind does is its
 * handler's (job-handlers.ts, one per kind); runJob holds what every kind shares around it.
 */
import { rm, writeFile } from 'node:fs/promises';
import { RETAKE_VERSION } from '@retake/core/base';
import { projectPath } from '@retake/core/project';
import { JOB_INPUT_VERSION, JOB_KINDS, JobInputSchema } from './job-input.js';
import type { RenderJobInput, RunJobInput } from './job-input.js';
import type { FilmingEvent, FilmingReport } from '@retake/runner-web/types';
import { stampOf } from '../clock.js';
import { toEngineError } from '../errors.js';
import type { InterruptPort } from '../interrupts.js';
import type { Renderer } from '../render/renderer.js';
import { openProjectBySlug } from '../projects.js';
import type { openWorkspace } from '../workspace.js';
import { FilmingMarker, TakeBeside } from './captures.js';
import { processStart } from './proc.js';
import type { ProcessIdentity } from './proc.js';
import { interrupted } from './interrupted.js';
import type { JobQueue } from './job-queue.js';
import { jobProject } from './queue-core.js';
import type { JobFiles } from './queue.js';
import { finaliseReservedRun } from './run-job.js';
import { appendHistory, runCounted } from '../history.js';
import type { EnginePorts } from '../ports.js';
import { approvalsOf, verifiedApprovals } from './signing.js';
import type { JobErrorView, JobEventBody, JobProgress, JobRecord, JobWorkerInfo } from './types.js';
import { handleJob } from './job-handlers.js';
import type { FreeBytes, RecordWindow } from './worker-ports.js';

export type Workspace = Awaited<ReturnType<typeof openWorkspace>>;

/** What a job runner runs with; its ports (ports.ts EnginePorts) are its composition root's (the worker, the job process). */
export interface JobRunnerContext extends EnginePorts {
  root: string;
  ws: Workspace;
  queue: JobQueue;
  /** The queue's paths: a render's browser.json, a run's live channel. */
  files: Pick<JobFiles, 'browser' | 'live'>;
  /** How the commands a human is asked to run start ("retake -C <root>"). */
  cli: string;
  build: string;
  /** Who runs the job (job.json `worker`): the worker for a capture, the job process for a heavy job. */
  worker: JobWorkerInfo;
  self: ProcessIdentity;
  /** The worker that claimed it, when a job process runs it (job.json `supervisor`). */
  supervisor?: JobWorkerInfo;
  log: (message: string) => void;
  interrupts: (signal: AbortSignal) => InterruptPort;
  /** The running job's cancel and a `record` job's stop, for the process's signal handler. */
  slot: { current?: AbortController; currentStop?: AbortController };
  /** Ids whose stored state is final. */
  done: Set<string>;
  /** Write job.json, or exit: a job whose state cannot be written must not look alive. */
  writeOrExit: (rec: JobRecord) => Promise<void>;
  /** What render, export and preview jobs render with: the composition root's choice (render/renderer.ts). */
  renderer: Renderer;
  /** The window a `record` job opens (worker-ports.ts; absent: the product's, a headed window a person drives). */
  recordWindow?: RecordWindow;
  /** What a library preview job reads the free space with (worker-ports.ts; absent: library.ts freeBytesOf). */
  freeBytes?: FreeBytes;
  /** Why the running job was aborted when it was not a cancel (a job process whose worker stopped): it ends interrupted. */
  abortedBecause?: () => string | undefined;
  /** A filming take of this process started (true), paused, resumed or stopped filming (L5.14: the worker's loop wakes). */
  onFilming?: (on: boolean) => void;
  /** The worker's heavy job runs slowed now (its own hold, review A H1): what a take of this worker reports. */
  heavySlowed?: () => boolean;
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A finished job's line of the history (history.jsonl). */
export function historyOf(job: JobRecord): Parameters<typeof appendHistory>[1] {
  const r = job.result;
  const run = r?.kind === 'run' && job.input.kind === 'run' ? { id: r.run_id, scenario: job.input.scenario, mode: r.mode, status: r.status } : undefined;
  const render = job.input.kind === 'render' ? { id: job.input.render_id, scenario: job.input.scenario, ...(r?.kind === 'render' ? { variant: r.variant } : {}) } : undefined;
  const review = job.input.kind === 'review' ? { render: job.input.render_id, ...(r?.kind === 'review' ? { clean: r.clean } : {}) } : undefined;
  // An export counts the formats it re-rendered through the planner (as `retake export` does); transcodes do not count.
  const exported =
    job.input.kind === 'export' ? { render: job.input.render_id, formats: r?.kind === 'export' ? r.outputs.map((o) => o.format) : [], rendered: r?.kind === 'export' ? r.rendered : 0 } : undefined;
  const preview =
    job.input.kind === 'preview'
      ? { id: job.input.preview_id, target: job.input.target.kind === 'component' ? job.input.target.component : job.input.target.kind, ...(r?.kind === 'preview' ? { theme: r.theme } : {}) }
      : undefined;
  // An inspection counts nothing (a dry replay to read a page, not a dry run of the scenario).
  const inspect = job.input.kind === 'inspect' ? { id: job.input.inspect_id, source: job.input.source.kind, ...(r?.kind === 'inspect' ? { status: r.status, reported: r.reported } : {}) } : undefined;
  // A recording counts nothing (its check replay is a check, not a dry run of a saved scenario).
  const record = job.input.kind === 'record' ? { id: job.input.rec_id, steps: r?.kind === 'record' ? r.stats.steps : 0, saved: r?.kind === 'record' && r.saved !== null } : undefined;
  // A site extraction counts nothing (workspace-level: no project).
  const site = job.input.kind === 'site' ? { id: job.input.site_id, host: new URL(job.input.url).hostname, ...(r?.kind === 'site' ? { status: r.status } : {}) } : undefined;
  const project = jobProject(job.input);
  const started = job.started_at ? Date.parse(job.started_at) : NaN;
  return {
    ...(job.finished_at ? { at: job.finished_at } : {}),
    job: job.id,
    kind: job.kind,
    ...(project !== undefined ? { project } : {}),
    submitted_by: job.input.submitted_by,
    state: job.state,
    ...(Number.isFinite(started) && job.finished_at ? { ms: Date.parse(job.finished_at) - started } : {}),
    ...(run ? { run } : {}),
    ...(render ? { render } : {}),
    ...(review ? { review } : {}),
    ...(exported ? { export: { render: exported.render, formats: exported.formats } } : {}),
    ...(preview ? { preview } : {}),
    ...(inspect ? { inspect } : {}),
    ...(record ? { record } : {}),
    ...(site ? { site } : {}),
    // A render counts once it wrote its video (the Remotion usage a licence would track); an export, its re-renders.
    counted: run ? runCounted(run.mode, run.status) : { captures: 0, dry_runs: 0, renders: render && job.state === 'succeeded' && r?.kind === 'render' ? 1 : (exported?.rendered ?? 0) },
  };
}

/** What in a job's input this worker does not know (a newer client's input version or kind), or null. */
export function unknownInput(input: unknown): string | null {
  const i = (input ?? {}) as { version?: unknown; kind?: unknown };
  if (i.version !== JOB_INPUT_VERSION) return `input version ${JSON.stringify(i.version ?? null)} (it knows ${JOB_INPUT_VERSION})`;
  if (!(JOB_KINDS as readonly unknown[]).includes(i.kind)) return `kind ${JSON.stringify(i.kind ?? null)} (it knows ${JOB_KINDS.join(', ')})`;
  return null;
}

/** Running claimed jobs with `c` (a worker, or a job process). */
export function createJobRunner(c: JobRunnerContext): { runJob: (stored: JobRecord) => Promise<void> } {
  const { root, ws, queue, files, cli, build, worker, self, log, interrupts, slot, done, writeOrExit, clock, stores, hooks, reviewer, capture, sandboxes } = c;

  /** The filming marker of a capture take (L5.14): written at capture time 0, paused with the take, removed at its end. */
  const filmingOf = (id: string, event: (e: JobEventBody) => void): { on: (state: FilmingEvent) => void | FilmingReport; close: () => void } => {
    let marker: FilmingMarker | null = null;
    let beside: TakeBeside | undefined;
    const close = () => {
      if (!marker) return;
      marker.closeSync();
      marker = null;
      c.onFilming?.(false);
    };
    return {
      on: (state) => {
        if (state === 'start' && !marker) {
          marker = FilmingMarker.open({ root, source: 'job', owner: self });
          if (!marker) log(`job ${id}: no filming marker (the captures folder cannot be used): heavy work elsewhere is not held`);
          c.onFilming?.(true);
          // What films or renders beside the take (run.json perf.machine), and one warning when another take films.
          beside = new TakeBeside({
            root,
            own: () => marker?.name,
            ...(c.heavySlowed ? { slowed: c.heavySlowed } : {}),
            onFirst: (where) =>
              event({ type: 'log', level: 'warn', message: `another take films ${where === 'here' ? 'in this workspace' : 'elsewhere on this Mac'} at the same time: both share the machine` }),
          });
          beside.start();
        } else if (state === 'pause' || state === 'resume') {
          marker?.setPaused(state === 'pause');
          c.onFilming?.(state === 'resume');
        } else if (state === 'stop') {
          close();
          const report = beside?.stop();
          beside = undefined;
          return report;
        }
        return undefined;
      },
      close: () => {
        beside?.stop();
        beside = undefined;
        close();
      },
    };
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
      const final: JobRecord = { ...rec, finished_at: stampOf(clock), ...(error ? { error } : {}) };
      await writeOrExit(final);
      append([
        { type: 'state', state: final.state },
        { type: 'result', ...(final.result ? { result: final.result } : {}), ...(error ? { error } : {}) },
      ]);
      await chain;
      done.add(id);
      await appendHistory(root, historyOf(final), clock);
      log(`job ${id}: ${final.state}${error ? ` (${error.message.split('\n')[0]})` : ''}`);
    };

    // A cancel asked before the claim closes the job without running it (its reserved run too).
    if ((await queue.cancelOf(id)) !== undefined) {
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
        {
          code: 'invalid',
          message: `refused without running: this worker (Retake ${RETAKE_VERSION}, build ${build}) does not know job ${unknown} — submit it again once the client and the worker run the same build`,
        },
      );
      return;
    }
    const parsed = JobInputSchema.safeParse(stored.input);
    if (!parsed.success) {
      await finish({ ...stored, state: 'failed' }, { code: 'invalid', message: `invalid job input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
      return;
    }
    const controller = new AbortController();
    slot.current = controller;
    let rec: JobRecord = { ...stored, state: 'running', started_at: stampOf(clock), worker, ...(c.supervisor ? { supervisor: c.supervisor } : {}) };
    await writeOrExit(rec);
    append([{ type: 'state', state: 'running' }]);
    log(`job ${id}: running (${stored.kind} ${jobProject(stored.input) ?? 'workspace'})`);

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
    // L4.4: a run's pause marker (a client creates and removes it), polled with the cancel marker; the runner reads the
    // gate between steps (a capture does not film the pause).
    const pauseGate: { requested: boolean; maxMs?: number } = { requested: false };
    // L4.8: a `record` job's stop marker (the Studio's Stop): the window closes as if the person closed it, the draft is
    // made and its check replay runs (a worker signal, currentStop, skips the check).
    const stopAsked = new AbortController();
    const cancelPoll = setInterval(() => {
      void queue.cancelOf(id).then((asked) => {
        if (asked !== undefined && !controller.signal.aborted) {
          log(`job ${id}: cancel requested`);
          controller.abort(capture.cancelled('run cancelled (cancel requested)'));
        }
      });
      if (stored.kind === 'record' && !stopAsked.signal.aborted) {
        void queue.stopOf(id).then(
          (asked) => {
            if (asked !== undefined && !stopAsked.signal.aborted) {
              log(`job ${id}: stop requested`);
              stopAsked.abort();
            }
          },
          () => undefined,
        );
      }
      if (stored.kind === 'run') {
        void queue.pauseOf(id).then(
          (mark) => {
            const asked = mark !== undefined;
            if (asked !== pauseGate.requested) log(`job ${id}: ${asked ? 'pause' : 'resume'} requested`);
            pauseGate.requested = asked;
          },
          () => undefined,
        );
      }
    }, 250);
    let error: JobErrorView | undefined;
    try {
      const event = (e: JobEventBody) => append([e]);
      // Only approvals a submit signed count (signing.ts): the others are dropped, their hooks refused.
      const { approvals, rejected } = await verifiedApprovals(parsed.data, { jobId: id, root });
      if (rejected) event({ type: 'log', level: 'warn', message: `${rejected} approval(s) of this job are not signed for it with this Retake home's key (not written by its submit): ignored` });
      const job = { ...parsed.data, ...(approvalsOf(parsed.data) ? { approvals } : {}) } as typeof parsed.data;
      // Every kind runs with trust `mcp` (hooks, seed steps): only the approvals taken at submit count.
      const base = { ws, cli, queue, signal: controller.signal, event, clock, stores, hooks, reviewer, capture, sandboxes };
      const onProgress = (p: JobProgress) => {
        latest = p;
        if (!progressTimer) progressTimer = setTimeout(flushProgress, 500);
      };
      // A render browser is recorded at once (pid + start time): a worker killed mid-render leaves it running.
      const recordBrowser = (b: { pid: number; user_data_dir?: string }) => {
        chain = chain.then(async () => {
          const t = await processStart(b.pid).catch(() => null);
          await writeFile(
            files.browser(id),
            `${JSON.stringify({ pid: b.pid, ...(t !== null ? { started_at: new Date(t).toISOString() } : {}), ...(b.user_data_dir ? { user_data_dir: b.user_data_dir } : {}) })}\n`,
          ).catch(() => undefined);
        });
      };
      const outcome = await handleJob(job, {
        id,
        base,
        interrupts: () => interrupts(controller.signal),
        progress: onProgress,
        browser: recordBrowser,
        renderer: c.renderer,
        files,
        self,
        log,
        pause: pauseGate,
        filming: () => filmingOf(id, event),
        stopAsked,
        slot,
        ...(c.recordWindow ? { recordWindow: c.recordWindow } : {}),
        ...(c.freeBytes ? { freeBytes: c.freeBytes } : {}),
      });
      rec = { ...rec, result: outcome.result, ...(outcome.progress && latest ? { progress: latest } : {}), state: outcome.state };
      if (outcome.error) error = outcome.error;
    } catch (e) {
      const err = toEngineError(e);
      const cancelled = controller.signal.aborted || err.code === 'cancelled';
      rec = { ...rec, state: cancelled ? 'cancelled' : 'failed' };
      error = { code: cancelled ? 'cancelled' : err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) };
    } finally {
      clearInterval(cancelPoll);
      if (progressTimer) clearTimeout(progressTimer);
      closed = true;
      slot.current = undefined;
    }
    // A job process whose worker stopped (job-child.ts): it ended itself, as interrupted rather than cancelled.
    const orphan = c.abortedBecause?.();
    if (orphan && rec.state === 'cancelled') {
      error = interrupted(rec, cli, orphan).error;
      rec = { ...rec, state: 'interrupted' };
    }
    if (stored.kind === 'render' || stored.kind === 'export' || stored.kind === 'preview') {
      // The render browser is closed: its record must not outlive the job (a reused pid is never killed anyway).
      await chain;
      await rm(files.browser(id), { force: true }).catch(() => undefined);
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
      await finaliseReservedRun(projectPath(project.dir, 'runs', input.run_id), status, message, clock);
    } catch (e) {
      log(`run ${input.run_id}: not finalised (${(e as Error).message})`);
    }
  }

  return { runJob };
}
