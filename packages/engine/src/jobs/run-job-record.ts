/**
 * Running one claimed job: its state in job.json, its events, its history line — the code the jobs worker
 * runs for a capture in its own process, and a job process (`worker-main --job`, job-child.ts) runs for a heavy job.
 * One writer of job.json at a time: the claimer until the job runs, then whoever runs it. What a kind does is its
 * handler's (job-handlers.ts, one per kind); runJob holds what every kind shares around it.
 */
import { RETAKE_VERSION, bestEffort, errorMessage } from '@retake/core/base';
import { join } from 'node:path';
import { runsDirOf } from '../outputs/outputs.js';
import { JOB_INPUT_VERSION, JOB_KINDS, JobInputSchema } from './job-input.js';
import type { RenderJobInput, RunJobInput } from './job-input.js';
import type { FilmingEvent, FilmingReport } from '@retake/runner-web/types';
import { stampOf } from '../clock.js';
import { toEngineError } from '../errors.js';
import type { InterruptPort } from '../interrupts.js';
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
import { portsOf } from '../ports.js';
import type { EnginePorts } from '../ports.js';
import { approvalsOf, verifiedApprovals } from './signing.js';
import type { JobErrorView, JobEventBody, JobProgress, JobRecord, JobWorkerInfo } from './types.js';
import { handleJob } from './job-handlers.js';
import type { JobBase } from './job-handlers.js';
import type { FreeBytes, RecordWindow } from './worker-ports.js';

export type Workspace = Awaited<ReturnType<typeof openWorkspace>>;

