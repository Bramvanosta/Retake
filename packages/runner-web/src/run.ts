import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import {
  isCaptureScene,
  listSteps,
  scenePageEntries,
  newRunId,
  resolveEnvironment,
  resolveStepRef,
  timelineVideo,
  writeJson,
} from '@demo-studio/core';
import type {
  BrowserConfig,
  HookStep,
  LoadedProject,
  LoadedScenario,
  LoadedTemplate,
  RunError,
  RunMode,
  RunProgress,
  RunRecord,
  TemplateContext,
} from '@demo-studio/core';
import { evalInPage } from './actions/misc.js';
import { snapshotMailbox } from './actions/artefacts.js';
import { watchNotifications } from './notifications.js';
import { mergeCapture, mergePacing, projectBrowser, resolveAuth } from './config.js';
import { encodeFrames } from './encode.js';
import { CancelledError, EncodeError, RunnerError, errorMessage, isCancelled } from './errors.js';
import { hookResultFailed, hookResultName, loadHooksModule } from './hooks-bridge.js';
import type { HookContextLike, HooksModule, JournalLike } from './hooks-bridge.js';
import { kitConfigFor } from './kit/source.js';
import { ScreencastRecorder } from './recorder.js';
import type { FrameIndexEntry } from './recorder.js';
import { RunFiles } from './runfiles.js';
import { Runtime } from './runtime.js';
import type { LogLevel } from './runtime.js';
import { StepFailure, runScenes } from './scenes.js';
import { BrowserSession } from './session.js';
import { CaptureClock, TimelineBuilder, motionCapture } from './timeline.js';
import type { MotionCapture } from './timeline.js';
import { throwIfAborted, wallNow } from './util.js';

export interface RunOptions {
  project: LoadedProject;
  scenario: LoadedScenario;
  template?: LoadedTemplate;
  mode: RunMode;
  /** Environment name (default: scenario.env, project.default_env, first environment). */
  env?: string;
  /** Stop after this step (`scene.step`, `scene.<index>`, a step id or a scene id). */
  until?: string;
  /** Default: capture = run, dry = skip. */
  hooks?: 'run' | 'skip';
  headed?: boolean;
  runId?: string;
  /** Default <project>/runs. */
  runsDir?: string;
  onProgress?: (e: RunProgress) => void;
  signal?: AbortSignal;
  /** Overrides project.config.browser. */
  browser?: BrowserConfig;
  /** ffmpeg binary (default "ffmpeg" on PATH). */
  ffmpeg?: string;
  /**
   * Capture without the in-page cursor (raw export for editors, L2.13: `studio run --raw --cursor none|layer`). The
   * pointer still drives real input and the cursor track, icon, presses and ripples are recorded; nothing of the
   * cursor is drawn in the pictures. The timeline says so (`capture.cursor: hidden`).
   */
  hideCursor?: boolean;
}

/** SIGINT/SIGTERM abort the run (teardown still runs); a second signal kills the process. */
function installSignalHandlers(onSignal: (sig: NodeJS.Signals) => void): () => void {
  let count = 0;
  const handler = (sig: NodeJS.Signals) => {
    count++;
    if (count === 1) {
      onSignal(sig);
      return;
    }
    remove();
    process.kill(process.pid, sig);
  };
  const remove = () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return remove;
}

interface HooksState {
  mod: HooksModule;
  journal: JournalLike;
  ctx: HookContextLike;
}


/**
 * Run warnings about the motion a capture shows: moves below `minFps` (slow rendering) and stalls — the capture froze
 * ≥ STALL_MIN_S (150 ms) while the cursor moved or a click ripple played (L1.3). Null (cursor hidden): nothing can be
 * judged.
 */
