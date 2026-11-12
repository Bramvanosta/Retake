/**
 * The in-memory capture runner's run (memory-capture.ts `run`, L7.12 Part 2): what a run does that the engine reads,
 * without a browser or an encoder — the run folder and its run.json through core's writers (reserveRunId, startedRun,
 * finishRun, writeJson), scenario.yaml, a minimal timeline.json, a marker capture.mp4 in capture mode; the progress
 * events (`run_start`, `outline`, hooks, `scene_start`, `step_start` / `step_end`, pauses, `run_end`); the signal, `until`,
 * the pause gate, the live sink (one frame per step while it is wanted), an inspection's report (inspect.json and
 * `onResult`), `onFilming` (start, pause, resume, stop) and the scenario's hooks through the handed hook runner (setup,
 * `hook:` steps, teardown, the setup's rollbacks after it — as the runner orders them).
 *
 * A `wait` or `hold` step sleeps its seconds (abortably): a cancel during a run is seen as with the runner. A step the
 * options script as failing (`fail`) fails the run there. Limits: nothing is opened, filmed, typed or checked; no
 * persona, no sign-in, no secret, no write guard; a dry run executes every step (no irreversible one is skipped).
 * What it stamps (run.json's times, a pause's, the timeline's) is its clock's; elapsed times are performance.now()'s.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FORMAT_VERSIONS } from '@retake/core/base';
import { isCaptureScene } from '@retake/core/model';
import { parseRunId } from '@retake/core/ids';
import { listSteps, resolveStepRef, sceneId } from '@retake/core/language';
import { resolveEnvironment } from '@retake/core/environment';
import { hookStepNames, resolveNamedHook } from '@retake/core/hooks';
import { projectPath } from '@retake/core/project';
import { finishRun, startedRun } from '@retake/core/run';
import type { HookStep, RunError, RunPause, Timeline, TimelineEvent } from '@retake/core/model';
import type { HookContext, HookPhase } from '@retake/core/hooks';
import type { RunEnd, RunProgress, RunRecord, RunningRun } from '@retake/core/run';
import { reserveRunId, writeJson } from '@retake/core/io';
import type { InspectReport } from '@retake/runner-web/types';
import { dateOf, stampOf } from '../clock.js';
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

/** A run of `req` in memory (see the file's comment). */
export async function memoryRun(req: CaptureRequest, o: { clock: Clock; fail?: MemoryStepFailure }): Promise<RunRecord> {
  const { clock, fail = () => undefined } = o;
  const { project, scenario: loaded, mode } = req;
  const sc = loaded.scenario;
  const env = resolveEnvironment(project, req.env ?? sc.env);
  if (req.inspect && mode !== 'dry') throw new EngineError('invalid', 'an inspection replays the scenario as a dry run (mode: dry)');
  const hooksMode = req.inspect ? 'skip' : (req.hooks ?? (mode === 'capture' ? 'run' : 'skip'));
  const until = req.until !== undefined ? resolveStepRef(sc, req.until) : null;
  if (req.until !== undefined && !until) throw new EngineError('invalid', `--until "${req.until}" matches no step`);
  const runsDir = resolve(req.runsDir ?? projectPath(project.dir, 'runs'));
  const given = req.runId !== undefined ? parseRunId(req.runId) : undefined;
  if (given === null) throw new EngineError('invalid', `run id ${JSON.stringify(String(req.runId))} is not a run id`);
  const { id: runId, dir } = given !== undefined ? { id: given, dir: join(runsDir, given) } : await reserveRunId(runsDir, loaded.name, dateOf(clock));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'scenario.yaml'), loaded.text);

  const toRun = listSteps(sc).filter((s) => !until || s.sceneIndex < until.sceneIndex || (s.sceneIndex === until.sceneIndex && s.step.index <= until.stepIndex));
  const record: RunningRun = startedRun({
    version: FORMAT_VERSIONS.run,
    id: runId,
    project: project.slug,
    scenario: loaded.name,
    mode,
    started_at: stampOf(clock),
    dir,
    env: env.name,
    options: { hooks: hooksMode, headed: req.headed ?? false, ...(req.until !== undefined ? { until: req.until } : {}) },
    steps_total: toRun.length,
    steps_done: 0,
    screenshots: [],
    hooks: { setup: 'none', teardown: 'none' },
    warnings: [],
    environment: { access: env.access === 'read-only' ? 'read-only' : 'read-write' },
  });
  const runFile = join(dir, 'run.json');
  const emit = (e: RunProgress) => {
    try {
      req.onProgress?.(e);
    } catch {
      /* a listener's error never breaks the run */
    }
  };
  emit({ type: 'run_start', run: { ...record } });
  await writeJson(runFile, record);
  emit({ type: 'outline', steps: toRun.map((s) => ({ scene: s.scene.id ?? sceneId(s.scene, s.sceneIndex), step: s.step.index, action: s.step.action, desc: s.step.action })) });

  const signal = req.signal;
  const events: TimelineEvent[] = [];
  const pauses: RunPause[] = [];
  const t0 = performance.now();
  const t0Wall = clock.now();
  const at = () => (performance.now() - t0) / 1000;
  const filming = mode === 'capture' && req.onFilming ? req.onFilming : undefined;
  const tell = (state: 'start' | 'pause' | 'resume' | 'stop') => {
    try {
      return filming?.(state);
    } catch {
      return undefined;
    }
  };

  const hookSteps = hookStepNames(sc).length > 0;
  const hasHooks = (sc.setup?.length ?? 0) + (sc.teardown?.length ?? 0) > 0 || hookSteps;
  let hooks: { journal: HookJournal; ctx: HookContext } | undefined;
  const runHooks = async (list: HookStep[], phase: HookPhase, agentWritten: boolean) => {
    const res = await req.hookRunner.run(list, hooks!.ctx, { phase, journal: hooks!.journal, agentWritten });
    res.results.forEach((r, i) => emit({ type: 'hook', phase: phase === 'step' ? 'step' : phase === 'teardown' ? 'teardown' : 'setup', name: r.name ?? r.description ?? `hook ${i + 1}`, status: r.ok ? 'ok' : 'failed', ...(r.error ?? r.message ? { message: r.error ?? r.message } : {}) }));
    return res;
  };

  let failure: Error | null = null;
  let filmed = false;
  try {
    if (signal?.aborted) throw cancelOf(signal);
    if (hookSteps) record.hooks.steps = hooksMode === 'skip' ? 'skipped' : 'ok';
    if (hasHooks && hooksMode === 'skip') {
      if (sc.setup?.length) record.hooks.setup = 'skipped';
      if (sc.teardown?.length) record.hooks.teardown = 'skipped';
    } else if (hasHooks) {
      // A hook runner that cannot load: the run fails with the runner's words (runner-web hooks-bridge.ts loadHookRunner).
      await req.hookRunner.load().catch((e: unknown) => {
        throw new Error(`this scenario has hooks (setup, teardown or hook steps) but @retake/hooks could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
      });
      const journal = await req.hookRunner.journals.open(join(dir, 'hooks-journal.json'));
      const ctx: HookContext = {
        project,
        policy: req.policy,
        env,
        vars: { ...(project.config.vars ?? {}), ...(sc.vars ?? {}) },
        runId,
        runDir: dir,
        dryRun: false,
        log: (level, message) => emit({ type: 'log', level, message }),
        saved: {},
        ...(req.hookTrust ? { trust: req.hookTrust } : {}),
        ...(req.hookVia ? { via: req.hookVia } : {}),
        ...(req.confirmHook ? { confirmDestructive: req.confirmHook } : {}),
        ...(req.recordHookRun ? { recordRun: (r, run) => req.recordHookRun!(r, run ?? runId) } : {}),
      };
      hooks = { journal, ctx };
      if (sc.setup?.length) {
        emit({ type: 'hook', phase: 'setup', name: 'setup', status: 'start', message: `${sc.setup.length} hook(s)` });
        if (signal) ctx.signal = signal;
        const res = await runHooks(sc.setup, 'setup', true).finally(() => delete ctx.signal);
        record.hooks.setup = res.ok ? 'ok' : 'failed';
        if (!res.ok) {
          if (signal?.aborted) throw cancelOf(signal);
          throw new Error('setup hooks failed; completed setup hooks were rolled back');
        }
      }
    }

    filmed = mode === 'capture';
    tell('start');
    for (const s of toRun) {
      const scene = s.scene.id ?? sceneId(s.scene, s.sceneIndex);
      const ref = `${scene}.${s.step.index}`;
      if (s.step.index === 0) emit({ type: 'scene_start', scene, index: s.sceneIndex });
      if (signal?.aborted) throw cancelOf(signal);
      if (req.pause?.requested) {
        const maxMs = req.pause.maxMs ?? PAUSE_MAX_MS;
        const since = performance.now();
        const sinceStamp = stampOf(clock);
        record.paused = { scene, step: s.step.index, since: sinceStamp };
        await writeJson(runFile, record);
        emit({ type: 'pause', state: 'paused', scene, step: s.step.index, max_ms: maxMs });
        tell('pause');
        try {
          while (req.pause.requested) {
            if (performance.now() - since > maxMs) throw new Cancel(`paused longer than ${maxMs / 1000} s before step ${ref}: the run was stopped (its teardown and rollbacks still run)`);
            await sleep(20, signal);
          }
        } finally {
          const ms = Math.round(performance.now() - since);
          pauses.push({ scene, step: s.step.index, at: sinceStamp, ms });
          record.pauses = [...pauses];
          delete record.paused;
        }
        tell('resume');
        emit({ type: 'pause', state: 'resumed', scene, step: s.step.index, ms: Math.round(performance.now() - since) });
      }
      record.current = { scene, step: s.step.index, action: s.step.action };
      emit({ type: 'step_start', scene, step: s.step.index, action: s.step.action, desc: s.step.action });
      const start = at();
      const t = performance.now();
      // A step that fails or is cancelled counts as attempted, its step_end `failed` (runner-web scenes.ts).
      let status: TimelineEvent['status'] = 'failed';
      try {
        await sleep(1000 * (seconds(s.step.raw, 'wait') + seconds(s.step.raw, 'hold')), signal);
        if (s.step.action === 'hook' && hooksMode === 'run' && hooks) {
          const name = String((s.step.raw as { hook?: unknown }).hook);
          const named = resolveNamedHook(name, sc, project);
          if (!named) throw new StepStop(`unknown hook "${name}"`, { scene, step: s.step.index, action: s.step.action });
          if (signal) hooks.ctx.signal = signal;
          const res = await runHooks(named.hooks, 'step', named.source === 'scenario').finally(() => delete hooks!.ctx.signal);
          if (!res.ok) {
            record.hooks.steps = 'failed';
            throw new StepStop(`hook "${name}" failed`, { scene, step: s.step.index, action: s.step.action });
          }
        }
        const failed = fail(ref);
        if (failed !== undefined) throw new StepStop(failed, { scene, step: s.step.index, action: s.step.action });
        status = 'ok';
      } finally {
        events.push({ scene, scene_index: s.sceneIndex, step: s.step.index, action: s.step.action, t_start: start, t_end: at(), status });
        record.steps_done++;
        emit({ type: 'step_end', scene, step: s.step.index, action: s.step.action, status, ms: Math.round(performance.now() - t) });
      }
      if (req.live?.wanted) req.live.frame({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: project.config.capture.width, height: project.config.capture.height, at: clock.now(), page: s.scene.page ?? Object.keys(env.pages)[0] });
    }
    if (until) {
      const last = toRun.at(-1);
      if (last) record.stopped_at = { scene: last.scene.id ?? sceneId(last.scene, last.sceneIndex), step: last.step.index, reason: 'until' };
    }
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
  }
  // What the take saw beside it is the caller's to say (run.json perf.machine): the fake keeps no perf block.
  if (filmed) tell('stop');
  delete record.current;

  if (req.inspect) {
    const stop = failure instanceof StepStop ? failure.at : null;
    const r: InspectReport = {
      version: 1,
      status: failure && !stop ? 'failed' : 'ok',
      at: stop ? 'failed_step' : until ? 'until' : 'end',
      page: Object.keys(env.pages)[0] ?? null,
      persona: null,
      viewport: { width: project.config.capture.width, height: project.config.capture.height },
      scale: project.config.capture.scale,
      screenshot: null,
      file: join(dir, 'inspect.json'),
      replay: { steps_done: record.steps_done, steps_total: record.steps_total, until: req.until ?? null, skipped_irreversible: 0, hooks: record.hooks.setup === 'skipped' || record.hooks.teardown === 'skipped' ? 'skipped' : 'none', failed: stop },
      counts: { interactive: 0, listed: 0, in_view: 0, suggested: 0, ambiguous: 0, unsuggested: 0, verifications: 0, shadow_roots: 0, same_origin_frames: 0, cross_origin_frames: 0, partial: false, within_found: true, dropped: 0, targets_checked: 0 },
      popups: [],
      scrollers: [],
      elements: [],
      targets_checked: [],
      timings: { inspect_ms: 0, kit_ms: 0 },
      untrusted: { url: '', title: '', headings: [], ...(failure ? { error: failure.message } : {}), warnings: [] },
    };
    if (!(failure instanceof Cancel)) {
      await writeJson(r.file, r);
      await req.inspect.onResult(r);
    }
  }

  // Teardown always, then the setup's rollbacks still pending (the runner's order).
  if (hooks) {
    if (sc.teardown?.length) {
      emit({ type: 'hook', phase: 'teardown', name: 'teardown', status: 'start', message: `${sc.teardown.length} hook(s)` });
      const res = await runHooks(sc.teardown, 'teardown', true);
      record.hooks.teardown = res.ok ? 'ok' : 'failed';
    }
    if (hooks.journal.pending().length) {
      emit({ type: 'hook', phase: 'rollback', name: 'rollback', status: 'start', message: `${hooks.journal.pending().length} setup hook(s)` });
      const results = await hooks.journal.rollbackAll(hooks.ctx);
      results.forEach((r, i) => emit({ type: 'hook', phase: 'rollback', name: r.name ?? `hook ${i + 1}`, status: r.ok ? 'ok' : 'failed' }));
      if (results.some((r) => !r.ok)) record.hooks.teardown = 'failed';
      else if (record.hooks.teardown === 'none') record.hooks.teardown = 'ok';
    }
  }

  const capture = project.config.capture;
  const timeline: Timeline = {
    version: 1,
    run_id: runId,
    project: project.slug,
    scenario: loaded.name,
    created_at: stampOf(clock),
    mode,
    capture: { file: 'capture.mp4', width: capture.width, height: capture.height, scale: capture.scale, fps: capture.fps, duration: at(), t0_wall: t0Wall, frames: 0 },
    scenes: sc.scenes.flatMap((s, index) => (isCaptureScene(s) ? [{ id: sceneId(s, index), index, kind: 'scene' as const, t_start: 0, t_end: at(), status: 'ok' as const }] : [])),
    events,
    markers: [],
    pages: [],
    cursor: [],
    idle: [],
    warnings: [],
  };
  const timelineFile = join(dir, 'timeline.json');
  await writeJson(timelineFile, timeline);
  record.timeline = timelineFile;
  if (mode === 'capture' && !failure) {
    const file = join(dir, 'capture.mp4');
    await writeFile(file, `memory capture of ${runId}\n`);
    record.capture = file;
  }

  let end: RunEnd;
  const stamp = stampOf(clock);
  if (!failure) end = { status: 'succeeded', at: stamp, warnings: [] };
  else {
    const error: RunError = { message: failure.message, ...(failure instanceof StepStop ? failure.at : {}) };
    end = { status: failure instanceof Cancel ? 'cancelled' : 'failed', at: stamp, warnings: [], error };
  }
  const done = finishRun(record, end);
  await writeJson(runFile, done);
  emit({ type: 'run_end', run: { ...done } });
  return done;
}
