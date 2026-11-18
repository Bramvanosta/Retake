/**
 * The in-memory capture runner's run (memory-capture.ts `run`): what a run does that the engine reads,
 * without a browser or an encoder — the run folder and its run.json through the request's Outputs port (`req.runs`:
 * reserve, writeJson) and core's records (startedRun, finishRun), scenario.yaml, a minimal timeline.json, a marker capture.mp4 in capture mode; the progress
 * events (`run_start`, `outline`, hooks, `scene_start`, `step_start` / `step_end`, pauses, `run_end`); the signal, `until`,
 * the pause gate, the live sink (one frame per step while it is wanted), an inspection's report (inspect.json and
 * `onResult`), `onFilming` (start, pause, resume, stop) and the scenario's hooks through the handed hook runner (setup,
 * `hook:` steps, teardown, the setup's rollbacks after it — as the runner orders them).
 *
 * A `wait` or `hold` step sleeps its seconds (abortably): a cancel during a run is seen as with the runner. A step the
 * options script as failing (`fail`) fails the run there. Limits: nothing is opened, filmed, typed or checked; no
 * persona, no sign-in, no secret, no write guard; a dry run executes every step (no irreversible one is skipped).
 * What it stamps (run.json's times, a pause's, the timeline's) is its clock's; elapsed times are performance.now's.
 */
import { join, resolve } from 'node:path';
import { FORMAT_VERSIONS, errorMessage, runRecordOnDisk } from '@retake/core/base';
import { isCaptureScene } from '@retake/core/language';
import { parseRunId } from '@retake/core/ids';
import { listSteps, resolveStepRef, sceneId } from '@retake/core/language';
import { resolveEnvironment } from '@retake/core/environment';
import { hookStepNames, resolveNamedHook } from '@retake/core/hooks';
import { finishRun, startedRun } from '@retake/core/run';
import type { HookStep } from '@retake/core/hooks';
import type { RunError, RunPause, Timeline, TimelineEvent } from '@retake/core/run';
import type { HookContext, HookPhase } from '@retake/core/hooks';
import type { RunEnd, RunProgress, RunRecord, RunningRun } from '@retake/core/run';
import type { InspectReport } from '@retake/runner-web/types';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import { EngineError } from '../errors.js';
import type { HookJournal } from '../hook-run/runner.js';
import type { CaptureRequest } from './runner.js';

/** A step the fake fails, by its reference (`<scene>.<step index>`), with this message. */
export type MemoryStepFailure = (ref: string) => string | undefined;

/** The runner's longest pause (runner-web pause.ts PAUSE_MAX_MS). */
const PAUSE_MAX_MS = 30 * 60_000;

/** A failed step: where it stopped (the runner's StepFailure, in words). */
class StepStop extends Error {
  constructor(
    message: string,
    readonly at: { scene: string; step: number; action: string },
  ) {
    super(message);
  }
}

/** A cancel: the reason's message, as the runner keeps it (throwIfAborted). */
class Cancel extends Error {}