export function motionWarnings(motion: MotionCapture | null, minFps: number, prefix: string): string[] {
  if (!motion) return [];
  const out: string[] = [];
  if (motion.slow > 0 && motion.worst) {
    out.push(
      `${prefix}${motion.slow} of ${motion.moves} cursor moves were captured below ${Math.round(minFps)} fps ` +
        `(lowest ${motion.worst.fps.toFixed(0)} fps at ${motion.worst.t.toFixed(1)} s): the browser renders this page slowly ` +
        `(software rendering without a GPU, heavy effects such as backdrop-filter blur, or several pages at once), so motion will look choppy`,
    );
  }
  if (motion.stalls.length) {
    const worst = motion.stalls.reduce((a, b) => (b.ms > a.ms ? b : a));
    const where = motion.stalls.slice(0, 4).map((s) => `${s.t.toFixed(1)} s (${s.ms} ms, ${s.during === 'move' ? 'cursor moving' : 'click ripple'})`);
    out.push(
      `${prefix}the capture froze ${motion.stalls.length === 1 ? 'once' : `${motion.stalls.length} times`} while the cursor moved or a click ripple played ` +
        `(longest ${worst.ms} ms): ${where.join(', ')}${motion.stalls.length > 4 ? ', …' : ''} — the frames show a stop, then a jump` +
        (motion.stalls.some((s) => s.during === 'ripple')
          ? '; a freeze during a click ripple is usually a closing dialog whose overlay has a backdrop-filter (Chromium stops drawing ≈ 0.26 s): browser.frame_rate_limit: false avoids it, see the README'
          : ''),
    );
  }
  return out;
}

/**
 * Run a scenario in a headless browser: setup hooks, scenes (page switching, open, still, steps), screencast
 * capture, teardown hooks (always), encoding, timeline.json and run.json. Never throws for step failures:
 * the returned RunRecord carries the status and error.
 */