/** What a job runner runs with; its ports (ports.ts EnginePorts) are its composition root's (the worker, the job process). */
export interface JobRunnerContext extends EnginePorts {
  root: string;
  ws: Workspace;
  queue: JobQueue;
  /** The queue's paths: a run's live channel (a render's browser is recorded through the queue). */
  files: Pick<JobFiles, 'live'>;
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
  /** The window a `record` job opens (worker-ports.ts; absent: the product's, a headed window a person drives). */
  recordWindow?: RecordWindow;
  /** What a library preview job reads the free space with (worker-ports.ts; absent: library.ts freeBytesOf). */
  freeBytes?: FreeBytes;
  /** Why the running job was aborted when it was not a cancel (a job process whose worker stopped): it ends interrupted. */
  abortedBecause?: () => string | undefined;
  /** A filming take of this process started (true), paused, resumed or stopped filming (the worker's loop wakes). */
  onFilming?: (on: boolean) => void;
  /** The worker's heavy job runs slowed now (its own hold): what a take of this worker reports. */
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

/** The filming marker of a capture take: written at capture time 0, paused with the take, removed at its end. */
function filmingOf(c: JobRunnerContext, id: string, event: (e: JobEventBody) => void): { on: (state: FilmingEvent) => FilmingReport | undefined; close: () => void } {
  const { root, self, log } = c;
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
        marker = FilmingMarker.open({ root, source: 'job', owner: self, env: c.env });
        if (!marker) log(`job ${id}: no filming marker (the captures folder cannot be used): heavy work elsewhere is not held`);
        c.onFilming?.(true);
        // What films or renders beside the take (run.json perf.machine), and one warning when another take films.
        beside = new TakeBeside({
          root,
          env: c.env,
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
}

/** One job as it runs: its event sequence and write chain, its record, its pending progress. */
interface JobRun {
  id: string;
  seq: number;
  chain: Promise<unknown>;
  rec: JobRecord;
  /** The final write is made: no progress after it. */
  closed: boolean;
  progressTimer?: NodeJS.Timeout;
  latest?: JobProgress;
}

/** The markers a client sets while a job runs: its cancel, a `record` job's stop, a run's pause gate. */
interface JobControls {
  controller: AbortController;
  // A run's pause marker (a client creates and removes it), polled with the cancel marker; the runner reads the
  // gate between steps (a capture does not film the pause).
  pauseGate: { requested: boolean; maxMs?: number };
  // A `record` job's stop marker (the Studio's Stop): the window closes as if the person closed it, the draft is
  // made and its check replay runs (a worker signal, currentStop, skips the check).
  stopAsked: AbortController;
}

type ParsedJob = ReturnType<typeof JobInputSchema.parse>;

/** Events after those already written, in order (a failed write is logged, never thrown). */
function appendEvents(c: JobRunnerContext, st: JobRun, events: JobEventBody[]): void {
  st.chain = st.chain.then(async () => {
    try {
      st.seq = await c.queue.append(st.id, st.seq, events);
    } catch (e) {
      c.log(`job ${st.id}: events not written (${errorMessage(e)})`);
    }
  });
}

/** The job's final state: job.json, its last events, the history line. */
async function finishJob(c: JobRunnerContext, st: JobRun, rec: JobRecord, error?: JobErrorView): Promise<void> {
  const { id } = st;
  await st.chain;
  const final: JobRecord = { ...rec, finished_at: stampOf(c.clock), ...(error ? { error } : {}) };
  await c.writeOrExit(final);
  appendEvents(c, st, [
    { type: 'state', state: final.state },
    { type: 'result', ...(final.result ? { result: final.result } : {}), ...(error ? { error } : {}) },
  ]);
  await st.chain;
  c.done.add(id);
  await appendHistory(c.root, historyOf(final), c.clock);
  c.log(`job ${id}: ${final.state}${error ? ` (${error.message.split('\n')[0]})` : ''}`);
}

/** A job closed without running (cancelled before its claim, unknown or invalid input), or its parsed input. */
async function claimedInput(c: JobRunnerContext, st: JobRun, stored: JobRecord): Promise<ParsedJob | null> {
  // A cancel asked before the claim closes the job without running it (its reserved run too).
  if ((await c.queue.cancelOf(st.id)) !== undefined) {
    if (stored.input.kind === 'run') {
      await finaliseRun(c, stored.input, 'cancelled', 'cancelled before it started');
    }
    if (stored.input.kind === 'render') await releaseLock(c, stored.input);
    await finishJob(c, st, { ...stored, state: 'cancelled' }, { code: 'cancelled', message: 'cancelled before it started' });
    return null;
  }
  // A job this worker does not know is refused without running (never parsed as another kind).
  const unknown = unknownInput(stored.input);
  if (unknown) {
    await finishJob(
      c,
      st,
      { ...stored, state: 'failed' },
      {
        code: 'invalid',
        message: `refused without running: this worker (Retake ${RETAKE_VERSION}, build ${c.build}) does not know job ${unknown} — submit it again once the client and the worker run the same build`,
      },
    );
    return null;
  }
  const parsed = JobInputSchema.safeParse(stored.input);
  if (!parsed.success) {
    await finishJob(c, st, { ...stored, state: 'failed' }, { code: 'invalid', message: `invalid job input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    return null;
  }
  return parsed.data;
}

/** Progress: job.json at most every 500 ms; nothing after the final write. */
function flushProgress(c: JobRunnerContext, st: JobRun): void {
  st.progressTimer = undefined;
  if (st.closed || !st.latest) return;
  st.rec = { ...st.rec, progress: st.latest };
  const snapshot = st.rec;
  st.chain = st.chain.then(() =>
    st.closed ? undefined : c.queue.write(snapshot).catch((e: unknown) => c.log(`job ${st.id}: its progress could not be written (${errorMessage(e)}): it shows the last one written`)),
  );
}

/** Every 250 ms: the cancel marker, a `record` job's stop marker and a run's pause marker. */
function pollMarkers(c: JobRunnerContext, id: string, kind: JobRecord['kind'], k: JobControls): NodeJS.Timeout {
  const { queue, log, capture } = c;
  const { controller, pauseGate, stopAsked } = k;
  return setInterval(() => {
    void queue.cancelOf(id).then((asked) => {
      if (asked !== undefined && !controller.signal.aborted) {
        log(`job ${id}: cancel requested`);
        controller.abort(capture.cancelled('run cancelled (cancel requested)'));
      }
    });
    if (kind === 'record' && !stopAsked.signal.aborted) {
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
    if (kind === 'run') {
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
}

/** A render browser is recorded at once (pid + start time): a worker killed mid-render leaves it running. */
function recordBrowser(c: JobRunnerContext, st: JobRun, b: { pid: number; user_data_dir?: string }): void {
  st.chain = st.chain.then(async () => {
    const t = await bestEffort(processStart(b.pid), 'a process start that cannot be read is recorded without it (recovery then signals nothing)', null);
    await c.queue
      .recordBrowser(st.id, { pid: b.pid, ...(t !== null ? { started_at: new Date(t).toISOString() } : {}), ...(b.user_data_dir ? { user_data_dir: b.user_data_dir } : {}) })
      .catch((e: unknown) => c.log(`job ${st.id}: its render browser could not be recorded (${errorMessage(e)}): a worker that dies now leaves that browser running`));
  });
}

/** The kind's handler on the verified input: the record takes its outcome; its error, if any, is returned. */
async function handleClaimed(c: JobRunnerContext, st: JobRun, input: ParsedJob, k: JobControls): Promise<JobErrorView | undefined> {
  const { id } = st;
  const { root, ws, cli, queue, files, self, log, slot } = c;
  const event = (e: JobEventBody) => appendEvents(c, st, [e]);
  // Only approvals a submit signed count (signing.ts): the others are dropped, their hooks refused.
  const { approvals, rejected } = await verifiedApprovals(input, { jobId: id, root, env: c.env });
  if (rejected) event({ type: 'log', level: 'warn', message: `${rejected} approval(s) of this job are not signed for it with this Retake home's key (not written by its submit): ignored` });
  const job = { ...input, ...(approvalsOf(input) ? { approvals } : {}) } as typeof input;
  // Every kind runs with trust `mcp` (hooks, seed steps): only the approvals taken at submit count.
  const base: JobBase = { ws, cli, queue, signal: k.controller.signal, event, ...portsOf(c) };
  const onProgress = (p: JobProgress) => {
    st.latest = p;
    if (!st.progressTimer) st.progressTimer = setTimeout(() => flushProgress(c, st), 500);
  };
  const outcome = await handleJob(job, {
    id,
    base,
    interrupts: () => c.interrupts(k.controller.signal),
    progress: onProgress,
    browser: (b) => recordBrowser(c, st, b),
    renderer: c.renderer,
    files,
    self,
    log,
    pause: k.pauseGate,
    filming: () => filmingOf(c, id, event),
    stopAsked: k.stopAsked,
    slot,
    ...(c.recordWindow ? { recordWindow: c.recordWindow } : {}),
    ...(c.freeBytes ? { freeBytes: c.freeBytes } : {}),
  });
  st.rec = { ...st.rec, result: outcome.result, ...(outcome.progress && st.latest ? { progress: st.latest } : {}), state: outcome.state };
  return outcome.error;
}

/** One claimed job, from its claim to its final state (see the file's comment). */
async function runJob(c: JobRunnerContext, stored: JobRecord): Promise<void> {
  const { cli, worker, log, slot, clock } = c;
  const id = stored.id;
  const st: JobRun = { id, seq: 0, chain: Promise.resolve(), rec: stored, closed: false };
  const input = await claimedInput(c, st, stored);
  if (!input) return;
  const controller = new AbortController();
  slot.current = controller;
  st.rec = { ...stored, state: 'running', started_at: stampOf(clock), worker, ...(c.supervisor ? { supervisor: c.supervisor } : {}) };
  await c.writeOrExit(st.rec);
  appendEvents(c, st, [{ type: 'state', state: 'running' }]);
  log(`job ${id}: running (${stored.kind} ${jobProject(stored.input) ?? 'workspace'})`);

  const k: JobControls = { controller, pauseGate: { requested: false }, stopAsked: new AbortController() };
  const cancelPoll = pollMarkers(c, id, stored.kind, k);
  let error: JobErrorView | undefined;
  try {
    error = await handleClaimed(c, st, input, k);
  } catch (e) {
    const err = toEngineError(e);
    const cancelled = controller.signal.aborted || err.code === 'cancelled';
    st.rec = { ...st.rec, state: cancelled ? 'cancelled' : 'failed' };
    error = { code: cancelled ? 'cancelled' : err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) };
  } finally {
    clearInterval(cancelPoll);
    if (st.progressTimer) clearTimeout(st.progressTimer);
    st.closed = true;
    slot.current = undefined;
  }
  // A job process whose worker stopped (job-child.ts): it ended itself, as interrupted rather than cancelled.
  const orphan = c.abortedBecause?.();
  if (orphan && st.rec.state === 'cancelled') {
    error = interrupted(st.rec, cli, orphan).error;
    st.rec = { ...st.rec, state: 'interrupted' };
  }
  if (stored.kind === 'render' || stored.kind === 'export' || stored.kind === 'preview') {
    // The render browser is closed: its record must not outlive the job (a reused pid is never killed anyway).
    await st.chain;
    await c.queue.recordBrowser(id, null).catch(() => undefined);
  }
  await finishJob(c, st, st.rec, error);
}

async function releaseLock(c: JobRunnerContext, input: RenderJobInput): Promise<void> {
  try {
    const { releaseRenderLock } = await import('./render-job.js');
    await releaseRenderLock(c.ws, input);
  } catch (e) {
    c.log(`render ${input.render_id}: lock not released (${errorMessage(e)})`);
  }
}

async function finaliseRun(c: JobRunnerContext, input: RunJobInput, status: 'cancelled' | 'failed', message: string): Promise<void> {
  try {
    const project = await openProjectBySlug(c.ws, input.project);
    await finaliseReservedRun(c.ws.outputs.runs, join(runsDirOf(project.dir), input.run_id), status, message, c.clock);
  } catch (e) {
    c.log(`run ${input.run_id}: not finalised (${errorMessage(e)})`);
  }
}

/** Running claimed jobs with `c` (a worker, or a job process). */
export function createJobRunner(c: JobRunnerContext): { runJob: (stored: JobRecord) => Promise<void> } {
  return { runJob: (stored) => runJob(c, stored) };
}