const cancelOf = (signal: AbortSignal): Cancel => new Cancel(signal.reason instanceof Error ? signal.reason.message : 'run cancelled');

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(cancelOf(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      done();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      fail(cancelOf(signal!));
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

const seconds = (raw: unknown, key: 'wait' | 'hold'): number => {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
};

/** A step of the run (core listSteps). */
type RunStep = ReturnType<typeof listSteps>[number];

/** A run's hooks once loaded: its journal and the context every hook runs with. */
interface RunHooks {
  journal: HookJournal;
  ctx: HookContext;
}

/** The run's record as it starts (run.json before the first step). */
function startRecord(
  req: CaptureRequest,
  o: {
    clock: Clock;
    runId: NonNullable<ReturnType<typeof parseRunId>>;
    dir: string;
    env: ReturnType<typeof resolveEnvironment>;
    hooksMode: NonNullable<CaptureRequest['hooks']> | 'run' | 'skip';
    steps: number;
  },
): RunningRun {
  const { project, scenario: loaded, mode } = req;
  return startedRun({
    version: FORMAT_VERSIONS.run,
    id: o.runId,
    project: project.slug,
    scenario: loaded.name,
    mode,
    started_at: stampOf(o.clock),
    dir: o.dir,
    env: o.env.name,
    options: { hooks: o.hooksMode, headed: req.headed ?? false, ...(req.until !== undefined ? { until: req.until } : {}) },
    steps_total: o.steps,
    steps_done: 0,
    screenshots: [],
    hooks: { setup: 'none', teardown: 'none' },
    warnings: [],
    environment: { access: o.env.access === 'read-only' ? 'read-only' : 'read-write' },
  });
}

/** The run's checks, its folder, its record and its first events: what every later step shares. */
async function openRun(req: CaptureRequest, o: { clock: Clock; fail?: MemoryStepFailure }) {
  const { clock, fail = () => undefined } = o;
  const { project, scenario: loaded, mode } = req;
  const sc = loaded.scenario;
  const env = resolveEnvironment(project, req.env ?? sc.env);
  if (req.inspect && mode !== 'dry') throw new EngineError('invalid', 'an inspection replays the scenario as a dry run (mode: dry)');
  const hooksMode = req.inspect ? 'skip' : (req.hooks ?? (mode === 'capture' ? 'run' : 'skip'));
  const until = req.until !== undefined ? resolveStepRef(sc, req.until) : null;
  if (req.until !== undefined && !until) throw new EngineError('invalid', `--until "${req.until}" matches no step`);
  const runsDir = resolve(req.runsDir);
  const runId = parseRunId(req.runId);
  if (runId === null) throw new EngineError('invalid', `run id ${JSON.stringify(String(req.runId))} is not a run id`);
  const { runs } = req;
  const dir = join(runsDir, runId);
  await runs.write(dir, 'scenario.yaml', loaded.text);

  const toRun = listSteps(sc).filter((s) => !until || s.sceneIndex < until.sceneIndex || (s.sceneIndex === until.sceneIndex && s.step.index <= until.stepIndex));
  const record = startRecord(req, { clock, runId, dir, env, hooksMode, steps: toRun.length });
  const emit = (e: RunProgress) => {
    try {
      req.onProgress?.(e);
    } catch {
      /* a listener's error never breaks the run */
    }
  };
  emit({ type: 'run_start', run: { ...record } });
  await runs.writeJson(dir, 'run.json', runRecordOnDisk(record, project.dir));
  emit({ type: 'outline', steps: toRun.map((s) => ({ scene: s.scene.id ?? sceneId(s.scene, s.sceneIndex), step: s.step.index, action: s.step.action, desc: s.step.action })) });

  const t0 = performance.now();
  const t0Wall = clock.now();
  const filming = mode === 'capture' && req.onFilming ? req.onFilming : undefined;
  const tell = (state: 'start' | 'pause' | 'resume' | 'stop') => {
    try {
      return filming?.(state);
    } catch {
      return undefined;
    }
  };
  const hookSteps = hookStepNames(sc).length > 0;
  return {
    req,
    clock,
    fail,
    sc,
    env,
    hooksMode,
    until,
    runId,
    dir,
    record,
    toRun,
    emit,
    events: [] as TimelineEvent[],
    pauses: [] as RunPause[],
    t0Wall,
    at: () => (performance.now() - t0) / 1000,
    tell,
    hookSteps,
    hasHooks: (sc.setup?.length ?? 0) + (sc.teardown?.length ?? 0) > 0 || hookSteps,
    hooks: undefined as RunHooks | undefined,
  };
}

type MemoryState = Awaited<ReturnType<typeof openRun>>;

/** A list of hooks through the handed runner, one `hook` event per result. */
async function runHooks(st: MemoryState, list: HookStep[], phase: HookPhase, agentWritten: boolean) {
  const res = await st.req.hookRunner.run(list, st.hooks!.ctx, { phase, journal: st.hooks!.journal, agentWritten });
  res.results.forEach((r, i) =>
    st.emit({
      type: 'hook',
      phase: phase === 'step' ? 'step' : phase === 'teardown' ? 'teardown' : 'setup',
      name: r.name ?? r.description ?? `hook ${i + 1}`,
      status: r.ok ? 'ok' : 'failed',
      ...((r.error ?? r.message) ? { message: r.error ?? r.message } : {}),
    }),
  );
  return res;
}

/** The context every hook of the run runs with. */
function hookContext(st: MemoryState): HookContext {
  const { req, env, runId, dir, sc } = st;
  const { project } = req;
  return {
    project,
    policy: req.policy,
    env,
    vars: { ...(project.config.vars ?? {}), ...(sc.vars ?? {}) },
    runId,
    runDir: dir,
    dryRun: false,
    log: (level, message) => st.emit({ type: 'log', level, message }),
    saved: {},
    ...(req.hookTrust ? { trust: req.hookTrust } : {}),
    ...(req.hookVia ? { via: req.hookVia } : {}),
    ...(req.trustedHookFiles ? { trustedFiles: req.trustedHookFiles } : {}),
    ...(req.confirmHook ? { confirmDestructive: req.confirmHook } : {}),
    ...(req.recordHookRun ? { recordRun: (r, run) => req.recordHookRun!(r, run ?? runId) } : {}),
  };
}

/** The hooks' state in the record, the runner loaded and the setup run (it fails the run when it fails). */
async function setupHooks(st: MemoryState): Promise<void> {
  const { req, sc, record, hooksMode, hasHooks, dir } = st;
  const signal = req.signal;
  if (st.hookSteps) record.hooks.steps = hooksMode === 'skip' ? 'skipped' : 'ok';
  if (hasHooks && hooksMode === 'skip') {
    if (sc.setup?.length) record.hooks.setup = 'skipped';
    if (sc.teardown?.length) record.hooks.teardown = 'skipped';
  } else if (hasHooks) {
    // A hook runner that cannot load: the run fails with the runner's words (runner-web hooks-bridge.ts loadHookRunner).
    await req.hookRunner.load().catch((e: unknown) => {
      throw new Error(`this scenario has hooks (setup, teardown or hook steps) but @retake/hooks could not be loaded: ${errorMessage(e)}`);
    });
    const journal = await req.hookRunner.journals.open(join(dir, 'hooks-journal.json'));
    const ctx = hookContext(st);
    st.hooks = { journal, ctx };
    if (sc.setup?.length) {
      st.emit({ type: 'hook', phase: 'setup', name: 'setup', status: 'start', message: `${sc.setup.length} hook(s)` });
      if (signal) ctx.signal = signal;
      const res = await runHooks(st, sc.setup, 'setup', true).finally(() => delete ctx.signal);
      record.hooks.setup = res.ok ? 'ok' : 'failed';
      if (!res.ok) {
        if (signal?.aborted) throw cancelOf(signal);
        throw new Error('setup hooks failed; completed setup hooks were rolled back');
      }
    }
  }
}

/** The pause gate before a step: run.json says paused, the run waits (at most its longest pause), then resumes. */
async function pauseBefore(st: MemoryState, s: RunStep, scene: string, ref: string): Promise<void> {
  const { req, clock, record, pauses } = st;
  const pause = req.pause!;
  const maxMs = pause.maxMs ?? PAUSE_MAX_MS;
  const since = performance.now();
  const sinceStamp = stampOf(clock);
  record.paused = { scene, step: s.step.index, since: sinceStamp };
  await req.runs.writeJson(st.dir, 'run.json', runRecordOnDisk(record, req.project.dir));
  st.emit({ type: 'pause', state: 'paused', scene, step: s.step.index, max_ms: maxMs });
  st.tell('pause');
  try {
    while (pause.requested) {
      if (performance.now() - since > maxMs) throw new Cancel(`paused longer than ${maxMs / 1000} s before step ${ref}: the run was stopped (its teardown and rollbacks still run)`);
      await sleep(20, req.signal);
    }
  } finally {
    const ms = Math.round(performance.now() - since);
    pauses.push({ scene, step: s.step.index, at: sinceStamp, ms });
    record.pauses = [...pauses];
    delete record.paused;
  }
  st.tell('resume');
  st.emit({ type: 'pause', state: 'resumed', scene, step: s.step.index, ms: Math.round(performance.now() - since) });
}

/** A `hook:` step: its named hooks through the runner (a failure fails the step). */
async function hookStep(st: MemoryState, hooks: RunHooks, s: RunStep, scene: string): Promise<void> {
  const { req, sc, record } = st;
  const signal = req.signal;
  const name = String((s.step.raw as { hook?: unknown }).hook);
  const named = resolveNamedHook(name, sc, req.project);
  if (!named) throw new StepStop(`unknown hook "${name}"`, { scene, step: s.step.index, action: s.step.action });
  if (signal) hooks.ctx.signal = signal;
  const res = await runHooks(st, named.hooks, 'step', named.source === 'scenario').finally(() => delete hooks.ctx.signal);
  if (!res.ok) {
    record.hooks.steps = 'failed';
    throw new StepStop(`hook "${name}" failed`, { scene, step: s.step.index, action: s.step.action });
  }
}

/** One step: the pause gate, its wait, its hook or its scripted failure, its events, then a live frame. */
async function runStep(st: MemoryState, s: RunStep): Promise<void> {
  const { req, record, events, clock, env } = st;
  const { project } = req;
  const signal = req.signal;
  const scene = s.scene.id ?? sceneId(s.scene, s.sceneIndex);
  const ref = `${scene}.${s.step.index}`;
  if (s.step.index === 0) st.emit({ type: 'scene_start', scene, index: s.sceneIndex });
  if (signal?.aborted) throw cancelOf(signal);
  if (req.pause?.requested) await pauseBefore(st, s, scene, ref);
  record.current = { scene, step: s.step.index, action: s.step.action };
  st.emit({ type: 'step_start', scene, step: s.step.index, action: s.step.action, desc: s.step.action });
  const start = st.at();
  const t = performance.now();
  // A step that fails or is cancelled counts as attempted, its step_end `failed` (runner-web scenes.ts).
  let status: TimelineEvent['status'] = 'failed';
  try {
    await sleep(1000 * (seconds(s.step.raw, 'wait') + seconds(s.step.raw, 'hold')), signal);
    if (s.step.action === 'hook' && st.hooksMode === 'run' && st.hooks) await hookStep(st, st.hooks, s, scene);
    const failed = st.fail(ref);
    if (failed !== undefined) throw new StepStop(failed, { scene, step: s.step.index, action: s.step.action });
    status = 'ok';
  } finally {
    events.push({ scene, scene_index: s.sceneIndex, step: s.step.index, action: s.step.action, t_start: start, t_end: st.at(), status });
    record.steps_done++;
    st.emit({ type: 'step_end', scene, step: s.step.index, action: s.step.action, status, ms: Math.round(performance.now() - t) });
  }
  if (req.live?.wanted)
    req.live.frame({
      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      width: project.config.capture.width,
      height: project.config.capture.height,
      at: clock.now(),
      page: s.scene.page ?? Object.keys(env.pages)[0],
    });
}

/** An inspection's report: where the replay stopped, and nothing of a page (the fake opens none). */
function inspectReport(st: MemoryState, failure: Error | null): InspectReport {
  const { req, env, record, until, dir } = st;
  const { project } = req;
  const stop = failure instanceof StepStop ? failure.at : null;
  return {
    version: 1,
    status: failure && !stop ? 'failed' : 'ok',
    at: stop ? 'failed_step' : until ? 'until' : 'end',
    page: Object.keys(env.pages)[0] ?? null,
    persona: null,
    viewport: { width: project.config.capture.width, height: project.config.capture.height },
    scale: project.config.capture.scale,
    screenshot: null,
    file: join(dir, 'inspect.json'),
    replay: {
      steps_done: record.steps_done,
      steps_total: record.steps_total,
      until: req.until ?? null,
      skipped_irreversible: 0,
      hooks: record.hooks.setup === 'skipped' || record.hooks.teardown === 'skipped' ? 'skipped' : 'none',
      failed: stop,
    },
    counts: {
      interactive: 0,
      listed: 0,
      in_view: 0,
      suggested: 0,
      ambiguous: 0,
      unsuggested: 0,
      verifications: 0,
      shadow_roots: 0,
      same_origin_frames: 0,
      cross_origin_frames: 0,
      partial: false,
      within_found: true,
      dropped: 0,
      targets_checked: 0,
    },
    popups: [],
    scrollers: [],
    elements: [],
    targets_checked: [],
    timings: { inspect_ms: 0, kit_ms: 0 },
    untrusted: { url: '', title: '', headings: [], ...(failure ? { error: failure.message } : {}), warnings: [] },
  };
}

/** Teardown always, then the setup's rollbacks still pending (the runner's order). */
async function closeHooks(st: MemoryState, hooks: RunHooks): Promise<void> {
  const { sc, record } = st;
  if (sc.teardown?.length) {
    st.emit({ type: 'hook', phase: 'teardown', name: 'teardown', status: 'start', message: `${sc.teardown.length} hook(s)` });
    const res = await runHooks(st, sc.teardown, 'teardown', true);
    record.hooks.teardown = res.ok ? 'ok' : 'failed';
  }
  if (hooks.journal.pending().length) {
    st.emit({ type: 'hook', phase: 'rollback', name: 'rollback', status: 'start', message: `${hooks.journal.pending().length} setup hook(s)` });
    const results = await hooks.journal.rollbackAll(hooks.ctx);
    results.forEach((r, i) => st.emit({ type: 'hook', phase: 'rollback', name: r.name ?? `hook ${i + 1}`, status: r.ok ? 'ok' : 'failed' }));
    if (results.some((r) => !r.ok)) record.hooks.teardown = 'failed';
    else if (record.hooks.teardown === 'none') record.hooks.teardown = 'ok';
  }
}

/** The minimal timeline.json, and the marker capture.mp4 of a capture that succeeded. */
async function writeOutputs(st: MemoryState, failure: Error | null): Promise<void> {
  const { req, sc, record, runId, dir, clock, at } = st;
  const { project, scenario: loaded, mode, runs } = req;
  const capture = project.config.capture;
  const timeline: Timeline = {
    version: 1,
    run_id: runId,
    project: project.slug,
    scenario: loaded.name,
    created_at: stampOf(clock),
    mode,
    capture: { file: 'capture.mp4', width: capture.width, height: capture.height, scale: capture.scale, fps: capture.fps, duration: at(), t0_wall: st.t0Wall, frames: 0 },
    scenes: sc.scenes.flatMap((s, index) => (isCaptureScene(s) ? [{ id: sceneId(s, index), index, kind: 'scene' as const, t_start: 0, t_end: at(), status: 'ok' as const }] : [])),
    events: st.events,
    markers: [],
    pages: [],
    cursor: [],
    idle: [],
    warnings: [],
  };
  const timelineFile = join(dir, 'timeline.json');
  await runs.writeJson(dir, 'timeline.json', timeline);
  record.timeline = timelineFile;
  if (mode === 'capture' && !failure) {
    const file = join(dir, 'capture.mp4');
    await runs.write(dir, 'capture.mp4', `memory capture of ${runId}\n`);
    record.capture = file;
  }
}

/** The run's end in run.json and its `run_end` event. */
async function endRun(st: MemoryState, failure: Error | null): Promise<RunRecord> {
  const { record, clock, dir } = st;
  let end: RunEnd;
  const stamp = stampOf(clock);
  if (!failure) end = { status: 'succeeded', at: stamp, warnings: [] };
  else {
    const error: RunError = { message: failure.message, ...(failure instanceof StepStop ? failure.at : {}) };
    end = { status: failure instanceof Cancel ? 'cancelled' : 'failed', at: stamp, warnings: [], error };
  }
  const done = finishRun(record, end);
  await st.req.runs.writeJson(dir, 'run.json', runRecordOnDisk(done, st.req.project.dir));
  st.emit({ type: 'run_end', run: { ...done } });
  return done;
}

/** A run of `req` in memory (see the file's comment). */
export async function memoryRun(req: CaptureRequest, o: { clock: Clock; fail?: MemoryStepFailure }): Promise<RunRecord> {
  const st = await openRun(req, o);
  const { record, until, toRun } = st;
  const signal = req.signal;
  let failure: Error | null = null;
  let filmed = false;
  try {
    if (signal?.aborted) throw cancelOf(signal);
    await setupHooks(st);
    filmed = req.mode === 'capture';
    st.tell('start');
    for (const s of toRun) await runStep(st, s);
    if (until) {
      const last = toRun.at(-1);
      if (last) record.stopped_at = { scene: last.scene.id ?? sceneId(last.scene, last.sceneIndex), step: last.step.index, reason: 'until' };
    }
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
  }
  // What the take saw beside it is the caller's to say (run.json perf.machine): the fake keeps no perf block.
  if (filmed) st.tell('stop');
  delete record.current;

  if (req.inspect) {
    const r = inspectReport(st, failure);
    if (!(failure instanceof Cancel)) {
      await req.runs.writeJson(st.dir, 'inspect.json', r);
      await req.inspect.onResult(r);
    }
  }
  if (st.hooks) await closeHooks(st, st.hooks);
  await writeOutputs(st, failure);
  return endRun(st, failure);
}