export async function runScenario(opts: RunOptions): Promise<RunRecord> {
  const { project, scenario: loaded, mode } = opts;
  const sc = loaded.scenario;
  const env = resolveEnvironment(project, opts.env ?? sc.env);
  const pacing = mergePacing(project.config.pacing, sc.pacing);
  const capture = mergeCapture(project.config.capture, sc.capture);
  const hooksMode = opts.hooks ?? (mode === 'capture' ? 'run' : 'skip');
  let until: { sceneIndex: number; stepIndex: number } | null = null;
  if (opts.until !== undefined) {
    until = resolveStepRef(sc, opts.until);
    if (!until) {
      throw new RunnerError(
        `--until "${opts.until}" matches no step (use <scene>.<step id|index>, a unique step id, or a scene id)`,
      );
    }
  }
  const runId = opts.runId ?? newRunId(loaded.name);
  const dir = resolve(opts.runsDir ?? join(project.dir, 'runs'), runId);
  const screenshotsDir = join(dir, 'screenshots');
  const framesDir = join(dir, 'frames');
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(join(dir, 'scenario.yaml'), loaded.text);

  const listed = listSteps(sc);
  const total = until
    ? listed.filter((s) => s.sceneIndex < until!.sceneIndex || (s.sceneIndex === until!.sceneIndex && s.step.index <= until!.stepIndex)).length
    : listed.length;
  const record: RunRecord = {
    id: runId,
    project: project.slug,
    scenario: loaded.name,
    mode,
    status: 'running',
    started_at: new Date().toISOString(),
    dir,
    env: env.name,
    options: { hooks: hooksMode, headed: opts.headed ?? false },
    steps_total: total,
    steps_done: 0,
    screenshots: [],
    hooks: { setup: 'none', teardown: 'none' },
    warnings: [],
  };
  if (opts.until !== undefined) record.options.until = opts.until;
  if (opts.hideCursor) record.options.cursor = 'hidden';
  const files = new RunFiles(dir, record);
  const emit = (e: RunProgress) => {
    files.progress(e);
    try {
      opts.onProgress?.(e);
    } catch {
      /* a listener error must not break the run */
    }
  };
  const log = (level: LogLevel, message: string) => emit({ type: 'log', level, message });
  emit({ type: 'run_start', run: { ...record } });
  await files.saveRecord();

  const abort = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal;
  const removeSignals = installSignalHandlers((sig) => abort.abort(new CancelledError(`run cancelled (${sig})`)));
  const clock = new CaptureClock();
  const video = timelineVideo(sc, project.config, opts.template?.name);
  const timeline = new TimelineBuilder(
    { run_id: runId, project: project.slug, scenario: loaded.name, mode, capture, video, ...(opts.hideCursor ? { cursor: 'hidden' as const } : {}) },
    clock,
  );
  const template: TemplateContext = {
    pages: env.pages,
    vars: { ...(project.config.vars ?? {}), ...(sc.vars ?? {}) },
    run: { id: runId, dir },
    hooks: {},
  };

  let session: BrowserSession | null = null;
  let rt: Runtime | null = null;
  let notifications: { settled: () => Promise<void> } | null = null;
  let recorder: ScreencastRecorder | null = null;
  let hooks: HooksState | null = null;
  let failure: unknown = null;
  let frames: FrameIndexEntry[] = [];
  let endT = 0;

  try {
    throwIfAborted(signal);
    const auth = resolveAuth(project, env.name);
    session = await BrowserSession.open({
      width: capture.width,
      height: capture.height,
      scale: capture.scale,
      kit: kitConfigFor(opts.template, opts.hideCursor ? { hidden: true } : undefined),
      browser: projectBrowser(project, opts.browser),
      profileDir: auth.profileDir,
      storageState: auth.storageState,
      headed: opts.headed,
      log,
    });
    rt = new Runtime({
      session,
      timeline,
      pacing,
      capture,
      mode,
      signal,
      project,
      env,
      runDir: dir,
      screenshotsDir,
      template,
      recorder: null,
      cursorHidden: opts.hideCursor === true,
      log,
    });

    if (opts.hideCursor) log('info', 'capturing without the in-page cursor (raw export): its track, icon, presses and ripples are recorded as data');
    notifications = watchNotifications(rt);
    // wait_for_email takes only the messages that arrive during the run: remember those already there (before setup).
    if (project.config.mailbox && listed.some((l) => l.step.action === 'wait_for_email')) await snapshotMailbox(rt);

    const hasHooks = (sc.setup?.length ?? 0) + (sc.teardown?.length ?? 0) > 0;
    if (hasHooks && hooksMode === 'skip') {
      if (sc.setup?.length) record.hooks.setup = 'skipped';
      if (sc.teardown?.length) record.hooks.teardown = 'skipped';
    } else if (hasHooks) {
      hooks = await setupHooks(sc.setup ?? [], { rt, session, project, env, template, runId, dir, emit, log, record });
    }

    const captured = sc.scenes.filter(isCaptureScene).filter((s) => !s.skip);
    const firstScene = captured[0];
    const firstPage = firstScene?.pages !== undefined ? undefined : (firstScene?.page ?? Object.keys(env.pages)[0]);
    if (firstScene?.pages === undefined && !firstPage) throw new RunnerError(`environment "${env.name}" declares no pages`);
    // Capture time 0: right before the first page is shown and the screencast starts.
    clock.t0Wall = wallNow();
    // A scenario whose first scene films several pages starts with their tracks (the main capture starts with the
    // first single-page scene, if any).
    if (firstPage) await rt.activate(firstPage);
    if (mode === 'capture' && captured.some((s) => s.pages === undefined)) {
      recorder = new ScreencastRecorder({
        framesDir,
        indexFile: join(dir, 'frames.jsonl'),
        format: capture.format,
        quality: capture.quality,
        width: capture.width,
        height: capture.height,
        scale: capture.scale,
        clock,
        onError: (m) => timeline.warn(m),
      });
      if (firstPage) await recorder.start(rt.page);
      else await recorder.prepare();
      rt.recorder = recorder;
    }
    await runScenes(rt, {
      scenario: sc,
      scenarioName: loaded.name,
      until,
      record,
      emit,
      save: () => void files.saveRecord(),
    });
  } catch (e) {
    failure = e;
  } finally {
    endT = clock.now();
    if (rt) {
      for (const [id, t] of rt.tracks) {
        if (!t.recorder) continue;
        try {
          t.builder.frames = (await t.recorder.stop()).length;
        } catch (e) {
          log('error', `stopping the recorder of page ${id} failed: ${errorMessage(e)}`);
        }
      }
    }
    if (recorder) {
      try {
        frames = await recorder.stop();
        const st = recorder.stats();
        if (st.write_errors) timeline.warn(`${st.write_errors} frames could not be written`);
        const minFps = Math.min(capture.fps, 30) * 0.6;
        // Without the drawn cursor a move changes nothing on screen: the frame rate during moves cannot be judged.
        const motion = opts.hideCursor
          ? null
          : motionCapture(frames.map((f) => f.t), timeline.cursor, minFps, timeline.cursorEffects, timeline.pages.map((p) => p.t_start));
        for (const message of motionWarnings(motion, minFps, '')) {
          timeline.warn(message);
          log('warn', message);
        }
      } catch (e) {
        log('error', `stopping the recorder failed: ${errorMessage(e)}`);
      }
    }
    if (hooks) {
      try {
        record.hooks.teardown = await teardownHooks(hooks, sc.teardown ?? [], emit, log);
      } catch (e) {
        record.hooks.teardown = 'failed';
        log('error', `teardown failed: ${errorMessage(e)}`);
      }
    }
    await notifications?.settled().catch(() => undefined);
    await session?.close().catch((e: unknown) => log('warn', `closing the browser failed: ${errorMessage(e)}`));
    // Artefact images (emails, PDF pages, icons, project documents) are rendered after the capture, in a clean browser.
    if (rt && !(failure !== null && isCancelled(failure))) {
      try {
        await rt.artefacts.finalize({ browser: projectBrowser(project, opts.browser), scenario: sc, project });
      } catch (e) {
        timeline.warn(`artefacts: ${errorMessage(e)}`);
      }
    }
    if (rt) timeline.artefacts = rt.artefacts.items;
    removeSignals();
  }

  const cancelled = failure !== null && isCancelled(failure);
  // Per-page tracks of multi-page scenes (L2.11): their frames, encoded on the same CFR grid as capture.mp4.
  const trackFrames = new Map<string, FrameIndexEntry[]>();
  if (rt && mode === 'capture') {
    for (const [id, t] of rt.tracks) {
      if (!t.recorder) continue;
      const list = [...t.recorder.frames].sort((a, b) => a.t - b.t);
      trackFrames.set(id, list);
      t.builder.frames = list.length;
      const st = t.recorder.stats();
      if (st.write_errors) timeline.warn(`page ${id}: ${st.write_errors} frames could not be written`);
      const minFps = Math.min(capture.fps, 30) * 0.6;
      const motion = opts.hideCursor
        ? null
        : motionCapture(list.map((f) => f.t), t.builder.cursor, minFps, t.builder.cursorEffects, t.builder.pages.map((p) => p.t_start));
      for (const message of motionWarnings(motion, minFps, `page ${id}: `)) {
        timeline.warn(message);
        log('warn', message);
      }
    }
  }
  const allTrackFrames = [...trackFrames.values()].flat();
  // A scenario made only of multi-page scenes has no main capture of its own: capture.mp4 is its first page's track.
  const mainFromTrack = mode === 'capture' && frames.length === 0 && allTrackFrames.length > 0 ? [...trackFrames.keys()].find((k) => trackFrames.get(k)!.length > 0) : undefined;
  if (mode === 'capture' && !cancelled && failure === null && frames.length === 0 && !mainFromTrack) {
    // A capture without a single frame is a failed capture, never a "succeeded" run without capture.mp4.
    const why = timeline.warnings.find((w) => w.startsWith('screencast frames stay'));
    failure = new EncodeError(`the capture recorded no frame${why ? ` (${why}: every frame was dropped)` : ''}`);
  }
  if (mode === 'capture' && !cancelled && frames.length > 0) {
    const out = join(dir, 'capture.mp4');
    emit({ type: 'encode', status: 'start', message: `${frames.length} frames → ${out}` });
    try {
      await encodeFrames(framesDir, frames, out, {
        fps: capture.fps,
        crf: capture.crf,
        endT,
        width: capture.width * capture.scale,
        height: capture.height * capture.scale,
        jpeg: capture.format === 'jpeg',
        ffmpeg: opts.ffmpeg,
      });
      record.capture = out;
      emit({ type: 'encode', status: 'done', message: out });
      if (!capture.keep_frames) await rm(framesDir, { recursive: true, force: true });
    } catch (e) {
      emit({ type: 'encode', status: 'done', message: `failed: ${errorMessage(e)}` });
      failure ??= e;
    }
  }
  if (rt && mode === 'capture' && !cancelled) {
    for (const [id, t] of rt.tracks) {
      const list = trackFrames.get(id) ?? [];
      if (list.length === 0) {
        timeline.warn(`page ${id}: its track recorded no frame`);
        continue;
      }
      const tframes = join(dir, t.builder.info.frames_file.replace(/\.jsonl$/, ''));
      const out = join(dir, t.builder.info.file);
      emit({ type: 'encode', status: 'start', message: `page ${id}: ${list.length} frames → ${out}` });
      try {
        await encodeFrames(tframes, list, out, {
          fps: capture.fps,
          crf: capture.crf,
          endT,
          width: t.viewport.width * capture.scale,
          height: t.viewport.height * capture.scale,
          jpeg: capture.format === 'jpeg',
          ffmpeg: opts.ffmpeg,
        });
        emit({ type: 'encode', status: 'done', message: out });
        if (!capture.keep_frames) await rm(tframes, { recursive: true, force: true });
        if (mainFromTrack === id) {
          await copyFile(out, join(dir, 'capture.mp4'));
          record.capture = join(dir, 'capture.mp4');
          frames = list;
          log('info', `every scene films several pages: capture.mp4 is the track of page "${id}"`);
        }
      } catch (e) {
        emit({ type: 'encode', status: 'done', message: `failed: ${errorMessage(e)}` });
        failure ??= e;
      }
    }
  }

  const tl = timeline.build({
    file: record.capture ? 'capture.mp4' : '',
    duration: endT,
    frames: frames.length,
    frameTimes: frames.map((f) => f.t),
    ...(allTrackFrames.length ? { idleFrameTimes: [...(mainFromTrack ? [] : frames), ...allTrackFrames].map((f) => f.t) } : {}),
    // capture.mp4 copied from a page's track has that page's size.
    ...(mainFromTrack && rt?.tracks.get(mainFromTrack) ? { size: { width: rt.tracks.get(mainFromTrack)!.viewport.width, height: rt.tracks.get(mainFromTrack)!.viewport.height } } : {}),
  });
  const timelineFile = join(dir, 'timeline.json');
  try {
    await writeJson(timelineFile, tl);
    record.timeline = timelineFile;
  } catch (e) {
    failure ??= e;
  }

  record.warnings = [...timeline.warnings];
  record.finished_at = new Date().toISOString();
  delete record.current;
  if (failure === null) {
    record.status = 'succeeded';
  } else {
    record.status = isCancelled(failure) ? 'cancelled' : 'failed';
    const err: RunError = { message: errorMessage(failure) };
    if (failure instanceof StepFailure) {
      err.scene = failure.scene;
      err.step = failure.step;
      err.action = failure.action;
      if (failure.screenshot) err.screenshot = failure.screenshot;
      if (failure.dom) err.dom = failure.dom;
    }
    record.error = err;
  }
  emit({ type: 'run_end', run: { ...record } });
  await files.close().catch(() => undefined);
  return record;
}

interface SetupDeps {
  rt: Runtime;
  session: BrowserSession;
  project: LoadedProject;
  env: { name: string; pages: Record<string, string> };
  template: TemplateContext;
  runId: string;
  dir: string;
  emit: (e: RunProgress) => void;
  log: (level: LogLevel, message: string) => void;
  record: RunRecord;
}

async function setupHooks(setup: HookStep[], d: SetupDeps): Promise<HooksState> {
  const mod = await loadHooksModule();
  const journal = await mod.Journal.open(join(d.dir, 'hooks-journal.json'));
  const saved: Record<string, unknown> = {};
  d.template.hooks = saved;
  const ctx: HookContextLike = {
    project: d.project,
    env: d.env,
    vars: Object.fromEntries(Object.entries(d.template.vars ?? {}).map(([k, v]) => [k, String(v)])),
    runId: d.runId,
    // Hooks only get here when they are enabled; in a dry run that takes an explicit `hooks: 'run'`, so they
    // really execute: the dry run then sees the same prepared data as a capture.
    dryRun: false,
    log: (level, msg) => d.log(level, msg),
    evalInPage: async (pageKey, code) => {
      const key = pageKey ?? Object.keys(d.env.pages)[0];
      if (!key) throw new RunnerError('js hook: the environment declares no pages');
      const page: Page = await d.session.page(key);
      if ((page.url() === 'about:blank' || page.url() === '') && d.env.pages[key]) {
        await page.goto(d.env.pages[key], { waitUntil: 'load', timeout: 60_000 });
      }
      return evalInPage(page, code);
    },
    saved,
  };
  const state: HooksState = { mod, journal, ctx };
  if (!setup.length) {
    d.record.hooks.setup = 'none';
    return state;
  }
  d.emit({ type: 'hook', phase: 'setup', name: 'setup', status: 'start', message: `${setup.length} hook(s)` });
  const res = await mod.runHooks(setup, ctx, { phase: 'setup', journal });
  res.results.forEach((r, i) =>
    d.emit({ type: 'hook', phase: 'setup', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }),
  );
  d.record.hooks.setup = res.ok ? 'ok' : 'failed';
  if (!res.ok) {
    // An optional hook may have failed before the one that stopped the setup: report the blocking one.
    const failed = res.results.find((r) => hookResultFailed(r) && r.optional !== true) ?? res.results.find(hookResultFailed);
    throw new RunnerError(`setup hooks failed${failed ? ` (${hookResultName(failed, res.results.indexOf(failed))}: ${failed.error ?? failed.message ?? 'error'})` : ''}; completed setup hooks were rolled back`);
  }
  return state;
}

/**
 * Teardown hooks always run, then the setup hooks still pending in the journal are rolled back (most recent first),
 * like `finally` blocks unwinding: teardown cleans what the scenario did, rollbacks undo what setup did.
 */
async function teardownHooks(
  h: HooksState,
  teardown: HookStep[],
  emit: (e: RunProgress) => void,
  log: (level: LogLevel, message: string) => void,
): Promise<RunRecord['hooks']['teardown']> {
  let ok = true;
  let ran = false;
  if (teardown.length) {
    ran = true;
    emit({ type: 'hook', phase: 'teardown', name: 'teardown', status: 'start', message: `${teardown.length} hook(s)` });
    const res = await h.mod.runHooks(teardown, h.ctx, { phase: 'teardown', journal: h.journal });
    res.results.forEach((r, i) =>
      emit({ type: 'hook', phase: 'teardown', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }),
    );
    ok = res.ok;
  }
  const pending = h.journal.pending().length;
  if (pending) {
    ran = true;
    log('info', `rolling back ${pending} setup hook(s)`);
    emit({ type: 'hook', phase: 'rollback', name: 'rollback', status: 'start', message: `${pending} setup hook(s)` });
    const results = await h.journal.rollbackAll(h.ctx);
    results.forEach((r, i) =>
      emit({ type: 'hook', phase: 'rollback', name: hookResultName(r, i), status: hookResultFailed(r) ? 'failed' : 'ok', message: r.error ?? r.message }),
    );
    if (results.some(hookResultFailed)) ok = false;
  }
  if (!ran) return 'none';
  return ok ? 'ok' : 'failed';
}
